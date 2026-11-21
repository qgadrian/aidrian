// The forge token a project run hands its issue session, read outside the sandbox, which hides the system keyring from
// the session (docs/providers/claude-code.md#project-start). Three sources, in order, each with an id:
//   1. `project`, on macOS: the keychain entry the main checkout's local file (LOCAL_FILE) names in
//      projectRun.forgeTokenKeychain, read with `security find-generic-password -s <service> -a <account> -w`;
//   2. `machine`, on macOS: the machine's default keychain entry, service DEFAULT_KEYCHAIN_SERVICE with any account,
//      which every project on the machine shares: `security find-generic-password -s aidrian-project-run -w`;
//   3. `login`: the forge CLI's own login for the repository's host (forgeFor's authToken), wherever the CLI keeps it.
// Each keychain read is an argv with no shell. The start picks the first source that gives a token, checks that token
// may push, and records only the source's id, with the digest of a claim it gives the session it launches (writeClaim).
// The session's SessionStart hook then reads that one source again, outside the sandbox, only for a session that holds
// the claim, and hands the token to the sandboxed commands alone, as the forge CLI's token variable (forgeTokenVar).
// No file of the run, argv, or printed line holds the token.

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { forgeFor, forgeLoginStep, forgeTokenNote, forgeTokenVar } from './forges/index.mjs';
import { readSmallJson } from './fs.mjs';
import { programNames, programOnPath } from './hosts/process.mjs';
import { LOCAL_FILE } from './project.mjs';

// What `security` exits with when no entry matches (errSecItemNotFound).
const NOT_FOUND = 44;
// How long one read may take: each reads a local store, and the SessionStart hook that reads again has 5 seconds in all.
export const TOKEN_TIMEOUT_MS = 1500;
// The service of the machine's default keychain entry, which any project's run reads when its own local file names none.
export const DEFAULT_KEYCHAIN_SERVICE = 'aidrian-project-run';
// A token as a shell's single quotes and the forge CLI take it: printable, no space, and of a sane length.
const TOKEN_SHAPE = /^[\x21-\x7e]{8,4096}$/u;
const SOURCE_IDS = Object.freeze(['project', 'machine', 'login']);

const projectEntry = ({ service, account }) => `the project's keychain entry service ${JSON.stringify(service)}, account ${JSON.stringify(account)} (projectRun.forgeTokenKeychain)`;
const DEFAULT_ENTRY = `the machine's default keychain entry, service ${JSON.stringify(DEFAULT_KEYCHAIN_SERVICE)}`;
const firstLine = (error) => String(error?.message ?? error).split('\n')[0].slice(0, 200);
const whyNone = (read) => (read?.missing ? 'it is not there' : read?.problem ?? 'it gave no token');

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

// The forge CLI's login token for `host`, through the forge facade `forge`: { token } or { problem }.
function loginToken(forge, host) {
  try {
    const given = forge.authToken({ host });
    return TOKEN_SHAPE.test(given ?? '') ? { token: given } : { problem: 'it gave no token' };
  } catch (error) {
    return { problem: firstLine(error) };
  }
}

// The sources this machine reads, in order: { id, label, quiet, read() }. `quiet` marks one whose absence is no note.
function sources({ keychain, platform, forge, host, env, exec, timeoutMs }) {
  const options = { env, exec, timeoutMs };
  const list = [];
  if (platform === 'darwin' && keychain) list.push({ id: 'project', label: projectEntry(keychain), read: () => keychainToken(keychain, options) });
  if (platform === 'darwin') list.push({ id: 'machine', label: DEFAULT_ENTRY, quiet: true, read: () => keychainToken({ service: DEFAULT_KEYCHAIN_SERVICE }, options) });
  list.push({ id: 'login', label: `the forge CLI's login for ${host}`, read: () => loginToken(forge, host) });
  return list;
}

