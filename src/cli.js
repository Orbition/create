#!/usr/bin/env node
// The installer's command: `npm create @orbition`, `npx @orbition/create` or
// `pnpm dlx @orbition/create` once published, `node src/cli.js` in a checkout.
//
// So far it welcomes the person, has them sign in in the browser, confirms
// that sign-in with the site, asks for the project folder and checks it, then
// stops. Choosing what to add, approving a release and downloading come
// later. Nothing in the project is changed.
//
// The site: until the Orbition site's address is confirmed, only a local test
// site at https://127.0.0.1:<port> is accepted (--origin or ORBITION_ORIGIN),
// with its certificate authority given explicitly (--ca or ORBITION_CA; each
// flag wins over its variable). That file is the only authority trusted for
// the site, and the certificate is always checked: no other host can vouch for
// Orbition here.
//
// Network, in order:
//
//   <origin>/terminal/sign-in?port=<port>&state=<state>
//     &code_challenge=<S256>&code_challenge_method=S256      (in the browser)
//   http://127.0.0.1:<port>/callback?state=<state>&result=signed_in&code=<code>
//                                                            (to this command)
//   POST <origin>/terminal/sign-in/verify {code, code_verifier}  (this command)
//
// The run makes a fresh random state and PKCE verifier; only the challenge
// leaves it before the proof. The callback is only a hand-off: anything that
// can reach the port with the state could send one, so a sign-in counts only
// when the site answers the proof, made with this run's own verifier, with
// exactly 200 {"status":"signed_in"}. A callback without a code (the site's
// older status-only answer) is not accepted as a sign-in. The code and the
// verifier are never shown or logged. What follows reads only local files,
// and every protected step (approval, credential, download) is checked by the
// site.
import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual, X509Certificate } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { InstallError } from './errors.js';
import { checkProject } from './install.js';

/** How long the browser has to sign in once the link is shown, as on the site. */
export const SIGN_IN_MS = 10 * 60 * 1000;
/** How long the site has to answer the proof, from the request to its last byte. */
export const VERIFY_MS = 15_000;
/** The most a certificate file, or the site's answer to the proof, may weigh. */
const MAX_CA_BYTES = 64 * 1024;
const MAX_ANSWER_BYTES = 4096;
/** A one-time code, as the site makes them: base64url of 32 bytes. */
const CODE = /^[A-Za-z0-9_-]{43}$/;

// What the site may send this command, and what each means here.
const RESULTS = new Set(['signed_in', 'cancelled', 'expired']);
const PAGES = {
  signed_in: ['Back to your terminal', 'The terminal is now confirming your sign-in with Orbition. You can close this tab.'],
  unconfirmed: [
    'Not confirmed',
    'This answer had no sign-in code, so the terminal cannot confirm it. Nothing was changed. Run the installer again.',
  ],
  cancelled: ['Cancelled', 'Nothing was changed. You can close this tab.'],
  expired: [
    'This sign-in ran out of time',
    'Nothing was changed. Run the installer again to sign in.',
  ],
};

// The site's refusals of the proof, by status and error, and what to say.
const REFUSALS = {
  '400 invalid_grant':
    'Orbition did not accept this sign-in: it was already used, ran out of time, or belongs to another run. Run the installer again.',
  '401 sign_in_required':
    'The browser is no longer signed in to Orbition. Run the installer again and sign in.',
  '403 access_denied':
    'This account cannot be used with the installer right now. Check it on the Orbition site, then run the installer again.',
  '429 rate_limited':
    'Too many sign-in checks from this network. Try again in a few minutes.',
  '503 unavailable': 'Orbition cannot confirm sign-ins right now. Try again later.',
};

const HELP = `Adds Orbition to an existing npm or pnpm project.

For now it signs you in in your browser, asks for the project folder and checks
it, then stops. Nothing is changed.

Usage:
  node src/cli.js [--origin <url>] [--ca <file>]    (in a checkout)
  npx @orbition/create [--origin <url>] [--ca <file>]    (once published)

Options:
  --origin <url>  The Orbition site to sign in on. Until the Orbition site
                  is confirmed, only a local test site is accepted, as
                  https://127.0.0.1:<port> (a port other than 443). Without
                  it, ORBITION_ORIGIN is used; one of the two is required.
  --ca <file>     The local test site's certificate authority: a PEM file
                  holding exactly one certificate, the only one trusted for
                  that site. Without it, ORBITION_CA is used; one of the two
                  is required.
  -h, --help      Show this help.
  -v, --version   Show the version.
`;

