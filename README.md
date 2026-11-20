# Orbition Create

Home of `@orbition/create`, the planned installer for Orbition Design System and Foundation.

## Try the command locally

The command welcomes you and opens one browser page, where you sign in (if
you are not already) and allow this one install: Design System 0.1.0 only,
used once: Install must start within 15 minutes. Signing out blocks any
further authorization or download; once the files are downloaded, the
install can still finish on your computer. The command confirms that
permission with the site, then asks for the project folder and checks it,
lets you choose what to add, and shows a review of what adding it would
change. **Install** then downloads the release, checks every archive, adds it
to the project and runs the project's own install. Nothing in the project
changes, and nothing is downloaded, before you choose Install.

Until the Orbition site's address is confirmed, the command works only with a
local test site, `https://127.0.0.1:<port>` (a port other than 443), and only
with that site's certificate authority given explicitly, as a PEM file holding
exactly one certificate. Give the site with `--origin` or
`ORBITION_ORIGIN`, and the authority's PEM file with `--ca` or `ORBITION_CA`
(each flag wins over its variable). That file is the only authority trusted
for the site, and the site's certificate is always checked. Any other site is
refused. The command shows which site it uses before the browser is opened.

To try it against the application's local test site (a test-only build with
an in-memory provider and synthetic accounts, from an Orbition application
checkout whose site offers the install permission and its check,
`/terminal/approve/verify`), start that site from the checkout,
with its dependencies installed and no `.env` files in it (the first start
builds the site, which takes a few minutes):

```bash
node tests/e2e/auth-fixture/serve.ts 3192
```

It makes a throwaway certificate for `127.0.0.1`, valid for two days, in a
new scratch build each time it starts, at `.cache/auth-fixture-<id>/cert.pem`
in that checkout: the newest such folder's file is the authority to give
(`ls -td .cache/auth-fixture-*/ | head -1` shows it). An older copy's
certificate is refused.

On this local test site only, the address you sign up with decides the
synthetic account's access (the real site decides access from the account's
membership, never from its address):

| Sign-up address | Access on the local test site | What the command does |
| --- | --- | --- |
| Starts with `entitled-`, for example `entitled-walkthrough@example.com` | Design System access for one hour from when the sign-up code is sent | After **Allow**, the folder question |
| Any other address, for example `walkthrough@example.com` | None: the page says so and offers no **Allow**, only **Let the terminal know** or **Cancel** | After **Let the terminal know**, stops with the no-access reason before the folder question, nothing changed (after **Cancel**, stops as cancelled) |

The access is set only when the account is created, and the fixture keeps its
accounts in memory: each case needs its own new address, an `entitled-`
account needs a new one after its hour, and restarting the site forgets every
account. The fixture's verification code is `12345678` (the application's
`docs/technical/verification.md` describes it).

That stock fixture is enough for everything up to the permission, its check
and the exchange, but not for installing: it serves random bytes under the
archive names, which the installer refuses (nothing is installed). To
install, the local test site must serve actual release archives that match
their manifest, from a local application test setup made for that; this
repository does not prescribe how. Then, from an existing npm or pnpm
project (a scratch one: Install installs into it):

```bash
export ORBITION_ORIGIN=https://127.0.0.1:3192
export ORBITION_CA=/path/to/application/.cache/auth-fixture-<id>/cert.pem
node /path/to/create/src/cli.js
```

Press Enter to open the browser, sign in, and choose **Allow** (or
**Cancel**; without access, **Let the terminal know** or **Cancel**). Use `127.0.0.1`, not `localhost`: the site sends the browser to
its own configured address. The browser warns about the self-signed
certificate until you accept it. Then answer the folder question;
Enter takes the current folder.

Then choose what to add, with the keys: Up and Down move, Space marks a
renderer, Enter chooses, Ctrl+C stops (as does Ctrl+D, or the input ending).
Keys pasted together with the Enter that chooses are dropped; keys typed
after it are kept and answer the next list once it is shown.

1. **What would you like to add?** Builder and Foundation are shown as coming
   soon and cannot be chosen; Enter takes Design System 0.1.0.
2. **Which do you use?** React (marked at first), Web Components (plain HTML),
   or both; at least one must be marked.
3. **Review**: the project and its package manager, the packages (Core once,
   then each renderer), the archives that would be kept in `vendor/orbition`,
   `package.json` and the lockfile, and the install command that would follow.
   Then **Install**, **Change selections** (back to step 1 with your last
   answers; the permission and the folder stand), or **Cancel** (ends the run,
   nothing changed).

