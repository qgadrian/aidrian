// The forge token a project run hands its issue session, read outside the sandbox, which hides the system keyring from
// the session (docs/providers/claude-code.md#project-start). Three sources, in order, each with an id:
//   1. `project`, on macOS: the keychain entry the main checkout's local file (LOCAL_FILE) names in
//      projectRun.forgeTokenKeychain, read with `security find-generic-password -s <service> -a <account> -w`;
//   2. `machine`, on macOS and for github.com alone: the machine's default keychain entry, service
//      DEFAULT_KEYCHAIN_SERVICE with any account, which every project on the machine shares:
//      `security find-generic-password -s aidrian-project-run -w`;
//   3. `login`: the forge CLI's own login for the repository's host (forgeFor's authToken), wherever the CLI keeps it.
// Each keychain read is an argv with no shell. The start picks the first source that gives a token, checks that token
// may push, and records the source's id and the token's digest, with the digest of a claim it gives the session it
// launches (writeClaim). The session's SessionStart hook then reads that one source again, outside the sandbox, only for
// a session that holds the claim, and hands the sandboxed commands alone the token whose digest the start recorded, as
// the forge CLI's token variable for the host (forgeTokenVar); it records whether it did (writeHandoff), which the
// sandbox proof's check reads. No file of the run, argv, or printed line holds the token.

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { forgeFor, forgeGitHelper, forgeLoginStep, forgeTokenNote, forgeTokenVar } from './forges/index.mjs';
import { exists, writeJson } from './confine-guard.mjs';
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
  // The machine's default entry holds a github.com token: a run on any other host never reads it, so never sends it.
  if (platform === 'darwin' && String(host ?? '').toLowerCase() === 'github.com') list.push({ id: 'machine', label: DEFAULT_ENTRY, quiet: true, read: () => keychainToken({ service: DEFAULT_KEYCHAIN_SERVICE }, options) });
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
  return { problem: `no source gives a forge token for ${host}, of ${tried.join(', ')} (the login: ${whyNone(last)}), and an issue session reaches the forge only with one; ${recovery({ host, platform }).join(', or ')}`, notes };
}

// The steps that would give a run on `host` a token, from the sources it can use on `platform`: the forge CLI's login
// always; the machine's default keychain entry for github.com on macOS; a project keychain entry on macOS.
function recovery({ host, platform }) {
  const steps = [`sign the forge CLI in with \`${forgeLoginStep(host)}\``];
  if (platform !== 'darwin') return steps;
  if (String(host ?? '').toLowerCase() === 'github.com') steps.push(`add a keychain entry of service ${JSON.stringify(DEFAULT_KEYCHAIN_SERVICE)}`);
  return [...steps, `name one in projectRun.forgeTokenKeychain of ${LOCAL_FILE}`];
}

// The variables that hand `token` to the session's sandboxed commands: the forge CLI's token variable for `host` alone.
export const tokenVars = (token, host) => ({ [forgeTokenVar(host)]: token });

// The command-scope git config that makes git take that token from the forge CLI's credential helper, for the session's
// sandboxed commands, after the entries `env` already counts in GIT_CONFIG_COUNT, both scoped to `https://<host>`, the
// forge the session pushes to: an empty `credential.https://<host>.helper`, which drops every helper git collected
// for that host from the user's and the repository's config, then the CLI's own helper (forgeGitHelper). Another
// host keeps the user's own helpers, so the CLI never offers the run's token there. Null when the CLI is not on an
// absolute folder of PATH, or `host` is no plain host name.
export function gitCredentialVars(env, host) {
  const helper = forgeGitHelper(env);
  if (!helper || typeof host !== 'string' || !/^[A-Za-z0-9.-]+$/u.test(host)) return null;
  const key = `credential.https://${host}.helper`;
  const given = Number(env?.GIT_CONFIG_COUNT);
  const count = Number.isSafeInteger(given) && given >= 0 && /^\d+$/u.test(String(env?.GIT_CONFIG_COUNT ?? '')) ? given : 0;
  return {
    GIT_CONFIG_COUNT: String(count + 2),
    [`GIT_CONFIG_KEY_${count}`]: key, [`GIT_CONFIG_VALUE_${count}`]: '',
    [`GIT_CONFIG_KEY_${count + 1}`]: key, [`GIT_CONFIG_VALUE_${count + 1}`]: helper,
  };
}

// The token as the SessionStart hook of a confined session reads it again, outside the sandbox, from the main checkout
// `root`, from the source `only` the start recorded: forgeToken's answer, each read stopped at TOKEN_TIMEOUT_MS.
export const sessionToken = ({ root, repository, keychain, env = process.env, platform = process.platform, only }) =>
  forgeToken({ forge: forgeFor(root, { timeoutMs: TOKEN_TIMEOUT_MS, killSignal: 'SIGKILL' }), repository, keychain, env, platform, only });

