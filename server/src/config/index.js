import path from 'node:path';
import dotenv from 'dotenv';

// Settings and secrets live in server/.env (never committed; see server/.env.example).
// Variables already set in the shell take precedence over the file.
const envFile = path.resolve(import.meta.dirname, '../../.env');
dotenv.config({ path: envFile, quiet: true });

const errors = [];

const nodeEnv = process.env.NODE_ENV || 'development';

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  errors.push('PORT must be a whole number between 1 and 65535.');
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  errors.push('DATABASE_URL is required.');
} else if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
  errors.push('DATABASE_URL must start with postgres:// or postgresql://');
}

// Browsers send Origin without a trailing slash, so normalise each entry to its origin.
// Only http(s) origins are accepted: "localhost:5500" would otherwise parse as a URL
// with the scheme "localhost:" and the opaque origin "null".
const corsOrigins = [];
for (const entry of (process.env.CORS_ORIGINS || '').split(',')) {
  const value = entry.trim();
  if (!value) continue;
  let url;
  try {
    url = new URL(value);
  } catch {
    url = null;
  }
  if (url && (url.protocol === 'http:' || url.protocol === 'https:')) {
    corsOrigins.push(url.origin);
  } else {
    errors.push(`CORS_ORIGINS entry "${value}" must be a full origin such as http://localhost:5500`);
  }
}

// Where the frontend lives, for links in emails (verification). Defaults to this server,
// which serves the pages itself. A trailing slash is removed.
let clientBaseUrl = `http://localhost:${port}`;
if (process.env.CLIENT_BASE_URL) {
  let url;
  try {
    url = new URL(process.env.CLIENT_BASE_URL.trim());
  } catch {
    url = null;
  }
  if (url && (url.protocol === 'http:' || url.protocol === 'https:') && !url.search && !url.hash) {
    clientBaseUrl = url.href.replace(/\/+$/, '');
  } else {
    errors.push('CLIENT_BASE_URL must be an http(s) address such as http://localhost:3000, without ?query or #hash.');
  }
}

// Gmail SMTP for verification emails. Both values or neither: without them, emails are
// printed to the console instead (see services/email.service.js). Google shows app
// passwords in groups of four ("abcd efgh ijkl mnop"); the spaces are not part of it.
const smtpUser = (process.env.SMTP_USER || '').trim();
const smtpAppPassword = (process.env.SMTP_APP_PASSWORD || '').replace(/\s+/g, '');
const emailWarnings = [];
if (Boolean(smtpUser) !== Boolean(smtpAppPassword)) {
  emailWarnings.push(`${smtpUser ? 'SMTP_APP_PASSWORD' : 'SMTP_USER'} is empty: set both SMTP_USER and SMTP_APP_PASSWORD to send email.`);
}

if (errors.length > 0) {
  console.error(`Invalid configuration (checked environment and ${envFile}):`);
  for (const message of errors) console.error(`  - ${message}`);
  process.exit(1);
}

const isProduction = nodeEnv === 'production';

const email = {
  // Real sending needs both values, and never happens in the automated tests.
  smtpConfigured: Boolean(smtpUser && smtpAppPassword) && nodeEnv !== 'test',
  smtpUser,
  warnings: Object.freeze(emailWarnings),
};
// Not enumerable: console.log(config) or JSON.stringify(config) never shows the password.
Object.defineProperty(email, 'smtpAppPassword', { value: smtpAppPassword, enumerable: false });

const config = Object.freeze({
  nodeEnv,
  isProduction,
  port,
  databaseUrl,
  corsOrigins: Object.freeze(corsOrigins),
  clientBaseUrl,
  email: Object.freeze(email),
  auth: Object.freeze({
    // About 200 ms per hash with bcryptjs. database/seed.sql uses the same cost so that
    // a wrong password takes as long as an unknown email (no timing hint about accounts).
    bcryptRounds: 12,
    sessionCookieName: 'sid',
    sessionTtlMs: 8 * 60 * 60 * 1000, // 8 hours, fixed from login (not extended on activity)
    emailVerificationTtlMs: 24 * 60 * 60 * 1000, // verification links work for 24 hours, once
    // Secure cookies are only sent over https; local development uses plain http.
    secureCookies: isProduction,
  }),
});

export default config;
