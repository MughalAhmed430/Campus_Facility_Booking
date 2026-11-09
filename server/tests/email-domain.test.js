// Unit tests for utils/email-domain.js: the registration check that an email domain can
// receive mail and is not a disposable email service. DNS is mocked in every test
// (node:dns/promises resolveMx, resolve4 and resolve6), so nothing here queries real DNS.
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { describe, test } from 'node:test';
import {
  checkEmailDomain, DISPOSABLE_EMAIL_MESSAGE, DNS_LOOKUP_TIMEOUT_MS, emailDomain, isDisposableDomain,
  UNDELIVERABLE_EMAIL_MESSAGE,
} from '../src/utils/email-domain.js';

const NO_ANSWER = Symbol('no answer'); // a lookup that never settles
const mx = (...hosts) => hosts.map((exchange, i) => ({ exchange, priority: 10 * (i + 1) }));

/**
 * Replaces the three DNS lookups for one test. Each answer is an array of records, a DNS
 * error code ('ENOTFOUND', 'ENODATA', ...) or NO_ANSWER. A lookup without an answer
 * fails with EUNEXPECTED. Returns the lookups made, e.g. ['MX naver.com'].
 */
function mockDns(t, { mx: mxAnswer, a, aaaa } = {}) {
  const lookups = [];
  const fake = (type, answer) => (domain) => {
    lookups.push(`${type} ${domain}`);
    if (answer === NO_ANSWER) return new Promise(() => {});
    const code = typeof answer === 'string' ? answer : answer === undefined ? 'EUNEXPECTED' : null;
    if (code) return Promise.reject(Object.assign(new Error(`query${type} ${code} ${domain}`), { code }));
    return Promise.resolve(answer);
  };
  t.mock.method(dns, 'resolveMx', fake('MX', mxAnswer));
  t.mock.method(dns, 'resolve4', fake('A', a));
  t.mock.method(dns, 'resolve6', fake('AAAA', aaaa));
  return lookups;
}

/** Captures console.warn for one test. */
function captureWarnings(t) {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  return warnings;
}

describe('disposable email services', () => {
  test('mailinator.com is refused even though it has MX records, without asking DNS', async (t) => {
    const lookups = mockDns(t, { mx: mx('mail.mailinator.com') });
    assert.equal(await checkEmailDomain('someone@mailinator.com'), DISPOSABLE_EMAIL_MESSAGE);
    assert.deepEqual(lookups, []);
  });

  test('other well-known throwaway services are refused too', () => {
    for (const domain of ['yopmail.com', 'guerrillamail.com', '10minutemail.com']) {
      assert.ok(isDisposableDomain(domain), domain);
    }
  });

  test('a subdomain of a disposable service is refused', async (t) => {
    mockDns(t, { mx: mx('mail.mailinator.com') });
    assert.equal(await checkEmailDomain('someone@inbox.mailinator.com'), DISPOSABLE_EMAIL_MESSAGE);
  });

  test('capitals and a trailing dot do not get around the list', async (t) => {
    mockDns(t);
    assert.equal(await checkEmailDomain('Someone@MAILINATOR.COM.'), DISPOSABLE_EMAIL_MESSAGE);
  });

  test('common real providers, including Korean ones and KDU, are not on the list', () => {
    const real = ['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'proton.me', 'naver.com',
      'daum.net', 'hanmail.net', 'kakao.com', 'nate.com', 'kdu.ac.kr', 'snu.ac.kr', 'qq.com', 'duck.com'];
    assert.deepEqual(real.filter(isDisposableDomain), []);
  });
});