The project is checked again before the review and before Install, as the
install will check it (a package manager it uses, no workspace, no other
installer working in it, no other version of a Design System package
declared, and the archive of each declared package that is not being added
now still there). A project the install would refuse is refused there,
before anything is spent. If the project's package manager changed since the
review, the review is shown again with the new one: nothing is installed
with a package manager you did not review.

The archive names in the review are the ones the release is expected to
have. A project's name and folder are shown as plain text: any control,
direction-changing or invisible character is written as a `\u` escape, and a
backslash is doubled.

### The permission, Install, and allowing again

The browser page is the site's `/terminal/approve?product=design-system&version=0.1.0&purpose=install`
with this request's own state, PKCE challenge and listener port. The site
asks you to sign in if you are not, decides the account's access live, and
names exactly what you allow: Design System 0.1.0 only, used once: Install
must start within 15 minutes. Signing out blocks any further authorization
or download, since the check, the exchange and every download check the
session again; once every archive has been downloaded, nothing more is asked
of the site and the install can still finish on your computer. The
credential Install gets lives its own 10 minutes. **Allow** sends the command a
one-time code; Cancel or no access sends the reason instead.

The command then asks the site itself, `POST /terminal/approve/verify` with
the code and its own verifier, and asks for the project folder only if the
site answers exactly `200 {"status":"approved"}` for that release, with the
seconds the permission has left. That check spends nothing and gives no
credential. Choosing **Install** in the terminal is your decision, not proof
to the site: only then is the code exchanged, once, at `POST /terminal/token`
for a credential for 0.1.0 alone, and the site decides the account's access
again then and on every download.

| What happens                                                                 | What the command does                                                                  |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Cancelled or ran out of time in the browser, or no answer in 10 minutes       | Stops before the folder question, nothing changed                                      |
| No current access, account not ready, no such release                        | Stops with the reason, nothing changed                                                 |
| The check refused, not understood, not answered in 15 seconds, or with 30 seconds or less left | Stops before the folder question with the reason, nothing changed |
| Install: the 15 minutes to start it have passed (by the time the site gave, less 30 seconds) | Nothing sent; the review again, selections kept, with **Allow again in your browser, then install** |
| Install: the site says the permission was used or expired, or you signed out | The review again, selections kept, with **Allow again in your browser, then install** |
| Allowing again: cancelled, ran out of time, or the check refused for a reason that asking again can help | The review again, nothing changed                       |
| Install: rate limited, unavailable, or no answer in 15 seconds               | The review again with **Install**: the same permission can be tried again               |
| Install refused for access, or an answer not understood                       | Stops, nothing changed                                                                 |
| A download refused (for example after a sign-out), broken, or not matching the manifest | Stops before anything is written (one retry for a network fault or `503`) |
| Signed out after every archive was downloaded                                | The install goes on: nothing more is asked of the site                                 |
| The project or its package manager changed meanwhile                         | The review again before Install; stops before anything is written after it            |
| The archives check out                                                       | The install engine keeps them in `vendor/orbition`, declares them and updates the lockfile with the reviewed package manager; on any failure there it puts the project back |
| Then                                                                         | `npm install` or `pnpm install` in the project, its output shown, with the project still held so no other installer can start |

**Allow again in your browser, then install** opens the browser at once with
a new request (a new state, verifier and listener). If the browser is still
signed in it is one more click; after a sign-out it asks you to sign in
first. Once the site confirms it, the install goes on with the selections
you reviewed, unless the permission has too little time left (then the
review is shown again).

If that last install fails or is stopped, the run says so: the packages are
declared and kept, `node_modules` may be partly changed, and running the
project's install again finishes it (nothing has to be allowed again). The
command never retries a project it has changed. Running the installer again
on a project that has the release changes nothing in it but runs the install
again. Ctrl+C at any point before the engine writes leaves the project as it
was, and the run says what became of it otherwise.

The code, its verifier and the credential stay in the command's memory:
never shown, logged, written to a file, put in an argument or the
environment, and the package managers never get them. The download source
lets the credential go once the archives are in memory, before the project
is written.

What the permission grants: one exchange, for Design System 0.1.0 alone.
The questions that follow it read only local files and change none.
Everything protected stays with the site, which checks the account itself
on each request: the check, the exchange for a short-lived credential, and
every download with it. The site's older sign-in-only page
(`/terminal/sign-in`) is not used by this command. `node src/cli.js --help`
and `--version` need no site.
