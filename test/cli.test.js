// The command (src/cli.js), run with a stand-in terminal, a stand-in for the
// browser (requests to the run's own listener) and a local HTTPS stand-in for
// the site (the check, the exchange and the downloads), with a throwaway
// certificate for 127.0.0.1. No real site, account or browser is involved.
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:https';
import { connect } from 'node:net';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, beforeEach, describe, test } from 'node:test';

import { APPROVAL_MS, CONSENT_MARGIN_MS, EXCHANGE_MS, main, VERIFY_MS } from '../src/cli.js';
import { INSTALL_LOCK } from '../src/install.js';
import {
  certificate,
  makeProject,
  snapshot,
  synthesizeRelease,
  temporaryDirectory,
} from './helpers.js';

const cli = path.resolve(import.meta.dirname, '../src/cli.js');

// The site's stand-in: what it was sent, and how it answers the current test:
// the check of the permission (`check`), its exchange (`exchange`) and the
// downloads (`serve`), which by default give a synthetic release 0.1.0 to the
// one credential the exchange issues. Anything else is recorded in `others`.
let site;
let ORIGIN;
let CA;
let release;
const checks = [];
const exchanges = [];
const fetches = [];
const others = [];
let check;
let exchange;
let serve;
const CREDENTIAL = randomBytes(32).toString('base64url');
const RELEASE_PATH = '/terminal/design-system/releases/0.1.0';
const json = (response, status, value, type = 'application/json; charset=utf-8') => {
  response.writeHead(status, { 'Content-Type': type });
  response.end(typeof value === 'string' ? value : JSON.stringify(value));
};
const approved = (_request, response) =>
  json(response, 200, { status: 'approved', product: 'design-system', version: '0.1.0', expires_in: 900 });
const issued = (_request, response) =>
  json(response, 200, { credential: CREDENTIAL, expires_in: 600, product: 'design-system', version: '0.1.0' });
const served = (incoming, response) => {
  if (incoming.headers.authorization !== `Bearer ${CREDENTIAL}`) {
    return json(response, 401, { error: 'sign_in_required' });
  }
  if (incoming.url === `${RELEASE_PATH}/manifest`) return json(response, 200, release.manifest);
  const file = incoming.url.slice(`${RELEASE_PATH}/archives/`.length);
  if (incoming.url.startsWith(`${RELEASE_PATH}/archives/`) && release.manifest.packages.some((e) => e.file === file)) {
    response.writeHead(200, { 'Content-Type': 'application/gzip' });
    return response.end(release.read(file));
  }
  return json(response, 404, { error: 'not_found' });
};
/** Answers one request with `first`, every later one with `then`. */
const once = (first, then) => {
  let used = false;
  return (...args) => {
    const answer = used ? then : first;
    used = true;
    return answer(...args);
  };
};

before(async () => {
  const tls = certificate();
  CA = tls.certPath;
  release = synthesizeRelease('0.1.0');
  site = createServer({ key: tls.key, cert: tls.cert }, (incoming, response) => {
    let body = '';
    incoming.setEncoding('utf8');
    incoming.on('data', (chunk) => (body += chunk));
    incoming.on('end', () => {
      const seen = {
        method: incoming.method,
        url: incoming.url,
        type: incoming.headers['content-type'],
        authorization: incoming.headers.authorization,
        body,
      };
      if (incoming.url === '/terminal/approve/verify') {
        checks.push(seen);
        return check(incoming, response, body);
      }
      if (incoming.url === '/terminal/token') {
        exchanges.push(seen);
        return exchange(incoming, response, body);
      }
      if (incoming.url.startsWith('/terminal/design-system/')) {
        fetches.push(seen);
        return serve(incoming, response);
      }
      others.push(seen);
      return json(response, 404, { error: 'not_found' });
    });
  });
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  ORIGIN = `https://127.0.0.1:${String(site.address().port)}`;
});
after(() => {
  site.close();
  site.closeAllConnections();
});
beforeEach(() => {
  checks.length = 0;
  exchanges.length = 0;
  fetches.length = 0;
  others.length = 0;
  check = approved;
  exchange = issued;
  serve = served;
});

// The link the browser is given for a permission to install, on its own line.
const LINK =
  /https:\/\/127\.0\.0\.1:\d+\/terminal\/approve\?product=([a-z-]+)&version=([0-9.]+)&purpose=install&code_challenge=([A-Za-z0-9_-]{43})&code_challenge_method=S256&state=([A-Za-z0-9_-]{43})&port=(\d+)(?=\n)/;

/** A terminal for one run: what it shows, and a way to type into it. */
function terminal({ columns = 1000 } = {}) {
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode: (mode) => Object.assign(stdin, { isRaw: mode }),
  });
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns });
  const stderr = new PassThrough();
  let written = '';
  let shown = '';
  let problems = '';
  // What a person would read: readline's cursor movements left out.
  stdout.on('data', (chunk) => {
    written += chunk;
    shown += String(chunk).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  });
  stderr.on('data', (chunk) => (problems += chunk));
  /** Waits until `pattern` is shown, looking only past `from` characters of what was shown. */
  const waitFor = async (pattern, from = 0) => {
    for (let tries = 0; tries < 400; tries += 1) {
      const found = pattern.exec(shown.slice(from));
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`never shown: ${String(pattern)}\n${shown}`);
  };
  return {
    stdin,
    stdout,
    stderr,
    shown: () => shown,
    /** Everything written, cursor movements included. */
    written: () => written,
    /** How much has been shown so far, to wait for what comes after it. */
    at: () => shown.length,
    problems: () => problems,
    type: (text) => stdin.write(text),
    waitFor,
    /** The first permission link shown past `from`, and the product, version, challenge, state and port in it. */
    link: async (from = 0) => {
      const [link, product, version, challenge, state, port] = await waitFor(LINK, from);
      return { link, product, version, challenge, state, port: Number(port) };
    },
  };
}

