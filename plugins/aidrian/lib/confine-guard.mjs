// The agent gate hook's side of the per-start sandbox proof (lib/project-confine.mjs is the start's and the proof's):
// what holds a session to its proof, the one command it may run until the start confirms it, the file-tool reads its
// sandbox denies, and the host's sandbox escape. Kept apart from the proof's probes, so the hook loads only this.
// docs/providers/claude-code.md#the-sandbox-proof.

import { randomBytes } from 'node:crypto';
import { lstatSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { attemptOf, systemReal } from './attempt-clone.mjs';
import { bashCall } from './config-guard.mjs';
import { readSmallJson } from './fs.mjs';
import { fileReadOf } from './hosts/index.mjs';
import { CONFINE_STATES } from './unattended-mark.mjs';

// The plan the start writes in the attempt's folder, the verdict the proof writes in the drop folder, and the lock that
// lets the proof run once a start.
export const CONFINE_PLAN = 'confine-plan.json';
export const CONFINE_VERDICT = 'confine.json';
export const CONFINE_LOCK = 'confine.lock';
// The shell environment the start writes in the attempt's folder: project-start.mjs's SHELL_VARS, which imports modules
// this one must not load in a hook's first steps; test/project-confine.test.mjs holds the two equal.
export const SHELL_VARS = 'shell-env.json';
// The largest verdict read: one with every read's salted sight.
export const VERDICT_CAP = 1024 * 1024;

// The real path of `file` where the system lands (attempt-clone.mjs systemReal), or null.
const real = systemReal;
// Whether `file` is `folder` or under it, the file system's root included.
export const within = (folder, file) => file === folder || file.startsWith(folder.endsWith(path.sep) ? folder : `${folder}${path.sep}`);
// Whether something is at `file`; a path that cannot be checked counts as there.
export const exists = (file) => {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    return error.code !== 'ENOENT' && error.code !== 'ENOTDIR';
  }
};

// Writes `value` as JSON to `file` through a temporary file beside it: null, or why it could not.
export function writeJson(file, value) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
    return null;
  } catch (error) {
    rmSync(temporary, { force: true });
    return `${file} cannot be written (${error.code ?? 'no code'})`;
  }
}

// Why the cache variables of the attempt in `folder` reach `env`, the host process's environment as a hook gets it, or
// null: a variable whose value names the attempt's cache folder, which only the session's sandboxed commands may get.
export function hostVarsProblem(folder, env) {
  const expected = readSmallJson(path.join(folder, SHELL_VARS));
  if (!expected) return null;
  const cache = path.join(folder, 'cache');
  const leaked = Object.entries(expected).filter(([name, value]) => typeof value === 'string' && value.includes(cache) && env[name] === value).map(([name]) => name);
  return leaked.length ? `the host process's own environment holds the cache variables ${leaked.join(', ')}, which only the session's sandboxed commands may get` : null;
}

// The attempt whose clone holds the folder of the call in `input`, when the start wrote a proof plan beside it, as a
// hold that owes the proof; else null. The folder is read every way readsStore reads a path: as the system resolves
// it, where a `..` after a link climbs from the link's target, and folded as text first, from the nearest folder above
// it that is there when it does not resolve, as a dangling link or a missing folder.
function cloneHold(input) {
  if (typeof input.cwd !== 'string') return null;
  for (const at of [real(input.cwd), realOf(path.resolve(input.cwd))]) {
    const attempt = at ? attemptOf(at) : null;
    if (attempt && within(attempt.work, at) && exists(path.join(attempt.folder, CONFINE_PLAN))) return { attempt, state: true };
  }
  return null;
}

// What holds the session of `input`, by its unattended mark `mark`, to its sandbox proof: { attempt, state } with
// `state` the mark's confine state (true while owed), or null when no proof holds it. A readable mark of the session's
// own holds by its confine state, a state that cannot be read counting as failed, or, with none, through a plan beside
// its clone. With no readable mark of its own (none, one that cannot be read, or any pending mark, whichever start filed
// it), any call whose folder lies in an attempt's clone with a proof plan owes the proof.
function proofHold(input, mark) {
  const own = mark !== null && typeof mark === 'object' && !mark.pending && typeof mark.root === 'string';
  if (own) {
    const attempt = typeof mark.cwd === 'string' ? attemptOf(mark.cwd) : null;
    if (mark.confine !== undefined) return { attempt, state: CONFINE_STATES.includes(mark.confine) ? mark.confine : 'failed' };
    if (mark.issue && attempt && exists(path.join(attempt.folder, CONFINE_PLAN))) return { attempt, state: true };
  }
  return cloneHold(input);
}

// The program words `aidrian project confine` may run under: `aidrian` on PATH, or this plugin's own command by its path.
const BIN = path.resolve(import.meta.dirname, '../bin/aidrian');
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

// Whether the call in `input` is exactly `aidrian project confine <run> <issue>` for `attempt`, alone, on one line, its
// words apart by spaces or tabs only, with at most one line end after it.
export function isConfineCall(input, attempt) {
  if (!bashCall(input) || typeof input.tool_input?.command !== 'string') return false;
  const program = `(?:aidrian|${escaped(BIN)}|'${escaped(BIN)}')`;
  return new RegExp(`^[ \\t]*${program}[ \\t]+project[ \\t]+confine[ \\t]+${escaped(attempt.run)}[ \\t]+${escaped(attempt.key)}[ \\t]*\\n?$`, 'u').test(input.tool_input.command);
}

