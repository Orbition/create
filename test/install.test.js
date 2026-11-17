import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { before, describe, test } from 'node:test';

import { install, INSTALL_LOCK, RETAINED_DIRECTORY } from '../src/install.js';
import { DESIGN_SYSTEM } from '../src/manifest.js';
import {
  alter,
  entryFor,
  makeProject,
  rebuildElsewhere,
  run,
  snapshot,
  subset,
  synthesizeRelease,
  tarWithSize,
  temporaryDirectory,
  withArchive,
} from './helpers.js';

const CORE = DESIGN_SYSTEM.core;
const REACT = DESIGN_SYSTEM.renderers.react;
const ELEMENTS = DESIGN_SYSTEM.renderers['web-components'];
const LOCKFILES = { npm: 'package-lock.json', pnpm: 'pnpm-lock.yaml' };

let release;
let newer;
before(() => {
  release = synthesizeRelease('1.0.0');
  newer = synthesizeRelease('1.1.0');
});

const retained = (source, which) => `${RETAINED_DIRECTORY}/${entryFor(source.manifest, which).file}`;
const dependencyOn = (source, which) => `file:${retained(source, which)}`;
const readManifest = (project) =>
  JSON.parse(readFileSync(path.join(project, 'package.json'), 'utf8'));
const modeOf = (file) => statSync(file).mode & 0o777;

/** Asserts the installer refuses, and that the directory is exactly as it was. */
async function refuses(project, options, message, unchanged = project) {
  const before = snapshot(unchanged);
  await assert.rejects(install({ project, invokedBy: 'npm', ...options }), {
    name: 'InstallError',
    message,
  });
  assert.deepEqual(snapshot(unchanged), before, 'the project was changed');
}

