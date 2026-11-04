// `aidrian pr auto-merge [PR] [--json]`: whether a session may merge this pull request without asking. It is on only
// when all of these hold, and the first that fails is the reason it is off:
//   1. team: both the repository's default branch and the pull request's base allow it. `github.autoMerge` is read
//      from GitHub, as the pull request's repository commits it on each branch now: never from the working copy, its
//      folder override, or a local ref, so a pull request cannot raise its own ceiling, a feature base cannot raise the
//      default branch's, a fork checkout reads the upstream's, and no stale fetch keeps an old one. The strategy and
//      the cleanup come from the default branch.
//   2. checks: the default branch names `github.requiredChecks`, and the working copy's three check lists and its
//      `state.dir` are the default branch's. A named check that has not registered is pending, so naming them keeps a
//      draft's partial set of checks from reading as ready. `aidrian pr checks` reads the working copy, so equal lists
//      make its verdict the default branch's policy, and a branch cannot relax the lists that judge its own merge. The
//      review record is read from `state.dir`, so a branch cannot point it at a record of its own. A working copy config
//      that cannot be read, or has errors, is off too.
//   3. paths: gh lists every changed file with its change type, none is a rename, whose old path gh does not give, and
//      none is one that instructs an AI session or runs in CI (GUARDED_PATHS).
//   4. local: this machine opted in, `github.autoMerge: "on"` in the main checkout's local file (project.localAutoMerge).
//   5. author: the pull request is the gh user's own.
//   6. outsider: every issue comment, review, and inline comment is by a member of the repository, or by the default
//      branch's `github.reviewer` bot. It reads only these lists, so text that reaches a run another way, such as an
//      issue, is not seen.
//   7. review: nobody's latest review requests changes, and this machine's review record (lib/review/state.mjs), scoped
//      to the pull request's repository, holds the outcome `received` on exactly the pull request's current head,
//      and nothing is owed. `none_needed` is no review, so a pull request that needed none waits for the Human.
// gh reads: one `gh pr view` for the number, head, base, author, URL, files, and reviews; `gh api repos/<repo>` for the
// default branch; each branch's folder override and config.json through the contents API, at `refs/heads/<branch>` (once
// when the base is the default branch); and, only when the team, the checks, the paths, and the machine all allow it,
// `gh api user` for the login, then the pull request's three comment lists.
// Every `gh api` call names the host of the pull request's URL. A gh failure prints gh's last line of stderr.
// stdout: one line, or with --json { effective, reason, why, allow, local, strategy, deleteBranch, deleteWorktree, pr, head,
// repo, base }: `why` is the off line's sentence, null when on; `allow` is true only when both branches allow it, and the
// other team values are the default branch's.
// When the reason is local and the local file has errors, they go to stderr.
// Exit 0 on, 1 off, 3 error (an argument, a gh read, or a pull request gh describes only in part).

import { configFromText, loadConfig, resolveAutoMerge } from './config.mjs';
import { runGh } from './gh.mjs';
import { configPathIn, GUARDED_PATHS } from './project.mjs';
import { prNumber, repoName } from './review-gate.mjs';
import { MEMBER_ASSOCIATIONS, owed, readLocalState } from './review/state.mjs';
import { scoped } from './rules/github/merge-review.mjs';

const VIEW_FIELDS = 'number,headRefOid,baseRefName,author,url,files,changedFiles,reviewDecision,latestReviews';
const SHA = /^[0-9a-f]{40}$/iu;
// The `github` keys `aidrian pr checks` judges by (pr-checks.mjs computeVerdict).
const CHECK_LISTS = ['requiredChecks', 'conditionalChecks', 'ignoreCancelledChecks'];

// What a failed gh call says: its last non-empty line of stderr, else the first line of the error's message.
export const ghError = (error) => String(error?.stderr ?? '').split('\n').map((line) => line.trim()).filter(Boolean).at(-1) ??
  String(error?.message ?? error).split('\n')[0];
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

// The pull request as `gh pr view` describes it: { number, head, base, author, repo, host, files, changedFiles,
// reviewDecision, latestReviews }, or a string naming what is missing.
export function readView(view) {
  const { number, headRefOid: head, baseRefName: base, url, files, changedFiles, reviewDecision, latestReviews } = view ?? {};
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
  if (!Array.isArray(files) || files.some((file) => typeof file?.path !== 'string') || !Number.isInteger(changedFiles) || typeof reviewDecision !== 'string' || !Array.isArray(latestReviews)) {
    return 'gh returned no file list, changed-file count, review decision, or latest reviews for the pull request';
  }
  return { number, head, base, author, repo, host, files: files.map(({ path, changeType }) => ({ path, changeType })), changedFiles, reviewDecision, latestReviews };
}

