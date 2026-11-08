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
//      none is one that instructs an AI session or runs in CI (GUARDED_PATHS), unless both branches commit
//      `github.autoMerge.includeGuardedPaths` true, which lifts the GUARDED_PATHS refusal alone, never for a policy
//      file (POLICY_PATHS). None, with the key on or off, is one of the files the gate reads its policy from,
//      including a folder the pointer file names (branchPolicies' policyFiles). `gh pr view` lists at most 100 files,
//      so a longer pull request's list is read whole from the forge's paged list (wholeFiles), at the head the view gave.
//   4. local: the main checkout's local file turns it on (project.localAutoMerge), or sets nothing under the default
//      branch's `github.autoMerge.default` "on".
//   5. author: the pull request is the gh user's own.
//   6. outsider: every issue comment, review, and inline comment is by a member of the repository, or by the default
//      branch's `github.reviewer` bot. It reads only these lists, so text that reaches a run another way, such as an
//      issue, is not seen.
//   7. review: nobody's latest review requests changes, and this machine's review record (lib/review/state.mjs), scoped
//      to the pull request's repository, holds the outcome `received` on exactly the pull request's current head,
//      and nothing is owed. A waiver above low through an accepted residual, on any pass record, keeps it off too, also
//      after the waiver ends, until a listing holds the finding as fixed (settled.mjs heldWaiver).
//      `none_needed` is no review, so a pull request that needed none waits for the Human.
// gh reads, each through the forge facade (lib/forges): one `gh pr view` for the number, head, base, author, URL, files,
// and reviews; `gh api repos/<repo>` for the default branch; each branch's folder override and config.json through the
// contents API, at `refs/heads/<branch>` (once when the base is the default branch); and, only when the team, the checks,
// the paths, and the machine all allow it, `gh api user` for the login, then the pull request's three comment lists.
// When the view lists fewer files than it counts, and the team and the checks allow it, the paged file list and then the
// pull request's head again, before the login.
// Every `gh api` call names the host of the pull request's URL. A gh failure prints gh's last line of stderr.
// stdout: one line, or with --json { effective, reason, why, allow, local, strategy, deleteBranch, deleteWorktree, pr, head,
// repo, base }: `why` is the off line's sentence, null when on; `allow` is true only when both branches allow it, and the
// other team values are the default branch's.
// When the reason is local and the local file has errors, they go to stderr.
// Exit 0 on, 1 off, 3 error (an argument, a gh read, or a pull request gh describes only in part).
// A failed read of the full file list, or of the head after it, is off (paths): the paths check names it.

import { configFromText, loadConfig, resolveAutoMerge } from './config.mjs';
import { forgeFor, isTrustedCommenter } from './forges/index.mjs';
import { runGit } from './git.mjs';
import { configPathIn, GUARDED_PATHS, mayFollowTeamDefault, POLICY_PATHS } from './project.mjs';
import { prNumber, repoName } from './review-gate.mjs';
import { heldWaiver } from './review/settled.mjs';
import { owed, readLocalState } from './review/state.mjs';
import { scoped } from './rules/github/merge-review.mjs';

export const VIEW_FIELDS = 'number,headRefOid,baseRefName,author,url,files,changedFiles,reviewDecision,latestReviews';
const SHA = /^[0-9a-f]{40}$/iu;
// The `github` keys `aidrian pr checks` judges by (pr-checks.mjs computeVerdict).
const CHECK_LISTS = ['requiredChecks', 'conditionalChecks', 'ignoreCancelledChecks'];

// What a failed gh call says: its last non-empty line of stderr, else the first line of the error's message.
export const ghError = (error) => String(error?.stderr ?? '').split('\n').map((line) => line.trim()).filter(Boolean).at(-1) ??
  String(error?.message ?? error).split('\n')[0];
export const notFound = (error) => /HTTP 404/u.test(`${error?.stderr ?? ''}\n${error?.message ?? ''}`);

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

