// Unit tests for services/email.service.js and the email settings in config/index.js.
// Nothing here contacts Gmail.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { before, describe, test } from 'node:test';
import { useTestEnvironment } from './helpers/test-server.js';

const run = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, '../..');

let emailService;

before(async () => {
  useTestEnvironment(); // no SMTP settings: the default sender is the console fallback
  emailService = await import('../src/services/email.service.js');
});

describe('without Gmail settings', () => {
  test('the verification email is printed to the console with its link, not sent', async (t) => {
    const logged = [];
    t.mock.method(console, 'log', (...args) => logged.push(args.join(' ')));
    t.mock.method(console, 'warn', (...args) => logged.push(args.join(' ')));

    emailService.setEmailSenderForTests(null); // the real default sender
    await emailService.sendVerificationEmail({ to: 'new.student@kdu.example', fullName: 'New Student', token: 'a'.repeat(43) });

    const output = logged.join('\n');
    assert.match(output, /NOT SENT: SMTP_USER and SMTP_APP_PASSWORD are not set/);
    assert.match(output, /To: +new\.student@kdu\.example/);
    assert.ok(output.includes(emailService.verificationLink('a'.repeat(43))), output);
    assert.match(emailService.describeEmailSender(), /not configured/);
  });
});

describe('Gmail settings in config', () => {
  // Loads config/index.js in a separate Node process with the given environment and
  // reports what it exposes. No email is sent: only the settings are read.
  async function loadConfig(env) {
    const script = `
      import util from 'node:util';
      const { default: config } = await import('./server/src/config/index.js');
      console.log(JSON.stringify({
        smtpConfigured: config.email.smtpConfigured,
        smtpUser: config.email.smtpUser,
        warnings: config.email.warnings,
        passwordLength: config.email.smtpAppPassword.length,
        json: JSON.stringify(config),
        inspected: util.inspect(config, { depth: 5, showHidden: false }),
      }));`;
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], {
      cwd: repoRoot,
      // Every setting config checks is given here, so server/.env cannot change the result.
      env: { ...process.env, DATABASE_URL: 'postgresql://tests:unused@127.0.0.1:9/unused', PORT: '3000', CORS_ORIGINS: '', CLIENT_BASE_URL: '', ...env },
    });
    return JSON.parse(stdout);
  }

  const GMAIL = { SMTP_USER: 'sender@example.com', SMTP_APP_PASSWORD: 'abcd efgh ijkl mnop' };

  test('the app password is usable (spaces removed) but never shown when config is printed', async () => {
    const result = await loadConfig({ NODE_ENV: 'development', ...GMAIL });
    assert.equal(result.smtpConfigured, true);
    assert.equal(result.smtpUser, 'sender@example.com');
    assert.equal(result.passwordLength, 16);
    for (const shown of [result.json, result.inspected]) {
      assert.ok(!shown.includes('abcdefghijklmnop') && !shown.includes('abcd efgh'), 'the password appears in printed config');
    }
  });

  test('real sending is switched off when NODE_ENV is "test", even with credentials', async () => {
    const result = await loadConfig({ NODE_ENV: 'test', ...GMAIL });
    assert.equal(result.smtpConfigured, false);
  });

  test('only one of the two settings means no sending (and a startup warning)', async () => {
    const result = await loadConfig({ NODE_ENV: 'development', SMTP_USER: 'sender@example.com', SMTP_APP_PASSWORD: '' });
    assert.equal(result.smtpConfigured, false);
    assert.deepEqual(result.warnings, ['SMTP_APP_PASSWORD is empty: set both SMTP_USER and SMTP_APP_PASSWORD to send email.']);
  });
});
