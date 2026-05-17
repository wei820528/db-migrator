#!/usr/bin/env node
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('./db');
const { PLANS } = require('./plans');

const cmd = process.argv[2];
const arg = (name) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

function help() {
  console.log(`Usage:
  node admin-cli.js create-user --email a@b.c --password XXX [--plan trial|basic|team|enterprise] [--devices N] [--expires YYYY-MM-DD]
  node admin-cli.js list-users
  node admin-cli.js list-sessions [--email a@b.c]
  node admin-cli.js list-events [--email a@b.c] [--limit 50]
  node admin-cli.js set-plan --email a@b.c --plan team [--devices 5] [--expires YYYY-MM-DD]
  node admin-cli.js reset-trial --email a@b.c
  node admin-cli.js revoke --email a@b.c             # set expires=now, kick all sessions
  node admin-cli.js kick-all --email a@b.c           # just kick all sessions, leave plan alone
  node admin-cli.js delete-user --email a@b.c
  node admin-cli.js make-admin --email a@b.c         # promote existing user to admin
  node admin-cli.js set-free --email a@b.c --days 30 # give free month override
  node admin-cli.js plans                            # show plan definitions

  node admin-cli.js list-licenses [--filter active|revoked]
  node admin-cli.js add-license <json>               # e.g. '{"id":"<uuid>","customer":"Acme","plan":"team","expires_at":"2027-05-15T..."}'
  node admin-cli.js import-licenses --file ../license-tools/issued-licenses.jsonl
  node admin-cli.js revoke-license --id <uuid> [--reason "abuse"]
  node admin-cli.js unrevoke-license --id <uuid>
`);
}

function findUser(email) {
  if (!email) throw new Error('--email required');
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  if (!u) throw new Error(`No such user: ${email}`);
  return u;
}

