// Neutral dump 格式 — read / write JSONL event 串流。
//
// 格式 = JSON Lines（一行一個 event）。三種 event：
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
// 順序很重要：header 一定要在最前面；每張 table 的 schema event 一定要在
// 自己的 row events 前面。Tables 之間可以交錯或集中 — reader 維護 name→schema map。
//
// `format: "neutral-v1"` 是版本標記。將來若 break format 就升 "neutral-v2"，
// reader 可以拒絕不相容的檔案。

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

// Generator 風格的 reader：lazy 依序 yield events。
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

// （錯誤訊息保留英文，方便 grep / log。Comments 以外的 user-facing 訊息一律英文。）

// 快速讀 metadata — 只載入 header 跟所有 schema events，不掃 rows。
// 給 dry-run preview UI 用：在實際推資料前先讓使用者看會遷移什麼。
async function readMetadata(filePath) {
  let header = null;
  const schemas = [];
  for await (const evt of readNeutral(filePath)) {
    if (evt.op === 'header') header = evt;
    else if (evt.op === 'schema') schemas.push(evt);
    else if (evt.op === 'row') break;   // metadata-only — 碰到第一個 row event 就停
  }
  return { header, schemas };
}

module.exports = { NeutralWriter, readNeutral, readMetadata, FORMAT_VERSION };
