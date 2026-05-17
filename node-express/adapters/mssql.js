const fs = require('fs');
const sql = require('mssql');
const { escapeIdent, formatValueGeneric, parseTableNamesFromDumpGeneric } = require('./_shared');

// Accepts "HOST", "HOST\\INSTANCE", "HOST,PORT", "HOST\\INSTANCE,PORT".
function parseServer(raw) {
  let server = raw, instance, port;
  const commaIdx = server.indexOf(',');
  if (commaIdx >= 0) {
    port = Number(server.slice(commaIdx + 1)) || undefined;
    server = server.slice(0, commaIdx);
  }
  const slashIdx = server.indexOf('\\');
  if (slashIdx >= 0) {
    instance = server.slice(slashIdx + 1);
    server = server.slice(0, slashIdx);
  }
  return { server, instance, port };
}

function buildConfig(c) {
  const { server, instance, port } = parseServer(c.host);
  const cfg = {
    server,
    database: c.database || 'master',  // empty -> master, so test connection still works
    options: {
      trustServerCertificate: true,
      encrypt: false,
      enableArithAbort: true,
    },
    connectionTimeout: 15000,
    requestTimeout: 0,
  };
  if (instance) cfg.options.instanceName = instance;
  // Explicit port from server string takes priority; otherwise the form's port field.
  const finalPort = port ?? (c.port ? Number(c.port) : undefined);
  if (finalPort && !instance) cfg.port = finalPort;

  if (c.authMode === 'windows') {
    // NTLM with provided Windows credentials (user can be "DOMAIN\\User" or "MACHINE\\User")
    let domain = '', userName = c.user || '';
    const m = userName.match(/^([^\\]+)\\(.+)$/);
    if (m) { domain = m[1]; userName = m[2]; }
    cfg.authentication = {
      type: 'ntlm',
      options: { domain, userName, password: c.password || '' },
    };
  } else {
    cfg.user = c.user;
    cfg.password = c.password;
  }
  return cfg;
}

const ident = (n) => escapeIdent(n, '[').replace(/^\[/, '[').replace(/\]$/, ']')
  .replace(/\[/, '[').replace(/\]/, ']'); // simplified; we'll just bracket
function bracket(n) { return '[' + String(n).replace(/]/g, ']]') + ']'; }

