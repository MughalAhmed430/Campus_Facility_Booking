import { query, withTransaction } from '../db/pool.js';
import AppError from '../utils/app-error.js';
import { deleteStoredFile, readStoredFile, saveFile } from '../utils/file-storage.js';
import { detectImageType, imageTypeOfExtension } from '../utils/file-type.js';

// Professors are records the academic office (an administrator) keeps: a name, a
// department and, optionally, a publicly available photo with its credit. They are not
// user accounts and cannot sign in.

const PHOTO_AREA = 'professors';
export const PHOTO_MAX_BYTES = 2 * 1024 * 1024; // 2 MB, as for profile photos

const COLUMNS = `p.id, p.full_name, p.photo_file, p.photo_credit,
  d.id AS department_id, d.code AS department_code, d.name AS department_name,
  (SELECT count(*)::int FROM courses c WHERE c.professor_id = p.id) AS course_count`;

export function toProfessor(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    department: { id: row.department_id, code: row.department_code, name: row.department_name },
    hasPhoto: row.photo_file != null,
    photoCredit: row.photo_file != null ? row.photo_credit : null,
    courseCount: row.course_count,
  };
}

export function professorNotFound() {
  return new AppError(404, 'PROFESSOR_NOT_FOUND', 'This professor does not exist.');
}

/** Every professor, by name. departmentId (optional): only that department's. */
export async function listProfessors({ departmentId } = {}) {
  const { rows } = await query(
    `SELECT ${COLUMNS}
     FROM professors p
     JOIN departments d ON d.id = p.department_id
     WHERE ($1::int IS NULL OR p.department_id = $1::int)
     ORDER BY p.full_name, p.id`,
    [departmentId ?? null],
  );
  return rows.map(toProfessor);
}

export async function getProfessor(id) {
  const { rows: [row] } = await query(
    `SELECT ${COLUMNS} FROM professors p JOIN departments d ON d.id = p.department_id WHERE p.id = $1`,
    [id],
  );
  if (!row) throw professorNotFound();
  return toProfessor(row);
}

function departmentMissing(err) {
  return new AppError(400, 'VALIDATION_ERROR', 'Some fields are missing or invalid.', {
    details: { departmentId: 'This department does not exist.' }, cause: err,
  });
}

/** { fullName, departmentId } -> the new professor. 400 if the department does not exist. */
export async function createProfessor({ fullName, departmentId }) {
  try {
    const { rows: [row] } = await query(
      'INSERT INTO professors (full_name, department_id) VALUES ($1, $2) RETURNING id',
      [fullName, departmentId],
    );
    return getProfessor(row.id);
  } catch (err) {
    if (err.code === '23503') throw departmentMissing(err);
    throw err;
  }
}

export async function updateProfessor(id, { fullName, departmentId }) {
  try {
    const { rows } = await query(
      'UPDATE professors SET full_name = $2, department_id = $3 WHERE id = $1 RETURNING id',
      [id, fullName, departmentId],
    );
    if (rows.length === 0) throw professorNotFound();
    return getProfessor(id);
  } catch (err) {
    if (err.code === '23503') throw departmentMissing(err);
    throw err;
  }
}

/** Deletes a professor who teaches no course. 409 PROFESSOR_HAS_COURSES otherwise. */
export async function deleteProfessor(id) {
  let photo;
  try {
    photo = await withTransaction(async (tx) => {
      const { rows: [row] } = await tx.query('DELETE FROM professors WHERE id = $1 RETURNING photo_file', [id]);
      if (!row) throw professorNotFound();
      return row.photo_file;
    });
  } catch (err) {
    // 23001 restrict_violation (ON DELETE RESTRICT); 23503 foreign_key_violation
    if (err.code === '23001' || err.code === '23503') {
      throw new AppError(409, 'PROFESSOR_HAS_COURSES', 'This professor teaches at least one course. Give those courses another professor first.', { cause: err });
    }
    throw err;
  }
  if (photo) await deleteStoredFile(PHOTO_AREA, photo);
}

/**
 * Sets the professor's photo and its credit (where it was published, required). The
 * type is read from the content: JPEG, PNG or WebP only. Saved before the database
 * points at it; the old file is deleted only afterwards.
 */
export async function setProfessorPhoto(id, buffer, credit) {
  const image = buffer ? detectImageType(buffer) : null;
  if (!image) {
    throw new AppError(400, 'VALIDATION_ERROR', 'The photo must be a JPEG, PNG or WebP image.', {
      details: { photo: 'Choose a JPEG, PNG or WebP image. This file is not one, whatever its name says.' },
    });
  }
  const name = await saveFile(PHOTO_AREA, buffer, image.extension);
  let previous;
  try {
    previous = await swapPhoto(id, name, credit);
  } catch (err) {
    await deleteStoredFile(PHOTO_AREA, name);
    throw err;
  }
  if (previous) await deleteStoredFile(PHOTO_AREA, previous);
  return getProfessor(id);
}

export async function removeProfessorPhoto(id) {
  const previous = await swapPhoto(id, null, null);
  if (previous) await deleteStoredFile(PHOTO_AREA, previous);
  return getProfessor(id);
}

function swapPhoto(id, name, credit) {
  return withTransaction(async (tx) => {
    const { rows: [row] } = await tx.query('SELECT photo_file FROM professors WHERE id = $1 FOR UPDATE', [id]);
    if (!row) throw professorNotFound();
    await tx.query('UPDATE professors SET photo_file = $2, photo_credit = $3 WHERE id = $1', [id, name, credit]);
    return row.photo_file;
  });
}

/** Any signed-in user may see a professor's photo: it is public information. 404 when there is none. */
export async function readProfessorPhoto(id) {
  const notFound = () => new AppError(404, 'PHOTO_NOT_FOUND', 'There is no photo for this professor.');
  const { rows: [row] } = await query('SELECT photo_file FROM professors WHERE id = $1', [id]);
  if (!row?.photo_file) throw notFound();
  const buffer = await readStoredFile(PHOTO_AREA, row.photo_file);
  if (!buffer) throw notFound();
  return { buffer, type: imageTypeOfExtension(row.photo_file.split('.').pop()) };
}

export async function listDepartments() {
  const { rows } = await query('SELECT id, code, name FROM departments ORDER BY name');
  return rows;
}
