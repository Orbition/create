import { spawnSync } from 'node:child_process';
import {
  closeSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { readPackedManifest, verifyArchive } from './archive.js';
import { InstallError } from './errors.js';
import { archiveName, packageNames, selectPackages, validateManifest } from './manifest.js';
import {
  declaredDependency,
  detectPackageManager,
  kindOf,
  LOCKFILES,
  readProject,
  refuseWorkspace,
  requireManifestFile,
  withDependencies,
} from './project.js';

/**
 * Where the archives are kept in the project, relative to its root. They are
 * the project's own copies: commit them, and the project installs and builds
 * from them with no access to Orbition.
 */
export const RETAINED_DIRECTORY = 'vendor/orbition';

/** Held in the project's root while an installer works in it. */
export const INSTALL_LOCK = '.orbition-install.lock';

// Updates the lockfile only. Nothing is installed into node_modules and no
// package's install script runs, so a failure can be undone exactly.
const UPDATE_LOCKFILE = {
  npm: ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
  pnpm: ['install', '--lockfile-only', '--ignore-scripts', '--no-frozen-lockfile'],
};

// The only way this installer declares a package: a file in the retained
// folder, by relative path.
const RETAINED_DEPENDENCY = new RegExp(
  `^file:${RETAINED_DIRECTORY}/([a-z0-9][a-z0-9._-]*\\.tgz)$`,
);

/**
 * Adds the Design System to an existing npm or pnpm project: core, and the
 * renderers asked for.
 *
 * Each archive is checked against the release manifest, kept in the project
 * under `vendor/orbition`, and declared in `package.json` as a dependency on
 * that file by relative path. The project's lockfile is then updated by its
 * own package manager.
 *
 * Running it again changes nothing, unless the lockfile no longer agrees with
 * the project: the package manager runs every time and brings a stale
 * lockfile up to date. Running it with the other renderer adds
 * that renderer beside what is there; the manifest then only needs core and
 * that renderer. It never replaces a version: a project that already has a
 * different one is refused.
 *
 * Everything is checked before anything is written, one installer works in a
 * project at a time, and links are never followed. If the lockfile update
 * fails, the project is put back as it was.
 *
 * @param {object} options
 * @param {string} options.project The project's directory.
 * @param {{ manifest: unknown, read: (file: string) => Uint8Array | Promise<Uint8Array> }} options.source
 *   The release manifest, and a way to read each archive it names.
 * @param {string[]} options.renderers `react`, `web-components`, or both.
 * @param {string} [options.invokedBy] The package manager the installer was
 *   started with, used when the project does not say which it uses.
 * @param {'npm' | 'pnpm'} [options.packageManager] The package manager the
 *   person was shown. If the project now says another, nothing is fetched or
 *   written.
 * @param {(result: object) => Promise<void>} [options.whileLocked] Runs after
 *   a successful install, while this installer still holds the project (to
 *   run the project's own install, say), so no other installer can start in
 *   between. A failure there is its own: the project stays as the install
 *   left it, and the lock is let go either way.
 */
export async function install({ project, source, renderers, invokedBy, packageManager, whileLocked }) {
  const names = selectPackages(renderers);
  const entries = validateManifest(source.manifest);
  const { version } = source.manifest;
  for (const name of names) {
    if (!entries.has(name)) {
      throw new InstallError(`The release manifest for ${version} does not include ${name}.`);
    }
  }

  const directory = path.resolve(project);
  requireManifestFile(directory);
  const unlock = lock(directory);
  try {
    const result = await installLocked({
      directory,
      source,
      entries,
      names,
      version,
      invokedBy,
      expected: packageManager,
    });
    await whileLocked?.(result);
    return result;
  } finally {
    unlock();
  }
}

/**
 * Takes the project for this installer alone, before anything in it is read,
 * so two installers cannot work from each other's stale view or undo each
 * other's files. Returns the release.
 */
function lock(directory) {
  const file = path.join(directory, INSTALL_LOCK);
  try {
    // Fails if anything is at the path, a link included, and follows nothing.
    closeSync(openSync(file, 'wx'));
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw new InstallError(`Could not write to ${directory}: ${error.message}`);
    }
    throw new InstallError(
      `Another installer is working in this project, or one stopped before it finished: ${INSTALL_LOCK} is there. If none is running, delete that file and run this again.`,
    );
  }
  return () => rmSync(file, { force: true });
}

