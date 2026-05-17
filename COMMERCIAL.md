# Commercial License

This software is licensed under [PolyForm Free Trial 1.0.0](LICENSE) — free
for **32 days of evaluation**, after which you must obtain a commercial
license to continue using it.

## When you need a commercial license

You need a paid license if **any** of these is true:

- You have used the software for more than 32 days from first use
- You are using the software in production / live operations
- You are using the software for commercial purposes (revenue-generating, internal business operations, or for paying clients)
- You are bundling or distributing the software as part of another product

The trial allows evaluation only. After 32 days, continued use without a
commercial license is a violation of the LICENSE terms.

## Pricing

> ⚠ Placeholder — fill in your actual terms before publishing.

| Plan | Price | Use case |
|---|---|---|
| **Single User** | TBD / year | One developer, one workstation |
| **Team (≤ 5)** | TBD / year | Small team |
| **Organization** | TBD / year | Unlimited users in one legal entity |
| **OEM / Embedding** | Contact us | Bundle with your own product |

All plans include:
- 12 months of updates
- Email support
- Bug-fix turnaround

## How license enforcement works

Both versions ship with a built-in license check:

| Status | Behavior |
|---|---|
| **Trial** (no `license.key`, within 32 days of first run) | Full access; banner shows days remaining |
| **Licensed** (valid signed `license.key` not expired) | Full access; banner shows expiry |
| **Expired** (trial ended OR license expired) | All `/api/*` calls return `402 Payment Required`. UI loads but blocked from using DBs |

The trial timestamp is stored in `.trial` next to the executable. The `license.key`
file goes in the same folder, or can be uploaded via the in-app license dialog
(🔑 button in header).

For the project owner: see `license-tools/README.md` for how to issue licenses.

## How to purchase

> ⚠ Placeholder — replace with your real contact / store URL.

Email: **<your-email@example.com>**

Or visit: **<https://your-website.example.com/license>**

Please include:
1. Plan you want
2. Number of users / team size
3. Company name + billing address (for invoice)
4. Intended use case (helps us help you)

## Refund policy

> ⚠ Placeholder

30-day refund if the software does not meet your stated use case.

## Custom terms

For volume discounts, perpetual licenses, source-code escrow, or compliance
requirements (SOC2, HIPAA, etc.), please contact us.

## FAQ

**Q: Can I read the source on GitHub without paying?**
A: Yes. Source is published for transparency. Reading / studying / academic
analysis is fine. **Running** it past the 32-day trial is what requires a
license.

**Q: Can I contribute pull requests?**
A: Yes — see [CONTRIBUTING.md](CONTRIBUTING.md). Note that contributions
become part of the licensed product.

**Q: Can I fork and modify privately?**
A: For evaluation, yes (within 32 days). For ongoing use, you still need a
commercial license — the LICENSE applies regardless of source modifications.

**Q: What if I deploy it for an open-source / non-profit project?**
A: Contact us — we may grant free or discounted licenses for qualifying
non-profits.
