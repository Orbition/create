#!/usr/bin/env node
// Rehearses the installer with real archives that are kept somewhere else.
//
// This file is for people working on this repository. It is not part of the
// published package, and the archives it reads never belong in this
// repository: keep them, and the project you try them in, outside it.
//
//   node scripts/rehearse.js --archives <folder> --project <directory> \
//     --renderer react [--renderer web-components] [--package-manager pnpm]
//
// <folder> holds the archives and a `release-manifest.json` that lists them:
// either a manifest in the installer's own shape, or a list of packages, each
// with `name`, `version`, `file`, `integrity` and `bytes`, all at one version.
//
// <directory> is an existing npm or pnpm project of its own. The package
// manager is only asked for when the project has no lockfile yet.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { InstallError } from '../src/errors.js';
import { install } from '../src/install.js';
import { DESIGN_SYSTEM, SCHEMA_VERSION } from '../src/manifest.js';

const { values } = parseArgs({
  options: {
    archives: { type: 'string' },
    project: { type: 'string' },
    renderer: { type: 'string', multiple: true },
    'package-manager': { type: 'string' },
  },
});
if (!values.archives || !values.project || !values.renderer) {
  console.error(
    'Usage: node scripts/rehearse.js --archives <folder> --project <directory> --renderer react|web-components [--renderer …] [--package-manager npm|pnpm]',
  );
  process.exit(2);
}

const folder = path.resolve(values.archives);
const listed = JSON.parse(readFileSync(path.join(folder, 'release-manifest.json'), 'utf8'));
const manifest =
  listed.schemaVersion === undefined
    ? {
        schemaVersion: SCHEMA_VERSION,
        product: DESIGN_SYSTEM.product,
        version: listed.packages?.[0]?.version,
        packages: listed.packages,
      }
    : listed;

try {
  const result = await install({
    project: values.project,
    source: { manifest, read: (file) => readFileSync(path.join(folder, file)) },
    renderers: values.renderer,
    invokedBy: values['package-manager'],
  });
  console.log(
    result.changed
      ? `Design System ${result.version}, with ${result.packageManager}:`
      : `Design System ${result.version} is already installed. Nothing was changed.`,
  );
  for (const { name, file, added } of result.packages) {
    console.log(`  ${added ? 'added  ' : 'present'}  ${name}  ${file}`);
  }
  for (const warning of result.warnings) console.log(`\nWarning: ${warning}`);
  console.log(
    `\n${result.lockfile} is up to date. Run \`${result.nextCommand}\`, and commit the archives with the project.`,
  );
} catch (error) {
  if (!(error instanceof InstallError)) throw error;
  console.error(error.message);
  process.exit(1);
}
