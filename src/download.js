import { request } from 'node:https';
import { createGunzip } from 'node:zlib';

import { InstallError } from './errors.js';
import { DESIGN_SYSTEM, validateManifest } from './manifest.js';

/** The most a release manifest, or a refusal, may weigh once decoded. */
export const MAX_MANIFEST_BYTES = 64 * 1024;
/** The most one archive may weigh. */
export const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
/** How long one request may take, from its start to its last byte. */
export const LIMITS = { manifestMs: 15_000, archiveMs: 120_000 };

// A plain three-part version, as the service addresses releases.
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
// A bearer token (RFC 6750): nothing that could break out of a header.
const CREDENTIAL = /^[A-Za-z0-9._~+/-]+=*$/;
// The code the service gives with each refusal status. Any other pairing, and
// any other status, is not an answer this installer understands.
const CODES = {
  401: ['sign_in_required'],
  403: ['not_entitled', 'access_denied'],
  404: ['not_found'],
  503: ['unavailable'],
};
// A certificate that cannot be trusted is not a passing fault: no second try.
const NOT_TRUSTED = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ALTNAME|ERR_TLS|ERR_SSL/;

/**
 * A refusal with its reason as a code the caller can act on: one of the
 * service's own (`sign_in_required`, `not_entitled`, `access_denied`,
 * `not_found`, `unavailable`), or `invalid_release` when what arrived is not
 * the release that was asked for. No message repeats text the service sent.
 */
const refusal = (code, message) =>
  Object.assign(new InstallError(`${message} Nothing was installed.`), { code });
const unavailable = (what) => refusal('unavailable', `${what} Try again in a few minutes.`);

const MESSAGES = {
  sign_in_required: () =>
    'This download is no longer approved: the approval ended, or the account signed out. Run the installer again to approve it.',
  not_entitled: () => 'This account has no current access to the Design System.',
  access_denied: () =>
    'This account cannot download yet. Finish setting the account up on the Orbition site, then run the installer again.',
  not_found: (what) => `${what} was not found.`,
};

/** The archive name the service gives a package: its name without the scope sign, and the version. */
export const archiveName = (name, version) => `${name.replace('@', '').replace('/', '-')}-${version}.tgz`;

/**
 * One GET. `plan(status)` says what an answer with that status may be: its
 * media type and the most its body may weigh once decoded; `null` for a
 * status that is not wanted at all.
 *
 * Resolves with the status and one of: `body`, the whole decoded body;
 * `overflow`, there was more than allowed; `unexpected`, this is not an
 * answer the installer reads (status, media type, compression, or a refusal
 * whose body did not arrive). Rejects when no answer arrived whole: no
 * connection, a certificate that is not trusted, a broken connection, or the
 * time limit.
 *
 * Redirects are never followed, only gzip or no compression is read, the
 * certificate is always checked whatever the environment says, and once the
 * outcome is known nothing is left reading or decoding.
 */
