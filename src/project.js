import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { InstallError } from './errors.js';

/** The lockfile each supported package manager keeps. */
export const LOCKFILES = { npm: 'package-lock.json', pnpm: 'pnpm-lock.yaml' };

// Lockfiles of package managers, or of an npm mode, this installer does not
// update yet.
const UNSUPPORTED_LOCKFILES = ['yarn.lock', 'bun.lock', 'bun.lockb', 'npm-shrinkwrap.json'];

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * What is at a path, without following a link: `missing`, a regular `file`, a
 * `directory`, or `other` for a link or anything else. The installer only
 * reads and writes real files and directories inside the project, so a link
 * can never send it to a file somewhere else.
 *
 * @returns {'missing' | 'file' | 'directory' | 'other'}
 */
export function kindOf(file) {
  const stats = lstatSync(file, { throwIfNoEntry: false });
  if (!stats) return 'missing';
  if (stats.isFile()) return 'file';
  return stats.isDirectory() ? 'directory' : 'other';
}

/** Refuses unless the project has a `package.json` that is a regular file. */
export function requireManifestFile(directory) {
  const manifestPath = path.join(directory, 'package.json');
  const kind = kindOf(manifestPath);
  if (kind === 'missing') {
    throw new InstallError(
      `There is no package.json in ${directory}. Run this in an existing project.`,
    );
  }
  if (kind !== 'file') {
    throw new InstallError(
      `${manifestPath} is a link or not a regular file, so it was left as it is.`,
    );
  }
  return manifestPath;
}

/**
 * Reads the project's `package.json`, and refuses one that is missing, a
 * link, or not valid JSON.
 *
 * @param {string} directory
 */
export function readProject(directory) {
  const manifestPath = requireManifestFile(directory);
  const text = readFileSync(manifestPath, 'utf8');
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    manifest = undefined;
  }
  if (!isObject(manifest)) {
    throw new InstallError(`${manifestPath} is not valid JSON, so it was left as it is.`);
  }
  for (const field of DEPENDENCY_FIELDS) {
    if (manifest[field] !== undefined && !isObject(manifest[field])) {
      throw new InstallError(`"${field}" in ${manifestPath} is not an object.`);
    }
  }
  return { directory, manifestPath, text, manifest };
}

/**
 * Refuses a project that is a workspace or sits inside one. Both package
 * managers look upwards for a workspace, and would then write the workspace's
 * lockfile and not this project's.
 *
 * @param {string} directory
 * @param {'npm' | 'pnpm'} packageManager
 */
export function refuseWorkspace(directory, packageManager) {
  const workspace = findWorkspace(directory, packageManager);
  if (workspace) {
    throw new InstallError(
      `This project is part of a workspace (${workspace}). Workspaces are not supported yet; run this in a project of its own.`,
    );
  }
}

function findWorkspace(directory, packageManager) {
  for (let current = directory; ; current = path.dirname(current)) {
    const manifestPath = path.join(current, 'package.json');
    if (kindOf(manifestPath) === 'file') {
      try {
        if (JSON.parse(readFileSync(manifestPath, 'utf8')).workspaces) return manifestPath;
      } catch {
        // Not ours to judge: an unreadable manifest above the project.
      }
    }
    const pnpmPath = path.join(current, 'pnpm-workspace.yaml');
    const kind = kindOf(pnpmPath);
    // Above the project, pnpm takes this file's directory as the workspace
    // root whatever the file says, and writes the lockfile there.
    if (kind !== 'missing' && current !== directory && packageManager === 'pnpm') return pnpmPath;
    // In the project itself the file may hold only pnpm's settings, so it
    // counts when it lists packages. That also holds under npm.
    if (kind === 'file' && /^packages\s*:/m.test(readFileSync(pnpmPath, 'utf8'))) return pnpmPath;
    if (path.dirname(current) === current) return undefined;
  }
}

/**
 * Which package manager the project uses: the one whose lockfile is there,
 * else the one its `packageManager` field names, else the one the installer
 * was started with.
 *
 * @param {{ directory: string, manifest: Record<string, unknown> }} project
 * @param {string | undefined} invokedBy
 * @returns {'npm' | 'pnpm'}
 */
export function detectPackageManager({ directory, manifest }, invokedBy) {
  // Anything at the path counts, a dangling link included.
  const has = (file) => kindOf(path.join(directory, file)) !== 'missing';

  const unsupported = UNSUPPORTED_LOCKFILES.filter(has);
  if (unsupported.length > 0) {
    throw new InstallError(
      `This project has ${unsupported.join(' and ')}. Only npm and pnpm projects are supported yet.`,
    );
  }
  const found = Object.keys(LOCKFILES).filter((name) => has(LOCKFILES[name]));
  if (found.length > 1) {
    throw new InstallError(
      `This project has both ${LOCKFILES.npm} and ${LOCKFILES.pnpm}. Remove the one it does not use, then run this again.`,
    );
  }
  if (found.length === 1) return found[0];

  const declared =
    typeof manifest.packageManager === 'string' ? manifest.packageManager.split('@')[0] : undefined;
  for (const candidate of [declared, invokedBy]) {
    if (!candidate) continue;
    if (Object.hasOwn(LOCKFILES, candidate)) return candidate;
    throw new InstallError(
      `This project uses ${candidate}. Only npm and pnpm projects are supported yet.`,
    );
  }
  throw new InstallError(
    'Could not tell whether this project uses npm or pnpm. Start the installer with the package manager the project uses.',
  );
}

/**
 * Where a package is already declared in the project, in any dependency
 * field.
 *
 * @returns {{ field: string, spec: unknown } | undefined}
 */
export function declaredDependency(manifest, name) {
  for (const field of DEPENDENCY_FIELDS) {
    if (manifest[field] && Object.hasOwn(manifest[field], name)) {
      return { field, spec: manifest[field][name] };
    }
  }
  return undefined;
}

/**
 * The project's `package.json` text with dependencies added. Its indentation,
 * line endings and final newline are kept. Dependencies stay in alphabetical
 * order if they were, and are added at the end if they were not.
 *
 * @param {{ text: string, manifest: Record<string, any> }} project
 * @param {Record<string, string>} additions
 */
export function withDependencies({ text, manifest }, additions) {
  const before = Object.keys(manifest.dependencies ?? {});
  const compare = (a, b) => a.localeCompare(b, 'en');
  const wasSorted = before.every((key, index) => index === 0 || compare(before[index - 1], key) <= 0);

  let entries = Object.entries({ ...manifest.dependencies, ...additions });
  if (wasSorted) entries = entries.sort(([a], [b]) => compare(a, b));

  const indent = /^[ \t]+(?=")/m.exec(text)?.[0] ?? '  ';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const next = JSON.stringify({ ...manifest, dependencies: Object.fromEntries(entries) }, null, indent);
  return next.replaceAll('\n', eol) + (/\n$/.test(text) ? eol : '');
}
