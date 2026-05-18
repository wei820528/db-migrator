// Cross-DB migration — 對外 public surface。
// 詳見 README.md 的 status 與設計。

const { normalize } = require('./normalize');
const { emit }      = require('./emit');

// translate(source, sourceDialect, targetDialect)
//   → { sql, warnings }
//
// 便利包裝：先把 source-dialect 字串 parse 成 IR，再 emit 成 target。
//   translate('INT UNSIGNED', 'mysql', 'pg')
//     → { sql: 'BIGINT', warnings: ["PG has no unsigned int..."] }
function translate(source, sourceDialect, targetDialect) {
  const ir = normalize(sourceDialect, source);
  return emit(ir, targetDialect);
}

module.exports = { normalize, emit, translate };
