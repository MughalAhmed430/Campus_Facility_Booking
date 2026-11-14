// Managing facilities as an administrator, through the real app: POST /api/facilities,
// PUT /api/facilities/:id, PATCH /api/facilities/:id/status and GET /api/facilities/:id/usage.
//
// The campus clock is frozen in 2035, so the sample bookings are all in the past and
// "upcoming" is exact. Each test makes facilities of its own (room numbers T1, T2, ...).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startTestServer } from './helpers/test-server.js';

const NOW = new Date('2035-03-07T05:00:00Z'); // Wednesday 7 March 2035, 14:00 in Korea

let server;
let admin; // session cookies
let student;
let adminId;
let studentId;
const buildingIds = {};
const equipmentIds = {};

before(async () => {
  server = await startTestServer();
  server.setClock(() => NOW);
  admin = await server.login('admin@kdu.example', 'Admin@2026');
  student = await server.login('minjun.kim@kdu.example', 'Student@2026');
  adminId = (await server.db.query("SELECT id FROM users WHERE email = 'admin@kdu.example'")).rows[0].id;
  studentId = (await server.db.query("SELECT id FROM users WHERE email = 'minjun.kim@kdu.example'")).rows[0].id;
  for (const row of (await server.db.query('SELECT id, code FROM buildings')).rows) buildingIds[row.code] = row.id;
  for (const row of (await server.db.query('SELECT id, name FROM equipment')).rows) equipmentIds[row.name] = row.id;
});

after(async () => {
  await server?.close();
});

let roomCount = 0;
/** A valid request body, with a room number no other test uses. */
function body(overrides = {}) {
  roomCount += 1;
  return {
    name: `Test Room ${roomCount}`,
    buildingId: buildingIds.ENG,
    roomNumber: `T${roomCount}`,
    type: 'meeting_room',
    capacity: 12,
    floor: 2,
    description: 'Made by a test.',
    opensAt: '09:00',
    closesAt: '18:00',
    openWeekends: false,
    equipment: [{ id: equipmentIds.Projector, quantity: 1 }, { id: equipmentIds.Whiteboard, quantity: 2 }],
    ...overrides,
  };
}

const create = (payload, cookie = admin) => server.request('/facilities', { method: 'POST', body: payload, cookie });
const update = (id, payload, cookie = admin) => server.request(`/facilities/${id}`, { method: 'PUT', body: payload, cookie });
const setStatus = (id, status, cookie = admin) => server.request(`/facilities/${id}/status`, { method: 'PATCH', body: { status }, cookie });
const usage = (id, cookie = admin) => server.request(`/facilities/${id}/usage`, { cookie });
const facilityCount = async () => (await server.db.query('SELECT count(*)::int AS n FROM facilities')).rows[0].n;

/** A new facility, made through the API. Returns it. */
async function newFacility(overrides) {
  const response = await create(body(overrides));
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data.facility;
}

/** Puts a booking for the sample student straight into the test database. */
async function seedBooking(facilityId, { date, status, startTime = '10:00', endTime = '11:00' }) {
  const decided = status !== 'pending';
  await server.db.query(
    `INSERT INTO bookings (user_id, facility_id, start_time, end_time, attendees, purpose, status, decided_by, decided_at)
     VALUES ($1, $2, $3::timestamptz, $4::timestamptz, 4, 'Seeded by a test', $5, $6, $7::timestamptz)`,
    [studentId, facilityId, `${date}T${startTime}:00+09:00`, `${date}T${endTime}:00+09:00`, status,
      decided ? adminId : null, decided ? NOW : null],
  );
}

