import { api, apiUrl } from './client.js';

// The academic module: semesters, departments, professors, courses, lectures, registration.

/** Resolves to { semesters: [{ id, name, startsOn, endsOn }], currentId }. */
export function listSemesters({ signal } = {}) {
  return api.get('/semesters', { signal });
}

/** Administrators. Resolves to { semester }. 409 SEMESTER_TAKEN or SEMESTER_OVERLAP. */
export function createSemester({ name, startsOn, endsOn }) {
  return api.post('/semesters', { name, startsOn, endsOn });
}

/** Resolves to { departments: [{ id, code, name }] }. */
export function listDepartments({ signal } = {}) {
  return api.get('/departments', { signal });
}

/** Resolves to { professors: [{ id, fullName, department, hasPhoto, photoCredit, courseCount }] }. */
export function listProfessors({ department } = {}, { signal } = {}) {
  return api.get('/professors', { query: { department }, signal });
}

export function createProfessor(fields) {
  return api.post('/professors', fields);
}

export function updateProfessor(id, fields) {
  return api.put(`/professors/${encodeURIComponent(id)}`, fields);
}

/** 409 PROFESSOR_HAS_COURSES when they still teach a course. */
export function deleteProfessor(id) {
  return api.delete(`/professors/${encodeURIComponent(id)}`);
}

/** file: JPEG, PNG or WebP, at most 2 MB; credit: where it was published (required). */
export function uploadProfessorPhoto(id, file, credit) {
  const body = new FormData();
  body.append('credit', credit);
  body.append('photo', file);
  return api.put(`/professors/${encodeURIComponent(id)}/photo`, body);
}

export function removeProfessorPhoto(id) {
  return api.delete(`/professors/${encodeURIComponent(id)}/photo`);
}

export function professorPhotoUrl(id, version = '') {
  return apiUrl(`/professors/${encodeURIComponent(id)}/photo`, version ? { v: version } : undefined);
}

/** filters: { semester, q, department }. Resolves to { semester, courses }. */
export function listCourses(filters = {}, { signal } = {}) {
  return api.get('/courses', { query: filters, signal });
}

/** Students. Resolves to { semester, courses, totalCredits }. */
export function getTimetable({ semester } = {}, { signal } = {}) {
  return api.get('/courses/mine', { query: { semester }, signal });
}

export function getCourse(id, { signal } = {}) {
  return api.get(`/courses/${encodeURIComponent(id)}`, { signal });
}

/** Administrators. Resolves to { students }. */
export function listCourseStudents(id) {
  return api.get(`/courses/${encodeURIComponent(id)}/students`);
}

export function createCourse(fields) {
  return api.post('/courses', fields);
}

export function updateCourse(id, fields) {
  return api.put(`/courses/${encodeURIComponent(id)}`, fields);
}

export function deleteCourse(id) {
  return api.delete(`/courses/${encodeURIComponent(id)}`);
}

/** { weekday, startTime, endTime, facilityId } -> { slot, sessionsCreated, autoRejected }. 409 LECTURE_CONFLICT | PROFESSOR_CLASH. */
export function addLectureSlot(courseId, fields) {
  return api.post(`/courses/${encodeURIComponent(courseId)}/slots`, fields);
}

export function removeLectureSlot(courseId, slotId) {
  return api.delete(`/courses/${encodeURIComponent(courseId)}/slots/${encodeURIComponent(slotId)}`);
}

/** Students. Resolves to { course }. 409 COURSE_FULL | TIMETABLE_CLASH | ALREADY_REGISTERED | REGISTRATION_CLOSED. */
export function registerForCourse(id) {
  return api.post(`/courses/${encodeURIComponent(id)}/register`);
}

export function dropCourse(id) {
  return api.post(`/courses/${encodeURIComponent(id)}/drop`);
}

// ---- Grades ----------------------------------------------------------------------------

/** Students. Resolves to { semesters: [{ semester, courses, gpa, credits, creditsEarned }], cgpa, creditsEarned, scale }. */
export function getMyGrades({ signal } = {}) {
  return api.get('/grades/mine', { signal });
}

/** Resolves to { assessments: [{ id, name, weight, maxPoints }], weightTotal }. */
export function listAssessments(courseId) {
  return api.get(`/courses/${encodeURIComponent(courseId)}/assessments`);
}

