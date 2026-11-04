// `aidrian pr auto-merge [PR] [--json]`: whether a session may merge this pull request without asking. It is on only
// when all of these hold, and the first that fails is the reason it is off:
//   1. team: the base branch allows it. `github.autoMerge` is read from GitHub, as the pull request's repository commits
//      it on its base branch now: never from the working copy, its folder override, or a local ref, so a pull request
//      cannot raise its own ceiling, a fork checkout reads the upstream's, and no stale fetch keeps an old one.
//   2. local: this machine opted in, `github.autoMerge: "on"` in the local file (project.localAutoMerge).
//   3. author: the pull request is the gh user's own.
//   4. review: this machine's review record (lib/review/state.mjs), scoped to the pull request's repository, holds a
//      finished outcome (`received`, `none_needed`) on the pull request's current head, and nothing is owed.
// gh reads: one `gh pr view` for the number, head, base, author, and URL; the base's folder override and config.json
// through the contents API; and, only when the team and the machine both allow it, `gh api user` for the login. Every
// `gh api` call names the host of the pull request's URL.
// stdout: one line, or with --json { effective, reason, allow, local, strategy, deleteBranch, deleteWorktree, pr, head,
// repo }, the team values from the base. When the reason is local and the local file has errors, they go to stderr.
// Exit 0 on, 1 off, 3 error (an argument, a gh read, or a pull request gh describes only in part).

import { configFromText, resolveAutoMerge } from './config.mjs';
import { runGh } from './gh.mjs';
import { configPathIn } from './project.mjs';
import { prNumber, repoName } from './review-gate.mjs';
import { FINISHED, owed, readLocalState, sameCommit } from './review/state.mjs';
import { scoped } from './rules/github/merge-review.mjs';

const VIEW_FIELDS = 'number,headRefOid,baseRefName,author,url';
const SHA = /^[0-9a-f]{40}$/iu;

const firstLine = (error) => String(error?.message ?? error).split('\n')[0];
const notFound = (error) => /HTTP 404/u.test(`${error?.stderr ?? ''}\n${error?.message ?? ''}`);