/**
 * What every run checks of the project before anything else, and the command
 * checks when the folder is chosen: a `package.json` that is a real file and
 * valid JSON, an npm or pnpm project that is not part of a workspace, and a
 * lockfile and retained directory that are not links. Reads only. The install
 * lock is not among these: `install` takes it, and refuses then, if another
 * installer holds it.
 *
 * @param {string} directory
 * @param {string | undefined} invokedBy
 */
export function checkProject(directory, invokedBy) {
  const project = readProject(directory);
  const packageManager = detectPackageManager(project, invokedBy);
  refuseWorkspace(directory, packageManager);
  const lockfile = LOCKFILES[packageManager];
  const lockfilePath = path.join(directory, lockfile);

  // Only real files and directories are read or written. A link in any of
  // these places is refused, wherever it points.
  if (!['missing', 'file'].includes(kindOf(lockfilePath))) {
    throw new InstallError(`${lockfile} is a link or not a regular file, so nothing was changed.`);
  }
  const segments = RETAINED_DIRECTORY.split('/');
  for (let depth = 1; depth <= segments.length; depth += 1) {
    if (!['missing', 'directory'].includes(kindOf(path.join(directory, ...segments.slice(0, depth))))) {
      throw new InstallError(
        `${segments.slice(0, depth).join('/')} is a link or not a directory, so nothing was changed.`,
      );
    }
  }
  return { project, packageManager, lockfile, lockfilePath };
}

/**
 * What can be known about a project before a release is downloaded for it,
 * without the release, as `install` would judge it: everything
 * `checkProject` checks, no install lock in it, and every Design System
 * package it already declares declared as this installer declares this
 * release's (in `dependencies`, as the retained archive of this version).
 * A declared package that is not asked for now must have its archive there;
 * one asked for is downloaded again if it is missing, as `install` does.
 * Reads only. `install` checks all of it again, and the archives themselves,
 * before it writes.
 *
 * @param {string} directory
 * @param {string | undefined} invokedBy
 * @param {string} version
 * @param {string[]} renderers The renderers asked for now.
 */
export function checkBeforeInstall(directory, invokedBy, version, renderers) {
  const asked = selectPackages(renderers);
  const checked = checkProject(directory, invokedBy);
  if (kindOf(path.join(directory, INSTALL_LOCK)) !== 'missing') {
    throw new InstallError(
      `Another installer is working in this project, or one stopped before it finished: ${INSTALL_LOCK} is there. If none is running, delete that file and run this again.`,
    );
  }
  for (const name of packageNames()) {
    const declared = declaredDependency(checked.project.manifest, name);
    if (!declared) continue;
    const expected = archiveName(name, version);
    const file =
      declared.field === 'dependencies' && typeof declared.spec === 'string'
        ? RETAINED_DEPENDENCY.exec(declared.spec)?.[1]
        : undefined;
    if (file !== expected) {
      throw new InstallError(
        `This project already declares ${name} in ${declared.field} as ${JSON.stringify(declared.spec)}. This release is ${version}, and replacing an installed version is not supported yet.`,
      );
    }
    if (!asked.includes(name) && kindOf(path.join(directory, ...RETAINED_DIRECTORY.split('/'), file)) !== 'file') {
      throw new InstallError(
        `This project declares ${name}, but ${RETAINED_DIRECTORY}/${file} is not in it. Restore that file, then run this again.`,
      );
    }
  }
  return checked;
}

