// Registration-time checks on the domain of an email address. Nothing is sent to the
// address and no credentials are needed:
//
//   1. The domain is not a disposable (throwaway) email service. The list is the
//      community-maintained blocklist published as the disposable-email-domains-js package.
//   2. The domain can receive mail: it has MX records or, without them, an IPv4/IPv6
//      address, which mail servers then deliver to (RFC 5321, section 5.1).
//
// Only a domain that DNS says does not exist or accepts no mail is refused. A lookup that
// fails for any other reason (timeout, unreachable DNS server, resolver error) lets the
// registration through and logs a warning: a DNS hiccup must never block a real student.
//
// This shows that the domain is real, not that the mailbox exists or belongs to the
// person registering. Only sending an email could show that, and this project sends none.
import dnsPromises from 'node:dns/promises';
import { domainToASCII } from 'node:url';
import disposableEmailDomains from 'disposable-email-domains-js';

const DISPOSABLE_DOMAINS = new Set(disposableEmailDomains.disposableEmailBlocklist());

/** How long each DNS lookup may take before registration goes ahead without the check. */
export const DNS_LOOKUP_TIMEOUT_MS = 3000;

export const DISPOSABLE_EMAIL_MESSAGE =
  'Please use a permanent email address. Temporary or disposable email services are not accepted.';
export const UNDELIVERABLE_EMAIL_MESSAGE =
  'This email domain does not appear to exist or accept mail. Check it for typos.';

// DNS error codes (node:dns). ENOTFOUND: the domain does not exist (NXDOMAIN).
// EBADNAME: not a valid domain name, so it cannot exist. ENODATA: the domain exists but
// has no records of the type asked for.
const DOES_NOT_EXIST = new Set(['ENOTFOUND', 'EBADNAME']);
const NO_RECORDS = 'ENODATA';

let resolver = dnsPromises;

/**
 * Tests: answers DNS lookups with `replacement` ({ resolveMx, resolve4, resolve6 }, the
 * same functions as node:dns/promises) instead of real DNS. null restores real DNS.
 */
export function setDnsResolverForTests(replacement) {
  resolver = replacement ?? dnsPromises;
}

/**
 * The domain of an email address as DNS knows it: lower case, without a trailing dot,
 * internationalized names in their xn-- form ("학교.kr" -> "xn--9d0b527e.kr").
 * '' if it cannot be a domain name at all.
 */
export function emailDomain(email) {
  return domainToASCII(email.slice(email.lastIndexOf('@') + 1).trim().replace(/\.+$/, ''));
}

/** True for a disposable email domain, and for any subdomain of one (inbox.mailinator.com). */
export function isDisposableDomain(domain) {
  const labels = domain.split('.');
  // Every suffix with at least two labels: a.b.example.com -> a.b.example.com, b.example.com, example.com
  return labels.slice(0, -1).some((_, i) => DISPOSABLE_DOMAINS.has(labels.slice(i).join('.')));
}

/**
 * Checks the domain of a well-formed email address. Resolves to a message for the email
 * field, or null when the domain is acceptable or could not be checked.
 * timeoutMs: per lookup (tests use a short one).
 */
export async function checkEmailDomain(email, { timeoutMs = DNS_LOOKUP_TIMEOUT_MS } = {}) {
  const domain = emailDomain(email);
  if (!domain) return UNDELIVERABLE_EMAIL_MESSAGE;
  if (isDisposableDomain(domain)) return DISPOSABLE_EMAIL_MESSAGE;

  const result = await canReceiveMail(domain, timeoutMs);
  if (result.unknown) {
    // Only the domain is logged, never the whole address.
    console.warn(`[email-domain] Could not check "${domain}" (${result.unknown}); the registration was allowed without the check.`);
    return null;
  }
  return result.acceptsMail ? null : UNDELIVERABLE_EMAIL_MESSAGE;
}

/** { acceptsMail: true | false }, or { unknown: reason } when DNS could not answer. */
async function canReceiveMail(domain, timeoutMs) {
  // new Promise(...) turns a synchronous throw from the resolver into a rejection.
  const lookup = (method) => withTimeout(new Promise((resolve) => resolve(resolver[method](domain))), timeoutMs);

  try {
    const records = await lookup('resolveMx');
    if (records.some((record) => record.exchange !== '' && record.exchange !== '.')) return { acceptsMail: true };
    // Only a "null MX" (RFC 7505: a single record with no host, "."): the domain says it
    // accepts no mail. example.com publishes one.
    if (records.length > 0) return { acceptsMail: false };
  } catch (error) {
    if (DOES_NOT_EXIST.has(error.code)) return { acceptsMail: false };
    if (error.code !== NO_RECORDS) return { unknown: reason(error) };
  }

  // No MX records: mail is delivered to the domain's own address, if it has one.
  const answers = await Promise.allSettled([lookup('resolve4'), lookup('resolve6')]);
  if (answers.some((answer) => answer.status === 'fulfilled' && answer.value.length > 0)) return { acceptsMail: true };
  const failed = answers.find((answer) => answer.status === 'rejected'
    && answer.reason?.code !== NO_RECORDS && !DOES_NOT_EXIST.has(answer.reason?.code));
  return failed ? { unknown: reason(failed.reason) } : { acceptsMail: false };
}

function reason(error) {
  return error?.code ? `${error.code}: ${error.message}` : String(error?.message ?? error);
}

/** Rejects with code ETIMEOUT if `promise` has not settled after `ms` milliseconds. */
function withTimeout(promise, ms) {
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`no answer within ${ms} ms`), { code: 'ETIMEOUT' })), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
