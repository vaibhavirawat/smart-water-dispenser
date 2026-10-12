// Sends email via SMTP when SMTP_HOST is set; otherwise prints the message to the server log
// (handy for local development) and keeps the last few in `outbox` (used by tests).
const outbox = [];
let transporter;

async function sendMail({ to, subject, text }) {
  const e = process.env;
  if (e.SMTP_HOST) {
    transporter ||= require('nodemailer').createTransport({
      host: e.SMTP_HOST, port: +(e.SMTP_PORT || 587), secure: +(e.SMTP_PORT || 587) === 465,
      auth: e.SMTP_USER ? { user: e.SMTP_USER, pass: e.SMTP_PASS } : undefined,
    });
    await transporter.sendMail({ from: e.SMTP_FROM || e.SMTP_USER, to, subject, text });
    return;
  }
  outbox.push({ to, subject, text });
  if (outbox.length > 50) outbox.shift();
  if (e.NODE_ENV !== 'test') console.log(`\n[email not configured - would send to ${to}]\nSubject: ${subject}\n${text}\n`);
}
module.exports = { sendMail, outbox };
