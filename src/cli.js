#!/usr/bin/env node
// The installer's command: `npm create @orbition`, `npx @orbition/create` or
// `pnpm dlx @orbition/create` once published, `node src/cli.js` in a checkout.
//
// It welcomes the person and has them sign in in the browser and allow this
// one install there, in one visit, before anything else: the browser page
// names exactly the release (Design System 0.1.0) and the site decides the
// account's access live. The command confirms that permission with the site,
// then asks for the project folder and checks it, has them choose what to add
// (the Design System and its renderers) and shows a review of what adding it
// would change. From the review they install, change the selections or
// cancel. Install exchanges the permission, once, for a short-lived download
// credential, downloads the release, and the install engine (src/install.js)
// checks every archive, keeps them in the project, declares them and updates
// the lockfile; then the project's own package manager runs a normal install.
// Until Install, nothing in the project is changed and no credential exists.
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
//   <origin>/terminal/approve?product=design-system&version=<version>
//     &purpose=install&code_challenge=<S256>&code_challenge_method=S256
//     &state=<state>&port=<port>                             (in the browser)
//   http://127.0.0.1:<port>/callback?state=<state>&code=<code> (or &error=<why>)
//                                                            (to this command)
//   POST <origin>/terminal/approve/verify {code, code_verifier}  (this command,
//                                                  before the project folder)
//   POST <origin>/terminal/token {code, code_verifier}       (this command, on
//                                                  Install; spends the code)
//   GET <origin>/terminal/design-system/releases/<version>/manifest and
//     /archives/<file>, with the credential as a Bearer header (this command)
//
// Each request to the browser makes a fresh random state, PKCE verifier and
// listener; only the challenge leaves the command before the check. The
// callback is only a hand-off: anything that can reach the port with the
// state could send one, so the permission counts only when the site answers
// the check, made with this request's own verifier, with exactly
// 200 {"status":"approved"} for this release. The check spends nothing; the
// one exchange happens only when the person chooses Install. Choosing
// Install is the person's own decision in the terminal, not proof to the
// site: the site decides the account's access again at the exchange and on
// every download. A permission that was used, ran out or whose browser
// session ended is asked for again in the browser, with the selections kept.
//
// The code, its verifier and the credential stay in this process's memory
// only: never shown, logged, written to a file, put in an argument or in the
// environment, and the package managers never see them. The download source
// lets the credential go once the archives are in memory, before anything in
// the project is written, and nothing uses it after.
import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual, X509Certificate } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { downloadSource, LIMITS } from './download.js';
import { InstallError } from './errors.js';
import { checkBeforeInstall, checkProject, install, RETAINED_DIRECTORY } from './install.js';
import { choose } from './menu.js';
import { listed, plain, PRODUCTS, RENDERERS, reviewLines } from './selection.js';

/** How long the browser has to sign in and allow the install, as the site keeps the request. */
export const APPROVAL_MS = 10 * 60 * 1000;
/** How long the site has to answer the check of the permission, from the request to its last byte. */
export const VERIFY_MS = 15_000;
/** How long the site has to answer the exchange of the permission. */
export const EXCHANGE_MS = 15_000;
/** How much sooner than the site says the permission is taken to have ended, for the exchange's way there. */
export const CONSENT_MARGIN_MS = 30_000;
/** How long the project's install's output is still read after it exits. */
const OUTPUT_GRACE_MS = 2000;
/** A download credential, as the site makes them: base64url of 32 bytes. */
const CREDENTIAL = /^[A-Za-z0-9_-]{43}$/;
/** The most a certificate file, or one of the site's answers, may weigh. */
const MAX_CA_BYTES = 64 * 1024;
const MAX_ANSWER_BYTES = 4096;
/** A one-time code, as the site makes them: base64url of 32 bytes. */
const CODE = /^[A-Za-z0-9_-]{43}$/;
/** The longest the site gives a permission's code before Install must start: 15 minutes. */
const MAX_CONSENT_SECONDS = 900;