const fmt = (v) =>
  formatValueGeneric(v, {
    stringQuote: (s) => "N'" + String(s).replace(/'/g, "''") + "'",
    binaryHex: (b) => '0x' + b.toString('hex'),
    boolAs01: true,
  });

async function testConnection(conn) {
  // buildConfig defaults database to 'master' if empty, so we can connect even without a target DB picked.
  const pool = await sql.connect(buildConfig(conn));
  try {
    const v = await pool.request().query('SELECT @@VERSION AS v');
    const d = await pool.request().query(
      `SELECT name FROM sys.databases WHERE database_id > 4 ORDER BY name`
    );
    return {
      ok: true,
      version: v.recordset[0].v.split('\n')[0],
      databases: d.recordset.map((r) => r.name),
    };
  } finally { await pool.close(); }
}

async function listTables(conn) {
  const pool = await sql.connect(buildConfig(conn));
  try {
    const r = await pool.request().query(
      `SELECT s.name + '.' + t.name AS name, p.rows AS rowEstimate
       FROM sys.tables t
       JOIN sys.schemas s ON s.schema_id = t.schema_id
       LEFT JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0,1)
       ORDER BY s.name, t.name`
    );
    return r.recordset;
  } finally { await pool.close(); }
}

async function getTableDDL(pool, schema, table) {
  const cols = (await pool.request()
    .input('s', sql.NVarChar, schema)
    .input('t', sql.NVarChar, table)
    .query(
      `SELECT c.name AS column_name,
              ty.name AS data_type,
              c.max_length, c.precision, c.scale, c.is_nullable,
              dc.definition AS default_def,
              c.is_identity
       FROM sys.columns c
       JOIN sys.types ty ON ty.user_type_id = c.user_type_id
       LEFT JOIN sys.default_constraints dc ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
       WHERE c.object_id = OBJECT_ID(@s + '.' + @t)
       ORDER BY c.column_id`
    )).recordset;

  const pk = (await pool.request()
    .input('s', sql.NVarChar, schema)
    .input('t', sql.NVarChar, table)
    .query(
      `SELECT col.name
       FROM sys.indexes i
       JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
       JOIN sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id
       WHERE i.object_id = OBJECT_ID(@s + '.' + @t) AND i.is_primary_key = 1
       ORDER BY ic.key_ordinal`
    )).recordset.map((r) => r.name);

  const lines = cols.map((c) => {
    let type = c.data_type;
    if (['nvarchar', 'nchar'].includes(type)) type += `(${c.max_length === -1 ? 'MAX' : c.max_length / 2})`;
    else if (['varchar', 'char', 'varbinary', 'binary'].includes(type)) type += `(${c.max_length === -1 ? 'MAX' : c.max_length})`;
    else if (['decimal', 'numeric'].includes(type)) type += `(${c.precision},${c.scale})`;
    let line = `  ${bracket(c.column_name)} ${type}`;
    if (c.is_identity) line += ' IDENTITY(1,1)';
    if (c.default_def) line += ` DEFAULT ${c.default_def}`;
    line += c.is_nullable ? ' NULL' : ' NOT NULL';
    return line;
  });
  if (pk.length) lines.push(`  CONSTRAINT ${bracket('PK_' + table)} PRIMARY KEY (${pk.map(bracket).join(', ')})`);
  return `CREATE TABLE ${bracket(schema)}.${bracket(table)} (\n${lines.join(',\n')}\n)`;
}

async function dumpTableData(pool, schema, table, stream, onProgress) {
  return new Promise((resolve, reject) => {
    const req = pool.request();
    req.stream = true;
    let columnsLine = null;
    let buf = [], bufBytes = 0, n = 0;
    const MAX_BATCH = 500, MAX_BYTES = 512 * 1024;

    function flush() {
      if (!buf.length) return;
      stream.write(`INSERT INTO ${bracket(schema)}.${bracket(table)} ${columnsLine} VALUES\n` + buf.join(',\n') + ';\n');
      buf = []; bufBytes = 0;
    }

    req.on('row', (row) => {
      if (!columnsLine) columnsLine = '(' + Object.keys(row).map(bracket).join(',') + ')';
      const line = '  (' + Object.values(row).map(fmt).join(',') + ')';
      buf.push(line); bufBytes += line.length; n++;
      if (buf.length >= MAX_BATCH || bufBytes >= MAX_BYTES) flush();
      if (n % 5000 === 0) onProgress?.(`  ${schema}.${table}: ${n} rows...`);
    });
    req.on('error', reject);
    req.on('done', () => { flush(); stream.write('\n'); onProgress?.(`  ${schema}.${table}: ${n} rows done`); resolve(); });

    req.query(`SELECT * FROM ${bracket(schema)}.${bracket(table)}`);
  });
}

// ----- FK / index / trigger dump for MSSQL -----
async function dumpMsSqlExtras(pool, tables, stream, onProgress) {
  if (tables.length === 0) return;
  const fqns = tables.map(([s, t]) => `'${s}.${t}'`).join(',');

  // 1. Foreign keys
  try {
    const fks = (await pool.request().query(`
      SELECT s.name AS schema_name, t.name AS table_name, fk.name AS fk_name,
             OBJECT_NAME(fk.parent_object_id) AS parent_tbl,
             rs.name AS ref_schema, rt.name AS ref_table,
             STUFF((
               SELECT ',' + QUOTENAME(c.name)
               FROM sys.foreign_key_columns fkc
               JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
               WHERE fkc.constraint_object_id = fk.object_id
               ORDER BY fkc.constraint_column_id
               FOR XML PATH('')
             ), 1, 1, '') AS parent_cols,
             STUFF((
               SELECT ',' + QUOTENAME(c.name)
               FROM sys.foreign_key_columns fkc
               JOIN sys.columns c ON c.object_id = fkc.referenced_object_id AND c.column_id = fkc.referenced_column_id
               WHERE fkc.constraint_object_id = fk.object_id
               ORDER BY fkc.constraint_column_id
               FOR XML PATH('')
             ), 1, 1, '') AS ref_cols
      FROM sys.foreign_keys fk
      JOIN sys.tables t ON t.object_id = fk.parent_object_id
      JOIN sys.schemas s ON s.schema_id = t.schema_id
      JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id
      JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
      WHERE s.name + '.' + t.name IN (${fqns})
      ORDER BY s.name, t.name, fk.name
    `)).recordset;
    if (fks.length) {
      stream.write(`\n-- ----------------------------\n-- Foreign keys (${fks.length})\n-- ----------------------------\n`);
      for (const fk of fks) {
        stream.write(
          `ALTER TABLE ${bracket(fk.schema_name)}.${bracket(fk.table_name)} ` +
          `ADD CONSTRAINT ${bracket(fk.fk_name)} FOREIGN KEY (${fk.parent_cols}) ` +
          `REFERENCES ${bracket(fk.ref_schema)}.${bracket(fk.ref_table)} (${fk.ref_cols});\nGO\n`
        );
      }
      onProgress?.(`  ${fks.length} foreign key(s)`);
    }
  } catch (e) { stream.write(`\n-- (skipped FK dump: ${e.message})\n`); }

  // 2. Secondary indexes — exclude PK / unique constraint indexes
  try {
    const idxs = (await pool.request().query(`
      SELECT s.name AS schema_name, t.name AS table_name, i.name AS index_name,
             i.is_unique,
             STUFF((
               SELECT ',' + QUOTENAME(c.name) + CASE WHEN ic.is_descending_key=1 THEN ' DESC' ELSE '' END
               FROM sys.index_columns ic
               JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
               WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
               ORDER BY ic.key_ordinal
               FOR XML PATH('')
             ), 1, 1, '') AS key_cols
      FROM sys.indexes i
      JOIN sys.tables t ON t.object_id = i.object_id
      JOIN sys.schemas s ON s.schema_id = t.schema_id
      WHERE i.type > 0 AND i.is_primary_key = 0 AND i.is_unique_constraint = 0
        AND s.name + '.' + t.name IN (${fqns})
      ORDER BY s.name, t.name, i.name
    `)).recordset;
    if (idxs.length) {
      stream.write(`\n-- ----------------------------\n-- Secondary indexes (${idxs.length})\n-- ----------------------------\n`);
      for (const idx of idxs) {
        const uniq = idx.is_unique ? 'UNIQUE ' : '';
        stream.write(`CREATE ${uniq}INDEX ${bracket(idx.index_name)} ON ${bracket(idx.schema_name)}.${bracket(idx.table_name)} (${idx.key_cols});\nGO\n`);
      }
      onProgress?.(`  ${idxs.length} index(es)`);
    }
  } catch (e) { stream.write(`\n-- (skipped index dump: ${e.message})\n`); }

  // 3. Triggers
  try {
    const trigs = (await pool.request().query(`
      SELECT s.name AS schema_name, t.name AS table_name, tr.name AS trigger_name,
             OBJECT_DEFINITION(tr.object_id) AS body
      FROM sys.triggers tr
      JOIN sys.tables t ON t.object_id = tr.parent_id
      JOIN sys.schemas s ON s.schema_id = t.schema_id
      WHERE s.name + '.' + t.name IN (${fqns}) AND tr.is_ms_shipped = 0
      ORDER BY s.name, t.name, tr.name
    `)).recordset;
    if (trigs.length) {
      stream.write(`\n-- ----------------------------\n-- Triggers (${trigs.length})\n-- ----------------------------\n`);
      for (const t of trigs) {
        if (!t.body) continue;
        stream.write(`IF OBJECT_ID('${t.schema_name}.${t.trigger_name}', 'TR') IS NOT NULL DROP TRIGGER ${bracket(t.schema_name)}.${bracket(t.trigger_name)};\nGO\n`);
        stream.write(t.body.trim() + '\nGO\n\n');
      }
      onProgress?.(`  ${trigs.length} trigger(s)`);
    }
  } catch (e) { stream.write(`\n-- (skipped trigger dump: ${e.message})\n`); }
}

// Views + procedures + functions for SQL Server. Each object's body comes from
// OBJECT_DEFINITION as a full CREATE statement. We rely on GO separators
// (already understood by our MSSQL restore) instead of ROUTINE markers.
async function dumpMsSqlRoutines(pool, stream, onProgress) {
  // Views
  try {
    const views = (await pool.request().query(`
      SELECT s.name AS schema_name, v.name AS name, OBJECT_DEFINITION(v.object_id) AS body
      FROM sys.views v JOIN sys.schemas s ON s.schema_id = v.schema_id
      WHERE v.is_ms_shipped = 0
      ORDER BY s.name, v.name
    `)).recordset;
    if (views.length) {
      stream.write(`\n-- ----------------------------\n-- Views (${views.length})\n-- ----------------------------\n`);
      for (const v of views) {
        if (!v.body) continue;
        stream.write(`IF OBJECT_ID('${v.schema_name}.${v.name}', 'V') IS NOT NULL DROP VIEW ${bracket(v.schema_name)}.${bracket(v.name)};\nGO\n`);
        stream.write(v.body.trim() + '\nGO\n\n');
      }
      onProgress?.(`  ${views.length} view(s)`);
    }
  } catch (e) { stream.write(`\n-- (skipped view dump: ${e.message})\n`); }

  // Stored procedures
  try {
    const procs = (await pool.request().query(`
      SELECT s.name AS schema_name, p.name AS name, OBJECT_DEFINITION(p.object_id) AS body
      FROM sys.procedures p JOIN sys.schemas s ON s.schema_id = p.schema_id
      WHERE p.is_ms_shipped = 0
      ORDER BY s.name, p.name
    `)).recordset;
    if (procs.length) {
      stream.write(`\n-- ----------------------------\n-- Stored procedures (${procs.length})\n-- ----------------------------\n`);
      for (const p of procs) {
        if (!p.body) continue;
        stream.write(`IF OBJECT_ID('${p.schema_name}.${p.name}', 'P') IS NOT NULL DROP PROCEDURE ${bracket(p.schema_name)}.${bracket(p.name)};\nGO\n`);
        stream.write(p.body.trim() + '\nGO\n\n');
      }
      onProgress?.(`  ${procs.length} procedure(s)`);
    }
  } catch (e) { stream.write(`\n-- (skipped procedure dump: ${e.message})\n`); }

  // Functions — FN = scalar, IF = inline table-valued, TF = multi-statement table-valued, FS = CLR, FT = CLR TVF
  try {
    const funcs = (await pool.request().query(`
      SELECT s.name AS schema_name, o.name AS name, o.type AS kind,
             OBJECT_DEFINITION(o.object_id) AS body
      FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
      WHERE o.type IN ('FN','IF','TF','FS','FT') AND o.is_ms_shipped = 0
      ORDER BY s.name, o.name
    `)).recordset;
    if (funcs.length) {
      stream.write(`\n-- ----------------------------\n-- Functions (${funcs.length})\n-- ----------------------------\n`);
      for (const f of funcs) {
        if (!f.body) continue;
        // FN/IF/TF use different DROP semantics; DROP FUNCTION works for all
        stream.write(`IF OBJECT_ID('${f.schema_name}.${f.name}') IS NOT NULL DROP FUNCTION ${bracket(f.schema_name)}.${bracket(f.name)};\nGO\n`);
        stream.write(f.body.trim() + '\nGO\n\n');
      }
      onProgress?.(`  ${funcs.length} function(s)`);
    }
  } catch (e) { stream.write(`\n-- (skipped function dump: ${e.message})\n`); }
}

async function dump(conn, options, outFilePath, onProgress) {
  const pool = await sql.connect(buildConfig(conn));
  const stream = fs.createWriteStream(outFilePath, { encoding: 'utf8' });
  try {
    stream.write(`-- DB Migrator dump (SQL Server)\n-- Database: ${conn.database}\n-- Generated: ${new Date().toISOString()}\n\n`);

    let tables;
    if (options.tables?.length) {
      tables = options.tables.map((t) => t.includes('.') ? t.split('.', 2) : ['dbo', t]);
    } else {
      const r = await pool.request().query(
        `SELECT s.name AS schema_name, t.name AS table_name
         FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
         ORDER BY s.name, t.name`
      );
      tables = r.recordset.map((x) => [x.schema_name, x.table_name]);
    }

    onProgress?.(`Dumping ${tables.length} table(s)`);
    for (const [schema, table] of tables) {
      onProgress?.(`> ${schema}.${table}`);
      if (!options.noSchema) {
        stream.write(`\n-- ----------------------------\n-- Table: ${schema}.${table}\n-- ----------------------------\n`);
        stream.write(`IF OBJECT_ID('${schema}.${table}', 'U') IS NOT NULL DROP TABLE ${bracket(schema)}.${bracket(table)};\nGO\n`);
        stream.write((await getTableDDL(pool, schema, table)) + ';\nGO\n\n');
      }
      if (!options.noData) await dumpTableData(pool, schema, table, stream, onProgress);
    }

    // ===== DDL extras: FK / secondary indexes / triggers =====
    if (!options.noSchema) {
      onProgress?.('Adding FK / indexes / triggers');
      await dumpMsSqlExtras(pool, tables, stream, onProgress);
      onProgress?.('Adding views / procedures / functions');
      await dumpMsSqlRoutines(pool, stream, onProgress);
    }
    onProgress?.('Done');
  } finally {
    await new Promise((r) => stream.end(r));
    await pool.close();
  }
  return { outFilePath };
}

// MSSQL scripts use GO as batch separator (sqlcmd directive). Split on lines that are exactly 'GO'.
function splitMsSqlBatches(text) {
  const batches = [];
  let cur = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*GO\s*$/i.test(line)) {
      const s = cur.join('\n').trim();
      if (s) batches.push(s);
      cur = [];
    } else {
      cur.push(line);
    }
  }
  const last = cur.join('\n').trim();
  if (last) batches.push(last);
  return batches;
}

async function restore(conn, sqlFilePath, onProgress) {
  const pool = await sql.connect(buildConfig(conn));
  try {
    const text = fs.readFileSync(sqlFilePath, 'utf8');
    const batches = splitMsSqlBatches(text);
    onProgress?.(`Executing ${batches.length} batches...`);
    let n = 0;
    for (const b of batches) {
      await pool.request().batch(b);
      n++;
      if (n % 50 === 0) onProgress?.(`  ${n}/${batches.length}`);
    }
    onProgress?.(`Restore complete (${n} batches)`);
    return { ok: true };
  } finally { await pool.close(); }
}

function parseTableNamesFromDump(sqlFilePath) {
  return parseTableNamesFromDumpGeneric(fs.readFileSync(sqlFilePath, 'utf8'), '[');
}

module.exports = { type: 'mssql', testConnection, listTables, dump, restore, parseTableNamesFromDump };
