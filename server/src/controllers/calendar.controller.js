import { studentCalendar } from '../services/calendar.service.js';

/** GET /api/calendar/mine.ics (students) -> text/calendar: reservations, lectures and meetings */
export async function mine(req, res) {
  res.set({
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': 'attachment; filename="campus-calendar.ics"',
    'Cache-Control': 'private, no-store',
  });
  res.send(await studentCalendar(req.user.id));
}