// What the site may send this command about the permission, besides a code.
const APPROVAL_ERRORS = new Set(['not_entitled', 'access_denied', 'not_found', 'cancelled', 'expired']);
const APPROVAL_PAGES = {
  approved: [
    'Back to your terminal',
    'The terminal is confirming this with Orbition and goes on there. You can close this tab.',
  ],
  not_entitled: ['No access', 'This account has no current access to this release. Nothing was changed. You can close this tab.'],
  access_denied: ['Not allowed', 'This account cannot download yet. Nothing was changed. You can close this tab.'],
  not_found: ['Not found', 'There is no such release. Nothing was changed. You can close this tab.'],
  cancelled: ['Cancelled', 'Nothing was changed. Return to your terminal. You can close this tab.'],
  expired: ['This request ran out of time', 'Nothing was changed. Return to your terminal. You can close this tab.'],
};

const NO_ACCESS = 'This account has no current access to the Design System.';
const NOT_READY =
  'This account cannot download yet. Finish setting the account up on the Orbition site, then run the installer again.';

// The site's refusals of the check, by status and error: what to say, and
// whether asking again could help (else the run stops).
const CHECK_REFUSALS = {
  '400 invalid_grant': {
    again: true,
    message: 'Orbition did not accept this permission: it ran out of time, was already used, or belongs to another run.',
  },
  '401 sign_in_required': { again: true, message: 'The browser is no longer signed in to Orbition.' },
  '403 not_entitled': { again: false, message: NO_ACCESS },
  '403 access_denied': { again: false, message: NOT_READY },
  '429 rate_limited': { again: true, message: 'Too many checks from this network. Try again in a few minutes.' },
  '503 unavailable': { again: true, message: 'Orbition cannot confirm this right now. Try again in a few minutes.' },
};

// The site's refusals of the exchange, by status and error: what to say, and
// what follows: `renew` (the permission has ended: allow again in the
// browser), `retry` (the same permission can be tried again) or `stop`.
const EXCHANGE_REFUSALS = {
  '400 invalid_grant': {
    then: 'renew',
    message: 'Orbition did not accept the permission to install: it ran out of time, or was already used.',
  },
  '401 sign_in_required': {
    then: 'renew',
    message: 'The browser is no longer signed in to Orbition, so the permission to install has ended.',
  },
  '403 not_entitled': { then: 'stop', message: NO_ACCESS },
  '403 access_denied': { then: 'stop', message: NOT_READY },
  '429 rate_limited': { then: 'retry', message: 'Too many requests from this network. Wait a few minutes before choosing Install again.' },
  '503 unavailable': { then: 'retry', message: 'Orbition cannot hand out downloads right now. Try Install again in a few minutes.' },
};