function get({ url, credential, ca, timeoutMs, plan }) {
  return new Promise((resolve, reject) => {
    let incoming;
    let gunzip;
    let settled = false;
    const settle = (finish, value) => {
      if (settled) return;
      settled = true;
      finish(value);
      if (gunzip) incoming.unpipe(gunzip);
      gunzip?.destroy();
      outgoing.destroy();
    };
    let broken = (error) => settle(reject, error);

    const outgoing = request(
      url,
      {
        agent: false,
        ca,
        rejectUnauthorized: true,
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${credential}`, 'Accept-Encoding': 'gzip' },
      },
      (response) => {
        incoming = response;
        const status = response.statusCode;
        const type = (response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        const encoding = (response.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
        const done = (outcome) => settle(resolve, { status, ...outcome });

        // Decided on the headers alone, before any of the body is waited for.
        const allowed = plan(status);
        if (allowed === null || type !== allowed.type || !['identity', 'gzip'].includes(encoding)) {
          return done({ unexpected: true });
        }
        // A refusal stays a refusal: if its body does not arrive, it is not asked for again.
        if (status !== 200 && status !== 503) broken = () => done({ unexpected: true });

        if (encoding === 'gzip') gunzip = createGunzip();
        const decoded = gunzip ? response.pipe(gunzip) : response;
        const chunks = [];
        let received = 0;
        decoded.on('data', (chunk) => {
          if (settled) return;
          received += chunk.length;
          if (received > allowed.max) done({ overflow: true });
          else chunks.push(chunk);
        });
        decoded.on('end', () => {
          if (response.complete) done({ body: Buffer.concat(chunks) });
          else broken(new Error('the connection closed early'));
        });
        // Compression that cannot be read is a wrong answer, not a passing fault.
        gunzip?.on('error', () => done({ unexpected: true }));
        response.on('error', (error) => broken(error));
      },
    );
    outgoing.on('error', (error) => broken(error));
    outgoing.end();
  });
}

/**
 * One request to the service, read as its contract says. Returns the decoded
 * body of a `200` with the expected media type, or `overflow` when it was
 * longer than `maxBytes`. Every other answer is a refusal. A passing fault (no
 * answer, or `503`) is tried once more; nothing else is ever tried twice.
 */
async function ask({ url, expect, what, credential, ca, timeoutMs, maxBytes }) {
  const unexpected = () =>
    unavailable('The download service gave an answer this installer does not understand.');
  const plan = (status) => {
    if (status === 200) return { type: expect, max: maxBytes };
    return Object.hasOwn(CODES, status) ? { type: 'application/json', max: MAX_MANIFEST_BYTES } : null;
  };
  let last;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let answer;
    try {
      answer = await get({ url, credential, ca, timeoutMs, plan });
    } catch (error) {
      if (NOT_TRUSTED.test(`${error.code} ${error.message}`)) {
        throw unavailable("The download service's certificate could not be verified.");
      }
      last = unavailable('The download service could not be reached.');
      continue;
    }
    const { status, body, overflow } = answer;
    if (answer.unexpected) throw unexpected();
    if (status === 200) return { body, overflow };
    let code;
    try {
      code = overflow ? undefined : JSON.parse(body.toString('utf8'))?.error;
    } catch {
      // Falls through to the refusal below.
    }
    if (!CODES[status].includes(code)) throw unexpected();
    if (code !== 'unavailable') throw refusal(code, MESSAGES[code](what));
    last = unavailable('The download service is not available right now.');
  }
  throw last;
}

/**
 * Opens one Design System release on the download service, as a source for
 * `install`: its manifest, fetched and checked now, and a way to fetch each
 * archive it names when the installer asks for it.
 *
 *   const source = await downloadSource({ origin, version: '0.1.0', credential });
 *   try {
 *     await install({ project, source, renderers: ['react'] });
 *   } finally {
 *     source.close();
 *   }
 *
 * The caller is trusted to give the service's own origin and a credential the
 * service issued for this release; neither is read from the environment or
 * the command line here. The credential travels only in the `Authorization`
 * header of requests to that origin, and never appears in a URL or a refusal.
 * `close()` lets it go: `install` calls it once the last archive it needs has
 * arrived, before it writes anything or starts a package manager.
 *
 * Refusals are `InstallError`s with a `code`. This module writes nothing
 * anywhere, and `install` checks every archive before it changes a project.
 *
 * @param {object} options
 * @param {string} options.origin The service, as `https://host` or `https://host:port`.
 * @param {string} options.version The release, such as `0.1.0`.
 * @param {string} options.credential The bearer credential for this release.
 * @param {string | Buffer} [options.ca] The only certificate authority to
 *   trust, for a rehearsal or test server that has its own. The certificate
 *   is checked either way.
 * @param {{ manifestMs: number, archiveMs: number }} [options.limits]
 * @returns {Promise<{ manifest: object, read: (file: string) => Promise<Buffer>, close: () => void }>}
 */
export async function downloadSource({ origin, version, credential, ca, limits = LIMITS }) {
  let base;
  try {
    base = new URL(origin);
  } catch {
    throw new InstallError('The download service address is not a URL.');
  }
  if (base.protocol !== 'https:' || `${base.origin}/` !== base.href || base.username || base.password) {
    throw new InstallError(
      'The download service address must be an https:// origin: a host, an optional port, and nothing else.',
    );
  }
  if (typeof version !== 'string' || !VERSION.test(version)) {
    throw new InstallError('The release version must be three numbers, such as 0.1.0.');
  }
  if (typeof credential !== 'string' || !CREDENTIAL.test(credential)) {
    throw new InstallError('The download credential is missing or is not a bearer token.');
  }

  const release = `${base.origin}/terminal/${DESIGN_SYSTEM.product}/releases/${version}`;
  const named = `Design System ${version}`;
  const invalid = (reason) =>
    refusal('invalid_release', `The download service's manifest for ${named} ${reason}`);

  const listed = await ask({
    url: `${release}/manifest`,
    expect: 'application/json',
    what: named,
    credential,
    ca,
    timeoutMs: limits.manifestMs,
    maxBytes: MAX_MANIFEST_BYTES,
  });
  if (listed.overflow) throw invalid('is larger than a manifest can be.');
  let manifest;
  let entries;
  try {
    manifest = JSON.parse(listed.body.toString('utf8'));
    entries = validateManifest(manifest);
  } catch (error) {
    if (!(error instanceof InstallError || error instanceof SyntaxError)) throw error;
    throw invalid('is not a release manifest this installer can use.');
  }
  if (manifest.version !== version) throw invalid('is for another release.');
  const files = new Map();
  for (const entry of entries.values()) {
    if (entry.file !== archiveName(entry.name, version) || entry.bytes > MAX_ARCHIVE_BYTES) {
      throw invalid('lists an archive under a name or size no package of this release has.');
    }
    files.set(entry.file, entry);
  }

  let held = credential;
  return {
    manifest,
    /** Fetches one archive the manifest names: exactly its recorded size once decoded, or a refusal. */
    async read(file) {
      const entry = files.get(file);
      if (entry === undefined) throw new InstallError(`That is not an archive of ${named}.`);
      if (held === undefined) {
        throw new InstallError(`This download of ${named} was closed. Open it again to fetch more.`);
      }
      const { body, overflow } = await ask({
        url: `${release}/archives/${file}`,
        expect: 'application/gzip',
        what: `${file} of ${named}`,
        credential: held,
        ca,
        timeoutMs: limits.archiveMs,
        maxBytes: entry.bytes,
      });
      if (overflow || body.length !== entry.bytes) {
        throw refusal(
          'invalid_release',
          `${file} arrived ${overflow ? 'longer' : 'shorter'} than the ${entry.bytes} bytes the release manifest records.`,
        );
      }
      return body;
    },
    /** Lets the credential go. Nothing more can be fetched afterwards. */
    close() {
      held = undefined;
    },
  };
}
