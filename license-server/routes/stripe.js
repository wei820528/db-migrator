// Stripe checkout + webhook.
//
// Required env:
//   STRIPE_SECRET_KEY=sk_xxx
//   STRIPE_WEBHOOK_SECRET=whsec_xxx
//   STRIPE_PRICE_BASIC=price_xxx (and TEAM, ENTERPRISE)
//
// Mounted in server.js BEFORE express.json() (webhook needs raw body).

const router = require('express').Router();
const express = require('express');
const db = require('../db');
const { PLANS, getPlan } = require('../plans');

const KEY = process.env.STRIPE_SECRET_KEY;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 4000}`;

let stripe = null;
if (KEY) {
  try { stripe = require('stripe')(KEY); console.log('[stripe] enabled'); }
  catch (e) { console.warn('[stripe] init failed:', e.message); }
} else {
  console.warn('[stripe] STRIPE_SECRET_KEY not set — billing endpoints will return 503');
}

function logEvent(userId, event, details) {
  db.prepare('INSERT INTO event_log (user_id, ip, user_agent, event, details) VALUES (?,?,?,?,?)')
    .run(userId || null, '', 'stripe', event, details ? JSON.stringify(details) : null);
}

// ============================================================
// Create checkout session
//   body: { plan, userToken }   userToken = current login token (so we know who)
//   → { checkoutUrl }
// ============================================================
router.post('/checkout', express.json(), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
  const { plan, userToken } = req.body || {};
  if (!plan || !PLANS[plan]) return res.status(400).json({ error: `bad plan: ${plan}` });
  if (plan === 'trial') return res.status(400).json({ error: 'cannot purchase trial' });

  const priceId = PLANS[plan].stripe_price;
  if (!priceId) return res.status(400).json({ error: `plan ${plan} has no Stripe price ID configured` });

  // Find user by their session token
  const session = userToken && db.prepare('SELECT * FROM sessions WHERE id = ?').get(userToken);
  if (!session) return res.status(401).json({ error: 'user not logged in' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);

  try {
    const checkout = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      customer: user.stripe_customer_id || undefined,
      customer_email: user.stripe_customer_id ? undefined : user.email,
      client_reference_id: user.id,    // so webhook knows which user
      metadata: { user_id: user.id, plan },
      success_url: `${PUBLIC_BASE}/admin/payment-success.html`,
      cancel_url:  `${PUBLIC_BASE}/admin/payment-cancel.html`,
    });
    logEvent(user.id, 'checkout_started', { plan, checkoutId: checkout.id });
    res.json({ checkoutUrl: checkout.url });
  } catch (e) {
    console.error('[stripe/checkout] failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// Webhook — Stripe POSTs lifecycle events here
// Must use raw body for signature verification
// ============================================================
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(503).end();
  if (!WEBHOOK_SECRET) {
    console.warn('[stripe/webhook] STRIPE_WEBHOOK_SECRET not set — refusing');
    return res.status(503).end();
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], WEBHOOK_SECRET);
  } catch (e) {
    console.error('[stripe/webhook] signature verify failed:', e.message);
    return res.status(400).send(`Webhook signature error: ${e.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const sess = event.data.object;
        const userId = sess.client_reference_id || sess.metadata?.user_id;
        const plan = sess.metadata?.plan;
        if (userId && plan && PLANS[plan]) {
          const customerId = sess.customer;
          const expires = new Date();
          expires.setFullYear(expires.getFullYear() + 1);  // 1 year subscription
          db.prepare(`UPDATE users SET plan = ?, max_devices = ?, expires_at = ?, stripe_customer_id = ?
                      WHERE id = ?`)
            .run(plan, PLANS[plan].max_devices, expires.toISOString(), customerId, userId);
          logEvent(userId, 'plan_upgraded', { plan, via: 'stripe', sessionId: sess.id });
        }
        break;
      }
      case 'invoice.paid': {
        // Subscription renewed — extend expires_at by 1 year
        const inv = event.data.object;
        const customerId = inv.customer;
        const user = db.prepare('SELECT * FROM users WHERE stripe_customer_id = ?').get(customerId);
        if (user) {
          const cur = user.expires_at ? new Date(user.expires_at) : new Date();
          const base = cur > new Date() ? cur : new Date();
          base.setFullYear(base.getFullYear() + 1);
          db.prepare('UPDATE users SET expires_at = ? WHERE id = ?').run(base.toISOString(), user.id);
          logEvent(user.id, 'subscription_renewed', { invoiceId: inv.id });
        }
        break;
      }
      case 'customer.subscription.deleted': {
        // Cancellation — let it run until expires_at, then it'll naturally fail checkUserStatus
        const sub = event.data.object;
        const user = db.prepare('SELECT * FROM users WHERE stripe_customer_id = ?').get(sub.customer);
        if (user) logEvent(user.id, 'subscription_canceled', { subscriptionId: sub.id });
        break;
      }
      default:
        // Ignore other events
        break;
    }
    res.json({ received: true });
  } catch (e) {
    console.error('[stripe/webhook] handler failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// Status endpoint (for admin UI to check if Stripe is configured)
router.get('/status', (req, res) => {
  res.json({
    enabled: !!stripe,
    webhookConfigured: !!WEBHOOK_SECRET,
    prices: {
      basic: PLANS.basic.stripe_price || null,
      team: PLANS.team.stripe_price || null,
      enterprise: PLANS.enterprise.stripe_price || null,
    },
  });
});

module.exports = router;