async function installLocked({ directory, source, entries, names, version, invokedBy, expected }) {
  const { project, packageManager, lockfile, lockfilePath } = checkProject(directory, invokedBy);
  if (expected !== undefined && packageManager !== expected) {
    throw new InstallError(
      `This project now uses ${packageManager}, not ${expected} as it did when it was reviewed. Nothing was changed: run the installer again to review it.`,
    );
  }
  const segments = RETAINED_DIRECTORY.split('/');
  const retainedPath = (file) => path.join(directory, ...segments, file);

  // A Design System package the project already declares must be this
  // release's, declared the way this installer declares it.
  for (const name of packageNames()) {
    const declared = declaredDependency(project.manifest, name);
    if (!declared) continue;
    const entry = entries.get(name);
    const file =
      declared.field === 'dependencies' && typeof declared.spec === 'string'
        ? RETAINED_DEPENDENCY.exec(declared.spec)?.[1]
        : undefined;
    if (!file || (entry && file !== entry.file)) {
      throw new InstallError(
        `This project already declares ${name} in ${declared.field} as ${JSON.stringify(declared.spec)}. This release is ${version}, and replacing an installed version is not supported yet.`,
      );
    }
    // One asked for now is compared with the release's own archive below.
    if (names.includes(name)) continue;

    // One kept by an earlier run is checked as it stands in the project. The
    // manifest need not list it: it may cover only what was asked for.
    const relative = `${RETAINED_DIRECTORY}/${file}`;
    if (kindOf(retainedPath(file)) !== 'file') {
      throw new InstallError(
        `This project declares ${name}, but ${relative} is not in it. Restore that file, then run this again.`,
      );
    }
    const bytes = readFileSync(retainedPath(file));
    if (entry) {
      verifyArchive(entry, bytes);
    } else {
      const packed = readPackedManifest(relative, bytes);
      if (packed.name !== name || packed.version !== version) {
        throw new InstallError(
          `${relative} in this project is ${packed.name}@${packed.version}. This release is ${version}, and replacing an installed version is not supported yet.`,
        );
      }
    }
  }

  const packages = [];
  for (const name of names) {
    const entry = entries.get(name);
    let bytes;
    try {
      bytes = Buffer.from(await source.read(entry.file));
    } catch (error) {
      // A source's own refusal already says what happened and what to do.
      if (error instanceof InstallError) throw error;
      throw new InstallError(`${entry.file} could not be read: ${error.message}`);
    }
    verifyArchive(entry, bytes);

    const relative = `${RETAINED_DIRECTORY}/${entry.file}`;
    const destination = retainedPath(entry.file);
    const kind = kindOf(destination);
    if (kind !== 'missing' && !(kind === 'file' && readFileSync(destination).equals(bytes))) {
      throw new InstallError(
        `${relative} is already in this project and differs from the release's archive. It was not replaced.`,
      );
    }
    packages.push({
      name,
      file: relative,
      destination,
      bytes,
      retained: kind === 'file',
      declared: declaredDependency(project.manifest, name) !== undefined,
    });
  }

  // Every archive this run needs is in memory now. A source that holds a
  // credential lets it go here, before anything is written or started.
  source.close?.();

  // The downloads take time: the project must still be as it was read, and
  // use the same package manager, or nothing is written.
  const now = checkProject(directory, invokedBy);
  if (now.packageManager !== packageManager || now.project.text !== project.text) {
    throw new InstallError(
      now.packageManager !== packageManager
        ? `This project now uses ${now.packageManager}, not ${packageManager}: it changed while the release was downloaded. Nothing was changed: run the installer again to review it.`
        : 'package.json changed while the release was downloaded. Nothing was changed: run the installer again.',
    );
  }

  // The two files this run may replace, as they are now: what a failure puts
  // back, permissions included.
  const manifestBefore = { contents: project.text, mode: modeOf(project.manifestPath) };
  const lockfileBefore =
    kindOf(lockfilePath) === 'file'
      ? { contents: readFileSync(lockfilePath), mode: modeOf(lockfilePath) }
      : undefined;
  const toRetain = packages.filter((entry) => !entry.retained);
  const toDeclare = packages.filter((entry) => !entry.declared);

  const result = {
    changed: true,
    version,
    packageManager,
    lockfile,
    packages: packages.map(({ name, file, retained, declared }) => ({
      name,
      version,
      file,
      added: !(retained && declared),
    })),
    warnings: [],
    nextCommand: `${packageManager} install`,
  };

  // From here the project is written to. `created` lists what this run made,
  // in the order it was made, so a failure removes exactly that.
  //
  // The package manager runs every time, also when there is nothing to add:
  // only it can say whether the lockfile still agrees with the project, and
  // it brings a stale one up to date.
  const created = [];
  let manifestWritten = false;
  let interrupted = false;
  // With a listener, Ctrl-C does not end this process on the spot: the
  // package manager stops, and the project is put back before leaving.
  const onSignal = () => {
    interrupted = true;
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    if (toRetain.length > 0) {
      for (let depth = 1; depth <= segments.length; depth += 1) {
        const made = path.join(directory, ...segments.slice(0, depth));
        if (kindOf(made) === 'missing') {
          mkdirSync(made);
          created.push({ directory: made });
        }
      }
    }
    for (const { destination, bytes } of toRetain) {
      // Creates the file or fails: it never writes over or through anything.
      const descriptor = openSync(destination, 'wx');
      created.push({ file: destination });
      try {
        writeFileSync(descriptor, bytes);
      } finally {
        closeSync(descriptor);
      }
    }
    if (toDeclare.length > 0) {
      const additions = Object.fromEntries(toDeclare.map(({ name, file }) => [name, `file:${file}`]));
      replaceFile(project.manifestPath, withDependencies(project, additions), manifestBefore.mode);
      manifestWritten = true;
    }

    const update = spawnSync(packageManager, UPDATE_LOCKFILE[packageManager], {
      cwd: directory,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    // Ctrl+C reaches the package manager in the same terminal, and this
    // process's handler only after it ended: an end by signal is one too.
    if (interrupted || update.signal) {
      throw Object.assign(new InstallError('Interrupted.'), { interrupted: true });
    }
    if (update.error || update.status !== 0) {
      const output = update.error?.message ?? `${update.stdout}${update.stderr}`.trim();
      throw new InstallError(`${packageManager} could not update ${lockfile}:\n\n${output}`);
    }
    // A last guard, not the judge of the lockfile: the package manager wrote
    // one here, and it names every archive.
    const lockfileAfter = kindOf(lockfilePath) === 'file' ? readFileSync(lockfilePath) : undefined;
    const unrecorded = packages.filter(({ file }) => !lockfileAfter?.includes(`file:${file}`));
    if (unrecorded.length > 0) {
      throw new InstallError(
        `${packageManager} ran, but ${lockfile} does not record ${unrecorded.map(({ file }) => file).join(' or ')}.`,
      );
    }
    result.changed =
      toRetain.length > 0 ||
      toDeclare.length > 0 ||
      !lockfileBefore?.contents.equals(lockfileAfter);
  } catch (error) {
    try {
      if (manifestWritten) {
        replaceFile(project.manifestPath, manifestBefore.contents, manifestBefore.mode);
      }
      if (lockfileBefore) replaceFile(lockfilePath, lockfileBefore.contents, lockfileBefore.mode);
      else rmSync(lockfilePath, { force: true });
      for (const { file, directory: made } of created.reverse()) {
        if (file) rmSync(file, { force: true });
        else rmdirSync(made);
      }
    } catch (undoError) {
      // `projectState` says what became of the project: `unknown` here.
      throw Object.assign(
        new InstallError(
          `${error.message}\n\nThe project could then not be put back as it was (${undoError.message}). Check package.json, ${lockfile} and ${RETAINED_DIRECTORY} before going on.`,
        ),
        { projectState: 'unknown' },
      );
    }
    // Whatever the failure, the project was put back: `projectState` says so.
    if (error instanceof InstallError) error.message += '\n\nThe project was put back as it was.';
    if (error !== null && typeof error === 'object') error.projectState = 'restored';
    throw error;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }

  const ignored = packages.filter(({ file }) => isIgnoredByGit(directory, file));
  if (ignored.length > 0) {
    result.warnings.push(
      `Git ignores ${ignored.map(({ file }) => file).join(' and ')}. Commit the archives, or the project cannot be installed from another checkout: allow them in .gitignore.`,
    );
  }
  return result;
}

/** A file's permission bits. */
const modeOf = (file) => lstatSync(file).mode & 0o7777;

/**
 * Replaces a file in one step, so it is never left half written. The new
 * contents go to a file of this run's own beside it, created and never
 * reused, which is given the permissions asked for and then takes the old
 * file's place.
 */
function replaceFile(file, contents, mode) {
  const temporary = `${file}.orbition-${process.pid}.tmp`;
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(descriptor, contents);
      fchmodSync(descriptor, mode);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** Whether Git would leave this path out of a commit. False outside a repository. */
function isIgnoredByGit(directory, file) {
  return spawnSync('git', ['check-ignore', '--quiet', file], { cwd: directory }).status === 0;
}