// The default branch of `repo` on GitHub, through the forge facade. Throws when gh cannot say.
export function defaultBranch(forge, { repo, host }) {
  let name;
  try {
    name = forge.repository(repo, { host })?.default_branch;
  } catch (error) {
    throw new Error(`could not read the default branch of ${repo} with gh (${ghError(error)})`);
  }
  if (typeof name !== 'string' || name === '') throw new Error(`gh returned no default branch for ${repo}`);
  return name;
}

// The config the branch `branch` of `repo` commits on GitHub now, by committedConfig's rules: its folder override
// first, then that folder's config.json. The ref is `refs/heads/<branch>`, so a tag of the same name never answers.
// A file GitHub does not have (404) is no file; any other failure throws. `prefix` is the project's folder from the top of the
// repository, with its trailing slash: GitHub's paths start at the top, and config paths at the project root. `locate` and
// `parse` find the file and read its text, for a caller that holds a broken file to stricter rules. `seen`, when given,
// collects every path it reads from the top of the repository: the pointer file, then the config.json it located.
export function branchConfig(forge, { repo, host }, branch, prefix = '', { locate = configPathIn, parse = configFromText, seen = null } = {}) {
  const read = (name) => {
    const file = `${prefix}${name}`;
    seen?.push(file);
    let body;
    try {
      body = forge.contents(repo, file, `refs/heads/${branch}`, { host });
    } catch (error) {
      if (notFound(error)) return null;
      throw new Error(`could not read ${file} on ${repo} ${branch} with gh (${ghError(error)})`);
    }
    if (body?.type !== 'file' || body.encoding !== 'base64' || typeof body.content !== 'string') {
      throw new Error(`gh returned no file content for ${file} on ${repo} ${branch}`);
    }
    return Buffer.from(body.content, 'base64').toString('utf8');
  };
  const file = locate(read);
  return parse(read(file), file);
}

// The team's config at the two branches that decide a ceiling: { main, policy, basePolicy, policyFiles }, the default
// branch's name, its config, the base's config (the same object when the base is the default branch), and every path
// read for them on either branch, each once: the files the gate reads its policy from, including a folder the pointer
// file names. Read in this order: the default branch, its config, then the base's config, each config by branchConfig's
// reads. `pr` is { repo, host, base }. Throws as defaultBranch and branchConfig do.
export function branchPolicies(forge, pr, prefix = '') {
  const seen = [];
  const main = defaultBranch(forge, pr);
  const policy = branchConfig(forge, pr, main, prefix, { seen });
  const basePolicy = pr.base === main ? policy : branchConfig(forge, pr, pr.base, prefix, { seen });
  return { main, policy, basePolicy, policyFiles: [...new Set(seen)] };
}

// The branches whose `github.<key>.allow` is not true, the default branch first, each once: empty when both allow it.
export const refusingBranches = ({ main, policy, basePolicy }, base, key) =>
  [...new Set([[main, policy.github[key]], [base, basePolicy.github[key]]].filter(([, each]) => each?.allow !== true).map(([name]) => name))];

// Whether the team lets a guarded path through the paths gate: true only when the default branch and the base both
// commit `github.autoMerge.includeGuardedPaths` true, read as `allow` is, never from the working copy.
export const includesGuardedPaths = ({ policy, basePolicy }) =>
  policy.github.autoMerge.includeGuardedPaths === true && basePolicy.github.autoMerge.includeGuardedPaths === true;

// GitHub's REST file statuses as the GraphQL change types `gh pr view` gives and pathsProblem reads. `unchanged`, a file
// listed with no change to its content, reads as MODIFIED, so its path still meets every guard.
const REST_CHANGE_TYPES = Object.freeze({
  added: 'ADDED', removed: 'DELETED', modified: 'MODIFIED', renamed: 'RENAMED', copied: 'COPIED', changed: 'CHANGED', unchanged: 'MODIFIED',
});

