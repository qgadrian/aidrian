// `aidrian pr auto-merge [PR] --check [--json]`: whether a session may merge this pull request without asking; without
// `--check`, whether it merged too (runAutoMergeCommand). It is on only
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
//      none is one that instructs an AI session or runs in CI (GUARDED_PATHS, every host's instruction files among
//      them), or a knowledge doc the start hook loads into every session, or a file of the knowledge folder that names
//      them, as the default branch commits its indexes (startDocs), which must be readable, unless both branches commit
//      `github.autoMerge.includeGuardedPaths` true, which lifts those refusals alone, never for a policy
//      file (POLICY_PATHS). None, with the key on or off, is one of the files the gate reads its policy from,
//      including a folder the pointer file names (branchPolicies' policyFiles), unless both branches also commit
//      `github.autoMerge.includePolicyFiles` true, which lifts those two refusals too (includesPolicyFiles). `gh pr view` lists at most 100 files,
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
//      after the waiver ends, until a listing holds the finding as fixed, or until the body no longer lists it and a pass
//      of exactly the head carries it as ended, having weighed it again (settled.mjs heldWaiver, bodyAccepts): the gate then
//      reads the body through the forge, at the head, once.
//      `round_limit` on exactly the head counts in place of `received` only with a judge's `waive` verdict that stands for
//      that head under the unattended waiver (lib/review/waiver-stand.mjs waivedReview): the team's
//      `github.unattendedWaiver.allow` on both branches, read with the policies above, and this machine's switch; every
//      finding open at the cap a local reviewer's of medium severity or lower and no security finding; the judge in the
//      recording session's dispatch log; under a project run, fewer than WAIVED_MERGES waived merges; and the review
//      bot's pass of exactly the head, read in the review trail, attended or not. A verdict never stands in for the bot.
//      A sign-off the Human owes on the head, found before any verdict is read, stops as merge trust does: reason
//      `trust`, `trust: "signoff"`, naming the flow and the class of the decision. The closing-word check holds a
//      waived merge too, and comes first.
//      A `none_needed` outcome on exactly that head counts only by pr-auto-merge-docs.mjs noneNeededProblem: its plan
//      reasons are exactly "only files that cannot change behaviour", at depth `none`; `github.autoMerge.unreviewedPaths` is a non-empty
//      list with no error on both the default branch and the base, and names every changed file on each, as the whole path
//      from the project root; and every file of the paths check's whole list is added, modified, or deleted, sorts as `review.nonBehaviour`
//      by the default branch's review lists (a `review.ignore` file is off too), has a safe extension (.md or a raster
//      image), and is no GUARDED_PATHS file, which holds every host's instruction files, and no knowledge doc the start
//      hook loads, with includeGuardedPaths on too, no path with a folder or name that starts with ".", and no test file,
//      fixture, or golden file; and every file still at the head is a regular file there, read from the head's tree:
//      no symbolic link and no submodule. Every list is read from GitHub, never the working copy, so a pull request
//      cannot widen what lets it through. Any other `none_needed` waits for the Human.
//   then closes, only for a session no Human attends whose unattended mark names a project run's issue
//      (closing-words.mjs runClosingContext): the pull request's title, body, and every commit message, read through the
//      forge at exactly the head, name no issue but that one after a closing word, and the title no other key of a team
//      the run knows; and the issues the forge links to close at the merge, by hand in the sidebar included, are that
//      one alone and all of them. The title, the body, and those issues come from one review trail, read after the
//      commits, which merge trust then reads too (closingProblem). A mark it cannot read names no issue, so any
//      counts. Computed from the final review verdict, after every check before it.
//   8. trust, only for a session no Human attends (its unattended mark): the record is this machine's word, which a
//      project run's confined session can write, so the merge also rests on what no such session writes
//      (lib/review/merge-trust.mjs): the default branch's `github.reviewer` bot passed exactly the head on GitHub, read in
//      one call (the forge's reviewTrail), whatever the record's outcome, and the sign-off store holds the Human's
//      sign-off on exactly the head of every flow the record names for it and every flow the changed files, as GitHub
//      lists them, may select (flowsFloor). With no bot set, it is off. Its reason is `trust`. An attended run reads none.
// gh reads, each through the forge facade (lib/forges): one `gh pr view` for the number, head, base, author, URL, files,
// and reviews; `gh api repos/<repo>` for the default branch; each branch's folder override and config.json through the
// contents API, at `refs/heads/<branch>` (once when the base is the default branch); and, only when the team, the checks,
// the paths, and the machine all allow it, `gh api user` for the login, then the pull request's three comment lists.
// When the view lists fewer files than it counts, and the team and the checks allow it, the paged file list and then the
// pull request's head again, before the login. Then, with a whole list, the default branch's knowledge folder beside its
// config.json and each `.json` index in it (startDocs). Last, once, the review trail: for a judge's verdict at the round
// cap under the unattended waiver, and for a session no Human attends when every other check allows it.
// The `none_needed` route of the review check reads the head's tree too, one folder at a time, after every other check
// of that route passed; the two configs above hold its lists. The includePolicyFiles lift reads that tree too, in the
// paths check (headPolicyProblem).
// Every `gh api` call names the host of the pull request's URL. A gh failure prints gh's last line of stderr.
// stdout: one line, or with --json { effective, reason, why, allow, local, strategy, deleteBranch, deleteWorktree, pr, head,
// repo, base, waived?, trust?, flow?, signoffClass? }: `why` is the off line's sentence, null when on; `allow` is true only when both branches allow it, and the
// other team values are the default branch's; `waived`, only when the review check passed on a judge's verdict at the
// round cap, is true, as the plain line says too; `trust`, only with the reason `trust`, is `bot` or `signoff`, which half
// of merge trust is missing, as the plain line names it too; with `signoff`, `flow` names the flow and `signoffClass`
// is `security` or `product` (signoffClassOf).
// When the reason is local and the local file has errors, they go to stderr.
// Exit 0 on, 1 off, 3 error (an argument, a gh read, or a pull request gh describes only in part); exit 0 merges nothing.
// A failed read of the full file list, or of the head after it, is off (paths): the paths check names it.

