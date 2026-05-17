const fs = require('fs');
const { Client } = require('pg');
const QueryStream = require('pg-query-stream');
const { escapeIdent, escapeStringSql, formatValueGeneric, splitSqlStatements, parseTableNamesFromDumpGeneric, extractRoutineBlocks, ROUTINE_BEGIN, ROUTINE_END } = require('./_shared');

function buildClient(c) {
  return new Client({
    host: c.host,
    port: Number(c.port) || 5432,
    user: c.user,
    password: c.password,
    database: c.database,
    connectionTimeoutMillis: 8000,
    // Supabase / managed PG requires TLS. rejectUnauthorized:false accepts the managed cert
    // without bundling a CA. Tighten in production by adding `ca: <pem>` if you have it.
    ssl: c.ssl ? { rejectUnauthorized: false } : false,
  });
}

const ident = (n) => escapeIdent(n, '"');
const fmt = (v) =>
  formatValueGeneric(v, {
    stringQuote: escapeStringSql,
    binaryHex: (b) => "decode('" + b.toString('hex') + "', 'hex')",
  });

async function testConnection(conn) {
  // Connect to 'postgres' (the default admin DB) when none specified.
  const c = buildClient({ ...conn, database: conn.database || 'postgres' });
  await c.connect();
  try {
    const v = await c.query('SELECT version()');
    const d = await c.query(
      `SELECT datname AS name FROM pg_database WHERE NOT datistemplate ORDER BY datname`
    );
    return { ok: true, version: v.rows[0].version, databases: d.rows.map((r) => r.name) };
  } finally {
    await c.end();
  }
}

async function listTables(conn) {
  const c = buildClient(conn);
  await c.connect();
  try {
    const r = await c.query(
      `SELECT table_schema || '.' || table_name AS name,
              (SELECT reltuples::bigint FROM pg_class WHERE oid = (table_schema||'.'||table_name)::regclass) AS "rowEstimate"
       FROM information_schema.tables
       WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')
       ORDER BY table_schema, table_name`
    );
    return r.rows;
  } finally {
    await c.end();
  }
}

async function getTableDDL(c, schema, table) {
  const cols = (await c.query(
    `SELECT column_name, data_type, character_maximum_length, numeric_precision, numeric_scale,
            is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2
     ORDER BY ordinal_position`,
    [schema, table]
  )).rows;

  const pk = (await c.query(
    `SELECT a.attname AS column_name
     FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = ($1 || '.' || $2)::regclass AND i.indisprimary
     ORDER BY array_position(i.indkey, a.attnum)`,
    [schema, table]
  )).rows.map((r) => r.column_name);

  const lines = cols.map((c) => {
    let type = c.data_type;
    if (c.character_maximum_length) type += `(${c.character_maximum_length})`;
    else if (c.numeric_precision && c.data_type === 'numeric') type += `(${c.numeric_precision},${c.numeric_scale || 0})`;
    let line = `  ${ident(c.column_name)} ${type}`;
    if (c.column_default) line += ` DEFAULT ${c.column_default}`;
    if (c.is_nullable === 'NO') line += ' NOT NULL';
    return line;
  });
  if (pk.length) lines.push(`  PRIMARY KEY (${pk.map(ident).join(', ')})`);
  return `CREATE TABLE ${ident(schema)}.${ident(table)} (\n${lines.join(',\n')}\n)`;
}

async function dumpTableData(c, schema, table, stream, onProgress) {
  return new Promise((resolve, reject) => {
    const qs = new QueryStream(`SELECT * FROM ${ident(schema)}.${ident(table)}`, [], { batchSize: 200 });
    const src = c.query(qs);
    let columnsLine = null;
    let buf = [], bufBytes = 0, n = 0;
    const MAX_BATCH = 500, MAX_BYTES = 512 * 1024;

    function flush() {
      if (!buf.length) return;
      stream.write(`INSERT INTO ${ident(schema)}.${ident(table)} ${columnsLine} VALUES\n` + buf.join(',\n') + ';\n');
      buf = []; bufBytes = 0;
    }

    src.on('data', (row) => {
      if (!columnsLine) columnsLine = '(' + Object.keys(row).map(ident).join(',') + ')';
      const line = '  (' + Object.values(row).map(fmt).join(',') + ')';
      buf.push(line); bufBytes += line.length; n++;
      if (buf.length >= MAX_BATCH || bufBytes >= MAX_BYTES) flush();
      if (n % 5000 === 0) onProgress?.(`  ${schema}.${table}: ${n} rows...`);
    });
    src.on('end', () => { flush(); stream.write('\n'); onProgress?.(`  ${schema}.${table}: ${n} rows done`); resolve(); });
    src.on('error', reject);
  });
}

