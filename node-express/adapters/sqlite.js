const fs = require('fs');
const Database = require('better-sqlite3');
const { escapeIdent, formatValueGeneric, splitSqlStatements, parseTableNamesFromDumpGeneric } = require('./_shared');
const { normalize } = require('../lib/cross-db');
const { NeutralWriter, readNeutral } = require('../lib/cross-db/format');
const { encodeRow, decodeRow } = require('../lib/cross-db/encode');
const { buildCreateTable, buildCreateIndexes } = require('../lib/cross-db/tables');

// SQLite "connection" is just a file path. We accept conn.path (preferred) or conn.database / conn.host as fallbacks.
function pickPath(c) {
  return c.path || c.database || c.host;
}

function open(c, readonly = true) {
  const p = pickPath(c);
  if (!p) throw new Error('SQLite needs a file path (connection.path)');
  return new Database(p, { readonly, fileMustExist: readonly });
}

const ident = (n) => escapeIdent(n, '"');
const fmt = (v) =>
  formatValueGeneric(v, {
    binaryHex: (b) => "X'" + b.toString('hex') + "'",
    boolAs01: true,
  });

async function testConnection(conn) {
  const db = open(conn, true);
  try {
    const v = db.prepare('select sqlite_version() as v').get().v;
    return { ok: true, version: 'SQLite ' + v };
  } finally { db.close(); }
}

async function listTables(conn) {
  const db = open(conn, true);
  try {
    return db
      .prepare("SELECT name, (SELECT COUNT(*) FROM sqlite_master) AS rowEstimate FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => ({ name: r.name, rowEstimate: null })); // SQLite has no cheap row estimate
  } finally { db.close(); }
}

async function dump(conn, options, outFilePath, onProgress) {
  const db = open(conn, true);
  const stream = fs.createWriteStream(outFilePath, { encoding: 'utf8' });
  try {
    stream.write(`-- DB Migrator dump (SQLite)\n-- File: ${pickPath(conn)}\n-- Generated: ${new Date().toISOString()}\n\n`);
    stream.write(`PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n\n`);

    let tables;
    if (options.tables?.length) tables = options.tables;
    else tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);

    onProgress?.(`Dumping ${tables.length} table(s)`);

    for (const table of tables) {
      onProgress?.(`> ${table}`);
      const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql;
      if (!ddl) { onProgress?.(`  ${table}: not found, skipped`); continue; }

      if (!options.noSchema) {
        stream.write(`\n-- Table: ${table}\n`);
        stream.write(`DROP TABLE IF EXISTS ${ident(table)};\n`);
        stream.write(ddl + ';\n\n');
      }

      if (!options.noData) {
        const stmt = db.prepare(`SELECT * FROM ${ident(table)}`);
        let columnsLine = null;
        let buf = [], bufBytes = 0, n = 0;
        const MAX_BATCH = 500, MAX_BYTES = 512 * 1024;

        function flush() {
          if (!buf.length) return;
          stream.write(`INSERT INTO ${ident(table)} ${columnsLine} VALUES\n` + buf.join(',\n') + ';\n');
          buf = []; bufBytes = 0;
        }

        for (const row of stmt.iterate()) {
          if (!columnsLine) columnsLine = '(' + Object.keys(row).map(ident).join(',') + ')';
          const line = '  (' + Object.values(row).map(fmt).join(',') + ')';
          buf.push(line); bufBytes += line.length; n++;
          if (buf.length >= MAX_BATCH || bufBytes >= MAX_BYTES) flush();
          if (n % 5000 === 0) onProgress?.(`  ${table}: ${n} rows...`);
        }
        flush();
        stream.write('\n');
        onProgress?.(`  ${table}: ${n} rows done`);
      }
    }

    // Indexes (named, non-autoindex)
    const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all();
    if (indexes.length) {
      stream.write(`\n-- ----------------------------\n-- Indexes (${indexes.length})\n-- ----------------------------\n`);
      for (const idx of indexes) stream.write(idx.sql + ';\n');
      onProgress?.(`  ${indexes.length} index(es)`);
    }

    // Views
    const views = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='view' AND sql IS NOT NULL").all();
    if (views.length) {
      stream.write(`\n-- ----------------------------\n-- Views (${views.length})\n-- ----------------------------\n`);
      for (const v of views) {
        stream.write(`DROP VIEW IF EXISTS ${ident(v.name)};\n${v.sql};\n\n`);
      }
      onProgress?.(`  ${views.length} view(s)`);
    }

    // Triggers
    const triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL").all();
    if (triggers.length) {
      stream.write(`\n-- ----------------------------\n-- Triggers (${triggers.length})\n-- ----------------------------\n`);
      for (const t of triggers) {
        stream.write(`DROP TRIGGER IF EXISTS ${ident(t.name)};\n${t.sql};\n\n`);
      }
      onProgress?.(`  ${triggers.length} trigger(s)`);
    }

    stream.write(`\nCOMMIT;\nPRAGMA foreign_keys=ON;\n`);
    onProgress?.('Done');
  } finally {
    await new Promise((r) => stream.end(r));
    db.close();
  }
  return { outFilePath };
}