// The pull request with every changed file, or a string saying why its list is not whole. `gh pr view` lists at most 100
// files of `changedFiles`; past that, the forge's paged list gives up to 3000. That list names no commit, so the head is
// read again after it, and a head other than the view's means a file may come from a newer push: refused. A failed call,
// an entry with no path or no known status, a path listed twice, a count other than `changedFiles`, or a list that leaves
// out a file the view gave is refused too. A view that lists as many files as it counts, or more, is returned as it is.
export function wholeFiles(forge, pr) {
  const { repo, host, number, head, changedFiles } = pr;
  if (pr.files.length >= changedFiles) return pr;
  let entries;
  try {
    entries = forge.changeFiles(repo, number, { host });
  } catch (error) {
    return `could not read the ${changedFiles} changed files of #${number} with gh (${ghError(error)})`;
  }
  if (!Array.isArray(entries)) return `gh returned no list of the changed files of #${number}`;
  const files = [];
  for (const [index, entry] of entries.entries()) {
    const { filename: path, status } = entry ?? {};
    if (typeof path !== 'string' || path === '' || typeof status !== 'string' || !Object.hasOwn(REST_CHANGE_TYPES, status)) {
      return `gh listed changed file ${index + 1} of #${number} with no path or no known status (${JSON.stringify(status ?? null)})`;
    }
    files.push({ path, changeType: REST_CHANGE_TYPES[status] });
  }
  const paths = new Set(files.map(({ path }) => path));
  if (paths.size !== files.length) return `gh listed a changed file of #${number} twice`;
  if (files.length !== changedFiles) return `gh listed ${files.length} of its ${changedFiles} changed files, and GitHub lists at most 3000`;
  const missing = pr.files.find(({ path }) => !paths.has(path));
  if (missing) return `the paged file list leaves out ${JSON.stringify(missing.path)}, which the view lists`;
  let now;
  try {
    now = forge.pull(repo, number, { host })?.head?.sha;
  } catch (error) {
    return `could not read the head of #${number} again with gh (${ghError(error)})`;
  }
  if (now !== head) return `the head moved from ${head.slice(0, 7)} to ${String(now ?? 'none').slice(0, 7)} while gh listed its files`;
  return { ...pr, files };
}

// Why the changed files keep auto-merge off, or null. A path is the branch's text, so it is quoted: it cannot break the line.
// A list shorter than the count hides files, and a rename, or a file
// with no change type, may hide the path it replaced, so those are off too.
// A project below the root reviews only its own folder, so a file outside it has had no review, and its own folder's files
// are guarded by their path from the project root. `policyFiles` are the paths branchPolicies read, the files the gate
// reads its policy from, including a folder the pointer file names: a change to one, in any case, is off with the key on
// or off, after the guarded-path refusal so that refusal keeps its message. `includeGuardedPaths` lifts only the
// guarded-path refusal, the team having accepted that risk on both branches, and never for a policy file (POLICY_PATHS).
export function pathsProblem({ files, changedFiles }, prefix = '', { includeGuardedPaths = false, policyFiles = [] } = {}) {
  if (prefix === null) return 'git could not give the project\'s folder in the repository';
  if (files.length !== changedFiles) return `gh listed ${files.length} of its ${changedFiles} changed files`;
  const hidden = files.find(({ changeType }) => changeType === 'RENAMED' || !changeType);
  if (hidden) return `gh lists ${JSON.stringify(hidden.path)} as ${hidden.changeType || 'no change type'}, which may hide the path it replaced`;
  const outside = files.find(({ path }) => !path.startsWith(prefix));
  if (outside) return `it changes ${JSON.stringify(outside.path)}, outside this project's folder, which its review does not cover`;
  const read = new Set(policyFiles.map((each) => each.toLowerCase()));
  const policyRead = files.find(({ path }) => read.has(path.toLowerCase()));
  const readLine = policyRead && `it changes ${JSON.stringify(policyRead.path)}, a file the gate reads its policy from`;
  if (includeGuardedPaths) {
    const policy = files.find(({ path }) => POLICY_PATHS.test(path));
    if (policy) return `it changes ${JSON.stringify(policy.path)}, a policy file of aidrian, which includeGuardedPaths never lets through`;
    return readLine || null;
  }
  const guarded = files.find(({ path }) => GUARDED_PATHS.test(path) || GUARDED_PATHS.test(path.slice(prefix.length)));
  if (guarded) return `it changes ${JSON.stringify(guarded.path)}, which instructs AI sessions, or decides CI's verdict or auto-merge`;
  return readLine || null;
}

