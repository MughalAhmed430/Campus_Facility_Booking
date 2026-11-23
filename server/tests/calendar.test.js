// The calendar export: an iCalendar file of a student's reservations, lectures and meetings.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startTestServer } from './helpers/test-server.js';

let server;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server?.close();
});

async function download(cookie) {
  const response = await fetch(`${server.baseUrl}/api/calendar/mine.ics`, { headers: cookie ? { Cookie: cookie } : {} });
  return { status: response.status, type: response.headers.get('content-type'), disposition: response.headers.get('content-disposition'), text: await response.text() };
}

test("Ali Raza's calendar: his approved reservations, his lectures and his approved meeting", async () => {
  const cookie = await server.login('ali.raza@kdu.example', 'Student@2026');
  const { status, type, disposition, text } = await download(cookie);
  assert.equal(status, 200);
  assert.equal(type, 'text/calendar; charset=utf-8');
  assert.match(disposition, /attachment; filename="campus-calendar\.ics"/);
  assert.ok(text.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'));
  assert.ok(text.endsWith('END:VCALENDAR\r\n'));
  assert.ok(text.split('\r\n').every((line) => Buffer.byteLength(line) <= 75), 'long lines are folded');
  const unfolded = text.replace(/\r\n /g, '');
  assert.match(unfolded, /SUMMARY:Reservation: Group Study Room B/);
  assert.match(unfolded, /SUMMARY:BUS1010 Principles of Management/);
  assert.match(unfolded, /SUMMARY:Meeting with Dr\. Bilal Hussain/);
  assert.ok(unfolded.includes('LOCATION:Lecture Room 101\\, ENG 101'), 'commas are escaped');
  assert.doesNotMatch(unfolded, /CSE3050/, 'not a course he takes');
  assert.match(unfolded, /DTSTART:\d{8}T\d{6}Z/);
  const events = unfolded.match(/BEGIN:VEVENT/g).length;
  assert.equal(events, unfolded.match(/END:VEVENT/g).length);
});

test('only for signed-in students', async () => {
  assert.equal((await download()).status, 401);
  const admin = await server.login('admin@kdu.example', 'Admin@2026');
  assert.equal((await download(admin)).status, 403);
});