describe('POST /api/facilities', () => {
  test('creates the facility with its equipment, bookable at once', async () => {
    const payload = body({ name: '  Robotics Studio  ', openWeekends: true });
    const response = await create(payload);
    assert.equal(response.status, 201);
    const { facility } = response.body.data;
    assert.equal(facility.name, 'Robotics Studio', 'text is trimmed');
    assert.deepEqual(
      { type: facility.type, roomNumber: facility.roomNumber, floor: facility.floor, capacity: facility.capacity, status: facility.status, isBookable: facility.isBookable },
      { type: 'meeting_room', roomNumber: payload.roomNumber, floor: 2, capacity: 12, status: 'active', isBookable: true },
    );
    assert.deepEqual(facility.openingHours, { opensAt: '09:00', closesAt: '18:00', openWeekends: true });
    assert.equal(facility.building.code, 'ENG');
    assert.equal(facility.description, 'Made by a test.');
    assert.deepEqual(facility.equipment.map((item) => [item.name, item.quantity]), [['Projector', 1], ['Whiteboard', 2]]);

    const listed = (await server.request('/facilities?q=Robotics', { cookie: student })).body.data.facilities;
    assert.deepEqual(listed.map((item) => item.id), [facility.id], 'students find it in the list');
  });

  test('a new facility can start under maintenance; description and equipment are optional', async () => {
    const payload = body({ status: 'maintenance' });
    delete payload.description;
    delete payload.equipment;
    const { facility } = (await create(payload)).body.data;
    assert.deepEqual({ status: facility.status, description: facility.description, equipment: facility.equipment },
      { status: 'maintenance', description: null, equipment: [] });
  });

  test('id, timestamps and other fields in the body are ignored', async () => {
    const { facility } = (await create(body({ id: 1, createdAt: '2000-01-01', isBookable: false }))).body.data;
    assert.notEqual(facility.id, 1);
    assert.equal(facility.isBookable, true);
  });

  test('409 ROOM_TAKEN, under the room number, when the building already has that room', async () => {
    const before = await facilityCount();
    const response = await create(body({ roomNumber: '310' })); // Computer Lab A is ENG 310
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'ROOM_TAKEN');
    assert.equal(response.body.error.details.roomNumber, 'This building already has a facility with this room number.');
    assert.equal(await facilityCount(), before);
  });

  test('the same room number in another building is fine', async () => {
    assert.equal((await create(body({ roomNumber: '310', buildingId: buildingIds.HUM }))).status, 201);
  });

  test('400 for a building or an equipment type that does not exist; nothing is stored', async () => {
    const before = await facilityCount();
    const building = await create(body({ buildingId: 999999 }));
    assert.equal(building.status, 400);
    assert.deepEqual(building.body.error.details, { buildingId: 'This building does not exist.' });
    const equipment = await create(body({ equipment: [{ id: 999999, quantity: 1 }] }));
    assert.equal(equipment.status, 400);
    assert.deepEqual(equipment.body.error.details, { equipment: 'One of the equipment types does not exist.' });
    assert.equal(await facilityCount(), before, 'the facility row was rolled back with its equipment');
  });

  for (const [name, overrides, field] of [
    ['no name', { name: '   ' }, 'name'],
    ['a name over 100 characters', { name: 'x'.repeat(101) }, 'name'],
    ['an unknown type', { type: 'gym' }, 'type'],
    ['capacity 0', { capacity: 0 }, 'capacity'],
    ['capacity 1001', { capacity: 1001 }, 'capacity'],
    ['a fractional capacity', { capacity: 2.5 }, 'capacity'],
    ['floor 51', { floor: 51 }, 'floor'],
    ['an impossible opening time', { opensAt: '25:00' }, 'opensAt'],
    ['closing at or before opening', { opensAt: '18:00', closesAt: '18:00' }, 'closesAt'],
    ['openWeekends that is not true or false', { openWeekends: 'yes' }, 'openWeekends'],
    ['an unknown status', { status: 'closed' }, 'status'],
    ['a description over 1000 characters', { description: 'x'.repeat(1001) }, 'description'],
    ['equipment that is not a list', { equipment: 'Projector' }, 'equipment'],
    ['an equipment quantity of 0', { equipment: [{ id: 1, quantity: 0 }] }, 'equipment'],
    ['the same equipment type twice', { equipment: [{ id: 1, quantity: 1 }, { id: 1, quantity: 2 }] }, 'equipment'],
  ]) {
    test(`400 for ${name}`, async () => {
      const response = await create(body(overrides));
      assert.equal(response.status, 400);
      assert.equal(response.body.error.code, 'VALIDATION_ERROR');
      assert.deepEqual(Object.keys(response.body.error.details), [field]);
    });
  }

  test('every problem is listed in one 400; a basement floor is allowed', async () => {
    const response = await create({ floor: -1 });
    assert.equal(response.status, 400);
    assert.deepEqual(Object.keys(response.body.error.details).sort(),
      ['buildingId', 'capacity', 'closesAt', 'name', 'openWeekends', 'opensAt', 'roomNumber', 'type']);
  });

  test('401 without a session, 403 for a student; nothing is stored', async () => {
    const before = await facilityCount();
    assert.equal((await create(body(), null)).status, 401);
    const response = await create(body(), student);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'FORBIDDEN');
    assert.equal(await facilityCount(), before);
  });
});

