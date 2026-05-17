const fs = require('fs');
const mysql = require('mysql2');
const mysqlPromise = require('mysql2/promise');
const { extractRoutineBlocks, ROUTINE_BEGIN, ROUTINE_END } = require('./_shared');

function buildConnConfig(c, extra = {}) {
  return {
    host: c.host,
    port: Number(c.port) || 3306,
    user: c.user,
    password: c.password,
    database: c.database,
    connectTimeout: 8000,
    charset: 'utf8mb4',
    ...extra,
  };
}

async function testConnection(conn) {
  // Connect without database so we can list all schemas the user can see.
  const c = await mysqlPromise.createConnection(buildConnConfig({ ...conn, database: undefined }));
  try {
    const [vrows] = await c.query('SELECT VERSION() AS version');
    const [drows] = await c.query(
      `SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA
       WHERE SCHEMA_NAME NOT IN ('information_schema','mysql','performance_schema','sys')
       ORDER BY SCHEMA_NAME`
    );
    return { ok: true, version: vrows[0].version, databases: drows.map((r) => r.name) };
  } finally {
    await c.end();
  }
}

async function listTables(conn) {
  const c = await mysqlPromise.createConnection(buildConnConfig(conn));
  try {
    const [rows] = await c.query(
      'SELECT TABLE_NAME AS name, TABLE_ROWS AS rowEstimate ' +
        'FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
      [conn.database]
    );
    return rows;
  } finally {
    await c.end();
  }
}