/** Administrators. { name, weight, maxPoints } -> { assessment }. 409 WEIGHTS_OVER_100 | ASSESSMENT_NAME_TAKEN. */
export function createAssessment(courseId, fields) {
  return api.post(`/courses/${encodeURIComponent(courseId)}/assessments`, fields);
}

export function updateAssessment(courseId, assessmentId, fields) {
  return api.put(`/courses/${encodeURIComponent(courseId)}/assessments/${encodeURIComponent(assessmentId)}`, fields);
}

/** 409 ASSESSMENT_HAS_MARKS. */
export function deleteAssessment(courseId, assessmentId) {
  return api.delete(`/courses/${encodeURIComponent(courseId)}/assessments/${encodeURIComponent(assessmentId)}`);
}

/** Administrators. Resolves to { course, assessments, weightTotal, scale, students: [{ id, fullName, studentNumber, marks, result }] }. */
export function getGradebook(courseId) {
  return api.get(`/courses/${encodeURIComponent(courseId)}/gradebook`);
}

/** marks: [{ studentId, points }] (points null removes it). Resolves to the gradebook. 400 details["marks.<id>"]. */
export function saveMarks(courseId, assessmentId, marks) {
  return api.put(`/courses/${encodeURIComponent(courseId)}/assessments/${encodeURIComponent(assessmentId)}/marks`, { marks });
}

// ---- Attendance -------------------------------------------------------------------------

/** Students. Resolves to { semester, courses: [{ course, present, absent, excused, recorded, ratePercent, warning }], warningBelowPercent }. */
export function getMyAttendance({ signal } = {}) {
  return api.get('/attendance/mine', { signal });
}

/** Administrators. Resolves to { course, sessions: [{ id, date, startTime, endTime, room, marked, present }] }. */
export function listCourseSessions(courseId) {
  return api.get(`/courses/${encodeURIComponent(courseId)}/sessions`);
}

/** Administrators. Resolves to { session, students: [{ id, fullName, studentNumber, status }] }. */
export function getSessionAttendance(sessionId) {
  return api.get(`/sessions/${encodeURIComponent(sessionId)}/attendance`);
}

/** records: [{ studentId, status: 'present' | 'absent' | 'excused' | null }]. 409 SESSION_NOT_STARTED. */
export function saveSessionAttendance(sessionId, records) {
  return api.put(`/sessions/${encodeURIComponent(sessionId)}/attendance`, { records });
}

/** Administrators. Resolves to { course, students, warnings, warningBelowPercent }. */
export function getAttendanceReport(courseId) {
  return api.get(`/courses/${encodeURIComponent(courseId)}/attendance-report`);
}

// ---- Counselling ------------------------------------------------------------------------

/** Resolves to { advisors: [{ id, fullName, department, hasPhoto, photoCredit, officeHours }], categories, lengths }. all: administrators, every professor. */
export function listAdvisors({ all = false } = {}) {
  return api.get('/advisors', { query: { all: all ? '1' : undefined } });
}

/** Resolves to { date, officeHours, slots: [{ startTime, endTime, free }] }. */
export function getAdvisorAvailability(id, date, { signal } = {}) {
  return api.get(`/advisors/${encodeURIComponent(id)}/availability`, { query: { date }, signal });
}

export function addOfficeHours(id, fields) {
  return api.post(`/advisors/${encodeURIComponent(id)}/office-hours`, fields);
}

export function removeOfficeHours(id, hoursId) {
  return api.delete(`/advisors/${encodeURIComponent(id)}/office-hours/${encodeURIComponent(hoursId)}`);
}

/** Students. { professorId, date, startTime, minutes, category, description } -> { meeting }. 409 MEETING_CONFLICT | MEETING_OVERLAPS_YOURS. */
export function requestMeeting(fields) {
  return api.post('/meetings', fields);
}

export function listMyMeetings() {
  return api.get('/meetings/mine');
}

export function cancelMeeting(id, { reason } = {}) {
  return api.post(`/meetings/${encodeURIComponent(id)}/cancel`, { reason });
}

/** Administrators. statuses: ['pending'] etc. Resolves to { meetings }. */
export function listMeetings({ status } = {}) {
  return api.get('/meetings', { query: { status } });
}

export function approveMeeting(id, { note } = {}) {
  return api.post(`/meetings/${encodeURIComponent(id)}/approve`, { note });
}

export function declineMeeting(id, { reason }) {
  return api.post(`/meetings/${encodeURIComponent(id)}/decline`, { reason });
}