// The default branch of `repo` on GitHub. Throws when gh cannot say.
export function defaultBranch(gh, { repo, host }) {
  let name;
  try {
    name = JSON.parse(gh(['api', '--hostname', host, `repos/${repo}`]))?.default_branch;
  } catch (error) {
    throw new Error(`could not read the default branch of ${repo} with gh (${ghError(error)})`);
  }
  if (typeof name !== 'string' || name === '') throw new Error(`gh returned no default branch for ${repo}`);
  return name;
}

// The config the branch `branch` of `repo` commits on GitHub now, by committedConfig's rules: its folder override
// first, then that folder's config.json. The ref is `refs/heads/<branch>`, so a tag of the same name never answers.
// A file GitHub does not have (404) is no file; any other failure throws.
export function branchConfig(gh, { repo, host }, branch) {
  const read = (file) => {
    const route = `repos/${repo}/contents/${file.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(`refs/heads/${branch}`)}`;
    let body;
    try {
      body = JSON.parse(gh(['api', '--hostname', host, route]));
    } catch (error) {
      if (notFound(error)) return null;
      throw new Error(`could not read ${file} on ${repo} ${branch} with gh (${ghError(error)})`);
    }
    if (body?.type !== 'file' || body.encoding !== 'base64' || typeof body.content !== 'string') {
      throw new Error(`gh returned no file content for ${file} on ${repo} ${branch}`);
    }
    return Buffer.from(body.content, 'base64').toString('utf8');
  };
  const file = configPathIn(read);
  return configFromText(read(file), file);
}

// Why the changed files keep auto-merge off, or null. A list shorter than the count hides files, and a rename, or a file
// with no change type, may hide the path it replaced, so those are off too.
export function pathsProblem({ files, changedFiles }) {
  if (files.length !== changedFiles) return `gh listed ${files.length} of its ${changedFiles} changed files`;
  const hidden = files.find(({ changeType }) => changeType === 'RENAMED' || !changeType);
  if (hidden) return `gh lists ${hidden.path} as ${hidden.changeType || 'no change type'}, which may hide the path it replaced`;
  const guarded = files.find(({ path }) => GUARDED_PATHS.test(path));
  return guarded ? `it changes ${guarded.path}, which instructs AI sessions or decides CI's verdict` : null;
}

// Who keeps auto-merge off by commenting: the login of the first comment or review whose author is no member of the
// repository and not the default branch's review bot, or null. Reads the three lists from GitHub; a failure throws.
export function outsiderOn(gh, { repo, host, number }, reviewer) {
  const routes = [`repos/${repo}/issues/${number}/comments`, `repos/${repo}/pulls/${number}/reviews`, `repos/${repo}/pulls/${number}/comments`];
  const entries = routes.flatMap((route) => {
    try {
      return JSON.parse(gh(['api', '--hostname', host, route, '--paginate', '--slurp']) || '[]').flat();
    } catch (error) {
      throw new Error(`could not read ${route} with gh (${ghError(error)})`);
    }
  });
  const isBot = (login) => typeof reviewer === 'string' && typeof login === 'string' && login.toLowerCase() === reviewer.toLowerCase();
  const outsider = entries.find((entry) => !MEMBER_ASSOCIATIONS.has(entry?.author_association) && !isBot(entry?.user?.login));
  return outsider ? outsider.user?.login ?? 'a deleted account' : null;
}

// Who requested changes, as a string, or null: the review decision, then anyone's latest review.
export function changesRequested({ reviewDecision, latestReviews }) {
  const reviewer = latestReviews.find((review) => review?.state === 'CHANGES_REQUESTED');
  if (reviewer) return `${reviewer.author?.login ?? 'a reviewer'} requested changes`;
  return reviewDecision === 'CHANGES_REQUESTED' ? 'its review decision is changes requested' : null;
}

// Why the review keeps auto-merge off, or null when the record holds a `received` review of exactly `head` and nothing is owed.
export function reviewProblem(state, head) {
  if (!state) return 'this machine holds no review record for it: run `aidrian pr review`';
  const owing = owed(state);
  if (owing.length) return `${owing.length} review ${owing.length === 1 ? 'entry is' : 'entries are'} still owed`;
  const outcome = state.outcome ?? null;
  if (outcome === null) return 'its review record holds no finished review';
  if (outcome.head !== head) return `the last review covered ${String(outcome.head).slice(0, 7)}, not head ${head.slice(0, 7)}`;
  if (outcome.status !== 'received') return `the review of head ${head.slice(0, 7)} is \`${outcome.status}\``;
  return null;
}

