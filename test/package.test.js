import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { run } from './helpers.js';

const root = path.resolve(import.meta.dirname, '..');

test('the package stays private for now', () => {
  assert.equal(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).private, true);
});

test('the package would hold the installer and nothing meant for this repository only', () => {
  const [{ files }] = JSON.parse(run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], root));
  assert.deepEqual(files.map((file) => file.path).sort(), [
    'README.md',
    'package.json',
    'src/archive.js',
    'src/cli.js',
    'src/download.js',
    'src/errors.js',
    'src/install.js',
    'src/manifest.js',
    'src/menu.js',
    'src/project.js',
    'src/selection.js',
  ]);
});

test('the package’s one command is the installer, and it can be run directly', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.bin, { create: 'src/cli.js' });
  assert.match(readFileSync(path.join(root, 'src/cli.js'), 'utf8'), /^#!\/usr\/bin\/env node\n/);
  assert.ok(statSync(path.join(root, 'src/cli.js')).mode & 0o100);
});