/** One request to the run's listener, as a browser would send it. */
function visit(port, target, { method = 'GET', host = `127.0.0.1:${String(port)}` } = {}) {
  return new Promise((resolve, reject) => {
    // A new connection every time: nothing pooled from an earlier request.
    const outgoing = request({ host: '127.0.0.1', port, path: target, method, headers: { host }, agent: false });
    outgoing.on('response', (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

/** The site's callback for a request: `code=<code>` or `error=<why>`. */
const answer = (port, state, query) => visit(port, `/callback?state=${state}&${query}`);
const newCode = () => randomBytes(32).toString('base64url');
/** The browser's permission, with a fresh code; resolves with the code. */
const allowed = async (port, state) => {
  const code = newCode();
  await answer(port, state, `code=${code}`);
  return code;
};

/** Whether nothing listens at the port any more: a new TCP connection is refused. */
const closed = (port) =>
  new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.on('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', (error) => resolve(error.code === 'ECONNREFUSED'));
  });

/** A request written by hand, with a target no browser would send. Resolves with its status. */
const raw = (port, target) =>
  new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let text = '';
    socket.on('data', (chunk) => (text += chunk));
    socket.on('end', () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1])));
    socket.on('error', reject);
    socket.end(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nConnection: close\r\n\r\n`);
  });

/** Whether any file under `directory` holds any of `secrets`. */
const holdsAny = (directory, secrets) =>
  Object.values(snapshot(directory)).some((content) => {
    const bytes = content.startsWith('link to ') ? Buffer.from(content) : Buffer.from(content, 'base64');
    return secrets.some((secret) => bytes.includes(secret));
  });

function start(term, overrides = {}) {
  const opened = [];
  const signals = new EventEmitter();
  const run = main({
    argv: ['--origin', ORIGIN, '--ca', CA],
    env: {},
    stdin: term.stdin,
    stdout: term.stdout,
    stderr: term.stderr,
    cwd: makeProject({ name: 'my-app' }),
    signals,
    openUrl: async (url) => {
      opened.push(url);
      return true;
    },
    // Short enough that a failing test does not hold the run for long.
    approvalMs: 30_000,
    ...overrides,
  });
  return { run, opened, signals };
}

/**
 * From the folder's answer on: takes the defaults (Design System, React) and
 * cancels at the review, each key once its list is shown. The run then ends
 * with 1 and nothing changed.
 */
async function cancelAtReview(term) {
  const from = term.at();
  await term.waitFor(/What would you like to add\? \(.*\)\n(?:.*\n){3}/, from);
  term.type('\r');
  await term.waitFor(/Which do you use\? \(.*\)\n(?:.*\n){2}/, from);
  term.type('\r');
  await cancelHere(term, from);
}

/** At the review's list (past `from`): Up to Cancel, then Enter. */
async function cancelHere(term, from) {
  await term.waitFor(/What next\? \(.*\)\n(?:.*\n){3}/, from);
  const at = term.at();
  term.type('\x1b[A');
  await term.waitFor(/  ❯ Cancel\n/, at);
  term.type('\r');
}

/** Allowed by hand (no Enter): the run, its terminal, the code the site sent and the link. */
async function proved(overrides = {}) {
  const term = terminal();
  const started = start(term, overrides);
  const link = await term.link();
  const code = await allowed(link.port, link.state);
  return { term, started, code, link };
}

describe('signing in and allowing the install, in one browser visit', () => {
  test('Enter opens the link; the site confirms the permission; the folder is checked; nothing is spent or changed', async () => {
    assert.equal(APPROVAL_MS, 10 * 60 * 1000);
    const project = makeProject({ name: 'my-app' });
    writeFileSync(path.join(project, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
    const before = snapshot(project);
    const term = terminal();
    const { run, opened } = start(term, { cwd: project });

    await term.waitFor(/◆ Welcome to Orbition/);
    await term.waitFor(new RegExp(`Signing in on ${ORIGIN.replaceAll('.', '\\.')} \\(from --origin\\)\\.`));
    await term.waitFor(
      /Sign in and allow this install of Design System 0\.1\.0 in your browser\. Press Enter to open it, or Ctrl\+C to stop\.\n/,
    );
    const { link, product, version, port, state, challenge } = await term.link();
    assert.deepEqual([product, version], ['design-system', '0.1.0']);
    term.type('\r');
    await term.waitFor(/Waiting for you to sign in and allow it \(up to 1 minute\)… $/);
    assert.deepEqual(opened, [link]);

    const code = newCode();
    const page = await answer(port, state, `code=${code}`);
    assert.equal(page.status, 200);
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.match(page.headers['content-security-policy'], /default-src 'none'/);
    assert.match(page.body, /confirming this with Orbition/);

    await term.waitFor(
      /received\.\nConfirming with Orbition… allowed\.\n  Orbition allows this one install of Design System 0\.1\.0: Install must start within 15 minutes\. Signing out blocks any further authorization or download; files already downloaded can still finish installing\. Nothing is downloaded before you choose Install\.\n/,
    );
    await term.waitFor(/Which project folder\? \(a path from here; Enter for this one\) $/);
    // One answer is all it takes: nothing listens at the folder question.
    assert.equal(await closed(port), true);

    // The check: exactly the code and this request's verifier, whose challenge the link carried.
    assert.equal(checks.length, 1);
    const [checked] = checks;
    assert.deepEqual([checked.method, checked.url, checked.type], ['POST', '/terminal/approve/verify', 'application/json']);
    const sent = JSON.parse(checked.body);
    assert.deepEqual(Object.keys(sent).sort(), ['code', 'code_verifier']);
    assert.equal(sent.code, code);
    assert.match(sent.code_verifier, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(createHash('sha256').update(sent.code_verifier).digest('base64url'), challenge);

    term.type('missing-folder\r');
    await term.waitFor(/There is no folder at .*missing-folder\./);
    term.type('\r');
    await cancelAtReview(term);
    assert.equal(await run, 1);
    assert.match(term.shown(), /  my-app uses pnpm\.\n/);
    assert.equal(term.problems(), 'Cancelled. Nothing was changed.\n');
    assert.deepEqual(snapshot(project), before);
    // Nothing was exchanged or downloaded, and nothing else was asked.
    assert.deepEqual([exchanges.length, fetches.length, others.length], [0, 0, 0]);
    // Neither the code nor the verifier is ever shown.
    for (const secret of [code, sent.code_verifier]) {
      assert.ok(!term.shown().includes(secret) && !term.problems().includes(secret));
    }
  });

  test('ORBITION_ORIGIN and ORBITION_CA give the site when there are no flags, and each flag wins', async () => {
    let term = terminal();
    let started = start(term, { argv: [], env: { ORBITION_ORIGIN: ORIGIN, ORBITION_CA: CA } });
    await term.waitFor(/\(from ORBITION_ORIGIN\)\./);
    term.type('\x03');
    assert.equal(await started.run, 130);

    term = terminal();
    started = start(term, {
      env: { ORBITION_ORIGIN: 'https://127.0.0.1:1', ORBITION_CA: '/nowhere/ca.pem' },
    });
    await term.waitFor(/\(from --origin\)\./);
    term.type('\x03');
    assert.equal(await started.run, 130);
    assert.doesNotMatch(term.shown(), /127\.0\.0\.1:1\b/);
  });

  test('a link opened by hand needs no Enter, and the browser is not opened again', async () => {
    const { term, started } = await proved({ env: { npm_config_user_agent: 'pnpm/10.32.1 node/v24' } });
    await term.waitFor(/Which project folder\?/);
    term.type('\r');
    await cancelAtReview(term);
    assert.equal(await started.run, 1);
    assert.deepEqual(started.opened, []);
    assert.doesNotMatch(term.shown(), /Waiting for you to sign in/);
    assert.match(term.shown(), /\nConfirming with Orbition… allowed\.\n/);
    // No lockfile and no packageManager field: the launcher decides.
    assert.match(term.shown(), /my-app uses pnpm\./);
  });

  test('only this request’s well-formed answer counts; anything else is refused and the run keeps waiting', async () => {
    const term = terminal();
    const { run } = start(term);
    const { port, state } = await term.link();
    const other = 'A'.repeat(state.length);
    const code = newCode();
    const refused = [
      [visit(port, `/callback?state=${other}&code=${code}`), 400],
      [visit(port, `/callback?state=${state}`), 404],
      [visit(port, `/callback?state=${state}&code=${code}&next=x`), 404],
      [visit(port, `/callback?state=${state}&code=${code}&code=${code}`), 404],
      [visit(port, `/elsewhere?state=${state}&code=${code}`), 404],
      // The sign-in's own answer is not this request's.
      [visit(port, `/callback?state=${state}&result=signed_in&code=${code}`), 404],
      [visit(port, `/callback?state=${state}&error=granted`), 400],
      // A code or a reason, never both, and only a code the site could have made.
      [visit(port, `/callback?state=${state}&error=cancelled&code=${code}`), 404],
      [visit(port, `/callback?state=${state}&code=short`), 400],
      [visit(port, `/callback?state=${state}&code=`), 400],
      [visit(port, `/callback?state=${state}&code=${code}`, { method: 'POST' }), 405],
      [visit(port, `/callback?state=${state}&code=${code}`, { host: `localhost:${String(port)}` }), 400],
    ];
    for (const [response, status] of refused) assert.equal((await response).status, status);
    // Targets that are not a path are refused, not thrown.
    assert.equal(await raw(port, `http://127.0.0.1:${String(port)}/callback?state=${state}&error=cancelled`), 400);
    assert.equal(await raw(port, '*'), 400);
    assert.equal(await raw(port, '//[bad/callback'), 404);
    assert.equal(await raw(port, `//evil.example/callback?state=${state}&error=cancelled`), 404);

    const page = await answer(port, state, 'error=cancelled');
    assert.match(page.body, /Cancelled/);
    assert.equal(await run, 1);
    assert.match(term.problems(), /^It was cancelled in the browser\. Nothing was changed\.\n$/);
    assert.doesNotMatch(term.shown(), /Which project folder/);
    assert.equal(checks.length, 0);
  });

  test('ran out of time, no access, an account not ready or no such release in the browser: the run ends before the folder', async () => {
    for (const [error, message] of [
      ['expired', /^The request ran out of time in the browser\. Run the installer again\. Nothing was changed\.\n$/],
      ['not_entitled', /^This account has no current access to the Design System\. Nothing was changed\.\n$/],
      ['access_denied', /^This account cannot download yet\. Finish setting the account up on the Orbition site, then run the installer again\. Nothing was changed\.\n$/],
      ['not_found', /^Orbition has no Design System 0\.1\.0 to install\. Nothing was changed\.\n$/],
    ]) {
      const term = terminal();
      const { run } = start(term);
      const { port, state } = await term.link();
      term.type('\r');
      await term.waitFor(/Waiting for you to sign in and allow it/);
      await answer(port, state, `error=${error}`);
      assert.equal(await run, 1, error);
      assert.match(term.problems(), message, error);
      assert.match(term.shown(), error === 'expired' ? /… ran out of time\.\n$/ : /… not allowed\.\n$/, error);
      assert.doesNotMatch(term.shown(), /Which project folder/);
      assert.equal(checks.length, 0);
    }
  });

  test('the limit is the site’s: ten minutes, set again when the browser is opened', async () => {
    const term = terminal();
    const { run } = start(term, { approvalMs: 3000, env: { npm_config_user_agent: 'npm/11.0.0' } });
    const { port, state } = await term.link();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    term.type('\r');
    await term.waitFor(/up to 1 minute\)… $/);
    // Past the first limit, but within the one set at Enter.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await allowed(port, state);
    await term.waitFor(/Which project folder\?/);
    term.type('\r');
    await cancelAtReview(term);
    assert.equal(await run, 1);
  });

  test('typing while the browser is used does not answer the next question', async () => {
    const term = terminal();
    const { run } = start(term, { env: { npm_config_user_agent: 'npm/11.0.0' } });
    const { port, state } = await term.link();
    term.type('\r');
    await term.waitFor(/Waiting for you to sign in and allow it/);
    term.type('somewhere\r\r');
    await new Promise((resolve) => setTimeout(resolve, 50));
    await allowed(port, state);
    await term.waitFor(/Which project folder\?.*\) $/);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.doesNotMatch(term.shown(), /uses npm|There is no folder/);
    term.type('\r');
    await cancelAtReview(term);
    assert.equal(await run, 1);
    assert.match(term.shown(), /my-app uses npm\./);
  });

  test('with no answer in time, the run ends and stops listening', async () => {
    const term = terminal();
    const { run } = start(term, { approvalMs: 150 });
    const { port } = await term.link();
    assert.equal(await run, 1);
    assert.match(term.problems(), /Signing in and allowing the install ran out of time\. Run the installer again\. Nothing was changed\./);
    assert.equal(await closed(port), true);
  });
});

