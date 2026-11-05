import { query } from '../db/pool.js';

/** Sends a trivial query to confirm the database is reachable. Throws if it is not. */
export async function checkDatabase() {
  const started = performance.now();
  await query('SELECT 1');
  return { latencyMs: Math.round(performance.now() - started) };
}