try {
  switch (cmd) {
    case 'create-user': {
      const email = arg('email'), password = arg('password');
      if (!email || !password) throw new Error('--email and --password required');
      const plan = arg('plan') || 'trial';
      if (!PLANS[plan]) throw new Error(`Unknown plan: ${plan}. Available: ${Object.keys(PLANS).join(', ')}`);
      const devices = Number(arg('devices') || PLANS[plan].max_devices || 1);
      const expires = arg('expires');

      const id = crypto.randomUUID();
      const hash = bcrypt.hashSync(password, 10);
      const trialStart = plan === 'trial' ? new Date().toISOString() : null;
      const expIso = expires ? new Date(expires + 'T23:59:59Z').toISOString() : null;
      db.prepare(`INSERT INTO users (id, email, password_hash, plan, max_devices, trial_started_at, expires_at)
                  VALUES (?,?,?,?,?,?,?)`)
        .run(id, email.toLowerCase(), hash, plan, devices, trialStart, expIso);
      console.log(`Created: ${email} | plan=${plan} | devices=${devices} | expires=${expIso || '(trial=7d from now)'}`);
      break;
    }

    case 'list-users': {
      const rows = db.prepare(`SELECT email, plan, max_devices, trial_started_at, expires_at, created_at,
        (SELECT COUNT(*) FROM sessions WHERE user_id = users.id) AS active_sessions
        FROM users ORDER BY created_at DESC`).all();
      console.table(rows);
      break;
    }

    case 'list-sessions': {
      const email = arg('email');
      let rows;
      if (email) {
        const u = findUser(email);
        rows = db.prepare('SELECT id, ip, user_agent, created_at, last_seen FROM sessions WHERE user_id = ? ORDER BY last_seen DESC').all(u.id);
      } else {
        rows = db.prepare(`SELECT s.id, u.email, s.ip, s.user_agent, s.created_at, s.last_seen
                           FROM sessions s JOIN users u ON u.id = s.user_id ORDER BY s.last_seen DESC`).all();
      }
      console.table(rows.map((r) => ({ ...r, id: r.id.slice(0, 12) + '...' })));
      break;
    }

    case 'list-events': {
      const limit = Number(arg('limit') || 50);
      const email = arg('email');
      let rows;
      if (email) {
        const u = findUser(email);
        rows = db.prepare('SELECT event, ip, details, at FROM event_log WHERE user_id = ? ORDER BY at DESC LIMIT ?').all(u.id, limit);
      } else {
        rows = db.prepare(`SELECT e.event, u.email, e.ip, e.details, e.at FROM event_log e
                           LEFT JOIN users u ON u.id = e.user_id ORDER BY e.at DESC LIMIT ?`).all(limit);
      }
      console.table(rows);
      break;
    }

    case 'set-plan': {
      const u = findUser(arg('email'));
      const plan = arg('plan');
      if (!plan || !PLANS[plan]) throw new Error(`--plan must be one of: ${Object.keys(PLANS).join(', ')}`);
      const devices = arg('devices') ? Number(arg('devices')) : PLANS[plan].max_devices;
      const expires = arg('expires') ? new Date(arg('expires') + 'T23:59:59Z').toISOString() : null;
      db.prepare('UPDATE users SET plan=?, max_devices=?, expires_at=COALESCE(?, expires_at) WHERE id=?')
        .run(plan, devices, expires, u.id);
      console.log(`Updated ${u.email}: plan=${plan} devices=${devices} expires=${expires || '(unchanged)'}`);
      break;
    }

    case 'reset-trial': {
      const u = findUser(arg('email'));
      db.prepare(`UPDATE users SET plan='trial', trial_started_at=CURRENT_TIMESTAMP, expires_at=NULL WHERE id=?`).run(u.id);
      console.log(`Reset trial for ${u.email}`);
      break;
    }

    case 'revoke': {
      const u = findUser(arg('email'));
      db.prepare('UPDATE users SET expires_at=CURRENT_TIMESTAMP WHERE id=?').run(u.id);
      const n = db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id).changes;
      console.log(`Revoked ${u.email} (kicked ${n} active sessions)`);
      break;
    }

    case 'kick-all': {
      const u = findUser(arg('email'));
      const n = db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id).changes;
      console.log(`Kicked ${n} sessions for ${u.email}`);
      break;
    }

    case 'delete-user': {
      const u = findUser(arg('email'));
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
      db.prepare('DELETE FROM users WHERE id=?').run(u.id);
      console.log(`Deleted ${u.email}`);
      break;
    }

    case 'make-admin': {
      const u = findUser(arg('email'));
      db.prepare('UPDATE users SET is_admin = 1, email_verified = 1 WHERE id = ?').run(u.id);
      console.log(`Promoted ${u.email} to admin`);
      break;
    }

    case 'set-free': {
      const u = findUser(arg('email'));
      const days = Number(arg('days') || 30);
      const d = new Date(); d.setDate(d.getDate() + days);
      db.prepare('UPDATE users SET free_until = ? WHERE id = ?').run(d.toISOString(), u.id);
      console.log(`${u.email} now free until ${d.toISOString()}`);
      break;
    }

    case 'plans':
      console.log(JSON.stringify(PLANS, null, 2));
      break;

    case 'list-licenses': {
      const filter = arg('filter');
      const where = filter === 'revoked' ? 'WHERE revoked_at IS NOT NULL'
                  : filter === 'active'  ? 'WHERE revoked_at IS NULL'
                  : '';
      const rows = db.prepare(
        `SELECT id, customer, plan, expires_at, revoked_at, revoke_reason
         FROM issued_licenses ${where} ORDER BY issued_at DESC`
      ).all();
      console.table(rows.map((r) => ({
        ...r,
        id: r.id.slice(0, 8) + '…',
        status: r.revoked_at ? 'REVOKED' : 'active',
      })));
      break;
    }

    case 'add-license': {
      const json = process.argv[3];
      if (!json) throw new Error('Pass JSON: add-license \'{"id":"<uuid>","customer":"...","plan":"team","expires_at":"..."}\'');
      const obj = JSON.parse(json);
      if (!obj.id || !/^[0-9a-f-]{36}$/i.test(obj.id)) throw new Error('id must be a UUID');
      db.prepare(`INSERT INTO issued_licenses (id, customer, plan, expires_at, source, notes)
                  VALUES (?,?,?,?,?,?)`)
        .run(obj.id, obj.customer || null, obj.plan || null, obj.expires_at || null,
             obj.source || 'cli', obj.notes || null);
      console.log(`Registered license ${obj.id} (${obj.customer || 'no customer'})`);
      break;
    }

    case 'import-licenses': {
      const fs = require('fs');
      const path = require('path');
      const file = arg('file') || path.join(__dirname, '..', 'license-tools', 'issued-licenses.jsonl');
      if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      let added = 0, skipped = 0;
      const ins = db.prepare(`INSERT OR IGNORE INTO issued_licenses (id, customer, plan, expires_at, source)
                              VALUES (?,?,?,?,'import')`);
      for (const line of lines) {
        try {
          const o = JSON.parse(line);
          if (!o.lid) { skipped++; continue; }
          const r = ins.run(o.lid, o.customer || null, o.plan || null, o.expires || null);
          if (r.changes) added++; else skipped++;
        } catch { skipped++; }
      }
      console.log(`Imported ${added} licenses (${skipped} skipped/duplicate)`);
      break;
    }

    case 'revoke-license': {
      const id = arg('id');
      if (!id) throw new Error('--id <uuid> required');
      const reason = arg('reason') || null;
      const row = db.prepare('SELECT * FROM issued_licenses WHERE id = ?').get(id);
      if (!row) throw new Error(`Unknown license id: ${id}`);
      db.prepare('UPDATE issued_licenses SET revoked_at=CURRENT_TIMESTAMP, revoke_reason=? WHERE id=?').run(reason, id);
      db.prepare('INSERT INTO event_log (event, details) VALUES (?,?)').run(
        'license_revoked', JSON.stringify({ id, customer: row.customer, reason, by: 'cli' }));
      console.log(`Revoked ${id} (${row.customer || 'no customer'})${reason ? ': ' + reason : ''}`);
      break;
    }

    case 'unrevoke-license': {
      const id = arg('id');
      if (!id) throw new Error('--id <uuid> required');
      const row = db.prepare('SELECT * FROM issued_licenses WHERE id = ?').get(id);
      if (!row) throw new Error(`Unknown license id: ${id}`);
      db.prepare('UPDATE issued_licenses SET revoked_at=NULL, revoke_reason=NULL WHERE id=?').run(id);
      console.log(`Unrevoked ${id}`);
      break;
    }

    default:
      help();
  }
} catch (e) {
  console.error('ERR:', e.message);
  process.exit(1);
}