/** A stop with what to tell the person and the exit status. */
class Stop extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * The site, only as the local test site: https://127.0.0.1 with a port, and
 * nothing else. No other host is accepted until the Orbition site is
 * confirmed.
 */
function siteOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const exact = `${url.origin}/` === url.href && !url.username && !url.password;
  // A port written out (443 is the default, so it never is) and not 0.
  const local = url.hostname === '127.0.0.1' && Number(url.port) >= 1;
  return url.protocol === 'https:' && exact && local ? url.origin : null;
}

/** The certificate authority file's PEM text, or why it cannot be used. */
function readAuthority(file) {
  let stats;
  try {
    stats = statSync(file);
  } catch {
    return { problem: `there is no file at ${file}` };
  }
  if (!stats.isFile()) return { problem: `${file} is not a file` };
  if (stats.size > MAX_CA_BYTES) return { problem: `${file} is too large to be a certificate` };
  let pem;
  try {
    pem = readFileSync(file, 'utf8');
    new X509Certificate(pem);
  } catch {
    return { problem: `${file} is not a PEM certificate` };
  }
  // Exactly one certificate, and nothing else, is trusted.
  const blocks = pem.match(/-----BEGIN [^-]+-----/g) ?? [];
  if (blocks.length !== 1 || blocks[0] !== '-----BEGIN CERTIFICATE-----') {
    return { problem: `${file} must hold exactly one PEM certificate and nothing else` };
  }
  return { pem };
}

/**
 * The proof: POST {code, code_verifier} to the site's verify address, with
 * the given authority as the only one trusted and the certificate always
 * checked, no redirect followed and a time limit. Resolves with the status,
 * the media type and the body (up to MAX_ANSWER_BYTES, else `overflow`);
 * rejects when no whole answer arrived.
 */
