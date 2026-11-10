// Starts the real Express app on a random port, backed by a fresh in-memory PostgreSQL
// (PGlite) loaded from database/schema.sql and database/seed.sql. Every test file gets
// its own database; nothing touches the database configured in server/.env.
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import pg from 'pg';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

// PGlite converts a few column types differently from the pg driver (count(*) as a
// number, DATE at UTC midnight). Using pg's own converters makes query results in the
// tests identical to production. OIDs: int8, numeric, date, timestamp, timestamptz,
// interval, json, jsonb.
const PG_PARSERS = Object.fromEntries(
  [20, 1700, 1082, 1114, 1184, 1186, 114, 3802].map((oid) => [oid, pg.types.getTypeParser(oid, 'text')]),
);

/**
 * Sets the environment the app reads at import time. The DATABASE_URL is never used:
 * startTestServer() routes every query to PGlite. It points at a closed port, so a
 * query that somehow bypassed PGlite would fail fast instead of reaching a real database.
 */
export function useTestEnvironment() {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgresql://tests:unused@127.0.0.1:9/unused';
  process.env.CORS_ORIGINS = '';
}

/** A fresh PGlite database with database/schema.sql and (unless seed is false) database/seed.sql loaded. */
export async function createTestDatabase({ seed = true } = {}) {
  const db = await PGlite.create({ extensions: { btree_gist, pgcrypto }, parsers: PG_PARSERS });
  await db.exec(await readRepoFile('database/schema.sql'));
  if (seed) await db.exec(await readRepoFile('database/seed.sql'));
  return db;
}

/** The text of a file in the repository, e.g. readRepoFile('database/seed.sql'). */
export function readRepoFile(relativePath) {
  return readFile(path.join(repoRoot, relativePath), 'utf8');
}

// Real DNS knows this domain does not exist (checked 2026-11-08). Registering
// dann@examoke.com, a typo, is what the registration domain check was added for.
const NONEXISTENT_DOMAINS = new Set(['examoke.com']);

/**
 * Stands in for DNS in registration's email-domain check (src/utils/email-domain.js), so
 * tests never query real DNS. Every domain has one MX record (test addresses such as
 * new.student@kdu.example are fine), except the domains in NONEXISTENT_DOMAINS and any
 * domain given other answers with set(domain, { mx, a, aaaa }). Each answer is an array
 * of records or a node:dns error code ('ENOTFOUND', 'ENODATA', 'ESERVFAIL', ...).
 * `lookups` lists every query made, e.g. 'MX kdu.example'.
 */
export function createFakeDns() {
  const answers = new Map();
  const lookups = [];
  const defaults = { MX: (domain) => [{ exchange: `mx.${domain}`, priority: 10 }], A: () => 'ENODATA', AAAA: () => 'ENODATA' };

  function answer(type, key, domain) {
    lookups.push(`${type} ${domain}`);
    const value = answers.get(domain)?.[key] ?? (NONEXISTENT_DOMAINS.has(domain) ? 'ENOTFOUND' : defaults[type](domain));
    return typeof value === 'string'
      ? Promise.reject(Object.assign(new Error(`query${type} ${value} ${domain}`), { code: value }))
      : Promise.resolve(value);
  }

  return {
    resolveMx: (domain) => answer('MX', 'mx', domain),
    resolve4: (domain) => answer('A', 'a', domain),
    resolve6: (domain) => answer('AAAA', 'aaaa', domain),
    set: (domain, records) => answers.set(domain, records),
    lookups,
  };
}

export async function startTestServer() {
  useTestEnvironment();
  const db = await createTestDatabase();

  // Imported only now, after the environment is set: config/index.js reads it on import.
  const { default: pool, setDatabaseForTests } = await import('../../src/db/pool.js');
  let gate = null; // see holdUntilSimultaneous
  let failure = null; // see failStatement
  async function run(target, text, params) {
    if (gate?.pattern.test(text)) await gate.arrive();
    if (failure?.pattern.test(text)) {
      const { error } = failure;
      failure = null;
      throw error;
    }
    return target.query(text, params);
  }
  setDatabaseForTests({
    query: (text, params) => run(db, text, params),
    // PGlite has one connection, and an open transaction holds it until it ends: every
    // other query waits (it never runs inside someone else's transaction). A statement
    // held at the gate inside a transaction would therefore block everything, so for
    // transactions the gate is checked against the text 'BEGIN', before it starts.
    transaction: async (work) => {
      if (gate?.pattern.test('BEGIN')) await gate.arrive();
      return db.transaction((tx) => work({ query: (text, params) => run(tx, text, params) }));
    },
  });
  const { setClockForTests } = await import('../../src/utils/campus-time.js');
  const { setDnsResolverForTests } = await import('../../src/utils/email-domain.js');
  const dns = createFakeDns();
  setDnsResolverForTests(dns);
  const { default: app } = await import('../../src/app.js');

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  /** Calls the API. Resolves to { status, body } (body is the parsed JSON). */
  async function request(pathname, { method = 'GET', body, cookie } = {}) {
    const headers = { Accept: 'application/json' };
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${baseUrl}/api${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }

  /** Signs in through the real login endpoint and returns the Cookie header value. */
  async function login(email, password) {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (response.status !== 200) throw new Error(`Login as ${email} failed with HTTP ${response.status}`);
    const sid = response.headers.getSetCookie().find((cookie) => cookie.startsWith('sid='));
    return sid.split(';')[0];
  }

  /**
   * The next statement matching `pattern` fails with `error` instead of running, once.
   * Shows that a transaction is undone when a statement inside it fails.
   */
  function failStatement(pattern, error = Object.assign(new Error('Failure injected by a test'), { code: 'XX000' })) {
    failure = { pattern, error };
  }

  /**
   * Proves that requests really overlap: statements matching `pattern` are held back until
   * `count` of them are waiting at once, then all released together. Resolves when that
   * happens. Rejects if fewer arrive within `timeoutMs`, releasing the ones that did.
   * A transaction counts as the statement 'BEGIN' (see setDatabaseForTests above), so
   * /^BEGIN$/ holds transactions back before they start.
   * PGlite has one connection, so the released statements then run one after the other.
   */
  function holdUntilSimultaneous(pattern, count, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const waiting = [];
      const release = () => {
        clearTimeout(timer);
        gate = null;
        waiting.forEach((go) => go());
      };
      const timer = setTimeout(() => {
        release();
        reject(new Error(`Only ${waiting.length} of ${count} statements matching ${pattern} were waiting at once`));
      }, timeoutMs);
      gate = {
        pattern,
        arrive: () => new Promise((go) => {
          waiting.push(go);
          if (waiting.length === count) {
            release();
            resolve();
          }
        }),
      };
    });
  }

  async function close() {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    setDatabaseForTests(null);
    setClockForTests(null);
    setDnsResolverForTests(null);
    await pool.end();
    await db.close();
  }

  return { baseUrl, db, dns, request, login, holdUntilSimultaneous, failStatement, setClock: setClockForTests, close };
}
