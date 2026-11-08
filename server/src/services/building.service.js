import { query } from '../db/pool.js';

/** All buildings, for filters and forms. */
export async function listBuildings() {
  const { rows } = await query('SELECT id, code, name FROM buildings ORDER BY name');
  return rows.map((row) => ({ id: row.id, code: row.code, name: row.name }));
}
