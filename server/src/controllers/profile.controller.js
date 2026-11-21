import multer from 'multer';
import * as profileService from '../services/profile.service.js';
import AppError from '../utils/app-error.js';
import { readNewPassword } from '../utils/password-rules.js';
import { FieldValidator, MAX_INTEGER } from '../utils/validation.js';

/** GET /api/profile -> 200 { user }: the signed-in user's own profile */
export async function show(req, res) {
  res.json({ success: true, data: { user: await profileService.getProfile(req.user.id) } });
}

/** PATCH /api/profile { fullName } -> 200 { user }. Other fields are ignored. */
export async function update(req, res) {
  const v = new FieldValidator(req.body ?? {});
  const fullName = v.string('fullName', { label: 'Full name', max: 100 })?.replace(/\s+/g, ' ');
  v.assertValid();
  res.json({ success: true, data: { user: await profileService.updateProfile(req.user.id, { fullName }) } });
}

/**
 * POST /api/profile/password { currentPassword, newPassword } -> 200 { otherSessionsEnded }
 * 400 WRONG_PASSWORD (details.currentPassword) or VALIDATION_ERROR. This session stays
 * signed in; the user's other sessions are ended.
 */
export async function changePassword(req, res) {
  const v = new FieldValidator(req.body ?? {});
  const currentPassword = v.string('currentPassword', { label: 'Current password', trim: false, max: 1024 });
  const newPassword = readNewPassword(v, 'newPassword', { label: 'New password' });
  v.assertValid();
  const result = await profileService.changePassword(req.user.id, req.sessionToken, { currentPassword, newPassword });
  res.json({ success: true, data: result });
}

// One file in the field "photo", held in memory (at most 2 MB) until its content is checked.
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: profileService.PHOTO_MAX_BYTES, files: 1, fields: 0 },
}).single('photo');

const photoError = (message, cause) => new AppError(400, 'VALIDATION_ERROR', message, { details: { photo: message }, cause });

/** Runs multer, turning its errors into the API's usual 400 with details.photo. */
export function receivePhoto(req, res, next) {
  photoUpload(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return next(photoError(`The photo must be at most ${profileService.PHOTO_MAX_BYTES / 1024 / 1024} MB.`, err));
    }
    return next(photoError('Send one image in the field "photo".', err));
  });
}

/** PUT /api/profile/photo (multipart, field "photo") -> 200 { user }, 400 */
export async function setPhoto(req, res) {
  if (!req.file) throw photoError('Choose a photo to upload.');
  res.json({ success: true, data: { user: await profileService.setPhoto(req.user.id, req.file.buffer) } });
}

/** DELETE /api/profile/photo -> 200 { user } */
export async function removePhoto(req, res) {
  res.json({ success: true, data: { user: await profileService.removePhoto(req.user.id) } });
}

async function sendPhoto(req, res, userId) {
  const { buffer, type } = await profileService.readPhoto(req.user, userId);
  res.set({ 'Content-Type': type, 'Cache-Control': 'private, no-cache', 'Content-Disposition': 'inline' });
  res.send(buffer);
}

/** GET /api/profile/photo -> the signed-in user's photo, or 404 */
export function ownPhoto(req, res) {
  return sendPhoto(req, res, req.user.id);
}

/** GET /api/users/:id/photo -> that user's photo: their own, or anyone's for an administrator. 404 otherwise. */
export function userPhoto(req, res) {
  const v = new FieldValidator({ id: req.params.id });
  const id = v.integer('id', { label: 'User id', min: 1, max: MAX_INTEGER });
  v.assertValid();
  return sendPhoto(req, res, id);
}