// The forge token for the issue sessions of a run on `repository` ({ host, ... }): { token, id, source, notes } from
// the first source that gives one, or { problem, notes } when none does. With `only`, a source id the start recorded,
// that source alone is read, and its failure is the problem: a hook never falls back to another source. `source` names
// where the token came from and `notes` what to know, never the token itself. `env` gives the PATH `security` is on.
export function forgeToken({ forge, repository, keychain = null, platform = process.platform, env = process.env, exec, timeoutMs = TOKEN_TIMEOUT_MS, only = null }) {
  const host = repository?.host;
  const notes = platform !== 'darwin' && keychain ? [`projectRun.forgeTokenKeychain in ${LOCAL_FILE} reads the macOS keychain, which ${platform} has not, so the forge CLI's login gives the token`] : [];
  const all = sources({ keychain, platform, forge, host, env, exec, timeoutMs });
  const list = only ? all.filter((each) => each.id === only) : all;
  if (!list.length) return { problem: `the source the start checked, ${only}, is not one this machine reads now`, notes };
  let last = null;
  for (const each of list) {
    last = each.read();
    if (last.token) {
      const kind = forgeTokenNote(last.token);
      return { token: last.token, id: each.id, source: each.label, notes: kind ? [...notes, kind] : notes };
    }
    if (each !== list.at(-1) && !(last.missing && each.quiet)) notes.push(`${each.label} ${last.missing ? 'is not there' : last.problem}, so the next source gives the token`);
  }
  if (only) return { problem: `${list[0].label}, the source the start checked, gives no token now (${whyNone(last)})`, notes };
  const tried = all.map((each) => each.label.replace(/ for \S+$/u, ''));
  return { problem: `no source gives a forge token for ${host}, of ${tried.join(', ')} (the login: ${whyNone(last)}), and an issue session reaches the forge only with one; sign the forge CLI in with \`${forgeLoginStep(host)}\`, or add a keychain entry of service ${JSON.stringify(DEFAULT_KEYCHAIN_SERVICE)}, or name one in projectRun.forgeTokenKeychain of ${LOCAL_FILE}`, notes };
}

// The variables that hand `token` to the session's sandboxed commands: the forge CLI's token variable alone.
export const tokenVars = (token) => ({ [forgeTokenVar()]: token });

// The token as the SessionStart hook of a confined session reads it again, outside the sandbox, from the main checkout
// `root`, from the source `only` the start recorded: forgeToken's answer, each read stopped at TOKEN_TIMEOUT_MS.
export const sessionToken = ({ root, repository, keychain, env = process.env, platform = process.platform, only }) =>
  forgeToken({ forge: forgeFor(root, { timeoutMs: TOKEN_TIMEOUT_MS, killSignal: 'SIGKILL' }), repository, keychain, env, platform, only });

// The variable that carries the start's claim into the environment of the session it launches, and so of its hooks, as
// the inline settings' `env` (lib/hosts/claude-code-background.mjs): no other session opened in the clone holds it.
export const CLAIM_VAR = 'AIDRIAN_START_CLAIM';
const CLAIM_FILE = 'token-claim.json';
const digest = (value) => createHash('sha256').update(String(value)).digest('hex');

// A new claim for one start: random, and only its digest is kept on disk.
export const newClaim = () => randomBytes(24).toString('hex');

// Writes the claim's digest and the token's source id to the attempt's folder `folder`, owner-only, a new file: null,
// or why it could not.
export function writeClaim(folder, { claim, source }) {
  try {
    writeFileSync(path.join(folder, CLAIM_FILE), `${JSON.stringify({ claim: digest(claim), source })}\n`, { flag: 'wx', mode: 0o600 });
    return null;
  } catch (error) {
    return `the attempt's token claim cannot be written (${error.code ?? 'no code'})`;
  }
}

// The source id the start recorded for the attempt's folder `folder`, when `env` holds the claim it gave the session it
// launched: { source }, or { problem } for a session that does not hold it, or an attempt with no claim.
export function claimedSource(folder, env) {
  const read = readSmallJson(path.join(folder, CLAIM_FILE), 4096);
  if (!read || typeof read.claim !== 'string' || !SOURCE_IDS.includes(read.source)) return { problem: 'the start recorded no token claim for this attempt' };
  const given = env?.[CLAIM_VAR];
  if (typeof given !== 'string' || digest(given) !== read.claim) return { problem: 'this session does not hold the claim the start gave the session it launched, so it is not that session' };
  return { source: read.source };
}
