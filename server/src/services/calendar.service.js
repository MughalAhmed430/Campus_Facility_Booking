import { query } from '../db/pool.js';
import { currentInstant } from '../utils/campus-time.js';

// A student's calendar as an iCalendar (.ics) file (RFC 5545), for Google Calendar,
// Outlook or a phone: their approved facility reservations, the lectures of the courses
// they are registered for, and their approved counselling meetings, from a week ago on.

const PRODUCT = '-//Campus Facility Booking//Student course project//EN';

/** 2026-11-24T04:30:00.000Z -> 20261124T043000Z */
function icsTime(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Text values escape backslashes, semicolons, commas and line breaks. */
function icsText(text) {
  return String(text ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Lines longer than 75 octets are folded: CRLF and a space, without splitting a character. */
function fold(line) {
  const parts = [];
  let current = '';
  for (const char of line) {
    if (Buffer.byteLength(current + char) > (parts.length === 0 ? 75 : 74)) {
      parts.push(current);
      current = '';
    }
    current += char;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

function event({ uid, start, end, summary, location, description, stamp }) {
  return [
    'BEGIN:VEVENT',
    `UID:${uid}@campus-booking.example`,
    `DTSTAMP:${icsTime(stamp)}`,
    `DTSTART:${icsTime(start)}`,
    `DTEND:${icsTime(end)}`,
    `SUMMARY:${icsText(summary)}`,
    location ? `LOCATION:${icsText(location)}` : null,
    description ? `DESCRIPTION:${icsText(description)}` : null,
    'END:VEVENT',
  ].filter(Boolean);
}

/** The student's calendar, as the text of an .ics file. */
export async function studentCalendar(studentId) {
  const now = currentInstant();
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const [{ rows: bookings }, { rows: lectures }, { rows: meetings }] = await Promise.all([
    query(
      `SELECT b.id, b.start_time, b.end_time, b.purpose, f.name, bl.code, f.room_number, bl.name AS building
       FROM bookings b JOIN facilities f ON f.id = b.facility_id JOIN buildings bl ON bl.id = f.building_id
       WHERE b.user_id = $1 AND b.status IN ('approved', 'completed') AND b.end_time >= $2::timestamptz
       ORDER BY b.start_time`,
      [studentId, since],
    ),
    query(
      `SELECT ls.id, ls.start_time, ls.end_time, c.code, c.title, p.full_name AS professor, f.name, bl.code AS building_code, f.room_number
       FROM lecture_sessions ls
       JOIN courses c ON c.id = ls.course_id
       JOIN professors p ON p.id = c.professor_id
       JOIN course_registrations r ON r.course_id = c.id AND r.student_id = $1 AND r.status = 'registered'
       JOIN facilities f ON f.id = ls.facility_id JOIN buildings bl ON bl.id = f.building_id
       WHERE ls.end_time >= $2::timestamptz
       ORDER BY ls.start_time`,
      [studentId, since],
    ),
    query(
      `SELECT m.id, m.start_time, m.end_time, m.category, p.full_name AS professor,
              (SELECT oh.location FROM office_hours oh
                WHERE oh.professor_id = m.professor_id
                  AND oh.weekday = extract(isodow FROM m.start_time AT TIME ZONE 'Asia/Seoul')
                  AND oh.starts_at <= (m.start_time AT TIME ZONE 'Asia/Seoul')::time
                  AND oh.ends_at >= (m.end_time AT TIME ZONE 'Asia/Seoul')::time LIMIT 1) AS location
       FROM meetings m JOIN professors p ON p.id = m.professor_id
       WHERE m.student_id = $1 AND m.status IN ('approved', 'completed') AND m.end_time >= $2::timestamptz
       ORDER BY m.start_time`,
      [studentId, since],
    ),
  ]);

  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${PRODUCT}`, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:My campus calendar'];
  for (const b of bookings) {
    lines.push(...event({
      uid: `reservation-${b.id}`, start: b.start_time, end: b.end_time, stamp: now,
      summary: `Reservation: ${b.name}`, location: `${b.name}, ${b.code} ${b.room_number}, ${b.building}`,
      description: `Reference FR-${String(b.id).padStart(6, '0')}. ${b.purpose}`,
    }));
  }
  for (const l of lectures) {
    lines.push(...event({
      uid: `lecture-${l.id}`, start: l.start_time, end: l.end_time, stamp: now,
      summary: `${l.code} ${l.title}`, location: `${l.name}, ${l.building_code} ${l.room_number}`, description: `Lecture with ${l.professor}.`,
    }));
  }
  for (const m of meetings) {
    lines.push(...event({
      uid: `meeting-${m.id}`, start: m.start_time, end: m.end_time, stamp: now,
      summary: `Meeting with ${m.professor}`, location: m.location, description: `Counselling: ${m.category.replace(/_/g, ' ')}.`,
    }));
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
