import crypto from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import config from '../config/index.js';

// Uploaded files live in config.storageDir/<area>/, outside the public client folder.
// Names are random and chosen here, never taken from the upload, so a file name can
// never point anywhere else ("../../server/.env") or collide with another upload.

const SAFE_NAME = /^[0-9a-f]{32}\.[a-z0-9]{1,8}$/;

function pathOf(area, name) {
  if (!SAFE_NAME.test(name)) throw new Error(`Unsafe stored file name: ${name}`);
  return path.join(config.storageDir, area, name);
}

/** Saves `buffer` under a new random name ending in `.extension`. Resolves to the name. */
export async function saveFile(area, buffer, extension) {
  const name = `${crypto.randomBytes(16).toString('hex')}.${extension}`;
  await mkdir(path.join(config.storageDir, area), { recursive: true });
  await writeFile(pathOf(area, name), buffer, { flag: 'wx' }); // wx: never overwrite
  return name;
}

/** The file's bytes, or null when it is missing (e.g. the storage folder was emptied). */
export async function readStoredFile(area, name) {
  try {
    return await readFile(pathOf(area, name));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Deletes a stored file. A file that is already gone is not an error. */
export async function deleteStoredFile(area, name) {
  await rm(pathOf(area, name), { force: true });
}
