// Proves on the real PostgreSQL in server/.env that two approved bookings for one room
// can never overlap, even when decisions are made at the same moment on separate
// connections. (npm test uses PGlite, which has a single connection, so it cannot show
// real parallel transactions.)
//
//   npm run verify:concurrency
//
// It adds a temporary room, two temporary accounts and a few requests, far in the
// future, runs the checks, then deletes everything it added, also when a check fails.
// Nothing else in the database is read or changed.
//
// Each check holds the rows involved on a separate "barrier" connection, starts the
// competing operations, waits until pg_stat_activity shows every one of them blocked on
// a lock at the same moment, and only then releases them. So a pass means the
// operations really ran against each other, not one after the other by luck.
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import config from '../config/index.js';
import pool, { query } from './pool.js';
import {
  approveRequest, AUTO_REJECT_NOTE, cancelOwnBooking, rejectRequest,
} from '../services/booking.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const KST_MS = 9 * 60 * 60 * 1000;
const WAIT_TIMEOUT_MS = 15_000;
const tag = `cc${Date.now().toString(36)}`; // also the temporary room number (max 20 characters)

const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  -- ${detail}` : ''}`);
}

/** A campus date far in the future, YYYY-MM-DD: every check gets a day of its own. */
let dayOffset = 500;
function nextDay() {
  dayOffset += 1;
  return new Date(Date.now() + KST_MS + dayOffset * DAY_MS).toISOString().slice(0, 10);
}

async function newClient() {
  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();
  return client;
}

