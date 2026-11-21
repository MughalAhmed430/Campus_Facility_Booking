import { Router } from 'express';
import * as academic from '../controllers/academic.controller.js';
import * as grades from '../controllers/grades.controller.js';
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

export default router;