// Who keeps auto-merge off by commenting: the login of the first comment or review whose author is no member of the
// repository and not the default branch's review bot, or null. Reads the three lists from GitHub, every page; a failure
// throws, naming the list's route.
export function outsiderOn(forge, { repo, host, number }, reviewer) {
  const lists = [
    [`repos/${repo}/issues/${number}/comments`, () => forge.conversationComments(repo, number, { host })],
    [`repos/${repo}/pulls/${number}/reviews`, () => forge.reviews(repo, number, { host })],
    [`repos/${repo}/pulls/${number}/comments`, () => forge.reviewComments(repo, number, { host })],
  ];
  const entries = lists.flatMap(([route, read]) => {
    try {
      return read();
    } catch (error) {
      throw new Error(`could not read ${route} with gh (${ghError(error)})`);
    }
  });
  const isBot = (login) => typeof reviewer === 'string' && typeof login === 'string' && login.toLowerCase() === reviewer.toLowerCase();
  const outsider = entries.find((entry) => !isTrustedCommenter(entry) && !isBot(entry?.user?.login));
  return outsider ? outsider.user?.login ?? 'a deleted account' : null;
}

// Who requested changes, as a string, or null: the review decision, then anyone's latest review.
export function changesRequested({ reviewDecision, latestReviews }) {
  const reviewer = latestReviews.find((review) => review?.state === 'CHANGES_REQUESTED');
  if (reviewer) return `${reviewer.author?.login ?? 'a reviewer'} requested changes`;
  return reviewDecision === 'CHANGES_REQUESTED' ? 'its review decision is changes requested' : null;
}

// Why the review keeps auto-merge off, or null when the record holds a `received` review of exactly `head` and nothing is
// owed. A finding above low that an accepted residual waived is the author's word on a reviewer's finding, so the merge
// waits for the Human, whatever the review's outcome, and after the waiver ends, until a listing holds the finding as fixed.
export function reviewProblem(state, head) {
  if (!state) return 'this machine holds no review record for it: run `aidrian pr review`';
  const owing = owed(state);
  if (owing.length) return `${owing.length} review ${owing.length === 1 ? 'entry is' : 'entries are'} still owed`;
  const outcome = state.outcome ?? null;
  if (outcome === null) return 'its review record holds no finished review';
  if (outcome.head !== head) return `the last review covered ${String(outcome.head).slice(0, 7)}, not head ${head.slice(0, 7)}`;
  if (outcome.status !== 'received') return `the review of head ${head.slice(0, 7)} is \`${outcome.status}\``;
  const waived = heldWaiver(state);
  if (!waived) return null;
  const named = `the accepted residual ${JSON.stringify(String(waived.residual).slice(0, 120))} waived a finding above low severity`;
  return waived.ended ? `${named} and no listing holds it fixed, so the merge waits for the Human` : `${named}, so the merge waits for the Human`;
}

// Why the check policy keeps auto-merge off, or null. `config` is the default branch's config, `working` is loadConfig's
// answer for the checkout `aidrian pr checks` and the review record read, and `where` names the default branch in the message.
export function checksProblem({ github: policy, state }, working, where) {
  if (!policy.requiredChecks.length) return `the default branch names no required checks (github.requiredChecks on ${where}), so a check that has not registered would read as passed`;
  if (!working.current || working.errors.length) return `the working copy's config cannot be read, and aidrian pr checks reads it${working.errors.length ? `: ${JSON.stringify(working.errors[0])}` : ''}`;
  const same = (a, b) => new Set(a).size === new Set(b).size && a.every((each) => b.includes(each));
  const differing = CHECK_LISTS.filter((key) => !same(policy[key], working.config.github[key]));
  if (differing.length) return `the working copy's ${differing.map((key) => `github.${key}`).join(' and ')} differ from ${where}, and aidrian pr checks reads the working copy`;
  if (working.config.state.dir !== state.dir) return `the working copy's state.dir differs from ${where}, and the review record is read from it`;
  return null;
}

