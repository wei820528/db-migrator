// Online license: app talks to a license server. Login + heartbeat + cached features.
//
// State held in this module (per-app-process):
//   { token, user, status, daysLeft, features, maxDevices, kicked, lastError, lastHeartbeat }
//
// Browser logs in via /api/license-online/login → server stores token and starts heartbeat loop.

const fs = require('fs');
const path = require('path');

const SERVER_URL = process.env.LICENSE_SERVER_URL || 'http://localhost:4000';
const TOKEN_PATH = path.join(__dirname, '..', '.auth-token');
const HEARTBEAT_MS = 30 * 1000;

const state = {
  serverUrl: SERVER_URL,
  token: null,
  user: null,
  status: null,         // 'trial' | 'licensed' | 'expired' | 'kicked' | 'offline'
  daysLeft: null,
  features: {},
  maxDevices: null,
  kicked: false,
  lastError: null,
  lastHeartbeat: null,
};

function loadStoredToken() {
  try {
    if (fs.existsSync(TOKEN_PATH)) state.token = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
  } catch {}
}
function saveToken(t) {
  state.token = t;
  try { fs.writeFileSync(TOKEN_PATH, t); } catch (e) { console.warn('[license] could not save token:', e.message); }
}
function clearToken() {
  state.token = null;
  try { fs.unlinkSync(TOKEN_PATH); } catch {}
}

async function call(method, path_, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(state.serverUrl + path_, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: r.status, ok: r.ok, data };
}

async function register(email, password) {
  const r = await call('POST', '/api/auth/register', { email, password });
  if (!r.ok) throw new Error(r.data.error || `register failed (${r.status})`);
  return r.data;
}

async function login(email, password) {
  const r = await call('POST', '/api/auth/login', { email, password });
  if (!r.ok) throw new Error(r.data.error || `login failed (${r.status})`);
  saveToken(r.data.token);
  applyAuthResponse(r.data);
  return state;
}

async function logout() {
  if (state.token) await call('POST', '/api/auth/logout', null, state.token).catch(() => {});
  clearToken();
  state.user = null;
  state.status = null;
  state.daysLeft = null;
  state.features = {};
  state.kicked = false;
}

function applyAuthResponse(d) {
  state.user = d.user;
  state.status = d.status;
  state.daysLeft = d.daysLeft;
  state.features = d.features || {};
  state.maxDevices = d.maxDevices;
  state.kicked = false;
  state.lastError = null;
  state.lastHeartbeat = new Date().toISOString();
}

async function heartbeat() {
  if (!state.token) {
    state.status = 'expired';
    return state;
  }
  try {
    const r = await call('POST', '/api/auth/heartbeat', null, state.token);
    if (r.status === 401) {
      // Kicked or no session
      state.kicked = true;
      state.status = 'kicked';
      state.lastError = r.data.error || 'kicked';
      clearToken();
      return state;
    }
    if (r.status === 403) {
      // Expired plan
      state.status = 'expired';
      state.lastError = r.data.error || 'expired';
      return state;
    }
    if (!r.ok) {
      state.lastError = r.data.error || `heartbeat failed (${r.status})`;
      return state;
    }
    applyAuthResponse(r.data);
    return state;
  } catch (e) {
    // Network error → don't immediately kick, keep last known state but flag offline
    state.lastError = `cannot reach license server: ${e.message}`;
    state.status = state.status || 'offline';
    return state;
  }
}

function getState() {
  return { ...state, hasToken: !!state.token };
}

// Feature checks — used by the gate middleware
function hasFeature(name) {
  return !!state.features?.[name];
}
function getFeatureValue(name) {
  return state.features?.[name];
}

// Start the heartbeat loop. Returns the timer.
function startHeartbeatLoop() {
  loadStoredToken();
  if (state.token) heartbeat();   // initial check
  const t = setInterval(() => heartbeat(), HEARTBEAT_MS);
  if (t.unref) t.unref();
  return t;
}

module.exports = {
  startHeartbeatLoop,
  register, login, logout, heartbeat,
  getState, hasFeature, getFeatureValue,
};
