import multer from 'multer';
import * as courseService from '../services/course.service.js';
import { WEEKDAYS } from '../services/course.service.js';
import * as professorService from '../services/professor.service.js';
import AppError from '../utils/app-error.js';
import { FieldValidator, MAX_INTEGER } from '../utils/validation.js';

// The academic module: semesters, departments, professors, courses, lectures and
// registration. Students read and register; administrators (the academic office) manage.

const DESCRIPTION_MAX_LENGTH = 2000;

function parseId(raw, label = 'Id') {
  const v = new FieldValidator({ id: raw });
  const id = v.integer('id', { label, min: 1, max: MAX_INTEGER });
  v.assertValid();
  return id;
}

// ---- Semesters and departments -------------------------------------------------------

/** GET /api/semesters -> 200 { semesters, currentId } */
export async function listSemesters(req, res) {
  res.json({ success: true, data: await courseService.listSemesters() });
}

/** POST /api/semesters { name, startsOn, endsOn } (administrators) -> 201 { semester } */
export async function createSemester(req, res) {
  const v = new FieldValidator(req.body ?? {});
  const name = v.string('name', { label: 'Name', max: 40 });
  const startsOn = v.date('startsOn', { label: 'First day' });
  const endsOn = v.date('endsOn', { label: 'Last day' });
  if (startsOn && endsOn && endsOn <= startsOn) v.addError('endsOn', 'The last day must be after the first day.');
  v.assertValid();
  res.status(201).json({ success: true, data: { semester: await courseService.createSemester({ name, startsOn, endsOn }) } });
}

/** GET /api/departments -> 200 { departments } */
export async function listDepartments(req, res) {
  res.json({ success: true, data: { departments: await professorService.listDepartments() } });
}

// ---- Professors ------------------------------------------------------------------------

/** GET /api/professors?department= -> 200 { professors } */
export async function listProfessors(req, res) {
  const v = new FieldValidator(req.query);
  const departmentId = v.integer('department', { label: 'Department', required: false, min: 1, max: MAX_INTEGER });
  v.assertValid();
  res.json({ success: true, data: { professors: await professorService.listProfessors({ departmentId }) } });
}

function parseProfessor(body) {
  const v = new FieldValidator(body ?? {});
  const fields = {
    fullName: v.string('fullName', { label: 'Name', max: 100 })?.replace(/\s+/g, ' '),
    departmentId: v.integer('departmentId', { label: 'Department', min: 1, max: MAX_INTEGER }),
  };
  v.assertValid();
  return fields;
}

/** POST /api/professors { fullName, departmentId } -> 201 { professor } */
export async function createProfessor(req, res) {
  const professor = await professorService.createProfessor(parseProfessor(req.body));
  res.status(201).json({ success: true, data: { professor } });
}

/** PUT /api/professors/:id { fullName, departmentId } -> 200 { professor } */
export async function updateProfessor(req, res) {
  const id = parseId(req.params.id, 'Professor id');
  res.json({ success: true, data: { professor: await professorService.updateProfessor(id, parseProfessor(req.body)) } });
}

/** DELETE /api/professors/:id -> 200 {}, 409 PROFESSOR_HAS_COURSES */
export async function deleteProfessor(req, res) {
  await professorService.deleteProfessor(parseId(req.params.id, 'Professor id'));
  res.json({ success: true, data: {} });
}

// One image in the field "photo" and its credit in the field "credit".
const professorPhotoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: professorService.PHOTO_MAX_BYTES, files: 1, fields: 1, fieldSize: 1000 },
}).single('photo');

const photoError = (message, cause) => new AppError(400, 'VALIDATION_ERROR', message, { details: { photo: message }, cause });

export function receiveProfessorPhoto(req, res, next) {
  professorPhotoUpload(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return next(photoError(`The photo must be at most ${professorService.PHOTO_MAX_BYTES / 1024 / 1024} MB.`, err));
    }
    return next(photoError('Send one image in the field "photo" and its credit in the field "credit".', err));
  });
}

/**
 * PUT /api/professors/:id/photo (multipart: "photo", "credit") -> 200 { professor }.
 * The credit (where the photo was published, with permission) is required.
 */
export async function setProfessorPhoto(req, res) {
  const id = parseId(req.params.id, 'Professor id');
  const v = new FieldValidator(req.body ?? {});
  const credit = v.string('credit', { label: 'Photo credit', min: 3, max: 200 });
  if (!req.file) v.addError('photo', 'Choose a photo to upload.');
  v.assertValid();
  res.json({ success: true, data: { professor: await professorService.setProfessorPhoto(id, req.file.buffer, credit) } });
}

/** DELETE /api/professors/:id/photo -> 200 { professor } */
export async function removeProfessorPhoto(req, res) {
  res.json({ success: true, data: { professor: await professorService.removeProfessorPhoto(parseId(req.params.id, 'Professor id')) } });
}

/** GET /api/professors/:id/photo -> the image, to any signed-in user. 404 when there is none. */
export async function professorPhoto(req, res) {
  const { buffer, type } = await professorService.readProfessorPhoto(parseId(req.params.id, 'Professor id'));
  res.set({ 'Content-Type': type, 'Cache-Control': 'private, no-cache', 'Content-Disposition': 'inline' });
  res.send(buffer);
}

// ---- Courses ---------------------------------------------------------------------------