// The real path of `file`, or of the nearest folder above it that is there, joined with the rest.
function realOf(file) {
  const found = real(file);
  if (found) return found;
  const above = path.dirname(file);
  return above === file ? file : path.join(realOf(above), path.basename(file));
}

// The store of `unreadable` a file-tool read in `input` reaches, a folder it names holding one, or one holding it, or
// null: the host names its read tools and their paths (hosts/index.mjs fileReadOf), a path with none being the call's
// folder. Each path is read both ways a tool may: folded as text first, and as the system resolves it, where a `..`
// after a link climbs from the link's target.
function readsStore(input, unreadable) {
  const targets = fileReadOf(input);
  if (!targets) return null;
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const stores = unreadable.filter((each) => typeof each === 'string' && path.isAbsolute(each)).map((each) => realOf(each));
  for (const target of targets) {
    const spelled = typeof target === 'string' && target !== '' ? target : '.';
    const files = [realOf(path.resolve(cwd, spelled)), real(path.isAbsolute(spelled) ? spelled : `${cwd}/${spelled}`)].filter(Boolean);
    const store = stores.find((each) => files.some((file) => within(each, file) || within(file, each)));
    if (store) return store;
  }
  return null;
}

// Why the agent gate hook refuses the call in `input` of a session no Human attends, whose unattended mark is `mark`,
// when the host's own sandbox escape is asked for (`sandbox_escape`, which a host's adapter maps its own parameter to,
// as Claude Code's `dangerouslyDisableSandbox`), as { match, reason }, or null.
export function sandboxEscapeDenial(input, { mark }) {
  if (mark === null || mark === undefined || input.sandbox_escape !== true) return null;
  return { match: 'sandbox escape', reason: 'aidrian: this call is blocked: it asks to run outside the host\'s sandbox, and a session no Human attends runs every command inside it; run it without that.' };
}

// Why the agent gate hook refuses the call in `input`, for the session whose unattended mark is `mark`, as { match,
// reason }, or null. A file-tool read that reaches a store the proof's plan lists as unreadable is refused, whatever the
// proof's state. While the proof is owed, only the exact confine command runs, and only while no verdict is there and
// the host process's environment, `env`, the hook's own, holds none of the session's cache variables: one that does
// fails the proof, in a verdict the hook writes. Once the proof failed, nothing runs. Once it passed but the start has
// not confirmed it in the mark yet, the call waits. A proof that holds the session but cannot be read refuses the call.
export function confineDenial(input, { mark, env = process.env } = {}) {
  let held;
  try {
    held = proofHold(input, mark);
  } catch {
    held = mark?.confine !== undefined ? { attempt: null, state: true } : null;
  }
  if (!held) return null;
  const deny = (match, why) => ({ match, reason: `aidrian: this call is blocked: ${why}.` });
  const stopped = 'the start stops it and halts the run, and the agent gate hook refuses every later call of this session; nothing more runs here';
  const failed = `its sandbox proof failed, so ${stopped}`;
  if (held.state === 'failed') return deny('sandbox proof failed', `this session no Human attends ${failed}`);
  if (!held.attempt) return deny('sandbox proof owed', 'this session no Human attends must prove its sandbox first, and the hook cannot find the attempt it works');
  try {
    const plan = readSmallJson(path.join(held.attempt.folder, CONFINE_PLAN));
    const store = Array.isArray(plan?.unreadable) ? readsStore(input, plan.unreadable) : null;
    if (store) return deny('reads a denied store', `it reads ${store}, which the sandbox of a session no Human attends hides, and its file tools run outside that sandbox`);
    if (held.state === 'passed') return null;
    const verdict = readSmallJson(path.join(held.attempt.drop, CONFINE_VERDICT), VERDICT_CAP);
    if (verdict && verdict.pass !== true) return deny('sandbox proof failed', `this session no Human attends ${failed}`);
    if (verdict) return deny('sandbox proof unconfirmed', 'the sandbox proof of this session ran, and the start that runs it confirms it within seconds; run the next step again in a few seconds');
    if (isConfineCall(input, held.attempt)) {
      const leaked = hostVarsProblem(held.attempt.folder, env);
      if (!leaked) return null;
      writeJson(path.join(held.attempt.drop, CONFINE_VERDICT), {
        version: 1, run: held.attempt.run, key: held.attempt.key, attempt: held.attempt.attempt, nonce: plan?.nonce ?? null,
        session: typeof input.session_id === 'string' ? input.session_id : null, pass: false, failed: [leaked], by: 'hook', at: new Date().toISOString(),
      });
      return deny('sandbox proof failed', `${leaked}, so this session's sandbox proof failed: ${stopped}`);
    }
    return deny('sandbox proof owed', `this session no Human attends runs nothing before it proves its sandbox: its first call must be exactly \`aidrian project confine ${held.attempt.run} ${held.attempt.key}\`, alone, with the Bash tool, run in its clone`);
  } catch {
    return deny('sandbox proof owed', 'this session no Human attends must prove its sandbox first, and its proof cannot be read');
  }
}
