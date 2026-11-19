import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { DESIGN_SYSTEM } from '../src/manifest.js';

// Everything the tests make lives here, outside the repository.
const sandbox = mkdtempSync(path.join(tmpdir(), 'orbition-create-test-'));

// The package managers the tests start, and the ones the installer starts,
// use their own empty cache and store, and never the network: every package
// in these tests is a local archive.
process.env.npm_config_cache = path.join(sandbox, 'npm-cache');
process.env.npm_config_store_dir = path.join(sandbox, 'pnpm-store');
process.env.npm_config_offline = 'true';
process.env.npm_config_update_notifier = 'false';

let count = 0;
export function temporaryDirectory(label) {
  count += 1;
  const directory = path.join(sandbox, `${count}-${label}`);
  mkdirSync(directory, { recursive: true });
  return directory;
}

/** A self-signed certificate for 127.0.0.1, good for these tests only, and where its PEM file is. */
export function certificate() {
  const directory = temporaryDirectory('tls');
  const key = path.join(directory, 'key.pem');
  const cert = path.join(directory, 'cert.pem');
  run('openssl', [
    ...['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2'],
    ...['-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'],
    ...['-keyout', key, '-out', cert],
  ]);
  return { key: readFileSync(key), cert: readFileSync(cert), certPath: cert };
}

export function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Builds a release of synthetic packages: the real names, with a marker for
 * contents. Each renderer needs core beside it, as the real ones do, and
 * imports it, so loading a renderer proves core was installed too.
 *
 * @returns {{ directory: string, manifest: object, read: (file: string) => Buffer }}
 */
export function synthesizeRelease(version) {
  const directory = temporaryDirectory(`release-${version}`);
  const packages = [];
  for (const name of [DESIGN_SYSTEM.core, ...Object.values(DESIGN_SYSTEM.renderers)]) {
    const isCore = name === DESIGN_SYSTEM.core;
    const source = temporaryDirectory('package-source');
    writeFileSync(
      path.join(source, 'package.json'),
      JSON.stringify({
        name,
        version,
        description: 'Synthetic package for tests. Not the Design System.',
        type: 'module',
        exports: './index.js',
        ...(isCore ? {} : { peerDependencies: { [DESIGN_SYSTEM.core]: `^${version}` } }),
      }),
    );
    writeFileSync(
      path.join(source, 'index.js'),
      isCore
        ? `export const core = ${JSON.stringify(`${name}@${version}`)};\n`
        : `export { core } from ${JSON.stringify(DESIGN_SYSTEM.core)};\nexport const renderer = ${JSON.stringify(`${name}@${version}`)};\n`,
    );
    run('npm', ['pack', '--ignore-scripts', '--pack-destination', directory], source);
    const file = `${name.replace('@', '').replace('/', '-')}-${version}.tgz`;
    const bytes = readFileSync(path.join(directory, file));
    packages.push({ name, version, file, integrity: integrityOf(bytes), bytes: bytes.length });
  }
  return {
    directory,
    manifest: { schemaVersion: 1, product: 'design-system', version, packages },
    read: (file) => readFileSync(path.join(directory, file)),
  };
}

export const integrityOf = (bytes) =>
  `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

/** A copy of a release's source whose manifest can be changed freely. */
export function alter(release, change) {
  const manifest = structuredClone(release.manifest);
  const source = { manifest, read: release.read };
  return change(source) ?? source;
}

/** The release with only some of its packages in the manifest. */
export function subset(release, which) {
  return alter(release, ({ manifest }) => {
    const kept = which.map((item) => entryFor(release.manifest, item).name);
    manifest.packages = manifest.packages.filter(({ name }) => kept.includes(name));
  });
}

/** The release with one package's archive replaced, and the manifest agreeing with it. */
export function withArchive(release, which, bytes) {
  return alter(release, (source) => {
    const entry = entryFor(source.manifest, which);
    entry.bytes = bytes.length;
    entry.integrity = integrityOf(bytes);
    return { ...source, read: (file) => (file === entry.file ? bytes : release.read(file)) };
  });
}

/** A gzipped tar holding one header, with its size field written as given. */
export function tarWithSize(name, size) {
  const header = Buffer.alloc(512);
  header.write(name, 0);
  header.write(size, 124);
  header.write('0', 156);
  return gzipSync(Buffer.concat([header, Buffer.alloc(1024)]));
}

/** The manifest entry for a renderer or for `core`. */
export function entryFor(manifest, which) {
  const name = which === 'core' ? DESIGN_SYSTEM.core : DESIGN_SYSTEM.renderers[which];
  return manifest.packages.find((entry) => entry.name === name);
}

/**
 * An existing project of its own, with fields and formatting the installer
 * has no business changing.
 */
export function makeProject(manifest = {}) {
  const directory = temporaryDirectory('project');
  writeFileSync(
    path.join(directory, 'package.json'),
    `${JSON.stringify({ name: 'consumer', version: '1.2.3', private: true, scripts: { build: 'true' }, ...manifest }, null, 4)}\n`,
  );
  writeFileSync(path.join(directory, 'index.js'), '// The consumer’s own work.\n');
  return directory;
}

/** Everything under a directory, by relative path: each file's contents, each link's target. */
export function snapshot(directory) {
  const files = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const relative = path.relative(directory, full);
      if (entry.isSymbolicLink()) files[relative] = `link to ${readlinkSync(full)}`;
      else if (entry.isDirectory()) walk(full);
      else files[relative] = readFileSync(full).toString('base64');
    }
  };
  walk(directory);
  return files;
}

/**
 * Installs a project the way another checkout would: its manifest, lockfile
 * and retained archives copied elsewhere, then a strict install from the
 * lockfile. Returns what importing each named package gives.
 */
export function rebuildElsewhere(project, packageManager, names) {
  const elsewhere = temporaryDirectory('rebuild');
  for (const item of ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'vendor']) {
    if (existsSync(path.join(project, item))) {
      cpSync(path.join(project, item), path.join(elsewhere, item), { recursive: true });
    }
  }
  if (packageManager === 'npm') run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], elsewhere);
  else run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], elsewhere);

  const script = `const out = {}; for (const name of ${JSON.stringify(names)}) out[name] = { ...(await import(name)) }; console.log(JSON.stringify(out));`;
  return {
    directory: elsewhere,
    modules: JSON.parse(run('node', ['--input-type=module', '--eval', script], elsewhere)),
  };
}
