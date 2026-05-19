// Structured / human logger — v2 Theme E Phase 1。
//
// 用 LOG_FORMAT env 切換輸出格式：
//   LOG_FORMAT=json  → 每行一個 JSON object {ts, level, msg, ...extra}
//                      （送進 ELK / Loki / CloudWatch logs 容易 parse）
//   LOG_FORMAT=human → 預設，人類好讀（彩色 timestamp + level）
//
// 用法跟 console.log 對齊 — 替換點少、改動小：
//   const log = require('./logger');
//   log.info('server started', { port: 3000 });
//   log.warn('slow query', { ms: 1234, sql: '...' });
//   log.error('something broke', err);

const FORMAT = process.env.LOG_FORMAT === 'json' ? 'json' : 'human';

// 顏色 (僅 human mode 用，且僅 stderr 是 TTY 時開)
const useColor = FORMAT === 'human' && process.stderr.isTTY && process.env.NO_COLOR == null;
const C = {
  reset: useColor ? '\x1b[0m' : '',
  gray:  useColor ? '\x1b[90m' : '',
  cyan:  useColor ? '\x1b[36m' : '',
  yellow:useColor ? '\x1b[33m' : '',
  red:   useColor ? '\x1b[31m' : '',
  bold:  useColor ? '\x1b[1m'  : '',
};

const LEVEL_COLORS = { debug: C.gray, info: C.cyan, warn: C.yellow, error: C.red };

function emit(level, msg, extra) {
  if (FORMAT === 'json') {
    const obj = { ts: new Date().toISOString(), level, msg: String(msg) };
    if (extra !== undefined) {
      if (extra instanceof Error) {
        obj.error = { name: extra.name, message: extra.message, stack: extra.stack };
      } else if (typeof extra === 'object' && extra !== null) {
        Object.assign(obj, extra);
      } else {
        obj.detail = extra;
      }
    }
    process.stderr.write(JSON.stringify(obj) + '\n');
  } else {
    const tag = LEVEL_COLORS[level] + level.toUpperCase().padEnd(5) + C.reset;
    const ts  = C.gray + new Date().toISOString() + C.reset;
    let line = `${ts} ${tag} ${msg}`;
    if (extra !== undefined) {
      if (extra instanceof Error) {
        line += '\n  ' + (extra.stack || extra.message);
      } else if (typeof extra === 'object' && extra !== null) {
        line += '  ' + C.gray + JSON.stringify(extra) + C.reset;
      } else {
        line += '  ' + C.gray + String(extra) + C.reset;
      }
    }
    process.stderr.write(line + '\n');
  }
}

module.exports = {
  format: FORMAT,
  debug: (msg, extra) => emit('debug', msg, extra),
  info:  (msg, extra) => emit('info',  msg, extra),
  warn:  (msg, extra) => emit('warn',  msg, extra),
  error: (msg, extra) => emit('error', msg, extra),
  // 給 test / debug 用
  _emit: emit,
};