for (const packageManager of ['npm', 'pnpm']) {
  describe(`in a ${packageManager} project`, () => {
    const lockfile = LOCKFILES[packageManager];

    test('installs core and React only, and the project rebuilds from another checkout', async () => {
      const project = makeProject();
      const result = await install({
        project,
        source: release,
        renderers: ['react'],
        invokedBy: packageManager,
      });

      assert.equal(result.changed, true);
      assert.equal(result.packageManager, packageManager);
      assert.equal(result.nextCommand, `${packageManager} install`);
      assert.deepEqual(result.warnings, []);
      assert.deepEqual(
        result.packages.map(({ name, added }) => [name, added]),
        [
          [CORE, true],
          [REACT, true],
        ],
      );

      // The consumer's manifest keeps its fields and its four-space indent.
      const text = readFileSync(path.join(project, 'package.json'), 'utf8');
      assert.match(text, /^\{\n {4}"name": "consumer",/);
      assert.ok(text.endsWith('}\n'));
      assert.deepEqual(readManifest(project), {
        name: 'consumer',
        version: '1.2.3',
        private: true,
        scripts: { build: 'true' },
        dependencies: {
          [CORE]: dependencyOn(release, 'core'),
          [REACT]: dependencyOn(release, 'react'),
        },
      });

      // The archives kept are the release's, byte for byte. Nothing else is
      // new but the lockfile: no other archive, no node_modules, no lock left.
      for (const which of ['core', 'react']) {
        assert.deepEqual(
          readFileSync(path.join(project, retained(release, which))),
          release.read(entryFor(release.manifest, which).file),
        );
      }
      assert.deepEqual(
        Object.keys(snapshot(project)).sort(),
        ['index.js', lockfile, 'package.json', retained(release, 'core'), retained(release, 'react')].sort(),
      );

      const rebuilt = rebuildElsewhere(project, packageManager, [REACT]);
      assert.deepEqual(rebuilt.modules[REACT], {
        core: `${CORE}@1.0.0`,
        renderer: `${REACT}@1.0.0`,
      });
      assert.equal(
        existsSync(path.join(rebuilt.directory, 'node_modules', ...ELEMENTS.split('/'))),
        false,
      );
    });

    test('installs core and Web Components only', async () => {
      const project = makeProject();
      await install({
        project,
        source: release,
        renderers: ['web-components'],
        invokedBy: packageManager,
      });

      assert.deepEqual(readManifest(project).dependencies, {
        [CORE]: dependencyOn(release, 'core'),
        [ELEMENTS]: dependencyOn(release, 'web-components'),
      });
      const rebuilt = rebuildElsewhere(project, packageManager, [ELEMENTS]);
      assert.equal(rebuilt.modules[ELEMENTS].renderer, `${ELEMENTS}@1.0.0`);
      assert.equal(
        existsSync(path.join(rebuilt.directory, 'node_modules', ...REACT.split('/'))),
        false,
      );
    });

    test('installs both renderers at once', async () => {
      const project = makeProject();
      await install({
        project,
        source: release,
        renderers: ['react', 'web-components'],
        invokedBy: packageManager,
      });
      const rebuilt = rebuildElsewhere(project, packageManager, [REACT, ELEMENTS]);
      assert.deepEqual(Object.keys(rebuilt.modules), [REACT, ELEMENTS]);
    });

    test('changes nothing when run again', async () => {
      const project = makeProject();
      const options = { project, source: release, renderers: ['react'], invokedBy: packageManager };
      await install(options);
      const installed = snapshot(project);

      const again = await install(options);
      assert.equal(again.changed, false);
      assert.deepEqual(
        again.packages.map(({ added }) => added),
        [false, false],
      );
      assert.deepEqual(snapshot(project), installed);
    });

    test('adds the other renderer from a manifest of core and that renderer alone', async () => {
      const project = makeProject();
      await install({
        project,
        source: subset(release, ['core', 'react']),
        renderers: ['react'],
        invokedBy: packageManager,
      });
      const result = await install({
        project,
        source: subset(release, ['core', 'web-components']),
        renderers: ['web-components'],
        invokedBy: packageManager,
      });

      assert.deepEqual(
        result.packages.map(({ name, added }) => [name, added]),
        [
          [CORE, false],
          [ELEMENTS, true],
        ],
      );
      assert.deepEqual(readManifest(project).dependencies, {
        [CORE]: dependencyOn(release, 'core'),
        [REACT]: dependencyOn(release, 'react'),
        [ELEMENTS]: dependencyOn(release, 'web-components'),
      });
      const rebuilt = rebuildElsewhere(project, packageManager, [REACT, ELEMENTS]);
      assert.equal(rebuilt.modules[REACT].renderer, `${REACT}@1.0.0`);
      assert.equal(rebuilt.modules[ELEMENTS].core, `${CORE}@1.0.0`);
    });

    test('repairs a lockfile that is there but does not record the archives', async () => {
      const project = makeProject();
      await install({ project, source: release, renderers: ['react'], invokedBy: packageManager });
      const reactOnly = readFileSync(path.join(project, lockfile));
      const options = {
        project,
        source: release,
        renderers: ['web-components'],
        invokedBy: packageManager,
      };
      await install(options);
      const complete = snapshot(project);

      // The lockfile from before Web Components was added.
      writeFileSync(path.join(project, lockfile), reactOnly);
      const result = await install(options);

      assert.equal(result.changed, true);
      assert.deepEqual(
        result.packages.map(({ added }) => added),
        [false, false],
      );
      assert.deepEqual(snapshot(project), complete);
    });

    test('puts a new project back when the lockfile cannot be updated', async () => {
      // A dependency of the consumer's own that no package manager can resolve.
      const project = makeProject({ dependencies: { broken: 'file:./not-there.tgz' } });
      await refuses(
        project,
        { source: release, renderers: ['react'], invokedBy: packageManager },
        new RegExp(
          `^${packageManager} could not update ${lockfile.replace('.', '\\.')}[^]*The project was put back as it was\\.$`,
        ),
      );
    });

    test('puts an installed project back when adding a renderer fails', async () => {
      const project = makeProject();
      await install({ project, source: release, renderers: ['react'], invokedBy: packageManager });
      const manifest = readManifest(project);
      manifest.dependencies.broken = 'file:./not-there.tgz';
      writeFileSync(path.join(project, 'package.json'), JSON.stringify(manifest, null, 2));

      await refuses(
        project,
        { source: release, renderers: ['web-components'], invokedBy: packageManager },
        /The project was put back as it was\.$/,
      );
    });
  });
}

test('brings a pnpm lockfile whose own entry for a renderer went stale up to date', async () => {
  const project = makeProject();
  const options = { project, source: release, renderers: ['react'], invokedBy: 'pnpm' };
  await install(options);
  const installed = snapshot(project);

  // Only what the project asks for is changed. The archive's version,
  // tarball and checksum are all still recorded further down, and a strict
  // install refuses this lockfile.
  const lockfilePath = path.join(project, 'pnpm-lock.yaml');
  const specifier = `specifier: ${dependencyOn(release, 'react')}`;
  const lockfile = readFileSync(lockfilePath, 'utf8');
  assert.equal(lockfile.split(specifier).length, 2);
  writeFileSync(lockfilePath, lockfile.replace(specifier, 'specifier: ^0.0.9'));
  assert.throws(
    () => rebuildElsewhere(project, 'pnpm', [REACT]),
    (error) => `${error.stdout}${error.stderr}`.includes('ERR_PNPM_OUTDATED_LOCKFILE'),
  );

  const result = await install(options);
  assert.equal(result.changed, true);
  assert.deepEqual(snapshot(project), installed);
  rebuildElsewhere(project, 'pnpm', [REACT]);
});

test(
  'keeps the permissions of the files it replaces or puts back',
  { skip: process.platform === 'win32' },
  async () => {
    const project = makeProject();
    const manifestPath = path.join(project, 'package.json');
    const lockfilePath = path.join(project, 'package-lock.json');
    chmodSync(manifestPath, 0o600);

    await install({ project, source: release, renderers: ['react'], invokedBy: 'npm' });
    assert.equal(modeOf(manifestPath), 0o600);

    // A failed run puts both files back as they were, permissions included.
    const manifest = readManifest(project);
    manifest.dependencies.broken = 'file:./not-there.tgz';
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    chmodSync(lockfilePath, 0o640);
    await refuses(
      project,
      { source: release, renderers: ['web-components'] },
      /The project was put back as it was\.$/,
    );
    assert.equal(modeOf(manifestPath), 0o600);
    assert.equal(modeOf(lockfilePath), 0o640);
  },
);

describe('choosing the package manager', () => {
  test('uses the one whose lockfile is there, whatever started the installer', async () => {
    const project = makeProject();
    await install({ project, source: release, renderers: ['react'], invokedBy: 'npm' });
    const result = await install({
      project,
      source: release,
      renderers: ['web-components'],
      invokedBy: 'pnpm',
    });
    assert.equal(result.packageManager, 'npm');
    assert.equal(existsSync(path.join(project, 'pnpm-lock.yaml')), false);
  });

  test('refuses a project with both lockfiles', async () => {
    const project = makeProject();
    writeFileSync(path.join(project, 'package-lock.json'), '{}');
    writeFileSync(path.join(project, 'pnpm-lock.yaml'), '');
    await refuses(
      project,
      { source: release, renderers: ['react'] },
      /has both package-lock\.json and pnpm-lock\.yaml/,
    );
  });

  test('refuses a project of another package manager', async () => {
    const yarn = makeProject();
    writeFileSync(path.join(yarn, 'yarn.lock'), '');
    await refuses(yarn, { source: release, renderers: ['react'] }, /has yarn\.lock\. Only npm and pnpm/);

    const declared = makeProject({ packageManager: 'yarn@4.5.0' });
    await refuses(declared, { source: release, renderers: ['react'] }, /uses yarn\. Only npm and pnpm/);

    const started = makeProject();
    await refuses(started, { source: release, renderers: ['react'], invokedBy: 'bun' }, /uses bun\./);
  });

  test('refuses when nothing says which one the project uses', async () => {
    const project = makeProject();
    await refuses(
      project,
      { source: release, renderers: ['react'], invokedBy: undefined },
      /Could not tell whether this project uses npm or pnpm/,
    );
  });
});

describe('a project of its own', () => {
  test('refuses a workspace, and a project inside one', async () => {
    const npmWorkspace = makeProject({ workspaces: ['packages/*'] });
    await refuses(npmWorkspace, { source: release, renderers: ['react'] }, /part of a workspace/);

    const pnpmWorkspace = makeProject();
    writeFileSync(path.join(pnpmWorkspace, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    const member = path.join(pnpmWorkspace, 'packages', 'app');
    mkdirSync(member, { recursive: true });
    writeFileSync(path.join(member, 'package.json'), '{ "name": "app" }\n');
    await refuses(
      member,
      { source: release, renderers: ['react'] },
      /part of a workspace/,
      pnpmWorkspace,
    );
  });

  test('refuses a pnpm project below any pnpm-workspace.yaml, and leaves the directory above untouched', async () => {
    // With only settings in the file above, pnpm still takes that directory
    // as the workspace root and would write its lockfile there.
    const above = makeProject();
    writeFileSync(path.join(above, 'pnpm-workspace.yaml'), 'autoInstallPeers: true\n');
    const nested = path.join(above, 'app');
    mkdirSync(nested);
    writeFileSync(path.join(nested, 'package.json'), '{ "name": "app" }\n');

    await refuses(
      nested,
      { source: release, renderers: ['react'], invokedBy: 'pnpm' },
      /part of a workspace \(.*pnpm-workspace\.yaml\)/,
      above,
    );
  });

  test('installs into a pnpm project that keeps only settings in its own pnpm-workspace.yaml', async () => {
    const project = makeProject();
    writeFileSync(path.join(project, 'pnpm-workspace.yaml'), 'autoInstallPeers: true\n');
    await install({ project, source: release, renderers: ['react'], invokedBy: 'pnpm' });
    assert.match(readFileSync(path.join(project, 'pnpm-lock.yaml'), 'utf8'), /react-1\.0\.0\.tgz/);
  });
});

describe('one installer at a time', () => {
  test('refuses while another holds the project, and leaves its lock alone', async () => {
    const project = makeProject();
    writeFileSync(path.join(project, INSTALL_LOCK), '');
    await refuses(project, { source: release, renderers: ['react'] }, /Another installer is working/);
    assert.equal(existsSync(path.join(project, INSTALL_LOCK)), true);
  });

  test('a second installer that starts midway is refused, and the first finishes', async () => {
    const project = makeProject();
    let second;
    const source = {
      manifest: release.manifest,
      read: async (file) => {
        // The first installer is now reading its archives. Start another.
        second ??= await install({
          project,
          source: release,
          renderers: ['web-components'],
          invokedBy: 'npm',
        }).catch((error) => error);
        assert.equal(existsSync(path.join(project, INSTALL_LOCK)), true);
        return release.read(file);
      },
    };

    const first = await install({ project, source, renderers: ['react'], invokedBy: 'npm' });

    assert.equal(second.name, 'InstallError');
    assert.match(second.message, /Another installer is working/);
    assert.equal(first.changed, true);
    assert.deepEqual(readManifest(project).dependencies, {
      [CORE]: dependencyOn(release, 'core'),
      [REACT]: dependencyOn(release, 'react'),
    });
    assert.equal(existsSync(path.join(project, INSTALL_LOCK)), false);
    assert.equal(existsSync(path.join(project, retained(release, 'web-components'))), false);
  });
});

describe('links in the project are never followed', () => {
  test('a retained folder that is a link', async () => {
    const outside = temporaryDirectory('outside');
    const project = makeProject();
    symlinkSync(outside, path.join(project, 'vendor'));
    await refuses(
      project,
      { source: release, renderers: ['react'] },
      /^vendor is a link or not a directory/,
    );
    assert.deepEqual(snapshot(outside), {});
  });

  test('an archive path that is a dangling link', async () => {
    const outside = temporaryDirectory('outside');
    const project = makeProject();
    mkdirSync(path.join(project, RETAINED_DIRECTORY), { recursive: true });
    symlinkSync(path.join(outside, 'target.tgz'), path.join(project, retained(release, 'core')));
    await refuses(project, { source: release, renderers: ['react'] }, /It was not replaced/);
    assert.deepEqual(snapshot(outside), {});
  });

  test('a package.json that is a link', async () => {
    const outside = temporaryDirectory('outside');
    writeFileSync(path.join(outside, 'package.json'), '{ "name": "elsewhere" }\n');
    const project = makeProject();
    rmSync(path.join(project, 'package.json'));
    symlinkSync(path.join(outside, 'package.json'), path.join(project, 'package.json'));

    const before = snapshot(outside);
    await refuses(
      project,
      { source: release, renderers: ['react'] },
      /package\.json is a link or not a regular file/,
    );
    assert.deepEqual(snapshot(outside), before);
  });

  test('a lockfile that is a dangling link', async () => {
    const outside = temporaryDirectory('outside');
    const project = makeProject();
    symlinkSync(path.join(outside, 'lock.json'), path.join(project, 'package-lock.json'));
    await refuses(
      project,
      { source: release, renderers: ['react'] },
      /^package-lock\.json is a link or not a regular file/,
    );
    assert.deepEqual(snapshot(outside), {});
  });
});

describe('refuses, and leaves the project as it was', () => {
  test('a directory with no package.json', async () => {
    const project = makeProject();
    const empty = path.join(project, 'empty');
    await assert.rejects(install({ project: empty, source: release, renderers: ['react'] }), {
      name: 'InstallError',
      message: /There is no package\.json/,
    });
    assert.equal(existsSync(empty), false);
  });

  test('a package.json that is not valid JSON', async () => {
    const project = makeProject();
    writeFileSync(path.join(project, 'package.json'), '{ "name": "consumer", }');
    await refuses(project, { source: release, renderers: ['react'] }, /is not valid JSON/);
  });

  test('an unknown renderer, or none', async () => {
    const project = makeProject();
    await refuses(project, { source: release, renderers: ['vue'] }, /"vue" is not a renderer/);
    await refuses(project, { source: release, renderers: [] }, /Choose a renderer/);
  });

  test('a manifest of a schema it does not know', async () => {
    const project = makeProject();
    const source = alter(release, ({ manifest }) => {
      manifest.schemaVersion = 2;
    });
    await refuses(project, { source, renderers: ['react'] }, /schema version 1, and this one is 2/);
  });

  test('a manifest for another product', async () => {
    const project = makeProject();
    const source = alter(release, ({ manifest }) => {
      manifest.product = 'foundation';
    });
    await refuses(project, { source, renderers: ['react'] }, /is for "foundation"/);
  });

  test('a manifest that lists a package that is not the Design System', async () => {
    const project = makeProject();
    const source = alter(release, ({ manifest }) => {
      manifest.packages.push({ ...manifest.packages[0], name: 'left-pad', file: 'left-pad-1.0.0.tgz' });
    });
    await refuses(
      project,
      { source, renderers: ['react'] },
      /"left-pad", which is not a Design System package/,
    );
  });

  test('a manifest whose packages are at different versions', async () => {
    const project = makeProject();
    const source = alter(release, ({ manifest }) => {
      entryFor(manifest, 'react').version = '1.0.1';
    });
    await refuses(
      project,
      { source, renderers: ['react'] },
      /is for 1\.0\.0, but lists .*react at "1\.0\.1"/,
    );
  });

  test('a manifest whose file name points outside the retained folder', async () => {
    const project = makeProject();
    const source = alter(release, ({ manifest }) => {
      entryFor(manifest, 'core').file = '../../outside.tgz';
    });
    await refuses(project, { source, renderers: ['react'] }, /is not a usable archive name/);
  });

  test('a manifest without the renderer asked for', async () => {
    const project = makeProject();
    await refuses(
      project,
      { source: subset(release, ['core', 'web-components']), renderers: ['react'] },
      /does not include .*react/,
    );
  });

  test('an archive that is missing', async () => {
    const project = makeProject();
    const source = {
      manifest: release.manifest,
      read: (file) => {
        if (file === entryFor(release.manifest, 'react').file) throw new Error('not found');
        return release.read(file);
      },
    };
    await refuses(
      project,
      { source, renderers: ['react'] },
      /react-1\.0\.0\.tgz could not be read: not found/,
    );
  });

  test('an archive that is incomplete', async () => {
    const project = makeProject();
    const source = {
      manifest: release.manifest,
      read: (file) => release.read(file).subarray(0, 100),
    };
    await refuses(
      project,
      { source, renderers: ['react'] },
      /is 100 bytes, and the release manifest says/,
    );
  });

  test('an archive that was altered', async () => {
    const project = makeProject();
    const source = {
      manifest: release.manifest,
      read: (file) => {
        const bytes = Buffer.from(release.read(file));
        bytes[bytes.length - 20] ^= 0xff;
        return bytes;
      },
    };
    await refuses(project, { source, renderers: ['react'] }, /does not match the checksum/);
  });

  test('an archive that holds a different package than the manifest says', async () => {
    const project = makeProject();
    const core = release.read(entryFor(release.manifest, 'core').file);
    await refuses(
      project,
      { source: withArchive(release, 'react', core), renderers: ['react'] },
      /react-1\.0\.0\.tgz contains @orbition\/design-system-core@1\.0\.0/,
    );
  });

  test('an archive that is not an archive', async () => {
    const project = makeProject();
    await refuses(
      project,
      { source: withArchive(release, 'core', Buffer.from('not an archive')), renderers: ['react'] },
      /is not a readable package archive/,
    );
  });

  // Before sizes were checked, the first of these never finished reading.
  test('an archive whose tar sizes are negative or run past its end', async () => {
    const project = makeProject();
    for (const bytes of [
      tarWithSize('package/readme', '-0001000'),
      tarWithSize('package/package.json', '77777777777'),
    ]) {
      await refuses(
        project,
        { source: withArchive(release, 'core', bytes), renderers: ['react'] },
        /is not a readable package archive/,
      );
    }
  });

  test('a project that already has another version', async () => {
    const project = makeProject();
    await install({ project, source: release, renderers: ['react'], invokedBy: 'npm' });
    await refuses(
      project,
      { source: newer, renderers: ['web-components'] },
      /already declares @orbition\/design-system-core in dependencies as "file:vendor\/orbition\/orbition-design-system-core-1\.0\.0\.tgz"\. This release is 1\.1\.0/,
    );
  });

  test('a project that declares a package some other way', async () => {
    const range = makeProject({ dependencies: { [CORE]: '^1.0.0' } });
    await refuses(
      range,
      { source: release, renderers: ['react'] },
      /already declares .*core in dependencies as "\^1\.0\.0"/,
    );

    const development = makeProject({ devDependencies: { [REACT]: dependencyOn(release, 'react') } });
    await refuses(
      development,
      { source: release, renderers: ['react'] },
      /already declares .*react in devDependencies/,
    );
  });

  test('a different file already kept under the same name', async () => {
    const project = makeProject();
    mkdirSync(path.join(project, RETAINED_DIRECTORY), { recursive: true });
    writeFileSync(path.join(project, retained(release, 'core')), 'someone else’s file');
    await refuses(
      project,
      { source: release, renderers: ['react'] },
      /differs from the release's archive\. It was not replaced/,
    );
  });

  // The renderer kept by an earlier run is not in the manifest, so it is
  // judged by the archive that is in the project.
  test('a renderer kept earlier that is another version, or is gone', async () => {
    const onlyElements = subset(release, ['core', 'web-components']);

    const swapped = makeProject();
    await install({ project: swapped, source: release, renderers: ['react'], invokedBy: 'npm' });
    writeFileSync(
      path.join(swapped, retained(release, 'react')),
      newer.read(entryFor(newer.manifest, 'react').file),
    );
    await refuses(
      swapped,
      { source: onlyElements, renderers: ['web-components'] },
      /react-1\.0\.0\.tgz in this project is @orbition\/design-system-react@1\.1\.0\. This release is 1\.0\.0/,
    );

    const gone = makeProject();
    await install({ project: gone, source: release, renderers: ['react'], invokedBy: 'npm' });
    rmSync(path.join(gone, retained(release, 'react')));
    await refuses(
      gone,
      { source: onlyElements, renderers: ['web-components'] },
      /declares @orbition\/design-system-react, but .*react-1\.0\.0\.tgz is not in it/,
    );
  });
});

describe('what it tells the person', () => {
  test('warns when Git would not commit the archives', async () => {
    const project = makeProject();
    run('git', ['init', '--quiet'], project);
    writeFileSync(path.join(project, '.gitignore'), '*.tgz\n');

    const result = await install({ project, source: release, renderers: ['react'], invokedBy: 'npm' });
    assert.equal(result.warnings.length, 1);
    assert.match(
      result.warnings[0],
      /^Git ignores vendor\/orbition\/.*core-1\.0\.0\.tgz and .*react-1\.0\.0\.tgz\./,
    );
  });
});
