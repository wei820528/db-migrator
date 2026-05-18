// Plugin capability catalog — v2 Theme D Phase 1。
//
// 每個 plugin 在 manifest 宣告它要的 permissions。Marketplace install 時 UI
// 必須讓使用者明確勾選同意才能裝。Granted set 存在 `<plugin>/.granted-permissions.json`。
//
// 注意：**Phase 1 不做 runtime enforcement** — 這層只是「informed consent +
// audit trail」。Plugin 仍然能 require('fs') 為所欲為。Phase 2 才會加 worker_thread
// 隔離 + SDK ctx 把這些 permission 真正擋住。

// 已知 permission 列表 + 給人看的說明 + 危險程度（1-3）
const PERMISSIONS = {
  // === 公開 / 安全（grant 影響很小） ===
  'route': {
    label: 'Mount HTTP routes',
    description: '在 /api/plugin/<name>/* 下掛 endpoints',
    risk: 1,
  },
  'ui:cards': {
    label: 'Contribute UI cards',
    description: '在 Step 1 的 DB 類型卡片區加新 card',
    risk: 1,
  },
  'ui:tabs': {
    label: 'Contribute UI tabs',
    description: '在 mode-switch 加新 tab + panel',
    risk: 1,
  },
  'static': {
    label: 'Serve static assets',
    description: '在 /plugins/static/<name>/* 提供 css / js / image',
    risk: 1,
  },
  'adapter': {
    label: 'Register a new DB adapter',
    description: '可被選成連線目標；可看到使用者輸入的 host / user / password',
    risk: 3,
  },

  // === DB 存取（敏感） ===
  'db:read': {
    label: 'Read user DB data',
    description: '透過 SDK 讀取使用者連的 DB（SELECT）',
    risk: 2,
  },
  'db:write': {
    label: 'Write user DB data',
    description: '透過 SDK 寫使用者連的 DB（INSERT / UPDATE / DELETE）',
    risk: 3,
  },

  // === 檔案 / 網路（危險） ===
  'fs:tmp': {
    label: 'Read/write temp directory',
    description: '存取 node-express/tmp/，跨 plugin 共用',
    risk: 2,
  },
  'fs:plugin-dir': {
    label: 'Read/write own plugin directory',
    description: '存取 plugins/<name>/data/ 自己的私有空間',
    risk: 1,
  },
  'network': {
    label: 'Outbound network access',
    description: '對任何 URL 發 HTTP/HTTPS 請求（資料外洩風險）',
    risk: 3,
  },

  // === Escape hatch（grandfather 既有 plugin） ===
  'unrestricted': {
    label: '⚠ Unrestricted (legacy)',
    description: '完整 Node.js 存取（require fs / child_process / 等等）— 沒有限制。給 Phase 1 之前寫的 plugin 用',
    risk: 3,
  },
};

const KNOWN = new Set(Object.keys(PERMISSIONS));

// 驗證 manifest.permissions 陣列；返回 normalized array 或 throw
function validatePermissions(perms) {
  if (perms === undefined || perms === null) {
    // 沒宣告 = legacy plugin = grandfather 成 unrestricted（但給 warning）
    return { permissions: ['unrestricted'], legacy: true };
  }
  if (!Array.isArray(perms)) {
    throw new Error('manifest.permissions must be an array');
  }
  const out = [];
  for (const p of perms) {
    if (typeof p !== 'string') throw new Error('permissions must be strings');
    if (!KNOWN.has(p)) throw new Error(`unknown permission: ${p}`);
    if (!out.includes(p)) out.push(p);
  }
  if (out.length === 0) {
    throw new Error('manifest.permissions cannot be empty array (omit the field for legacy unrestricted)');
  }
  return { permissions: out, legacy: false };
}

// 給 UI 用：把 permission ID 列表 enrich 成 [{id, label, desc, risk}]
function describePermissions(ids) {
  return ids.map((id) => ({
    id,
    label:       PERMISSIONS[id]?.label || id,
    description: PERMISSIONS[id]?.description || '(unknown permission)',
    risk:        PERMISSIONS[id]?.risk ?? 3,
  }));
}

// 給 install 流程：拿到 user 同意的 grants（subset of requested），檢查是否合法
function verifyGrants(requested, granted) {
  const reqSet = new Set(requested);
  for (const g of granted || []) {
    if (!reqSet.has(g)) throw new Error(`granted permission "${g}" was not requested by plugin`);
  }
  return granted || [];
}

module.exports = {
  PERMISSIONS,
  KNOWN_PERMISSIONS: KNOWN,
  validatePermissions,
  describePermissions,
  verifyGrants,
};