describe('domains that can receive mail', () => {
  test('a domain with MX records is accepted, without an address lookup', async (t) => {
    const lookups = mockDns(t, { mx: mx('mx1.naver.com', 'mx2.naver.com') });
    assert.equal(await checkEmailDomain('student@naver.com'), null);
    assert.deepEqual(lookups, ['MX naver.com']);
  });

  test('no MX records but an IPv4 address: accepted (RFC 5321 delivers to the address)', async (t) => {
    const lookups = mockDns(t, { mx: 'ENODATA', a: ['203.0.113.10'], aaaa: 'ENODATA' });
    assert.equal(await checkEmailDomain('student@small-college.ac.kr'), null);
    assert.deepEqual(lookups.sort(), ['A small-college.ac.kr', 'AAAA small-college.ac.kr', 'MX small-college.ac.kr']);
  });

  test('no MX records but an IPv6 address only: accepted', async (t) => {
    mockDns(t, { mx: 'ENODATA', a: 'ENODATA', aaaa: ['2001:db8::25'] });
    assert.equal(await checkEmailDomain('student@ipv6-only.example'), null);
  });

  test('regression: dann@examoke.com (a domain that does not exist) is refused with the typo message', async (t) => {
    const lookups = mockDns(t, { mx: 'ENOTFOUND' });
    assert.equal(await checkEmailDomain('dann@examoke.com'), UNDELIVERABLE_EMAIL_MESSAGE);
    assert.equal(UNDELIVERABLE_EMAIL_MESSAGE, 'This email domain does not appear to exist or accept mail. Check it for typos.');
    // NXDOMAIN means no records of any kind, so there is no address lookup to make.
    assert.deepEqual(lookups, ['MX examoke.com']);
  });

  test('a domain with neither MX records nor an address is refused', async (t) => {
    mockDns(t, { mx: 'ENODATA', a: 'ENODATA', aaaa: 'ENODATA' });
    assert.equal(await checkEmailDomain('someone@web-only.example'), UNDELIVERABLE_EMAIL_MESSAGE);
  });

  test('a "null MX" (the domain accepts no mail, like example.com) is refused even with an address', async (t) => {
    const lookups = mockDns(t, { mx: [{ exchange: '', priority: 0 }], a: ['203.0.113.20'] });
    assert.equal(await checkEmailDomain('someone@example.com'), UNDELIVERABLE_EMAIL_MESSAGE);
    assert.deepEqual(lookups, ['MX example.com']);
  });

  test('a domain name DNS rejects as malformed (EBADNAME) is refused', async (t) => {
    mockDns(t, { mx: 'EBADNAME' });
    assert.equal(await checkEmailDomain('someone@bad..example.com'), UNDELIVERABLE_EMAIL_MESSAGE);
  });

  test('an address literal that is no domain name at all is refused without a lookup', async (t) => {
    const lookups = mockDns(t);
    assert.equal(await checkEmailDomain('someone@[203.0.113.5]'), UNDELIVERABLE_EMAIL_MESSAGE);
    assert.deepEqual(lookups, []);
  });

  test('an internationalized domain is looked up in its xn-- form', async (t) => {
    const lookups = mockDns(t, { mx: mx('mx.xn--9d0b527e.kr') });
    assert.equal(emailDomain('학생@학교.kr'), 'xn--9d0b527e.kr');
    assert.equal(await checkEmailDomain('학생@학교.kr'), null);
    assert.deepEqual(lookups, ['MX xn--9d0b527e.kr']);
  });
});

describe('when DNS cannot answer, registration goes ahead (fail open) and a warning is logged', () => {
  test('the default limit for each lookup is a few seconds', () => {
    assert.ok(DNS_LOOKUP_TIMEOUT_MS >= 1000 && DNS_LOOKUP_TIMEOUT_MS <= 5000, String(DNS_LOOKUP_TIMEOUT_MS));
  });

  test('an MX lookup that takes too long is abandoned and allowed through', async (t) => {
    mockDns(t, { mx: NO_ANSWER });
    const warnings = captureWarnings(t);
    const started = performance.now();
    assert.equal(await checkEmailDomain('student@slow-dns.example', { timeoutMs: 30 }), null);
    assert.ok(performance.now() - started < 1000, 'did not wait for the lookup');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Could not check "slow-dns\.example" \(ETIMEOUT: no answer within 30 ms\)/);
  });

  for (const code of ['ETIMEOUT', 'ESERVFAIL', 'EREFUSED', 'ECONNREFUSED']) {
    test(`an MX lookup failing with ${code} is allowed through`, async (t) => {
      mockDns(t, { mx: code });
      const warnings = captureWarnings(t);
      assert.equal(await checkEmailDomain('student@flaky.example'), null);
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0].includes(code), warnings[0]);
    });
  }

  test('an address lookup that fails after "no MX records" is allowed through', async (t) => {
    mockDns(t, { mx: 'ENODATA', a: 'ESERVFAIL', aaaa: 'ENODATA' });
    const warnings = captureWarnings(t);
    assert.equal(await checkEmailDomain('student@half-broken.example'), null);
    assert.equal(warnings.length, 1);
  });

  test('an address lookup that never answers is abandoned too', async (t) => {
    mockDns(t, { mx: 'ENODATA', a: NO_ANSWER, aaaa: NO_ANSWER });
    captureWarnings(t);
    assert.equal(await checkEmailDomain('student@slow-dns.example', { timeoutMs: 30 }), null);
  });

  test('the warning names the domain, never the whole address', async (t) => {
    mockDns(t, { mx: 'ESERVFAIL' });
    const warnings = captureWarnings(t);
    await checkEmailDomain('private.person@flaky.example');
    assert.ok(warnings[0].includes('flaky.example') && !warnings[0].includes('private.person'), warnings[0]);
  });

  test('no warning when the domain could be checked', async (t) => {
    mockDns(t, { mx: 'ENOTFOUND' });
    const warnings = captureWarnings(t);
    await checkEmailDomain('dann@examoke.com');
    assert.deepEqual(warnings, []);
  });
});