async function restore(conn, sqlFilePath, onProgress) {
  // Open writable; create the file if it doesn't exist.
  const p = pickPath(conn);
  if (!p) throw new Error('SQLite needs a file path');
  const db = new Database(p);
  try {
    const text = fs.readFileSync(sqlFilePath, 'utf8');
    const stmts = splitSqlStatements(text, '"');
    onProgress?.(`Executing ${stmts.length} statements...`);
    db.exec('BEGIN');
    try {
      let n = 0;
      for (const s of stmts) {
        // Skip transaction control inside the file — we wrap it ourselves
        if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(s)) continue;
        db.exec(s);
        n++;
        if (n % 50 === 0) onProgress?.(`  ${n}/${stmts.length}`);
      }
      db.exec('COMMIT');
      onProgress?.(`Restore complete (${n} statements)`);
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return { ok: true };
  } finally { db.close(); }
}

function parseTableNamesFromDump(sqlFilePath) {
  return parseTableNamesFromDumpGeneric(fs.readFileSync(sqlFilePath, 'utf8'), '"');
}

// ============ v2 Theme B — cross-DB support ============

// Returns IR-shaped table descriptors for the named tables (or all if not given).
// IR shape per ../lib/cross-db/README.md.
function getSchema(conn, tableNames) {
  const db = open(conn, true);
  try {
    const tables = tableNames && tableNames.length
      ? tableNames
      : db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);

    const out = [];
    for (const tname of tables) {
      // PRAGMA table_info returns: cid, name, type, notnull, dflt_value, pk
      const cols = db.prepare(`PRAGMA table_info(${ident(tname)})`).all();
      if (cols.length === 0) continue;

      // PRAGMA index_list → all indexes; PRAGMA index_info per-index for column list
      const indexRows = db.prepare(`PRAGMA index_list(${ident(tname)})`).all();
      const indexes = [];
      for (const idx of indexRows) {
        if (idx.origin === 'pk') continue;     // implicit PK index — emitted via primaryKey flag
        const cols = db.prepare(`PRAGMA index_info(${ident(idx.name)})`).all();
        indexes.push({
          name: idx.name,
          columns: cols.map((c) => c.name),
          unique: idx.unique === 1,
        });
      }

      out.push({
        name: tname,
        columns: cols.map((c) => ({
          name: c.name,
          type: normalize('sqlite', c.type || 'TEXT'),
          nullable: c.notnull === 0,
          primaryKey: c.pk > 0,
          default: c.dflt_value,
          // SQLite's INTEGER PRIMARY KEY is implicitly auto-incrementing
          autoIncrement: c.pk > 0 && /\bINTEGER\b/i.test(c.type || ''),
        })),
        indexes,
      });
    }
    return out;
  } finally { db.close(); }
}

