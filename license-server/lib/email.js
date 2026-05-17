// Email sender. Uses SMTP if env vars are set; otherwise logs to console (dev mode).
//
// Required env vars (production):
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
//   PUBLIC_BASE_URL  — full URL of license server (used for verification links)

const nodemailer = require('nodemailer');

const HOST = process.env.SMTP_HOST;
const PORT = Number(process.env.SMTP_PORT || 587);
const USER = process.env.SMTP_USER;
const PASS = process.env.SMTP_PASS;
const FROM = process.env.SMTP_FROM || 'no-reply@example.com';
const BASE = process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 4000}`;

let transporter = null;
if (HOST && USER && PASS) {
  transporter = nodemailer.createTransport({
    host: HOST, port: PORT, secure: PORT === 465,
    auth: { user: USER, pass: PASS },
  });
  console.log(`[email] SMTP configured: ${USER}@${HOST}:${PORT}`);
} else {
  console.warn('[email] SMTP not configured — verification emails will print to console only');
}

async function sendVerification(email, token) {
  const link = `${BASE}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
  const subject = 'DB Migrator — 請驗證您的 email';
  const body = `您好，

請點以下連結驗證您的 email 並啟用您的試用帳號：

${link}

此連結 24 小時內有效。如果不是您本人註冊，請忽略本信。

— DB Migrator
`;

  if (!transporter) {
    console.log(`\n========== EMAIL (DEV) ==========`);
    console.log(`To: ${email}`);
    console.log(`Subject: ${subject}`);
    console.log(body);
    console.log(`================================\n`);
    return { dev: true, link };
  }
  await transporter.sendMail({ from: FROM, to: email, subject, text: body });
  return { sent: true };
}

module.exports = { sendVerification, baseUrl: BASE };
