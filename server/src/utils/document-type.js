// Which files may be handed in, checked by their content as well as their name. A file's
// extension says what it claims to be; its first bytes (or, for text, that it really is
// text) must agree, so a renamed program is refused whatever it is called.

const startsWith = (buffer, bytes) => buffer.length >= bytes.length && buffer.subarray(0, bytes.length).equals(Buffer.from(bytes));
const isZip = (b) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06]);
const isOle = (b) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]); // old .doc / .ppt
// Office files are ZIP archives listing their parts by name (stored as plain text).
const zipHas = (b, ...names) => isZip(b) && names.every((name) => b.includes(Buffer.from(name, 'latin1')));
const decoder = new TextDecoder('utf-8', { fatal: true });
function isText(buffer) {
  if (buffer.includes(0)) return false; // NUL bytes: a binary file
  try {
    decoder.decode(buffer);
    return true;
  } catch {
    return false;
  }
}

const TEXT_EXTENSIONS = ['txt', 'md', 'csv', 'js', 'mjs', 'ts', 'py', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs', 'kt', 'swift',
  'php', 'rb', 'sql', 'html', 'css', 'json', 'xml', 'yml', 'yaml', 'sh', 'ipynb'];

/** extension -> { check(buffer), label, type (served as) } */
const KINDS = {
  pdf: { label: 'PDF', type: 'application/pdf', check: (b) => startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d]) }, // %PDF-
  docx: { label: 'Word', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', check: (b) => zipHas(b, '[Content_Types].xml', 'word/') },
  doc: { label: 'Word', type: 'application/msword', check: isOle },
  pptx: { label: 'PowerPoint', type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', check: (b) => zipHas(b, '[Content_Types].xml', 'ppt/') },
  ppt: { label: 'PowerPoint', type: 'application/vnd.ms-powerpoint', check: isOle },
  zip: { label: 'ZIP', type: 'application/zip', check: isZip },
  jpg: { label: 'image', type: 'image/jpeg', check: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  jpeg: { label: 'image', type: 'image/jpeg', check: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  png: { label: 'image', type: 'image/png', check: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  webp: { label: 'image', type: 'image/webp', check: (b) => b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
  ...Object.fromEntries(TEXT_EXTENSIONS.map((extension) => [extension, { label: 'source or text', type: 'text/plain; charset=utf-8', check: isText }])),
};

export const ALLOWED_EXTENSIONS = Object.freeze(Object.keys(KINDS));
export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export function extensionOf(name) {
  const match = /\.([a-z0-9]{1,8})$/i.exec(name ?? '');
  return match ? match[1].toLowerCase() : null;
}

/**
 * Checks an uploaded file. Returns { extension, type } when its name has an allowed
 * extension and its content matches it, or { error } saying what is wrong.
 */
export function checkDocument(buffer, originalName) {
  const extension = extensionOf(originalName);
  if (!buffer || buffer.length === 0) return { error: 'The file is empty.' };
  if (!extension || !KINDS[extension]) {
    return { error: 'Hand in a PDF, Word, PowerPoint, ZIP, image (JPEG, PNG, WebP) or source/text file.' };
  }
  if (!KINDS[extension].check(buffer)) {
    return { error: `This file is not really a ${KINDS[extension].label} file, whatever its name says.` };
  }
  return { extension, type: KINDS[extension].type };
}

/** What a stored file is served as. Text (including .html and .js) is always plain text. */
export function servedTypeOf(extension) {
  return KINDS[extension]?.type ?? 'application/octet-stream';
}

/** A file name safe for a Content-Disposition header: no path, no quotes or control characters. */
export function safeDownloadName(name) {
  const base = String(name ?? 'file').split(/[\\/]/).pop().replace(/[\u0000-\u001f"\\]/g, '').trim();
  return base.slice(0, 150) || 'file';
}
