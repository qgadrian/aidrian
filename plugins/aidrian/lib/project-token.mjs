// The forge token a project run hands its issue session, read outside the sandbox, which hides the system keyring from
// the session (docs/providers/claude-code.md#project-start). Three sources, in order:
//   1. on macOS, the project's keychain entry: the one the main checkout's local file (LOCAL_FILE) names in
//      projectRun.forgeTokenKeychain, read with `security find-generic-password -s <service> -a <account> -w`;
//   2. on macOS, the machine's default keychain entry, service DEFAULT_KEYCHAIN_SERVICE with any account, which every
//      project on the machine shares: `security find-generic-password -s aidrian-project-run -w`;
//   3. the forge CLI's own login for the repository's host (forgeFor's authToken), wherever the CLI keeps it.
// Each keychain read is an argv with no shell. The token reaches only the session's sandboxed commands, as the forge
// CLI's token variable (forgeTokenVar): the SessionStart hook hands it to the host (capabilities.projectStart.shellEnv),
// and nothing writes it in the clone, the state folder, an argv, or a line any command prints. The start and the
// preflight read it too, to halt a start that would have none and name the source it found.

import { execFileSync } from 'node:child_process';

import { forgeFor, forgeLoginStep, forgeTokenNote, forgeTokenVar } from './forges/index.mjs';
import { programNames, programOnPath } from './hosts/process.mjs';
import { LOCAL_FILE } from './project.mjs';

// What `security` exits with when no entry matches (errSecItemNotFound).
const NOT_FOUND = 44;
// How long one read may take: each reads a local store, and the SessionStart hook that reads again has 5 seconds in
// all for up to three of them.
export const TOKEN_TIMEOUT_MS = 1500;
// The service of the machine's default keychain entry, which any project's run reads when its own local file names none.
export const DEFAULT_KEYCHAIN_SERVICE = 'aidrian-project-run';
// A token as a shell's single quotes and the forge CLI take it: printable, no space, and of a sane length.
const TOKEN_SHAPE = /^[\x21-\x7e]{8,4096}$/u;

const projectEntry = ({ service, account }) => `the project's keychain entry service ${JSON.stringify(service)}, account ${JSON.stringify(account)} (projectRun.forgeTokenKeychain)`;
const DEFAULT_ENTRY = `the machine's default keychain entry, service ${JSON.stringify(DEFAULT_KEYCHAIN_SERVICE)}`;
const firstLine = (error) => String(error?.message ?? error).split('\n')[0].slice(0, 200);

// The password of the keychain entry `entry` ({ service, account }, or { service } for any account), read with macOS's
// `security`, the first on an absolute folder of `env`'s PATH, as the forge CLI is found: { token }, { missing: true }
// when no entry matches, or { problem }. `exec` is execFileSync's shape, the test seam.
export function keychainToken(entry, { env = process.env, exec = execFileSync, timeoutMs = TOKEN_TIMEOUT_MS } = {}) {
  const security = programOnPath(env, programNames('security'));
  if (!security) return { problem: 'cannot be read: macOS\'s security tool is not on PATH' };
  let out;
  try {
    const account = typeof entry.account === 'string' ? ['-a', entry.account] : [];
    out = exec(security, ['find-generic-password', '-s', entry.service, ...account, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, killSignal: 'SIGKILL' });
  } catch (error) {
    if (error?.status === NOT_FOUND) return { missing: true };
    return { problem: error?.code === 'ETIMEDOUT' ? `it did not answer in ${timeoutMs / 1000} s` : `it could not be read (${firstLine(error)})` };
  }
  const token = String(out).trim();
  return TOKEN_SHAPE.test(token) ? { token } : { problem: 'its password is not shaped like a token' };
}

// The token of the first keychain entry that gives one, on macOS: the project's `keychain`, then the machine's
// default entry: { token, source, notes }, or { notes } saying why each that was there to read gave none. Off macOS,
// a project entry is a note that it is unsupported. A default entry that is not there is no note: most machines have none.
function fromKeychain({ keychain, platform, env, exec, timeoutMs }) {
  if (platform !== 'darwin') return { notes: keychain ? [`projectRun.forgeTokenKeychain in ${LOCAL_FILE} reads the macOS keychain, which ${platform} has not, so the forge CLI's login gives the token`] : [] };
  const notes = [];
  const entries = [...(keychain ? [{ entry: keychain, label: projectEntry(keychain) }] : []), { entry: { service: DEFAULT_KEYCHAIN_SERVICE }, label: DEFAULT_ENTRY }];
  for (const { entry, label } of entries) {
    const read = keychainToken(entry, { env, exec, timeoutMs });
    if (read.token) return { token: read.token, source: label, notes };
    if (read.missing && entry === keychain) notes.push(`${label} is not there, so the next source gives the token`);
    if (read.problem) notes.push(`${label} ${read.problem}, so the next source gives the token`);
  }
  return { notes };
}

// The forge token for the issue sessions of a run on `repository` ({ host, ... }), from the project's keychain entry
// `keychain` or the machine's default one on `platform`, else from the forge facade `forge`'s login: { token, source,
// notes }, or { problem, notes } when none gives one. `source` names where it came from and `notes` what to know,
// never the token itself. `env` gives the PATH `security` is found on.
export function forgeToken({ forge, repository, keychain = null, platform = process.platform, env = process.env, exec, timeoutMs = TOKEN_TIMEOUT_MS }) {
  const host = repository?.host;
  const first = fromKeychain({ keychain, platform, env, exec, timeoutMs });
  const notes = [...first.notes];
  let token = first.token ?? null;
  let source = first.source ?? null;
  let why = null;
  if (!token) {
    try {
      const given = forge.authToken({ host });
      if (TOKEN_SHAPE.test(given ?? '')) [token, source] = [given, `the forge CLI's login for ${host}`];
      else why = 'it gave no token';
    } catch (error) {
      why = firstLine(error);
    }
  }
  if (!token) {
    const entries = keychain ? [projectEntry(keychain), DEFAULT_ENTRY] : [DEFAULT_ENTRY];
    const tried = [...(platform === 'darwin' ? entries : []), 'the forge CLI\'s login'];
    return { problem: `no source gives a forge token for ${host}, of ${tried.join(', ')} (the login: ${why}), and an issue session reaches the forge only with one; sign the forge CLI in with \`${forgeLoginStep(host)}\`, or add a keychain entry of service ${JSON.stringify(DEFAULT_KEYCHAIN_SERVICE)}, or name one in projectRun.forgeTokenKeychain of ${LOCAL_FILE}`, notes };
  }
  const kind = forgeTokenNote(token);
  return { token, source, notes: kind ? [...notes, kind] : notes };
}

// The variables that hand `token` to the session's sandboxed commands: the forge CLI's token variable alone.
export const tokenVars = (token) => ({ [forgeTokenVar()]: token });

// The token as the SessionStart hook of a confined session reads it for itself, outside the sandbox, from the main
// checkout `root`: forgeToken's answer, each read stopped at TOKEN_TIMEOUT_MS so the hook keeps within its budget.
export const sessionToken = ({ root, repository, keychain, env = process.env, platform = process.platform }) =>
  forgeToken({ forge: forgeFor(root, { timeoutMs: TOKEN_TIMEOUT_MS, killSignal: 'SIGKILL' }), repository, keychain, env, platform });
