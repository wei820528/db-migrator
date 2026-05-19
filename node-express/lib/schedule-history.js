// Theme A Phase 4 — scheduled backup history / retention / restore。
//
// 在 Phase 4 之前，scheduled-backups/ 是平層放所有 schedule 的輸出。Phase 4 改成
// per-schedule subdirectory：scheduled-backups/{sched-id}/{name}_{stamp}.{ext}
//
// 這樣 retention enforcement 可以針對單一 schedule 算（不會誤刪別人的）+ history
// 列表也乾淨。Legacy flat 檔仍然會被 _files/list 顯示出來（在 schedule.js route）。

const fs = require('fs');
const path = require('path');

// 取得單一 schedule 的歷史目錄 path
function historyDir(outputRoot, schedId) {
  return path.join(outputRoot, schedId);
}

// 列出該 schedule 的歷史備份檔，DESC by mtime
function listHistory(outputRoot, schedId) {
  const dir = historyDir(outputRoot, schedId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map((name) => {
      const full = path.join(dir, name);
      let st;
      try { st = fs.statSync(full); } catch { return null; }
      if (!st.isFile()) return null;
      return {
        name,
        fullPath: full,
        sizeBytes: st.size,
        mtime: st.mtimeMs,
        encrypted: name.endsWith('.enc'),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
}

// 計算「該刪掉」的檔。純函式 — 拿 entries (sorted DESC by mtime) + 規則，
// 回傳 should-be-deleted entries。實際 unlink 動作在 applyRetention()。
//
// 規則：
//   retentionCount > 0: 留最新 N 份，超過的全刪（第 N+1 名以後）
//   retentionDays  > 0: 刪 mtime < now - N*86400 秒的
//   兩者都設：取聯集（任一條 trigger 就刪）
//   都 0：什麼都不刪（不限）
function pickRetentionVictims(entries, { retentionCount = 0, retentionDays = 0, now = Date.now() } = {}) {
  if (entries.length === 0) return [];
  if (!retentionCount && !retentionDays) return [];
  const victims = [];
  const cutoffMs = retentionDays ? now - retentionDays * 86400 * 1000 : null;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const overCount = retentionCount && (i + 1 > retentionCount);
    const overAge   = cutoffMs !== null && e.mtime < cutoffMs;
    if (overCount || overAge) victims.push(e);
  }
  return victims;
}

// 跑 retention — 列歷史 + 算 victims + unlink。回傳 { deleted: [...names], kept: N }
function applyRetention(outputRoot, schedId, retention) {
  const all = listHistory(outputRoot, schedId);
  const victims = pickRetentionVictims(all, retention);
  const deleted = [];
  for (const v of victims) {
    try { fs.unlinkSync(v.fullPath); deleted.push(v.name); }
    catch (e) { /* keep going — best effort */ }
  }
  return { deleted, kept: all.length - deleted.length };
}

// 路徑 traversal 防禦：呼叫端拿到的 historyName 來自 user input，要驗
function isSafeHistoryName(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name.length > 255) return false;
  if (name.includes('..') || name.includes('/') || name.includes('\\')) return false;
  if (name.includes('\0')) return false;
  return true;
}

// 拿單一歷史檔的 full path（含 safety check）
function resolveHistoryPath(outputRoot, schedId, historyName) {
  if (!isSafeHistoryName(historyName)) {
    throw new Error('bad history name (path traversal blocked)');
  }
  const full = path.join(historyDir(outputRoot, schedId), historyName);
  // double check：normalized path 必須仍在 historyDir 下
  const dir = historyDir(outputRoot, schedId);
  if (!path.resolve(full).startsWith(path.resolve(dir) + path.sep) &&
      path.resolve(full) !== path.resolve(dir)) {
    throw new Error('bad history name (escapes history dir)');
  }
  if (!fs.existsSync(full)) {
    throw new Error('history file not found');
  }
  return full;
}

module.exports = {
  historyDir,
  listHistory,
  pickRetentionVictims,
  applyRetention,
  isSafeHistoryName,
  resolveHistoryPath,
};