describe('the check of the permission', () => {
  test('each refusal from the site ends the run with its own reason, before the folder', async () => {
    const cases = [
      [400, 'invalid_grant', /^Orbition did not accept this permission: it ran out of time, was already used, or belongs to another run\. Nothing was changed\. Run the installer again\.\n$/],
      [401, 'sign_in_required', /^The browser is no longer signed in to Orbition\. Nothing was changed\. Run the installer again\.\n$/],
      [403, 'not_entitled', /^This account has no current access to the Design System\. Nothing was changed\.\n$/],
      [403, 'access_denied', /^This account cannot download yet\./],
      [429, 'rate_limited', /^Too many checks from this network\. Try again in a few minutes\. Nothing was changed\. Run the installer again\.\n$/],
      [503, 'unavailable', /^Orbition cannot confirm this right now\./],
    ];
    for (const [status, error, reason] of cases) {
      check = (_request, response) => json(response, status, { error });
      const { term, started } = await proved();
      assert.equal(await started.run, 1, error);
      assert.match(term.shown(), /Confirming with Orbition… not confirmed\.\n/);
      assert.match(term.problems(), reason, error);
      assert.doesNotMatch(term.shown(), /Which project folder/);
    }
    assert.equal(exchanges.length, 0);
  });

  test('a permission with no more time left than the margin is not one: the run ends before the folder', async () => {
    assert.equal(CONSENT_MARGIN_MS, 30_000);
    for (const seconds of [1, 30]) {
      check = (_request, response) =>
        json(response, 200, { status: 'approved', product: 'design-system', version: '0.1.0', expires_in: seconds });
      const { term, started } = await proved();
      assert.equal(await started.run, 1, String(seconds));
      assert.match(term.shown(), /Confirming with Orbition… too late\.\n/);
      assert.match(term.problems(), /^The permission had too little time left to be used\. Nothing was changed\. Run the installer again\.\n$/);
      assert.doesNotMatch(term.shown(), /Which project folder/);
    }
    assert.equal(exchanges.length, 0);
  });

  test('anything but exactly 200 {"status":"approved"} for this release, with a sane lifetime, is not a permission; no redirect is followed', async () => {
    const good = { status: 'approved', product: 'design-system', version: '0.1.0', expires_in: 900 };
    const answers = [
      (_request, response) => json(response, 200, { ...good, status: 'signed_in' }),
      (_request, response) => json(response, 200, { status: 'signed_in' }),
      (_request, response) => json(response, 200, { ...good, account: 'x' }),
      (_request, response) => json(response, 200, { ...good, version: '0.2.0' }),
      (_request, response) => json(response, 200, { ...good, product: 'foundation' }),
      (_request, response) => json(response, 200, { ...good, expires_in: 0 }),
      (_request, response) => json(response, 200, { ...good, expires_in: 901 }),
      (_request, response) => json(response, 200, { ...good, expires_in: 1.5 }),
      (_request, response) => json(response, 200, { ...good, expires_in: '900' }),
      (_request, response) => json(response, 200, JSON.stringify(good), 'text/plain'),
      (_request, response) => json(response, 200, JSON.stringify(good).slice(0, -1), 'application/json'),
      (_request, response) => json(response, 201, good),
      (_request, response) => json(response, 400, { error: 'something_else' }),
      // An older site, which has no check: whatever its 404 says.
      (_request, response) => json(response, 404, { error: 'not_found' }),
      (_request, response) => json(response, 404, '<!doctype html><title>Not found</title>', 'text/html'),
      (_request, response) => json(response, 200, { ...good, padding: 'x'.repeat(5000) }),
      (_request, response) => {
        response.writeHead(302, { Location: `${ORIGIN}/terminal/approve/verify` });
        response.end();
      },
    ];
    for (const [index, answerWith] of answers.entries()) {
      check = answerWith;
      checks.length = 0;
      const { term, started } = await proved();
      assert.equal(await started.run, 1, String(index));
      assert.match(term.problems(), /^Orbition's answer was not understood, so the permission was not confirmed\. Nothing was changed\.\n$/, String(index));
      assert.doesNotMatch(term.shown(), /Which project folder/);
      assert.equal(checks.length, 1, `one request only: ${String(index)}`);
    }
    assert.equal(exchanges.length, 0);
  });

  test('a site whose certificate the given authority does not vouch for is never asked', async () => {
    const other = certificate();
    const { term, started } = await proved({ argv: ['--origin', ORIGIN, '--ca', other.certPath] });
    assert.equal(await started.run, 1);
    assert.match(term.problems(), /certificate is not one --ca vouches for/);
    assert.equal(checks.length, 0);
  });

  test('a site that does not answer in time, or cuts the answer off, ends the run', async () => {
    assert.equal(VERIFY_MS, 15_000);
    check = () => {};
    let outcome = await proved({ verifyMs: 200 });
    assert.equal(await outcome.started.run, 1);
    assert.match(outcome.term.problems(), /^Could not confirm the permission: the site did not answer in time\. Nothing was changed\. Run the installer again\.\n$/);

    check = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' });
      response.write('{"status"');
      setTimeout(() => response.destroy(), 20);
    };
    outcome = await proved();
    assert.equal(await outcome.started.run, 1);
    assert.match(outcome.term.problems(), /the site could not be reached/);
    site.closeAllConnections();
  });

  test('the environment cannot widen whom the check trusts', async () => {
    // With another authority given, the site's own certificate is refused even
    // when the environment asks Node to trust it or to stop checking.
    const other = certificate();
    const script = `
      import { readFileSync } from 'node:fs';
      import { verifyConsent } from ${JSON.stringify(cli)};
      const ca = readFileSync(${JSON.stringify(other.certPath)}, 'utf8');
      verifyConsent({ origin: ${JSON.stringify(ORIGIN)}, ca, code: 'c'.repeat(43), verifier: 'v'.repeat(43), signal: new AbortController().signal })
        .then(() => console.log('answered'), (error) => console.log('refused', error.code));`;
    // Run apart, so that this process stays free to serve the site meanwhile.
    const result = await new Promise((resolve) => {
      execFile(
        process.execPath,
        ['--input-type=module', '-e', script],
        {
          encoding: 'utf8',
          env: { PATH: process.env.PATH, NODE_TLS_REJECT_UNAUTHORIZED: '0', NODE_EXTRA_CA_CERTS: CA },
          timeout: 10_000,
        },
        (_error, stdout, stderr) => resolve({ stdout, stderr }),
      );
    });
    assert.match(result.stdout, /^refused \S*(CERT|SELF_SIGNED|UNABLE)/, result.stderr);
    assert.equal(checks.length, 0);
  });

  test('Ctrl+C while the site is asked stops the run', async () => {
    check = () => {};
    const { term, started } = await proved();
    await term.waitFor(/Confirming with Orbition… $/);
    started.signals.emit('SIGINT');
    assert.equal(await started.run, 130);
    assert.match(term.shown(), /\nStopped\. Nothing was changed\.\n$/);
    site.closeAllConnections();
  });
});

describe('stopping', () => {
  test('Ctrl+C at the Enter prompt, while waiting, or at the folder question stops with nothing changed', async () => {
    // At the Enter prompt: the terminal hears Ctrl+C itself.
    let term = terminal();
    let started = start(term);
    const { port } = await term.link();
    term.type('\x03');
    assert.equal(await started.run, 130);
    assert.match(term.shown(), /\nStopped\. Nothing was changed\.\n$/);
    assert.equal(await closed(port), true);

    // While waiting for the browser: the process gets SIGINT.
    term = terminal();
    started = start(term);
    await term.link();
    term.type('\r');
    await term.waitFor(/Waiting for you to sign in and allow it/);
    started.signals.emit('SIGINT');
    assert.equal(await started.run, 130);
    assert.equal(started.signals.listenerCount('SIGINT'), 0);

    // At the folder question.
    term = terminal();
    started = start(term);
    const link = await term.link();
    await allowed(link.port, link.state);
    await term.waitFor(/Which project folder\?/);
    term.type('\x03');
    assert.equal(await started.run, 130);
    assert.equal(exchanges.length, 0);
  });

  test('input that ends at a question, or while waiting for the browser, stops the run', async () => {
    let term = terminal();
    let started = start(term);
    await term.link();
    term.stdin.end();
    assert.equal(await started.run, 1);
    assert.match(term.problems(), /No answer: the input ended\. Nothing was changed\./);

    term = terminal();
    started = start(term);
    const { port } = await term.link();
    term.type('\r');
    await term.waitFor(/Waiting for you to sign in and allow it/);
    term.stdin.end();
    assert.equal(await started.run, 1);
    assert.match(term.problems(), /No answer: the input ended\. Nothing was changed\./);
    assert.equal(await closed(port), true);
  });
});

