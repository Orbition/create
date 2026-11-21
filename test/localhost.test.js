// The local app's address, https://localhost:8443 (as a local Caddy setup
// serves the application), tested without port 8443: the same requests go to
// https://localhost:<a free port>, served on 127.0.0.1 only (as an IPv4-only
// local app listens) with a certificate chain from a test authority made for
// these tests: a root, an intermediate and a server certificate. No real site,
// service or local app is involved.
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { after, before, test } from 'node:test';

import { verifyConsent } from '../src/cli.js';
import { addressOptions, downloadSource } from '../src/download.js';
import { authority, entryFor, synthesizeRelease } from './helpers.js';

const CODE = 'c'.repeat(43);
const VERIFIER = 'v'.repeat(43);
const CREDENTIAL = 'synthetic-credential.for_tests-0123456789';
const RELEASE_PATH = '/terminal/design-system/releases/0.1.0';
const LIMITS = { manifestMs: 5_000, archiveMs: 5_000 };

let local;
let elsewhere;
let release;
const servers = [];

before(() => {
  local = authority('local');
  elsewhere = authority('elsewhere');
  release = synthesizeRelease('0.1.0');
});
after(() => {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
});

const json = (response, status, value) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
};

/**
 * A site at `host` (127.0.0.1 unless said), answering the check and the
 * downloads, that records each request with the name its connection asked for.
 */
async function site(tls, { host = '127.0.0.1', port = 0 } = {}) {
  const seen = [];
  const server = createServer(tls, (incoming, response) => {
    seen.push({ servername: incoming.socket.servername, host: incoming.headers.host, url: incoming.url });
    if (incoming.url === '/terminal/approve/verify' && incoming.method === 'POST') {
      incoming.resume();
      return incoming.on('end', () =>
        json(response, 200, { status: 'approved', product: 'design-system', version: '0.1.0', expires_in: 900 }),
      );
    }
    if (incoming.headers.authorization !== `Bearer ${CREDENTIAL}`) {
      return json(response, 401, { error: 'sign_in_required' });
    }
    if (incoming.url === `${RELEASE_PATH}/manifest`) return json(response, 200, release.manifest);
    const file = incoming.url.slice(`${RELEASE_PATH}/archives/`.length);
    if (release.manifest.packages.some((entry) => entry.file === file)) {
      response.writeHead(200, { 'Content-Type': 'application/gzip' });
      return response.end(release.read(file));
    }
    return json(response, 404, { error: 'not_found' });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  servers.push(server);
  return { port: server.address().port, seen };
}

const check = (port, ca) =>
  verifyConsent({
    origin: `https://localhost:${String(port)}`,
    ca,
    code: CODE,
    verifier: VERIFIER,
    signal: new AbortController().signal,
    timeoutMs: 5_000,
  });
const open = (port, ca) =>
  downloadSource({ origin: `https://localhost:${String(port)}`, version: '0.1.0', credential: CREDENTIAL, ca, limits: LIMITS });

test('localhost is always 127.0.0.1 and never looked up; other names and addresses are left as they are', async () => {
  const { lookup } = addressOptions('localhost');
  assert.equal(typeof lookup, 'function');
  const ask = (hostname, options) =>
    new Promise((resolve) => {
      const answer = (error, ...found) => resolve(error ? { error: error.code } : found);
      if (options === undefined) lookup(hostname, answer);
      else lookup(hostname, options, answer);
    });
  // Both shapes net asks in: every address (as with autoSelectFamily), or one.
  assert.deepEqual(await ask('localhost', { all: true }), [[{ address: '127.0.0.1', family: 4 }]]);
  assert.deepEqual(await ask('localhost', { all: true, family: 0 }), [[{ address: '127.0.0.1', family: 4 }]]);
  assert.deepEqual(await ask('localhost', {}), ['127.0.0.1', 4]);
  assert.deepEqual(await ask('localhost'), ['127.0.0.1', 4]);
  // It answers for no other name.
  assert.deepEqual(await ask('orbition.example', { all: true }), { error: 'ENOTFOUND' });
  for (const hostname of ['127.0.0.1', '[::1]', 'orbition.example', 'localhost.', 'app.localhost']) {
    assert.deepEqual(addressOptions(hostname), {}, hostname);
  }
});

test('the check and the downloads reach an IPv4-only local app as localhost, its chain and name checked', async () => {
  const good = local.leaf('DNS:localhost');
  const app = await site({ key: good.key, cert: good.chain });
  // Where the system can, a different server at ::1 on the same port: had
  // `localhost` been looked up and ::1 tried first, it would have answered.
  const decoy = elsewhere.leaf('DNS:localhost');
  const other = await site({ key: decoy.key, cert: decoy.chain }, { host: '::1', port: app.port }).catch(() => null);

  const answer = await check(app.port, local.root);
  assert.equal(answer.status, 200);
  assert.equal(answer.type, 'application/json');
  assert.equal(JSON.parse(answer.body).status, 'approved');

  const source = await open(app.port, local.root);
  assert.equal(source.manifest.version, '0.1.0');
  const file = entryFor(release.manifest, 'core').file;
  assert.deepEqual(await source.read(file), release.read(file));
  source.close();

  // Every connection named localhost, to the server and in the Host header.
  assert.deepEqual(
    app.seen.map(({ servername, host }) => [servername, host]),
    Array(3).fill(['localhost', `localhost:${String(app.port)}`]),
  );
  assert.deepEqual(
    app.seen.map(({ url }) => url),
    ['/terminal/approve/verify', `${RELEASE_PATH}/manifest`, `${RELEASE_PATH}/archives/${file}`],
  );
  if (other !== null) assert.deepEqual(other.seen, []);
});

test('a certificate not for localhost, an authority not given, or a chain without its intermediate is refused before anything is sent', async () => {
  const notLocalhost = local.leaf('DNS:orbition.test,IP:127.0.0.1');
  const otherAuthority = elsewhere.leaf('DNS:localhost');
  const leafAlone = local.leaf('DNS:localhost');
  const cases = [
    ['not for localhost', { key: notLocalhost.key, cert: notLocalhost.chain }, local.root, ['ERR_TLS_CERT_ALTNAME_INVALID']],
    ['another authority', { key: otherAuthority.key, cert: otherAuthority.chain }, local.root, ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY']],
    ['no intermediate', { key: leafAlone.key, cert: leafAlone.cert }, local.root, ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY']],
    // Without the local authority, the system's own authorities do not vouch for it.
    ['no authority given', { key: leafAlone.key, cert: leafAlone.chain }, undefined, ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY']],
  ];
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  // And the environment cannot switch the check off.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    for (const [label, tls, ca, codes] of cases) {
      const app = await site(tls);
      await assert.rejects(check(app.port, ca), (error) => {
        assert.ok(codes.includes(error.code), `${label}: ${String(error.code)}`);
        return true;
      });
      await assert.rejects(open(app.port, ca), (error) => {
        assert.equal(error.name, 'InstallError', label);
        assert.equal(error.code, 'unavailable', label);
        assert.match(error.message, /certificate could not be verified/, label);
        return true;
      });
      assert.deepEqual(app.seen, [], label);
    }
  } finally {
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
  }
});
