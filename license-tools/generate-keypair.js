#!/usr/bin/env node
// One-time setup: generates an Ed25519 keypair.
// Run: node license-tools/generate-keypair.js
//
// - Saves private key to ./private-key.pem  (KEEP SECRET, DO NOT COMMIT)
// - Saves public key to ./public-key.pem    (this gets embedded in the app)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

const privPath = path.join(__dirname, 'private-key.pem');
const pubPath = path.join(__dirname, 'public-key.pem');

fs.writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
fs.writeFileSync(pubPath,  publicKey.export({  type: 'spki',  format: 'pem' }));

console.log(`Private key  -> ${privPath}  (KEEP SECRET — do NOT commit)`);
console.log(`Public key   -> ${pubPath}   (embed in app; safe to commit)`);
console.log(`\nNext: copy public-key.pem content into:`);
console.log(`  node-express/lib/license.js  ->  PUBLIC_KEY_PEM`);
console.log(`  dotnet8/Services/LicenseService.cs  ->  PublicKeyPem`);
