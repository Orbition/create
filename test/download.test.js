// The HTTPS download source, against a synthetic service on this machine: a
// throwaway certificate, synthetic packages and a made-up credential. No real
// service, account or package is involved.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { gzipSync } from 'node:zlib';

import { downloadSource, MAX_ARCHIVE_BYTES, MAX_MANIFEST_BYTES } from '../src/download.js';
import { install, RETAINED_DIRECTORY } from '../src/install.js';
import { DESIGN_SYSTEM } from '../src/manifest.js';
import {
  certificate,
  entryFor,
  makeProject,
  rebuildElsewhere,
  snapshot,
  synthesizeRelease,
} from './helpers.js';

const VERSION = '0.1.0';
const CREDENTIAL = 'synthetic-credential.for_tests-0123456789';
const RELEASE = `/terminal/design-system/releases/${VERSION}`;
const CORE = DESIGN_SYSTEM.core;
const REACT = DESIGN_SYSTEM.renderers.react;
const QUICK = { manifestMs: 300, archiveMs: 300 };

let release;
let tls;
let server;
let origin;
/** Every request the service received, in order. */
let requests = [];
/** What the current test makes the service answer; anything it leaves out is served properly. */
let script = () => undefined;

const json = (status, body) => ({ status, type: 'application/json; charset=utf-8', body: JSON.stringify(body) });
const refused = (status, code) => json(status, { error: code });

