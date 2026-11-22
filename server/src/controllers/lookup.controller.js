import { existsSync } from 'node:fs';
import path from 'node:path';
import { listBuildings } from '../services/building.service.js';
import { listEquipment } from '../services/equipment.service.js';

// Reference lists used to fill filter and form dropdowns.

/** GET /api/buildings -> 200 { buildings: [{ id, code, name }] } */
export async function buildings(req, res) {
  res.json({ success: true, data: { buildings: await listBuildings() } });
}

// The university logo is installed by copying it here (client/assets/brand/README.md).
const LOGO_FILE = path.resolve(import.meta.dirname, '../../../client/assets/brand/kdu-logo.png');

/** GET /api/branding -> 200 { logo: '/assets/brand/kdu-logo.png' | null }. Public: the header needs it before sign-in. */
export function branding(req, res) {
  res.set('Cache-Control', 'no-cache');
  res.json({ success: true, data: { logo: existsSync(LOGO_FILE) ? '/assets/brand/kdu-logo.png' : null } });
}

/** GET /api/equipment -> 200 { equipment: [{ id, name }] } */
export async function equipment(req, res) {
  res.json({ success: true, data: { equipment: await listEquipment() } });
}
