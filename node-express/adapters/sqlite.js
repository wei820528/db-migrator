const fs = require('fs');
const Database = require('better-sqlite3');
const { escapeIdent, formatValueGeneric, splitSqlStatements, parseTableNamesFromDumpGeneric } = require('./_shared');

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

module.exports = { type: 'sqlite', testConnection, listTables, dump, restore, parseTableNamesFromDump };
