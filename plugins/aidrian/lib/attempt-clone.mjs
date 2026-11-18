// The clone a confined host's session works in for one attempt of a project run's issue (lib/project-start.mjs
// prepareAttempt), told apart from the state side alone: a checkout counts as an attempt clone when its real root is
// `<state>/runs/<run>/attempts/<issue>.<attempt>/work` and the run's ledger there holds a start row for that issue and
// attempt naming that folder. Nothing inside the clone is read for it, since the session writes there. The ledger's
// init row names the run's main checkout, which then stands as the clone's main checkout (lib/git.mjs checkoutRoots):
// the machine's switches and decisions come from that checkout's local file, never the clone's own, and the clone is no
// shared main checkout for the main-checkout rule. A clone whose link cannot be read reads every switch off.
// It also reads the clone's own git config, from its git folder beside it, for a key that makes git run a program
// (cloneConfigProblem): a hook refuses a call there while one is set, before any git call of its own runs there.
// It imports node built-ins only, as lib/git.mjs, which loads it, does.

import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';

// A path inside an attempt's folder: the state folder, the run, the issue, the attempt, and the part after it.
const ATTEMPT = /^(.+)\/runs\/([a-z0-9][a-z0-9-]{0,63})\/attempts\/((?:[A-Z][A-Z0-9]{0,15}-)?[1-9][0-9]{0,8})\.([1-9][0-9]{0,2})(\/.*)?$/u;
// The largest ledger read for a clone's link.
const LEDGER_CAP = 16 * 1024 * 1024;

const real = (file) => {
  try {
    return realpathSync(file);
  } catch {
    return null;
  }
};

// The attempt whose folder holds the path `file`, by its real path: { state, run, key, attempt, folder, work, git,
// drop }, or null.
export function attemptOf(file) {
  const resolved = real(file) ?? path.resolve(file);
  const match = ATTEMPT.exec(resolved.split(path.sep).join('/'));
  if (!match) return null;
  const [, state, run, key, attempt] = match;
  const folder = path.join(state, 'runs', run, 'attempts', `${key}.${attempt}`);
  return { state, run, key, attempt: Number(attempt), folder, work: path.join(folder, 'work'), git: path.join(folder, 'git'), drop: path.join(folder, 'drop') };
}

// The rows of the ledger file `file`, read without following a link from a regular file with one link, or null.
function ledgerRows(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > LEDGER_CAP) return null;
    const buffer = Buffer.alloc(stat.size);
    const read = readSync(fd, buffer, 0, stat.size, 0);
    return buffer.subarray(0, read).toString('utf8').split('\n').filter(Boolean).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    });
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// What the checkout root `root` is as an attempt clone: null when its real path is no attempt's work folder; else the
// attempt (attemptOf) with `main`, the run's main checkout the ledger's init row names, when the ledger holds a start
// row for that issue and attempt naming this folder, and that main checkout is a git checkout outside the state folder;
// or with `unlinked: true` when any of that cannot be read.
export function attemptClone(root) {
  const at = attemptOf(root);
  if (!at || real(root) !== at.work) return null;
  const rows = ledgerRows(path.join(at.state, 'runs', at.run, 'ledger.jsonl'));
  const [init] = rows ?? [];
  const named = (row) => [row.drop && real(row.drop) === at.drop, row.cwd && real(row.cwd) === at.work].some(Boolean);
  const started = (rows ?? []).some((row) => row?.event === 'start' && row.key === at.key && row.attempt === at.attempt && named(row));
  const main = init?.event === 'init' && init.run === at.run && typeof init.main === 'string' && path.isAbsolute(init.main) ? real(init.main) : null;
  const linked = started && main !== null && main !== at.work && !(`${main}/`.startsWith(`${at.state}/`)) && real(path.join(main, '.git')) !== null;
  return linked ? { ...at, main } : { ...at, unlinked: true };
}

// The keys that make git run a program, or send where it should not, in a clone's own config, as patterns over the
// lower-case key, each with the values that refuse (any, by default): the repository check's (lib/project-trust.mjs
// REFUSED_KEYS, all of which a clone's own config may not set) and the signature programs git runs to show a signature.
const PROGRAM_KEYS = [
  [/^core\.(?:sshcommand|gitproxy|askpass|alternaterefscommand|worktree|hookspath|editor|pager)$/u],
  [/^core\.fsmonitor$/u, (value) => !/^(?:true|false|yes|no|on|off|1|0)$/iu.test(value)],
  [/^credential\.(?:.+\.)?helper$/u],
  [/^remote\..+\.(?:uploadpack|receivepack|vcs|proxy)$/u],
  [/^http\.(?:.+\.)?proxy$/u],
  [/^(?:include\.path|includeif\..+)$/u],
  [/^filter\..+\.(?:clean|smudge|process)$/u],
  [/^diff\..+\.(?:command|textconv)$/u],
  [/^(?:diff|merge)\.external$|^merge\..+\.driver$/u],
  [/^protocol\.(?:.+\.)?allow$/u],
  [/^gpg\.(?:.+\.)?program$/u],
  [/^(?:log\.showsignature|commit\.gpgsign|tag\.gpgsign|push\.gpgsign)$/u, (value) => /^(?:true|yes|on|1|if-asked)$/iu.test(value)],
  [/^(?:sequence\.editor|pager\..+|alias\..+)$/u],
];

// Why a call in the folder `cwd` may not run because the attempt clone it lies in sets, in its own git config, a key
// that makes git run a program (PROGRAM_KEYS), or null. The config is the file in the attempt's git folder, beside the
// clone, read with `git config --file` and no other git call; a config that cannot be read refuses.
export function cloneConfigProblem(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return null;
  const at = attemptOf(cwd);
  if (!at) return null;
  const file = path.join(at.git, 'config');
  try {
    if (!lstatSync(file).isFile()) return `the attempt clone's git config, ${file}, is not a regular file`;
  } catch (error) {
    return error.code === 'ENOENT' ? null : `the attempt clone's git config, ${file}, cannot be read`;
  }
  const read = spawnSync('git', ['config', '--file', file, '--list', '-z'], { encoding: 'utf8', timeout: 2000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  if (read.error || read.status !== 0) return `the attempt clone's git config, ${file}, cannot be read`;
  for (const pair of read.stdout.split('\0').filter(Boolean)) {
    const at2 = pair.indexOf('\n');
    const key = (at2 < 0 ? pair : pair.slice(0, at2)).toLowerCase();
    const value = at2 < 0 ? '' : pair.slice(at2 + 1);
    const refused = PROGRAM_KEYS.find(([pattern, refuses]) => pattern.test(key) && (!refuses || refuses(value)));
    if (refused) return `the attempt clone's own git config sets ${key}, which makes git run a program or send elsewhere, so no git runs there until it is removed`;
  }
  return null;
}
