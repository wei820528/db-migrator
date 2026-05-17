// Neutral dump format — read / write JSONL event stream.
//
// Format = JSON Lines. Each line is one event. Three event types:
//
//   { "op": "header", "format": "neutral-v1", "sourceDialect": "mysql",
//     "db": "<name>", "generated": "<ISO>", "tables": ["users","orders"] }
//
//   { "op": "schema", "table": "users",
//     "columns": [
//       { "name": "id",    "type": { "kind": "int", "size": 32, "unsigned": true },
//         "nullable": false, "primaryKey": true, "autoIncrement": true },
//       { "name": "email", "type": { "kind": "string", "size": 128 },
//         "nullable": false, "unique": true }
//     ],
//     "indexes": [
//       { "name": "idx_users_email", "columns": ["email"], "unique": true }
//     ] }
//
//   { "op": "row", "table": "users", "values": { "id": 1, "email": "a@x.com" } }
//
// Order matters: header must come first, then for each table its schema
// event must precede that table's row events. Tables themselves can be
// interleaved or grouped — the reader keeps a name→schema map.
//
// `format: "neutral-v1"` is the version marker. If we ever break the format
// we bump to "neutral-v2" and readers can reject incompatible files.

const fs = require('fs');
const readline = require('readline');

const FORMAT_VERSION = 'neutral-v1';

class NeutralWriter {
  constructor(filePath) {
    this.stream = fs.createWriteStream(filePath, { encoding: 'utf8' });
    this.tablesEmitted = new Set();
  }
  writeHeader({ sourceDialect, db, tables }) {
    this._writeLine({
      op: 'header',
      format: FORMAT_VERSION,
      sourceDialect,
      db,
      generated: new Date().toISOString(),
      tables,
    });
  }
  writeSchema(irTable) {
    this._writeLine({
      op: 'schema',
      table: irTable.name,
      columns: irTable.columns,
      indexes: irTable.indexes || [],
    });
    this.tablesEmitted.add(irTable.name);
  }
  writeRow(table, values) {
    this._writeLine({ op: 'row', table, values });
  }
  async end() {
    return new Promise((resolve) => this.stream.end(resolve));
  }
  _writeLine(obj) {
    this.stream.write(JSON.stringify(obj) + '\n');
  }
}

// Generator-style reader: yields events in order, lazily.
async function* readNeutral(filePath) {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    let evt;
    try { evt = JSON.parse(t); } catch (e) { throw new Error(`Bad JSON in dump: ${e.message}`); }
    if (!evt.op) throw new Error(`Event missing "op" field`);
    yield evt;
  }
}

// Quick metadata read — load header + all schema events without iterating rows.
// Useful for the dry-run preview UI: shows what will be migrated before pushing data.
async function readMetadata(filePath) {
  let header = null;
  const schemas = [];
  for await (const evt of readNeutral(filePath)) {
    if (evt.op === 'header') header = evt;
    else if (evt.op === 'schema') schemas.push(evt);
    else if (evt.op === 'row') break;   // metadata only — stop at first data row
  }
  return { header, schemas };
}

module.exports = { NeutralWriter, readNeutral, readMetadata, FORMAT_VERSION };
