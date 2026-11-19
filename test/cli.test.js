// The command (src/cli.js), run with a stand-in terminal, a stand-in for the
// browser (requests to the run's own listener) and a local HTTPS stand-in for
// the site's verify address, with a throwaway certificate for 127.0.0.1. No
// real site, account or browser is involved.
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:https';
import { connect } from 'node:net';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, beforeEach, describe, test } from 'node:test';

import { main, SIGN_IN_MS, VERIFY_MS } from '../src/cli.js';
import { certificate, makeProject, snapshot, temporaryDirectory } from './helpers.js';

const cli = path.resolve(import.meta.dirname, '../src/cli.js');

// The site's stand-in: what it was sent, and how it answers the current test.
let site;
let ORIGIN;
let CA;
const proofs = [];
let respond;
const json = (response, status, value, type = 'application/json; charset=utf-8') => {
  response.writeHead(status, { 'Content-Type': type });
  response.end(typeof value === 'string' ? value : JSON.stringify(value));
};
const confirmed = (_request, response) => json(response, 200, { status: 'signed_in' });

before(async () => {
  const tls = certificate();
  CA = tls.certPath;
  site = createServer({ key: tls.key, cert: tls.cert }, (incoming, response) => {
    let body = '';
    incoming.setEncoding('utf8');
    incoming.on('data', (chunk) => (body += chunk));
    incoming.on('end', () => {
      proofs.push({
        method: incoming.method,
        url: incoming.url,
        type: incoming.headers['content-type'],
        body,
      });
      respond(incoming, response, body);
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
  proofs.length = 0;
  respond = confirmed;
});

/** A terminal for one run: what it shows, and a way to type into it. */
function terminal() {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin });
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 1000 });
  const stderr = new PassThrough();
  let shown = '';
  let problems = '';
  // What a person would read: readline's cursor movements left out.
  stdout.on('data', (chunk) => (shown += String(chunk).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')));
  stderr.on('data', (chunk) => (problems += chunk));
  const waitFor = async (pattern) => {
    for (let tries = 0; tries < 400; tries += 1) {
      const found = pattern.exec(shown);
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
    problems: () => problems,
    type: (text) => stdin.write(text),
    waitFor,
    /** The sign-in link shown, and the port, state and challenge in it. */
    link: async () => {
      const [link, port, state, challenge] = await waitFor(
        /https:\/\/127\.0\.0\.1:\d+\/terminal\/sign-in\?port=(\d+)&state=([A-Za-z0-9_-]+)&code_challenge=([A-Za-z0-9_-]{43})&code_challenge_method=S256/,
      );
      return { link, port: Number(port), state, challenge };
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

/** The site's callback: an outcome, and for a sign-in a one-time code. */
const answer = (port, state, result, code) =>
  visit(port, `/callback?state=${state}&result=${result}${code === undefined ? '' : `&code=${code}`}`);
const newCode = () => randomBytes(32).toString('base64url');
/** The browser's signed_in, with a fresh code; resolves with the code. */
const signedIn = async (port, state) => {
  const code = newCode();
  await answer(port, state, 'signed_in', code);
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
    signInMs: 120_000,
    ...overrides,
  });
  return { run, opened, signals };
}

/** Signs in by hand (no Enter): the run, its terminal and the code the site sent. */
async function proved(overrides = {}) {
  const term = terminal();
  const started = start(term, overrides);
  const { port, state } = await term.link();
  const code = await signedIn(port, state);
  return { term, started, code };
}

describe('signing in', () => {
  test('Enter opens the link; the site confirms the proof; the folder is checked and nothing is changed', async () => {
    const project = makeProject({ name: 'my-app' });
    writeFileSync(path.join(project, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
    const before = snapshot(project);
    const term = terminal();
    const { run, opened } = start(term, { cwd: project });

    await term.waitFor(/◆ Welcome to Orbition/);
    await term.waitFor(new RegExp(`Signing in on ${ORIGIN.replaceAll('.', '\\.')} \\(from --origin\\)\\.`));
    const { link, port, state, challenge } = await term.link();
    assert.ok(state.length >= 43);
    term.type('\r');
    await term.waitFor(/Waiting for you to sign in \(up to 2 minutes\)… $/);
    assert.deepEqual(opened, [link]);

    const code = newCode();
    const page = await answer(port, state, 'signed_in', code);
    assert.equal(page.status, 200);
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.match(page.headers['content-security-policy'], /default-src 'none'/);
    assert.match(page.body, /confirming your sign-in/);

    await term.waitFor(/received\.\nConfirming your sign-in with Orbition… signed in\.\n/);
    await term.waitFor(/Which project folder\? \(a path from here; Enter for this one\) $/);
    // One answer is all it takes: nothing listens at the folder question.
    assert.equal(await closed(port), true);

    // The proof: exactly the code and this run's verifier, whose challenge the link carried.
    assert.equal(proofs.length, 1);
    const [proof] = proofs;
    assert.deepEqual([proof.method, proof.url, proof.type], ['POST', '/terminal/sign-in/verify', 'application/json']);
    const sent = JSON.parse(proof.body);
    assert.deepEqual(Object.keys(sent).sort(), ['code', 'code_verifier']);
    assert.equal(sent.code, code);
    assert.match(sent.code_verifier, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(createHash('sha256').update(sent.code_verifier).digest('base64url'), challenge);

    term.type('missing-folder\r');
    await term.waitFor(/There is no folder at .*missing-folder\./);
    term.type('\r');
    assert.equal(await run, 0);
    assert.match(term.shown(), /  my-app uses pnpm\.\n/);
    assert.match(term.shown(), /Nothing was changed\.\n$/);
    assert.deepEqual(snapshot(project), before);
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
    assert.equal(await started.run, 0);
    assert.deepEqual(started.opened, []);
    assert.doesNotMatch(term.shown(), /Waiting for you to sign in/);
    assert.match(term.shown(), /\nConfirming your sign-in with Orbition… signed in\.\n/);
    // No lockfile and no packageManager field: the launcher decides.
    assert.match(term.shown(), /my-app uses pnpm\./);
  });

  test('only this run’s well-formed answer counts; anything else is refused and the run keeps waiting', async () => {
    const term = terminal();
    const { run } = start(term);
    const { port, state } = await term.link();
    const other = 'A'.repeat(state.length);
    const code = newCode();
    const refused = [
      [visit(port, `/callback?state=${other}&result=signed_in&code=${code}`), 400],
      [visit(port, `/callback?state=${state}`), 404],
      [visit(port, `/callback?state=${state}&result=signed_in&code=${code}&next=x`), 404],
      [visit(port, `/callback?state=${state}&result=signed_in&code=${code}&code=${code}`), 404],
      [visit(port, `/elsewhere?state=${state}&result=signed_in&code=${code}`), 404],
      [visit(port, `/callback?state=${state}&result=granted`), 400],
      // A code only with signed_in, and only one the site could have made.
      [visit(port, `/callback?state=${state}&result=cancelled&code=${code}`), 400],
      [visit(port, `/callback?state=${state}&result=signed_in&code=short`), 400],
      [visit(port, `/callback?state=${state}&result=signed_in&code=`), 400],
      [visit(port, `/callback?state=${state}&result=signed_in&code=${code}`, { method: 'POST' }), 405],
      [
        visit(port, `/callback?state=${state}&result=signed_in&code=${code}`, {
          host: `localhost:${String(port)}`,
        }),
        400,
      ],
    ];
    for (const [response, status] of refused) assert.equal((await response).status, status);
    // Targets that are not a path are refused, not thrown.
    assert.equal(await raw(port, `http://127.0.0.1:${String(port)}/callback?state=${state}&result=cancelled`), 400);
    assert.equal(await raw(port, '*'), 400);
    assert.equal(await raw(port, '//[bad/callback'), 404);
    assert.equal(await raw(port, `//evil.example/callback?state=${state}&result=cancelled`), 404);

    const page = await answer(port, state, 'cancelled');
    assert.match(page.body, /Cancelled/);
    assert.equal(await run, 1);
    assert.match(term.problems(), /Signing in was cancelled in the browser\. Nothing was changed\./);
    assert.doesNotMatch(term.shown(), /Which project folder/);
    assert.equal(proofs.length, 0);
  });

  test('a signed_in without a code (the older status-only answer) is not a sign-in', async () => {
    const term = terminal();
    const { run } = start(term);
    const { port, state } = await term.link();
    term.type('\r');
    await term.waitFor(/Waiting for you to sign in/);
    const page = await answer(port, state, 'signed_in');
    assert.match(page.body, /Not confirmed/);
    assert.equal(await run, 1);
    assert.match(term.shown(), /not confirmed\.\n/);
    assert.match(term.problems(), /answered without a sign-in code, so the sign-in cannot be confirmed/);
    assert.doesNotMatch(term.shown(), /Which project folder/);
    assert.equal(proofs.length, 0);
  });

  test('an answer that the request ran out of time ends the run', async () => {
    const term = terminal();
    const { run } = start(term);
    const { port, state } = await term.link();
    term.type('\r');
    await answer(port, state, 'expired');
    assert.equal(await run, 1);
    assert.match(term.problems(), /Run the installer again to sign in\. Nothing was changed\./);
    assert.equal(proofs.length, 0);
  });

  test('the limit is the site’s: ten minutes, set again when the browser is opened', async () => {
    assert.equal(SIGN_IN_MS, 10 * 60 * 1000);
    const term = terminal();
    const { run } = start(term, { signInMs: 3000, env: { npm_config_user_agent: 'npm/11.0.0' } });
    const { port, state } = await term.link();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    term.type('\r');
    await term.waitFor(/up to 1 minute\)… $/);
    // Past the first limit, but within the one set at Enter.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await signedIn(port, state);
    await term.waitFor(/Which project folder\?/);
    term.type('\r');
    assert.equal(await run, 0);
  });

  test('typing while the browser is used does not answer the next question', async () => {
    const term = terminal();
    const { run } = start(term, { env: { npm_config_user_agent: 'npm/11.0.0' } });
    const { port, state } = await term.link();
    term.type('\r');
    await term.waitFor(/Waiting for you to sign in/);
    term.type('somewhere\r\r');
    await new Promise((resolve) => setTimeout(resolve, 50));
    await signedIn(port, state);
    await term.waitFor(/Which project folder\?.*\) $/);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.doesNotMatch(term.shown(), /uses npm|There is no folder/);
    term.type('\r');
    assert.equal(await run, 0);
    assert.match(term.shown(), /my-app uses npm\./);
  });

  test('with no answer in time, the run ends and stops listening', async () => {
    const term = terminal();
    const { run } = start(term, { signInMs: 150 });
    const { port } = await term.link();
    assert.equal(await run, 1);
    assert.match(term.problems(), /Signing in ran out of time/);
    assert.equal(await closed(port), true);
  });
});

describe('the proof', () => {
  test('each refusal from the site ends the run with its own reason', async () => {
    const cases = [
      [400, 'invalid_grant', /did not accept this sign-in/],
      [401, 'sign_in_required', /no longer signed in/],
      [403, 'access_denied', /cannot be used with the installer right now/],
      [429, 'rate_limited', /Too many sign-in checks/],
      [503, 'unavailable', /cannot confirm sign-ins right now/],
    ];
    for (const [status, error, reason] of cases) {
      respond = (_request, response) => json(response, status, { error });
      const { term, started } = await proved();
      assert.equal(await started.run, 1, error);
      assert.match(term.shown(), /Confirming your sign-in with Orbition… not confirmed\.\n/);
      assert.match(term.problems(), reason, error);
      assert.doesNotMatch(term.shown(), /Which project folder/);
    }
  });

  test('anything but exactly 200 {"status":"signed_in"} is not a sign-in, and no redirect is followed', async () => {
    const answers = [
      (_request, response) => json(response, 200, { status: 'ok' }),
      (_request, response) => json(response, 200, { status: 'signed_in', account: 'x' }),
      (_request, response) => json(response, 200, 'signed_in', 'text/plain'),
      (_request, response) => json(response, 200, '{"status":"signed_in"', 'application/json'),
      (_request, response) => json(response, 201, { status: 'signed_in' }),
      (_request, response) => json(response, 400, { error: 'something_else' }),
      (_request, response) => json(response, 200, { status: 'signed_in', padding: 'x'.repeat(5000) }),
      (_request, response) => {
        response.writeHead(302, { Location: `${ORIGIN}/terminal/sign-in/verify` });
        response.end();
      },
    ];
    for (const [index, answerWith] of answers.entries()) {
      respond = answerWith;
      proofs.length = 0;
      const { term, started } = await proved();
      assert.equal(await started.run, 1, String(index));
      assert.match(term.problems(), /answer was not understood, so the sign-in was not confirmed/, String(index));
      assert.doesNotMatch(term.shown(), /Which project folder/);
      assert.equal(proofs.length, 1, `one request only: ${String(index)}`);
    }
  });

  test('a site whose certificate the given authority does not vouch for is never asked', async () => {
    const other = certificate();
    const { term, started } = await proved({ argv: ['--origin', ORIGIN, '--ca', other.certPath] });
    assert.equal(await started.run, 1);
    assert.match(term.problems(), /certificate is not one --ca vouches for/);
    assert.equal(proofs.length, 0);
  });

  test('a site that does not answer in time, or cuts the answer off, ends the run', async () => {
    assert.equal(VERIFY_MS, 15_000);
    respond = () => {};
    let outcome = await proved({ verifyMs: 200 });
    assert.equal(await outcome.started.run, 1);
    assert.match(outcome.term.problems(), /the site did not answer in time/);

    respond = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' });
      response.write('{"status"');
      setTimeout(() => response.destroy(), 20);
    };
    outcome = await proved();
    assert.equal(await outcome.started.run, 1);
    assert.match(outcome.term.problems(), /the site could not be reached/);
  });

  test('the environment cannot widen whom the proof trusts', async () => {
    // With another authority given, the site's own certificate is refused even
    // when the environment asks Node to trust it or to stop checking.
    const other = certificate();
    const script = `
      import { readFileSync } from 'node:fs';
      import { proveSignIn } from ${JSON.stringify(cli)};
      const ca = readFileSync(${JSON.stringify(other.certPath)}, 'utf8');
      proveSignIn({ origin: ${JSON.stringify(ORIGIN)}, ca, code: 'c'.repeat(43), verifier: 'v'.repeat(43), signal: new AbortController().signal })
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
    assert.equal(proofs.length, 0);
  });

  test('Ctrl+C while the site is asked stops the run', async () => {
    respond = () => {};
    const { term, started } = await proved();
    await term.waitFor(/Confirming your sign-in with Orbition… $/);
    started.signals.emit('SIGINT');
    assert.equal(await started.run, 130);
    assert.match(term.shown(), /\nStopped\. Nothing was changed\.\n$/);
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
    await term.waitFor(/Waiting for you to sign in/);
    started.signals.emit('SIGINT');
    assert.equal(await started.run, 130);
    assert.equal(started.signals.listenerCount('SIGINT'), 0);

    // At the folder question.
    term = terminal();
    started = start(term);
    const link = await term.link();
    await signedIn(link.port, link.state);
    await term.waitFor(/Which project folder\?/);
    term.type('\x03');
    assert.equal(await started.run, 130);
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
    await term.waitFor(/Waiting for you to sign in/);
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

  test('without an interactive terminal it stops before signing in', () => {
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
    assert.equal(await started.run, 0);
    assert.match(term.shown(), /good uses npm\./);
  });
});