const cleanup = (team) => `${team.deleteBranch ? 'delete' : 'keep'} the branch, ${team.deleteWorktree ? 'delete' : 'keep'} the worktree`;

// The CLI body. `forge` is the test seam: the forge facade (lib/forges), whose methods throw as gh does.
export function runAutoMerge(argv, project, { forge = forgeFor(project.root) } = {}) {
  const fail = (message) => {
    console.error(`aidrian pr auto-merge: ${message}`);
    return 3;
  };
  const { target, asJson, unknown } = parseArgs(argv);
  if (unknown) return fail(`unknown argument: ${unknown}`);
  let pr;
  try {
    pr = readView(forge.change(target, VIEW_FIELDS));
  } catch (error) {
    return fail(`could not read the pull request with gh (${ghError(error)})`);
  }
  if (typeof pr === 'string') return fail(pr);
  let team;
  // An empty prefix is the repository root, so a failed lookup is null, which the paths check refuses, never the root.
  const shown = runGit(['rev-parse', '--show-prefix'], project.root);
  const prefix = shown.status === 0 ? shown.stdout.trim() : null;
  let refusing;
  let main;
  let policy;
  let includeGuarded = false;
  let policyFiles = [];
  try {
    const policies = branchPolicies(forge, pr, prefix ?? '');
    ({ main, policy, policyFiles } = policies);
    refusing = refusingBranches(policies, pr.base, 'autoMerge');
    includeGuarded = includesGuardedPaths(policies);
    team = { ...policy.github.autoMerge, allow: refusing.length === 0 };
  } catch (error) {
    return fail(error.message);
  }

  // A tracked local file is no machine's own, so it follows no default of "on". Read only when that default would apply.
  const followsDefault = project.localAutoMerge === 'unset' && team.allow && team.default === 'on';
  const local = followsDefault && !mayFollowTeamDefault(project) ? 'off' : project.localAutoMerge;
  let { effective, reason } = resolveAutoMerge({ autoMerge: team }, local);
  let why = reason === 'team'
    ? `the team does not allow it (github.autoMerge.allow on ${pr.repo} ${refusing.join(' and ')})`
    : reason === 'local' ? `this machine has not opted in (github.autoMerge in ${project.paths.local})` : null;
  if (reason !== 'team') {
    const problem = checksProblem(policy, loadConfig(project), `${pr.repo} ${main}`);
    if (problem) [effective, reason, why] = [false, 'checks', problem];
    else {
      const listed = prefix === null ? pr : wholeFiles(forge, pr);
      const paths = typeof listed === 'string' ? listed : pathsProblem(listed, prefix, { includeGuardedPaths: includeGuarded, policyFiles });
      if (paths) [effective, reason, why] = [false, 'paths', paths];
    }
  }
  if (effective) {
    let user;
    try {
      user = forge.viewer({ host: pr.host });
    } catch (error) {
      return fail(`could not read the gh user (${ghError(error)})`);
    }
    if (typeof user !== 'string' || user === '') return fail('gh api user returned no login');
    if (pr.author.toLowerCase() !== user.toLowerCase()) {
      [effective, reason, why] = [false, 'author', `it is ${pr.author}'s pull request, not ${user}'s`];
    } else {
      let outsider;
      try {
        outsider = outsiderOn(forge, pr, policy.github.reviewer);
      } catch (error) {
        return fail(error.message);
      }
      const problem = changesRequested(pr) ?? reviewProblem(scoped(readLocalState(project, pr.number), project, pr.repo), pr.head);
      if (outsider) [effective, reason, why] = [false, 'outsider', `${outsider} commented, and is no member of the repository`];
      else if (problem) [effective, reason, why] = [false, 'review', problem];
    }
  }

  const result = {
    effective, reason, why, allow: team.allow, local, strategy: team.strategy, deleteBranch: team.deleteBranch,
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
