// Long-running API tokens — v2 Theme C Phase 2。
//
// Tokens 設計給 cron / CI / scripts 用：不會因為 inactivity 過期，但可手動 revoke
// 或設絕對 expiry。格式 'dbmt_<32-byte url-safe random>'，prefix 讓人能在 secret
// store 裡認出來、leak detection scanner 也容易抓。
//
// 只儲存 SHA-256 hex（token 本身已經是高熵 random，bcrypt 多此一舉 + 慢）。
// 同個原則 GitHub PAT / npm token 都是這樣做。

const crypto = require('crypto');

const TOKEN_PREFIX = 'dbmt_';
const TOKEN_BYTES = 32;          // 256-bit random body
const PREFIX_DISPLAY_LEN = 12;   // 印在列表上的 prefix 長度（包含 'dbmt_'）

// scopes 集合 — 未來要加新 scope 時都加到這
const KNOWN_SCOPES = new Set([
  'user:read',   // GET /api/user/*（自己的 plan / sessions / etc.）
  'user:write',  // 改密碼、踢自己其他 session、要 checkout 等
]);
const DEFAULT_SCOPES = ['user:read', 'user:write'];

function generateToken() {
  const body = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  return TOKEN_PREFIX + body;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// 給 UI 顯示用的 prefix（不可逆，安全）
function previewPrefix(token) {
  return String(token).slice(0, PREFIX_DISPLAY_LEN) + '…';
}

function isApiToken(s) {
  return typeof s === 'string' && s.startsWith(TOKEN_PREFIX);
}

function validateScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error('scopes must be a non-empty array');
  }
  for (const s of scopes) {
    if (!KNOWN_SCOPES.has(s)) throw new Error(`unknown scope: ${s}`);
  }
  return scopes;
}

function hasScope(tokenScopes, required) {
  if (!Array.isArray(tokenScopes)) return false;
  return tokenScopes.includes(required);
}

module.exports = {
  TOKEN_PREFIX,
  PREFIX_DISPLAY_LEN,
  KNOWN_SCOPES,
  DEFAULT_SCOPES,
  generateToken,
  hashToken,
  previewPrefix,
  isApiToken,
  validateScopes,
  hasScope,
};
