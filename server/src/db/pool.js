import pg from 'pg';
import config from '../config/index.js';

// One shared pool for the whole process. SSL is controlled by the connection
// string itself (e.g. ?sslmode=require for hosted databases).
const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// An idle client can lose its connection (network drop, or the database server
// closing idle connections). Without this listener the error would crash the
// process; the pool discards the broken client and opens a new one when needed.
pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client:', err.message);
});

// What query() talks to: the pool above, except in the automated tests, which swap in
// an in-memory PostgreSQL (PGlite) so they never touch the database in server/.env.
let database = pool;

/**
 * Tests only (server/tests/helpers): route query() and withTransaction() to another
 * database, which must offer query(text, params) and transaction(work).
 */
export function setDatabaseForTests(replacement) {
  database = replacement ?? pool;
}

/**
 * Run a parameterized query. Always pass user input through `params`,
 * never by building the SQL string: query('SELECT * FROM users WHERE id = $1', [id])
 */
export function query(text, params) {
  return database.query(text, params);
}

/**
 * Runs `work(tx)` as one transaction on one connection: BEGIN, then COMMIT when work
 * resolves, or ROLLBACK when it throws (the error is passed on). Every statement that
 * must succeed or fail together goes through tx.query, which works like query().
 *
 *   await withTransaction(async (tx) => {
 *     await tx.query('UPDATE ...', [...]);
 *     await tx.query('UPDATE ...', [...]);
 *   });
 */
export async function withTransaction(work) {
  if (database !== pool) return database.transaction(work);

  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const result = await work({ query: (text, params) => client.query(text, params) });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true; // the connection itself failed: discard it instead of reusing it
    }
    throw err;
  } finally {
    client.release(broken);
  }
}

export default pool;
