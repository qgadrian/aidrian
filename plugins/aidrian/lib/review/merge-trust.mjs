// What a merge no Human asks for rests on beyond this machine's review record (docs/review.md#merge-trust). A project
// run's confined session can write the state work folders, review records and the dispatch log among them, and can post
// as the user, so neither the record nor the user's own text on the pull request is a verdict for such a merge. Two
// things are, and `aidrian pr auto-merge` (lib/pr-auto-merge.mjs) and the merge guard, for a session no Human attends
// (lib/rules/github/merge-review.mjs), both ask for them at merge time:
//   1. the review bot's verdict, read on the forge: the configured `github.reviewer` of the default branch, a bot account,
//      approved exactly the head commit, or its own status card, edited by no one else, says its review of exactly that
//      commit finished with nothing unresolved; and no review of that commit by the bot says anything else, a dismissed
//      one included (botProblem);
//   2. the Human's sign-off of each flow that asks for one, read from the sign-off store, `<state root>/signoffs/`, which
//      only `aidrian pr signoff` in a session the Human attends writes: the agent gate hook refuses it to a subagent and to
//      a session no Human attends (lib/handoff-guard.mjs signoffWriteDenial), a confined session's sandbox denies it
//      (lib/hosts/claude-code-sandbox.mjs, lib/project-start.mjs guardedFolders), and the review-signoff rule refuses
//      them the command. The flows that need one are those the record names on that head, plus a floor read from the
//      forge alone (flowsFloor), so a record that names none does not lift them.
// A review stays the record's for every merge the Human asks for: the store adds to it, and no attended read changes.

import { isObject } from '../fs.mjs';
import { POLICY_PATHS } from '../project.mjs';
import { cardState, isReviewSummaryCard } from './bot-card.mjs';
import { citedDocs } from './cited.mjs';
import { classify, HARNESS_FLOW, pathPattern } from './plan.mjs';
import { sameCommit } from './state.mjs';

// The sign-off store (signoff-store.mjs), for the callers that read merge trust.
export { readHumanSignoffs, recordHumanSignoff, SIGNOFF_FOLDER, signoffFile, signoffFolder, signoffFolders } from './signoff-store.mjs';

// A bot's login as both GitHub APIs give it, compared: REST adds `[bot]`, GraphQL does not.
const botName = (login) => (typeof login === 'string' ? login.toLowerCase().replace(/\[bot\]$/u, '') : null);
export const sameBot = (login, reviewer) => botName(login) !== null && botName(login) === botName(reviewer);

// Why the review bot's verdict on the forge does not pass `head`, or null when it does. `trail` is the forge's
// reviewTrail of the pull request; `reviewer` the default branch's `github.reviewer`, read from the forge. A review or a
// comment counts only when its author is a bot account of that name. Passed: an approving review of exactly `head`, or
// the bot's status card, whose every edit the bot made, saying its code review of exactly `head` completed with
// `has_any_findings` and `has_unresolved_findings` both false; and no review of `head` by the bot in any other state,
// in a review list the forge gave whole (`reviewsComplete`), so the guard and `aidrian pr auto-merge` judge it alike.
// The two flags are the bot's ledger of its findings that still stand at that commit, equal on every card seen: the bot
// clears both itself on a later run once its findings are fixed, and neither a receipt nor a resolved thread clears
// them. A card that names `head` with a flag not false says so in the refusal. A clean receipt or a 👍 never
// counts: the receipt names a 10-hex short commit, which a commit ground to share it matches, and the forge gives no
// push time that would bind it to the head; the 👍 names no commit, and lands seconds after the receipt, so after a
// push it answers the head before it.
export function botProblem(trail, head, reviewer) {
  const sha7 = head.slice(0, 7);
  if (typeof reviewer !== 'string' || reviewer === '') return NO_BOT;
  if (typeof trail?.head !== 'string' || trail.head.toLowerCase() !== head.toLowerCase()) return `the forge gives its head as ${String(trail?.head ?? 'none').slice(0, 7)}, not ${sha7}`;
  // A review of `head` in another state may lie past a list the forge gave only in part (the trail reads the newest 100).
  if (trail.reviewsComplete !== true) return `the forge gave only part of its reviews, so whether ${reviewer} reviewed head ${sha7} in a state that does not pass cannot be told`;
  const onHead = (trail.reviews ?? []).filter((review) => review.bot && sameBot(review.login, reviewer) && typeof review.commit === 'string' && review.commit.toLowerCase() === head.toLowerCase());
  const other = onHead.find((review) => review.state !== 'APPROVED');
  if (other) return `${reviewer} reviewed head ${sha7} as ${String(other.state ?? 'unknown').toLowerCase()}, so its review of that commit did not pass`;
  if (onHead.length) return null;
  const cards = (trail.comments ?? []).filter((comment) => comment.bot && sameBot(comment.login, reviewer) && isReviewSummaryCard(comment.body));
  const whole = cards.filter((card) => card.editsComplete === true);
  const own = whole.filter((card) => (card.editors ?? []).every((login) => sameBot(login, reviewer)));
  const completedOnHead = own.map((card) => cardState(card.body)?.code_review).filter((review) => review?.status === 'completed'
    && typeof review.commit_sha === 'string' && review.commit_sha.toLowerCase() === head.toLowerCase());
  const holds = (review) => review.has_any_findings !== false || review.has_unresolved_findings !== false;
  if (completedOnHead.some((review) => !holds(review))) return null;
  let why = '';
  if (whole.length > own.length) why = ', and its status card was edited by another account';
  else if (cards.length > whole.length) why = ', and the forge gave only part of its status card\'s edit history, so who edited it cannot be told';
  else if (completedOnHead.length) why = ', and its status card of that commit says its review finished with a finding of its own still unresolved there: a later review by the bot clears that once the finding is fixed; a receipt or a resolved thread does not';
  else if (!cards.length && trail.commentsComplete === false) why = ', and the pull request has more comments than the forge read gives, so its status card may be past them';
  return `${reviewer} has not passed head ${sha7} on the forge: no approving review of that commit, and no status card of its own that says its review of that commit finished and found nothing${why}`;
}