/** GET /api/courses?semester=&q=&department= -> 200 { semester, courses } */
export async function listCourses(req, res) {
  const v = new FieldValidator(req.query);
  const filters = {
    semesterId: v.integer('semester', { label: 'Semester', required: false, min: 1, max: MAX_INTEGER }),
    search: v.string('q', { label: 'Search', required: false, max: 100 }),
    departmentId: v.integer('department', { label: 'Department', required: false, min: 1, max: MAX_INTEGER }),
  };
  v.assertValid();
  res.json({ success: true, data: await courseService.listCourses(req.user, filters) });
}

/** GET /api/courses/mine?semester= (students) -> 200 { semester, courses, totalCredits } */
export async function timetable(req, res) {
  const v = new FieldValidator(req.query);
  const semesterId = v.integer('semester', { label: 'Semester', required: false, min: 1, max: MAX_INTEGER });
  v.assertValid();
  res.json({ success: true, data: await courseService.getTimetable(req.user, { semesterId }) });
}

/** GET /api/courses/:id -> 200 { course } */
export async function showCourse(req, res) {
  res.json({ success: true, data: { course: await courseService.getCourse(req.user, parseId(req.params.id, 'Course id')) } });
}

/** GET /api/courses/:id/students (administrators) -> 200 { students } */
export async function courseStudents(req, res) {
  res.json({ success: true, data: { students: await courseService.listCourseStudents(parseId(req.params.id, 'Course id')) } });
}

function parseCourse(body, { withSemester }) {
  const v = new FieldValidator(body ?? {});
  const code = v.string('code', { label: 'Course code', max: 12 })?.toUpperCase().replace(/\s+/g, '');
  if (code !== undefined && !/^[A-Z]{2,5}[0-9]{3,4}[A-Z]?$/.test(code)) {
    v.addError('code', 'Write the code as 2 to 5 letters and 3 or 4 digits, for example CSE2010.');
  }
  const fields = {
    semesterId: withSemester ? v.integer('semesterId', { label: 'Semester', min: 1, max: MAX_INTEGER }) : undefined,
    code,
    title: v.string('title', { label: 'Title', max: 150 }),
    credits: v.integer('credits', { label: 'Credits', min: 1, max: 6 }),
    departmentId: v.integer('departmentId', { label: 'Department', min: 1, max: MAX_INTEGER }),
    professorId: v.integer('professorId', { label: 'Professor', min: 1, max: MAX_INTEGER }),
    description: v.string('description', { label: 'Description', required: false, max: DESCRIPTION_MAX_LENGTH }),
    seatLimit: v.integer('seatLimit', { label: 'Seat limit', min: 1, max: 1000 }),
  };
  v.assertValid();
  return fields;
}

/** POST /api/courses -> 201 { course }, 409 COURSE_CODE_TAKEN */
export async function createCourse(req, res) {
  const course = await courseService.createCourse(req.user, parseCourse(req.body, { withSemester: true }));
  res.status(201).json({ success: true, data: { course } });
}

/** PUT /api/courses/:id -> 200 { course }, 409 COURSE_CODE_TAKEN | SEATS_BELOW_REGISTERED. The semester cannot change. */
export async function updateCourse(req, res) {
  const id = parseId(req.params.id, 'Course id');
  res.json({ success: true, data: { course: await courseService.updateCourse(req.user, id, parseCourse(req.body, { withSemester: false })) } });
}

/** DELETE /api/courses/:id -> 200 {}, 409 COURSE_HAS_STUDENTS */
export async function deleteCourse(req, res) {
  await courseService.deleteCourse(parseId(req.params.id, 'Course id'));
  res.json({ success: true, data: {} });
}

/**
 * POST /api/courses/:id/slots { weekday (1 = Monday ... 7 = Sunday), startTime, endTime, facilityId }
 * -> 201 { slot, sessionsCreated, autoRejected }, 409 LECTURE_CONFLICT | PROFESSOR_CLASH
 */
export async function addSlot(req, res) {
  const id = parseId(req.params.id, 'Course id');
  const v = new FieldValidator(req.body ?? {});
  const weekday = v.integer('weekday', { label: 'Day', min: 1, max: 7 });
  const fields = {
    weekday: WEEKDAYS.includes(weekday) ? weekday : undefined,
    startTime: v.time('startTime', { label: 'Start time' }),
    endTime: v.time('endTime', { label: 'End time' }),
    facilityId: v.integer('facilityId', { label: 'Room', min: 1, max: MAX_INTEGER }),
  };
  v.assertValid();
  res.status(201).json({ success: true, data: await courseService.addLectureSlot(req.user, id, fields) });
}

/** DELETE /api/courses/:id/slots/:slotId -> 200 { sessionsRemoved } */
export async function removeSlot(req, res) {
  const id = parseId(req.params.id, 'Course id');
  const slotId = parseId(req.params.slotId, 'Lecture id');
  res.json({ success: true, data: await courseService.removeLectureSlot(id, slotId) });
}

/** POST /api/courses/:id/register (students) -> 200 { course }, 409 COURSE_FULL | TIMETABLE_CLASH | ... */
export async function register(req, res) {
  res.json({ success: true, data: { course: await courseService.register(req.user, parseId(req.params.id, 'Course id')) } });
}

/** POST /api/courses/:id/drop (students) -> 200 { course }, 409 NOT_REGISTERED | REGISTRATION_CLOSED */
export async function drop(req, res) {
  res.json({ success: true, data: { course: await courseService.drop(req.user, parseId(req.params.id, 'Course id')) } });
}