// ----- DDL extras: FK / secondary indexes / triggers -----
// Each chunk is preceded by a header comment and wrapped in try/catch so one missing
// privilege doesn't kill the rest.
async function dumpExtras(c, tables, stream, onProgress) {
  const tableTuples = tables.map(([s, t]) => `(${escapeStringSql(s)}, ${escapeStringSql(t)})`).join(',');
  if (!tableTuples) return;

  // 1. Foreign keys — restore AFTER data so ordering doesn't matter
  try {
    const fks = (await c.query(`
      SELECT n.nspname AS schema, cl.relname AS table, conname, pg_get_constraintdef(co.oid) AS def
      FROM pg_constraint co
      JOIN pg_class cl ON cl.oid = co.conrelid
      JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE co.contype = 'f'
        AND (n.nspname, cl.relname) IN (${tableTuples})
      ORDER BY n.nspname, cl.relname, conname
    `)).rows;
    if (fks.length) {
      stream.write(`\n-- ----------------------------\n-- Foreign keys (${fks.length})\n-- ----------------------------\n`);
      for (const fk of fks) {
        stream.write(`ALTER TABLE ${ident(fk.schema)}.${ident(fk.table)} ADD CONSTRAINT ${ident(fk.conname)} ${fk.def};\n`);
      }
      onProgress?.(`  ${fks.length} foreign key(s)`);
    }
  } catch (e) { stream.write(`\n-- (skipped FK dump: ${e.message})\n`); }

  // 2. Secondary indexes — exclude PK / unique constraint indexes (already in CREATE TABLE)
  try {
    const idxs = (await c.query(`
      SELECT schemaname AS schema, tablename AS table, indexname, indexdef
      FROM pg_indexes
      WHERE (schemaname, tablename) IN (${tableTuples})
        AND indexname NOT IN (
          SELECT conname FROM pg_constraint WHERE contype IN ('p','u')
        )
      ORDER BY schemaname, tablename, indexname
    `)).rows;
    if (idxs.length) {
      stream.write(`\n-- ----------------------------\n-- Secondary indexes (${idxs.length})\n-- ----------------------------\n`);
      for (const idx of idxs) {
        stream.write(`${idx.indexdef};\n`);
      }
      onProgress?.(`  ${idxs.length} index(es)`);
    }
  } catch (e) { stream.write(`\n-- (skipped index dump: ${e.message})\n`); }

  // 3. Triggers — pg_get_triggerdef gives full statement
  try {
    const trigs = (await c.query(`
      SELECT n.nspname AS schema, cl.relname AS table, tg.tgname AS name,
             pg_get_triggerdef(tg.oid, true) AS def
      FROM pg_trigger tg
      JOIN pg_class cl ON cl.oid = tg.tgrelid
      JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE NOT tg.tgisinternal
        AND (n.nspname, cl.relname) IN (${tableTuples})
      ORDER BY n.nspname, cl.relname, tg.tgname
    `)).rows;
    if (trigs.length) {
      stream.write(`\n-- ----------------------------\n-- Triggers (${trigs.length})\n-- ----------------------------\n`);
      for (const tg of trigs) {
        stream.write(`${tg.def};\n`);
      }
      onProgress?.(`  ${trigs.length} trigger(s)`);
    }
  } catch (e) { stream.write(`\n-- (skipped trigger dump: ${e.message})\n`); }
}

