// Phase 7: a facility's rules, services, directions and contact details, and its photo
// gallery (credited, content-checked, visible to every signed-in user).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startTestServer } from './helpers/test-server.js';

let server;
let admin;
let student;
let labId;

before(async () => {
  server = await startTestServer();
  admin = await server.login('admin@kdu.example', 'Admin@2026');
  student = await server.login('hamza.malik@kdu.example', 'Student@2026');
  labId = (await server.db.query("SELECT id FROM facilities WHERE name = 'Computer Lab A'")).rows[0].id;
});

after(async () => {
  await server?.close();
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
async function upload(cookie, bytes, fields) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append('image', new Blob([bytes]), 'room.png');
  const response = await fetch(`${server.baseUrl}/api/facilities/${labId}/images`, { method: 'POST', headers: { Cookie: cookie }, body: form });
  return { status: response.status, body: await response.json() };
}

test('the sample facilities have rules, services, directions and contact details', async () => {
  const { facility } = (await server.request(`/facilities/${labId}`, { cookie: student })).body.data;
  assert.match(facility.rules, /No food or drink/);
  assert.match(facility.services, /Wi-Fi/);
  assert.match(facility.locationNotes, /^Sample directions: Engineering Hall, floor 3/);
  assert.equal(facility.contact.email, 'eng.office@kdu.example');
  assert.match(facility.contact.phone, /^033-000-\d{4}$/);
  assert.deepEqual(facility.images, []);
});

test('administrators edit them; contact details are checked', async () => {
  const { facility } = (await server.request(`/facilities/${labId}`, { cookie: admin })).body.data;
  const body = {
    name: facility.name, buildingId: facility.building.id, roomNumber: facility.roomNumber, type: facility.type,
    capacity: facility.capacity, floor: facility.floor, opensAt: facility.openingHours.opensAt, closesAt: facility.openingHours.closesAt,
    openWeekends: facility.openingHours.openWeekends, equipment: facility.equipment.map((item) => ({ id: item.id, quantity: item.quantity })),
    rules: 'Bring your student card.', services: 'Printing', locationNotes: 'Third floor, east wing.', contactEmail: 'Lab.Office@KDU.example', contactPhone: '033-123-4567',
  };
  const saved = await server.request(`/facilities/${labId}`, { method: 'PUT', cookie: admin, body });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual([saved.body.data.facility.rules, saved.body.data.facility.contact.email], ['Bring your student card.', 'lab.office@kdu.example']);
  const bad = await server.request(`/facilities/${labId}`, { method: 'PUT', cookie: admin, body: { ...body, contactEmail: 'not an email', contactPhone: 'call me' } });
  assert.equal(bad.status, 400);
  assert.deepEqual(Object.keys(bad.body.error.details).sort(), ['contactEmail', 'contactPhone']);
});

test('photos: a credit is required, the content is checked, everyone signed in sees them, administrators remove them', async () => {
  assert.equal((await upload(admin, PNG, { caption: 'The lab' })).status, 400, 'no credit');
  assert.equal((await upload(admin, Buffer.from('MZ program'), { caption: 'The lab', credit: 'Photo: test' })).status, 400);
  assert.equal((await upload(student, PNG, { caption: 'The lab', credit: 'Photo: test' })).status, 403);
  const added = await upload(admin, PNG, { caption: 'Workstations by the window', credit: 'Photo: Facilities Office (sample)' });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const { image } = added.body.data;

  const { facility } = (await server.request(`/facilities/${labId}`, { cookie: student })).body.data;
  assert.deepEqual(facility.images, [{ id: image.id, caption: 'Workstations by the window', credit: 'Photo: Facilities Office (sample)' }]);
  const photo = await fetch(`${server.baseUrl}/api/facility-images/${image.id}`, { headers: { Cookie: student } });
  assert.deepEqual([photo.status, photo.headers.get('content-type')], [200, 'image/png']);
  assert.equal((await fetch(`${server.baseUrl}/api/facility-images/${image.id}`)).status, 401);

  assert.equal((await server.request(`/facilities/${labId}/images/${image.id}`, { method: 'DELETE', cookie: admin })).status, 200);
  assert.equal((await fetch(`${server.baseUrl}/api/facility-images/${image.id}`, { headers: { Cookie: student } })).status, 404);
});

test('branding: no university logo is installed in the repository, so none is offered', async () => {
  const response = await server.request('/branding');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data, { logo: null });
});