// The variable that carries the start's claim into the environment of the session it launches, and so of its hooks, as
// the inline settings' `env` (lib/hosts/claude-code-background.mjs): no other session opened in the clone holds it.
export const CLAIM_VAR = 'AIDRIAN_START_CLAIM';
const CLAIM_FILE = 'token-claim.json';
// Where the SessionStart hook records whether it handed the token over, beside the claim, outside the sandbox's grants.
const HANDOFF_FILE = 'token-handoff.json';
const digest = (value) => createHash('sha256').update(String(value)).digest('hex');

// The SHA-256 of a token, as the claim keeps it: the start's checked token, which the hook's must match.
export const tokenDigest = (token) => digest(token);

// A new claim for one start: random, and only its digest is kept on disk.
export const newClaim = () => randomBytes(24).toString('hex');

// Writes the claim's digest, the token's source id, and the checked token's digest `token` to the attempt's folder
// `folder`, owner-only, a new file: null, or why it could not.
export function writeClaim(folder, { claim, source, token }) {
  try {
    writeFileSync(path.join(folder, CLAIM_FILE), `${JSON.stringify({ claim: digest(claim), source, token })}\n`, { flag: 'wx', mode: 0o600 });
    return null;
  } catch (error) {
    return `the attempt's token claim cannot be written (${error.code ?? 'no code'})`;
  }
}

// The source id and the checked token's digest the start recorded for the attempt's folder `folder`, when `env` holds
// the claim it gave the session it launched: { source, token }, or { problem } for a session that does not hold it, or
// an attempt with no claim, with `unclaimed: true` when the start wrote no claim file at all.
export function claimedSource(folder, env) {
  const read = readSmallJson(path.join(folder, CLAIM_FILE), 4096);
  if (!read || typeof read.claim !== 'string' || !SOURCE_IDS.includes(read.source) || typeof read.token !== 'string') return { problem: 'the start recorded no token claim for this attempt', ...(exists(path.join(folder, CLAIM_FILE)) ? {} : { unclaimed: true }) };
  const given = env?.[CLAIM_VAR];
  if (typeof given !== 'string' || digest(given) !== read.claim) return { problem: 'this session does not hold the claim the start gave the session it launched, so it is not that session' };
  return { source: read.source, token: read.token };
}

// Records in the attempt's folder `folder` whether the hook handed the token over (`handed`) and, when not, `why`:
// nothing secret. Null, or why it could not.
export const writeHandoff = (folder, { handed, why = null }) => writeJson(path.join(folder, HANDOFF_FILE), handed ? { handed: true } : { handed: false, why });

// Where the SessionStart hook records the host's session environment files it hands the forge token to, beside the
// claim, outside the sandbox's grants, so the driver's sweep removes them once the session ended (lib/project-start.mjs
// sweepAttempts): the host keeps each file after its session, token and all.
export const TOKEN_FILES = 'token-files.json';
// The most files one record keeps: one a SessionStart, which a resume, a clear, or a compact runs again.
const TOKEN_FILES_CAP = 64;

// Adds `file`, a session environment file of the host session `session`, to the record in the attempt's folder
// `folder`, before the token is written there: null, or why it could not.
export function recordTokenFile(folder, { session, file }) {
  if (typeof session !== 'string' || typeof file !== 'string' || !path.isAbsolute(file)) return 'the host named no session environment file it can remove once the session ends';
  const read = tokenFiles(folder);
  const files = read?.session === session ? read.files : [];
  if (!files.includes(file)) files.push(file);
  if (files.length > TOKEN_FILES_CAP) return 'the session has handed the token to too many files';
  return writeJson(path.join(folder, TOKEN_FILES), { session, files });
}

// Keeps only `files` in the record of `folder`, the ones the host could not remove yet, or removes the record when none
// is left: whether the record now says what is left.
export function keepTokenFiles(folder, { session, files }) {
  const file = path.join(folder, TOKEN_FILES);
  if (files.length) return writeJson(file, { session, files }) === null;
  try {
    rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

// The record recordTokenFile keeps in `folder`: { session, files }, or null when there is none, or it is no record.
export function tokenFiles(folder) {
  const read = readSmallJson(path.join(folder, TOKEN_FILES), 64 * 1024);
  if (!read || typeof read.session !== 'string' || !Array.isArray(read.files)) return null;
  return { session: read.session, files: read.files.filter((each) => typeof each === 'string' && path.isAbsolute(each)) };
}

// Why the attempt in `folder` holds no forge token its session was handed, or null: only for a start that expected one,
// whose claim is there; then a missing record, or one that says not handed, is the problem.
export function handoffProblem(folder) {
  if (!readSmallJson(path.join(folder, CLAIM_FILE), 4096)) return null;
  const read = readSmallJson(path.join(folder, HANDOFF_FILE), 4096);
  if (!read) return 'the session\'s SessionStart hook recorded no forge token handoff, so its pushes would not sign in';
  if (read.handed === true) return null;
  return `the forge token was not handed to the session: ${typeof read.why === 'string' ? read.why.slice(0, 300) : 'no reason given'}`;
}
