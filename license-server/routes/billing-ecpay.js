// ECPay (綠界) billing — checkout + async return.
// Mounted in server.js BEFORE express.json() since /return needs URL-encoded body.

const router = require('express').Router();
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { PLANS } = require('../plans');
const ecpay = require('../lib/ecpay');

const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 4000}`;

function logEvent(userId, event, details) {
  db.prepare('INSERT INTO event_log (user_id, ip, user_agent, event, details) VALUES (?,?,?,?,?)')
    .run(userId || null, '', 'ecpay', event, details ? JSON.stringify(details) : null);
}

// =================================================
// Status — UI uses this to show whether ECPay is on
// =================================================
router.get('/status', (req, res) => {
  res.json({
    enabled: ecpay.isEnabled(),
    environment: ecpay.getEnv(),
    amounts: {
      basic: PLANS.basic.ecpay_amount_twd ?? null,
      team: PLANS.team.ecpay_amount_twd ?? null,
      enterprise: PLANS.enterprise.ecpay_amount_twd ?? null,
    },
  });
});

// =================================================
// POST /checkout (JSON body) — { plan, userToken }
// Returns { formAction, fields } — caller submits HTML form to formAction
// =================================================
router.post('/checkout', express.json(), (req, res) => {
  if (!ecpay.isEnabled()) return res.status(503).json({ error: 'ECPay not configured' });
  const { plan, userToken } = req.body || {};
  if (!plan || !PLANS[plan]) return res.status(400).json({ error: `bad plan: ${plan}` });
  if (plan === 'trial') return res.status(400).json({ error: 'cannot purchase trial' });

  const amount = PLANS[plan].ecpay_amount_twd;
  if (!amount) return res.status(400).json({ error: `plan ${plan} has no ECPay amount configured` });

  const session = userToken && db.prepare('SELECT * FROM sessions WHERE id = ?').get(userToken);
  if (!session) return res.status(401).json({ error: 'user not logged in' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);

  // tradeNo must be ≤ 20 chars and unique. We use a short random suffix.
  const tradeNo = 'DBM' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
  const trimmedTradeNo = tradeNo.slice(0, 20);

  // Record the pending payment so /return can verify the link to user + plan
  db.prepare(`INSERT INTO event_log (user_id, ip, user_agent, event, details)
              VALUES (?, '', 'ecpay', 'checkout_started', ?)`)
    .run(user.id, JSON.stringify({ tradeNo: trimmedTradeNo, plan, amount }));

  try {
    const payload = ecpay.buildCheckoutPayload({
      tradeNo: trimmedTradeNo,
      amount,
      itemName: `DB Migrator ${plan} plan (1 year)`,
      tradeDesc: 'DB Migrator subscription',
      returnUrl: `${PUBLIC_BASE}/api/billing/ecpay/return`,
      clientBackUrl: `${PUBLIC_BASE}/admin/payment-success.html`,
      customField1: `${user.id}|${plan}`,  // server-side fallback if event lookup races
    });
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =================================================
// POST /return (URL-encoded body) — ECPay async callback
// Must respond with text "1|OK" on success
// =================================================
router.post('/return', express.urlencoded({ extended: false }), (req, res) => {
  if (!ecpay.isEnabled()) return res.status(503).end();
  const body = req.body || {};

  // Verify signature
  if (!ecpay.verifyReturn(body)) {
    console.error('[ecpay/return] signature verify failed:', body);
    return res.status(400).send('0|InvalidSignature');
  }

  // RtnCode === '1' means success
  if (body.RtnCode !== '1') {
    logEvent(null, 'payment_failed', { tradeNo: body.MerchantTradeNo, rtnCode: body.RtnCode, rtnMsg: body.RtnMsg });
    return res.send('1|OK');   // ECPay still expects 1|OK so it stops retrying
  }

  // Pull user_id + plan from CustomField1, with event_log as fallback
  let userId = null, plan = null;
  if (body.CustomField1 && body.CustomField1.includes('|')) {
    [userId, plan] = body.CustomField1.split('|');
  } else {
    const row = db.prepare(
      `SELECT user_id, details FROM event_log WHERE event='checkout_started' AND details LIKE ? ORDER BY at DESC LIMIT 1`
    ).get(`%"tradeNo":"${body.MerchantTradeNo}"%`);
    if (row) {
      userId = row.user_id;
      try { plan = JSON.parse(row.details).plan; } catch {}
    }
  }
  if (!userId || !plan || !PLANS[plan]) {
    logEvent(null, 'payment_unmapped', { tradeNo: body.MerchantTradeNo, body });
    return res.send('1|OK');
  }

  // Idempotency — skip if we've already processed this tradeNo
  const already = db.prepare(
    `SELECT 1 FROM event_log WHERE event='plan_upgraded' AND details LIKE ?`
  ).get(`%"tradeNo":"${body.MerchantTradeNo}"%`);
  if (already) return res.send('1|OK');

  // Upgrade user: extend expires_at by 1 year (or set to 1 year from now if past expired)
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.send('1|OK');

  const cur = user.expires_at ? new Date(user.expires_at) : null;
  const base = (cur && cur > new Date()) ? cur : new Date();
  base.setFullYear(base.getFullYear() + 1);

  db.prepare(`UPDATE users SET plan = ?, max_devices = ?, expires_at = ? WHERE id = ?`)
    .run(plan, PLANS[plan].max_devices, base.toISOString(), userId);

  logEvent(userId, 'plan_upgraded', { plan, via: 'ecpay', tradeNo: body.MerchantTradeNo, amount: body.TradeAmt });
  res.send('1|OK');
});

module.exports = router;
