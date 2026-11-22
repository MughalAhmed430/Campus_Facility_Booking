import { Router } from 'express';
import * as academic from '../controllers/academic.controller.js';
import * as assignments from '../controllers/assignments.controller.js';
import * as attendance from '../controllers/attendance.controller.js';
import * as calendar from '../controllers/calendar.controller.js';
import * as grades from '../controllers/grades.controller.js';
import * as meetings from '../controllers/meetings.controller.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

// The academic module (mounted at /api). Every signed-in user may read it; students
// register and drop; administrators, acting as the academic office, manage it.
const router = Router();
const admin = requireRole('admin');
const student = requireRole('student');

router.get('/semesters', requireAuth, academic.listSemesters);
router.post('/semesters', requireAuth, admin, academic.createSemester);
router.get('/departments', requireAuth, academic.listDepartments);

router.get('/professors', requireAuth, academic.listProfessors);
router.post('/professors', requireAuth, admin, academic.createProfessor);
router.put('/professors/:id', requireAuth, admin, academic.updateProfessor);
router.delete('/professors/:id', requireAuth, admin, academic.deleteProfessor);
router.get('/professors/:id/photo', requireAuth, academic.professorPhoto);
router.put('/professors/:id/photo', requireAuth, admin, academic.receiveProfessorPhoto, academic.setProfessorPhoto);
router.delete('/professors/:id/photo', requireAuth, admin, academic.removeProfessorPhoto);

router.get('/courses', requireAuth, academic.listCourses);
router.post('/courses', requireAuth, admin, academic.createCourse);
router.get('/courses/mine', requireAuth, student, academic.timetable);
router.get('/courses/:id', requireAuth, academic.showCourse);
router.put('/courses/:id', requireAuth, admin, academic.updateCourse);
router.delete('/courses/:id', requireAuth, admin, academic.deleteCourse);
router.get('/courses/:id/students', requireAuth, admin, academic.courseStudents);
router.post('/courses/:id/slots', requireAuth, admin, academic.addSlot);
router.delete('/courses/:id/slots/:slotId', requireAuth, admin, academic.removeSlot);
router.post('/courses/:id/register', requireAuth, student, academic.register);
router.post('/courses/:id/drop', requireAuth, student, academic.drop);

// Grades: a course's weighted assessments and marks (administrators), a student's own results.
router.get('/courses/:id/assessments', requireAuth, grades.list);
router.post('/courses/:id/assessments', requireAuth, admin, grades.create);
router.put('/courses/:id/assessments/:assessmentId', requireAuth, admin, grades.update);
router.delete('/courses/:id/assessments/:assessmentId', requireAuth, admin, grades.remove);
router.put('/courses/:id/assessments/:assessmentId/marks', requireAuth, admin, grades.saveMarks);
router.get('/courses/:id/gradebook', requireAuth, admin, grades.gradebook);
router.get('/grades/mine', requireAuth, student, grades.mine);
router.get('/grades/scale', requireAuth, grades.scale);

// Attendance per lecture session (administrators), and a student's own rates.
router.get('/courses/:id/sessions', requireAuth, admin, attendance.sessions);
router.get('/courses/:id/attendance-report', requireAuth, admin, attendance.report);
router.get('/sessions/:id/attendance', requireAuth, admin, attendance.show);
router.put('/sessions/:id/attendance', requireAuth, admin, attendance.save);
router.get('/attendance/mine', requireAuth, student, attendance.mine);
router.get('/calendar/mine.ics', requireAuth, student, calendar.mine);

// Counselling: advisors (the professors) and their office hours, meeting requests and decisions.
router.get('/advisors', requireAuth, meetings.advisors);
router.get('/advisors/:id/availability', requireAuth, meetings.availability);
router.post('/advisors/:id/office-hours', requireAuth, admin, meetings.addOfficeHours);
router.delete('/advisors/:id/office-hours/:hoursId', requireAuth, admin, meetings.removeOfficeHours);
router.get('/meetings', requireAuth, admin, meetings.list);
router.post('/meetings', requireAuth, student, meetings.create);
router.get('/meetings/mine', requireAuth, student, meetings.mine);
router.post('/meetings/:id/approve', requireAuth, admin, meetings.approve);
router.post('/meetings/:id/decline', requireAuth, admin, meetings.decline);
router.post('/meetings/:id/cancel', requireAuth, student, meetings.cancel);

// Assignments: set by the academic office, handed in by students (files by content check).
router.get('/courses/:id/assignments', requireAuth, assignments.list);
router.post('/courses/:id/assignments', requireAuth, admin, assignments.receiveAttachment, assignments.create);
router.put('/courses/:id/assignments/:assignmentId', requireAuth, admin, assignments.receiveAttachment, assignments.update);
router.delete('/courses/:id/assignments/:assignmentId', requireAuth, admin, assignments.remove);
router.get('/assignments/:id/attachment', requireAuth, assignments.attachment);
router.put('/assignments/:id/submission', requireAuth, student, assignments.receiveSubmission, assignments.submit);
router.get('/assignments/:id/submission/file', requireAuth, student, assignments.ownFile);
router.get('/assignments/:id/submissions', requireAuth, admin, assignments.submissions);
router.get('/assignments/:id/submissions/:studentId/file', requireAuth, admin, assignments.studentFile);
router.put('/assignments/:id/submissions/:studentId/mark', requireAuth, admin, assignments.mark);

export default router;
