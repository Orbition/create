// What can be chosen, and what the review says adding it would change.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DESIGN_SYSTEM } from '../src/manifest.js';
import { listed, plain, previewChanges, PRODUCTS, RENDERERS, reviewLines } from '../src/selection.js';

test('only the Design System 0.1.0 can be chosen; Builder and Foundation are coming soon', () => {
  assert.deepEqual(
    PRODUCTS.map(({ label, note, disabled = false }) => [label, note, disabled]),
    [
      ['Builder', 'coming soon', true],
      ['Foundation', 'coming soon', true],
      ['Design System', '0.1.0', false],
    ],
  );
  // The renderers are the engine's own.
  assert.deepEqual(
    RENDERERS.map((renderer) => renderer.id),
    Object.keys(DESIGN_SYSTEM.renderers),
  );
});

test('Core once and first, then each renderer chosen; archives, edited files and the install command', () => {
  assert.deepEqual(previewChanges({ packageManager: 'pnpm', renderers: ['web-components', 'react', 'react'], version: '0.1.0' }), {
    packages: [
      '@orbition/design-system-core',
      '@orbition/design-system-web-components',
      '@orbition/design-system-react',
    ],
    archives: [
      'vendor/orbition/orbition-design-system-core-0.1.0.tgz',
      'vendor/orbition/orbition-design-system-web-components-0.1.0.tgz',
      'vendor/orbition/orbition-design-system-react-0.1.0.tgz',
    ],
    edited: ['package.json', 'pnpm-lock.yaml'],
    command: 'pnpm install',
  });
  const npm = previewChanges({ packageManager: 'npm', renderers: ['react'], version: '0.1.0' });
  assert.deepEqual([npm.edited, npm.command], [['package.json', 'package-lock.json'], 'npm install']);
  assert.throws(() => previewChanges({ packageManager: 'npm', renderers: [], version: '0.1.0' }), /Choose a renderer/);
});

test('the review lists the parts in the order shown, whatever order they were chosen in', () => {
  const lines = reviewLines({
    label: 'my-app',
    directory: '/work/my-app',
    packageManager: 'npm',
    product: PRODUCTS[2],
    renderers: ['web-components', 'react'],
  });
  assert.ok(lines.includes('  Adding     Design System 0.1.0: Core, React and Web Components'));
  assert.ok(lines.includes('  Project    my-app (npm)'));
  assert.ok(lines.includes('             /work/my-app'));
  assert.deepEqual([listed([]), listed(['A']), listed(['A', 'B']), listed(['A', 'B', 'C'])], ['', 'A', 'A and B', 'A, B and C']);
});

test('text from the project is shown plain: control, separator and direction characters are escaped', () => {
  assert.equal(plain('my-app'), 'my-app');
  assert.equal(plain('é ❯ /x y'), 'é ❯ /x y');
  assert.equal(
    plain('a\x1b[2J\r\n\t\x7f\x9b\u2028\u202e\u2066z'),
    'a\\u001b[2J\\u000d\\u000a\\u0009\\u007f\\u009b\\u2028\\u202e\\u2066z',
  );
  // Invisible characters and the Arabic letter mark as well.
  assert.equal(
    plain('\u00ad\u061c\u200b\u200d\u2060\u2064\ufeff'),
    '\\u00ad\\u061c\\u200b\\u200d\\u2060\\u2064\\ufeff',
  );
  // A backslash is doubled, so text that looks like an escape cannot pass for one.
  assert.equal(plain('a\\u001b'), 'a\\\\u001b');
  assert.notEqual(plain('\\u001b'), plain('\x1b'));
  const lines = reviewLines({
    label: 'x\x1b]0;title\x07',
    directory: '/a\nb',
    packageManager: 'pnpm',
    product: PRODUCTS[2],
    renderers: ['react'],
  });
  for (const line of lines) assert.doesNotMatch(line, /[\u0000-\u001f\u007f-\u009f]/);
  assert.ok(lines.includes('  Project    x\\u001b]0;title\\u0007 (pnpm)'));
  assert.ok(lines.includes('             /a\\u000ab'));
});
