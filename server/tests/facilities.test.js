// Integration tests: GET /api/facilities, GET /api/facilities/:id, /api/buildings, /api/equipment.
// They run against the sample data in database/seed.sql (13 facilities in 5 buildings),
// so a change to the seed facilities may need a matching change here.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startTestServer } from './helpers/test-server.js';

let server;
let student;

before(async () => {
  server = await startTestServer();
  student = await server.login('minjun.kim@kdu.example', 'Student@2026');
});

after(() => server?.close());

/** GET as the signed-in student; fails the test unless the status matches. */
async function get(pathname, { cookie = student, status = 200 } = {}) {
  const response = await server.request(pathname, { cookie });
  assert.equal(response.status, status, `GET ${pathname}: ${JSON.stringify(response.body)}`);
  return response.body;
}

async function listNames(queryString) {
  const { data } = await get(`/facilities?${queryString}`);
  assert.equal(data.total, data.facilities.length);
  return data.facilities.map((facility) => facility.name).sort();
}

async function idOf(collection, name) {
  const { data } = await get(`/${collection}`);
  const item = data[collection].find((entry) => entry.name === name);
  assert.ok(item, `${name} not found in /${collection}`);
  return item.id;
}

describe('access control', () => {
  for (const pathname of ['/facilities', '/facilities/1', '/buildings', '/equipment']) {
    test(`GET ${pathname} without a session is 401`, async () => {
      const body = await get(pathname, { cookie: null, status: 401 });
      assert.equal(body.success, false);
      assert.equal(body.error.code, 'AUTH_REQUIRED');
    });
  }

  test('a forged session cookie is 401', async () => {
    const body = await get('/facilities', { cookie: 'sid=not-a-real-session', status: 401 });
    assert.equal(body.error.code, 'SESSION_INVALID');
  });

  test('administrators can browse facilities too', async () => {
    const admin = await server.login('admin@kdu.example', 'Admin@2026');
    const { data } = await get('/facilities', { cookie: admin });
    assert.equal(data.total, 13);
  });
});

describe('GET /api/facilities', () => {
  test('without filters lists every facility, bookable ones first', async () => {
    const { success, data } = await get('/facilities');
    assert.equal(success, true);
    assert.equal(data.total, 13);
    const statuses = data.facilities.map((facility) => facility.status);
    assert.deepEqual(statuses.slice(-2), ['maintenance', 'inactive']);
    assert.ok(statuses.slice(0, 11).every((status) => status === 'active'));
  });

  test('returns the summary shape for each facility', async () => {
    const { data } = await get('/facilities?q=Computer%20Lab%20A');
    assert.equal(data.total, 1);
    const { id, building, equipment, ...rest } = data.facilities[0];
    assert.equal(typeof id, 'number');
    // deepEqual is exact: the list must not carry extra fields such as the description.
    assert.deepEqual(rest, {
      name: 'Computer Lab A',
      type: 'laboratory',
      roomNumber: '310',
      floor: 3,
      capacity: 30,
      status: 'active',
      isBookable: true,
      openingHours: { opensAt: '09:00', closesAt: '21:00' },
    });
    assert.deepEqual(Object.keys(building).sort(), ['code', 'id', 'name']);
    assert.deepEqual([building.code, building.name], ['ENG', 'Engineering Hall']);
    assert.deepEqual(equipment.map(({ name, quantity }) => ({ name, quantity })), [
      { name: 'Desktop computer', quantity: 30 },
      { name: 'Projector', quantity: 1 },
    ]);
  });

  test('filters by type', async () => {
    assert.deepEqual(await listNames('type=laboratory'), ['Chemistry Lab', 'Computer Lab A', 'Networking Lab', 'Physics Lab']);
  });

  test('filters by building', async () => {
    const scienceHall = await idOf('buildings', 'Science Hall');
    assert.deepEqual(await listNames(`building=${scienceHall}`), ['Chemistry Lab', 'Lecture Room 110', 'Physics Lab']);
  });

  test('filters by minimum capacity (inclusive)', async () => {
    assert.deepEqual(await listNames('minCapacity=40'), ['Classroom 105', 'Classroom 204', 'Lecture Room 101', 'Lecture Room 110']);
  });

  test('filters by equipment: the facility must have every selected type', async () => {
    const projector = await idOf('equipment', 'Projector');
    const whiteboard = await idOf('equipment', 'Whiteboard');
    assert.deepEqual(await listNames(`equipment=${projector},${whiteboard}`),
      ['Classroom 105', 'Classroom 204', 'Lecture Room 101', 'Networking Lab']);
    // The repeated-parameter form gives the same result.
    assert.deepEqual(await listNames(`equipment=${projector}&equipment=${whiteboard}`),
      ['Classroom 105', 'Classroom 204', 'Lecture Room 101', 'Networking Lab']);
  });

  test('filters by status', async () => {
    assert.deepEqual(await listNames('status=maintenance,inactive'), ['Conference Room 401', 'Lecture Room 110']);
  });

  test('combines filters with AND', async () => {
    // Lecture Room 110 also matches type and capacity, but is under maintenance.
    assert.deepEqual(await listNames('type=classroom&minCapacity=50&status=active'), ['Lecture Room 101']);
  });

  test('searches name, building and "CODE ROOM", case-insensitively', async () => {
    assert.deepEqual(await listNames('q=lab'), ['Chemistry Lab', 'Computer Lab A', 'Networking Lab', 'Physics Lab']);
    assert.deepEqual(await listNames('q=eng%20310'), ['Computer Lab A']);
    assert.deepEqual(await listNames('q=central%20library'), ['Group Study Room A', 'Group Study Room B']);
  });

  test('treats % and _ in the search as plain text, not wildcards', async () => {
    assert.deepEqual(await listNames('q=_'), []);
    assert.deepEqual(await listNames('q=%25'), []);
  });

  test('ignores a search of only spaces', async () => {
    assert.equal((await listNames('q=%20%20%20')).length, 13);
  });

  test('returns an empty list when nothing matches', async () => {
    const { data } = await get('/facilities?type=meeting_room&minCapacity=500');
    assert.deepEqual(data, { facilities: [], total: 0 });
  });

  test('rejects invalid filters with a 400 listing every problem', async () => {
    const body = await get('/facilities?type=pool&minCapacity=lots&equipment=1,x&building=0&status=open', { status: 400 });
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    assert.deepEqual(Object.keys(body.error.details).sort(), ['building', 'equipment', 'minCapacity', 'status', 'type']);
  });

  test('rejects a capacity above the largest room size', async () => {
    const body = await get('/facilities?minCapacity=5000', { status: 400 });
    assert.match(body.error.details.minCapacity, /between 1 and 1000/);
  });
});

