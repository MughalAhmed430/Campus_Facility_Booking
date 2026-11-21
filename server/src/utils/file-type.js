// Recognises a file's type from its first bytes ("magic numbers"), not from its name or
// the type the browser claims: a renamed program is not an image just because it ends
// in .png.

const IMAGE_SIGNATURES = [
  { type: 'image/jpeg', extension: 'jpg', matches: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    type: 'image/png',
    extension: 'png',
    matches: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    type: 'image/webp',
    extension: 'webp',
    matches: (b) => b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
  },
];

/** { type, extension } for a JPEG, PNG or WebP image, or null for anything else. */
export function detectImageType(buffer) {
  const match = IMAGE_SIGNATURES.find((signature) => signature.matches(buffer));
  return match ? { type: match.type, extension: match.extension } : null;
}

/** 'jpg' -> 'image/jpeg', for serving a stored image. */
export function imageTypeOfExtension(extension) {
  return IMAGE_SIGNATURES.find((signature) => signature.extension === extension)?.type ?? null;
}
