// Integration tests: email verification on sign-up.
// Emails go to the test outbox (helpers/test-server.js), never to Gmail.
//
// The rate limits apply here too (10 registrations, 10 resend requests and 10 failed
// logins per IP). Each test file runs in its own process with fresh limits, so keep the
// number of such requests in this file below 10 each (currently 9 registrations, 7 resend
// requests, 3 failed logins over HTTP).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { startTestServer, tokenFromEmail, TEST_CLIENT_BASE_URL } from './helpers/test-server.js';

const PASSWORD = 'Verify-me-2026';
const STUDENT = { email: 'minjun.kim@kdu.example', password: 'Student@2026' };
const ADMIN = { email: 'admin@kdu.example', password: 'Admin@2026' };

let server;
let authService;
let accountCount = 0;

before(async () => {
  server = await startTestServer();
  // The same module instance the app uses (imported after startTestServer set up PGlite).
  authService = await import('../src/services/auth.service.js');
});

after(() => server?.close());

/** Registers a new student through the API; returns { email, token } from the emailed link. */
async function registerNewStudent({ fullName = 'Test Student' } = {}) {
  accountCount += 1;
  const email = `verify.${accountCount}.${Date.now()}@kdu.example`;
  const response = await server.request('/auth/register', {
    method: 'POST',
    body: { fullName, email, password: PASSWORD },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const message = server.lastEmailTo(email);
  assert.ok(message, `no verification email was queued for ${email}`);
  return { email, token: tokenFromEmail(message), response, message };
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const login = (email, password) => server.request('/auth/login', { method: 'POST', body: { email, password } });
const verify = (token) => server.request(`/auth/verify-email?token=${encodeURIComponent(token)}`);
const resend = (email) => server.request('/auth/resend-verification', { method: 'POST', body: { email } });

async function userRow(email) {
  const { rows } = await server.db.query('SELECT id, email_verified_at, is_active FROM users WHERE email = $1', [email]);
  return rows[0];
}

describe('registration', () => {
  test('creates an unverified account and queues a verification email', async () => {
    const before = server.outbox.length;
    // The name tries to add markup to the HTML email; it must arrive escaped.
    const { email, token, response, message } = await registerNewStudent({ fullName: 'Kim <img src=x onerror=alert(1)>' });

    // Unchanged from the outside: 201 { user } with the public fields only.
    assert.deepEqual(Object.keys(response.body.data.user).sort(), ['email', 'fullName', 'id', 'role', 'studentNumber']);
    assert.ok(!JSON.stringify(response.body).includes(token), 'the token is only in the email');

    assert.equal((await userRow(email)).email_verified_at, null);

    assert.equal(server.outbox.length, before + 1);
    assert.equal(message.to, email);
    assert.match(message.subject, /confirm your email/i);
    assert.ok(message.link.startsWith(`${TEST_CLIENT_BASE_URL}/pages/verify-email.html?token=`), message.link);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(message.text.includes(message.link) && message.html.includes(message.link));
    assert.ok(!message.html.includes('<img'), 'the name is escaped in the HTML');
    assert.ok(message.html.includes('Kim &lt;img src=x onerror=alert(1)&gt;'));

    // Only the hash is stored; the token is single-use and lasts 24 hours.
    const { rows: [stored] } = await server.db.query(
      `SELECT t.token_hash, t.used_at, extract(epoch FROM t.expires_at - now()) AS seconds_left
       FROM email_verification_tokens t JOIN users u ON u.id = t.user_id WHERE u.email = $1`,
      [email],
    );
    assert.equal(stored.token_hash, sha256(token));
    assert.equal(stored.used_at, null);
    assert.ok(Math.abs(Number(stored.seconds_left) - 24 * 3600) < 120, `expires in ${stored.seconds_left}s`);
  });

});

describe('sign-in before verification', () => {
  let account;
  before(async () => {
    account = await registerNewStudent();
  });

  test('the right password on an unverified account is 403 EMAIL_NOT_VERIFIED, without a session', async () => {
    const response = await login(account.email, PASSWORD);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'EMAIL_NOT_VERIFIED');
    assert.match(response.body.error.message, /confirm your email/i);
    assert.equal(response.headers.getSetCookie().some((cookie) => cookie.startsWith('sid=')), false);
  });

  test('a wrong password or an unknown email still gets the same generic 401', async () => {
    const wrongPassword = await login(account.email, 'not-the-password');
    const unknownEmail = await login('nobody.here@kdu.example', PASSWORD);
    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownEmail.status, 401);
    assert.deepEqual(wrongPassword.body, unknownEmail.body);
    assert.equal(wrongPassword.body.error.code, 'INVALID_CREDENTIALS');
  });

  test('every sign-in failure takes about as long (no timing hint about accounts)', async () => {
    // Calls the service directly so the login rate limit is not involved. The slowest
    // part of every answer must be the same bcrypt comparison (about 200 ms); an answer
    // that skipped it would take a few milliseconds.
    async function fastest(email, password) {
      let best = Infinity;
      for (let i = 0; i < 3; i += 1) {
        const started = performance.now();
        await authService.login({ email, password }).catch(() => {});
        best = Math.min(best, performance.now() - started);
      }
      return best;
    }
    const wrongPasswordVerified = await fastest(STUDENT.email, 'not-the-password');
    const timings = {
      unknownEmail: await fastest('nobody.here@kdu.example', PASSWORD),
      wrongPasswordUnverified: await fastest(account.email, 'not-the-password'),
      rightPasswordUnverified: await fastest(account.email, PASSWORD),
    };
    for (const [name, ms] of Object.entries(timings)) {
      const ratio = ms / wrongPasswordVerified;
      assert.ok(ratio > 0.5 && ratio < 2,
        `${name} took ${ms.toFixed(0)} ms vs ${wrongPasswordVerified.toFixed(0)} ms for a wrong password`);
    }
  });
});

describe('GET /api/auth/verify-email', () => {
  test('a valid token verifies the account once; the same link then reports "already used"', async () => {
    const { email, token } = await registerNewStudent();

    const first = await verify(token);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body, { success: true, data: { verified: true, email } });
    assert.equal(first.headers.get('cache-control'), 'no-store');
    assert.ok((await userRow(email)).email_verified_at instanceof Date);

    const signIn = await login(email, PASSWORD);
    assert.equal(signIn.status, 200, 'a verified account can sign in');

    const second = await verify(token);
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'VERIFICATION_TOKEN_USED');
  });

  test('an expired token is 410 and leaves the account unverified', async () => {
    const { email, token } = await registerNewStudent();
    await server.db.query(
      `UPDATE email_verification_tokens
       SET created_at = now() - interval '25 hours', expires_at = now() - interval '1 hour'
       WHERE token_hash = $1`,
      [sha256(token)],
    );
    const response = await verify(token);
    assert.equal(response.status, 410);
    assert.equal(response.body.error.code, 'VERIFICATION_TOKEN_EXPIRED');
    assert.equal((await userRow(email)).email_verified_at, null);
  });

  test('a missing, malformed or unknown token is 400 VERIFICATION_TOKEN_INVALID', async () => {
    const unknown = crypto.randomBytes(32).toString('base64url'); // well-formed, never issued
    for (const query of ['', '?token=', '?token=abc', `?token=${unknown}`, `?token=${unknown}&token=${unknown}`]) {
      const response = await server.request(`/auth/verify-email${query}`);
      assert.equal(response.status, 400, query);
      assert.equal(response.body.error.code, 'VERIFICATION_TOKEN_INVALID', query);
    }
  });

  test('two clicks at the same moment: exactly one succeeds', async () => {
    // PGlite runs one query at a time; on PostgreSQL the row lock taken by the UPDATE
    // gives the same result for truly simultaneous requests.
    const { token } = await registerNewStudent();
    const statuses = (await Promise.all([verify(token), verify(token)])).map((response) => response.status).sort();
    assert.deepEqual(statuses, [200, 409]);
  });
});

