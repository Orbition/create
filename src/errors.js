/**
 * A refusal the person running the installer can act on: the message says
 * what was found and what to do. Anything else that is thrown is a bug.
 */
export class InstallError extends Error {
  name = 'InstallError';
}