// [PR] [--json], where PR is a number, `#number`, or a pull request URL: { target, asJson, unknown }.
export function parseArgs(argv) {
  const positional = argv.filter((arg) => arg !== '--json');
  const [first, ...extra] = positional;
  const valid = first === undefined || /^#?\d+$/u.test(first) || prNumber(first) !== null;
  return {
    target: first === undefined ? null : first.replace(/^#/u, ''),
    asJson: argv.includes('--json'),
    unknown: valid ? extra[0] ?? null : first,
  };
}

// The pull request as `gh pr view` describes it: { number, head, base, author, repo, host }, or a string naming what is
// missing.
export function readView(view) {
  const { number, headRefOid: head, baseRefName: base, url } = view ?? {};
  const author = view?.author?.login;
  let host = null;
  try {
    host = new URL(url).hostname || null;
  } catch {}
  const repo = typeof url === 'string' ? repoName(url) : null;
  if (!Number.isInteger(number) || typeof base !== 'string' || base === '' || typeof author !== 'string' || author === '' || !host || !repo) {
    return 'gh returned no number, base branch, author, or URL for the pull request';
  }
  if (typeof head !== 'string' || !SHA.test(head)) return `gh returned ${JSON.stringify(head ?? null)} as the head, not a full commit SHA`;
  return { number, head, base, author, repo, host };
}

// The config the base branch `base` of `repo` commits on GitHub now, by committedConfig's rules: its folder override
// first, then that folder's config.json. A file GitHub does not have (404) is no file; any other failure throws.
export function baseConfig(gh, { repo, base, host }) {
  const read = (file) => {
    const route = `repos/${repo}/contents/${file.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(base)}`;
    let body;
    try {
      body = JSON.parse(gh(['api', '--hostname', host, route]));
    } catch (error) {
      if (notFound(error)) return null;
      throw new Error(`could not read ${file} on ${repo} ${base} with gh (${firstLine(error)})`);
    }
    if (body?.type !== 'file' || body.encoding !== 'base64' || typeof body.content !== 'string') {
      throw new Error(`gh returned no file content for ${file} on ${repo} ${base}`);
    }
    return Buffer.from(body.content, 'base64').toString('utf8');
  };
  const file = configPathIn(read);
  return configFromText(read(file), file);
}

// Why the review keeps auto-merge off, or null when the record holds a finished review of `head` and nothing is owed.
export function reviewProblem(state, head) {
  if (!state) return 'this machine holds no review record for it: run `aidrian pr review`';
  const owing = owed(state);
  if (owing.length) return `${owing.length} review ${owing.length === 1 ? 'entry is' : 'entries are'} still owed`;
  const outcome = state.outcome ?? null;
  if (outcome === null) return 'its review record holds no finished review';
  if (!sameCommit(outcome.head, head)) return `the last review covered ${String(outcome.head).slice(0, 7)}, not head ${head.slice(0, 7)}`;
  if (!FINISHED.has(outcome.status)) return `the review of head ${head.slice(0, 7)} is \`${outcome.status}\``;
  return null;
}

const cleanup = (team) => `${team.deleteBranch ? 'delete' : 'keep'} the branch, ${team.deleteWorktree ? 'delete' : 'keep'} the worktree`;

// The CLI body. `gh` is the test seam: (args) → stdout, throwing as runGh does.
export function runAutoMerge(argv, project, { gh = (args) => runGh(args, { cwd: project.root }) } = {}) {
  const fail = (message) => {
    console.error(`aidrian pr auto-merge: ${message}`);
    return 3;
  };
  const { target, asJson, unknown } = parseArgs(argv);
  if (unknown) return fail(`unknown argument: ${unknown}`);
  let pr;
  try {
    pr = readView(JSON.parse(gh(['pr', 'view', ...(target === null ? [] : [target]), '--json', VIEW_FIELDS])));
  } catch (error) {
    return fail(`could not read the pull request with gh (${firstLine(error)})`);
  }
  if (typeof pr === 'string') return fail(pr);
  let team;
  try {
    team = baseConfig(gh, pr).github.autoMerge;
  } catch (error) {
    return fail(error.message);
  }

  let { effective, reason } = resolveAutoMerge({ autoMerge: team }, project.localAutoMerge);
  let why = reason === 'team'
    ? `the team does not allow it (github.autoMerge.allow on ${pr.repo} ${pr.base})`
    : reason === 'local' ? `this machine has not opted in (github.autoMerge in ${project.paths.local})` : null;
  if (effective) {
    let user;
    try {
      user = JSON.parse(gh(['api', '--hostname', pr.host, 'user']))?.login;
    } catch (error) {
      return fail(`could not read the gh user (${firstLine(error)})`);
    }
    if (typeof user !== 'string' || user === '') return fail('gh api user returned no login');
    if (pr.author.toLowerCase() !== user.toLowerCase()) {
      [effective, reason, why] = [false, 'author', `it is ${pr.author}'s pull request, not ${user}'s`];
    } else {
      const problem = reviewProblem(scoped(readLocalState(project, pr.number), project, pr.repo), pr.head);
      if (problem) [effective, reason, why] = [false, 'review', problem];
    }
  }

  const result = {
    effective, reason, allow: team.allow, local: project.localAutoMerge, strategy: team.strategy, deleteBranch: team.deleteBranch,
    deleteWorktree: team.deleteWorktree, pr: pr.number, head: pr.head, repo: pr.repo,
  };
  console.log(asJson ? JSON.stringify(result)
    : effective ? `auto-merge on for #${pr.number} at ${pr.head.slice(0, 7)}: ${team.strategy ?? 'no strategy set'}, ${cleanup(team)}`
      : `auto-merge off for #${pr.number}: ${why}`);
  if (reason === 'local') {
    for (const line of project.errors.filter((each) => each.startsWith(`${project.paths.local}:`))) console.error(line);
  }
  return effective ? 0 : 1;
}