// The refusal when no review bot is set, which names the fix.
export const NO_BOT = 'no review bot is set (github.reviewer on the default branch), so no reviewer outside this machine has passed it: '
  + 'set one in github.reviewer on the default branch, or the Human merges';

// The changed files as paths from the project root, or null for one outside the project's folder `prefix`.
const fromRoot = (file, prefix) => (file.startsWith(prefix) ? file.slice(prefix.length) : null);

// Whether a review config runs a command of the project's own that may select a flow or read a file the review is
// decided by: the plan command, an `exec` reviewer's command, or the visual review's login or preview command.
const runsCommand = (review) => (typeof review.planCommand === 'string' && review.planCommand !== '')
  || Object.values(isObject(review.reviewers) ? review.reviewers : {}).some((reviewer) => Array.isArray(reviewer?.command) && reviewer.command.length > 0)
  || (isObject(review.visual) && ['login', 'preview'].some((key) => typeof review.visual[key] === 'string' && review.visual[key] !== ''));

// Whether every one of `configs`, as the forge holds each branch's, commits github.autoMerge.includePolicyFiles with
// includeGuardedPaths: the team's explicit acceptance, on the default branch and the base alike, that a policy file
// merges with no sign-off of the Human (pr-auto-merge.mjs includesPolicyFiles reads the same two keys). None lifts nothing.
export const policyFilesLifted = (configs) => configs.length > 0
  && configs.every((config) => config?.github?.autoMerge?.includeGuardedPaths === true && config.github.autoMerge.includePolicyFiles === true);

// The flows whose Human sign-off a merge of these changed files needs, by what the forge alone gives: { flows, reasons },
// a Set of flow ids and why each is in it. `files` are { path, changeType } from the top of the repository, `complete`
// whether they are every changed file, `configs` the default branch's and the base's configs as the forge holds them,
// `prefix` the project's folder, and `policyFiles` the paths, from the top of the repository, both branches' configs
// were read from (pr-auto-merge.mjs branchPolicies). It never reads the head's content, so it takes every flow that may be
// selected:
// - a flow the Human signs off (`signoff: "human"`) whose `files` match a behaviour file, sorted by that config's
//   `review.ignore` and `review.nonBehaviour` as the plan sorts them (plan.mjs classify, detectFlows); or that a command
//   of the project's (runsCommand), its `added` patterns, or its `content` tracing may select;
// - any flow whose `tests` match a deleted file: the review asks the Human to accept the deletion;
// - the built-in harness-config flow when a changed file is a policy file of aidrian (POLICY_PATHS), one the configs
//   were read from, unless every config lifts that (policyFilesLifted), or a doc a flow cites, or a command of the
//   project's may name the files that decide the review;
// - every one of those flows when the list is not whole, or a change type hides a path (a rename).
export function flowsFloor({ files, complete = true, configs, prefix = '', policyFiles = [] }) {
  const flows = new Set();
  const reasons = new Map();
  const add = (id, why) => {
    if (!flows.has(id)) reasons.set(id, why);
    flows.add(id);
  };
  const known = complete && files.every((file) => ['ADDED', 'MODIFIED', 'DELETED', 'CHANGED', 'COPIED'].includes(file.changeType));
  const changed = files.map((file) => ({ ...file, rel: fromRoot(file.path, prefix) }));
  const matches = (globs, rel) => rel !== null && (globs ?? []).map(pathPattern).some((pattern) => pattern.test(rel));
  const read = new Set(policyFiles.map((each) => each.toLowerCase()));
  const lifted = policyFilesLifted(configs);
  for (const config of configs) {
    const review = config?.review ?? {};
    const commanded = runsCommand(review);
    const sorted = classify(changed.filter((file) => file.rel !== null).map((file) => ({ file: file.rel })), { ignore: review.ignore, nonBehaviour: review.nonBehaviour });
    const behaviour = new Set(sorted.behaviour);
    const flowsOf = isObject(review.flows) ? review.flows : {};
    for (const [id, flow] of Object.entries(flowsOf)) {
      if (!known && (flow.signoff === 'human' || flow.tests?.length)) add(id, 'the forge did not give every changed file with its path');
      if (changed.some((file) => file.changeType === 'DELETED' && matches(flow.tests, file.rel))) add(id, 'it deletes a test of the flow');
      if (flow.signoff !== 'human') continue;
      if (changed.some((file) => behaviour.has(file.rel) && matches(flow.files, file.rel))) add(id, 'it changes a file of the flow');
      if (commanded) add(id, 'a command of the project\'s review may select it');
      if (flow.added?.length || flow.content !== undefined) add(id, 'what selects it is the changed content, which the merge does not read');
    }
    const cited = [...citedDocs(flowsOf).keys()];
    if (!known) add(HARNESS_FLOW, 'the forge did not give every changed file with its path');
    if (commanded) add(HARNESS_FLOW, 'a command of the project\'s review may name the files that decide the review');
    if (!lifted && changed.some((file) => POLICY_PATHS.test(file.path) || read.has(file.path.toLowerCase()))) add(HARNESS_FLOW, 'it changes the review config');
    if (changed.some((file) => file.rel !== null && cited.includes(file.rel))) add(HARNESS_FLOW, 'it changes a doc a flow\'s invariants cite');
  }
  return { flows, reasons };
}

