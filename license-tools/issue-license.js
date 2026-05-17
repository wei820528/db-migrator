#!/usr/bin/env node
// Issue a license key. Run privately when a customer pays.
//
// Usage:
//   node license-tools/issue-license.js \
//     --customer "Acme Inc" \
//     --plan team \
//     --expires 2027-05-15 \
//     [--users 5] \
//     [--out license.key] \
//     [--rurl https://license.example.com/api/revocation/list]
//
// Each issued license gets a UUID (`lid`) embedded in the signed payload.
// Save the printed JSON line into license-server (Admin UI > Licenses, or
// `node admin-cli.js add-license '<json>'`) so you can revoke it later.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
}

const customer = arg('customer');
const plan     = arg('plan', 'single');
const expires  = arg('expires');
const users    = Number(arg('users', 1));
const out      = arg('out', 'license.key');
const rurl     = arg('rurl', process.env.REVOCATION_URL || '');

if (!customer || !expires) {
  console.error('Required: --customer "..." --expires YYYY-MM-DD');
  process.exit(1);
}

const privPath = path.join(__dirname, 'private-key.pem');
if (!fs.existsSync(privPath)) {
  console.error(`Private key not found at ${privPath}. Run generate-keypair.js first.`);
  process.exit(1);
}

const lid = crypto.randomUUID();
const payload = {
  lid,                                                  // unique id for remote revocation
  customer,
  plan,
  users,
  issued: new Date().toISOString(),
  expires: new Date(expires + 'T23:59:59Z').toISOString(),
  v: 2,                                                 // bumped: now includes lid
};
if (rurl) payload.rurl = rurl;                          // optional revocation list URL

const payloadJson = JSON.stringify(payload);
const payloadB64 = Buffer.from(payloadJson, 'utf8').toString('base64url');

const privateKey = crypto.createPrivateKey(fs.readFileSync(privPath));
const sig = crypto.sign(null, Buffer.from(payloadB64, 'utf8'), privateKey);
const sigB64 = sig.toString('base64url');

const license = `${payloadB64}.${sigB64}`;
fs.writeFileSync(out, license);

// Also append to a local log so you have a record of every key you've issued
const logPath = path.join(__dirname, 'issued-licenses.jsonl');
const logLine = JSON.stringify({ ...payload, file: path.resolve(out) }) + '\n';
try { fs.appendFileSync(logPath, logLine); } catch { /* non-fatal */ }

console.log('Issued license:');
console.log(JSON.stringify(payload, null, 2));
console.log(`\nWritten to: ${out}`);
console.log(`Logged to:  ${logPath}`);
console.log(`\nTo enable remote revocation, register this license in license-server:`);
console.log(`  cd ../license-server && node admin-cli.js add-license '${JSON.stringify({ id: lid, customer, plan, expires_at: payload.expires })}'`);
console.log(`\nSend the .key file (or the string content) to the customer.`);