describe('GET /api/facilities/:id', () => {
  test('returns the full detail of one facility', async () => {
    const id = await idOf('facilities', 'Chemistry Lab');
    const { data } = await get(`/facilities/${id}`);
    const { facility } = data;
    assert.equal(facility.id, id);
    assert.equal(facility.name, 'Chemistry Lab');
    assert.equal(facility.description, 'Wet lab with fume hoods. A safety briefing is required.');
    assert.deepEqual(facility.openingHours, { opensAt: '09:00', closesAt: '18:00' });
    assert.deepEqual(facility.building, {
      id: facility.building.id,
      code: 'SCI',
      name: 'Science Hall',
      description: 'Chemistry and physics laboratories and a large lecture room.',
    });
    assert.deepEqual(facility.equipment.map(({ name, quantity, description }) => ({ name, quantity, description })), [
      { name: 'Fume hood', quantity: 4, description: 'Ventilated enclosure for working with chemicals.' },
      { name: 'Whiteboard', quantity: 1, description: 'Wall-mounted whiteboard with markers.' },
    ]);
    assert.ok(!Number.isNaN(Date.parse(facility.updatedAt)), 'updatedAt is an ISO date');
  });

  test('an inactive facility can still be viewed, but is not bookable', async () => {
    const id = await idOf('facilities', 'Conference Room 401');
    const { data } = await get(`/facilities/${id}`);
    assert.equal(data.facility.status, 'inactive');
    assert.equal(data.facility.isBookable, false);
  });

  test('an id that does not exist is 404 FACILITY_NOT_FOUND', async () => {
    const body = await get('/facilities/999999', { status: 404 });
    assert.equal(body.error.code, 'FACILITY_NOT_FOUND');
  });

  for (const badId of ['abc', '0', '-1', '1.5', '2147483648']) {
    test(`an invalid id (${badId}) is 400, not a server error`, async () => {
      const body = await get(`/facilities/${badId}`, { status: 400 });
      assert.equal(body.error.code, 'VALIDATION_ERROR');
      assert.ok(body.error.details.id);
    });
  }
});

describe('filter options', () => {
  test('GET /api/buildings lists buildings by name', async () => {
    const { data } = await get('/buildings');
    assert.deepEqual(data.buildings.map((b) => b.code), ['LIB', 'ENG', 'HUM', 'SCI', 'STU']);
  });

  test('GET /api/equipment lists equipment types by name', async () => {
    const { data } = await get('/equipment');
    assert.equal(data.equipment.length, 7);
    assert.equal(data.equipment[0].name, 'Desktop computer');
  });
});