// The flows the record `state` asks the Human to sign off on `head`: the review step's `signoffable` list for that head.
export const recordedFlows = (state, head) => (isObject(state?.signoffable) && sameCommit(state.signoffable.head, head) && Array.isArray(state.signoffable.flows)
  ? state.signoffable.flows.filter((flow) => typeof flow === 'string')
  : []);

// Why the Human's sign-offs do not cover a merge of `head`, or null: each of `flows` needs an entry of the store
// (`signoffs`, readHumanSignoffs's answer) on exactly `head`. `reasons` says why the floor took a flow.
export function signoffProblem({ flows, reasons = new Map(), signoffs, head }) {
  if (signoffs.problem) return signoffs.problem;
  for (const flow of [...flows].sort()) {
    const entry = signoffs.flows[flow];
    if (entry && entry.head === head.toLowerCase()) continue;
    const why = reasons.get(flow) ? ` (${reasons.get(flow)})` : '';
    return `flow ${flow} needs the Human's sign-off on head ${head.slice(0, 7)}${why}, and this machine's sign-off store holds none for that head: only \`aidrian pr signoff\` in a session the Human attends records one`;
  }
  return null;
}

// Why the forge and the sign-off store do not let a merge no Human asks for go ahead, as { kind, why, flow? }, or null: the
// bot's verdict first (`kind` "bot"), then the sign-offs ("signoff", with `flow`, the first flow whose sign-off is missing, and `unsigned`, every one). `trail` is the forge's reviewTrail, `reviewer` and
// `configs` read from the forge, `files` and `complete` the changed files, `state` the review record, read only for the
// flows it names.
export function trustVerdict({ trail, head, reviewer, files, complete, configs, prefix, policyFiles = [], state, signoffs }) {
  const bot = botProblem(trail, head, reviewer);
  if (bot) return { kind: 'bot', why: bot };
  const floor = flowsFloor({ files, complete, configs, prefix, policyFiles });
  const flows = new Set([...recordedFlows(state, head), ...floor.flows]);
  const signoff = signoffProblem({ flows, reasons: floor.reasons, signoffs, head });
  return signoff ? { kind: 'signoff', why: signoff, flow: unsignedFlow({ flows, signoffs, head }), unsigned: unsignedFlows({ flows, signoffs, head }) } : null;
}

// The flow signoffProblem names: the first of `flows`, sorted, the store holds no sign-off of on `head`, or null when no
// flow needs one.
export function unsignedFlow({ flows, signoffs, head }) {
  return unsignedFlows({ flows, signoffs, head })[0] ?? null;
}

// Every one of `flows`, sorted, the store holds no sign-off of on `head`: every one of them when the store itself could
// not be read, so a reader that classes the missing sign-offs, as a security one among them, sees each.
export function unsignedFlows({ flows, signoffs, head }) {
  if (signoffs.problem) return [...flows].sort();
  return [...flows].sort().filter((flow) => !(signoffs.flows[flow] && signoffs.flows[flow].head === head.toLowerCase()));
}

// trustVerdict's sentence alone, or null.
export const trustProblem = (args) => trustVerdict(args)?.why ?? null;