// Routines = sequences (PG-specific), views, functions, procedures.
// All dumped after data so FK ordering / data references resolve cleanly.
async function dumpRoutines(c, stream, onProgress) {
  // Sequences — PG has standalone sequence objects (also auto-created for SERIAL columns).
  // We dump non-internal ones with their last_value + cache + increment etc.
  try {
    const seqs = (await c.query(`
      SELECT n.nspname AS schema, cl.relname AS name
      FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE cl.relkind = 'S' AND n.nspname NOT IN ('pg_catalog','information_schema')
      ORDER BY n.nspname, cl.relname
    `)).rows;
    if (seqs.length) {
      stream.write(`\n-- ----------------------------\n-- Sequences (${seqs.length})\n-- ----------------------------\n`);
      for (const s of seqs) {
        try {
          const meta = (await c.query(
            `SELECT increment, minimum_value, maximum_value, start_value, cache_size, cycle_option, data_type
             FROM information_schema.sequences WHERE sequence_schema = $1 AND sequence_name = $2`,
            [s.schema, s.name]
          )).rows[0];
          if (!meta) continue;
          const fq = `${ident(s.schema)}.${ident(s.name)}`;
          stream.write(`DROP SEQUENCE IF EXISTS ${fq} CASCADE;\n`);
          stream.write(`CREATE SEQUENCE ${fq} AS ${meta.data_type}` +
                       ` INCREMENT BY ${meta.increment}` +
                       ` MINVALUE ${meta.minimum_value} MAXVALUE ${meta.maximum_value}` +
                       ` START WITH ${meta.start_value} CACHE ${meta.cache_size}` +
                       (meta.cycle_option === 'YES' ? ' CYCLE' : ' NO CYCLE') + ';\n`);
          // Restore last_value so re-imported data doesn't collide
          const last = (await c.query(`SELECT last_value, is_called FROM ${fq}`)).rows[0];
          if (last) stream.write(`SELECT setval(${escapeStringSql(s.schema + '.' + s.name)}, ${last.last_value}, ${last.is_called});\n`);
        } catch (e) { stream.write(`-- (sequence ${s.schema}.${s.name} skipped: ${e.message})\n`); }
      }
      onProgress?.(`  ${seqs.length} sequence(s)`);
    }
  } catch (e) { stream.write(`\n-- (skipped sequence dump: ${e.message})\n`); }

  // Views — pg_views has the SELECT body, we reconstruct CREATE OR REPLACE VIEW
  try {
    const views = (await c.query(`
      SELECT schemaname AS schema, viewname AS name, definition
      FROM pg_views WHERE schemaname NOT IN ('pg_catalog','information_schema')
      ORDER BY schemaname, viewname
    `)).rows;
    if (views.length) {
      stream.write(`\n-- ----------------------------\n-- Views (${views.length})\n-- ----------------------------\n`);
      for (const v of views) {
        stream.write(`DROP VIEW IF EXISTS ${ident(v.schema)}.${ident(v.name)} CASCADE;\n`);
        stream.write(`CREATE VIEW ${ident(v.schema)}.${ident(v.name)} AS\n${v.definition};\n\n`);
      }
      onProgress?.(`  ${views.length} view(s)`);
    }
  } catch (e) { stream.write(`\n-- (skipped view dump: ${e.message})\n`); }

  // Functions + procedures — pg_get_functiondef returns a full ready-to-execute DDL.
  // Bodies use $$ delimiters so splitSqlStatements (which respects ' " idents but NOT $$)
  // won't slice them; we still wrap in ROUTINE markers to be safe.
  try {
    const fns = (await c.query(`
      SELECT n.nspname AS schema, p.proname AS name, p.prokind AS kind,
             pg_get_functiondef(p.oid) AS def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema')
        AND p.prokind IN ('f','p')
      ORDER BY p.prokind, n.nspname, p.proname
    `)).rows;
    const funcs = fns.filter((r) => r.kind === 'f');
    const procs = fns.filter((r) => r.kind === 'p');

    if (funcs.length) {
      stream.write(`\n-- ----------------------------\n-- Functions (${funcs.length})\n-- ----------------------------\n`);
      for (const f of funcs) {
        stream.write(`${ROUTINE_BEGIN} function ${f.schema}.${f.name}\n${f.def}\n${ROUTINE_END}\n\n`);
      }
      onProgress?.(`  ${funcs.length} function(s)`);
    }
    if (procs.length) {
      stream.write(`\n-- ----------------------------\n-- Procedures (${procs.length})\n-- ----------------------------\n`);
      for (const p of procs) {
        stream.write(`${ROUTINE_BEGIN} procedure ${p.schema}.${p.name}\n${p.def}\n${ROUTINE_END}\n\n`);
      }
      onProgress?.(`  ${procs.length} procedure(s)`);
    }
  } catch (e) { stream.write(`\n-- (skipped function/procedure dump: ${e.message})\n`); }
}

async function dump(conn, options, outFilePath, onProgress) {
  const c = buildClient(conn);
  await c.connect();
  const stream = fs.createWriteStream(outFilePath, { encoding: 'utf8' });
  try {
    stream.write(`-- DB Migrator dump (PostgreSQL)\n-- Database: ${conn.database}\n-- Generated: ${new Date().toISOString()}\n\n`);

    let tables;
    if (options.tables?.length) {
      tables = options.tables.map((t) => t.includes('.') ? t.split('.', 2) : ['public', t]);
    } else {
      const r = await c.query(
        `SELECT table_schema, table_name FROM information_schema.tables
         WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema')
         ORDER BY table_schema, table_name`
      );
      tables = r.rows.map((x) => [x.table_schema, x.table_name]);
    }

    onProgress?.(`Dumping ${tables.length} table(s)`);
    for (const [schema, table] of tables) {
      onProgress?.(`> ${schema}.${table}`);
      if (!options.noSchema) {
        stream.write(`\n-- ----------------------------\n-- Table: ${schema}.${table}\n-- ----------------------------\n`);
        stream.write(`DROP TABLE IF EXISTS ${ident(schema)}.${ident(table)} CASCADE;\n`);
        stream.write((await getTableDDL(c, schema, table)) + ';\n\n');
      }
      if (!options.noData) await dumpTableData(c, schema, table, stream, onProgress);
    }

    // ===== DDL extras: FK constraints, secondary indexes, triggers =====
    // Done AFTER all data inserted so FK don't block restore order.
    if (!options.noSchema) {
      onProgress?.('Adding FK / indexes / triggers');
      await dumpExtras(c, tables, stream, onProgress);
      onProgress?.('Adding sequences / views / functions / procedures');
      await dumpRoutines(c, stream, onProgress);
    }
    onProgress?.('Done');
  } finally {
    await new Promise((r) => stream.end(r));
    await c.end();
  }
  return { outFilePath };
}

async function restore(conn, sqlFilePath, onProgress) {
  const c = buildClient(conn);
  await c.connect();
  try {
    const sql = fs.readFileSync(sqlFilePath, 'utf8');
    // Pull out routine blocks first; the rest goes through the per-statement splitter
    // (postgres functions use $$ delimiters which our naive splitter would still
    // mishandle if a `;` appeared inside the body).
    const blocks = extractRoutineBlocks(sql);
    let totalStmts = 0;
    for (const b of blocks) totalStmts += b.kind === 'sql' ? splitSqlStatements(b.body, '"').length : 1;
    onProgress?.(`Executing ${totalStmts} statements...`);

    let n = 0;
    for (const b of blocks) {
      if (b.kind === 'routine') {
        const body = b.body.replace(/;\s*$/, '');
        await c.query(body);
        n++;
      } else {
        for (const s of splitSqlStatements(b.body, '"')) {
          await c.query(s);
          n++;
          if (n % 50 === 0) onProgress?.(`  ${n}/${totalStmts}`);
        }
      }
    }
    onProgress?.(`Restore complete (${n} statements)`);
    return { ok: true };
  } finally {
    await c.end();
  }
}

function parseTableNamesFromDump(sqlFilePath) {
  return parseTableNamesFromDumpGeneric(fs.readFileSync(sqlFilePath, 'utf8'), '"');
}

module.exports = { type: 'postgres', testConnection, listTables, dump, restore, parseTableNamesFromDump };
