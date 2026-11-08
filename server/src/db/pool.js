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

/** Tests only (server/tests/helpers): route query() to another database. */
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

export default pool;