function escapeIdent(name) {
  return '`' + String(name).replace(/`/g, '``') + '`';
}

function formatValue(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (Buffer.isBuffer(v)) return '0x' + v.toString('hex');
  if (v instanceof Date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `'${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())} ` +
      `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}:${pad(v.getUTCSeconds())}'`;
  }
  return mysql.escape(v);
}

async function dumpTableSchema(conn, table, stream) {
  const [rows] = await conn.query(`SHOW CREATE TABLE ${escapeIdent(table)}`);
  const ddl = rows[0]['Create Table'];
  stream.write(`\n-- ----------------------------\n-- Table structure: ${table}\n-- ----------------------------\n`);
  stream.write(`DROP TABLE IF EXISTS ${escapeIdent(table)};\n`);
  stream.write(ddl + ';\n\n');
}

function dumpTableData(rawConn, table, stream, onProgress) {
  return new Promise((resolve, reject) => {
    stream.write(`-- ----------------------------\n-- Data: ${table}\n-- ----------------------------\n`);

    const queryStream = rawConn.query(`SELECT * FROM ${escapeIdent(table)}`).stream({ highWaterMark: 200 });

    let buffer = [];
    let columnsLine = null;
    let rowCount = 0;
    const MAX_BATCH = 500;
    const MAX_BYTES = 512 * 1024; // ~0.5MB per INSERT
    let bufferBytes = 0;

    function flush() {
      if (buffer.length === 0) return;
      stream.write(`INSERT INTO ${escapeIdent(table)} ${columnsLine} VALUES\n` + buffer.join(',\n') + ';\n');
      buffer = [];
      bufferBytes = 0;
    }

    queryStream.on('data', (row) => {
      if (!columnsLine) {
        const cols = Object.keys(row).map(escapeIdent);
        columnsLine = '(' + cols.join(',') + ')';
      }
      const values = Object.values(row).map(formatValue).join(',');
      const line = '  (' + values + ')';
      buffer.push(line);
      bufferBytes += line.length;
      rowCount++;
      if (buffer.length >= MAX_BATCH || bufferBytes >= MAX_BYTES) flush();
      if (rowCount % 5000 === 0) onProgress?.(`  ${table}: ${rowCount} rows...`);
    });

    queryStream.on('end', () => {
      flush();
      stream.write('\n');
      onProgress?.(`  ${table}: ${rowCount} rows done`);
      resolve();
    });

    queryStream.on('error', reject);
  });
}

async function dump(conn, options, outFilePath, onProgress) {
  // Use the non-promise driver because its .stream() API is friendlier for row streaming.
  const rawConn = mysql.createConnection(buildConnConfig(conn));
  await new Promise((res, rej) => rawConn.connect((e) => (e ? rej(e) : res())));
  const promiseConn = rawConn.promise();

  const stream = fs.createWriteStream(outFilePath, { encoding: 'utf8' });

  try {
    stream.write(`-- DB Migrator dump\n`);
    stream.write(`-- Database: ${conn.database}\n`);
    stream.write(`-- Generated: ${new Date().toISOString()}\n\n`);
    stream.write(`SET NAMES utf8mb4;\n`);
    stream.write(`SET FOREIGN_KEY_CHECKS=0;\n`);
    stream.write(`SET SQL_MODE='NO_AUTO_VALUE_ON_ZERO';\n\n`);

    let tables;
    if (options.tables && options.tables.length) {
      tables = options.tables;
    } else {
      const [rows] = await promiseConn.query(
        'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = "BASE TABLE" ORDER BY TABLE_NAME',
        [conn.database]
      );
      tables = rows.map((r) => r.TABLE_NAME);
    }

    onProgress?.(`Dumping ${tables.length} table(s)`);

    for (const table of tables) {
      onProgress?.(`> ${table}`);
      if (!options.noSchema) await dumpTableSchema(promiseConn, table, stream);
      if (!options.noData) await dumpTableData(rawConn, table, stream, onProgress);
    }

    // ===== Triggers — MySQL's FK + indexes are already in SHOW CREATE TABLE =====
    if (!options.noSchema) {
      try {
        const [trigs] = await promiseConn.query(
          `SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE FROM information_schema.TRIGGERS
           WHERE TRIGGER_SCHEMA = ? ORDER BY EVENT_OBJECT_TABLE, TRIGGER_NAME`,
          [conn.database]
        );
        const tableSet = new Set(tables);
        const relevant = trigs.filter((t) => tableSet.has(t.EVENT_OBJECT_TABLE));
        if (relevant.length > 0) {
          stream.write(`\n-- ----------------------------\n-- Triggers (${relevant.length})\n-- ----------------------------\n`);
          for (const t of relevant) {
            const [[row]] = await promiseConn.query(`SHOW CREATE TRIGGER ${escapeIdent(t.TRIGGER_NAME)}`);
            const ddl = row?.['SQL Original Statement'];
            if (ddl) {
              stream.write(`DROP TRIGGER IF EXISTS ${escapeIdent(t.TRIGGER_NAME)};\n`);
              stream.write(`${ROUTINE_BEGIN} trigger ${t.TRIGGER_NAME}\n${ddl}\n${ROUTINE_END}\n\n`);
            }
          }
          onProgress?.(`  ${relevant.length} trigger(s)`);
        }
      } catch (e) { stream.write(`\n-- (skipped trigger dump: ${e.message})\n`); }

      // ===== Views =====
      try {
        const [views] = await promiseConn.query(
          `SELECT TABLE_NAME FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
          [conn.database]
        );
        if (views.length > 0) {
          stream.write(`\n-- ----------------------------\n-- Views (${views.length})\n-- ----------------------------\n`);
          for (const v of views) {
            try {
              const [[row]] = await promiseConn.query(`SHOW CREATE VIEW ${escapeIdent(v.TABLE_NAME)}`);
              const ddl = row?.['Create View'];
              if (ddl) {
                stream.write(`DROP VIEW IF EXISTS ${escapeIdent(v.TABLE_NAME)};\n${ddl};\n\n`);
              }
            } catch (e) { stream.write(`-- (view ${v.TABLE_NAME} skipped: ${e.message})\n`); }
          }
          onProgress?.(`  ${views.length} view(s)`);
        }
      } catch (e) { stream.write(`\n-- (skipped view dump: ${e.message})\n`); }

      // ===== Stored procedures + functions =====
      try {
        const [routines] = await promiseConn.query(
          `SELECT ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES
           WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_TYPE, ROUTINE_NAME`,
          [conn.database]
        );
        const procs = routines.filter((r) => r.ROUTINE_TYPE === 'PROCEDURE');
        const funcs = routines.filter((r) => r.ROUTINE_TYPE === 'FUNCTION');

        if (procs.length > 0) {
          stream.write(`\n-- ----------------------------\n-- Stored procedures (${procs.length})\n-- ----------------------------\n`);
          for (const p of procs) {
            try {
              const [[row]] = await promiseConn.query(`SHOW CREATE PROCEDURE ${escapeIdent(p.ROUTINE_NAME)}`);
              const ddl = row?.['Create Procedure'];
              if (ddl) {
                stream.write(`DROP PROCEDURE IF EXISTS ${escapeIdent(p.ROUTINE_NAME)};\n`);
                stream.write(`${ROUTINE_BEGIN} procedure ${p.ROUTINE_NAME}\n${ddl}\n${ROUTINE_END}\n\n`);
              }
            } catch (e) { stream.write(`-- (proc ${p.ROUTINE_NAME} skipped: ${e.message})\n`); }
          }
          onProgress?.(`  ${procs.length} procedure(s)`);
        }

        if (funcs.length > 0) {
          stream.write(`\n-- ----------------------------\n-- Functions (${funcs.length})\n-- ----------------------------\n`);
          for (const f of funcs) {
            try {
              const [[row]] = await promiseConn.query(`SHOW CREATE FUNCTION ${escapeIdent(f.ROUTINE_NAME)}`);
              const ddl = row?.['Create Function'];
              if (ddl) {
                stream.write(`DROP FUNCTION IF EXISTS ${escapeIdent(f.ROUTINE_NAME)};\n`);
                stream.write(`${ROUTINE_BEGIN} function ${f.ROUTINE_NAME}\n${ddl}\n${ROUTINE_END}\n\n`);
              }
            } catch (e) { stream.write(`-- (func ${f.ROUTINE_NAME} skipped: ${e.message})\n`); }
          }
          onProgress?.(`  ${funcs.length} function(s)`);
        }
      } catch (e) { stream.write(`\n-- (skipped routine dump: ${e.message})\n`); }

      // ===== Events =====
      try {
        const [events] = await promiseConn.query(
          `SELECT EVENT_NAME FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME`,
          [conn.database]
        );
        if (events.length > 0) {
          stream.write(`\n-- ----------------------------\n-- Events (${events.length})\n-- ----------------------------\n`);
          for (const ev of events) {
            try {
              const [[row]] = await promiseConn.query(`SHOW CREATE EVENT ${escapeIdent(ev.EVENT_NAME)}`);
              const ddl = row?.['Create Event'];
              if (ddl) {
                stream.write(`DROP EVENT IF EXISTS ${escapeIdent(ev.EVENT_NAME)};\n`);
                stream.write(`${ROUTINE_BEGIN} event ${ev.EVENT_NAME}\n${ddl}\n${ROUTINE_END}\n\n`);
              }
            } catch (e) { stream.write(`-- (event ${ev.EVENT_NAME} skipped: ${e.message})\n`); }
          }
          onProgress?.(`  ${events.length} event(s)`);
        }
      } catch (e) { stream.write(`\n-- (skipped event dump: ${e.message})\n`); }
    }

    stream.write(`SET FOREIGN_KEY_CHECKS=1;\n`);
    onProgress?.('Done');
  } finally {
    await new Promise((r) => stream.end(r));
    rawConn.end();
  }

  return { outFilePath };
}

async function restore(conn, sqlFilePath, onProgress) {
  // multipleStatements lets us run the bulk of the dump (DDL + INSERTs) in one shot.
  // Routine / trigger / event bodies contain internal `;` so we send each one
  // as a single un-split statement, isolated by ROUTINE_BEGIN/END markers.
  const c = await mysqlPromise.createConnection(
    buildConnConfig(conn, { multipleStatements: true })
  );
  try {
    const sql = fs.readFileSync(sqlFilePath, 'utf8');
    onProgress?.(`Executing ${(sql.length / 1024).toFixed(1)} KB of SQL...`);

    const blocks = extractRoutineBlocks(sql);
    const sqlChunks = blocks.filter((b) => b.kind === 'sql').length;
    const routineCount = blocks.filter((b) => b.kind === 'routine').length;
    if (routineCount > 0) onProgress?.(`  ${sqlChunks} SQL chunk(s) + ${routineCount} routine(s)`);

    for (const b of blocks) {
      if (b.kind === 'sql') {
        if (b.body.trim()) await c.query(b.body);
      } else {
        // Routine body: strip a trailing semicolon if any (CREATE PROC body wraps its own END)
        const body = b.body.replace(/;\s*$/, '');
        await c.query(body);
      }
    }
    onProgress?.('Restore complete');
    return { ok: true };
  } finally {
    await c.end();
  }
}

function parseTableNamesFromDump(sqlFilePath) {
  const text = fs.readFileSync(sqlFilePath, 'utf8');
  const tables = new Set();
  const re = /CREATE TABLE(?: IF NOT EXISTS)?\s+`?([^`\s(]+)`?/gi;
  let m;
  while ((m = re.exec(text)) !== null) tables.add(m[1]);
  return [...tables];
}

module.exports = {
  type: 'mysql',
  testConnection,
  listTables,
  dump,
  restore,
  parseTableNamesFromDump,
};