/** Waits until at least `count` sessions in this database are blocked on a lock. Returns how many were seen. */
async function waitForLockWaits(count) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let waiting = 0;
  while (Date.now() < deadline) {
    const { rows } = await query(
      `SELECT count(*)::int AS waiting
       FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    waiting = rows[0].waiting;
    if (waiting >= count) return waiting;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return waiting;
}

/**
 * Locks `ids` on a separate connection, starts `operations` (functions returning
 * promises), waits until all of them are blocked behind that lock, then releases it.
 * Resolves to { settled: Promise.allSettled results, allWaited }.
 */
async function race(ids, operations) {
  const barrier = await newClient();
  try {
    await barrier.query('BEGIN');
    await barrier.query('SELECT id FROM bookings WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE', [ids]);
    const running = Promise.allSettled(operations.map((operation) => operation()));
    const waiting = await waitForLockWaits(operations.length);
    await barrier.query('COMMIT');
    return { settled: await running, allWaited: waiting >= operations.length, waiting };
  } finally {
    await barrier.end();
  }
}

const statusOf = async (id) => (await query('SELECT status, decision_note FROM bookings WHERE id = $1', [id])).rows[0];
const outcome = (result) => (result.status === 'fulfilled' ? 'ok' : `${result.reason.statusCode ?? 'error'} ${result.reason.code ?? result.reason.message}`);

// ---- Temporary data ------------------------------------------------------------------
const created = { userIds: [], facilityId: null };

async function setUp() {
  const { rows: [building] } = await query('SELECT id FROM buildings ORDER BY id LIMIT 1');
  if (!building) throw new Error('The database has no buildings. Run npm run db:reset first.');
  // A real bcrypt hash of a random password nobody knows: these accounts never sign in.
  const passwordHash = await bcrypt.hash(randomBytes(24).toString('hex'), 10);
  const addUser = async (role) => {
    const { rows: [user] } = await query(
      `INSERT INTO users (full_name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id`,
      [`Concurrency check ${role}`, `${tag}.${role}@kdu.example`, passwordHash, role],
    );
    created.userIds.push(user.id);
    return user.id;
  };
  const adminId = await addUser('admin');
  const studentId = await addUser('student');
  const { rows: [facility] } = await query(
    `INSERT INTO facilities (building_id, room_number, name, facility_type, capacity, floor, description)
     VALUES ($1, $2, 'Temporary concurrency check room', 'meeting_room', 50, 1, 'Created and deleted by npm run verify:concurrency.')
     RETURNING id`,
    [building.id, tag],
  );
  created.facilityId = facility.id;
  return { adminId, studentId, facilityId: facility.id };
}

async function cleanUp() {
  if (created.facilityId) {
    await query('DELETE FROM bookings WHERE facility_id = $1', [created.facilityId]);
    await query('DELETE FROM facilities WHERE id = $1', [created.facilityId]);
  }
  if (created.userIds.length > 0) await query('DELETE FROM users WHERE id = ANY($1::int[])', [created.userIds]);
}

// ---- The checks ----------------------------------------------------------------------
async function main() {
  const { hostname, pathname } = new URL(config.databaseUrl);
  console.log(`Concurrency checks on ${hostname}${pathname} (temporary data tagged ${tag})\n`);
  const { adminId, studentId, facilityId } = await setUp();

  const request = async (date, startTime, endTime) => {
    const { rows: [booking] } = await query(
      `INSERT INTO bookings (user_id, facility_id, start_time, end_time, attendees, purpose)
       VALUES ($1, $2, $3::timestamptz, $4::timestamptz, 4, $5)
       RETURNING id`,
      [studentId, facilityId, `${date}T${startTime}:00+09:00`, `${date}T${endTime}:00+09:00`, `Concurrency check ${tag}`],
    );
    return booking.id;
  };

  // 1. The database on its own: no application code, no row locks taken first.
  {
    const date = nextDay();
    const first = await request(date, '10:00', '12:00');
    const second = await request(date, '11:00', '13:00');
    const [one, two] = [await newClient(), await newClient()];
    const approveSql = "UPDATE bookings SET status = 'approved', decided_by = $2, decided_at = now() WHERE id = $1";
    try {
      await one.query('BEGIN');
      await one.query(approveSql, [first, adminId]);
      await two.query('BEGIN');
      const secondApproval = two.query(approveSql, [second, adminId]).then(() => null, (error) => error);
      const waited = (await waitForLockWaits(1)) >= 1;
      check('database: a second overlapping approval waits for the first one\'s transaction', waited);
      await one.query('COMMIT');
      const error = await secondApproval;
      check('database: when the first commits, the second is refused by bookings_no_overlap (SQLSTATE 23P01)',
        error?.code === '23P01' && error?.constraint === 'bookings_no_overlap', error ? `${error.code} ${error.message}` : 'no error');
      await two.query('ROLLBACK');
    } finally {
      await one.end();
      await two.end();
    }
    check('database: exactly one of the two is approved',
      (await statusOf(first)).status === 'approved' && (await statusOf(second)).status === 'pending');
  }

  // 2. Six overlapping requests, each approved by the application at the same moment.
  {
    const date = nextDay();
    const ids = [];
    for (let i = 0; i < 6; i += 1) ids.push(await request(date, `10:${String(i * 5).padStart(2, '0')}`, '12:00'));
    const { settled, allWaited, waiting } = await race(ids, ids.map((id) => () => approveRequest(adminId, id)));
    check('app: six approvals of overlapping requests were all in flight at the same moment', allWaited, `only ${waiting} waiting`);
    const succeeded = settled.filter((result) => result.status === 'fulfilled');
    check('app: exactly one approval succeeds; the other five get 409', succeeded.length === 1
      && settled.every((result) => result.status === 'fulfilled' || result.reason.statusCode === 409), settled.map(outcome).join(', '));
    const stored = await Promise.all(ids.map(statusOf));
    check('app: one approved, five rejected automatically with the note',
      stored.filter((row) => row.status === 'approved').length === 1
      && stored.filter((row) => row.status === 'rejected' && row.decision_note === AUTO_REJECT_NOTE).length === 5,
      JSON.stringify(stored.map((row) => row.status)));
  }

  // 3. One request approved twice at the same moment.
  {
    const id = await request(nextDay(), '10:00', '11:00');
    const { settled, allWaited } = await race([id], [() => approveRequest(adminId, id, { note: 'First' }), () => approveRequest(adminId, id, { note: 'Second' })]);
    check('app: two approvals of one request were in flight at the same moment', allWaited);
    check('app: one approval succeeds, the other gets 409 "already been approved"',
      settled.filter((result) => result.status === 'fulfilled').length === 1
      && settled.some((result) => result.status === 'rejected' && result.reason.code === 'BOOKING_NOT_PENDING'), settled.map(outcome).join(', '));
  }

  // 4. An approval and a rejection of one request at the same moment.
  {
    const id = await request(nextDay(), '10:00', '11:00');
    const { settled, allWaited } = await race([id], [() => approveRequest(adminId, id), () => rejectRequest(adminId, id, { reason: 'Rejected at the same moment.' })]);
    check('app: an approval and a rejection were in flight at the same moment', allWaited);
    const [approval, rejection] = settled;
    const stored = (await statusOf(id)).status;
    check('app: exactly one decision is stored, and it is the one that succeeded',
      [approval, rejection].filter((result) => result.status === 'fulfilled').length === 1
      && stored === (approval.status === 'fulfilled' ? 'approved' : 'rejected'), `${settled.map(outcome).join(', ')}; stored ${stored}`);
  }

  // 5. An approval and the student's cancellation at the same moment.
  {
    const id = await request(nextDay(), '10:00', '11:00');
    const { settled, allWaited } = await race([id], [() => approveRequest(adminId, id), () => cancelOwnBooking(studentId, id)]);
    check('app: an approval and a cancellation were in flight at the same moment', allWaited);
    check('app: the student\'s cancellation stands either way', settled[1].status === 'fulfilled'
      && (await statusOf(id)).status === 'cancelled', settled.map(outcome).join(', '));
  }

  // Whatever happened above: no two approved bookings overlap in the room.
  const { rows: [{ overlaps }] } = await query(
    `SELECT count(*)::int AS overlaps
     FROM bookings a
     JOIN bookings b ON a.facility_id = b.facility_id AND a.id < b.id
     WHERE a.facility_id = $1
       AND a.status IN ('approved', 'completed') AND b.status IN ('approved', 'completed')
       AND tstzrange(a.start_time, a.end_time, '[)') && tstzrange(b.start_time, b.end_time, '[)')`,
    [facilityId],
  );
  check('overall: no two approved bookings overlap', overlaps === 0, `${overlaps} overlapping pairs`);
}

try {
  await main();
} catch (error) {
  check('the checks ran to the end', false, error.message);
} finally {
  try {
    await cleanUp();
    console.log('\nRemoved the temporary room, accounts and bookings.');
  } catch (error) {
    console.error(`\nCould not remove the temporary data (${error.message}). Delete the bookings and facility with room number "${tag}", then the users whose email starts with "${tag}.".`);
    process.exitCode = 1;
  }
  await pool.end();
}

const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
