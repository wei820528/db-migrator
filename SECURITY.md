# Security Policy

## Reporting a vulnerability

**Do not open a public GitHub Issue for security issues.**

Email: **<your-security-email@example.com>**

> ⚠ Placeholder — replace with your real security contact.

Please include:
- Description of the vulnerability
- Steps to reproduce
- Impact assessment (what an attacker could do)
- Affected version(s)
- Any suggested fix (optional)

## Response timeline

- **Acknowledgement**: within 3 business days
- **Initial assessment**: within 7 business days
- **Fix or workaround**: depends on severity (see below)

| Severity | Target resolution |
|---|---|
| **Critical** (RCE, auth bypass, data exfiltration) | 7 days |
| **High** (privilege escalation, sensitive data leak) | 14 days |
| **Medium** (DoS, info disclosure) | 30 days |
| **Low** (best-practice issue) | next minor release |

## Disclosure

We follow **coordinated disclosure**:
1. You report privately
2. We confirm + fix
3. You and we agree on a public disclosure date (typically 30–90 days after fix)
4. We credit you in the release notes (unless you prefer anonymity)

## Known security considerations

This tool **directly executes database queries with credentials supplied by
the user**. Anyone who can reach the web app can connect to any database they
have credentials for, and dump / restore arbitrary data.

**Do not deploy this on a public network without:**
- Authentication (currently NOT built in — see Roadmap)
- HTTPS
- Rate limiting
- Audit logging
- Allow-listed destination hosts

Self-hosted on `localhost` or behind a VPN is the intended deployment model
for the current version.

## Supported versions

Currently in pre-1.0, only the latest commit on `main` is supported.
Once we hit 1.0, this policy will be updated with a version-support matrix.
