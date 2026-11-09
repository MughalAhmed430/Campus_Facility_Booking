// POST /api/auth/register through the real app: the email-domain check takes part in the
// normal single 400 response, and a new account can sign in straight away. DNS is the
// test server's fake (helpers/test-server.js): examoke.com does not exist, every other
// domain has an MX record unless a test says otherwise.
// Registrations are rate-limited to 10 per hour per IP address; this file makes 6.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startTestServer } from './helpers/test-server.js';

const DISPOSABLE = 'Please use a permanent email address. Temporary or disposable email services are not accepted.';
const UNDELIVERABLE = 'This email domain does not appear to exist or accept mail. Check it for typos.';

let server;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server?.close();
});

const newStudent = (email, extra = {}) => ({ fullName: 'New Student', email, password: 'Password123', ...extra });
const register = (body) => server.request('/auth/register', { method: 'POST', body });

async function userCount(email) {
  const { rows } = await server.db.query('SELECT count(*) AS n FROM users WHERE email = $1', [email]);
  return Number(rows[0].n);
}

describe('registration', () => {
  test('a new student can sign in straight after registering: there is no confirmation step', async () => {
    const created = await register(newStudent('new.student@kdu.example'));
    assert.equal(created.status, 201);
    assert.equal(created.body.data.user.email, 'new.student@kdu.example');
    assert.equal(created.body.data.user.role, 'student');

    const cookie = await server.login('new.student@kdu.example', 'Password123'); // throws unless 200
    const me = await server.request('/auth/me', { cookie });
    assert.equal(me.status, 200);
    assert.equal(me.body.data.user.email, 'new.student@kdu.example');
  });

  test('regression: dann@examoke.com is refused under the email field, in the same 400 as the other field errors', async () => {
    const response = await register(newStudent('dann@examoke.com', { password: 'short' }));
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    assert.deepEqual(response.body.error.details, {
      email: UNDELIVERABLE,
      password: 'Password must be at least 8 characters.',
    });
    assert.equal(await userCount('dann@examoke.com'), 0);
  });

  test('a disposable address is refused, and DNS is not asked about it', async () => {
    const response = await register(newStudent('someone@mailinator.com'));
    assert.equal(response.status, 400);
    assert.deepEqual(response.body.error.details, { email: DISPOSABLE });
    assert.ok(!server.dns.lookups.some((lookup) => lookup.includes('mailinator')), server.dns.lookups.join(', '));
    assert.equal(await userCount('someone@mailinator.com'), 0);
  });

  test('a badly formed address gets the format error, and DNS is not asked about it', async () => {
    const response = await register(newStudent('not-an-email'));
    assert.equal(response.status, 400);
    assert.deepEqual(response.body.error.details, { email: 'Enter a valid email address.' });
    assert.ok(!server.dns.lookups.some((lookup) => lookup.includes('not-an-email')));
  });

  test('when DNS fails, registration goes ahead and the server logs a warning', async (t) => {
    server.dns.set('flaky-dns.example', { mx: 'ESERVFAIL' });
    const warnings = [];
    t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));

    const response = await register(newStudent('student@flaky-dns.example'));
    assert.equal(response.status, 201);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Could not check "flaky-dns\.example" \(ESERVFAIL/);
  });

  test('the email is checked case-insensitively: a capitalised typo domain is refused too', async () => {
    const response = await register(newStudent('Dann@Examoke.COM'));
    assert.deepEqual(response.body.error.details, { email: UNDELIVERABLE });
  });

  test('accounts have no verification state: no email_verified_at column, no tokens table', async () => {
    const { rows } = await server.db.query(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND (column_name LIKE '%verif%' OR table_name LIKE '%verif%')`);
    assert.deepEqual(rows, []);
  });
});