describe('PUT /api/facilities/:id', () => {
  test('replaces the details and the equipment', async () => {
    const facility = await newFacility();
    const response = await update(facility.id, body({
      name: 'Renamed Room', roomNumber: facility.roomNumber, type: 'classroom', capacity: 40, floor: 0,
      opensAt: '08:00', closesAt: '22:00', openWeekends: true, description: 'Now a classroom.',
      equipment: [{ id: equipmentIds['Interactive display'], quantity: 1 }],
    }));
    assert.equal(response.status, 200);
    const updated = response.body.data.facility;
    assert.deepEqual(
      { id: updated.id, name: updated.name, type: updated.type, capacity: updated.capacity, floor: updated.floor, description: updated.description },
      { id: facility.id, name: 'Renamed Room', type: 'classroom', capacity: 40, floor: 0, description: 'Now a classroom.' },
    );
    assert.deepEqual(updated.openingHours, { opensAt: '08:00', closesAt: '22:00', openWeekends: true });
    assert.deepEqual(updated.equipment.map((item) => [item.name, item.quantity]), [['Interactive display', 1]]);
  });

  test('the status is not changed by an edit, whatever the body says', async () => {
    const facility = await newFacility({ status: 'maintenance' });
    const response = await update(facility.id, body({ roomNumber: facility.roomNumber, status: 'active' }));
    assert.equal(response.body.data.facility.status, 'maintenance');
  });

  test('existing bookings are left alone, even ones outside the new hours', async () => {
    const facility = await newFacility();
    await seedBooking(facility.id, { date: '2035-04-02', status: 'approved', startTime: '16:00', endTime: '18:00' });
    const response = await update(facility.id, body({ roomNumber: facility.roomNumber, closesAt: '15:00', capacity: 2 }));
    assert.equal(response.status, 200);
    const { rows } = await server.db.query('SELECT status FROM bookings WHERE facility_id = $1', [facility.id]);
    assert.deepEqual(rows, [{ status: 'approved' }]);
  });

  test('409 ROOM_TAKEN when moving onto another facility\'s room; nothing changes, equipment included', async () => {
    const facility = await newFacility();
    const response = await update(facility.id, body({ roomNumber: '310', equipment: [] }));
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'ROOM_TAKEN');
    const current = (await server.request(`/facilities/${facility.id}`, { cookie: admin })).body.data.facility;
    assert.equal(current.roomNumber, facility.roomNumber);
    assert.equal(current.equipment.length, 2, 'the equipment was rolled back with the rest');
  });

  test('if any step fails, the whole edit is undone', async () => {
    const facility = await newFacility();
    server.failStatement(/INSERT INTO facility_equipment/);
    const response = await update(facility.id, body({ name: 'Half Saved', roomNumber: facility.roomNumber }));
    assert.equal(response.status, 500);
    const current = (await server.request(`/facilities/${facility.id}`, { cookie: admin })).body.data.facility;
    assert.equal(current.name, facility.name);
    assert.equal(current.equipment.length, 2);
  });

  test('400 for invalid fields, 404 for a facility that does not exist, 400 for an invalid id', async () => {
    const facility = await newFacility();
    const invalid = await update(facility.id, body({ capacity: 0 }));
    assert.equal(invalid.status, 400);
    assert.deepEqual(Object.keys(invalid.body.error.details), ['capacity']);
    const missing = await update(999999, body());
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'FACILITY_NOT_FOUND');
    assert.equal((await update('abc', body())).status, 400);
  });

  test('401 without a session, 403 for a student; nothing changes', async () => {
    const facility = await newFacility();
    assert.equal((await update(facility.id, body(), null)).status, 401);
    assert.equal((await update(facility.id, body({ name: 'Taken Over' }), student)).status, 403);
    assert.equal((await server.request(`/facilities/${facility.id}`, { cookie: admin })).body.data.facility.name, facility.name);
  });
});