import { configFromText, loadConfig, resolveAutoMerge, stateDirProblem, strictConfigFromText } from './config.mjs';
import { forgeFor, isTrustedCommenter } from './forges/index.mjs';
import { knownPrefix } from './git.mjs';
import { indexedAlways } from './knowledge.mjs';
import { entryKind, FILE_MODES, noneNeededProblem, RELEASE_SCRIPT, startLoadProblem, startUnreadable, treeLookup } from './pr-auto-merge-docs.mjs';
import { configPathIn, foldPath, isGuardedPath, isPluginRepository, isPolicyPath, knowledgeIn, strictConfigPathIn, mayFollowTeamDefault, PLUGIN_REPOSITORY_PATHS, trailPaths } from './project.mjs';
import { hostOf } from './remotes.mjs';
import { prNumber, repoName } from './review-gate.mjs';
import { isFindingId } from './review/findings.mjs';
import { detectHost, sessionIdentity } from './hosts/index.mjs';
import { readHumanSignoffs, trustVerdict } from './review/merge-trust.mjs';
import { closingContextOf, closingTextsProblem, forgeClosingProblem, markOnce } from './closing-words.mjs';
import { driverHold } from './run-driver.mjs';
import { readUnattendedMark } from './unattended-mark.mjs';
import { bodyAccepts, heldWaiver } from './review/settled.mjs';
import { owed } from './review/state.mjs';
import { waiverKind } from './review/waiver.mjs';
import { runOf, waivedReview } from './review/waiver-stand.mjs';
import { recordFor, scoped } from './rules/github/merge-review.mjs';

// Whether no Human attends `session`: its unattended mark, a pending or unreadable one included, or its driver mark.
const heldSession = (session, options = {}) => (readUnattendedMark(session, options) ?? driverHold(session, options)) !== null;

export const VIEW_FIELDS = 'number,headRefOid,baseRefName,baseRefOid,author,url,files,changedFiles,reviewDecision,latestReviews';
const SHA = /^[0-9a-f]{40}$/iu;
// The `github` keys `aidrian pr checks` judges by (pr-checks.mjs computeVerdict).
const CHECK_LISTS = ['requiredChecks', 'conditionalChecks', 'ignoreCancelledChecks'];

// What a failed gh call says: its last non-empty line of stderr, else the first line of the error's message.
export const ghError = (error) => String(error?.stderr ?? '').split('\n').map((line) => line.trim()).filter(Boolean).at(-1) ??
  String(error?.message ?? error).split('\n')[0];
export const notFound = (error) => /HTTP 404/u.test(`${error?.stderr ?? ''}\n${error?.message ?? ''}`);

