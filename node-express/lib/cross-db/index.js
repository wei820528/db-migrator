// Cross-DB migration — public surface.
// See README.md for status + design.

const { normalize } = require('./normalize');
const { emit }      = require('./emit');

// translate(source, sourceDialect, targetDialect)
//   → { sql, warnings }
//
// Convenience wrapper: parse source-dialect string into IR then emit for target.
//   translate('INT UNSIGNED', 'mysql', 'pg')
//     → { sql: 'BIGINT', warnings: ["PG has no unsigned int..."] }
function translate(source, sourceDialect, targetDialect) {
  const ir = normalize(sourceDialect, source);
  return emit(ir, targetDialect);
}

module.exports = { normalize, emit, translate };
