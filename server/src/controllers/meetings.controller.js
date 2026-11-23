import { WEEKDAYS } from '../services/course.service.js';
import * as meetingService from '../services/meeting.service.js';
import { MEETING_CATEGORIES, MEETING_LENGTHS, MEETING_STATUSES } from '../services/meeting.service.js';
import { FieldValidator, MAX_INTEGER } from '../utils/validation.js';

// Counselling: advisors' office hours, meeting requests and decisions.

const TEXT_MAX_LENGTH = 500;
const REASON_MIN_LENGTH = 5;

function parseId(raw, label) {
  const v = new FieldValidator({ id: raw });
  const id = v.integer('id', { label, min: 1, max: MAX_INTEGER });
  v.assertValid();
  return id;
}

/** GET /api/advisors -> 200 { advisors, categories, lengths }. Administrators: ?all=1 adds professors without office hours. */
export async function advisors(req, res) {
  const all = req.user.role === 'admin' && req.query.all === '1';
  res.json({ success: true, data: { advisors: await meetingService.listAdvisors({ all }), categories: MEETING_CATEGORIES, lengths: MEETING_LENGTHS } });
}

/** GET /api/advisors/:id/availability?date= -> 200 { date, officeHours, slots } */
export async function availability(req, res) {
  const id = parseId(req.params.id, 'Advisor id');
  const v = new FieldValidator(req.query);
  const date = v.date('date', { label: 'Date' });
  v.assertValid();
  res.json({ success: true, data: await meetingService.advisorAvailability(id, date) });
}

/** POST /api/advisors/:id/office-hours { weekday, startTime, endTime, location } (administrators) -> 201 { officeHours } */
export async function addOfficeHours(req, res) {
  const id = parseId(req.params.id, 'Advisor id');
  const v = new FieldValidator(req.body ?? {});
  const weekday = v.integer('weekday', { label: 'Day', min: 1, max: 7 });
  const startTime = v.time('startTime', { label: 'Start time' });
  const endTime = v.time('endTime', { label: 'End time' });
  const location = v.string('location', { label: 'Location', max: 100 });
  for (const [field, value] of [['startTime', startTime], ['endTime', endTime]]) {
    if (value !== undefined && !value.endsWith(':00') && !value.endsWith(':30')) v.addError(field, 'Choose a time on the hour or half hour.');
  }
  if (startTime && endTime && endTime <= startTime) v.addError('endTime', 'End time must be after the start time.');
  v.assertValid();
  const officeHours = await meetingService.addOfficeHours(id, { weekday: WEEKDAYS.includes(weekday) ? weekday : 1, startTime, endTime, location });
  res.status(201).json({ success: true, data: { officeHours } });
}

/** DELETE /api/advisors/:id/office-hours/:hoursId (administrators) -> 200 {} */
export async function removeOfficeHours(req, res) {
  await meetingService.removeOfficeHours(parseId(req.params.id, 'Advisor id'), parseId(req.params.hoursId, 'Office hours id'));
  res.json({ success: true, data: {} });
}

/** POST /api/meetings { professorId, date, startTime, minutes, category, description } (students) -> 201 { meeting } */
export async function create(req, res) {
  const v = new FieldValidator(req.body ?? {});
  const minutes = v.integer('minutes', { label: 'Length', min: 1, max: 600 });
  const request = {
    professorId: v.integer('professorId', { label: 'Advisor', min: 1, max: MAX_INTEGER }),
    date: v.date('date', { label: 'Date' }),
    startTime: v.time('startTime', { label: 'Start time' }),
    minutes: MEETING_LENGTHS.includes(minutes) ? minutes : undefined,
    category: v.oneOf('category', Object.keys(MEETING_CATEGORIES), { label: 'Category' }),
    description: v.string('description', { label: 'Description', min: 10, max: TEXT_MAX_LENGTH }),
  };
  if (minutes !== undefined && request.minutes === undefined) v.addError('minutes', `Choose ${MEETING_LENGTHS.join(' or ')} minutes.`);
  await meetingService.checkMeetingRules(v, request);
  v.assertValid();
  res.status(201).json({ success: true, data: { meeting: await meetingService.requestMeeting(req.user.id, request) } });
}

/** GET /api/meetings/mine (students) -> 200 { meetings } */
export async function mine(req, res) {
  res.json({ success: true, data: { meetings: await meetingService.listMyMeetings(req.user) } });
}

/** GET /api/meetings?status=pending,approved (administrators) -> 200 { meetings } */
export async function list(req, res) {
  const v = new FieldValidator(req.query);
  const statuses = v.oneOfList('status', MEETING_STATUSES, { label: 'Status', required: false });
  v.assertValid();
  res.json({ success: true, data: { meetings: await meetingService.listMeetings(req.user, { statuses }) } });
}

/** POST /api/meetings/:id/approve { note? } (administrators) -> 200 { meetingId, autoDeclined } */
export async function approve(req, res) {
  const id = parseId(req.params.id, 'Meeting id');
  const v = new FieldValidator(req.body ?? {});
  const note = v.string('note', { label: 'Note', required: false, max: TEXT_MAX_LENGTH });
  v.assertValid();
  res.json({ success: true, data: await meetingService.approveMeeting(req.user.id, id, { note }) });
}

/** POST /api/meetings/:id/decline { reason } (administrators) -> 200 {} */
export async function decline(req, res) {
  const id = parseId(req.params.id, 'Meeting id');
  const v = new FieldValidator(req.body ?? {});
  const reason = v.string('reason', { label: 'Reason', min: REASON_MIN_LENGTH, max: TEXT_MAX_LENGTH });
  v.assertValid();
  await meetingService.declineMeeting(req.user.id, id, { reason });
  res.json({ success: true, data: {} });
}

/** POST /api/meetings/:id/cancel { reason? } (students, their own) -> 200 { meeting } */
export async function cancel(req, res) {
  const id = parseId(req.params.id, 'Meeting id');
  const v = new FieldValidator(req.body ?? {});
  const reason = v.string('reason', { label: 'Reason', required: false, max: TEXT_MAX_LENGTH });
  v.assertValid();
  res.json({ success: true, data: { meeting: await meetingService.cancelMyMeeting(req.user, id, { reason }) } });
}
