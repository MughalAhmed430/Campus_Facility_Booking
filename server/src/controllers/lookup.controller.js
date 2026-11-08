import { listBuildings } from '../services/building.service.js';
import { listEquipment } from '../services/equipment.service.js';

// Reference lists used to fill filter and form dropdowns.

/** GET /api/buildings -> 200 { buildings: [{ id, code, name }] } */
export async function buildings(req, res) {
  res.json({ success: true, data: { buildings: await listBuildings() } });
}

/** GET /api/equipment -> 200 { equipment: [{ id, name }] } */
export async function equipment(req, res) {
  res.json({ success: true, data: { equipment: await listEquipment() } });
}
