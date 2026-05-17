// Lazy-load adapters. If one driver (e.g. native better-sqlite3) fails to require,
// the others stay usable. Status is reported via getStatus() for the UI.
//
// Plugins can also registerAdapter() at runtime to add new DB types.

const loaders = {
  mysql:    () => require('./mysql'),
  postgres: () => require('./postgres'),
  mssql:    () => require('./mssql'),
  sqlite:   () => require('./sqlite'),
  supabase: () => require('./postgres'),  // Supabase IS Postgres
  mongo:    () => require('./mongo'),
  redis:    () => require('./redis'),
};

const cache = {};      // type -> adapter module
const status = {};     // type -> { ok: bool, error?: string, source?: 'builtin'|'plugin:<name>' }

function tryLoad(type) {
  if (cache[type]) return { ok: true, adapter: cache[type] };
  const loader = loaders[type];
  if (!loader) return { ok: false, error: `Unsupported type: ${type}` };
  try {
    cache[type] = loader();
    status[type] = { ok: true, source: status[type]?.source || 'builtin' };
    return { ok: true, adapter: cache[type] };
  } catch (e) {
    status[type] = { ok: false, error: e.message, source: status[type]?.source || 'builtin' };
    return { ok: false, error: e.message };
  }
}

function getAdapter(type) {
  const r = tryLoad(type);
  if (!r.ok) throw new Error(`Adapter "${type}" unavailable: ${r.error}`);
  return r.adapter;
}

function getStatus() {
  for (const type of Object.keys(loaders)) {
    if (!status[type]) tryLoad(type);
  }
  return { ...status };
}

// Plugins can call this to register a new adapter type at runtime.
function registerAdapter(type, handler, source = 'plugin') {
  if (!handler || typeof handler.testConnection !== 'function')
    throw new Error('adapter handler must implement testConnection()');
  loaders[type] = () => handler;
  cache[type] = handler;
  status[type] = { ok: true, source };
}

function unregisterAdapter(type) {
  delete loaders[type];
  delete cache[type];
  delete status[type];
}

module.exports = { getAdapter, getStatus, registerAdapter, unregisterAdapter };
