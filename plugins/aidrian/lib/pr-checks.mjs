// `aidrian pr checks`: one line and an exit code for a pull request's checks, so a watch loop costs one line per poll
// instead of the whole check table. The policy comes from config.json `github`:
//   - FAILURE, TIMED_OUT, ACTION_REQUIRED, STARTUP_FAILURE, or an unknown terminal state: failing.
//   - CANCELLED: failing, unless the name contains an `ignoreCancelledChecks` entry (a routine cancel, such as a
//     preview deploy skipped by an ignored build); those are listed as skipped.
//   - SKIPPED or NEUTRAL: passes, and is named in the output so nothing skips silently. When `conditionalChecks` lists
//     anything, only a check whose name contains an entry may skip (a job a path filter turns off, say); any other skip
//     is an unexpected skip, listed under `unexpected_skips`, and failing.
//   - `requiredChecks`: every check whose name contains an entry must be SUCCESS, and at least one must exist. Checks
//     register over time, so a required entry with no check yet is pending, never ready.
// The policy is this checkout's, so `-R` may name only a repository that is a remote of this checkout, by its host and
// full path (namesRemote; a bare `owner/repo`, an SSH alias remote, or a local remote compares the path alone): for a
// pull request in another repository, run the command from that repository's checkout.
// Exit 0 ready, 1 failing, 2 pending, 3 error (gh missing, no pull request, unreadable output, another repository, or a
// config.json with errors).

import { forgeFor, repoIdentity } from './forges/index.mjs';
import { runGit } from './git.mjs';

