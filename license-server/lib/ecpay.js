// ECPay (綠界) payment helper — CheckMacValue, form builder, return verifier.
//
// Required env vars:
//   ECPAY_MERCHANT_ID    — 商店代號
//   ECPAY_HASH_KEY       — HashKey for CheckMacValue
//   ECPAY_HASH_IV        — HashIV
//   ECPAY_ENVIRONMENT    — 'stage' (default, sandbox) or 'production'
//   PUBLIC_BASE_URL      — used for ReturnURL / ClientBackURL
//
// Test merchant from official docs (use in stage):
//   MerchantID: 3002599
//   HashKey:    spPjZn66i0OhqJsQ
//   HashIV:     hT5OJckN45isQTTs

const crypto = require('crypto');

const ENDPOINTS = {
  stage: 'https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5',
  production: 'https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5',
};

function isEnabled() {
  return !!(process.env.ECPAY_MERCHANT_ID && process.env.ECPAY_HASH_KEY && process.env.ECPAY_HASH_IV);
}

function getEnv() {
  return process.env.ECPAY_ENVIRONMENT === 'production' ? 'production' : 'stage';
}

// .NET-style URL encoding per ECPay spec:
//   space → +, lowercase hex %xx,
//   characters NOT encoded: A-Z a-z 0-9 - _ . ! * ( ) '
function ecpayUrlEncode(s) {
  return encodeURIComponent(String(s))
    .replace(/%20/g, '+')
    .replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())
    .replace(/%21/g, '!')
    .replace(/%2a/g, '*')
    .replace(/%28/g, '(')
    .replace(/%29/g, ')')
    .replace(/%27/g, "'");
}

// Compute CheckMacValue per ECPay spec (SHA256 variant — EncryptType=1).
function checkMacValue(params, hashKey, hashIv) {
  // 1. Remove CheckMacValue itself, sort keys A-Z case-insensitive
  const keys = Object.keys(params)
    .filter((k) => k !== 'CheckMacValue')
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  // 2. Build "HashKey=...&k1=v1&...&HashIV=..."
  const middle = keys.map((k) => `${k}=${params[k] ?? ''}`).join('&');
  const raw = `HashKey=${hashKey}&${middle}&HashIV=${hashIv}`;
  // 3. URL encode, lowercase
  const encoded = ecpayUrlEncode(raw).toLowerCase();
  // 4. SHA256 → uppercase
  return crypto.createHash('sha256').update(encoded, 'utf8').digest('hex').toUpperCase();
}

// Format a JS Date as ECPay's required format "yyyy/MM/dd HH:mm:ss"
function formatTradeDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Build checkout form payload. Caller submits these fields to `formAction` URL.
function buildCheckoutPayload({ tradeNo, amount, itemName, tradeDesc, returnUrl, clientBackUrl, customField1 = '' }) {
  if (!isEnabled()) throw new Error('ECPay not configured (set ECPAY_MERCHANT_ID / HASH_KEY / HASH_IV)');
  if (!tradeNo || !amount || !itemName) throw new Error('tradeNo, amount, itemName required');
  if (tradeNo.length > 20) throw new Error('tradeNo must be ≤ 20 chars');

  const params = {
    MerchantID: process.env.ECPAY_MERCHANT_ID,
    MerchantTradeNo: tradeNo,
    MerchantTradeDate: formatTradeDate(),
    PaymentType: 'aio',
    TotalAmount: String(amount),
    TradeDesc: ecpayUrlEncode(tradeDesc || itemName).replace(/\+/g, ' '),  // TradeDesc must be url-encoded already
    ItemName: itemName,
    ReturnURL: returnUrl,
    ChoosePayment: 'ALL',
    EncryptType: '1',
    ClientBackURL: clientBackUrl || returnUrl,
    CustomField1: customField1,
  };
  params.CheckMacValue = checkMacValue(params, process.env.ECPAY_HASH_KEY, process.env.ECPAY_HASH_IV);

  return {
    formAction: ENDPOINTS[getEnv()],
    fields: params,
  };
}

// Verify the CheckMacValue in an ECPay return POST. Returns true/false.
function verifyReturn(body) {
  if (!isEnabled()) return false;
  const given = body.CheckMacValue;
  if (!given) return false;
  const expected = checkMacValue(body, process.env.ECPAY_HASH_KEY, process.env.ECPAY_HASH_IV);
  return given.toUpperCase() === expected.toUpperCase();
}

module.exports = {
  isEnabled, getEnv, ecpayUrlEncode, checkMacValue,
  formatTradeDate, buildCheckoutPayload, verifyReturn,
  ENDPOINTS,
};