before(async () => {
  release = synthesizeRelease(VERSION);
  tls = certificate();
  server = createServer({ key: tls.key, cert: tls.cert }, (request, response) => {
    const { pathname, search } = new URL(request.url, 'https://service.test');
    const seen = requests.filter((earlier) => earlier.pathname === pathname).length;
    requests.push({
      pathname,
      search,
      method: request.method,
      authorization: request.headers.authorization,
      encoding: request.headers['accept-encoding'],
      cookie: request.headers.cookie,
    });

    let answer = script(pathname, seen);
    if (answer === undefined) {
      if (request.headers.authorization !== `Bearer ${CREDENTIAL}`) {
        answer = refused(401, 'sign_in_required');
      } else if (pathname === `${RELEASE}/manifest`) {
        answer = json(200, release.manifest);
      } else if (pathname.startsWith(`${RELEASE}/archives/`)) {
        const file = pathname.slice(`${RELEASE}/archives/`.length);
        const listed = release.manifest.packages.some((entry) => entry.file === file);
        answer = listed
          ? { status: 200, type: 'application/gzip', body: release.read(file) }
          : refused(404, 'not_found');
      } else {
        answer = refused(404, 'not_found');
      }
    }

    const { status = 200, type, headers = {}, then } = answer;
    const body = Buffer.from(answer.body ?? '');
    if (then === 'drop') return void request.socket.destroy();
    if (then === 'never') return undefined;
    response.writeHead(status, {
      ...(type ? { 'Content-Type': type } : {}),
      'Cache-Control': 'private, no-store',
      ...headers,
    });
    if (then === 'stall') return void response.write(body.subarray(0, 10));
    if (then === 'cut') {
      // Part of the promised body, then the connection goes.
      return void response.write(body.subarray(0, 10), () => request.socket.destroy());
    }
    if (then === 'endless') {
      // Keeps sending until the client goes away; the test reads how much.
      const chunk = Buffer.alloc(64 * 1024, 1);
      answer.sent = 0;
      const more = () => {
        while (!response.destroyed && response.write(chunk)) answer.sent += chunk.length;
        if (!response.destroyed) response.once('drain', more);
      };
      return void more();
    }
    return void response.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `https://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

/** Starts a test's script and an empty request log. */
function service(answers = () => undefined) {
  requests = [];
  script = answers;
}
const open = (options = {}) =>
  downloadSource({ origin, version: VERSION, credential: CREDENTIAL, ca: tls.cert, limits: QUICK, ...options });
const asked = (suffix) => requests.filter(({ pathname }) => pathname === `${RELEASE}${suffix}`).length;
const archive = (which) => `/archives/${entryFor(release.manifest, which).file}`;
const refusedWith = (code, message) => (error) => {
  assert.equal(error.name, 'InstallError');
  assert.equal(error.code, code);
  if (message) assert.match(error.message, message);
  assert.ok(!error.message.includes(CREDENTIAL), 'the credential is in the message');
  return true;
};

/** Installs React from the service into a new project; a refusal must leave that project as it was. */
async function installRefused(answers, check, label) {
  service(answers);
  const project = makeProject();
  const before = snapshot(project);
  await assert.rejects(
    async () => {
      const source = await open();
      await install({ project, source, renderers: ['react'], invokedBy: 'npm' });
    },
    check,
    label,
  );
  assert.deepEqual(snapshot(project), before, `the project was changed: ${label}`);
}

test('installs into an npm project over HTTPS, fetching only what was chosen', async () => {
  service();
  const project = makeProject();
  const source = await open();
  const result = await install({ project, source, renderers: ['react'], invokedBy: 'npm' });

  assert.equal(result.version, VERSION);
  assert.deepEqual(
    result.packages.map(({ name, added }) => [name, added]),
    [
      [CORE, true],
      [REACT, true],
    ],
  );
  for (const which of ['core', 'react']) {
    const { file } = entryFor(release.manifest, which);
    assert.deepEqual(readFileSync(path.join(project, RETAINED_DIRECTORY, file)), release.read(file));
  }
  // Another checkout can install from what was kept, with no service at all.
  const rebuilt = rebuildElsewhere(project, 'npm', [CORE, REACT]);
  assert.equal(rebuilt.modules[REACT].renderer, `${REACT}@${VERSION}`);

  // The manifest once, then core and React: Web Components was never asked for.
  assert.deepEqual(
    requests.map(({ pathname }) => pathname),
    [`${RELEASE}/manifest`, `${RELEASE}${archive('core')}`, `${RELEASE}${archive('react')}`],
  );
  // The credential travels in the header only.
  for (const request of requests) {
    assert.deepEqual(
      [request.method, request.authorization, request.encoding, request.search, request.cookie],
      ['GET', `Bearer ${CREDENTIAL}`, 'gzip', '', undefined],
    );
    assert.ok(!request.pathname.includes(CREDENTIAL));
  }
});

test('each refusal of the service is reported by its code, once, and changes nothing', async () => {
  const refusals = [
    [401, 'sign_in_required', /no longer approved/],
    [403, 'not_entitled', /no current access/],
    [403, 'access_denied', /cannot download yet/],
    [404, 'not_found', /was not found/],
  ];
  for (const [status, code, message] of refusals) {
    // For the manifest: nothing else is asked for.
    service((pathname) => (pathname.endsWith('/manifest') ? refused(status, code) : undefined));
    await assert.rejects(open(), refusedWith(code, message), code);
    assert.equal(requests.length, 1, code);

    // For an archive, part way through an install.
    await installRefused(
      (pathname) => (pathname.endsWith(archive('react')) ? refused(status, code) : undefined),
      refusedWith(code, message),
    );
    assert.equal(asked(archive('react')), 1, code);
  }

  // A credential the service does not know is the service's own 401.
  service();
  await assert.rejects(open({ credential: 'another-credential' }), refusedWith('sign_in_required'));
});

test('no answer and 503 are tried once more, and only once', async () => {
  const unavailable = refused(503, 'unavailable');
  const once = (suffix, answer) => (pathname, seen) =>
    pathname.endsWith(suffix) && seen === 0 ? answer : undefined;
  const always = (suffix, answer) => (pathname) => (pathname.endsWith(suffix) ? answer : undefined);

  // One passing fault, for the manifest and for an archive: the install completes.
  for (const fault of [unavailable, { then: 'drop' }, { then: 'never' }]) {
    for (const suffix of ['/manifest', archive('core')]) {
      service(once(suffix, fault));
      const project = makeProject();
      await install({ project, source: await open(), renderers: ['react'], invokedBy: 'npm' });
      assert.equal(asked(suffix), 2);
      assert.equal(requests.length, 4);
    }
  }

  // The same fault twice ends it, after exactly two tries.
  for (const fault of [unavailable, { then: 'drop' }, { then: 'never' }]) {
    service(always('/manifest', fault));
    await assert.rejects(open(), refusedWith('unavailable', /Try again in a few minutes/));
    assert.equal(requests.length, 2);

    await installRefused(always(archive('react'), fault), refusedWith('unavailable'), JSON.stringify(fault));
    assert.equal(asked(archive('react')), 2);
  }

  // An archive that starts and then stops arriving, or is cut off, is the same.
  const body = release.read(entryFor(release.manifest, 'react').file);
  for (const then of ['stall', 'cut']) {
    const headers = { 'Content-Length': String(body.length) };
    await installRefused(
      always(archive('react'), { type: 'application/gzip', body, headers, then }),
      refusedWith('unavailable', /could not be reached/),
      then,
    );
    assert.equal(asked(archive('react')), 2, then);
  }
});

test('a wrong or broken answer is settled on what has arrived, without waiting or asking again', async () => {
  const manifest = Buffer.from(JSON.stringify(release.manifest));
  const not = (code, message) => refusedWith(code, message);
  const cases = {
    // The media type is wrong: decided on the headers, though the body never ends.
    'a web page that stalls': [{ type: 'text/html', body: manifest, then: 'stall' }, 1],
    'a refusal as a web page that stalls': [{ status: 403, type: 'text/html', body: manifest, then: 'stall' }, 1],
    // Declared gzip, and the first bytes already are not: no need for the rest.
    'unreadable compression that stalls': [
      { type: 'application/json', body: manifest, headers: { 'Content-Encoding': 'gzip' }, then: 'stall' },
      1,
    ],
    // A refusal whose body stops or is cut off is still a refusal.
    'a 401 that stalls': [{ ...refused(401, 'sign_in_required'), then: 'stall' }, 1],
    'a 403 that is cut off': [{ ...refused(403, 'not_entitled'), headers: { 'Content-Length': '99' }, then: 'cut' }, 1],
    'a 404 that is cut off': [{ ...refused(404, 'not_found'), headers: { 'Content-Length': '99' }, then: 'cut' }, 1],
  };
  for (const [label, [answer, tries]] of Object.entries(cases)) {
    service((pathname) => (pathname.endsWith('/manifest') ? answer : undefined));
    const started = performance.now();
    await assert.rejects(open(), not('unavailable', /does not understand/), label);
    assert.equal(requests.length, tries, label);
    // The stalled ones did not wait out the time limit.
    if (!label.includes('40')) assert.ok(performance.now() - started < QUICK.manifestMs, label);
  }
  // Only "not available" may be asked for again, also when its body is cut off.
  service((pathname) =>
    pathname.endsWith('/manifest')
      ? { ...refused(503, 'unavailable'), headers: { 'Content-Length': '99' }, then: 'cut' }
      : undefined,
  );
  await assert.rejects(open(), not('unavailable', /could not be reached/));
  assert.equal(requests.length, 2);
});

test('an answer outside the contract stops the run, with no second try', async () => {
  const manifest = JSON.stringify(release.manifest);
  const outside = {
    'a redirect': { status: 302, headers: { Location: `${RELEASE}/elsewhere` } },
    'a web page': { status: 200, type: 'text/html', body: '<p>Sign in</p>' },
    'no media type': { status: 200, body: manifest },
    'compression this does not read': {
      status: 200,
      type: 'application/json',
      body: manifest,
      headers: { 'Content-Encoding': 'br' },
    },
    'compression that cannot be read': {
      status: 200,
      type: 'application/json',
      body: manifest,
      headers: { 'Content-Encoding': 'gzip' },
    },
    'another status': json(500, { error: 'unavailable' }),
    'a code that belongs to another status': refused(401, 'not_entitled'),
    'an unknown code': refused(403, 'payment_required'),
    'a refusal that is not JSON': { status: 404, type: 'application/json', body: 'not found' },
    'a refusal as a web page': { status: 404, type: 'text/html', body: '<h1>404</h1>' },
    'an oversized refusal': json(403, { error: 'not_entitled', padding: 'x'.repeat(MAX_MANIFEST_BYTES) }),
  };
  for (const [label, answer] of Object.entries(outside)) {
    service((pathname) => (pathname.endsWith('/manifest') ? answer : undefined));
    await assert.rejects(open(), refusedWith('unavailable', /does not understand/), label);
    assert.deepEqual(
      requests.map(({ pathname }) => pathname),
      [`${RELEASE}/manifest`],
      label,
    );
  }
});

test('a manifest that is not exactly the release asked for is refused', async () => {
  const changed = (change) => {
    const manifest = structuredClone(release.manifest);
    change(manifest);
    return json(200, manifest);
  };
  const invalid = {
    'not JSON': { status: 200, type: 'application/json', body: '{ "packages": [' },
    'too large': json(200, { ...release.manifest, padding: 'x'.repeat(MAX_MANIFEST_BYTES) }),
    'another product': changed((manifest) => void (manifest.product = 'foundation')),
    'another release': changed((manifest) => {
      manifest.version = '0.1.1';
      for (const entry of manifest.packages) {
        entry.version = '0.1.1';
        entry.file = entry.file.replace(VERSION, '0.1.1');
      }
    }),
    'another package': changed((manifest) => void (manifest.packages[0].name = 'left-pad')),
    'another file name': changed((manifest) => void (manifest.packages[0].file = 'core.tgz')),
    "another package's file": changed((manifest) => {
      const [core, other] = manifest.packages;
      [core.file, other.file] = [other.file, core.file];
    }),
    'a path for a file': changed((manifest) => void (manifest.packages[0].file = '../../x.tgz')),
    'a weaker checksum': changed((manifest) => void (manifest.packages[0].integrity = 'sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=')),
    'no size': changed((manifest) => void (manifest.packages[0].bytes = 0)),
    'an impossible size': changed((manifest) => void (manifest.packages[0].bytes = MAX_ARCHIVE_BYTES + 1)),
  };
  for (const [label, answer] of Object.entries(invalid)) {
    service((pathname) => (pathname.endsWith('/manifest') ? answer : undefined));
    await assert.rejects(open(), refusedWith('invalid_release', /Nothing was installed/), label);
    assert.equal(requests.length, 1, label);
  }
});

test('an archive must arrive exactly as the manifest records it', async () => {
  const body = release.read(entryFor(release.manifest, 'react').file);
  const react = (answer) => (pathname) => (pathname.endsWith(archive('react')) ? answer : undefined);
  const gzip = 'application/gzip';

  await installRefused(react({ type: gzip, body: body.subarray(0, body.length - 1) }), refusedWith('invalid_release', /shorter/));
  await installRefused(react({ type: gzip, body: Buffer.concat([body, Buffer.from([0])]) }), refusedWith('invalid_release', /longer/));
  await installRefused(react({ type: gzip, body: Buffer.alloc(0) }), refusedWith('invalid_release', /shorter/));
  // The right size with other contents: the installer's own checksum refuses it.
  const altered = Buffer.from(body);
  altered[altered.length - 1] ^= 0xff;
  await installRefused(react({ type: gzip, body: altered }), { name: 'InstallError', message: /does not match the checksum/ });
  for (const answer of [
    { type: 'application/octet-stream', body },
    { type: 'application/json', body },
    { type: gzip, body, headers: { 'Content-Encoding': 'deflate' } },
    // Declared as compressed in transit, but the body is the archive itself
    // with a byte changed: not readable as that.
    { type: gzip, body: altered, headers: { 'Content-Encoding': 'gzip' } },
  ]) {
    await installRefused(react(answer), refusedWith('unavailable', /does not understand/));
  }
  // None of those is tried again.
  assert.equal(asked(archive('react')), 1);

  // A body that never ends is given up one byte past the recorded size.
  const endless = { type: gzip, then: 'endless' };
  await installRefused(react(endless), refusedWith('invalid_release', /longer/));
  assert.equal(asked(archive('react')), 1);
  assert.ok(endless.sent < body.length + 32 * 1024 * 1024, `the service sent ${endless.sent} bytes`);
});

test('the certificate is always verified', async () => {
  const untrusted = refusedWith('unavailable', /certificate could not be verified/);
  service();
  // Not signed by an authority this machine trusts.
  await assert.rejects(open({ ca: undefined }), untrusted);
  // Not the authority the caller named.
  await assert.rejects(open({ ca: certificate().cert }), untrusted);
  // Not a certificate for this name.
  await assert.rejects(open({ origin: origin.replace('127.0.0.1', 'localhost') }), untrusted);
  // And the environment cannot switch the check off.
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    await assert.rejects(open({ ca: undefined }), untrusted);
  } finally {
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
  }
  // Nothing was sent to a service that could not be verified.
  assert.deepEqual(requests, []);
});

test('the address, the version and the credential are checked before anything is sent', async () => {
  service();
  const { port } = server.address();
  const refuse = (options, message) =>
    assert.rejects(open(options), { name: 'InstallError', message }, JSON.stringify(options));

  for (const address of [
    `http://127.0.0.1:${port}`,
    `https://user:secret@127.0.0.1:${port}`,
    `https://127.0.0.1:${port}/terminal`,
    `https://127.0.0.1:${port}/?next=1`,
    `https://127.0.0.1:${port}/#top`,
    `127.0.0.1:${port}`,
    'not an address',
    '',
    undefined,
  ]) {
    await refuse({ origin: address }, /download service address/);
  }
  for (const version of ['latest', '0.1', '0.1.0.0', '0.1.0-beta', '01.0.0', '../0.1.0', ' 0.1.0', '', 1]) {
    await refuse({ version }, /release version must be three numbers/);
  }
  for (const credential of ['', 'two words', 'line\nbreak', 'a"quote', 'ünïcode', undefined, 42]) {
    await refuse({ credential }, /credential is missing or is not a bearer token/);
  }
  assert.deepEqual(requests, []);
});