export function proveSignIn({ origin, ca, code, verifier, signal, timeoutMs = VERIFY_MS }) {
  const payload = JSON.stringify({ code, code_verifier: verifier });
  return new Promise((resolve, reject) => {
    const outgoing = httpsRequest(
      new URL('/terminal/sign-in/verify', origin),
      {
        method: 'POST',
        agent: false,
        ca,
        rejectUnauthorized: true,
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Accept: 'application/json',
        },
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_ANSWER_BYTES) {
            resolve({ status: response.statusCode, overflow: true });
            outgoing.destroy();
          } else chunks.push(chunk);
        });
        response.on('end', () => {
          if (!response.complete) return reject(new Error('the connection closed early'));
          resolve({
            status: response.statusCode,
            type: (response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase(),
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        response.on('error', reject);
      },
    );
    outgoing.on('error', reject);
    outgoing.end(payload);
  });
}

/** Whether the site's answer to the proof is exactly a confirmed sign-in, or else what to say. */
function readProof(answer) {
  let value;
  try {
    value = answer.type === 'application/json' && !answer.overflow ? JSON.parse(answer.body) : null;
  } catch {
    value = null;
  }
  const keys = value !== null && typeof value === 'object' ? Object.keys(value) : [];
  if (answer.status === 200 && keys.length === 1 && value.status === 'signed_in') return { confirmed: true };
  const refusal = keys.length === 1 && typeof value.error === 'string' ? REFUSALS[`${String(answer.status)} ${value.error}`] : undefined;
  return {
    confirmed: false,
    message: refusal ?? "Orbition's answer was not understood, so the sign-in was not confirmed. Nothing was changed.",
  };
}

/** The package manager the command was started with, if a launcher says so. */
function launcher(env) {
  return /^([a-z]+)\//.exec(env.npm_config_user_agent ?? '')?.[1];
}

/**
 * Opens a URL in the default browser, with the platform's own opener and no
 * shell. Resolves whether an opener could be started.
 */
export function openInBrowser(url, platform = process.platform) {
  const command = { darwin: 'open', linux: 'xdg-open' }[platform];
  if (!command) return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn(command, [url], { stdio: 'ignore', detached: true });
    child.on('error', () => resolve(false));
    child.on('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

const page = (title, text) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title} · Orbition</title>` +
  `<h1>${title}</h1><p>${text}</p></html>\n`;

/**
 * Listens on 127.0.0.1 for the site's answer to this run. `answer` resolves
 * with `{ result, code }` the first time a well-formed request carries this
 * run's state: signed_in with a code, cancelled or expired without one, or
 * signed_in without a code, which is answered as unconfirmed. Everything else
 * is refused and the listener keeps waiting.
 */
async function listenForAnswer(state) {
  let settle;
  const answer = new Promise((resolve) => (settle = resolve));
  let answered = false;
  let port;

  const server = createServer((request, response) => {
    const reply = (status, title, text) => {
      response.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(page(title, text));
    };
    // Only this address, as the site builds it: no other name for it.
    if (request.headers.host !== `127.0.0.1:${String(port)}`) {
      return reply(400, 'Not for this address', 'This page only answers at 127.0.0.1.');
    }
    if (request.method !== 'GET') return reply(405, 'Not allowed', 'Only GET is answered.');
    // A path, nothing else; whatever cannot be read as one is refused.
    let url;
    try {
      if (!request.url?.startsWith('/')) throw new Error('not a path');
      // Appended, not resolved: `//host/callback` stays a path, and is not found.
      url = new URL(`http://127.0.0.1:${String(port)}${request.url}`);
    } catch {
      return reply(400, 'Not understood', 'The request was not understood.');
    }
    const keys = [...url.searchParams.keys()].sort().join(',');
    if (url.pathname !== '/callback' || (keys !== 'result,state' && keys !== 'code,result,state')) {
      return reply(404, 'Not found', 'There is nothing here.');
    }
    const given = Buffer.from(url.searchParams.get('state') ?? '');
    const expected = Buffer.from(state);
    const result = url.searchParams.get('result') ?? '';
    if (answered) {
      return reply(410, 'Already answered', 'The terminal already has its answer.');
    }
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return reply(
        400,
        'Not this sign-in',
        'This answer is for another installer run. Use the link the terminal shows now.',
      );
    }
    const code = url.searchParams.get('code');
    const understood =
      RESULTS.has(result) &&
      (code === null || (result === 'signed_in' && CODE.test(code)));
    if (!understood) return reply(400, 'Not understood', 'The answer was not understood.');
    answered = true;
    // A signed_in without a code is the site's older status-only answer: not
    // a sign-in this command can confirm.
    const kind = result === 'signed_in' && code === null ? 'unconfirmed' : result;
    // The run goes on, and stops listening, once this page has been sent.
    response.once('close', () => settle({ result: kind, code }));
    reply(200, ...PAGES[kind]);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  }).catch(() => {
    throw new Stop('Could not listen on 127.0.0.1 for the sign-in answer. Nothing was changed.', 1);
  });
  port = server.address().port;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    server.close();
    server.closeAllConnections();
  };
  if (port < 1024) {
    close();
    throw new Stop('The system gave a port below 1024 to listen on. Run the installer again.', 1);
  }
  return { port, answer, close };
}

/**
 * Runs the command. Resolves with the exit status: 0 done, 1 stopped with a
 * reason, 2 used wrongly, 130 stopped with Ctrl+C.
 */
