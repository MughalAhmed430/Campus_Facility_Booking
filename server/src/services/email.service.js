// Sends the application's emails (so far only the verification email).
//
// - SMTP_USER and SMTP_APP_PASSWORD set in server/.env: sent through Gmail (Nodemailer).
// - Not set: nothing is sent; the message and its link are printed to the server console,
//   so registration and verification still work in local development.
// - Automated tests: setEmailSenderForTests() swaps in a fake that only records messages,
//   the same way setDatabaseForTests() swaps in PGlite. Tests never contact Gmail
//   (config also refuses SMTP when NODE_ENV is "test").
//
// The app password is only handed to Nodemailer. It is never logged, and errors are
// logged by code and message only.
import nodemailer from 'nodemailer';
import config from '../config/index.js';

const APP_NAME = 'Campus Facility Booking';
const VERIFICATION_LINK_HOURS = Math.round(config.auth.emailVerificationTtlMs / (60 * 60 * 1000));

/*
 * A sender is { description, send(message) }, where message is
 * { to, subject, text, html, link } and link is the main link in the email (printed
 * by the console sender, recorded by the test fake, not a separate part of the email).
 */

function createGmailSender({ user, appPassword }) {
  const transport = nodemailer.createTransport({
    service: 'gmail', // smtp.gmail.com, port 465, TLS from the start
    auth: { user, pass: appPassword },
    // Give up instead of hanging if Gmail cannot be reached.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return {
    description: `Gmail SMTP as ${user}`,
    async send({ to, subject, text, html }) {
      await transport.sendMail({ from: { name: APP_NAME, address: user }, to, subject, text, html });
    },
  };
}

function createConsoleSender() {
  return {
    description: 'not configured: emails are printed to this console (set SMTP_USER and SMTP_APP_PASSWORD to send them)',
    async send({ to, subject, link }) {
      console.warn('[email] NOT SENT: SMTP_USER and SMTP_APP_PASSWORD are not set in server/.env. The email is shown here instead.');
      console.log(`[email]   To:      ${to}`);
      console.log(`[email]   Subject: ${subject}`);
      if (link) console.log(`[email]   Link:    ${link}`);
    },
  };
}

const defaultSender = config.email.smtpConfigured
  ? createGmailSender({ user: config.email.smtpUser, appPassword: config.email.smtpAppPassword })
  : createConsoleSender();
let sender = defaultSender;

/**
 * Tests only (server/tests/helpers): send through `replacement` ({ send(message) })
 * instead of Gmail or the console. Pass null to go back to the default.
 */
export function setEmailSenderForTests(replacement) {
  sender = replacement ?? defaultSender;
}

/** One line for the startup log, e.g. "Gmail SMTP as yourname@gmail.com". */
export function describeEmailSender() {
  return sender.description ?? 'test sender';
}

/** The page that completes verification, e.g. http://localhost:3000/pages/verify-email.html?token=… */
export function verificationLink(token) {
  return `${config.clientBaseUrl}/pages/verify-email.html?token=${encodeURIComponent(token)}`;
}

/** Sends the "confirm your email address" message. Rejects if sending fails. */
export async function sendVerificationEmail({ to, fullName, token }) {
  const link = verificationLink(token);
  const subject = `Confirm your email address for ${APP_NAME}`;
  const text = [
    `Hello ${fullName},`,
    '',
    `Please confirm your email address to finish creating your ${APP_NAME} account:`,
    '',
    link,
    '',
    `The link works once and expires in ${VERIFICATION_LINK_HOURS} hours. If it has expired, you can ask for a new one on the sign-in page.`,
    '',
    'If you did not create this account, you can ignore this email.',
  ].join('\n');
  // Email clients ignore stylesheets, so styles are inline; the colours are the design
  // tokens gray-50, gray-200, gray-900, gray-600 and navy-700.
  const html = `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:24px;background:#f6f7f9;font-family:Segoe UI,Arial,sans-serif;color:#181c23;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #dcdfe6;border-radius:8px;padding:32px;">
    <p style="margin:0 0 16px;font-size:16px;">Hello ${escapeHtml(fullName)},</p>
    <p style="margin:0 0 24px;font-size:16px;line-height:1.5;">Please confirm your email address to finish creating your ${APP_NAME} account.</p>
    <p style="margin:0 0 24px;">
      <a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 20px;background:#1f3f7f;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;">Confirm my email address</a>
    </p>
    <p style="margin:0 0 8px;font-size:14px;line-height:1.5;color:#535a68;">The link works once and expires in ${VERIFICATION_LINK_HOURS} hours. If the button does not work, copy this address into your browser:</p>
    <p style="margin:0 0 24px;font-size:14px;word-break:break-all;"><a href="${escapeHtml(link)}" style="color:#1f3f7f;">${escapeHtml(link)}</a></p>
    <p style="margin:0;font-size:14px;color:#535a68;">If you did not create this account, you can ignore this email.</p>
  </div>
</body>
</html>`;
  await sender.send({ to, subject, text, html, link });
}

/**
 * Logs a failed send without anything secret: Nodemailer errors can carry the SMTP
 * conversation, so only the error code, the server's reply code and the message are logged.
 */
export function logEmailFailure(error, to) {
  const code = [error.code, error.responseCode].filter(Boolean).join(' ');
  console.error(`[email] Could not send email to ${to}${code ? ` (${code})` : ''}: ${error.message}`);
}

/** The user's name goes into the HTML email, so it must not be able to add markup. */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}
