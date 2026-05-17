# License Tools (PRIVATE)

This folder contains tools you run privately as the project owner.
**Don't ship this folder to users; it's only for you.**

## Setup (one-time)

```powershell
cd license-tools
node generate-keypair.js
```

Produces:
- `private-key.pem` — **KEEP SECRET**, never commit (gitignored)
- `public-key.pem`  — embed in app (see below)

## Embed the public key in the app

Open `public-key.pem`, copy its content (the entire `-----BEGIN PUBLIC KEY-----` ... `-----END PUBLIC KEY-----` block), and paste it as a string into:

- `node-express/lib/license.js` → `PUBLIC_KEY_PEM`
- `dotnet8/Services/LicenseService.cs` → `PublicKeyPem`

Both apps have a placeholder you replace.

## Issue a license (when a customer pays)

```powershell
node issue-license.js --customer "Acme Inc" --plan team --expires 2027-05-15 --users 5
```

Produces `license.key` — send this to the customer.

The customer drops it next to their `node-express/` or `dotnet8/` folder (or uploads via the UI), and the app accepts it.

## Plans / pricing

This tool doesn't enforce specific plan limits beyond expiry. To enforce:
- `users` count is in the payload but not currently checked
- Add server-side enforcement in `lib/license.js` / `LicenseService.cs` if needed

## License file format

A license is `<base64url-payload>.<base64url-signature>`, similar to JWT.

Payload example:
```json
{
  "customer": "Acme Inc",
  "plan": "team",
  "users": 5,
  "issued": "2026-05-15T00:00:00.000Z",
  "expires": "2027-05-15T23:59:59.000Z",
  "v": 1
}
```

Signature is Ed25519 over the base64url payload string, also base64url-encoded.
