import { query } from '../db/pool.js';
import AppError from '../utils/app-error.js';
import { deleteStoredFile, readStoredFile, saveFile } from '../utils/file-storage.js';
import { detectImageType, imageTypeOfExtension } from '../utils/file-type.js';
import { facilityNotFound } from './facility.service.js';

// A facility's photo gallery. Administrators upload JPEG, PNG or WebP photos (checked by
// content), each with a caption and a credit; every signed-in user can see them.

const AREA = 'facilities';
export const IMAGE_MAX_BYTES = 3 * 1024 * 1024; // 3 MB
const MAX_IMAGES = 12;

export async function addImage(facilityId, buffer, { caption, credit }) {
  const image = buffer ? detectImageType(buffer) : null;
  if (!image) {
    throw new AppError(400, 'VALIDATION_ERROR', 'The photo must be a JPEG, PNG or WebP image.', {
      details: { image: 'Choose a JPEG, PNG or WebP image. This file is not one, whatever its name says.' },
    });
  }
  const { rows: [facility] } = await query('SELECT (SELECT count(*)::int FROM facility_images WHERE facility_id = $1) AS images FROM facilities WHERE id = $1', [facilityId]);
  if (!facility) throw facilityNotFound();
  if (facility.images >= MAX_IMAGES) throw new AppError(409, 'TOO_MANY_IMAGES', `A facility has at most ${MAX_IMAGES} photos. Remove one first.`);
  const name = await saveFile(AREA, buffer, image.extension);
  try {
    const { rows: [row] } = await query(
      'INSERT INTO facility_images (facility_id, file, caption, credit) VALUES ($1, $2, $3, $4) RETURNING id, caption, credit',
      [facilityId, name, caption, credit],
    );
    return row;
  } catch (err) {
    await deleteStoredFile(AREA, name);
    throw err;
  }
}

export async function removeImage(facilityId, imageId) {
  const { rows: [row] } = await query('DELETE FROM facility_images WHERE id = $1 AND facility_id = $2 RETURNING file', [imageId, facilityId]);
  if (!row) throw new AppError(404, 'IMAGE_NOT_FOUND', 'This photo does not exist.');
  await deleteStoredFile(AREA, row.file);
}

export async function readImage(imageId) {
  const { rows: [row] } = await query('SELECT file FROM facility_images WHERE id = $1', [imageId]);
  const buffer = row ? await readStoredFile(AREA, row.file) : null;
  if (!buffer) throw new AppError(404, 'IMAGE_NOT_FOUND', 'This photo is not available.');
  return { buffer, type: imageTypeOfExtension(row.file.split('.').pop()) };
}