describe('the command', () => {
  const command = (args, input = '', env = {}) =>
    spawnSync(process.execPath, [cli, ...args], {
      input,
      encoding: 'utf8',
      cwd: temporaryDirectory('cli'),
      env: { PATH: process.env.PATH, ...env },
      timeout: 10_000,
    });

  test('--help and --version answer without asking anything or signing in', () => {
    for (const flag of ['--help', '-h']) {
      const result = command([flag]);
      assert.equal(result.status, 0);
      assert.match(result.stdout, /^Adds Orbition to an existing npm or pnpm project\./);
      assert.match(result.stdout, /--origin <url>/);
      assert.match(result.stdout, /--ca <file>/);
      // A sign-out blocks what is still to be asked of the site, not an install
      // whose files are already downloaded.
      const prose = result.stdout.replace(/\s+/g, ' ');
      assert.match(
        prose,
        /Install must start within 15 minutes\. Signing out blocks any further authorization or download; once the files are downloaded, the install can still finish\./,
      );
      assert.doesNotMatch(prose, /stops it at any point/);
    }
    for (const flag of ['--version', '-v']) {
      const result = command([flag]);
      assert.deepEqual([result.status, result.stdout], [0, '0.0.0\n']);
    }
  });

  test('the site must be the local test site, https://127.0.0.1:<port>, and nothing else', () => {
    const missing = command([]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /Give it with --origin or ORBITION_ORIGIN/);
    for (const origin of [
      'https://example.com',
      'https://orbition.example:443',
      'https://localhost:3192',
      'https://[::1]:3192',
      'https://127.0.0.1',
      'https://127.0.0.1:0',
      'https://127.0.0.1:443',
      'http://127.0.0.1:3192',
      'https://127.0.0.1:3192/path',
      'https://user:secret@127.0.0.1:3192',
      'https://127.0.0.1:3192/?next=x',
      'not a url',
    ]) {
      const result = command(['--origin', origin, '--ca', CA]);
      assert.equal(result.status, 2, origin);
      assert.match(result.stderr, /must be a local test site, https:\/\/127\.0\.0\.1:<port>/, origin);
    }
    const fromEnv = command(['--ca', CA], '', { ORBITION_ORIGIN: 'https://example.com' });
    assert.match(fromEnv.stderr, /^ORBITION_ORIGIN must be a local test site/);
    assert.equal(command(['--origin', ORIGIN, '--ca', CA, 'extra']).status, 2);
  });

  test('the site’s certificate authority must be given, as a readable PEM certificate', () => {
    const none = command(['--origin', ORIGIN]);
    assert.equal(none.status, 2);
    assert.match(none.stderr, /Give its PEM file with --ca or ORBITION_CA/);
    const directory = temporaryDirectory('not-a-ca');
    const text = path.join(directory, 'notes.txt');
    writeFileSync(text, 'not a certificate\n');
    const large = path.join(directory, 'large.pem');
    writeFileSync(large, 'x'.repeat(70 * 1024));
    // Two certificates, or a certificate with anything else beside it.
    const pem = readFileSync(CA, 'utf8');
    const two = path.join(directory, 'two.pem');
    writeFileSync(two, pem + certificate().cert.toString('utf8'));
    const withKey = path.join(directory, 'with-key.pem');
    writeFileSync(withKey, `${pem}-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n`);
    for (const [file, reason] of [
      [path.join(directory, 'missing.pem'), /there is no file at/],
      [directory, /is not a file/],
      [text, /is not a PEM certificate/],
      [large, /is too large to be a certificate/],
      [two, /must hold exactly one PEM certificate and nothing else/],
      [withKey, /must hold exactly one PEM certificate and nothing else/],
    ]) {
      const result = command(['--origin', ORIGIN, '--ca', file]);
      assert.equal(result.status, 2, file);
      assert.match(result.stderr, reason, file);
    }
    const fromEnv = command(['--origin', ORIGIN], '', { ORBITION_CA: text });
    assert.match(fromEnv.stderr, /^ORBITION_CA: .*is not a PEM certificate/);
  });

  test('without an interactive terminal it stops before the browser', () => {
    const result = command(['--origin', ORIGIN, '--ca', CA], '\n');
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /needs an interactive terminal\. Nothing was changed\./);
  });
});

describe('the project folder', () => {
  test('is checked as the installer checks it: links and workspaces are refused, and it is asked again', async () => {
    const linked = makeProject({ name: 'linked-lock' });
    const realLock = path.join(temporaryDirectory('elsewhere'), 'pnpm-lock.yaml');
    writeFileSync(realLock, "lockfileVersion: '9.0'\n");
    symlinkSync(realLock, path.join(linked, 'pnpm-lock.yaml'));

    // A project inside an npm workspace, chosen through a link from outside it.
    const workspace = temporaryDirectory('workspace');
    writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ workspaces: ['member'] }));
    const member = path.join(workspace, 'member');
    mkdirSync(member);
    writeFileSync(path.join(member, 'package.json'), JSON.stringify({ name: 'member' }));
    writeFileSync(path.join(member, 'package-lock.json'), '{}');
    const shortcut = path.join(temporaryDirectory('shortcut'), 'member');
    symlinkSync(member, shortcut);

    // A folder that cannot be read.
    const locked = makeProject({ name: 'locked' });
    chmodSync(locked, 0o000);

    const good = makeProject({ name: 'good', packageManager: 'npm@11.0.0' });
    const { term, started } = await proved();
    // Each answer once the question before has had its reply.
    for (const [text, reply] of [
      [linked, /pnpm-lock\.yaml is a link or not a regular file/],
      [shortcut, /This project is part of a workspace \(.*workspace.*package\.json\)/],
      [locked, /Could not read .*: EACCES/],
    ]) {
      await term.waitFor(/Which project folder\? \(a path from here; Enter for this one\) $/);
      term.type(`${text}\r`);
      await term.waitFor(reply);
    }
    await term.waitFor(/Which project folder\? \(a path from here; Enter for this one\) $/);
    term.type(`${good}\r`);
    chmodSync(locked, 0o755);
    await cancelAtReview(term);
    assert.equal(await started.run, 1);
    assert.match(term.shown(), /good uses npm\./);
  });
});

// Keys as a terminal in raw mode sends them.
const UP = '\x1b[A';
const DOWN = '\x1b[B';

/** Waits for the list asked with `question` (and its `items` lines) past `from`, then types `keys`. */
async function inList(term, question, items, keys, from) {
  await term.waitFor(new RegExp(`${question} \\(.*\\)\\n(?:.*\\n){${String(items)}}`), from);
  term.type(keys);
}

/** Allowed, and the folder answered with Enter: the run at the product list, and where it starts. */
async function atProducts(overrides = {}) {
  // Started with pnpm, unless a test says otherwise, so the project needs no lockfile.
  const { term, started, code, link } = await proved({ env: { npm_config_user_agent: 'pnpm/10.32.1' }, ...overrides });
  await term.waitFor(/Which project folder\?.*\) $/);
  const from = term.at();
  term.type('\r');
  await term.waitFor(/What would you like to add\? \(.*\)\n(?:.*\n){3}/, from);
  return { term, started, from, code, link };
}

// The review's choices, as the list shows them.
const INSTALL_ITEM = '  ❯ Install            download and install now\n';
const ALLOW_AGAIN_ITEM = '  ❯ Allow again in your browser, then install\n';

