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

export async function createTestDatabase() {
  const db = await PGlite.create({ extensions: { btree_gist, pgcrypto }, parsers: PG_PARSERS });
  for (const file of ['database/schema.sql', 'database/seed.sql']) {
    await db.exec(await readFile(path.join(repoRoot, file), 'utf8'));
  }
  return db;
}

export async function startTestServer() {
  useTestEnvironment();
  const db = await createTestDatabase();

  // Imported only now, after the environment is set: config/index.js reads it on import.
  const { default: pool, setDatabaseForTests } = await import('../../src/db/pool.js');
  setDatabaseForTests({ query: (text, params) => db.query(text, params) });
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

  async function close() {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    setDatabaseForTests(null);
    await pool.end();
    await db.close();
  }

  return { baseUrl, db, request, login, close };
}