describe('POST /api/auth/resend-verification', () => {
  test('answers identically for an unverified, a missing, a verified and a deactivated account', async () => {
    const unverified = await registerNewStudent();
    const deactivated = await registerNewStudent();
    await server.db.query('UPDATE users SET is_active = false WHERE email = $1', [deactivated.email]);
    const sentBefore = server.outbox.length;

    const responses = {
      unverified: await resend(unverified.email),
      missing: await resend('no.such.account@kdu.example'),
      verified: await resend(STUDENT.email),
      deactivated: await resend(deactivated.email),
    };
    for (const [name, response] of Object.entries(responses)) {
      assert.equal(response.status, 200, name);
      assert.deepEqual(response.body, responses.unverified.body, `${name} answers differently`);
    }
    assert.match(responses.unverified.body.data.message, /If an account with this email address/);

    // Only the account that is waiting for verification gets an email.
    assert.deepEqual(server.outbox.slice(sentBefore).map((message) => message.to), [unverified.email]);
  });

  test('the new link works and replaces the earlier one', async () => {
    const { email, token: firstToken } = await registerNewStudent();
    await resend(email);
    const secondToken = tokenFromEmail(server.lastEmailTo(email));
    assert.notEqual(secondToken, firstToken);

    assert.equal((await verify(firstToken)).body.error.code, 'VERIFICATION_TOKEN_INVALID');
    assert.equal((await verify(secondToken)).status, 200);
  });

  test('does not wait for the email to be sent (no timing difference)', async () => {
    const { email } = await registerNewStudent();
    server.setEmailDelay(1500); // a slow mail server
    try {
      const started = performance.now();
      const response = await resend(email);
      const elapsed = performance.now() - started;
      assert.equal(response.status, 200);
      assert.ok(elapsed < 1000, `the response waited for the email (${elapsed.toFixed(0)} ms)`);
    } finally {
      server.setEmailDelay(0);
    }
  });

  test('an invalid email address is a 400 validation error', async () => {
    const response = await resend('not-an-email');
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    assert.ok(response.body.error.details.email);
  });
});

describe('demo accounts', () => {
  for (const account of [STUDENT, ADMIN]) {
    test(`${account.email} is seeded as verified and signs in straight away`, async () => {
      assert.ok((await userRow(account.email)).email_verified_at instanceof Date);
      const response = await login(account.email, account.password);
      assert.equal(response.status, 200, JSON.stringify(response.body));
    });
  }
});
