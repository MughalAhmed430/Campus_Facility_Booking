import { query } from '../db/pool.js';

/** All equipment types, for filters and forms. */
export async function listEquipment() {
  const { rows } = await query('SELECT id, name FROM equipment ORDER BY name');
  return rows.map((row) => ({ id: row.id, name: row.name }));
}
