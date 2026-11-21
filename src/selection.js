// What the person can choose to add, and what adding it would change, for the
// review. Nothing here reads the network or writes a file.
import { archiveName } from './download.js';
import { RETAINED_DIRECTORY } from './install.js';
import { DESIGN_SYSTEM, selectPackages } from './manifest.js';
import { LOCKFILES } from './project.js';

/** The Design System release this installer offers; the first proof names it explicitly. */
export const DESIGN_SYSTEM_VERSION = '0.1.0';

/** The products, in the order shown. Only the Design System can be chosen yet. */
export const PRODUCTS = [
  { id: 'builder', label: 'Builder', note: 'coming soon', disabled: true },
  { id: 'foundation', label: 'Foundation', note: 'coming soon', disabled: true },
  {
    id: DESIGN_SYSTEM.product,
    label: 'Design System',
    note: DESIGN_SYSTEM_VERSION,
    version: DESIGN_SYSTEM_VERSION,
  },
];

/** The Design System's renderers, in the order shown, as the engine names them. React is the default. */
export const RENDERERS = [
  { id: 'react', label: 'React', part: 'React' },
  { id: 'web-components', label: 'Web Components (plain HTML)', part: 'Web Components' },
];

// Control characters (C0, DEL, C1), line and paragraph separators,
// bidirectional formatting characters (U+061C, U+200E-F, U+202A-E,
// U+2066-9) and invisible ones (soft hyphen, zero-width characters, word
// joiner and invisible operators, byte order mark).
const CONTROL =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/gu;

/**
 * Text that came from the person's files or folders (a project's name, a
 * path), as plain terminal text: each control, formatting or invisible
 * character is shown as a \u escape, and a backslash as two, so an escape
 * always reads as one. None can move the cursor, clear or recolour the
 * screen, reorder the line or start another one, and nothing it holds can
 * change how the choices around it read.
 */
export const plain = (text) =>
  String(text)
    .replace(/\\/g, '\\\\')
    .replace(CONTROL, (character) => `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`);

/** "A", "A and B", "A, B and C". */
export const listed = (words) =>
  words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;

/**
 * What adding the Design System with these renderers would do to a project:
 * the packages (Core once, first, then each renderer), the archives kept in
 * the project, the files edited, and the install that follows. The archive
 * names are the ones the release manifest is expected to give; the manifest
 * itself is only read after approval.
 *
 * @param {{ packageManager: 'npm' | 'pnpm', renderers: string[], version: string }} options
 */
export function previewChanges({ packageManager, renderers, version }) {
  const packages = selectPackages(renderers);
  return {
    packages,
    archives: packages.map((name) => `${RETAINED_DIRECTORY}/${archiveName(name, version)}`),
    edited: ['package.json', LOCKFILES[packageManager]],
    command: `${packageManager} install`,
  };
}

/**
 * The review's lines, without the choices that follow it.
 *
 * @param {object} options
 * @param {string} options.label The project's name, or its folder's.
 * @param {string} options.directory
 * @param {'npm' | 'pnpm'} options.packageManager
 * @param {{ label: string, version: string }} options.product
 * @param {string[]} options.renderers
 */
export function reviewLines({ label, directory, packageManager, product, renderers }) {
  const { packages, archives, edited, command } = previewChanges({
    packageManager,
    renderers,
    version: product.version,
  });
  const parts = ['Core', ...RENDERERS.filter((r) => renderers.includes(r.id)).map((r) => r.part)];
  const column = (title, values) =>
    values.map((value, index) => `  ${(index === 0 ? title : '').padEnd(10)} ${value}`);
  return [
    'Review',
    ...column('Project', [`${plain(label)} (${packageManager})`, plain(directory)]),
    ...column('Adding', [`${product.label} ${product.version}: ${listed(parts)}`]),
    ...column(
      'Packages',
      packages.map((name) => `${name} ${product.version}`),
    ),
    ...column('Changes', [
      ...archives,
      '(the archive names the release is expected to give)',
      listed(edited),
    ]),
    ...column('Then', [
      command,
      "which can also run install scripts of the project's other dependencies.",
    ]),
  ];
}