// [PR] [--json] [--check], where PR is a number, `#number`, or a pull request URL: { target, asJson, check, unknown }.
export function parseArgs(argv) {
  const positional = argv.filter((arg) => arg !== '--json' && arg !== '--check');
  const [first, ...extra] = positional;
  const valid = first === undefined || /^#?\d+$/u.test(first) || prNumber(first) !== null;
  return {
    target: first === undefined ? null : first.replace(/^#/u, ''),
    asJson: argv.includes('--json'),
    check: argv.includes('--check'),
    unknown: valid ? extra[0] ?? null : first,
  };
}

// The pull request as `gh pr view` describes it: { number, head, base, author, repo, host, files, changedFiles,
// reviewDecision, latestReviews }, or a string naming what is missing.
export function readView(view) {
  const { number, headRefOid: head, baseRefName: base, baseRefOid, url, files, changedFiles, reviewDecision, latestReviews } = view ?? {};
  const author = view?.author?.login;
  const host = hostOf(url);
  const repo = typeof url === 'string' ? repoName(url) : null;
  if (!Number.isInteger(number) || typeof base !== 'string' || base === '' || typeof author !== 'string' || author === '' || !host || !repo) {
    return 'gh returned no number, base branch, author, or URL for the pull request';
  }
  if (typeof head !== 'string' || !SHA.test(head)) return `gh returned ${JSON.stringify(head ?? null)} as the head, not a full commit SHA`;
  if (!Array.isArray(files) || files.some((file) => typeof file?.path !== 'string') || !Number.isInteger(changedFiles) || typeof reviewDecision !== 'string' || !Array.isArray(latestReviews)) {
    return 'gh returned no file list, changed-file count, review decision, or latest reviews for the pull request';
  }
  // The base's tip by its SHA, or null: only the policy-file lift reads it, and refuses without one (headPolicyProblem).
  const baseOid = typeof baseRefOid === 'string' && SHA.test(baseRefOid) ? baseRefOid : null;
  return { number, head, base, baseOid, author, repo, host, files: files.map(({ path, changeType }) => ({ path, changeType })), changedFiles, reviewDecision, latestReviews };
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
// `ref`, when given, reads that commit instead, `branch` then only naming it in a message.
export function branchConfig(forge, { repo, host }, branch, prefix = '', { locate = configPathIn, parse = configFromText, seen = null, ref = null } = {}) {
  const read = (name) => {
    const file = `${prefix}${name}`;
    seen?.push(file);
    return branchText(forge, { repo, host }, branch, file, ref ?? `refs/heads/${branch}`);
  };
  const file = locate(read);
  return parse(read(file), file);
}

// The text of `file`, from the top of the repository, as the branch `branch` of `repo` commits it on GitHub now, at
// `refs/heads/<branch>` or the commit `ref` names, or null when GitHub has no such file (404). Any other failure, or an
// answer with no file content, throws, naming the file and the branch.
function branchText(forge, { repo, host }, branch, file, ref = `refs/heads/${branch}`) {
  let body;
  try {
    body = forge.contents(repo, file, ref, { host });
  } catch (error) {
    if (notFound(error)) return null;
    throw new Error(`could not read ${file} on ${repo} ${branch} with gh (${ghError(error)})`);
  }
  if (body?.type !== 'file' || body.encoding !== 'base64' || typeof body.content !== 'string') {
    throw new Error(`gh returned no file content for ${file} on ${repo} ${branch}`);
  }
  return Buffer.from(body.content, 'base64').toString('utf8');
}

// What the start hook loads into every session, as the default branch `branch` commits it now: { docs, folder }, the
// `always` docs of each `.json` index in the knowledge folder beside `configFile`, the config.json branchPolicies located
// there, and that folder, each from the top of the repository; or a string saying why it cannot be read, which the
// paths check refuses on. No folder there (404) is no docs. Each index is read by the knowledge reader's own rules
// (knowledge.mjs indexedAlways). Only `always` docs: the start hook names no other doc of a bucket to every session.
// A machine's local knowledge sources are on no branch, so none is read.
export function startDocs(forge, pr, branch, configFile, prefix = '') {
  const { repo, host } = pr;
  const folder = knowledgeIn(configFile);
  let listing;
  try {
    listing = forge.contents(repo, folder, `refs/heads/${branch}`, { host });
  } catch (error) {
    if (notFound(error)) return { docs: [], folder };
    return `could not read ${folder} on ${repo} ${branch} with gh (${ghError(error)})`;
  }
  if (!Array.isArray(listing)) return `gh returned no listing of ${folder} on ${repo} ${branch}`;
  const names = listing.filter((entry) => entry?.type === 'file' && typeof entry.name === 'string' && entry.name.endsWith('.json')).map((entry) => entry.name).sort();
  const docs = [];
  for (const name of names) {
    const file = `${folder}/${name}`;
    try {
      const text = branchText(forge, pr, branch, file);
      if (text === null) return `${file} on ${repo} ${branch} was listed, and then GitHub had no such file`;
      docs.push(...indexedAlways(text, file).map((doc) => `${prefix}${doc}`));
    } catch (error) {
      return error.message;
    }
  }
  return { docs, folder };
}

// The team's config at the two branches that decide a ceiling: { main, policy, basePolicy, policyFiles, policyErrors,
// baseErrors, configFile }, the default branch's name, its config, the base's config (the same object when the base is the default
// branch), every path read for them on either branch, each once: the files the gate reads its policy from, including a
// folder the pointer file names; and each config's errors, one line each, whose keys then hold their defaults (the
// same list when the base is the default branch), and the config.json path the default branch's read located, from the
// top of the repository. Read in this order: the default branch, its config, then the base's
// config, each config by branchConfig's reads. `pr` is { repo, host, base }; a null `base` is the default branch, for a
// reader with no pull request (lib/solo.mjs). Throws as defaultBranch and branchConfig do.
export function branchPolicies(forge, pr, prefix = '') {
  const seen = [];
  const policyErrors = [];
  const main = defaultBranch(forge, pr);
  const base = pr.base ?? main;
  const policy = branchConfig(forge, pr, main, prefix, { seen, parse: (text, file) => configFromText(text, file, policyErrors) });
  // branchConfig reads the located config.json last.
  const configFile = seen.at(-1);
  const baseErrors = base === main ? policyErrors : [];
  const basePolicy = base === main ? policy : branchConfig(forge, pr, base, prefix, { seen, parse: (text, file) => configFromText(text, file, baseErrors) });
  return { main, policy, basePolicy, policyFiles: [...new Set(seen)], policyErrors, baseErrors, configFile };
}

// The paths a review trail reads each branch's policy files at (project.mjs trailPaths), for the merge guard.
export { trailPaths };

// branchPolicies' answer from a review trail's branch files, with no further read, or null when the trail cannot stand
// in for those reads: a branch it names no name for, a file it gave only in part, or a pointer that names another
// folder than the default one, whose config.json the trail did not read. `pr` is { repo, base }.
export function trailPolicies(trail, pr, prefix = '') {
  const { default: main, base } = trail?.branches ?? {};
  if (typeof main?.name !== 'string' || main.name === '') return null;
  const branch = pr.base ?? main.name;
  if (branch !== main.name && base?.name !== branch) return null;
  const paths = trailPaths(prefix);
  const configOf = (files, errors, seen) => {
    const read = (name) => {
      const file = `${prefix}${name}`;
      seen.push(file);
      const text = { [paths.pointer]: files.pointer, [paths.config]: files.config }[file];
      if (text === undefined || text === false) throw new TrailMiss();
      return text;
    };
    const file = configPathIn(read);
    return configFromText(read(file), file, errors);
  };
  const seen = [];
  const policyErrors = [];
  try {
    const policy = configOf(main, policyErrors, seen);
    const configFile = seen.at(-1);
    const baseErrors = branch === main.name ? policyErrors : [];
    const basePolicy = branch === main.name ? policy : configOf(base, baseErrors, seen);
    return { main: main.name, policy, basePolicy, policyFiles: [...new Set(seen)], policyErrors, baseErrors, configFile };
  } catch (error) {
    if (error instanceof TrailMiss) return null;
    throw error;
  }
}
class TrailMiss extends Error {}

// startDocs' answer from a review trail's knowledge folder on the default branch, read beside `configFile` when that is
// the default folder's, or null when the trail did not read that folder.
export function trailDocs(trail, configFile, prefix = '') {
  const folder = knowledgeIn(configFile);
  if (folder !== trailPaths(prefix).knowledge) return null;
  const listing = trail?.branches?.default?.knowledge;
  if (listing === null) return { docs: [], folder };
  if (!Array.isArray(listing)) return `the review trail gave no listing of ${folder}`;
  const docs = [];
  for (const entry of listing.filter((each) => each?.type === 'blob' && typeof each.name === 'string' && each.name.endsWith('.json')).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const file = `${folder}/${entry.name}`;
    if (typeof entry.text !== 'string') return `the review trail gave only part of ${file}`;
    try {
      docs.push(...indexedAlways(entry.text, file).map((doc) => `${prefix}${doc}`));
    } catch (error) {
      return error.message;
    }
  }
  return { docs, folder };
}

// What the `none_needed` route of the review check reads from the two branches' configs (pr-auto-merge-docs.mjs
// noneNeededProblem): each branch's `github.autoMerge.unreviewedPaths`, the default branch first and the base once, and
// the errors either config has under that key, each naming its branch.
function unreviewedLists({ main, policy, basePolicy, policyErrors, baseErrors }, { repo, base }) {
  const branches = [[main, policy, policyErrors], ...(base === main ? [] : [[base, basePolicy, baseErrors]])];
  return {
    lists: branches.map(([branch, config]) => [`${repo} ${branch}`, config.github.autoMerge.unreviewedPaths]),
    listErrors: branches.flatMap(([branch, , errors]) => errors.filter((error) => error.includes('"github.autoMerge.unreviewedPaths"'))
      .map((error) => error.replace(/^(.*?): /u, `$1 on ${repo} ${branch}: `))),
  };
}

// The branches whose `github.<key>.allow` is not true, the default branch first, each once: empty when both allow it.
export const refusingBranches = ({ main, policy, basePolicy }, base, key) =>
  [...new Set([[main, policy.github[key]], [base, basePolicy.github[key]]].filter(([, each]) => each?.allow !== true).map(([name]) => name))];

// Whether the team runs the project solo (config.json `solo`): true only when the default branch and the base both commit
// it true, read as `allow` is, never from the working copy. A value that fails its check reads as the default, false.
export const soloOn = ({ policy, basePolicy }) => policy.solo === true && basePolicy.solo === true;

// Whether the team lets a guarded path through the paths gate: true only when the default branch and the base both
// commit `github.autoMerge.includeGuardedPaths` true, read as `allow` is, never from the working copy.
export const includesGuardedPaths = ({ policy, basePolicy }) =>
  policy.github.autoMerge.includeGuardedPaths === true && basePolicy.github.autoMerge.includeGuardedPaths === true;

// Whether the team lets a policy file through the paths gate too: true only when includesGuardedPaths is, and the default
// branch and the base both commit `github.autoMerge.includePolicyFiles` true, read as `allow` is. The gate reads its
// policy from those two branches as GitHub holds them, never from the head, so the pull request that sets the key, or
// lowers any other policy, is still judged under the old one.
export const includesPolicyFiles = (policies) => includesGuardedPaths(policies)
  && policies.policy.github.autoMerge.includePolicyFiles === true && policies.basePolicy.github.autoMerge.includePolicyFiles === true;

// Why a change the includePolicyFiles lift lets through the paths check may not merge, or null. The policy that judges
// the merges after this one is the config the merge leaves, so, in this order, each failing closed:
//   - the pull request changes no pointer file (trailPaths' `pointer`, at the project root, in any case), which would move the
//     config the gate reads;
//   - its head holds the base's tip now: the forge's compare of the base's tip by its SHA, `pr.baseOid` (the pull
//     request's baseRefOid), with the head, through the same facade, is behind by none, so the head's config is the one
//     the merge leaves; no SHA, or a read that fails, refuses. Two SHAs, so no branch name is spelled into the route.
//     Accepted residual: the base can move between this compare and the merge; the branch protection setting
//     "Require branches to be up to date before merging" closes it on the forge (docs/config.md, Auto-merge);
//   - each policy file the head holds, the pointer and the config.json it locates, is a regular file there: its entry in
//     the head's git tree, read one folder at a time from the root, has a regular file's mode (a pointer may be absent).
//     A file read follows an in-repository link, while git and every reader of the merged tree see the link itself, so a
//     link refuses, and so does a tree that cannot be read whole (headEntryProblem);
//   - the head's own config, read from the forge at exactly the head commit `pr.head` as branchConfig reads a branch's,
//     its pointer by strictConfigPathIn, so a malformed one never falls back to the default folder, sits at the path the
//     default branch's does (`policies.configFile`), parses with no error, and keeps the default branch's
//     github.requiredChecks, conditionalChecks, and ignoreCancelledChecks as sets, and its state.dir.
// The checks row compares only the checkout the gate runs in, which may be the unchanged base, so without this a pull
// request could drop the checks or move the review record that judge the merge after its own. Read only while the lift
// counts (includesPolicyFiles) and a changed file in `files` ({ path }, from the top of the repository) is a policy file
// (isPolicyPath, with `policies.policyFiles`). `pr` is { repo, host, head, base, baseOid }, and `policies` branchPolicies' answer.
// Both the gate (gateVerdict) and the merge guard (merge-review.mjs policyProblem) ask it.
export function headPolicyProblem(forge, pr, policies, files, prefix = '') {
  if (!includesPolicyFiles(policies) || !files.some(({ path }) => isPolicyPath(path, policies.policyFiles))) return null;
  const at = String(pr.head).slice(0, 7);
  const moved = movedPointer(files, prefix);
  if (moved) return movedLine(moved);
  const behind = (() => {
    try {
      if (typeof pr.baseOid !== 'string' || !SHA.test(pr.baseOid)) return null;
      const compared = forge.compare(pr.repo, pr.baseOid, pr.head, { host: pr.host });
      return Number.isInteger(compared?.behind_by) ? compared.behind_by : null;
    } catch {
      return null;
    }
  })();
  if (behind !== 0) return `head ${at} ${behind === null ? 'cannot be compared with its base on the forge' : `is behind its base ${pr.base} by ${behind} ${behind === 1 ? 'commit' : 'commits'}`}, so the merged config is not the one checked; merge the base first`;
  const lookup = treeLookup(pr.head, headTree(forge, pr));
  const linked = headEntryProblem(lookup, pr, trailPaths(prefix).pointer, { optional: true });
  if (linked) return linked;
  const seen = [];
  let config;
  try {
    config = branchConfig(forge, pr, `head ${at}`, prefix, { ref: pr.head, seen, locate: strictConfigPathIn, parse: (text, file) => (text === null ? null : strictConfigFromText(text, file, () => true)) });
  } catch (error) {
    return `it changes a policy file, and its config at head ${at} cannot be read whole (${String(error.message).split('\n')[0]})`;
  }
  if (config === null) return `it changes a policy file, and head ${at} has no config, so the checks that judge the next merge cannot be told`;
  const located = headEntryProblem(lookup, pr, seen.at(-1));
  if (located) return located;
  // Never by foldPath: two paths equal here pass, so a wider equality would let more through.
  if (seen.at(-1)?.toLowerCase() !== String(policies.configFile).toLowerCase()) return `its config at head ${at} is ${JSON.stringify(seen.at(-1))}, not ${JSON.stringify(policies.configFile)} where ${pr.repo} ${policies.main} keeps it, which includePolicyFiles never lets a pull request move by itself`;
  const { github: policy, state } = policies.policy;
  const same = (a, b) => new Set(a).size === new Set(b).size && a.every((each) => b.includes(each));
  const differing = CHECK_LISTS.filter((key) => !same(policy[key], config.github[key]));
  if (state.dir !== config.state.dir) differing.push('state.dir');
  if (!differing.length) return null;
  const names = differing.map((key) => (key === 'state.dir' ? key : `github.${key}`)).join(' and ');
  return `its config at head ${at} changes ${names} from ${pr.repo} ${policies.main}, which includePolicyFiles never lets a pull request change by itself`;
}

// The changed file of `files` ({ path }, from the top of the repository) that is the pointer file of the project folder
// `prefix` (trailPaths' `pointer`), by its fold (foldPath), or undefined: the includePolicyFiles lift never lets one through.
export const movedPointer = (files, prefix = '') => {
  const pointer = foldPath(trailPaths(prefix).pointer);
  return files.find(({ path }) => foldPath(path) === pointer);
};
const movedLine = (moved) => `it changes ${JSON.stringify(moved.path)}, the pointer file that locates the config, which includePolicyFiles never lets a pull request change by itself`;

// The first of the changed files `files` ({ path, changeType }, from the top of the repository) that keeps auto-merge
// off by its path alone, whatever its review, checks, or head: { path, why }, or null. Each file is judged alone by the
// paths check's own rule (pathsProblem), under `policies`, branchPolicies' answer, with the lifts it reads
// (includesGuardedPaths, includesPolicyFiles), the start hook's docs `startDocs`, as startDocs reads them, and
// `pluginRepository`; then, while the includePolicyFiles lift counts, the pointer file, which headPolicyProblem never
// lets through. A project run's init asks it of each pull request it resumes (project-human-merges.mjs), so the Human
// hears of each merge that waits for them before the run starts.
export function neverMerged(files, prefix, policies, { startDocs: loaded, pluginRepository = false } = {}) {
  const options = { includeGuardedPaths: includesGuardedPaths(policies), includePolicyFiles: includesPolicyFiles(policies), policyFiles: policies.policyFiles, startDocs: loaded, pluginRepository };
  for (const file of files) {
    const why = pathsProblem({ files: [file], changedFiles: 1 }, prefix, options);
    if (why) return { path: file.path, why };
  }
  const moved = options.includePolicyFiles ? movedPointer(files, prefix) : undefined;
  return moved ? { path: moved.path, why: movedLine(moved) } : null;
}

// Why `file`, from the top of the repository, is no regular file at the head commit `pr.head`, or null, by its entry in
// that commit's tree (`lookup`, pr-auto-merge-docs.mjs treeLookup), which gives a link its own mode and never follows it.
// With `optional`, no entry is no file and passes. A tree that cannot tell refuses, and so does a file below a path that
// is no folder, such as a link.
function headEntryProblem(lookup, pr, file, { optional = false } = {}) {
  const at = String(pr.head).slice(0, 7);
  const named = JSON.stringify(file);
  const { unread, above, entry } = lookup(file);
  if (unread) return `it changes a policy file, and ${unread}, so whether ${named} is a regular file cannot be told`;
  if (above) return `${JSON.stringify(above)} at head ${at}, on the path to ${named}, is ${entryKind(entry)}, not a folder, which includePolicyFiles never lets through`;
  if (!entry) return optional ? null : `it changes a policy file, and head ${at} holds no ${named}`;
  return FILE_MODES.has(entry.mode) ? null : `${named} at head ${at} is ${entryKind(entry)}, not a regular file, which includePolicyFiles never lets through`;
}

// One folder of the head's tree by its SHA, for treeLookup: a failed read says gh's own words.
const headTree = (forge, pr) => (sha) => {
  try {
    return forge.tree(pr.repo, sha, { host: pr.host });
  } catch (error) {
    throw new Error(ghError(error));
  }
};

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
// reads its policy from, including a folder the pointer file names: a change to one, by its fold (foldPath), is off with the key on
// or off, after the guarded-path refusal so that refusal keeps its message. `startDocs` is what the start hook loads, as
// startDocs read it: a doc or index file of it is guarded too, and an unreadable answer is off, as no list would be
// whole. `pluginRepository` is whether the project is the plugin's own repository, whose release script is guarded too
// (PLUGIN_REPOSITORY_PATHS). `includeGuardedPaths` lifts only the guarded-path refusals, these included, the team having
// accepted that risk on both branches, and never for a policy file (POLICY_PATHS), unless `includePolicyFiles` is on as
// well (includesPolicyFiles): then neither a policy file nor one of `policyFiles` is refused. Alone it lifts nothing.
export function pathsProblem({ files, changedFiles }, prefix = '', { includeGuardedPaths = false, includePolicyFiles = false, policyFiles = [], startDocs = { docs: [], folder: null }, pluginRepository = false } = {}) {
  if (prefix === null) return 'git could not give the project\'s folder in the repository';
  if (files.length !== changedFiles) return `gh listed ${files.length} of its ${changedFiles} changed files`;
  const hidden = files.find(({ changeType }) => changeType === 'RENAMED' || !changeType);
  if (hidden) return `gh lists ${JSON.stringify(hidden.path)} as ${hidden.changeType || 'no change type'}, which may hide the path it replaced`;
  const outside = files.find(({ path }) => !path.startsWith(prefix));
  if (outside) return `it changes ${JSON.stringify(outside.path)}, outside this project's folder, which its review does not cover`;
  const read = new Set(policyFiles.map(foldPath));
  const policyRead = files.find(({ path }) => read.has(foldPath(path)));
  const readLine = policyRead && `it changes ${JSON.stringify(policyRead.path)}, a file the gate reads its policy from`;
  if (includeGuardedPaths) {
    if (includePolicyFiles) return null;
    const policy = files.find(({ path }) => isPolicyPath(path));
    if (policy) return `it changes ${JSON.stringify(policy.path)}, a policy file of aidrian, which includeGuardedPaths never lets through`;
    return readLine || null;
  }
  const guarded = files.find(({ path }) => isGuardedPath(path) || isGuardedPath(path.slice(prefix.length)));
  if (guarded) return `it changes ${JSON.stringify(guarded.path)}, which instructs AI sessions, or decides CI's verdict or auto-merge`;
  const release = pluginRepository && files.find(({ path }) => PLUGIN_REPOSITORY_PATHS.test(path));
  if (release) return `it changes ${JSON.stringify(release.path)}, ${RELEASE_SCRIPT}`;
  const unreadable = startUnreadable(startDocs);
  if (unreadable) return unreadable;
  for (const { path } of files) {
    const loaded = startLoadProblem(path, startDocs);
    if (loaded) return loaded;
  }
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

// settled.mjs bodyAccepts over the body of the pull request `pr` ({ repo, host, number, head }), read through the forge at
// exactly its head. Throws, naming the read, when gh fails, the head moved, or gh gives no body.
function bodyAt(forge, { repo, host, number, head }, section) {
  let pull;
  try {
    pull = forge.pull(repo, number, { host });
  } catch (error) {
    throw new Error(`could not read the body of #${number} with gh (${ghError(error)})`);
  }
  if (pull?.head?.sha !== head) throw new Error(`the head of #${number} moved from ${head.slice(0, 7)} to ${String(pull?.head?.sha ?? 'none').slice(0, 7)} while the gate read its body`);
  if (pull.body !== null && typeof pull.body !== 'string') throw new Error(`gh returned no body for #${number}`);
  return bodyAccepts(pull.body ?? '', section);
}

// Who requested changes, as a string, or null: the review decision, then anyone's latest review.
export function changesRequested({ reviewDecision, latestReviews }) {
  const reviewer = latestReviews.find((review) => review?.state === 'CHANGES_REQUESTED');
  if (reviewer) return `${reviewer.author?.login ?? 'a reviewer'} requested changes`;
  return reviewDecision === 'CHANGES_REQUESTED' ? 'its review decision is changes requested' : null;
}

// Why the review keeps auto-merge off, or null when the record holds a `received` review of exactly `head` and nothing is
// owed, or a `none_needed` one that pr-auto-merge-docs.mjs noneNeededProblem lets stand, by `unreviewed`: { files, prefix,
// review, errors, lists, listErrors }.
// A finding above low that an accepted residual waived is the author's word on a reviewer's finding, so the merge waits
// for the Human, whatever the review's outcome, and after the waiver ends, until a listing holds the finding as fixed, or,
// with `accepts` (settled.mjs bodyAccepts over the pull request's body at `head`), until the body no longer lists it and a
// pass of `head` re-weighed it (settled.mjs heldWaiver). `accepts` may throw, and its throw goes to the caller.
export function reviewProblem(state, head, unreviewed = {}, { accepts = null } = {}) {
  if (!state) return 'this machine holds no review record for it: run `aidrian pr review`';
  const owing = owed(state);
  if (owing.length) return `${owing.length} review ${owing.length === 1 ? 'entry is' : 'entries are'} still owed`;
  const outcome = state.outcome ?? null;
  if (outcome === null) return 'its review record holds no finished review';
  if (outcome.head !== head) return `the last review covered ${String(outcome.head).slice(0, 7)}, not head ${head.slice(0, 7)}`;
  const status = `the review of head ${head.slice(0, 7)} is \`${outcome.status}\``;
  if (outcome.status === 'none_needed') {
    const why = noneNeededProblem(outcome, unreviewed);
    if (why) return `${status}, and ${why}, so the merge waits for the Human`;
  } else if (outcome.status !== 'received') return status;
  const waived = heldWaiver(state, { head, accepts });
  if (!waived) return null;
  // A record without the residual's text names the finding by its id.
  const finding = [waived.ruled_id, waived.id].find(isFindingId);
  const named = typeof waived.residual === 'string'
    ? `the accepted residual ${JSON.stringify(waived.residual.slice(0, 120))} waived a finding above low severity`
    : `an accepted residual waived finding ${finding ?? 'with no id'}, above low severity`;
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
  return stateDirProblem(working.config, { state }, where);
}

const cleanup = (team) => `${team.deleteBranch ? 'delete' : 'keep'} the branch, ${team.deleteWorktree ? 'delete' : 'keep'} the worktree`;

// The gate's verdict, as `aidrian pr auto-merge --check` prints it: the JSON object, or its line. A pass says the check
// merges nothing, a verdict that reads no merge state, so it never reads as GitHub's own auto-merge turned on.
const waivedNote = (result) => (result.waived ? ' on a judge\'s verdict at the round cap' : '');
const allowedLead = (result) => `auto-merge allowed for #${result.pr} at ${result.head.slice(0, 7)}${waivedNote(result)}`;
function verdictLine({ result }, asJson) {
  if (asJson) return JSON.stringify(result);
  if (result.effective) return `${allowedLead(result)}, this check merges nothing: ${result.strategy ?? 'no strategy set'}, ${cleanup(result)}`;
  // A trust refusal names its reason and which half is missing: the bot's verdict, or a sign-off.
  return result.reason === 'trust' ? `auto-merge off for #${result.pr} (trust: ${result.trust}): ${result.why}` : `auto-merge off for #${result.pr}: ${result.why}`;
}
const printVerdict = (verdict, asJson, out) => {
  out.log(verdictLine(verdict, asJson));
  for (const line of verdict.localErrors) out.error(line);
};

// `aidrian pr auto-merge --check`, the gate alone: whether a session may merge the pull request unasked. Exit 0 on, 1 off,
// 3 error; exit 0 merges nothing. The options are gateVerdict's.
export function runAutoMerge(argv, project, options = {}) {
  const verdict = gateVerdict(argv, project, options);
  if (verdict.code === 3) return 3;
  printVerdict(verdict, parseArgs(argv).asJson, options.out ?? console);
  return verdict.code;
}

// The repository of `result`, gateVerdict's object, as gh's `--repo` takes it: always with its host, so gh never resolves
// a bare owner/name against another host it is signed in to.
const repoArg = (result, host) => `${host}/${result.repo}`;

// The `gh pr merge` command that merges the pull request of `result` by the team's choices, at exactly its head, or null
// when the team sets no strategy: the pr-merge-when-green skill picks one then, and no flag can stand in for it.
export function mergeCommand(result, host) {
  if (!result.strategy) return null;
  return `gh pr merge ${result.pr} --repo ${repoArg(result, host)} --${result.strategy} --match-head-commit ${result.head}${result.deleteBranch ? ' --delete-branch' : ''}`;
}

// Where the pull request stands, by the forge's mergeStatus: `merged`; `closed` with no merge; `queued` in GitHub's
// merge queue; `requested` with GitHub's auto-merge request; or `none`.
function mergeState(status) {
  if (status.merged) return 'merged';
  if (status.state === 'closed') return 'closed';
  if (status.queued) return 'queued';
  return status.autoMerge ? 'requested' : 'none';
}

// What the line says after the gate's lead, for each merge state.
function mergeLine(merge, status, result, host, command) {
  const checks = `\`aidrian pr checks ${result.pr} -R ${repoArg(result, host)}\` exits 0`;
  const run = command ? `then runs \`${command}\``
    : `picks a merge strategy, since the team sets none, then runs \`gh pr merge ${result.pr} --repo ${repoArg(result, host)} --match-head-commit ${result.head}${result.deleteBranch ? ' --delete-branch' : ''}\` with its flag`;
  return {
    merged: `merged: GitHub merged it at ${status.mergedAt ?? 'a time it does not give'}`,
    queued: 'merge queued: GitHub\'s merge queue holds it, and merges it once the queue\'s checks pass',
    requested: `merge requested: GitHub holds an auto-merge request (${status.autoMerge}) for it, and merges it once its required checks pass`,
    closed: 'not merged: it is closed with no merge',
    none: `not merged: nothing merged it, and GitHub holds no auto-merge request and no merge queue entry. Run the pr-auto-merge skill: it waits until ${checks}, ${run}`,
  }[merge];
}

// `aidrian pr auto-merge [PR] [--json] [--check]`. With `--check`, the gate alone (runAutoMerge). Without it, a session
// that reads the command as the merge is never told it merged when nothing did (#620 and #622 sat green until the Human
// merged them): after a gate that allows it, one read of the pull request (the forge's mergeStatus) says whether GitHub
// merged it (exit 0, `merge` "merged"), its merge queue holds it (exit 0, "queued"), or it holds an auto-merge request
// for it (exit 0, "requested"); a pull request closed with no merge is exit 1 ("closed"); otherwise exit 4 ("none"), with
// the `gh pr merge --match-head-commit` command a session runs once every check passes, as the pr-auto-merge skill does,
// or with no strategy set, what that skill does. It never merges itself: a merge from this process would pass the merge
// guard by, which reads the session's own command, and the skill's wait for every check and its confirm.
// The read must give the head the gate passed: one that moved is exit 3, since the verdict is of the old head.
// A refusal is the gate's (exit 1), and a failed read exit 3. `--json` adds `merge`, and `command` with "none", null
// with no strategy set.
export function runAutoMergeCommand(argv, project, options = {}) {
  const { asJson, check } = parseArgs(argv);
  if (check) return runAutoMerge(argv, project, options);
  const out = options.out ?? console;
  const fail = (message) => {
    out.error(`aidrian pr auto-merge: ${message}`);
    return 3;
  };
  const forge = options.forge ?? forgeFor(project.root);
  const verdict = gateVerdict(argv, project, { ...options, forge });
  if (verdict.code === 3) return 3;
  if (verdict.code !== 0) {
    printVerdict(verdict, asJson, out);
    return verdict.code;
  }
  const { result, host } = verdict;
  let status;
  try {
    status = forge.mergeStatus(result.repo, result.pr, { host });
  } catch (error) {
    return fail(`could not read whether #${result.pr} merged with gh (${ghError(error)})`);
  }
  if (status?.head !== result.head) {
    return fail(`the head of #${result.pr} moved from ${result.head.slice(0, 7)} to ${String(status?.head ?? 'none').slice(0, 7)} after the gate passed it: run the command again`);
  }
  const merge = mergeState(status);
  const command = mergeCommand(result, host);
  out.log(asJson ? JSON.stringify({ ...result, merge, ...(merge === 'none' ? { command } : {}) }) : `${allowedLead(result)}, ${mergeLine(merge, status, result, host, command)}`);
  return { merged: 0, queued: 0, requested: 0, closed: 1, none: 4 }[merge];
}

// The gate's verdict: { code, result, host, localErrors }, `code` 0 on and 1 off, `result` the --json object, `host` the
// pull request's, and `localErrors` the local file's errors when the reason is local; or { code: 3 } once it printed
// the error to `out.error`. `forge` is the test seam: the forge facade (lib/forges), whose methods throw as gh does. `unattended`
// says whether no Human attends the session that runs it: its unattended mark, by the session id its host gives the
// command (hosts/index.mjs sessionIdentity), a pending or unreadable mark included. `run` gives the project run that
// mark names (waiver-stand.mjs runOf), for the run's budget of waived merges; `runHost` the host it runs under, which
// must confirm a waiver's judge (waiver-stand.mjs judgeHostProblem); `runIssue` the issue that run holds the session to,
// for the closing-word check (closing-words.mjs runClosingContext). Both come from one read of the mark (`mark`,
// closing-words.mjs markOnce); a mark that cannot be read names a run whose budget cannot be counted.
export function gateVerdict(argv, project, { forge = forgeFor(project.root), session = sessionIdentity(process.env).session, home, unattended = () => heldSession(session, home ? { home } : {}), mark = markOnce(session, home ? { home } : {}), run = () => (mark().unreadable ? null : runOf(mark().mark)), runHost = detectHost(), runIssue = () => closingContextOf(mark(), home ? { home } : {}), out = console } = {}) {
  const fail = (message) => {
    out.error(`aidrian pr auto-merge: ${message}`);
    return { code: 3 };
  };
  const { target, unknown } = parseArgs(argv);
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
  const prefix = knownPrefix(project.root);
  let refusing;
  let main;
  let policy;
  let includeGuarded = false;
  let includePolicy = false;
  let policyFiles = [];
  let policies;
  try {
    policies = branchPolicies(forge, pr, prefix ?? '');
    ({ main, policy, policyFiles } = policies);
    refusing = refusingBranches(policies, pr.base, 'autoMerge');
    includeGuarded = includesGuardedPaths(policies);
    includePolicy = includesPolicyFiles(policies);
    team = { ...policy.github.autoMerge, allow: refusing.length === 0 };
  } catch (error) {
    return fail(error.message);
  }

  // A tracked local file is no machine's own, so it follows no default of "on". Read only when that default would apply.
  const followsDefault = project.localAutoMerge === 'unset' && team.allow && team.default === 'on';
  const local = followsDefault && !mayFollowTeamDefault(project) ? 'off' : project.localAutoMerge;
  let { effective, reason } = resolveAutoMerge({ autoMerge: team }, local);
  // The plugin's own repository guards its release script too (PLUGIN_REPOSITORY_PATHS); no other project does.
  const pluginRepository = isPluginRepository(project);
  // Which half of merge trust is missing, `bot` or `signoff`, when the reason is `trust`; else null.
  let trust = null;
  // With `trust` "signoff": the flow whose sign-off is missing, and the class of the decision it is for the Human.
  let signoff = null;
  // Whether the review check passed on a judge's verdict at the round cap.
  let waived = false;
  let why = reason === 'team'
    ? `the team does not allow it (github.autoMerge.allow on ${pr.repo} ${refusing.join(' and ')})`
    : reason === 'local' ? `this machine has not opted in (github.autoMerge in ${project.paths.local})` : null;
  // The pull request with every changed file, once the paths check has read the whole list: the review check sorts it.
  let listed = pr;
  // What the start hook loads, read once the list is whole: the paths check and the review check both refuse on it.
  let loaded = null;
  if (reason !== 'team') {
    const problem = checksProblem(policy, loadConfig(project), `${pr.repo} ${main}`);
    if (problem) [effective, reason, why] = [false, 'checks', problem];
    else {
      listed = prefix === null ? pr : wholeFiles(forge, pr);
      if (prefix !== null && typeof listed !== 'string') loaded = startDocs(forge, pr, main, policies.configFile, prefix);
      const paths = typeof listed === 'string' ? listed : pathsProblem(listed, prefix, { includeGuardedPaths: includeGuarded, includePolicyFiles: includePolicy, policyFiles, startDocs: loaded ?? undefined, pluginRepository });
      const head = paths || typeof listed === 'string' ? null : headPolicyProblem(forge, pr, policies, listed.files, prefix);
      if (paths || head) [effective, reason, why] = [false, 'paths', paths || head];
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
      const unreviewed = { files: listed.files, prefix, review: policy.review, errors: policies.policyErrors, ...unreviewedLists(policies, pr), startDocs: loaded, tree: headTree(forge, pr), pluginRepository };
      const state = scoped(recordFor(project, pr.number, pr.repo), project, pr.repo);
      const changes = changesRequested(pr);
      // The body at the head, read once and only for a waiver above low the head's review re-weighed: the gate holds only
      // the waivers it still lists.
      let accepted = null;
      const accepts = (entry, raised) => {
        accepted ??= bodyAt(forge, pr, policy.github.pullRequest?.residuals?.section);
        return accepted(entry, raised);
      };
      let problem;
      try {
        problem = changes ?? reviewProblem(state, pr.head, unreviewed, { accepts });
      } catch (error) {
        return fail(error.message);
      }
      // A sign-off of the Human's that a judge's verdict would otherwise need: merge trust's `signoff` stop.
      let owedSignoff = null;
      // The review trail, read at most once: for a verdict's bot check and for merge trust.
      let trail = null;
      const readTrail = () => (trail ??= forge.reviewTrail(pr.repo, pr.number, { host: pr.host, paths: trailPaths(prefix) }));
      // A read taken now, kept for every reader after it: the closing check takes its snapshot after its commit reads,
      // so a link added while they ran is seen, and merge trust then judges that same snapshot.
      const freshTrail = () => (trail = forge.reviewTrail(pr.repo, pr.number, { host: pr.host, paths: trailPaths(prefix) }));
      if (!outsider && !changes && problem && waiverKind(state, pr.head) === 'round_cap') {
        let stand;
        try {
          stand = waivedReview({
            project, config: loadConfig(project).config, state, pr: pr.number, head: pr.head, policies, repo: pr.repo, host: pr.host, base: pr.base, prefix, trail: readTrail, run: run(), runHost,
          });
        } catch (error) {
          return fail(`could not read the review trail of #${pr.number} with gh (${ghError(error)})`);
        }
        if (stand.waived) [problem, waived] = [null, true];
        // A sign-off the Human owes on the head, found before any verdict is read, stops as merge trust does, with its
        // flow and class, so a run parks it as a decision for the Human.
        else if (stand.kind === 'signoff') {
          [problem, owedSignoff] = [null, stand.why];
          const unsigned = stand.unsigned ?? [];
          signoff = { flow: unsigned[0] ?? null, signoffClass: signoffClassOf(policy, unsigned) };
        } else problem = `${problem}, and no judge's verdict lets it merge: ${stand.why}`;
      }
      // The closing words of a project run's issue session, from the final review verdict: read only when every check
      // before them allows it, a review a judge's verdict waived included. One read of the mark gives the run and its
      // issue.
      const context = outsider || problem ? undefined : runIssue();
      let closing = null;
      if (context !== undefined && unattended()) {
        try {
          closing = closingProblem(forge, pr, context, freshTrail);
        } catch (error) {
          return fail(error.message);
        }
      }
      if (outsider) [effective, reason, why] = [false, 'outsider', `${outsider} commented, and is no member of the repository`];
      else if (problem) [effective, reason, why] = [false, 'review', problem];
      // Before merge trust, as for any merge: a pull request that would close another issue stops on that first.
      else if (closing) [effective, reason, why] = [false, 'closes', closing];
      else if (owedSignoff) [effective, reason, why, trust] = [false, 'trust', owedSignoff, 'signoff'];
      else if (unattended()) {
        // The record is this machine's word, which a confined session can write: a merge no Human attends rests on the
        // forge too. The merge guard holds the merge itself to the same.
        try {
          readTrail();
        } catch (error) {
          return fail(`could not read the review trail of #${pr.number} with gh (${ghError(error)})`);
        }
        const verdict = trustVerdict({
          trail, head: pr.head, reviewer: policy.github.reviewer, files: listed.files, complete: true, configs: [policy, policies.basePolicy],
          prefix, policyFiles, state, signoffs: readHumanSignoffs({ repo: pr.repo, pr: pr.number }),
        });
        if (verdict) [effective, reason, why, trust] = [false, 'trust', verdict.why, verdict.kind];
        if (verdict?.kind === 'signoff') signoff = { flow: verdict.flow, signoffClass: signoffClassOf(policy, verdict.unsigned ?? [verdict.flow]) };
      }
    }
  }

  const result = {
    effective, reason, why, allow: team.allow, local, strategy: team.strategy, deleteBranch: team.deleteBranch,
    deleteWorktree: team.deleteWorktree, pr: pr.number, head: pr.head, repo: pr.repo, base: pr.base, ...(waived ? { waived } : {}), ...(trust ? { trust } : {}), ...(trust === 'signoff' ? signoff ?? {} : {}),
  };
  const localErrors = reason === 'local' ? project.errors.filter((each) => each.startsWith(`${project.paths.local}:`)) : [];
  return { code: effective ? 0 : 1, result, host: pr.host, localErrors };
}

// --- The closing words of a project run's issue session (reason `closes`, lib/closing-words.mjs) ---

// Why the title, body, or a commit of the pull request `pr` ({ repo, host, number, head }) would close, or its title link,
// an issue other than the run's own, by `context` { own, prefixes } (closing-words.mjs runClosingContext), or null. First
// the commits, from the forge's list for the pull request at exactly `head`, which must be all of them: GitHub lists at
// most 250, and a commit's message is fixed by its SHA. Then one snapshot, the review trail `takeTrail` reads afresh
// after them, gives the title, the body, and the issues the forge itself links to close at the merge, a sidebar link
// included (closing-words.mjs forgeClosingProblem), as the merge guard judges them: an edit or a link made while the
// commits were read is seen, and merge trust reads that same snapshot after it. Throws, naming the read, when gh fails
// or the head moved during the read: the caller exits 3, and the stop's command waits for a settled head rather than
// refuse on a race.
export function closingProblem(forge, pr, context, takeTrail) {
  const { repo, host, number, head } = pr;
  let pull;
  let commits;
  try {
    pull = forge.pull(repo, number, { host });
  } catch (error) {
    throw new Error(`could not read the commit count of #${number} with gh (${ghError(error)})`);
  }
  if (pull?.head?.sha !== head) throw new Error(`the head of #${number} moved from ${head.slice(0, 7)} to ${String(pull?.head?.sha ?? 'none').slice(0, 7)} while the gate read its commits`);
  if (!Number.isInteger(pull.commits)) return `gh returned no commit count for #${number}`;
  try {
    commits = forge.changeCommits(repo, number, { host });
  } catch (error) {
    throw new Error(`could not read the commits of #${number} with gh (${ghError(error)})`);
  }
  // A refusal of the commit list waits for the trail's head check below: a push between the reads changes the list, and
  // is a moved head the stop retries on, never `closes` for the head before it.
  let listed = null;
  const messages = [];
  if (!Array.isArray(commits) || commits.length !== pull.commits) listed = `gh listed ${Array.isArray(commits) ? commits.length : 'none'} of its ${pull.commits} commits, and GitHub lists at most 250, so a closing word may hide in one it did not list`;
  for (const commit of listed ? [] : commits) {
    const message = commit?.commit?.message;
    if (typeof message !== 'string') {
      listed = `gh returned a commit of #${number} with no message`;
      break;
    }
    messages.push({ where: `commit ${String(commit.sha ?? '').slice(0, 7) || 'with no SHA'}`, text: message });
  }
  let trail;
  try {
    trail = takeTrail();
  } catch (error) {
    throw new Error(`could not read the review trail of #${number} with gh (${ghError(error)})`);
  }
  if (typeof trail?.head !== 'string' || trail.head.toLowerCase() !== head.toLowerCase()) {
    throw new Error(`the head of #${number} moved from ${head.slice(0, 7)} to ${String(trail?.head ?? 'none').slice(0, 7)} while the gate read its title, body, and the issues it closes`);
  }
  if (listed) return listed;
  if (typeof trail.title !== 'string' || (trail.body !== null && typeof trail.body !== 'string')) return `the forge gave no title or body for #${number}`;
  const texts = [{ where: 'its title', text: trail.title, title: true }, { where: 'its body', text: trail.body ?? '' }, ...messages];
  return closingTextsProblem(texts, context, pr) ?? forgeClosingProblem(trail, context, pr);
}

// The class of the decision the missing sign-offs of `flows` are for the Human (`aidrian project stop-action` names it):
// `security` when the default branch's config, `policy`, has any of them a security sign-off, a flow whose id holds the
// word `security` or whose `require` names the security-engineer agent; `product` otherwise, a flow it does not define
// included. A single flow id is read as a list of one.
export function signoffClassOf(policy, flows) {
  const security = (flow) => {
    if (typeof flow !== 'string') return false;
    const defined = policy?.review?.flows?.[flow];
    return flow.split('-').includes('security') || (Array.isArray(defined?.require) && defined.require.includes('agent:security-engineer'));
  };
  return (Array.isArray(flows) ? flows : [flows]).some(security) ? 'security' : 'product';
}