export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  cwd = process.cwd(),
  signals = process,
  openUrl = openInBrowser,
  signInMs = SIGN_IN_MS,
  verifyMs = VERIFY_MS,
} = {}) {
  const say = (text = '') => stdout.write(`${text}\n`);
  const complain = (text) => stderr.write(`${text}\n`);

  let options;
  try {
    ({ values: options } = parseArgs({
      args: argv,
      options: {
        origin: { type: 'string' },
        ca: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    complain(`${error.message}\n\n${HELP}`);
    return 2;
  }
  if (options.help) {
    stdout.write(HELP);
    return 0;
  }
  if (options.version) {
    const manifest = new URL('../package.json', import.meta.url);
    say(JSON.parse(readFileSync(manifest, 'utf8')).version);
    return 0;
  }
  // The site: the flag, else the environment. No site is assumed.
  const [given, from] =
    options.origin !== undefined
      ? [options.origin, '--origin']
      : [env.ORBITION_ORIGIN || undefined, 'ORBITION_ORIGIN'];
  if (given === undefined) {
    complain(
      'Which Orbition site? Give it with --origin or ORBITION_ORIGIN, such as https://127.0.0.1:3192 for a local test site.',
    );
    return 2;
  }
  const origin = siteOrigin(given);
  if (origin === null) {
    complain(
      `${from} must be a local test site, https://127.0.0.1:<port>, and nothing else: no other site is accepted until the Orbition site is confirmed.`,
    );
    return 2;
  }
  // Its certificate authority: the flag, else the environment. Never assumed.
  const [caFile, caFrom] =
    options.ca !== undefined ? [options.ca, '--ca'] : [env.ORBITION_CA || undefined, 'ORBITION_CA'];
  if (caFile === undefined) {
    complain("Which certificate authority does the local site use? Give its PEM file with --ca or ORBITION_CA.");
    return 2;
  }
  const authority = readAuthority(path.resolve(cwd, caFile));
  if (authority.pem === undefined) {
    complain(`${caFrom}: ${authority.problem}.`);
    return 2;
  }
  if (!stdin.isTTY || !stdout.isTTY) {
    complain('This installer asks questions, so it needs an interactive terminal. Nothing was changed.');
    return 1;
  }

  // Ctrl+C stops the run wherever it is; a question in progress hears it as well.
  const stopped = new AbortController();
  const interrupt = () => stopped.abort(new Stop('Stopped. Nothing was changed.', 130));
  signals.on('SIGINT', interrupt);
  let listener;
  let timer;

  /**
   * One question, read from the terminal, which is left as it was after.
   * `skip` ends it early without an answer (resolving with null).
   */
  const inputEnded = () => new Stop('\nNo answer: the input ended. Nothing was changed.', 1);
  const ask = async (question, skip = new AbortController().signal) => {
    if (stdin.readableEnded) throw inputEnded();
    const rl = createInterface({ input: stdin, output: stdout, terminal: true });
    const ended = new AbortController();
    let done = false;
    rl.on('SIGINT', interrupt);
    rl.on('close', () => {
      if (!done) ended.abort(inputEnded());
    });
    try {
      const signal = AbortSignal.any([stopped.signal, ended.signal, skip]);
      return await rl.question(question, { signal });
    } catch (error) {
      if (stopped.signal.aborted) throw stopped.signal.reason;
      if (ended.signal.aborted) throw ended.signal.reason;
      if (skip.aborted) return null;
      throw error;
    } finally {
      done = true;
      rl.close();
    }
  };

  // Whether "Waiting…" is on the screen, so the outcome finishes that line.
  let waiting = false;
  const minutes = (ms) => {
    const count = Math.ceil(ms / 60000);
    return `${String(count)} minute${count === 1 ? '' : 's'}`;
  };

  try {
    say();
    say('  ◆ Welcome to Orbition');
    say();

    // Sign in first, in the browser, with this run's own state and verifier.
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
    listener = await listenForAnswer(state);
    const link =
      `${origin}/terminal/sign-in?port=${String(listener.port)}&state=${state}` +
      `&code_challenge=${challenge}&code_challenge_method=S256`;
    // The first of: the site's answer, the time limit, Ctrl+C. The limit is
    // set when the link is shown and set again when the browser is opened,
    // as the site starts its own when the link is visited.
    let expire;
    const timedOut = new Promise((_, reject) => (expire = reject));
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const lead = waiting ? 'ran out of time.\n' : '';
        expire(new Stop(`${lead}Signing in ran out of time. Run the installer again. Nothing was changed.`, 1));
      }, signInMs);
    };
    const aborted = new Promise((_, reject) => {
      if (stopped.signal.aborted) reject(stopped.signal.reason);
      stopped.signal.addEventListener('abort', () => reject(stopped.signal.reason), { once: true });
    });
    const deadline = Promise.race([listener.answer, timedOut, aborted]);
    deadline.catch(() => {});
    arm();
    say(`Signing in on ${origin} (from ${from}).`);
    say('Sign in to continue. Press Enter to open your browser, or Ctrl+C to stop.');
    say(`  ${link}`);
    // The link may also be opened by hand: an answer, or the time limit,
    // ends the wait for Enter.
    const answeredFirst = new AbortController();
    deadline.then(
      () => answeredFirst.abort(),
      () => answeredFirst.abort(),
    );
    const enter = await ask('', answeredFirst.signal);
    if (enter !== null && !answeredFirst.signal.aborted) {
      arm();
      const opened = await openUrl(link);
      if (!opened) say('Could not open a browser here. Open the link above in your browser.');
    }
    // Typing while the browser is used goes nowhere, so that it cannot answer
    // the next question.
    // Input that ends meanwhile ends the run, as it would at a question.
    const ignore = () => {};
    let endOfInput;
    const ending = new Promise((_, reject) => (endOfInput = () => reject(inputEnded())));
    ending.catch(() => {});
    let answer;
    try {
      if (!answeredFirst.signal.aborted) {
        stdout.write(`Waiting for you to sign in (up to ${minutes(signInMs)})… `);
        waiting = true;
        stdin.on('data', ignore);
        stdin.once('end', endOfInput);
        stdin.resume();
      }
      answer = await Promise.race([deadline, ending]);
    } finally {
      stdin.off('data', ignore);
      stdin.off('end', endOfInput);
      stdin.pause();
    }
    clearTimeout(timer);
    // One answer is all it takes: nothing listens after it.
    listener.close();
    const { result, code } = answer;
    const outcome = {
      signed_in: 'received.',
      unconfirmed: 'not confirmed.',
      cancelled: 'cancelled.',
      expired: 'ran out of time.',
    };
    if (waiting) say(outcome[result]);
    if (result === 'cancelled') {
      throw new Stop('Signing in was cancelled in the browser. Nothing was changed.', 1);
    }
    if (result === 'expired') {
      throw new Stop('The sign-in ran out of time. Run the installer again to sign in. Nothing was changed.', 1);
    }
    if (result === 'unconfirmed') {
      throw new Stop(
        'The site answered without a sign-in code, so the sign-in cannot be confirmed. Nothing was changed. Run the installer again.',
        1,
      );
    }

    // The proof: only the site's own answer, to this run's verifier, counts.
    stdout.write('Confirming your sign-in with Orbition… ');
    let proof;
    try {
      proof = readProof(
        await proveSignIn({ origin, ca: authority.pem, code, verifier, signal: stopped.signal, timeoutMs: verifyMs }),
      );
    } catch (error) {
      if (stopped.signal.aborted) throw stopped.signal.reason;
      say('not confirmed.');
      const code = String(error?.code ?? '');
      let reason = 'the site could not be reached';
      if (code === 'CERT_HAS_EXPIRED' || code === 'CERT_NOT_YET_VALID') {
        reason = "the site's certificate has expired or is not valid yet";
      } else if (code === 'ERR_SSL_WRONG_VERSION_NUMBER' || code === 'EPROTO') {
        reason = 'the site did not answer over HTTPS';
      } else if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ALTNAME|ERR_TLS|ERR_SSL/.test(code)) {
        reason = `the site's certificate is not one ${caFrom} vouches for`;
      } else if (error?.name === 'TimeoutError' || code === 'ABORT_ERR') {
        reason = 'the site did not answer in time';
      }
      throw new Stop(`Could not confirm the sign-in: ${reason}. Nothing was changed.`, 1);
    }
    if (!proof.confirmed) {
      say('not confirmed.');
      throw new Stop(proof.message, 1);
    }
    say('signed in.');
    say();

    // The project, checked at once; asked again until it can be used.
    for (;;) {
      const answer = (await ask('Which project folder? (a path from here; Enter for this one) ')).trim();
      const chosen = path.resolve(cwd, answer === '' ? '.' : answer);
      try {
        if (!statSync(chosen, { throwIfNoEntry: false })?.isDirectory()) {
          throw new InstallError(`There is no folder at ${chosen}.`);
        }
        // The folder as the package manager will see it: its real path, so
        // the workspace above it is the one that counts.
        const directory = realpathSync(chosen);
        const { project, packageManager } = checkProject(directory, launcher(env));
        const { name } = project.manifest;
        const label = typeof name === 'string' && name !== '' ? name : path.basename(directory);
        say(`  ${label} uses ${packageManager}.`);
        break;
      } catch (error) {
        // A refusal, or a folder that cannot be read: say so and ask again.
        if (error instanceof InstallError) say(`  ${error.message}`);
        else if (typeof error?.code === 'string') say(`  Could not read ${chosen}: ${error.message}`);
        else throw error;
      }
    }
    say();
    say('That is as far as this version goes: choosing what to add, approving it and');
    say('downloading come next. Nothing was changed.');
    return 0;
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    if (error.status === 130) say(`\n${error.message}`);
    else complain(error.message);
    return error.status;
  } finally {
    clearTimeout(timer);
    listener?.close();
    signals.off('SIGINT', interrupt);
  }
}

// Run when started as a command (directly, or through a package manager's link).
const started = process.argv[1] && realpathSync(process.argv[1]);
if (started && started === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