test('only an archive the manifest names can be asked for', async () => {
  service();
  const source = await open();
  for (const file of ['other-0.1.0.tgz', '../manifest', 'manifest', '', undefined]) {
    await assert.rejects(source.read(file), { name: 'InstallError', message: /not an archive of Design System 0\.1\.0/ });
  }
  assert.deepEqual(requests.map(({ pathname }) => pathname), [`${RELEASE}/manifest`]);
  // One it does name arrives whole.
  const { file } = entryFor(release.manifest, 'web-components');
  assert.deepEqual(await source.read(file), release.read(file));
});

test('answers compressed in transit are read, and measured after decoding', async () => {
  const compressed = (answer) => ({
    ...answer,
    body: gzipSync(answer.body),
    headers: { 'Content-Encoding': 'gzip' },
  });
  const manifest = { type: 'application/json', body: Buffer.from(JSON.stringify(release.manifest)) };
  const file = (pathname) => release.read(pathname.slice(`${RELEASE}/archives/`.length));
  // The manifest, the archives (each already a .tgz) and a refusal, all gzipped on the way.
  service((pathname) =>
    pathname.endsWith('/manifest')
      ? compressed(manifest)
      : compressed({ type: 'application/gzip', body: file(pathname) }),
  );
  const project = makeProject();
  await install({ project, source: await open(), renderers: ['react'], invokedBy: 'npm' });
  const kept = entryFor(release.manifest, 'react').file;
  assert.deepEqual(readFileSync(path.join(project, RETAINED_DIRECTORY, kept)), release.read(kept));

  service(() => compressed({ status: 403, type: 'application/json', body: Buffer.from('{"error":"not_entitled"}') }));
  await assert.rejects(open(), refusedWith('not_entitled'));

  // Small on the wire, too large once decoded: a manifest, a refusal and an archive.
  const zeros = Buffer.alloc(8 * 1024 * 1024);
  service(() => compressed({ type: 'application/json', body: zeros }));
  await assert.rejects(open(), refusedWith('invalid_release', /larger than a manifest can be/));
  service(() => compressed({ status: 403, type: 'application/json', body: zeros }));
  await assert.rejects(open(), refusedWith('unavailable', /does not understand/));
  const react = archive('react');
  await installRefused(
    (pathname) => (pathname.endsWith(react) ? compressed({ type: 'application/gzip', body: zeros }) : undefined),
    refusedWith('invalid_release', /longer/),
  );
  await installRefused(
    (pathname) =>
      pathname.endsWith(react)
        ? compressed({ type: 'application/gzip', body: file(pathname).subarray(1) })
        : undefined,
    refusedWith('invalid_release', /shorter/),
  );
  assert.equal(asked(react), 1);
});

test('the credential is let go once the archives have arrived, and on request', async () => {
  service();
  const source = await open();
  const { file } = entryFor(release.manifest, 'web-components');
  await install({ project: makeProject(), source, renderers: ['react'], invokedBy: 'npm' });
  const sent = requests.length;
  // The installer closed it before it wrote anything: nothing more can be fetched.
  await assert.rejects(source.read(file), { name: 'InstallError', message: /was closed/ });
  assert.equal(requests.length, sent);

  const another = await open();
  assert.deepEqual(await another.read(file), release.read(file));
  another.close();
  another.close();
  await assert.rejects(another.read(file), { name: 'InstallError', message: /was closed/ });
});
