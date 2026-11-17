import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

import { InstallError } from './errors.js';

// Far above any real package, and low enough that a hostile archive cannot
// exhaust memory while it is unpacked to read its manifest.
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;

/**
 * Checks an archive against its manifest entry: its size, its sha512, and that
 * the package inside is the one the entry names, at the entry's version.
 *
 * @param {{ name: string, version: string, file: string, integrity: string, bytes: number }} entry
 * @param {Uint8Array} bytes
 */
export function verifyArchive(entry, bytes) {
  if (bytes.length !== entry.bytes) {
    throw new InstallError(
      `${entry.file} is ${bytes.length} bytes, and the release manifest says ${entry.bytes}. The download may be incomplete.`,
    );
  }
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (integrity !== entry.integrity) {
    throw new InstallError(
      `${entry.file} does not match the checksum in the release manifest. Nothing was installed.`,
    );
  }
  const packed = readPackedManifest(entry.file, bytes);
  if (packed.name !== entry.name || packed.version !== entry.version) {
    throw new InstallError(
      `${entry.file} contains ${packed.name}@${packed.version}, and the release manifest says ${entry.name}@${entry.version}.`,
    );
  }
}

/**
 * The `package.json` an npm archive carries, at `package/package.json`.
 *
 * @param {string} file The archive's name, for the refusal.
 * @param {Uint8Array} bytes
 */
export function readPackedManifest(file, bytes) {
  let tar;
  try {
    tar = gunzipSync(bytes, { maxOutputLength: MAX_UNPACKED_BYTES });
  } catch {
    throw new InstallError(`${file} is not a readable package archive.`);
  }
  // A tar file is a run of 512-byte headers, each followed by its file's
  // contents padded to a multiple of 512 bytes. A size that is not a plain
  // octal number, or that runs past the end, ends the reading: every step
  // moves forward by at least one header.
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    const name = field(header, 0, 100);
    const size = field(header, 124, 12);
    if (name === '' || !/^[0-7]+$/.test(size)) break;
    const start = offset + 512;
    const end = start + Number.parseInt(size, 8);
    if (end > tar.length) break;

    const prefix = field(header, 345, 155);
    const type = String.fromCharCode(header[156]);
    const isFile = type === '0' || type === '\0';
    if (isFile && (prefix ? `${prefix}/${name}` : name) === 'package/package.json') {
      try {
        const manifest = JSON.parse(tar.subarray(start, end).toString('utf8'));
        if (typeof manifest === 'object' && manifest !== null) return manifest;
      } catch {
        // Falls through to the refusal.
      }
      break;
    }
    offset = start + Math.ceil((end - start) / 512) * 512;
  }
  throw new InstallError(`${file} is not a readable package archive.`);
}

/** A header field: text up to its first NUL, without surrounding spaces. */
function field(header, start, length) {
  const bytes = header.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return bytes
    .subarray(0, end === -1 ? length : end)
    .toString('utf8')
    .trim();
}
