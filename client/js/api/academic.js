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