describe('choosing what to add, and the review', () => {
  test('defaults: Design System 0.1.0 and React; the review shows what would change, and Cancel changes nothing', async () => {
    const project = makeProject({ name: 'my-app' });
    writeFileSync(path.join(project, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
    const before = snapshot(project);
    const { term, started, from } = await atProducts({ cwd: project });
    // Builder and Foundation are shown, and only the Design System can be chosen.
    assert.match(
      term.shown().slice(from),
      /\n    Builder        coming soon\n    Foundation     coming soon\n  ❯ Design System  0\.1\.0\n/,
    );
    // Up and Down cannot reach what is coming soon.
    term.type(UP);
    term.type(DOWN);
    term.type('\r');
    await inList(term, 'Which do you use\\?', 2, '', from);
    assert.match(term.shown().slice(from), /What would you like to add\? Design System 0\.1\.0\n/);
    assert.match(term.shown().slice(from), /  ❯ \[x\] React\n    \[ \] Web Components \(plain HTML\)\n/);
    term.type('\r');
    await term.waitFor(/What next\? \(.*\)\n(?:.*\n){3}/, from);
    const review = term.shown().slice(from);
    assert.match(review, /Which do you use\? React\n/);
    const directory = realpathSync(project);
    assert.ok(
      review.includes(
        [
          'Review',
          '  Project    my-app (pnpm)',
          `             ${directory}`,
          '  Adding     Design System 0.1.0: Core and React',
          '  Packages   @orbition/design-system-core 0.1.0',
          '             @orbition/design-system-react 0.1.0',
          '  Changes    vendor/orbition/orbition-design-system-core-0.1.0.tgz',
          '             vendor/orbition/orbition-design-system-react-0.1.0.tgz',
          '             (the archive names the release is expected to give)',
          '             package.json and pnpm-lock.yaml',
          '  Then       pnpm install',
          "             which can also run install scripts of the project's other dependencies.",
          '',
          'What next? (Up/Down to move, Enter to choose)',
          INSTALL_ITEM + '    Change selections',
          '    Cancel',
        ].join('\n'),
      ),
      review,
    );
    await cancelHere(term, from);
    assert.equal(await started.run, 1);
    assert.match(term.shown(), /What next\? Cancel\.\n$/);
    assert.equal(term.problems(), 'Cancelled. Nothing was changed.\n');
    assert.deepEqual(snapshot(project), before);
    // Only the one check, and nothing spent; the terminal is left out of raw mode.
    assert.equal(checks.length, 1);
    assert.equal(exchanges.length, 0);
    assert.equal(term.stdin.isRaw, false);
  });

  test('both renderers: Core once, then React and Web Components; npm names its own lockfile', async () => {
    const { term, started, from } = await atProducts({ env: { npm_config_user_agent: 'npm/11.0.0' } });
    term.type('\r');
    await inList(term, 'Which do you use\\?', 2, DOWN, from);
    await term.waitFor(/  ❯ \[ \] Web Components/, from);
    term.type(' ');
    await term.waitFor(/  ❯ \[x\] Web Components/, from);
    term.type('\r');
    await term.waitFor(/What next\? \(.*\)\n(?:.*\n){3}/, from);
    const review = term.shown().slice(from);
    assert.match(review, /Which do you use\? React and Web Components \(plain HTML\)\n/);
    assert.match(review, /Adding     Design System 0\.1\.0: Core, React and Web Components\n/);
    assert.equal(review.match(/design-system-core/g).length, 2); // one package, one archive
    assert.match(
      review,
      /Packages   @orbition\/design-system-core 0\.1\.0\n {13}@orbition\/design-system-react 0\.1\.0\n {13}@orbition\/design-system-web-components 0\.1\.0\n/,
    );
    assert.match(
      review,
      /orbition-design-system-web-components-0\.1\.0\.tgz\n {13}\(the archive names the release is expected to give\)\n {13}package\.json and package-lock\.json\n  Then       npm install\n/,
    );
    await cancelHere(term, from);
    assert.equal(await started.run, 1);
  });

  test('at least one renderer: none marked is refused, and Web Components alone is enough', async () => {
    const { term, started, from } = await atProducts();
    term.type('\r');
    await inList(term, 'Which do you use\\?', 2, ' ', from);
    await term.waitFor(/  ❯ \[ \] React/, from);
    term.type('\r');
    await term.waitFor(/Choose at least one: Space marks the one under ❯\./, from);
    assert.doesNotMatch(term.shown().slice(from), /Review/);
    term.type(DOWN);
    term.type(' ');
    await term.waitFor(/  ❯ \[x\] Web Components/, from);
    term.type('\r');
    await term.waitFor(/What next\? \(.*\)\n(?:.*\n){3}/, from);
    const review = term.shown().slice(from);
    assert.match(review, /Which do you use\? Web Components \(plain HTML\)\n/);
    assert.match(review, /Adding     Design System 0\.1\.0: Core and Web Components\n/);
    assert.doesNotMatch(review, /design-system-react/);
    await cancelHere(term, from);
    assert.equal(await started.run, 1);
  });

  test('Change selections asks again from the last answers, without the browser again', async () => {
    const { term, started, from } = await atProducts();
    term.type('\r');
    await inList(term, 'Which do you use\\?', 2, `${DOWN} `, from);
    await term.waitFor(/  ❯ \[x\] Web Components/, from);
    term.type('\r');
    await inList(term, 'What next\\?', 3, DOWN, from);
    await term.waitFor(/  ❯ Change selections/, from);
    const again = term.at();
    term.type('\r');
    await inList(term, 'What would you like to add\\?', 3, '\r', again);
    // Both still marked, as last answered: unmark React.
    await inList(term, 'Which do you use\\?', 2, '', again);
    assert.match(term.shown().slice(again), /  ❯ \[x\] React\n    \[x\] Web Components/);
    term.type(' ');
    await term.waitFor(/  ❯ \[ \] React/, again);
    term.type('\r');
    await cancelHere(term, again);
    assert.equal(await started.run, 1);
    const second = term.shown().slice(again);
    assert.match(second, /Adding     Design System 0\.1\.0: Core and Web Components\n/);
    // One link, one check, no browser opened again, nothing spent.
    assert.equal(term.shown().match(/\/terminal\/approve\?/g).length, 1);
    assert.equal(checks.length, 1);
    assert.equal(exchanges.length, 0);
    assert.equal(term.shown().match(/Which project folder\?/g).length, 1);
  });

  test('Ctrl+C, the process interrupt, Ctrl+D and the input ending each stop the run at a list', async () => {
    // Ctrl+C as the raw terminal sends it, at each list.
    for (const [question, items, before] of [
      ['What would you like to add\\?', 3, ''],
      ['Which do you use\\?', 2, '\r'],
      ['What next\\?', 3, '\r\r'],
    ]) {
      const { term, started, from } = await atProducts();
      for (const key of before) {
        const at = term.at();
        term.type(key);
        await term.waitFor(/\? [A-Z].*\n/, at);
      }
      await inList(term, question, items, '\x03', from);
      assert.equal(await started.run, 130, question);
      assert.match(term.shown(), /\nStopped\. Nothing was changed\.\n$/);
      assert.equal(term.stdin.isRaw, false);
      assert.equal(started.signals.listenerCount('SIGINT'), 0);
    }
    // The process's own interrupt.
    let { term, started } = await atProducts();
    started.signals.emit('SIGINT');
    assert.equal(await started.run, 130);
    assert.equal(term.stdin.isRaw, false);
    // Ctrl+D.
    ({ term, started } = await atProducts());
    term.type('\x04');
    assert.equal(await started.run, 1);
    assert.match(term.problems(), /No answer: the input ended\. Nothing was changed\./);
    assert.equal(term.stdin.isRaw, false);
    // The input ending.
    ({ term, started } = await atProducts());
    term.stdin.end();
    assert.equal(await started.run, 1);
    assert.match(term.problems(), /No answer: the input ended\. Nothing was changed\./);
    assert.equal(term.stdin.isRaw, false);
    assert.equal(exchanges.length, 0);
  });

  test('a project name or folder with control characters is shown as plain text', async () => {
    const parent = temporaryDirectory('odd');
    const project = path.join(parent, 'dir\x1b[31mred‮');
    mkdirSync(project);
    writeFileSync(
      path.join(project, 'package.json'),
      JSON.stringify({ name: 'evil\x1b[2J\r\n  ❯ Cancel x', packageManager: 'npm@11.0.0' }),
    );
    const { term, started, from } = await atProducts({ cwd: project });
    term.type('\r');
    await inList(term, 'Which do you use\\?', 2, '\r', from);
    await inList(term, 'What next\\?', 3, '', from);
    const written = term.written();
    for (const raw of ['\x1b[2J', '\x1b[31m', '\r\n  ❯ Cancel', ' ', '‮']) {
      assert.ok(!written.includes(raw), JSON.stringify(raw));
    }
    assert.match(term.shown(), /evil\\u001b\[2J\\u000d\\u000a  ❯ Cancel\\u2028x uses npm\./);
    assert.match(
      term.shown().slice(from),
      /  Project    evil\\u001b\[2J\\u000d\\u000a  ❯ Cancel\\u2028x \(npm\)\n {13}.*dir\\u001b\[31mred\\u202e\n/,
    );
    // The choices read as they should: Install is still the first.
    assert.match(term.shown().slice(from), /What next\? \(.*\)\n  ❯ Install /);
    await cancelHere(term, from);
    assert.equal(await started.run, 1);
  });

  test('on a narrow terminal, each redraw goes back over every row the list took', async () => {
    const columns = 20;
    const term = terminal({ columns });
    const started = start(term, { env: { npm_config_user_agent: 'pnpm/10.32.1' } });
    const { port, state } = await term.link();
    await allowed(port, state);
    await term.waitFor(/Which project folder\?.*\) $/);
    term.type('\r');
    await term.waitFor(/  ❯ Design System  0\.1\.0\n/);
    term.type('\r');
    await term.waitFor(/Which do you use\? \(.*\)\n(?:.*\n){2}/);
    const before = term.written().length;
    term.type(DOWN);
    await term.waitFor(/  ❯ \[ \] Web Components/);
    // The frame before Down, and the move back up over it.
    const written = term.written();
    const frame = written.slice(written.lastIndexOf('Which do you use? (', before), before);
    // 62 characters take 4 rows at 20 columns, 13 take 1, and 35 take 2: 7 rows.
    assert.deepEqual(
      frame.split('\n').map((line) => [...line].length),
      [62, 13, 35, 0],
    );
    assert.ok(
      written.slice(before).startsWith('\x1b[7A'),
      JSON.stringify(written.slice(before, before + 12)),
    );
    term.type('\r');
    await cancelHere(term, term.at());
    assert.equal(await started.run, 1);
  });
});

describe('installing, and allowing it again', () => {
  // A stand-in for npm, used for the project's own install where a test says
  // so: it records its arguments, whether the project was held, and its
  // environment, which those tests make wholly synthetic (fakeEnv), so nothing
  // of the machine's own is ever written down. It then exits as FAKE_STATUS
  // says, or waits when FAKE_WAIT is set.
  let fakeBin;
  before(() => {
    fakeBin = temporaryDirectory('fake-bin');
    writeFileSync(
      path.join(fakeBin, 'npm'),
      `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({
  argv: process.argv.slice(2),
  held: fs.existsSync(${JSON.stringify(INSTALL_LOCK)}),
  env: process.env,
}));
// A process left behind that holds the output, as an install script's might.
if (process.env.FAKE_LINGER) {
  const left = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  fs.writeFileSync(process.env.FAKE_RECORD + '.pid', String(left.pid));
  left.unref();
}
if (process.env.FAKE_WAIT) setTimeout(() => {}, 60000);
else process.exitCode = Number(process.env.FAKE_STATUS ?? 0);
`,
    );
    chmodSync(path.join(fakeBin, 'npm'), 0o755);
  });

  /** The environment of a run that installs: this process's (with its offline package-manager settings). */
  const installing = (agent, extra = {}) => ({ ...process.env, npm_config_user_agent: agent, ...extra });
  /**
   * A synthetic environment for a run whose own install is the fake npm: only
   * the fake and node on PATH, where to record, and the launcher. (The
   * engine's lockfile update runs with this process's environment and the
   * real npm.)
   */
  const fakeEnv = (record, extra = {}) => ({
    PATH: `${fakeBin}:${path.dirname(process.execPath)}`,
    FAKE_RECORD: record,
    npm_config_user_agent: 'npm/11.0.0',
    ...extra,
  });

  /**
   * Allowed, folder answered, the defaults or `keys` at the renderer list: the
   * run at the review's list, nothing spent yet.
   */
  async function toReview(overrides, rendererKeys = '\r') {
    const spent = exchanges.length;
    const { term, started, from, code, link } = await atProducts(overrides);
    term.type('\r');
    await inList(term, 'Which do you use\\?', 2, '', from);
    for (const key of rendererKeys) {
      term.type(key);
      await new Promise((resolve) => setImmediate(resolve));
    }
    await term.waitFor(/What next\? \(.*\)\n(?:.*\n){3}/, from);
    assert.equal(exchanges.length, spent, 'nothing is exchanged before Install');
    // `at`: where the review's list is looked for (it is shown past here).
    return { term, started, from, code, link, at: from };
  }

  /** At the review's list past `from`: Enter on its first choice. Resolves with where the answer starts. */
  async function first(term, from, item = INSTALL_ITEM) {
    await term.waitFor(/What next\? \(.*\)\n(?:.*\n){3}/, from);
    assert.ok(term.shown().slice(from).includes(item), term.shown().slice(from));
    const at = term.at();
    term.type('\r');
    return at;
  }

  /** At a review that offers to allow again (past `from`): Enter, then the new link the browser was given. */
  async function allowAgain(term, started, from) {
    const opened = started.opened.length;
    const at = await first(term, from, ALLOW_AGAIN_ITEM);
    await term.waitFor(/Allow this install of Design System 0\.1\.0 again in your browser, or press Ctrl\+C to stop\.\n/, at);
    const link = await term.link(at);
    await term.waitFor(/Waiting for you to allow it \(up to \d+ minutes?\)… $/, at);
    assert.deepEqual(started.opened.slice(opened), [link.link]);
    return { ...link, at };
  }

  const verifierOf = (seen) => JSON.parse(seen.body).code_verifier;

  test('npm, React: Install spends the permission once, then downloads and installs', async () => {
    assert.equal(EXCHANGE_MS, 15_000);
    const project = makeProject({ name: 'my-app', packageManager: 'npm@11.0.0' });
    const { term, started, code, link, at } = await toReview({ cwd: project, env: installing('npm/11.0.0') });
    await first(term, at);
    assert.equal(await started.run, 0, term.problems());
    assert.equal(await closed(link.port), true);

    // The exchange: the same code and verifier the check was made with, once.
    assert.equal(exchanges.length, 1);
    const sent = JSON.parse(exchanges[0].body);
    assert.deepEqual(Object.keys(sent).sort(), ['code', 'code_verifier']);
    assert.equal(sent.code, code);
    assert.equal(sent.code_verifier, verifierOf(checks[0]));
    assert.equal(createHash('sha256').update(sent.code_verifier).digest('base64url'), link.challenge);
    // The manifest, then Core and React only, each with the credential.
    assert.deepEqual(
      fetches.map((f) => [f.url, f.authorization]),
      [
        [`${RELEASE_PATH}/manifest`, `Bearer ${CREDENTIAL}`],
        [`${RELEASE_PATH}/archives/orbition-design-system-core-0.1.0.tgz`, `Bearer ${CREDENTIAL}`],
        [`${RELEASE_PATH}/archives/orbition-design-system-react-0.1.0.tgz`, `Bearer ${CREDENTIAL}`],
      ],
    );

    const manifest = JSON.parse(readFileSync(path.join(project, 'package.json'), 'utf8'));
    assert.deepEqual(manifest.dependencies, {
      '@orbition/design-system-core': 'file:vendor/orbition/orbition-design-system-core-0.1.0.tgz',
      '@orbition/design-system-react': 'file:vendor/orbition/orbition-design-system-react-0.1.0.tgz',
    });
    const installed = JSON.parse(
      readFileSync(path.join(project, 'node_modules/@orbition/design-system-react/package.json'), 'utf8'),
    );
    assert.equal(installed.version, '0.1.0');
    assert.ok(readFileSync(path.join(project, 'package-lock.json'), 'utf8').includes('file:vendor/orbition/'));
    assert.equal(existsSync(path.join(project, INSTALL_LOCK)), false);

    const shown = term.shown();
    assert.match(shown, /What next\? Install\.\nGetting a download credential from Orbition… received\.\n/);
    assert.match(shown, /Downloading, checking and adding Core and React… done\.\n/);
    assert.match(shown, /  Added @orbition\/design-system-core 0\.1\.0 \(vendor\/orbition\/orbition-design-system-core-0\.1\.0\.tgz\)\n/);
    assert.match(shown, /Running npm install…\n/);
    assert.match(shown, /Design System 0\.1\.0 \(Core and React\) is installed in my-app\.\n/);
    // No code, verifier or credential is ever shown or written to the project.
    const secrets = [code, sent.code_verifier, CREDENTIAL];
    for (const secret of secrets) {
      assert.ok(!shown.includes(secret) && !term.problems().includes(secret));
    }
    assert.equal(holdsAny(project, secrets), false);
  });

  test('pnpm, both renderers; run again, it finds them there and changes nothing', async () => {
    const project = makeProject({ name: 'my-app', packageManager: 'pnpm@10.32.1' });
    const env = installing('pnpm/10.32.1');
    let run = await toReview({ cwd: project, env }, [DOWN, ' ', '\r']);
    assert.match(run.term.shown().slice(run.from), /Adding     Design System 0\.1\.0: Core, React and Web Components\n/);
    await first(run.term, run.at);
    assert.equal(await run.started.run, 0, run.term.problems());
    assert.ok(existsSync(path.join(project, 'node_modules/@orbition/design-system-web-components/package.json')));
    assert.ok(existsSync(path.join(project, 'pnpm-lock.yaml')));
    assert.equal(fetches.length, 4);
    assert.equal(exchanges.length, 1);
    const before = snapshot(project);

    run = await toReview({ cwd: project, env });
    await first(run.term, run.at);
    assert.equal(await run.started.run, 0, run.term.problems());
    const shown = run.term.shown();
    assert.match(shown, /  Already there: @orbition\/design-system-core 0\.1\.0/);
    assert.match(shown, /  Already there: @orbition\/design-system-react 0\.1\.0/);
    assert.match(shown, /The project already had all of this; nothing in it changed\./);
    for (const file of ['package.json', 'pnpm-lock.yaml', 'vendor/orbition/orbition-design-system-core-0.1.0.tgz']) {
      assert.equal(snapshot(project)[file], before[file], file);
    }
    // Each run its own permission, each spent once.
    assert.equal(exchanges.length, 2);
    assert.notEqual(JSON.parse(exchanges[0].body).code, JSON.parse(exchanges[1].body).code);
  });

  test('the project is held through its own install, which gets no secret', async () => {
    const project = makeProject({ name: 'my-app', packageManager: 'npm@11.0.0' });
    const record = path.join(temporaryDirectory('record'), 'npm.json');
    const env = fakeEnv(record);
    const run = await toReview({ cwd: project, env });
    await first(run.term, run.at);
    assert.equal(await run.started.run, 0, run.term.problems());
    const seen = JSON.parse(readFileSync(record, 'utf8'));
    assert.deepEqual(seen.argv, ['install']);
    assert.equal(seen.held, true);
    // Exactly the environment the run was given: the installer adds nothing.
    // (macOS gives every new process its text encoding.)
    const names = Object.keys(seen.env).filter((name) => name !== '__CF_USER_TEXT_ENCODING');
    assert.deepEqual(names.sort(), Object.keys(env).sort());
    for (const secret of [run.code, verifierOf(exchanges[0]), CREDENTIAL]) {
      assert.ok(!JSON.stringify(seen).includes(secret));
    }
    assert.equal(existsSync(path.join(project, INSTALL_LOCK)), false);
  });

  test('its own install failing, or Ctrl+C during it, says what the project has and what to run', async () => {
    const project = makeProject({ name: 'my-app', packageManager: 'npm@11.0.0' });
    const record = path.join(temporaryDirectory('record'), 'npm.json');
    let run = await toReview({ cwd: project, env: fakeEnv(record, { FAKE_STATUS: '1' }) });
    await first(run.term, run.at);
    assert.equal(await run.started.run, 1);
    assert.match(
      run.term.problems(),
      /^npm install did not finish \(exit status 1\); node_modules may be partly changed\. Design System 0\.1\.0 is declared in package\.json, package-lock\.json and vendor\/orbition, so nothing has to be allowed again: run npm install in the project to finish\.\n$/,
    );
    assert.equal(existsSync(path.join(project, INSTALL_LOCK)), false);

    run = await toReview({ cwd: project, env: fakeEnv(record, { FAKE_WAIT: '1' }) });
    await first(run.term, run.at);
    await run.term.waitFor(/Running npm install…\n/);
    for (let tries = 0; tries < 200 && !existsSync(record); tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    rmSync(record);
    // The fake is now waiting.
    for (let tries = 0; tries < 200 && !existsSync(record); tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    run.started.signals.emit('SIGINT');
    assert.equal(await run.started.run, 130);
    assert.match(run.term.shown(), /\nStopped during npm install\. Design System 0\.1\.0 is declared in package\.json, package-lock\.json and vendor\/orbition, so nothing has to be allowed again: run npm install in the project to finish\.\n$/);
    assert.equal(existsSync(path.join(project, INSTALL_LOCK)), false);
  });

  for (const [status, error, said] of [
    [400, 'invalid_grant', /Orbition did not accept the permission to install: it ran out of time, or was already used\./],
    // Signed out in the browser between the check and Install.
    [401, 'sign_in_required', /The browser is no longer signed in to Orbition, so the permission to install has ended\./],
  ]) {
    test(`Install answered ${String(status)} ${error}: allowed again in the browser with the selections kept, then installed`, async () => {
      const project = makeProject({ name: 'my-app', packageManager: 'npm@11.0.0' });
      exchange = once((_request, response) => json(response, status, { error }), issued);
      const run = await toReview({ cwd: project, env: installing('npm/11.0.0') }, [DOWN, ' ', '\r']);
      const before = snapshot(project);
      const at = await first(run.term, run.at);
      await run.term.waitFor(/Getting a download credential from Orbition… not received\.\n/, at);
      await run.term.waitFor(said, at);
      await run.term.waitFor(/Nothing was changed\. The review is shown again with your selections: allow again in your browser to install, change the selections, or cancel\.\n/, at);
      assert.deepEqual(snapshot(project), before);
      assert.equal(fetches.length, 0);
      // The review again, with both renderers still chosen.
      await run.term.waitFor(/Adding     Design System 0\.1\.0: Core, React and Web Components\n[\s\S]*What next\?/, at);
      const again = await allowAgain(run.term, run.started, at);
      assert.notEqual(again.state, run.link.state);
      assert.notEqual(again.challenge, run.link.challenge);
      const code = await allowed(again.port, again.state);
      assert.equal(await run.started.run, 0, run.term.problems());
      assert.equal(await closed(again.port), true);
      // Checked again, then spent once: the new code and the new request's verifier.
      assert.equal(checks.length, 2);
      assert.equal(exchanges.length, 2);
      const sent = JSON.parse(exchanges[1].body);
      assert.equal(sent.code, code);
      assert.equal(sent.code_verifier, verifierOf(checks[1]));
      assert.equal(createHash('sha256').update(sent.code_verifier).digest('base64url'), again.challenge);
      assert.ok(existsSync(path.join(project, 'node_modules/@orbition/design-system-web-components/package.json')));
      assert.match(run.term.shown().slice(again.at), /Waiting for you to allow it \(up to 1 minute\)… received\.\nConfirming with Orbition… allowed\.\n  Orbition allows this one install of Design System 0\.1\.0: Install must start within 15 minutes\. Signing out blocks[^\n]*\nGetting a download credential from Orbition… received\.\n/);
      // The folder and the selections were asked once.
      assert.equal(run.term.shown().match(/Which project folder\?/g).length, 1);
      assert.equal(run.term.shown().match(/Which do you use\? [A-Z]/g).length, 1);
    });
  }

  test('a permission past its time is asked for again without spending anything; allowing again installs', async () => {
    assert.equal(CONSENT_MARGIN_MS, 30_000);
    const project = makeProject({ name: 'my-app', packageManager: 'npm@11.0.0' });
    // 60 seconds from the site, all but 0.4 of them kept as the margin for the
    // way to the site: past its time well before Install is chosen. The time
    // shown is the time that is enforced.
    check = (_request, response) =>
      json(response, 200, { status: 'approved', product: 'design-system', version: '0.1.0', expires_in: 60 });
    const run = await toReview({
      cwd: project,
      env: installing('npm/11.0.0'),
      consentMarginMs: 59_600,
    });
    assert.match(run.term.shown(), /Install must start within 1 minute\. Signing out blocks/);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const at = await first(run.term, run.at);
    await run.term.waitFor(/The permission to install ran out of time\. Nothing was changed\. The review is shown again with your selections/, at);
    assert.equal(exchanges.length, 0);
    // Allowing again gives a permission whose time also runs out at once: the
    // margin applies to it too, so it is not sent either.
    check = (_request, response) =>
      json(response, 200, { status: 'approved', product: 'design-system', version: '0.1.0', expires_in: 59 });
    let again = await allowAgain(run.term, run.started, at);
    await allowed(again.port, again.state);
    await run.term.waitFor(/Confirming with Orbition… too late\.\nThe permission had too little time left to be used\. Nothing was changed\. The review is shown again/, again.at);
    assert.equal(exchanges.length, 0);
    check = (_request, response) =>
      json(response, 200, { status: 'approved', product: 'design-system', version: '0.1.0', expires_in: 900 });
    again = await allowAgain(run.term, run.started, again.at);
    await allowed(again.port, again.state);
    assert.equal(await run.started.run, 0, run.term.problems());
    assert.match(run.term.shown().slice(again.at), /Confirming with Orbition… allowed\.\n {2}Orbition allows this one install of Design System 0\.1\.0: Install must start within 15 minutes\. Signing out blocks/);
    assert.equal(exchanges.length, 1);
    assert.equal(JSON.parse(exchanges[0].body).code_verifier, verifierOf(checks.at(-1)));
  });

  test('allowing again cancelled, out of time or not answered: the review again; a refused check is said; Cancel ends with nothing spent', async () => {
    const project = makeProject({ name: 'my-app', packageManager: 'npm@11.0.0' });
    const before = snapshot(project);
    exchange = (_request, response) => json(response, 400, { error: 'invalid_grant' });
    const run = await toReview({ cwd: project, env: installing('npm/11.0.0'), approvalMs: 2000 });
    const { term, started } = run;
    let at = await first(term, run.at);
    await term.waitFor(/The review is shown again with your selections/, at);

    let again = await allowAgain(term, started, at);
    const page = await answer(again.port, again.state, 'error=cancelled');
    assert.match(page.body, /Return to your terminal/);
    await term.waitFor(/cancelled\.\nIt was cancelled in the browser\. Nothing was changed\. The review is shown again with your selections/, again.at);
    assert.equal(await closed(again.port), true);

    again = await allowAgain(term, started, again.at);
    await answer(again.port, again.state, 'error=expired');
    await term.waitFor(/ran out of time\.\nThe request ran out of time in the browser\. Nothing was changed\./, again.at);

    again = await allowAgain(term, started, again.at);
    await term.waitFor(/ran out of time\.\nNo answer arrived in time\. Nothing was changed\./, again.at);
    assert.equal(await closed(again.port), true);

    // Allowed in the browser, but the site refuses the check: said, and the review again.
    check = (_request, response) => json(response, 401, { error: 'sign_in_required' });
    again = await allowAgain(term, started, again.at);
    await allowed(again.port, again.state);
    await term.waitFor(/Confirming with Orbition… not confirmed\.\nThe browser is no longer signed in to Orbition\. Nothing was changed\. The review is shown again with your selections/, again.at);

    await cancelHere(term, again.at);
    assert.equal(await started.run, 1);
    assert.equal(term.problems(), 'Cancelled. Nothing was changed.\n');
    // Only the first Install reached the exchange.
    assert.equal(exchanges.length, 1);
    assert.equal(fetches.length, 0);
    assert.deepEqual(snapshot(project), before);
  });

  test('allowing again refused for access, or the check refused for access: the run stops, nothing changed', async () => {
    for (const refuse of ['browser', 'check']) {
      const project = makeProject({ name: 'my-app', packageManager: 'npm@11.0.0' });
      const before = snapshot(project);
      exchange = (_request, response) => json(response, 401, { error: 'sign_in_required' });
      check = approved;
      const run = await toReview({ cwd: project, env: installing('npm/11.0.0') });
      const at = await first(run.term, run.at);
      await run.term.waitFor(/The review is shown again with your selections/, at);
      const again = await allowAgain(run.term, run.started, at);
      if (refuse === 'browser') await answer(again.port, again.state, 'error=not_entitled');
      else {
        check = (_request, response) => json(response, 403, { error: 'not_entitled' });
        await allowed(again.port, again.state);
      }
      assert.equal(await run.started.run, 1, refuse);
      assert.equal(run.term.problems(), 'This account has no current access to the Design System. Nothing was changed.\n', refuse);
      assert.equal(exchanges.length, 1, refuse);
      assert.deepEqual(snapshot(project), before);
      exchanges.length = 0;
      checks.length = 0;
    }
  });

  test('rate limited, unavailable or no answer at Install: the same permission is tried again and installs', async () => {
    const project = makeProject({ name: 'my-app', packageManager: 'npm@11.0.0' });
    const answers = [
      (_request, response) => json(response, 429, { error: 'rate_limited' }),
      (_request, response) => json(response, 503, { error: 'unavailable' }),
      (incoming) => incoming.socket.destroy(),
      issued,
    ];
    exchange = (...args) => answers.shift()(...args);
    const run = await toReview({ cwd: project, env: installing('npm/11.0.0') });
    let at = run.at;
    for (const said of [
      /Too many requests from this network\. Wait a few minutes before choosing Install again\. Nothing was changed\. The review is shown again: choose Install to try again\.\n/,
      /Orbition cannot hand out downloads right now\. Try Install again in a few minutes\. Nothing was changed\./,
      /Orbition could not be asked: the site could not be reached\. Nothing was changed\. The review is shown again: choose Install to try again\.\n/,
    ]) {
      const next = await first(run.term, at);
      await run.term.waitFor(said, next);
      at = next;
    }
    await first(run.term, at);
    assert.equal(await run.started.run, 0, run.term.problems());
    // One permission: every attempt carried the same code and verifier, and no browser was opened again.
    assert.equal(exchanges.length, 4);
    assert.equal(new Set(exchanges.map((e) => e.body)).size, 1);
    assert.equal(JSON.parse(exchanges[0].body).code, run.code);
    assert.equal(checks.length, 1);
    assert.deepEqual(run.started.opened, []);
  });

  test('access revoked before Install, or an exchange not understood: the run stops, nothing downloaded or changed', async () => {
    const project = makeProject({ name: 'my-app', packageManager: 'npm@11.0.0' });
    const before = snapshot(project);
    for (const [answerWith, message] of [
      [(_request, response) => json(response, 403, { error: 'not_entitled' }), /^This account has no current access to the Design System\. Nothing was changed\.\n$/],
      [(_request, response) => json(response, 403, { error: 'access_denied' }), /^This account cannot download yet\./],
      ...[
        { credential: CREDENTIAL, expires_in: 600, product: 'design-system', version: '0.2.0' },
        { credential: CREDENTIAL, expires_in: 600, product: 'design-system', version: '0.1.0', extra: 1 },
        { credential: 'short', expires_in: 600, product: 'design-system', version: '0.1.0' },
        { error: 'x'.repeat(8192) },
      ].map((value) => [
        (_request, response) => json(response, 200, value),
        /^Orbition's answer to the install was not understood, so nothing was downloaded\. Nothing was changed\.\n$/,
      ]),
    ]) {
      exchange = answerWith;
      const run = await toReview({ cwd: project, env: installing('npm/11.0.0') });
      await first(run.term, run.at);
      assert.equal(await run.started.run, 1);
      assert.match(run.term.problems(), message);
      assert.match(run.term.shown(), /Getting a download credential from Orbition… not received\.\n$/);
    }
    assert.equal(fetches.length, 0);
    assert.deepEqual(snapshot(project), before);
  });

  test('Ctrl+C during the exchange, or while allowing again, stops the run with nothing changed', async () => {
    const project = makeProject({ name: 'my-app', packageManager: 'npm@11.0.0' });
    const before = snapshot(project);
    exchange = () => undefined;
    let run = await toReview({ cwd: project, env: installing('npm/11.0.0') });
    await first(run.term, run.at);
    await run.term.waitFor(/Getting a download credential from Orbition… $/);
    run.started.signals.emit('SIGINT');
    assert.equal(await run.started.run, 130);
    assert.match(run.term.shown(), /\nStopped\. Nothing was changed\.\n$/);
    site.closeAllConnections();

    exchange = (_request, response) => json(response, 400, { error: 'invalid_grant' });
    run = await toReview({ cwd: project, env: installing('npm/11.0.0') });
    const at = await first(run.term, run.at);
    const again = await allowAgain(run.term, run.started, at);
    run.started.signals.emit('SIGINT');
    assert.equal(await run.started.run, 130);
    assert.equal(await closed(again.port), true);
    assert.equal(fetches.length, 0);
    assert.deepEqual(snapshot(project), before);
  });

  test('a download refused after the credential, or stopped with Ctrl+C, leaves the project as it was', async () => {
    const project = makeProject({ name: 'my-app', packageManager: 'npm@11.0.0' });
    const before = snapshot(project);
    // Access ended between the manifest and an archive; then signed out.
    for (const [status, error, message] of [
      [403, 'not_entitled', /no current access to the Design System\. Nothing was installed\./],
      [401, 'sign_in_required', /This download is no longer allowed: its permission ended, or the browser signed out\. Run the installer again to allow it\. Nothing was installed\./],
    ]) {
      serve = (incoming, response) =>
        incoming.url.endsWith('react-0.1.0.tgz') ? json(response, status, { error }) : served(incoming, response);
      const run = await toReview({ cwd: project, env: installing('npm/11.0.0') });
      await first(run.term, run.at);
      assert.equal(await run.started.run, 1);
      assert.match(run.term.shown(), /Downloading, checking and adding Core and React… stopped\.\n$/);
      assert.match(run.term.problems(), message);
      assert.deepEqual(snapshot(project), before);
    }

    // An archive that does not come: Ctrl+C.
    serve = (incoming, response) => (incoming.url.endsWith('.tgz') ? undefined : served(incoming, response));
    fetches.length = 0;
    let run = await toReview({ cwd: project, env: installing('npm/11.0.0') });
    await first(run.term, run.at);
    await run.term.waitFor(/Downloading, checking and adding Core and React… $/);
    for (let tries = 0; tries < 200 && fetches.filter((f) => f.url.endsWith('.tgz')).length === 0; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    run.started.signals.emit('SIGINT');
    assert.equal(await run.started.run, 130);
    assert.match(run.term.shown(), /stopped\.\n\nStopped\. Nothing was changed\.\n$/);
    assert.deepEqual(snapshot(project), before);
    site.closeAllConnections();

    // While the manifest is still on its way: the same.
    serve = () => undefined;
    fetches.length = 0;
    run = await toReview({ cwd: project, env: installing('npm/11.0.0') });
    await first(run.term, run.at);
    for (let tries = 0; tries < 200 && fetches.length === 0; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    run.started.signals.emit('SIGINT');
    assert.equal(await run.started.run, 130);
    assert.match(run.term.shown(), /Downloading, checking and adding Core and React… stopped\.\n\nStopped\. Nothing was changed\.\n$/);
    assert.deepEqual(snapshot(project), before);
    site.closeAllConnections();
  });

  test('the reviewed package manager: a change before Install, or while allowing again, is reviewed again; one during the download is not written', async () => {
    // Before Install: the review again with what the project uses now; nothing spent.
    let project = makeProject({ name: 'my-app', packageManager: 'npm@11.0.0' });
    let run = await toReview({ cwd: project, env: installing('npm/11.0.0') });
    assert.match(run.term.shown().slice(run.from), /Project    my-app \(npm\)/);
    writeFileSync(path.join(project, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
    let at = await first(run.term, run.at);
    await run.term.waitFor(/The project now uses pnpm, not npm\. Nothing was changed\. Review it again:\n/, at);
    await run.term.waitFor(/Project    my-app \(pnpm\)[\s\S]*What next\? \(.*\)\n(?:.*\n){3}/, at);
    assert.deepEqual(run.started.opened, []);
    assert.equal(exchanges.length, 0);
    await cancelHere(run.term, at);
    assert.equal(await run.started.run, 1);

    // While allowing again in the browser: the new permission is kept, and the review shown again.
    exchange = once((_request, response) => json(response, 400, { error: 'invalid_grant' }), issued);
    project = makeProject({ name: 'my-app', packageManager: 'npm@11.0.0' });
    run = await toReview({ cwd: project, env: installing('npm/11.0.0') });
    at = await first(run.term, run.at);
    const again = await allowAgain(run.term, run.started, at);
    writeFileSync(path.join(project, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
    await allowed(again.port, again.state);
    await run.term.waitFor(/allowed\.\n  Orbition allows this one install[^\n]*\n\nThe project now uses pnpm, not npm\. Nothing was changed\. Review it again:\n/, again.at);
    assert.equal(exchanges.length, 1);
    await cancelHere(run.term, again.at);
    assert.equal(await run.started.run, 1);
    exchanges.length = 0;

    // During the download: the install stops before writing anything.
    project = makeProject({ name: 'my-app', packageManager: 'npm@11.0.0' });
    const changing = project;
    serve = (incoming, response) => {
      if (incoming.url.endsWith('/manifest')) writeFileSync(path.join(changing, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
      return served(incoming, response);
    };
    run = await toReview({ cwd: project, env: installing('npm/11.0.0') });
    const before = { ...snapshot(project), 'pnpm-lock.yaml': Buffer.from("lockfileVersion: '9.0'\n").toString('base64') };
    await first(run.term, run.at);
    assert.equal(await run.started.run, 1);
    assert.match(run.term.problems(), /now uses pnpm/);
    assert.match(run.term.problems(), /Nothing was changed/);
    assert.deepEqual(snapshot(project), before);
  });

  test('a project the install would refuse is refused at the review, before anything is spent', async () => {
    for (const [prepare, message] of [
      [
        (project) => writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'my-app', packageManager: 'npm@11.0.0', dependencies: { '@orbition/design-system-react': '^1.0.0' } })),
        /already declares @orbition\/design-system-react in dependencies as "\^1\.0\.0"\. This release is 0\.1\.0, and replacing an installed version is not supported yet\. Nothing was changed\.\n$/,
      ],
      [
        (project) => writeFileSync(path.join(project, INSTALL_LOCK), ''),
        /Another installer is working in this project, or one stopped before it finished/,
      ],
    ]) {
      const project = makeProject({ name: 'my-app', packageManager: 'npm@11.0.0' });
      prepare(project);
      const before = snapshot(project);
      const { term, started, from } = await atProducts({ cwd: project, env: installing('npm/11.0.0') });
      term.type('\r');
      await inList(term, 'Which do you use\\?', 2, '\r', from);
      assert.equal(await started.run, 1);
      assert.match(term.problems(), message);
      assert.doesNotMatch(term.shown(), /Review/);
      assert.equal(exchanges.length, 0);
      assert.deepEqual(snapshot(project), before);
    }
  });

  test('a file system error while writing stops the run, saying the project was put back', async () => {
    const project = makeProject({ name: 'my-app', packageManager: 'npm@11.0.0' });
    mkdirSync(path.join(project, 'vendor'));
    chmodSync(path.join(project, 'vendor'), 0o555);
    const before = snapshot(project);
    try {
      const run = await toReview({ cwd: project, env: installing('npm/11.0.0') });
      await first(run.term, run.at);
      assert.equal(await run.started.run, 1);
      assert.match(run.term.shown(), /Downloading, checking and adding Core and React… stopped\.\n$/);
      assert.match(run.term.problems(), /^Could not install: EACCES[^\n]*\n\nThe project was put back as it was\.\n$/);
      assert.deepEqual(snapshot(project), before);
    } finally {
      chmodSync(path.join(project, 'vendor'), 0o755);
    }
  });

  test('a declared archive that is missing is downloaded again', async () => {
    const project = makeProject({
      name: 'my-app',
      packageManager: 'npm@11.0.0',
      dependencies: {
        '@orbition/design-system-core': 'file:vendor/orbition/orbition-design-system-core-0.1.0.tgz',
        '@orbition/design-system-react': 'file:vendor/orbition/orbition-design-system-react-0.1.0.tgz',
      },
    });
    const run = await toReview({ cwd: project, env: installing('npm/11.0.0') });
    await first(run.term, run.at);
    assert.equal(await run.started.run, 0, run.term.problems());
    assert.ok(existsSync(path.join(project, 'vendor/orbition/orbition-design-system-react-0.1.0.tgz')));
    assert.match(run.term.shown(), /  Added @orbition\/design-system-react 0\.1\.0/);
  });

  test('a process the install leaves behind holding its output does not keep the project held', async () => {
    const project = makeProject({ name: 'my-app', packageManager: 'npm@11.0.0' });
    const record = path.join(temporaryDirectory('record'), 'npm.json');
    const run = await toReview({ cwd: project, env: fakeEnv(record, { FAKE_LINGER: '1' }) });
    await first(run.term, run.at);
    const started = Date.now();
    try {
      assert.equal(await run.started.run, 0, run.term.problems());
      assert.ok(Date.now() - started < 15_000);
      assert.equal(existsSync(path.join(project, INSTALL_LOCK)), false);
    } finally {
      if (existsSync(`${record}.pid`)) {
        try {
          process.kill(Number(readFileSync(`${record}.pid`, 'utf8')));
        } catch {
          // Already gone.
        }
      }
    }
  });
});
