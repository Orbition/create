# Orbition Create

Home of `@orbition/create`, the planned installer for Orbition Design System and Foundation.

## Try the command locally

The command so far welcomes you, has you sign in in your browser, confirms
that sign-in with the site, asks for the project folder and checks it, then
stops. It changes nothing and downloads nothing.

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
checkout that includes verified sign-in), start that site from the checkout,
with its dependencies installed and no `.env` files in it (the first start
builds the site, which takes a few minutes):

```bash
node tests/e2e/auth-fixture/serve.ts 3192
```

It makes a throwaway certificate for `127.0.0.1`, valid for two days, in a
new scratch build each time it starts, at `.cache/auth-fixture-<id>/cert.pem`
in that checkout: the newest such folder's file is the authority to give
(`ls -td .cache/auth-fixture-*/ | head -1` shows it). An older copy's
certificate is refused. Sign up there with any address; the application's
`docs/technical/verification.md` ("Terminal approval walkthrough") gives the
fixture's verification code. Then, from an existing npm or pnpm project:

```bash
export ORBITION_ORIGIN=https://127.0.0.1:3192
export ORBITION_CA=/path/to/application/.cache/auth-fixture-<id>/cert.pem
node /path/to/create/src/cli.js
```

Press Enter to open the browser, sign in, and choose **Continue in the
terminal** (or **Cancel**). Use `127.0.0.1`, not `localhost`: the site sends
the browser to its own configured address. The browser warns about the
self-signed certificate until you accept it. Then answer the folder question;
Enter takes the current folder.

How the sign-in is confirmed: each run makes its own random state and PKCE
verifier, and the browser opens
`/terminal/sign-in?port=<port>&state=<state>&code_challenge=<challenge>&code_challenge_method=S256`.
After **Continue**, the site sends the browser to this command's listener on
`127.0.0.1` (a port the system picks) with a one-time code, and the command
stops listening. That hand-off alone proves nothing, since anything that can
reach the port could send one. The command then asks the site itself,
`POST /terminal/sign-in/verify` with the code and its own verifier, and goes
on only if the site answers exactly `200 {"status":"signed_in"}`. Any other
answer, a hand-off without a code (the site's older status-only answer), a
certificate the given authority does not vouch for, a redirect or no answer
within 15 seconds ends the run with nothing changed. The code and the
verifier are never shown or logged.

What a confirmed sign-in grants: nothing. The folder question that follows
reads only local files and changes none. Everything protected stays with the
site, which checks the account itself on each request: approving a release,
exchanging that approval for a short-lived credential, and every download
with it (not built in this command yet). `node src/cli.js --help` and
`--version` need no site.
