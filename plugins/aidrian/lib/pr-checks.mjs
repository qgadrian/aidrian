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
// The policy is this checkout's, so `-R` may name only a repository that is a remote of this checkout: for a pull
// request in another repository, run the command from that repository's checkout.
// Exit 0 ready, 1 failing, 2 pending, 3 error (gh missing, no pull request, unreadable output, another repository, or a
// config.json with errors).

import { runGh } from './gh.mjs';
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
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '-R' || argv[i] === '--repo') repo = argv[++i] ?? null;
    else if (argv[i].startsWith('--repo=')) repo = argv[i].slice('--repo='.length);
    else rest.push(argv[i]);
  }
  const unknown = rest.find((arg) => arg !== '--json' && !/^#?\d+$/.test(arg));
  return { repo, asJson: rest.includes('--json'), prNumber: rest.find((arg) => /^#?\d+$/.test(arg))?.replace('#', '') ?? null, unknown };
}

// `owner/repo`, lowercased, from `[HOST/]OWNER/REPO` or a remote URL: https, ssh, or `git@host:owner/repo.git`.
export const repoKey = (value) => value.replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).slice(-2).join('/').toLowerCase();

// The repositories the checkout at `cwd` has as remotes, as repoKey values. A fork's upstream counts: same project.
export function checkoutRepos(cwd) {
  const { status, stdout } = runGit(['remote', '-v'], cwd);
  if (status !== 0) return [];
  return [...new Set(stdout.split('\n').filter(Boolean).map((line) => repoKey(line.split(/\s+/)[1] ?? '')))];
}

// The CLI body. `gh` and `remotes` are the test seams: (args) → stdout, and () → checkoutRepos.
export function runChecks(
  argv,
  config,
  gh = (args) => runGh(args),
  remotes = () => checkoutRepos(process.cwd()),
) {
  const { prNumber, repo, asJson, unknown } = parseCliArgs(argv);
  const fail = (message) => {
    console.error(`error: ${message}`);
    return 3;
  };
  if (unknown) return fail(`unknown argument: ${unknown}`);
  if (repo && !prNumber) return fail('-R/--repo needs an explicit pull request number');
  if (repo && !remotes().includes(repoKey(repo))) {
    return fail(`${repo} is not a remote of this checkout, and the check policy comes from this checkout's config.json: ` +
      `run aidrian pr checks from a checkout of ${repo}`);
  }
  let rows;
  try {
    rows = JSON.parse(gh(['pr', 'checks', ...(prNumber ? [prNumber] : []), ...(repo ? ['--repo', repo] : []), '--json', 'name,state']));
  } catch (error) {
    // gh pr checks exits 8 while checks are pending, with the JSON on stdout.
    try {
      rows = JSON.parse(error.stdout ?? '');
    } catch {
      return fail(`could not read the checks with gh (${String(error?.message ?? error).split('\n')[0]})`);
    }
  }
  if (!Array.isArray(rows) || rows.length === 0) return fail('gh returned no checks for this pull request');
  const result = computeVerdict(rows, config.github);
  console.log(asJson ? JSON.stringify(result) : `${result.verdict}: ${result.reason}`);
  return EXIT_BY_VERDICT[result.verdict];
}
