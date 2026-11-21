import { InstallError } from './errors.js';

/** The release manifest shape this installer reads. */
export const SCHEMA_VERSION = 1;

/**
 * The Design System's packages. Core is always installed; a project chooses
 * one renderer or both. A manifest naming any other package is refused.
 */
export const DESIGN_SYSTEM = {
  product: 'design-system',
  core: '@orbition/design-system-core',
  renderers: {
    react: '@orbition/design-system-react',
    'web-components': '@orbition/design-system-web-components',
  },
};

const NAMES = [DESIGN_SYSTEM.core, ...Object.values(DESIGN_SYSTEM.renderers)];

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
// A bare file name: nothing that could point outside the retained folder.
const FILE = /^[a-z0-9][a-z0-9._-]*\.tgz$/;
// The sha512 of the archive, as npm writes it.
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Checks a release manifest and returns its packages by name.
 *
 * A manifest is one release of one product:
 *
 *   {
 *     "schemaVersion": 1,
 *     "product": "design-system",
 *     "version": "0.1.0",
 *     "packages": [
 *       { "name", "version", "file", "integrity", "bytes" }
 *     ]
 *   }
 *
 * Every package carries the release's version. The checksums catch a damaged
 * or incomplete archive; they do not vouch for whoever sent the manifest.
 *
 * @returns {Map<string, { name: string, version: string, file: string, integrity: string, bytes: number }>}
 */
export function validateManifest(manifest) {
  if (!isObject(manifest)) {
    throw new InstallError('The release manifest is not an object.');
  }
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    throw new InstallError(
      `This installer reads release manifests of schema version ${SCHEMA_VERSION}, and this one is ${JSON.stringify(manifest.schemaVersion)}. Use a newer version of the installer.`,
    );
  }
  if (manifest.product !== DESIGN_SYSTEM.product) {
    throw new InstallError(
      `The release manifest is for ${JSON.stringify(manifest.product)}, not "${DESIGN_SYSTEM.product}".`,
    );
  }
  if (typeof manifest.version !== 'string' || !VERSION.test(manifest.version)) {
    throw new InstallError(
      `The release manifest's version, ${JSON.stringify(manifest.version)}, is not a version.`,
    );
  }
  if (!Array.isArray(manifest.packages) || manifest.packages.length === 0) {
    throw new InstallError('The release manifest lists no packages.');
  }

  const entries = new Map();
  const files = new Set();
  for (const entry of manifest.packages) {
    if (!isObject(entry) || !NAMES.includes(entry.name)) {
      throw new InstallError(
        `The release manifest lists ${JSON.stringify(entry?.name)}, which is not a Design System package.`,
      );
    }
    const { name, version, file, integrity, bytes } = entry;
    if (entries.has(name)) {
      throw new InstallError(`The release manifest lists ${name} more than once.`);
    }
    if (version !== manifest.version) {
      throw new InstallError(
        `The release manifest is for ${manifest.version}, but lists ${name} at ${JSON.stringify(version)}.`,
      );
    }
    if (typeof file !== 'string' || !FILE.test(file) || files.has(file)) {
      throw new InstallError(
        `The release manifest's file for ${name}, ${JSON.stringify(file)}, is not a usable archive name.`,
      );
    }
    if (typeof integrity !== 'string' || !INTEGRITY.test(integrity)) {
      throw new InstallError(`The release manifest has no sha512 checksum for ${name}.`);
    }
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
      throw new InstallError(`The release manifest has no size for ${name}.`);
    }
    files.add(file);
    entries.set(name, { name, version, file, integrity, bytes });
  }
  return entries;
}

/**
 * The package names for a choice of renderers: core first, then each renderer
 * once, in the order asked for.
 *
 * @param {string[]} renderers
 */
export function selectPackages(renderers) {
  const known = Object.keys(DESIGN_SYSTEM.renderers);
  if (!Array.isArray(renderers) || renderers.length === 0) {
    throw new InstallError(`Choose a renderer: ${known.join(' or ')}, or both.`);
  }
  for (const renderer of renderers) {
    if (!Object.hasOwn(DESIGN_SYSTEM.renderers, renderer)) {
      throw new InstallError(
        `${JSON.stringify(renderer)} is not a renderer. Choose ${known.join(' or ')}, or both.`,
      );
    }
  }
  return [
    DESIGN_SYSTEM.core,
    ...new Set(renderers.map((renderer) => DESIGN_SYSTEM.renderers[renderer])),
  ];
}

/** The archive name the service gives a package: its name without the scope sign, and the version. */
export const archiveName = (name, version) => `${name.replace('@', '').replace('/', '-')}-${version}.tgz`;

/** Every Design System package name, core first. */
export const packageNames = () => [...NAMES];