const NON_TERMINAL = new Set(['IN_PROGRESS', 'QUEUED', 'PENDING', 'WAITING', 'REQUESTED', 'EXPECTED']);
const HARD_FAIL = new Set(['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const EXIT_BY_VERDICT = { ready: 0, failing: 1, pending: 2 };

// The verdict over `gh pr checks --json name,state` rows: { verdict, reason, failing, pending, skipped, unexpected_skips }.
export function computeVerdict(rows, { requiredChecks = [], ignoreCancelledChecks = [], conditionalChecks = [] } = {}) {
  const failing = [];
  const pending = [];
  const skipped = [];
  const unexpected = [];
  const required = (name) => requiredChecks.some((part) => name.includes(part));
  const maySkip = (name) => !conditionalChecks.length || conditionalChecks.some((part) => name.includes(part));
  for (const row of rows) {
    const state = String(row.state ?? '').toUpperCase();
    if (NON_TERMINAL.has(state)) pending.push(row.name);
    else if (HARD_FAIL.has(state)) failing.push(`${row.name}=${state}`);
    else if (state === 'CANCELLED' && !required(row.name) && ignoreCancelledChecks.some((part) => row.name.includes(part))) skipped.push(`${row.name} (cancelled)`);
    else if ((state === 'SKIPPED' || state === 'NEUTRAL') && !required(row.name)) (maySkip(row.name) ? skipped : unexpected).push(row.name);
    else if (state !== 'SUCCESS') failing.push(`${row.name}=${state || '?'}${required(row.name) ? ' (required)' : ''}`);
  }
  for (const part of requiredChecks) {
    if (!rows.some((row) => row.name.includes(part))) pending.push(`${part} (required, not reported yet)`);
  }
  const lists = { failing, pending, skipped, unexpected_skips: unexpected };
  const problems = [...failing, ...(unexpected.length ? [`unexpected skip: ${unexpected.join(', ')}`] : [])];
  if (problems.length) return { verdict: 'failing', reason: problems.join('; '), ...lists };
  if (pending.length) return { verdict: 'pending', reason: `${pending.length} not terminal: ${pending.join(', ')}`, ...lists };
  const passed = rows.length - skipped.length;
  return { verdict: 'ready', reason: `${passed} pass${skipped.length ? `; skipped: ${skipped.join(', ')}` : ''}`, ...lists };
}

// [PR] [-R owner/repo] [--json]. `-R` needs an explicit number: a branch lookup in another repository is ambiguous.
export function parseCliArgs(argv) {
  let repo = null;
  let usage = null;
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const inline = argv[i].startsWith('--repo=');
    if (!inline && argv[i] !== '-R' && argv[i] !== '--repo') {
      rest.push(argv[i]);
      continue;
    }
    const flag = inline ? '--repo' : argv[i];
    repo = inline ? argv[i].slice('--repo='.length) : argv[++i] ?? null;
    // A missing value, or the next flag taken for one, is a usage error, not this checkout's repository.
    if (!repo || repo.startsWith('-')) usage ??= `${flag} needs owner/repo`;
  }
  const unknown = rest.find((arg) => arg !== '--json' && !/^#?\d+$/.test(arg));
  return { repo, asJson: rest.includes('--json'), prNumber: rest.find((arg) => /^#?\d+$/.test(arg))?.replace('#', '') ?? null, unknown, usage };
}

// GitHub's SSH endpoint on port 443, for networks that block port 22: the same repositories as github.com.
const HOST_ALIASES = { 'ssh.github.com': 'github.com' };
const sameHost = (identity) => (identity && Object.hasOwn(HOST_ALIASES, identity.host) ? { ...identity, host: HOST_ALIASES[identity.host] } : identity);

// One remote URL as `{ host, path, fork }` to match a `-R` value against, or null. `host` is null when the remote names
// no forge host to compare: a host with no dot is an SSH config alias (`git@github-work:acme/notes.git`), and a remote on
// this machine's disk (a path, or file://) keeps only its last two path parts, as gh's `owner/repo`.
export function remoteRepo(url) {
  const identity = sameHost(repoIdentity(url));
  if (identity) return identity.host.includes('.') ? identity : { ...identity, host: null };
  if (typeof url !== 'string') return null;
  const parts = url.trim().replace(/\/+$/u, '').replace(/\.git$/u, '').split(/[/:]/u).filter(Boolean);
  return parts.length >= 2 ? { host: null, path: parts.slice(-2).join('/').toLowerCase(), fork: null } : null;
}

// The repositories the checkout at `cwd` has as remotes, as remoteRepo values. A fork's upstream counts: same project.
export function checkoutRepos(cwd) {
  const { status, stdout } = runGit(['remote', '-v'], cwd);
  if (status !== 0) return [];
  const found = new Map();
  for (const line of stdout.split('\n').filter(Boolean)) {
    const remote = remoteRepo(line.split(/\s+/)[1] ?? '');
    if (remote) found.set(`${remote.host ?? ''}/${remote.path}`, remote);
  }
  return [...found.values()];
}

// Whether the `-R` value `given` names one of the `remotes` (remoteRepo values). The paths must be equal. A bare
// `owner/repo` names no host, and a remote with no host (an SSH alias, a local remote) has none to compare, so either
// matches by path alone; otherwise the hosts must be equal too. A value with spaces around it names nothing.
export function namesRemote(given, remotes) {
  if (typeof given !== 'string' || given !== given.trim()) return false;
  const wanted = sameHost(repoIdentity(given));
  if (!wanted) return false;
  const bare = !given.includes(':') && given.replace(/\/+$/u, '').split('/').length === 2;
  return remotes.some((remote) => remote.path === wanted.path && (bare || remote.host === null || remote.host === wanted.host));
}

// The CLI body. `forge` and `remotes` are the test seams: the forge facade, and () → checkoutRepos.
export function runChecks(
  argv,
  config,
  forge = forgeFor(undefined),
  remotes = () => checkoutRepos(process.cwd()),
) {
  const { prNumber, repo, asJson, unknown, usage } = parseCliArgs(argv);
  const fail = (message) => {
    console.error(`error: ${message}`);
    return 3;
  };
  if (usage) return fail(usage);
  if (unknown) return fail(`unknown argument: ${unknown}`);
  if (repo && !prNumber) return fail('-R/--repo needs an explicit pull request number');
  if (repo && !namesRemote(repo, remotes())) {
    return fail(`${repo} is not a remote of this checkout, and the check policy comes from this checkout's config.json: ` +
      `run aidrian pr checks from a checkout of ${repo}`);
  }
  let rows;
  try {
    rows = forge.checks(prNumber, { repo });
  } catch (error) {
    return fail(`could not read the checks with gh (${String(error?.message ?? error).split('\n')[0]})`);
  }
  if (!Array.isArray(rows) || rows.length === 0) return fail('gh returned no checks for this pull request');
  const result = computeVerdict(rows, config.github);
  console.log(asJson ? JSON.stringify(result) : `${result.verdict}: ${result.reason}`);
  return EXIT_BY_VERDICT[result.verdict];
}
