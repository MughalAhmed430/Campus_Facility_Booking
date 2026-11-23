import bcrypt from 'bcryptjs';
import config from '../config/index.js';
import { query, withTransaction } from '../db/pool.js';
import AppError from '../utils/app-error.js';
import { deleteStoredFile, readStoredFile, saveFile } from '../utils/file-storage.js';
import { detectImageType, imageTypeOfExtension } from '../utils/file-type.js';
import { hashToken } from './auth.service.js';

const PHOTO_AREA = 'avatars';
export const PHOTO_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

const accountGone = () => new AppError(401, 'SESSION_INVALID', 'Your session has ended. Please log in again.');

function toProfile(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    role: row.role,
    studentNumber: row.student_number,
    hasPhoto: row.photo_file != null,
    createdAt: row.created_at.toISOString(),
  };
}

const PROFILE_COLUMNS = 'id, full_name, email, role, student_number, photo_file, created_at';

/** The signed-in user's own profile. */
export async function getProfile(userId) {
  const { rows: [row] } = await query(`SELECT ${PROFILE_COLUMNS} FROM users WHERE id = $1`, [userId]);
  if (!row) throw accountGone();
  return toProfile(row);
}

/**
 * Changes the details a user may edit themselves: only the full name. The email is the
 * sign-in name and the student number identifies the student, so neither changes here.
 */
export async function updateProfile(userId, { fullName }) {
  const { rows: [row] } = await query(
    `UPDATE users SET full_name = $2 WHERE id = $1 AND is_active RETURNING ${PROFILE_COLUMNS}`,
    [userId, fullName],
  );
  if (!row) throw accountGone();
  return toProfile(row);
}

/**
 * Changes the password after checking the current one. Every other session of this user
 * is ended (someone who knew the old password is signed out); `currentToken`'s session,
 * the one making the change, stays signed in.
 * 400 WRONG_PASSWORD (details.currentPassword) when the current password is wrong.
 */
export async function changePassword(userId, currentToken, { currentPassword, newPassword }) {
  const { rows: [user] } = await query('SELECT password_hash FROM users WHERE id = $1 AND is_active', [userId]);
  if (!user) throw accountGone();
  if (!(await bcrypt.compare(currentPassword, user.password_hash))) {
    throw new AppError(400, 'WRONG_PASSWORD', 'Your current password is not correct.', {
      details: { currentPassword: 'Your current password is not correct.' },
    });
  }
  if (await bcrypt.compare(newPassword, user.password_hash)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'The new password must be different from the current one.', {
      details: { newPassword: 'Choose a password different from your current one.' },
    });
  }
  const passwordHash = await bcrypt.hash(newPassword, config.auth.bcryptRounds);
  const otherSessionsEnded = await withTransaction(async (tx) => {
    await tx.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, passwordHash]);
    const { rows } = await tx.query(
      'DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2 RETURNING user_id',
      [userId, hashToken(currentToken)],
    );
    return rows.length;
  });
  return { otherSessionsEnded };
}

/**
 * Replaces the user's profile photo. The type is read from the file's content: only
 * JPEG, PNG and WebP are accepted, whatever the file is called. 400 otherwise.
 * The new file is saved first and the old one deleted only after the database points at
 * the new one, so a failure never leaves the user without a working photo.
 */
export async function setPhoto(userId, buffer) {
  const image = buffer ? detectImageType(buffer) : null;
  if (!image) {
    throw new AppError(400, 'VALIDATION_ERROR', 'The photo must be a JPEG, PNG or WebP image.', {
      details: { photo: 'Choose a JPEG, PNG or WebP image. This file is not one, whatever its name says.' },
    });
  }
  const name = await saveFile(PHOTO_AREA, buffer, image.extension);
  let previous;
  try {
    previous = await swapPhoto(userId, name);
  } catch (err) {
    await deleteStoredFile(PHOTO_AREA, name);
    throw err;
  }
  if (previous) await deleteStoredFile(PHOTO_AREA, previous);
  return getProfile(userId);
}

/** Removes the user's profile photo, if they have one. */
export async function removePhoto(userId) {
  const previous = await swapPhoto(userId, null);
  if (previous) await deleteStoredFile(PHOTO_AREA, previous);
  return getProfile(userId);
}

/** Points the user at photo `name` (or none). Resolves to the file name it replaced. */
function swapPhoto(userId, name) {
  return withTransaction(async (tx) => {
    const { rows: [row] } = await tx.query('SELECT photo_file FROM users WHERE id = $1 AND is_active FOR UPDATE', [userId]);
    if (!row) throw accountGone();
    await tx.query('UPDATE users SET photo_file = $2 WHERE id = $1', [userId, name]);
    return row.photo_file;
  });
}

/**
 * The photo of user `userId`, for `viewer`: only the user themselves or an administrator
 * may see it. Resolves to { buffer, type }. 404 PHOTO_NOT_FOUND when there is none, and
 * also when the viewer may not see it (the two look the same).
 */
export async function readPhoto(viewer, userId) {
  const notFound = () => new AppError(404, 'PHOTO_NOT_FOUND', 'There is no photo for this account.');
  if (viewer.role !== 'admin' && viewer.id !== userId) throw notFound();
  const { rows: [row] } = await query('SELECT photo_file FROM users WHERE id = $1', [userId]);
  if (!row?.photo_file) throw notFound();
  const buffer = await readStoredFile(PHOTO_AREA, row.photo_file);
  if (!buffer) throw notFound(); // the storage folder was emptied, e.g. on another computer
  return { buffer, type: imageTypeOfExtension(row.photo_file.split('.').pop()) };
}