describe('PATCH /api/facilities/:id/status and GET /api/facilities/:id/usage', () => {
  test('usage counts approved bookings that have not ended and pending requests that have not started', async () => {
    const facility = await newFacility({ opensAt: '08:00', closesAt: '22:00' });
    await seedBooking(facility.id, { date: '2035-03-07', status: 'approved', startTime: '13:00', endTime: '15:00' }); // in progress
    await seedBooking(facility.id, { date: '2035-03-08', status: 'approved' });
    await seedBooking(facility.id, { date: '2035-03-06', status: 'completed' }); // over
    await seedBooking(facility.id, { date: '2035-03-09', status: 'pending' });
    await seedBooking(facility.id, { date: '2035-03-09', status: 'pending', startTime: '10:30', endTime: '11:30' });
    await seedBooking(facility.id, { date: '2035-03-07', status: 'pending', startTime: '09:00', endTime: '10:00' }); // started
    await seedBooking(facility.id, { date: '2035-03-10', status: 'rejected' });

    const response = await usage(facility.id);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data.usage, { upcomingApprovedBookings: 2, pendingRequests: 2 });
  });

  test('deactivating leaves every booking in place and says how many', async () => {
    const facility = await newFacility();
    await seedBooking(facility.id, { date: '2035-04-03', status: 'approved' });
    await seedBooking(facility.id, { date: '2035-04-04', status: 'pending' });

    const response = await setStatus(facility.id, 'inactive');
    assert.equal(response.status, 200);
    assert.deepEqual(
      { status: response.body.data.facility.status, isBookable: response.body.data.facility.isBookable, usage: response.body.data.usage },
      { status: 'inactive', isBookable: false, usage: { upcomingApprovedBookings: 1, pendingRequests: 1 } },
    );
    const { rows } = await server.db.query('SELECT status FROM bookings WHERE facility_id = $1 ORDER BY start_time', [facility.id]);
    assert.deepEqual(rows.map((row) => row.status), ['approved', 'pending']);
  });

  test('a closed facility takes no new requests, and its pending requests cannot be approved; reopening restores both', async () => {
    const facility = await newFacility();
    await seedBooking(facility.id, { date: '2035-04-10', status: 'pending' }); // a Tuesday
    const pendingId = (await server.db.query('SELECT id FROM bookings WHERE facility_id = $1', [facility.id])).rows[0].id;
    const request = {
      facilityId: facility.id, date: '2035-04-09', startTime: '10:00', endTime: '11:00', participantCount: 4, purpose: 'Team meeting',
    };
    const book = () => server.request('/bookings', { method: 'POST', body: request, cookie: student });
    const approve = () => server.request(`/bookings/${pendingId}/approve`, { method: 'POST', body: {}, cookie: admin });

    assert.equal((await setStatus(facility.id, 'maintenance')).status, 200);
    assert.equal((await book()).status, 400);
    assert.equal((await approve()).body.error.code, 'FACILITY_NOT_BOOKABLE');

    assert.equal((await setStatus(facility.id, 'active')).body.data.facility.isBookable, true);
    assert.equal((await book()).status, 201);
    assert.equal((await approve()).status, 200);
  });

  test('400 for an unknown or missing status, 404 for a facility that does not exist', async () => {
    const facility = await newFacility();
    assert.equal((await setStatus(facility.id, 'deleted')).status, 400);
    assert.equal((await server.request(`/facilities/${facility.id}/status`, { method: 'PATCH', body: {}, cookie: admin })).status, 400);
    assert.equal((await setStatus(999999, 'inactive')).status, 404);
    assert.equal((await usage(999999)).status, 404);
  });

  test('401 without a session, 403 for a student; nothing changes', async () => {
    const facility = await newFacility();
    assert.equal((await setStatus(facility.id, 'inactive', null)).status, 401);
    assert.equal((await setStatus(facility.id, 'inactive', student)).status, 403);
    assert.equal((await usage(facility.id, student)).status, 403);
    assert.equal((await server.request(`/facilities/${facility.id}`, { cookie: admin })).body.data.facility.status, 'active');
  });
});

describe('two administrators at once, through the real API', () => {
  test('creating the same room at the same moment: one is created, the other gets 409', async () => {
    const payload = body();
    const together = server.holdUntilSimultaneous(/^BEGIN$/, 2);
    const responses = await Promise.all([create(payload), create({ ...payload, name: 'The Other One' })]);
    await together; // rejects unless both transactions were waiting to start at the same moment
    assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
    const { rows } = await server.db.query('SELECT count(*)::int AS n FROM facilities WHERE room_number = $1', [payload.roomNumber]);
    assert.equal(rows[0].n, 1);
  });
});
