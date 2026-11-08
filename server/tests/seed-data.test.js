// Checks on the database itself: schema defaults and the sample data in database/seed.sql.
//
// Sample booking dates are relative to the day the seed runs, so whether a booking lands
// on a weekend depends on that day. The seed is therefore loaded once as if it ran on each
// day of one week (Monday to Sunday), with now() faked, and every booking is checked.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createTestDatabase, readRepoFile } from './helpers/test-server.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MONDAY_NOON_KST = Date.parse('2026-11-02T03:00:00Z'); // Monday 2 November 2026, 12:00 in Korea
const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const SEED_BOOKINGS = 11;

let db;
let seedSql;

before(async () => {
  db = await createTestDatabase({ seed: false });

  // Test-only change: bcrypt cost 4 instead of 12, so each seed run takes milliseconds
  // instead of over a second. The password hashes are not used by these tests.
  const original = await readRepoFile('database/seed.sql');
  seedSql = original.replaceAll("gen_salt('bf', 12)", "gen_salt('bf', 4)");
  assert.notEqual(seedSql, original, "seed.sql no longer uses gen_salt('bf', 12): update this test");

  // Lets seedAsOf() replace now(). Naming pg_catalog after public in the search path makes
  // an unqualified now() resolve to public.now() (by default pg_catalog is searched first).
  await db.exec('SET search_path = public, pg_catalog');
});

after(() => db?.close());

/** Empties every table, then runs seed.sql as if the current time were `instant`. */
async function seedAsOf(instant) {
  const { rows } = await db.query(
    `SELECT string_agg(format('%I', tablename), ', ') AS tables FROM pg_tables WHERE schemaname = 'public'`,
  );
  await db.exec(`TRUNCATE ${rows[0].tables} RESTART IDENTITY CASCADE`);
  await db.exec(`CREATE OR REPLACE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql STABLE
                 AS $$ SELECT '${instant.toISOString()}'::timestamptz $$`);
  await db.exec(seedSql);
}

describe('sample bookings follow the facility rules on whichever day the seed runs', () => {
  for (const [index, weekday] of WEEKDAY_NAMES.entries()) {
    test(`seeded on a ${weekday}`, async () => {
      await seedAsOf(new Date(MONDAY_NOON_KST + index * DAY_MS));
      assert.equal((await db.query('SELECT now() AS now')).rows[0].now.getTime(), MONDAY_NOON_KST + index * DAY_MS,
        'the faked clock is in use');

      const { rows } = await db.query(`
        SELECT f.name, f.is_open_weekends, bk.status,
               to_char(bk.start_time AT TIME ZONE 'Asia/Seoul', 'Dy YYYY-MM-DD HH24:MI') AS starts,
               extract(isodow FROM bk.start_time AT TIME ZONE 'Asia/Seoul') AS isodow,
               (bk.start_time AT TIME ZONE 'Asia/Seoul')::date = (bk.end_time AT TIME ZONE 'Asia/Seoul')::date
                 AND (bk.start_time AT TIME ZONE 'Asia/Seoul')::time >= f.opens_at
                 AND (bk.end_time AT TIME ZONE 'Asia/Seoul')::time <= f.closes_at AS within_hours,
               bk.end_time <= now() AS has_ended,
               bk.start_time > now() AS is_upcoming
        FROM bookings bk
        JOIN facilities f ON f.id = bk.facility_id`);
      assert.equal(rows.length, SEED_BOOKINGS);

      for (const row of rows) {
        const booking = `${row.status} booking in ${row.name} on ${row.starts}`;
        assert.ok(row.is_open_weekends || Number(row.isodow) <= 5, `${booking}: the facility is closed at weekends`);
        assert.ok(row.within_hours, `${booking}: outside the opening hours`);
        if (row.status === 'completed') assert.ok(row.has_ended, `${booking}: completed but not over yet`);
        if (row.status === 'approved' || row.status === 'pending') {
          assert.ok(row.is_upcoming, `${booking}: should still be upcoming`);
        }
      }

      // The seed's example of two pending requests for the same lab slot must still overlap
      // after their day is moved.
      const { rows: [{ pairs }] } = await db.query(`
        SELECT count(*) AS pairs
        FROM bookings a
        JOIN bookings b ON a.id < b.id AND a.facility_id = b.facility_id
        WHERE a.status = 'pending' AND b.status = 'pending'
          AND tstzrange(a.start_time, a.end_time) && tstzrange(b.start_time, b.end_time)`);
      assert.equal(pairs, '1');
    });
  }
});

describe('schema defaults', () => {
  test('a facility is open at weekends unless stated otherwise', async () => {
    const { rows } = await db.query(`
      WITH building AS (
        INSERT INTO buildings (code, name) VALUES ('TST', 'Test Hall') RETURNING id
      )
      INSERT INTO facilities (building_id, room_number, name, facility_type, capacity, floor)
      SELECT id, '001', 'Test Room', 'classroom', 10, 0 FROM building
      RETURNING is_open_weekends`);
    assert.equal(rows[0].is_open_weekends, true);
  });
});