// Why the check policy keeps auto-merge off, or null. `config` is the default branch's config, `working` is loadConfig's
// answer for the checkout `aidrian pr checks` and the review record read, and `where` names the default branch in the message.
export function checksProblem({ github: policy, state }, working, where) {
  if (!policy.requiredChecks.length) return `the default branch names no required checks (github.requiredChecks on ${where}), so a check that has not registered would read as passed`;
  if (!working.current || working.errors.length) return `the working copy's config cannot be read, and aidrian pr checks reads it${working.errors.length ? `: ${working.errors[0]}` : ''}`;
  const same = (a, b) => new Set(a).size === new Set(b).size && a.every((each) => b.includes(each));
  const differing = CHECK_LISTS.filter((key) => !same(policy[key], working.config.github[key]));
  if (differing.length) return `the working copy's ${differing.map((key) => `github.${key}`).join(' and ')} differ from ${where}, and aidrian pr checks reads the working copy`;
  if (working.config.state.dir !== state.dir) return `the working copy's state.dir differs from ${where}, and the review record is read from it`;
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
    return fail(`could not read the pull request with gh (${ghError(error)})`);
  }
  if (typeof pr === 'string') return fail(pr);
  let team;
  let refusing;
  let main;
  let policy;
  try {
    main = defaultBranch(gh, pr);
    policy = branchConfig(gh, pr, main);
    const onDefault = policy.github.autoMerge;
    const onBase = pr.base === main ? onDefault : branchConfig(gh, pr, pr.base).github.autoMerge;
    refusing = [...new Set([[main, onDefault], [pr.base, onBase]].filter(([, each]) => each.allow !== true).map(([name]) => name))];
    team = { ...onDefault, allow: refusing.length === 0 };
  } catch (error) {
    return fail(error.message);
  }

  let { effective, reason } = resolveAutoMerge({ autoMerge: team }, project.localAutoMerge);
  let why = reason === 'team'
    ? `the team does not allow it (github.autoMerge.allow on ${pr.repo} ${refusing.join(' and ')})`
    : reason === 'local' ? `this machine has not opted in (github.autoMerge in ${project.paths.local})` : null;
  if (reason !== 'team') {
    const problem = checksProblem(policy, loadConfig(project), `${pr.repo} ${main}`);
    const paths = pathsProblem(pr);
    if (problem) [effective, reason, why] = [false, 'checks', problem];
    else if (paths) [effective, reason, why] = [false, 'paths', paths];
  }
  if (effective) {
    let user;
    try {
      user = JSON.parse(gh(['api', '--hostname', pr.host, 'user']))?.login;
    } catch (error) {
      return fail(`could not read the gh user (${ghError(error)})`);
    }
    if (typeof user !== 'string' || user === '') return fail('gh api user returned no login');
    if (pr.author.toLowerCase() !== user.toLowerCase()) {
      [effective, reason, why] = [false, 'author', `it is ${pr.author}'s pull request, not ${user}'s`];
    } else {
      let outsider;
      try {
        outsider = outsiderOn(gh, pr, policy.github.reviewer);
      } catch (error) {
        return fail(error.message);
      }
      const problem = changesRequested(pr) ?? reviewProblem(scoped(readLocalState(project, pr.number), project, pr.repo), pr.head);
      if (outsider) [effective, reason, why] = [false, 'outsider', `${outsider} commented, and is no member of the repository`];
      else if (problem) [effective, reason, why] = [false, 'review', problem];
    }
  }

  const result = {
    effective, reason, why, allow: team.allow, local: project.localAutoMerge, strategy: team.strategy, deleteBranch: team.deleteBranch,
    deleteWorktree: team.deleteWorktree, pr: pr.number, head: pr.head, repo: pr.repo, base: pr.base,
  };
  console.log(asJson ? JSON.stringify(result)
    : effective ? `auto-merge on for #${pr.number} at ${pr.head.slice(0, 7)}: ${team.strategy ?? 'no strategy set'}, ${cleanup(team)}`
      : `auto-merge off for #${pr.number}: ${why}`);
  if (reason === 'local') {
    for (const line of project.errors.filter((each) => each.startsWith(`${project.paths.local}:`))) console.error(line);
  }
  return effective ? 0 : 1;
}