// Stream rows in the neutral format. Same options as dump() (options.tables to filter).
async function dumpNeutral(conn, options, outFilePath, onProgress) {
  const irTables = getSchema(conn, options.tables);
  const writer = new NeutralWriter(outFilePath);
  writer.writeHeader({
    sourceDialect: 'sqlite',
    db: pickPath(conn),
    tables: irTables.map((t) => t.name),
  });

  const db = open(conn, true);
  try {
    onProgress?.(`Neutral dump: ${irTables.length} table(s)`);
    for (const irt of irTables) {
      onProgress?.(`> ${irt.name}`);
      writer.writeSchema(irt);
      if (options.noData) continue;
      const stmt = db.prepare(`SELECT * FROM ${ident(irt.name)}`);
      let n = 0;
      for (const row of stmt.iterate()) {
        writer.writeRow(irt.name, encodeRow(row, irt.columns));
        n++;
        if (n % 5000 === 0) onProgress?.(`  ${irt.name}: ${n} rows...`);
      }
      onProgress?.(`  ${irt.name}: ${n} rows done`);
    }
  } finally { db.close(); }
  await writer.end();
  return { outFilePath };
}

// Restore from a neutral JSONL dump produced by ANY source adapter.
// Reads schema events → emits CREATE TABLE + CREATE INDEX in SQLite dialect,
// then row events → parameterized INSERTs.
async function restoreNeutral(conn, neutralPath, onProgress) {
  const p = pickPath(conn);
  if (!p) throw new Error('SQLite needs a file path');
  const db = new Database(p);
  const schemas = new Map();              // table name → IR schema event
  const inserters = new Map();            // table name → cached prepared INSERT
  const allWarnings = [];

  try {
    db.exec('PRAGMA foreign_keys=OFF; BEGIN TRANSACTION;');
    try {
      let rowCount = 0;
      for await (const evt of readNeutral(neutralPath)) {
        if (evt.op === 'header') {
          onProgress?.(`Source: ${evt.sourceDialect} ${evt.db} (${evt.tables?.length ?? '?'} table(s))`);
          continue;
        }
        if (evt.op === 'schema') {
          schemas.set(evt.table, evt);
          const { sql, warnings } = buildCreateTable(evt, 'sqlite');
          allWarnings.push(...warnings);
          db.exec(`DROP TABLE IF EXISTS ${ident(evt.table)};`);
          db.exec(sql + ';');
          for (const idx of buildCreateIndexes(evt, 'sqlite')) {
            try { db.exec(idx); }
            catch (e) { allWarnings.push(`${evt.table} index skipped: ${e.message}`); }
          }
          onProgress?.(`> ${evt.table} (re-created${warnings.length ? `, ${warnings.length} warning(s)` : ''})`);
          continue;
        }
        if (evt.op === 'row') {
          const schema = schemas.get(evt.table);
          if (!schema) throw new Error(`Row event for unknown table "${evt.table}" — schema event missing`);
          const colNames = schema.columns.map((c) => c.name);
          let insert = inserters.get(evt.table);
          if (!insert) {
            const sql = `INSERT INTO ${ident(evt.table)} (${colNames.map(ident).join(',')}) VALUES (${colNames.map(() => '?').join(',')})`;
            insert = db.prepare(sql);
            inserters.set(evt.table, insert);
          }
          const decoded = decodeRow(evt.values, schema.columns);
          // better-sqlite3 doesn't accept Buffer; pass raw bytes
          const vals = colNames.map((n) => {
            const v = decoded[n];
            if (v == null) return null;
            if (Buffer.isBuffer(v)) return v;
            if (v instanceof Date) return v.toISOString();
            if (typeof v === 'object') return JSON.stringify(v);
            if (typeof v === 'boolean') return v ? 1 : 0;
            if (typeof v === 'bigint') return v;
            return v;
          });
          insert.run(...vals);
          rowCount++;
          if (rowCount % 5000 === 0) onProgress?.(`  ${rowCount} rows inserted`);
        }
      }
      db.exec('COMMIT;');
      onProgress?.(`Restore complete: ${schemas.size} table(s), ${rowCount} row(s)${allWarnings.length ? `, ${allWarnings.length} warning(s)` : ''}`);
    } catch (e) {
      db.exec('ROLLBACK;');
      throw e;
    }
  } finally {
    db.exec('PRAGMA foreign_keys=ON;');
    db.close();
  }
  return { ok: true, warnings: allWarnings };
}

module.exports = { type: 'sqlite', testConnection, listTables, dump, restore, parseTableNamesFromDump, getSchema, dumpNeutral, restoreNeutral };