const HELP = `Adds Orbition to an existing npm or pnpm project.

First, in your browser, you sign in and allow this one install of the
Design System 0.1.0 only, used once: Install must start within 15 minutes.
Signing out blocks any further authorization or download; once the files
are downloaded, the install can still finish. Then it asks for the project
folder and checks it, lets you choose what to add, and shows a review of
what that would change. Install downloads the release, checks it, adds it
to the project and runs the project's install. Nothing is changed before
Install.

Keys in the lists: Up and Down move, Space marks a renderer, Enter chooses,
Ctrl+C stops.

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
 * The check of a permission to install: POST {code, code_verifier} to the
 * site's check address. It spends nothing. See postJson.
 */
export function verifyConsent({ origin, ca, code, verifier, signal, timeoutMs = VERIFY_MS }) {
  const body = { code, code_verifier: verifier };
  return postJson({ origin, pathname: '/terminal/approve/verify', ca, body, signal, timeoutMs });
}

/**
 * One POST of JSON to the site, with the given authority as the only one
 * trusted and the certificate always checked, no redirect followed and a time
 * limit. Resolves with the status, the media type and the body (up to
 * MAX_ANSWER_BYTES, else `overflow`); rejects when no whole answer arrived.
 */
function postJson({ origin, pathname, ca, body, signal, timeoutMs }) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const outgoing = httpsRequest(
      new URL(pathname, origin),
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

/** An answer's JSON object, or null when it is not one. */
function jsonOf(answer) {
  let value;
  try {
    value = answer.type === 'application/json' && !answer.overflow ? JSON.parse(answer.body) : null;
  } catch {
    value = null;
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/**
 * The site's answer to the exchange: a credential for exactly this release,
 * or what to say and what follows (`renew`, `retry` or `stop`).
 */
function readExchange(answer, release) {
  const value = jsonOf(answer);
  const keys = value === null ? '' : Object.keys(value).sort().join(',');
  if (
    answer.status === 200 &&
    keys === 'credential,expires_in,product,version' &&
    typeof value.credential === 'string' &&
    CREDENTIAL.test(value.credential) &&
    Number.isSafeInteger(value.expires_in) &&
    value.expires_in > 0 &&
    value.product === release.product &&
    value.version === release.version
  ) {
    return { credential: value.credential };
  }
  const refusal =
    keys === 'error' && typeof value.error === 'string'
      ? EXCHANGE_REFUSALS[`${String(answer.status)} ${value.error}`]
      : undefined;
  return (
    refusal ?? {
      then: 'stop',
      message: "Orbition's answer to the install was not understood, so nothing was downloaded.",
    }
  );
}

/**
 * The site's answer to the check: exactly 200 {"status":"approved"} for this
 * release, with the seconds the permission has left, or what to say and
 * whether asking again could help.
 */
function readCheck(answer, release) {
  const value = jsonOf(answer);
  const keys = value === null ? '' : Object.keys(value).sort().join(',');
  if (
    answer.status === 200 &&
    keys === 'expires_in,product,status,version' &&
    value.status === 'approved' &&
    value.product === release.product &&
    value.version === release.version &&
    Number.isSafeInteger(value.expires_in) &&
    value.expires_in >= 1 &&
    value.expires_in <= MAX_CONSENT_SECONDS
  ) {
    return { expiresIn: value.expires_in };
  }
  const refusal =
    keys === 'error' && typeof value.error === 'string'
      ? CHECK_REFUSALS[`${String(answer.status)} ${value.error}`]
      : undefined;
  return refusal ?? { again: false, message: "Orbition's answer was not understood, so the permission was not confirmed." };
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

// The callbacks this command understands: their query keys, and what each
// answer is (null when it is not understood), with the page the browser gets.
const APPROVAL = {
  keys: ['code,state', 'error,state'],
  other: ['Not this request', 'This answer is for another installer request. Use the link the terminal shows now.'],
  // A code, or the reason there is none.
  read(params) {
    const code = params.get('code');
    const error = params.get('error');
    if (code !== null) return CODE.test(code) ? { result: 'approved', code } : null;
    return APPROVAL_ERRORS.has(error) ? { result: error, code: null } : null;
  },
  pages: APPROVAL_PAGES,
};

/**
 * Listens on 127.0.0.1 for the site's answer to one request of this run
 * (`flow` says which answers it understands). `answer` resolves with `{ result, code }`
 * the first time a well-formed request carries the request's state and an
 * answer `flow` understands. Everything else is refused and the listener
 * keeps waiting.
 */
async function listenForAnswer(state, flow) {
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
    if (url.pathname !== '/callback' || !flow.keys.includes(keys)) {
      return reply(404, 'Not found', 'There is nothing here.');
    }
    const given = Buffer.from(url.searchParams.get('state') ?? '');
    const expected = Buffer.from(state);
    if (answered) {
      return reply(410, 'Already answered', 'The terminal already has its answer.');
    }
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return reply(400, ...flow.other);
    }
    const read = flow.read(url.searchParams);
    if (read === null) return reply(400, 'Not understood', 'The answer was not understood.');
    answered = true;
    // The run goes on, and stops listening, once this page has been sent.
    response.once('close', () => settle(read));
    reply(200, ...flow.pages[read.result]);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  }).catch(() => {
    throw new Stop("Could not listen on 127.0.0.1 for the browser's answer. Nothing was changed.", 1);
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
  approvalMs = APPROVAL_MS,
  verifyMs = VERIFY_MS,
  exchangeMs = EXCHANGE_MS,
  consentMarginMs = CONSENT_MARGIN_MS,
  downloadLimits = LIMITS,
} = {}) {
  const say = (text = '') => stdout.write(`${text}\n`);
  /** Milliseconds by a clock that only moves forward, whatever the system's time does. */
  const clock = () => performance.now();
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

  /** Text from the project or its tools, line by line, as plain terminal text. */
  const plainLines = (text) => String(text).split('\n').map(plain).join('\n');

  /**
   * Checks the project again, as the install will find it, before the review
   * and before Install, so that no permission is spent on a project the
   * install would refuse. Stops the run if it cannot be used.
   * Returns the package manager it uses now, which the caller compares with
   * the one the person was shown.
   */
  const checkAgain = (project, version, renderers) => {
    try {
      return checkBeforeInstall(project.directory, launcher(env), version, renderers).packageManager;
    } catch (error) {
      if (!(error instanceof InstallError) && typeof error?.code !== 'string') throw error;
      throw new Stop(`${plainLines(error.message)} Nothing was changed.`, 1);
    }
  };

  /**
   * Waits for the browser's answer to a request this run is listening for:
   * resolves with it, or with null once `ms` have passed. Ctrl+C and the
   * input ending stop the run; typing meanwhile goes nowhere.
   */
  const waitForBrowser = async (answer, ms) => {
    if (stdin.readableEnded) throw inputEnded();
    let wait;
    let stop;
    let endOfInput;
    const ignore = () => {};
    const outcomes = [
      answer,
      new Promise((resolve) => (wait = setTimeout(() => resolve(null), ms))),
      new Promise((_, reject) => {
        stop = () => reject(stopped.signal.reason);
        if (stopped.signal.aborted) stop();
        else stopped.signal.addEventListener('abort', stop, { once: true });
      }),
      new Promise((_, reject) => (endOfInput = () => reject(inputEnded()))),
    ];
    stdin.on('data', ignore);
    stdin.once('end', endOfInput);
    stdin.resume();
    try {
      return await Promise.race(outcomes);
    } finally {
      clearTimeout(wait);
      stopped.signal.removeEventListener('abort', stop);
      stdin.off('data', ignore);
      stdin.off('end', endOfInput);
      stdin.pause();
    }
  };

  /** Why the site could not be asked, from a request's error, as the person can act on it. */
  const unreachable = (error) => {
    const code = String(error?.code ?? '');
    if (code === 'CERT_HAS_EXPIRED' || code === 'CERT_NOT_YET_VALID') {
      return "the site's certificate has expired or is not valid yet";
    }
    if (code === 'ERR_SSL_WRONG_VERSION_NUMBER' || code === 'EPROTO') return 'the site did not answer over HTTPS';
    if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ALTNAME|ERR_TLS|ERR_SSL/.test(code)) {
      return `the site's certificate is not one ${caFrom} vouches for`;
    }
    if (error?.name === 'TimeoutError' || code === 'ABORT_ERR') return 'the site did not answer in time';
    return 'the site could not be reached';
  };

  /**
   * A new request to the browser for a permission to install `product`: its
   * own state, PKCE verifier and listener, and the link to open.
   */
  const newRequest = async (product) => {
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
    listener = await listenForAnswer(state, APPROVAL);
    const link =
      `${origin}/terminal/approve?product=${product.id}&version=${product.version}&purpose=install` +
      `&code_challenge=${challenge}&code_challenge_method=S256&state=${state}&port=${String(listener.port)}`;
    return { verifier, link };
  };

  /** The stop for a browser answer that is not a permission and cannot be asked again. */
  const refused = (result, product) =>
    new Stop(
      {
        not_entitled: `${NO_ACCESS} Nothing was changed.`,
        access_denied: `${NOT_READY} Nothing was changed.`,
        not_found: `Orbition has no ${product.label} ${product.version} to install. Nothing was changed.`,
      }[result],
      1,
    );

  /**
   * The check of the permission the browser sent: only the site's own
   * answer, to this request's verifier, counts. Resolves with the permission,
   * kept in memory with the time it is taken to end, or with what to say and
   * whether asking again could help. Spends nothing.
   */
  const confirm = async (product, code, verifier) => {
    stdout.write('Confirming with Orbition… ');
    let read;
    try {
      read = readCheck(
        await verifyConsent({ origin, ca: authority.pem, code, verifier, signal: stopped.signal, timeoutMs: verifyMs }),
        { product: product.id, version: product.version },
      );
    } catch (error) {
      if (stopped.signal.aborted) throw stopped.signal.reason;
      say('not confirmed.');
      return { again: true, message: `Could not confirm the permission: ${unreachable(error)}.` };
    }
    if (read.expiresIn === undefined) {
      say('not confirmed.');
      return read;
    }
    // Too little time left to reach the site with it: no permission at all.
    if (read.expiresIn * 1000 <= consentMarginMs) {
      say('too late.');
      return { again: true, message: 'The permission had too little time left to be used.' };
    }
    say('allowed.');
    return {
      consent: {
        product,
        code,
        verifier,
        // By the monotonic clock: a change to the system's time moves nothing.
        endsAt: clock() + read.expiresIn * 1000 - consentMarginMs,
      },
    };
  };

  /** Says what the permission allows and how long is left to use it. */
  const announce = (consent) => {
    say(
      `  Orbition allows this one install of ${consent.product.label} ${consent.product.version}: Install must start within ${minutes(consent.endsAt - clock())}. Signing out blocks any further authorization or download; files already downloaded can still finish installing. Nothing is downloaded before you choose Install.`,
    );
  };

  // Said whenever the permission has ended and the review is shown again.
  const RENEW =
    'Nothing was changed. The review is shown again with your selections: allow again in your browser to install, change the selections, or cancel.';

  /**
   * Asks the browser again for a permission to install, once the person chose
   * to: the browser is opened at once. Resolves with the confirmed
   * permission, or with null when the review is to be shown again; stops the
   * run when asking again cannot help.
   */
  const renew = async (product) => {
    const request = await newRequest(product);
    let answer;
    try {
      say();
      say(`Allow this install of ${product.label} ${product.version} again in your browser, or press Ctrl+C to stop.`);
      say(`  ${request.link}`);
      if (!(await openUrl(request.link))) say('Could not open a browser here. Open the link above in your browser.');
      stdout.write(`Waiting for you to allow it (up to ${minutes(approvalMs)})… `);
      answer = await waitForBrowser(listener.answer, approvalMs);
    } finally {
      listener.close();
    }
    const again = (outcome, why) => {
      say(outcome);
      say(`${why} ${RENEW}`);
      return null;
    };
    if (answer === null) return again('ran out of time.', 'No answer arrived in time.');
    const { result, code } = answer;
    if (result === 'cancelled') return again('cancelled.', 'It was cancelled in the browser.');
    if (result === 'expired') return again('ran out of time.', 'The request ran out of time in the browser.');
    if (result !== 'approved') {
      say('not allowed.');
      throw refused(result, product);
    }
    say('received.');
    const confirmed = await confirm(product, code, request.verifier);
    if (confirmed.consent) {
      announce(confirmed.consent);
      return confirmed.consent;
    }
    if (confirmed.again) {
      say(`${confirmed.message} ${RENEW}`);
      return null;
    }
    throw new Stop(`${confirmed.message} Nothing was changed.`, 1);
  };

  /**
   * The one exchange of the permission for a download credential, on
   * Install. Resolves with the credential, or with what to say and what
   * follows: `renew` (the permission has ended) or `retry` (the same one may
   * be tried again); stops the run when neither can help.
   */
  const exchange = async (consent) => {
    const { product } = consent;
    stdout.write('Getting a download credential from Orbition… ');
    let exchanged;
    try {
      exchanged = readExchange(
        await postJson({
          origin,
          pathname: '/terminal/token',
          ca: authority.pem,
          body: { code: consent.code, code_verifier: consent.verifier },
          signal: stopped.signal,
          timeoutMs: exchangeMs,
        }),
        { product: product.id, version: product.version },
      );
    } catch (error) {
      if (stopped.signal.aborted) throw stopped.signal.reason;
      // The code may or may not have been used: the same one is tried again,
      // and if it was used, the site says so and it is asked for again.
      say('not received.');
      return {
        then: 'retry',
        message: `Orbition could not be asked: ${unreachable(error)}.`,
      };
    }
    if (exchanged.credential !== undefined) {
      say('received.');
      return exchanged;
    }
    say('not received.');
    if (exchanged.then === 'stop') throw new Stop(`${exchanged.message} Nothing was changed.`, 1);
    return exchanged;
  };

  /**
   * Downloads the release and installs it with the engine, with the
   * package manager the person reviewed, then runs the project's own install
   * while the engine still holds the project, so no other installer can start
   * in between. Resolves with the exit status; every failure says what became
   * of the project, and nothing is tried again unasked.
   */
  const installRelease = async ({ project, product, renderers, credential }) => {
    const parts = ['Core', ...RENDERERS.filter((r) => renderers.includes(r.id)).map((r) => r.part)];
    stdout.write(`Downloading, checking and adding ${listed(parts)}… `);
    let status;
    // Whether the engine's work is done and the project's own install began.
    let finishing = false;
    try {
      const source = await downloadSource({
        origin,
        version: product.version,
        credential,
        ca: authority.pem,
        limits: downloadLimits,
        signal: stopped.signal,
      });
      try {
        await install({
          project: project.directory,
          source,
          renderers,
          invokedBy: launcher(env),
          packageManager: project.packageManager,
          whileLocked: async (result) => {
            finishing = true;
            status = await finishInstall({ project, product, parts, result });
          },
        });
      } finally {
        source.close();
      }
    } catch (error) {
      // From the project's own install: already said what became of it.
      if (finishing) throw error;
      // What became of the project: written and put back (`restored`),
      // written and not put back (`unknown`), or never written (no state).
      const state = error?.projectState;
      const known = error instanceof InstallError || state !== undefined || typeof error?.code === 'string';
      if (!known && !stopped.signal.aborted) throw error;
      say('stopped.');
      const interrupted = stopped.signal.aborted || error?.interrupted === true;
      const detail = plainLines(error instanceof InstallError ? error.message : `Could not install: ${error?.message}`);
      if (state === 'unknown') throw new Stop(detail, interrupted ? 130 : 1);
      if (interrupted) {
        throw new Stop(
          state === 'restored' ? 'Stopped. The project was put back as it was.' : 'Stopped. Nothing was changed.',
          130,
        );
      }
      if (state === 'restored') {
        throw new Stop(error instanceof InstallError ? detail : `${detail}\n\nThe project was put back as it was.`, 1);
      }
      // Never written: said once, unless the refusal says so already.
      const said = /Nothing was (changed|installed)/.test(detail);
      throw new Stop(said ? detail : `${detail}\n\nNothing in the project was changed.`, 1);
    }
    return status;
  };

  /**
   * After the engine's install: what it did, then the project's own install,
   * as the person would run it. Its output is shown as it comes; it can run
   * install scripts of other dependencies. Resolves with 0, or stops the run
   * saying what became of the project.
   */
  const finishInstall = async ({ project, product, parts, result }) => {
    say('done.');
    const declared = `package.json, ${result.lockfile} and ${RETAINED_DIRECTORY}`;
    for (const entry of result.packages) {
      say(`  ${entry.added ? 'Added' : 'Already there:'} ${entry.name} ${entry.version} (${entry.file})`);
    }
    if (!result.changed) say('  The project already had all of this; nothing in it changed.');
    for (const warning of result.warnings) say(`  ${plainLines(warning)}`);
    const finish = `${product.label} ${product.version} is declared in ${declared}, so nothing has to be allowed again: run ${result.nextCommand} in the project to finish.`;
    if (stopped.signal.aborted) throw new Stop(`Stopped. ${finish}`, 130);

    say();
    say(`Running ${result.nextCommand}…`);
    const finished = await new Promise((resolve) => {
      const child = spawn(result.packageManager, ['install'], {
        cwd: project.directory,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });
      // Ctrl+C reaches a child in the terminal's own process group anyway;
      // this also stops one that is not.
      const halt = () => child.kill('SIGINT');
      stopped.signal.addEventListener('abort', halt, { once: true });
      child.stdout.pipe(stdout, { end: false });
      child.stderr.pipe(stderr, { end: false });
      let settled = false;
      const done = (outcome) => {
        if (settled) return;
        settled = true;
        stopped.signal.removeEventListener('abort', halt);
        resolve(outcome);
      };
      child.on('error', (error) => done({ error }));
      // Its end is when it exits. A process it left behind may still hold its
      // output: that is shown for a moment more, then let go, so the project
      // is not held for it.
      child.on('exit', (code, signal) => {
        const letGo = setTimeout(() => {
          for (const [from, to] of [[child.stdout, stdout], [child.stderr, stderr]]) {
            from.unpipe(to);
            from.destroy();
          }
          done({ code, signal });
        }, OUTPUT_GRACE_MS);
        child.once('close', () => {
          clearTimeout(letGo);
          done({ code, signal });
        });
      });
    });
    if (stopped.signal.aborted) throw new Stop(`Stopped during ${result.nextCommand}. ${finish}`, 130);
    if (finished.error || finished.code !== 0) {
      const how = finished.error
        ? `could not be started (${finished.error.message})`
        : `did not finish (${finished.signal ? `stopped by ${finished.signal}` : `exit status ${String(finished.code)}`})`;
      throw new Stop(`${result.nextCommand} ${how}; node_modules may be partly changed. ${finish}`, 1);
    }
    say();
    say(`${product.label} ${product.version} (${listed(parts)}) is installed in ${plain(project.label)}.`);
    say(`Commit ${declared}: the project installs from them, with no access to Orbition.`);
    return 0;
  };

  try {
    say();
    say('  ◆ Welcome to Orbition');
    say();

    // Sign in and allow this one install first, in the browser, with this
    // request's own state and verifier. The Design System is the one release
    // that can be chosen; its permission is asked for by name.
    const offered = PRODUCTS.find((product) => !product.disabled);
    const request = await newRequest(offered);
    const { link } = request;
    // The first of: the site's answer, the time limit, Ctrl+C. The limit is
    // set when the link is shown and set again when the browser is opened,
    // as the site starts its own when the link is visited.
    let expire;
    const timedOut = new Promise((_, reject) => (expire = reject));
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const lead = waiting ? 'ran out of time.\n' : '';
        expire(new Stop(`${lead}Signing in and allowing the install ran out of time. Run the installer again. Nothing was changed.`, 1));
      }, approvalMs);
    };
    const aborted = new Promise((_, reject) => {
      if (stopped.signal.aborted) reject(stopped.signal.reason);
      stopped.signal.addEventListener('abort', () => reject(stopped.signal.reason), { once: true });
    });
    const deadline = Promise.race([listener.answer, timedOut, aborted]);
    deadline.catch(() => {});
    arm();
    say(`Signing in on ${origin} (from ${from}).`);
    say(
      `Sign in and allow this install of ${offered.label} ${offered.version} in your browser. Press Enter to open it, or Ctrl+C to stop.`,
    );
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
        stdout.write(`Waiting for you to sign in and allow it (up to ${minutes(approvalMs)})… `);
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
      approved: 'received.',
      cancelled: 'cancelled.',
      expired: 'ran out of time.',
      not_entitled: 'not allowed.',
      access_denied: 'not allowed.',
      not_found: 'not allowed.',
    };
    if (waiting) say(outcome[result]);
    if (result === 'cancelled') {
      throw new Stop('It was cancelled in the browser. Nothing was changed.', 1);
    }
    if (result === 'expired') {
      throw new Stop('The request ran out of time in the browser. Run the installer again. Nothing was changed.', 1);
    }
    if (result !== 'approved') throw refused(result, offered);

    // The check: only the site's own answer, to this request's verifier,
    // counts. It spends nothing; the folder is asked only after it.
    const confirmed = await confirm(offered, code, request.verifier);
    if (!confirmed.consent) {
      const tail = confirmed.again ? ' Nothing was changed. Run the installer again.' : ' Nothing was changed.';
      throw new Stop(`${confirmed.message}${tail}`, 1);
    }
    let consent = confirmed.consent;
    announce(consent);
    say();

    // The project, checked at once; asked again until it can be used.
    let project;
    for (;;) {
      const typed = (await ask('Which project folder? (a path from here; Enter for this one) ')).trim();
      const chosen = path.resolve(cwd, typed === '' ? '.' : typed);
      try {
        if (!statSync(chosen, { throwIfNoEntry: false })?.isDirectory()) {
          throw new InstallError(`There is no folder at ${chosen}.`);
        }
        // The folder as the package manager will see it: its real path, so
        // the workspace above it is the one that counts.
        const directory = realpathSync(chosen);
        const checked = checkProject(directory, launcher(env));
        const { packageManager } = checked;
        const { name } = checked.project.manifest;
        const label = typeof name === 'string' && name !== '' ? name : path.basename(directory);
        say(`  ${plain(label)} uses ${packageManager}.`);
        project = { label, directory, packageManager };
        break;
      } catch (error) {
        // A refusal, or a folder that cannot be read: say so and ask again.
        if (error instanceof InstallError) say(`  ${plain(error.message)}`);
        else if (typeof error?.code === 'string') say(`  ${plain(`Could not read ${chosen}: ${error.message}`)}`);
        else throw error;
      }
    }
    say();

    // What to add, then the review. "Change selections" asks again, starting
    // from the last answers; the permission and the folder stand.
    const pick = (options) =>
      choose({ stdin, stdout, signal: stopped.signal, interrupt, ended: inputEnded, ...options });
    let productIndex = PRODUCTS.indexOf(offered);
    let renderers = ['react'];
    let choosing = true;
    for (;;) {
      if (choosing) {
        productIndex = await pick({
          question: 'What would you like to add?',
          hint: '(Up/Down to move, Enter to choose)',
          items: PRODUCTS,
          start: productIndex,
          summary: (index) => `${PRODUCTS[index].label} ${PRODUCTS[index].version}`,
        });
        const marked = await pick({
          question: 'Which do you use?',
          hint: '(Space to mark, one or both; Enter to go on)',
          items: RENDERERS,
          multiple: true,
          marked: RENDERERS.flatMap((renderer, index) => (renderers.includes(renderer.id) ? [index] : [])),
          summary: (indexes) => listed(indexes.map((index) => RENDERERS[index].label)),
        });
        renderers = marked.map((index) => RENDERERS[index].id);
      }
      choosing = false;
      const product = PRODUCTS[productIndex];
      // A permission is for one release only.
      if (consent !== null && (consent.product.id !== product.id || consent.product.version !== product.version)) {
        consent = null;
      }

      // The project as it is now, as the install will find it: the review
      // shows its package manager as it is now.
      project.packageManager = checkAgain(project, product.version, renderers);
      say();
      for (const line of reviewLines({ ...project, product, renderers })) say(line);
      say();
      const choices = [
        consent === null
          ? { label: 'Allow again in your browser, then install' }
          : { label: 'Install', note: 'download and install now' },
        { label: 'Change selections' },
        { label: 'Cancel' },
      ];
      const next = await pick({
        question: 'What next?',
        hint: '(Up/Down to move, Enter to choose)',
        items: choices,
        summary: (index) => `${choices[index].label}.`,
      });
      if (next === 2) throw new Stop('Cancelled. Nothing was changed.', 1);
      if (next === 1) {
        choosing = true;
        say();
        continue;
      }
      // Nothing is installed with another package manager than the one the
      // person reviewed: if the project changed, it is reviewed again.
      const reviewed = () => {
        const now = checkAgain(project, product.version, renderers);
        if (now === project.packageManager) return true;
        say();
        say(`The project now uses ${now}, not ${project.packageManager}. Nothing was changed. Review it again:`);
        return false;
      };
      if (!reviewed()) continue;
      if (consent === null) {
        // The person chose to allow it again: the browser is opened now.
        consent = await renew(product);
        if (consent === null || !reviewed()) continue;
      }
      // Past its time (less the margin for the way to the site), the
      // permission is not sent at all, however it was obtained.
      if (clock() >= consent.endsAt) {
        consent = null;
        say();
        say(`The permission to install ran out of time. ${RENEW}`);
        continue;
      }
      const exchanged = await exchange(consent);
      if (exchanged.credential === undefined) {
        if (exchanged.then === 'renew') {
          consent = null;
          say(`${exchanged.message} ${RENEW}`);
        } else {
          say(`${exchanged.message} Nothing was changed. The review is shown again: choose Install to try again.`);
        }
        continue;
      }
      // Spent: the code and its verifier are of no further use.
      consent = null;
      return await installRelease({ project, product, renderers, credential: exchanged.credential });
    }
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
