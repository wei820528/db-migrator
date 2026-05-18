// Cross-DB preview helpers — 純函式，沒有 express / I/O 依賴。
// /api/cross-db/preview-live 那層（routes/cross-db.js）是 buildTablePreview()
// 的薄薄一層 HTTP 包裝。

const { buildCreateTable, buildCreateIndexes, buildColumnDdl } = require('./tables');

// 給一張 IR table object + target dialect，回傳 UI 要 render 的 preview payload：
// per-column source→target 型別對照、預測的 CREATE TABLE、indexes、deduped 過的
// table-level warning list。
//
// per-column `targetType` 走的是跟實際 CREATE TABLE 一樣的 path（buildColumnDdl），
// 所以 SERIAL / AUTO_INCREMENT / INTEGER PRIMARY KEY 這類眉角會正確反映出來，
// 而不是只看到 emit() 的裸型別。
function buildTablePreview(ir, target) {
  const ct = buildCreateTable(ir, target);
  const indexes = buildCreateIndexes(ir, target);
  const columns = ir.columns.map((col) => {
    const r = buildColumnDdl(col, target);
    return {
      name: col.name,
      sourceType: col.sourceTypeRaw || stringifyIr(col.type),
      targetType: extractTypeFromDdl(r.ddl, col.name, target),
      nullable: col.nullable,
      primaryKey: !!col.primaryKey,
      autoIncrement: !!col.autoIncrement,
      warnings: r.warnings,
    };
  });
  return {
    table: ir.name,
    columns,
    indexes,
    createTable: ct.sql,
    warnings: [...new Set(ct.warnings)],
  };
}

// `buildColumnDdl` 會回類似 "`id` INT AUTO_INCREMENT" 或 '"id" SERIAL' 這種字串。
// Preview UI 只想要型別部分（quoted column name 之後、constraint clauses 之前 ——
// 像 NOT NULL / DEFAULT 我們在別處單獨顯示）。簡單拆掉前綴 quoted identifier 即可。
function extractTypeFromDdl(ddl, colName, target) {
  const quoteChar = target === 'mysql' ? '`' : '"';
  // 比對 column-name prefix：<quote>colName<quote>（內部 quote 字元已被 doubled escape）
  const prefix = quoteChar + String(colName).replace(new RegExp(quoteChar, 'g'), quoteChar + quoteChar) + quoteChar;
  return ddl.startsWith(prefix) ? ddl.slice(prefix.length).trim() : ddl;
}

// 沒有 sourceTypeRaw 時，把 IR `type` 簡短渲染成可讀字串給 UI 用。
function stringifyIr(t) {
  if (!t || !t.kind) return '(unknown)';
  switch (t.kind) {
    case 'int':      return `int${t.size || ''}` + (t.unsigned ? ' unsigned' : '');
    case 'float':    return `float${t.size || ''}`;
    case 'decimal':  return t.precision != null ? `decimal(${t.precision}${t.scale != null ? ',' + t.scale : ''})` : 'decimal';
    case 'string':   return `string(${t.size || '?'})`;
    case 'binary':   return `binary(${t.size || '?'})`;
    case 'enum':     return `enum(${(t.values || []).length} value(s))`;
    case 'datetime': return t.timezone ? 'datetime tz' : 'datetime';
    case 'unknown':  return `unknown:${t.raw || ''}`;
    default:         return t.kind;
  }
}

module.exports = { buildTablePreview, stringifyIr };
