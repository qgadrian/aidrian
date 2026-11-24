// Extra review rounds past config.json `github.maxReviewRounds`. At the cap, `aidrian pr review` and
// `aidrian pr await-review --request` ask whether one more round is worth it instead of stopping outright:
//
//   1. The policy is the base branch's: `github.extraRounds` ("off", "ask", "auto") and `github.maxExtraRounds`, the hard
//      ceiling on grants. "off", or the ceiling reached, is round_limit as before.
//   2. Mechanical signals from the round history, computed here: converging (fewer open findings than the round before),
//      looping (a finding back at the same place or under the same title after a fix), drifting (a finding outside the
//      files the pull request first changed), bloating (fix commits adding more than BLOAT_PERCENT of the pull request's
//      first diff, counting code only: docs and other prose files that review.nonBehaviour lists add no bloat).
//      A red flag is no dead end: it goes to the judge as evidence, and an extra round over it needs the Human.
//   3. `extension_check` dispatches a read-only judge; `aidrian pr extend <PR> --verdict extend|stop` records its word.
//      "auto" grants on extend with no red flag; "ask", or any red flag, returns `extension_ask` until the Human
//      answers, recorded with `aidrian pr extend <PR> --human approve|deny` (lib/rules/review-extend.mjs guards it).
//   4. A grant is one round. The next cap repeats the check.
//   5. Under the unattended waiver (docs/config.md#unattended-waiver), the step's `waiver` says whether the cap may end
//      in a merge with its open findings filed (waiver-stand.mjs offerWaiver). Only then the judge may also rule `land`,
//      and at a `round_limit` with no check one judge is dispatched for that alone (offerLand). `aidrian pr extend <PR>
//      --verdict land --judge <agent id>` stops the check and records the waiver's `waive` verdict, through the gate and
//      the writer `aidrian pr waive` uses (runLanding); `--verdict stop --judge` records its `refuse`.
//
// Each decision is an entry in the review record (lib/review/state.mjs) and a `review_extension` row in the dispatch
// log. docs/review.md#extra-rounds describes it.

import { appendEvent, stamp } from '../dispatch-log.mjs';
import { forgeFor } from '../forges/index.mjs';
import { runGit } from '../git.mjs';
import { sessionIdentity } from '../hosts/index.mjs';
import { givenRepo, repoFlag } from '../remotes.mjs';
import { readGate, asLanded } from './waiver-stand.mjs';
import { appendVerdict, JUDGE_ID, sameRevision, verdictNext } from './waiver.mjs';
import { changedFiles, diffLines, mergeBase, resolve } from './diff.mjs';
import { holdToBase } from './in-force.mjs';
import { classify } from './plan.mjs';
import { postContext, readReading, shellQuote } from './dispatch.mjs';
// One reading of a red flag, a full reason or the bare name a posted copy keeps (publish.mjs flagName).
import { flagName } from './publish.mjs';
import { isFindingId, twinMatch } from './findings.mjs';
import { checkId, heldMessage, mergePending, publishState, readRecord, sameCommit, SHA_REF, writeLocalState } from './state.mjs';

export { checkId };

// The twin match lives with the findings (lib/review/findings.mjs), which the security mark reads too.
export { NEAR_LINES, normalizeTitle } from './findings.mjs';

export const MODES = Object.freeze(['off', 'ask', 'auto']);
// Fix commits that add more than this share of the lines of code the pull request first added are the change growing under
// review, not converging. Below BLOAT_MIN_LINES the share says nothing: a ten-line change may need a ten-line fix.
export const BLOAT_PERCENT = 50;
export const BLOAT_MIN_LINES = 40;
export const JUDGE_PASS = 'extension-judge';
export const JUDGE_AGENT = 'code-reviewer';
// What a status carries per round and per list, so a long history stays one readable JSON object.
const MAX_FINDINGS = 30;
const MAX_FILES = 100;
const MAX_BODY = 4000;

export const policyOf = (github) => ({ mode: github?.extraRounds ?? 'ask', max: github?.maxExtraRounds ?? 2 });

// The entries of `source`, and for the bot's rounds those of `reviewer` alone: a bot decision is for the reviewer whose
// history it read, so another bot never takes its check, its question, or its grant. A bot entry with no reviewer, one an
// older version or an override wrote, belongs to none, and the cap is checked afresh. A plan entry names no reviewer.
export const sameReviewer = (entry, reviewer = null) => (entry.reviewer ?? null) === (reviewer ?? null);
const entriesOf = (state, source, reviewer = null) => (state.extensions ?? []).filter((entry) => entry.source === source && sameReviewer(entry, reviewer));

// The extra rounds the base branch's policy lets count: each granted entry, once its mode allows it ("auto" takes the
// judge's word, "ask" needs the Human's approval), up to the ceiling. "off" counts none.
export function grantedRounds(state, source, policy, reviewer = null) {
  if (!state || policy.mode === 'off') return 0;
  const granted = entriesOf(state, source, reviewer).filter((entry) => entry.status === 'granted' && (policy.mode === 'auto' || entry.human?.answer === 'approve'));
  return Math.min(granted.length, policy.max);
}

// The round cap in force, the same for `aidrian pr review` and `aidrian pr await-review`: the baseline (an explicit
// --max-rounds, which the caller has checked against the base branch's cap and the Human's override, else that cap)
// plus the extra rounds still valid. `grantFloor` is the baseline: a round past it uses a grant, and a request for it is
// bound to the head the grant was read on.
export const roundCap = ({ baseline, granted }) => ({ maxRounds: baseline + granted, grantFloor: baseline });

// The title of a review bot's inline comment: its first line with words, without badges and markup.
export function findingTitle(body) {
  if (typeof body !== 'string') return null;
  for (const line of body.split('\n')) {
    const text = line.replace(/!\[[^\]]*\]\([^)]*\)/gu, '').replace(/<[^>]*>/gu, '').replace(/[*_`#>]/gu, '').trim();
    if (/\p{L}/u.test(text)) return text.slice(0, 200);
  }
  return null;
}

// The id an evidence entry carries for the finding it reports, when that finding has one.
const idOf = (finding) => (isFindingId(finding?.id) ? { id: finding.id } : {});
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// The mechanical signals of a round history: { converging, looping, drifting, bloating, unknown, evidence, reasons }.
// Each signal is true, false, or null when the history cannot tell. `reasons` lists every red flag; any red flag sends
// the judge's extend to the Human. A history from which no signal can be read is a red flag too: nothing in it shows
// the review converging.
// `rounds`: [{ round, head, open, floor?, findings: [{ title, file, line }] | null, fix: { added, code_added, removed, files } | null }],
// where `fix` is the change from that round's head to the next round's, or to the current head for the last, and
// `code_added` the lines of `added` outside prose files. Bloat counts `code_added` when it is there.
export function signals({ rounds = [], originalFiles = null, originalAdded = null, originalCodeAdded = null } = {}) {
  const reasons = [];
  const unknown = [];
  const evidence = {};
  const last = rounds.at(-1);
  const previous = rounds.at(-2);

  // A round marked `floor` holds a count that is a floor: a bot answer with no inline comment counts one, whatever it
  // holds (stages.mjs recordBot). A floor decides only what it still proves: the last round at least the previous
  // round's exact count is not converging, and an exact last round under the previous floor is converging. Anything
  // else cannot tell.
  let converging = null;
  const exact = (each) => each.floor !== true;
  const counted = last && previous && Number.isInteger(last.open) && Number.isInteger(previous.open);
  const decided = counted && (exact(last) && exact(previous) ? true : exact(previous) ? last.open >= previous.open : exact(last) && last.open < previous.open);
  if (decided) {
    converging = last.open < previous.open;
    evidence.converging = { round: last.round, open: last.open, previous_round: previous.round, previous_open: previous.open };
    if (!converging) reasons.push(`not converging: round ${last.round} left ${plural(last.open, 'open finding')}, round ${previous.round} left ${previous.open}`);
  } else unknown.push('converging');

  const itemized = rounds.filter((round) => Array.isArray(round.findings));
  let looping = null;
  if (itemized.length >= 2) {
    const loops = [];
    for (let k = 1; k < itemized.length; k += 1) {
      for (const finding of itemized[k].findings) {
        for (let j = 0; j < k; j += 1) {
          // A finding still there on the same head is not back after a fix: no fix came between.
          if (itemized[j].head && itemized[j].head === itemized[k].head) continue;
          const twin = itemized[j].findings.find((each) => twinMatch(finding, each));
          if (twin) {
            loops.push({ round: itemized[k].round, earlier_round: itemized[j].round, ...idOf(finding), file: finding.file ?? null, line: finding.line ?? null, title: finding.title ?? null, match: twinMatch(finding, twin) });
            break;
          }
        }
      }
    }
    looping = loops.length > 0;
    evidence.looping = loops.slice(0, 10);
    if (looping) {
      const [first] = loops;
      const where = first.file ? ` at ${first.file}${first.line ? `:${first.line}` : ''}` : '';
      // A finding is named by its id, never by its title: a reason can reach the pull request.
      reasons.push(`looping: ${plural(loops.length, 'finding')} came back after a fix, such as ${first.id ?? 'a finding with no id'}${where} in round ${first.round}, first in round ${first.earlier_round}`);
    }
  } else unknown.push('looping');

  const later = itemized.filter((round) => round !== rounds[0]);
  let drifting = null;
  if (Array.isArray(originalFiles) && later.length) {
    const original = new Set(originalFiles);
    const outside = later.flatMap((round) => round.findings.filter((finding) => typeof finding.file === 'string' && !original.has(finding.file)).map((finding) => ({ round: round.round, ...idOf(finding), file: finding.file, line: finding.line ?? null, title: finding.title ?? null })));
    drifting = outside.length > 0;
    evidence.drifting = outside.slice(0, 10);
    if (drifting) reasons.push(`drifting: ${plural(outside.length, 'finding')} after round ${rounds[0].round} sit outside the files the pull request first changed, such as ${outside[0].file}`);
  } else unknown.push('drifting');

  const fixes = rounds.map((round) => round.fix).filter(Boolean);
  let bloating = null;
  // Code growth is measured against the code the pull request first added, when known.
  const base = Number.isInteger(originalCodeAdded) ? originalCodeAdded : originalAdded;
  if (fixes.length && Number.isInteger(base)) {
    const all = fixes.reduce((total, fix) => total + (fix.added ?? 0), 0);
    const added = fixes.reduce((total, fix) => total + (fix.code_added ?? fix.added ?? 0), 0);
    const limit = Math.max(Math.ceil((base * BLOAT_PERCENT) / 100), BLOAT_MIN_LINES);
    bloating = added > limit;
    evidence.bloating = { fix_added: added, fix_added_all: all, original_added: base, limit };
    if (bloating) reasons.push(`bloating: the fixes since round ${rounds[0].round} added ${added} lines of code, past ${limit} (${BLOAT_PERCENT}% of the ${base} lines of code the pull request first added, and at least ${BLOAT_MIN_LINES})`);
  } else unknown.push('bloating');

  if (unknown.length === 4) reasons.push('no signal could be read from the round history, so nothing shows the review converging');
  return { converging, looping, drifting, bloating, unknown, evidence, reasons };
}

const sum = (changes) => changes.reduce((total, change) => total + (change.added ?? 0), 0);
const attempt = (read) => {
  try {
    return read();
  } catch {
    return null;
  }
};

// The round history `signals` reads, from git: each round's fix, the files and added lines of the pull request at its
// first round (merge base to that head), and its files now. A fix is how the pull request's own diff changed from one
// round's head to the next round's, or to `head` for the last: each head's diff from its merge base with the base tip,
// compared line by line per file. Lines the base branch gained are on neither side of either diff, so merging or
// rebasing on the base is no fix and no bloat, even in a file the pull request changes too. `added` counts the lines
// the later diff has that the earlier one did not; `removed` the reverse. Files review.ignore lists count nowhere. A
// commit git cannot read leaves its part null.
export function buildHistory({ root, rounds, baseTip, head, review = {} }) {
  const kept = (changes) => {
    const ignored = new Set(classify(changes, review).ignored);
    return changes.filter((change) => !ignored.has(change.file));
  };
  // The per-file added lines without prose files (review.nonBehaviour): what bloat counts.
  const code = (lines) => {
    const prose = new Set(classify(Object.keys(lines).map((file) => ({ file })), review).nonBehaviour);
    return Object.fromEntries(Object.entries(lines).filter(([file]) => !prose.has(file)));
  };
  const at = (ref) => (ref ? resolve(root, ref) : null);
  const first = at(rounds[0]?.head);
  const tip = at(baseTip);
  const now = at(head);
  const original = first && tip ? attempt(() => kept(changedFiles(root, mergeBase(root, tip, first), first))) : null;
  const proseFiles = new Set(original ? classify(original, review).nonBehaviour : []);
  const current = now && tip ? attempt(() => kept(changedFiles(root, mergeBase(root, tip, now), now))) : null;
  // The pull request's own added lines at one head, per file.
  const own = new Map();
  const ownAdded = (sha) => {
    if (!own.has(sha)) {
      own.set(sha, attempt(() => {
        const { addedLines } = diffLines(root, mergeBase(root, tip, sha), sha);
        const files = new Set(kept(Object.keys(addedLines).map((file) => ({ file }))).map((change) => change.file));
        return Object.fromEntries(Object.entries(addedLines).filter(([file]) => files.has(file)));
      }));
    }
    return own.get(sha);
  };
  const out = rounds.map((round, index) => {
    const from = at(round.head);
    const to = at(rounds[index + 1]?.head ?? head);
    let fix = null;
    if (from && to && from === to) fix = { added: 0, code_added: 0, removed: 0, files: [] };
    else if (from && to && tip) {
      const before = ownAdded(from);
      const after = ownAdded(to);
      if (before && after) fix = { ...ownDelta(before, after), code_added: ownDelta(code(before), code(after)).added };
    }
    return { ...round, fix };
  });
  return {
    rounds: out,
    originalFiles: original ? original.map((change) => change.file) : null,
    originalAdded: original ? sum(original) : null,
    originalCodeAdded: original ? sum(original.filter((change) => !proseFiles.has(change.file))) : null,
    files: current ? current.map((change) => change.file) : null,
  };
}

// How a pull request's added lines changed between two heads, per file, as multisets of line text.
export function ownDelta(before, after) {
  let added = 0;
  let removed = 0;
  const files = [];
  for (const file of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const left = new Map();
    for (const line of before[file] ?? []) left.set(line, (left.get(line) ?? 0) + 1);
    let gained = 0;
    for (const line of after[file] ?? []) {
      const count = left.get(line) ?? 0;
      if (count) left.set(line, count - 1);
      else gained += 1;
    }
    const lost = [...left.values()].reduce((total, count) => total + count, 0);
    if (gained || lost) files.push(file);
    added += gained;
    removed += lost;
  }
  return { added, removed, files: files.slice(0, MAX_FILES) };
}

// The review bot's rounds as a history: one round per bot review, oldest first, its findings the review's top-level
// inline comments, or a floor of one when a review that does not approve has none.
export function botRounds(reviews, reviewComments, reviewer) {
  return (reviews ?? [])
    .filter((review) => review?.user?.login === reviewer)
    .sort((a, b) => String(a.submitted_at ?? '').localeCompare(String(b.submitted_at ?? '')))
    .map((review, index) => {
      const findings = (reviewComments ?? [])
        .filter((comment) => comment.pull_request_review_id === review.id && !comment.in_reply_to_id)
        .map((comment) => ({ title: findingTitle(comment.body), file: comment.path ?? null, line: Number.isInteger(comment.line) ? comment.line : Number.isInteger(comment.original_line) ? comment.original_line : null }));
      // A review with no inline comment that does not approve holds its findings in its body: at least one, a floor
      // (stages.mjs recordBot), with no list to read for loops or drift. An approval with none is an exact zero.
      if (!findings.length && review.state !== 'APPROVED') return { round: index + 1, head: review.commit_id ?? null, open: 1, floor: true, findings: null };
      return { round: index + 1, head: review.commit_id ?? null, open: findings.length, findings };
    });
}

// The question `extension_ask` asks, and the options, for `aidrian pr review` and `aidrian pr extend` alike.
// lib/rules/review-extend.mjs reads the Human's answer by `#<PR>` and `round <N>`, so the question names no other
// round: an answer to it would approve that round too. `unreviewed` is the entry's { head }, when no round reviewed it.
// `flags`, the red flags' reasons, are named so the Human approves past them knowingly: by name only, so the question
// names no round but the one it grants.
// `repo` names the pull request's repository, `<owner>/<name>#<PR>`, which the review-extend rule binds the answer to.
export const askQuestion = (pr, round, unreviewed = null, flags = [], repo = null) => {
  const warn = flags?.length ? ` The round history raised red flags (${[...new Set(flags.map(flagName))].join(', ')}), and the judge still recommends one more round.` : '';
  const named = `${repo ?? ''}#${pr}`;
  return unreviewed?.head
    ? `Pull request ${named} reached its review-round cap, and its fix head ${String(unreviewed.head).slice(0, 7)} is reviewed by no pass.${warn} Grant one extra review round, round ${round}, to review that fix?`
    : `Pull request ${named} reached its review-round cap.${warn} Grant one extra review round, round ${round}?`;
};
export const askOptions = (round) => [`Approve round ${round}`, 'Deny'];

// What a `round_limit` carries for the Human, so the one question at the cap is the one the review-rounds rule
// (lib/rules/github/review-rounds.mjs) reads as the grant: `question` names `<owner>/<name>#<PR>` and `--max-rounds <N>`,
// the first of `options` starts with "Approve", and `raise` is the one command that answer approves, ending in
// `--repo <owner>/<name>` always, so it acts on the repository the question names, whatever the checkout's remotes. `<N>` allows one more round: the cap is the
// --max-rounds baseline plus the rounds `granted`, so it is `round + 1 - granted`. A second round needs a new answer.
// `source` "bot" raises `aidrian pr await-review --request`, else `aidrian pr review`, with `--with-bot` when the step
// ran the bot (`withBot`). Nothing without the repository: the rule needs it named.
export function raiseAsk({ pr, repo, source, round, granted = 0, withBot = false }) {
  if (!repo || !Number.isInteger(pr) || !Number.isInteger(round)) return {};
  const next = Math.max(1, round + 1 - granted);
  const bot = withBot ? ' --with-bot' : '';
  const step = source === 'bot' ? `aidrian pr await-review ${pr} --request` : `aidrian pr review ${pr}${bot}`;
  return {
    question: `Pull request ${repo}#${pr} reached its review-round cap. Allow one more review round, with --max-rounds ${next}?`,
    options: [`Approve one more round (--max-rounds ${next})`, 'Stop at the cap'],
    raise: `AIDRIAN_ALLOW_EXTRA_ROUNDS=1 ${step} --max-rounds ${next} --repo ${repo}`,
  };
}

const JUDGE_BRIEF =
  'Read-only. Decide whether this pull request earns one more review round past its cap. Read `extension.history` (each ' +
  "round's open findings, their files and lines, and each fix's size), `extension.files`, the goal in `extension.goal`, " +
  'and the code at the head. Answer each with evidence (path:line, round numbers): deviating, do the fixes stray from the ' +
  'goal; looping, do findings come back after their fix; over-engineering, do the fixes add more than the findings asked; ' +
  'and whether the open findings are valid and at least medium severity. Verdict `extend` only when none of the first three ' +
  'holds and at least one open finding is valid and at least medium; otherwise `stop`. ' +
  'When `extension.unreviewed_head` is set, no round has reviewed the head: it is a fix pushed after the last round, which ' +
  'reviewed `from`, and `fix` is its size. The last round\'s findings are what that fix answers, so against the head they ' +
  'can look fixed; judge them as that round saw them, at `from`. Then `extend` means "review this fix": verdict `extend` ' +
  'only when none of the first three holds, at least one of the last round\'s findings was valid and at least medium, and ' +
  'the fix is small and answers it; otherwise `stop`. ' +
  'When `extension.red_flags` is set, the round history raised those mechanical warnings: answer each one with evidence, ' +
  'saying whether it is real here or a false alarm (a doc reworded across rounds is normal review work, not bloat). An ' +
  '`extend` over a red flag goes to the Human, who decides. Record it with `record`, the reason naming the evidence.';

// What a judge weighs before `land`, at an `extension_check` or a `round_limit` alike.
const LAND_TEST =
  'Read every finding still open on the head, at the head\'s code, and its verdict from `aidrian pr disposition`. ' +
  'Verdict `land` only when every open finding is `accepted_residual`, `acceptable_as_is`, or `drop_unless_cited`, no ' +
  'flow has a `violated` or `unverified` invariant, the result has no `unreviewed_head`, and `aidrian pr checks <n>` is ' +
  'not failing. Give the evidence for each open finding: `path:line` at the head, the round that raised it, and its ' +
  'disposition. The session records `land` and `stop` with `--judge`, naming your agent id.';

// Added to JUDGE_BRIEF only when the step's `waiver` says a judge may rule on landing.
const LAND_BRIEF =
  '`waiver.may` is true: the team lets this pull request merge at the cap with its open findings filed, on your word. ' +
  'So a third verdict is open: `land`, the cap stands and the pull request may merge as it is. When no extra round is ' +
  `worth it, rule \`land\` or \`stop\`. ${LAND_TEST} The session records \`extend\` with \`record_extend\`, with no \`--judge\`.`;

// The brief of the one judge a `round_limit` dispatches when its `waiver` says one may rule: no check runs there.
const WAIVER_BRIEF =
  'Read-only. This pull request\'s review stopped at its round cap, and `waiver.may` is true: the team lets it merge with ' +
  `its open findings filed, on your word. Decide whether it may: \`land\` or \`stop\`. ${LAND_TEST}`;

export const WAIVER_PASS = 'waiver-judge';
const VERDICT_ARG = '--verdict extend|stop ';
const JUDGE_ARG = ' --judge <agent id>';

// Adds the step's `waiver` (waiver-stand.mjs offerWaiver) to a capped `result`, and, only when it says a judge may
// rule, the `land` verdict: to the check's judge at `extension_check`, or, at a `round_limit`, a dispatch of one judge
// for it. Its `record` is then the `land|stop` line, with `--judge`; at the check, `record_extend` is the `extend` line,
// with none, since parseExtend refuses `--judge` with `extend`. `repoArg` is the step's ` --repo <owner>/<name>` or ''.
// Returns `result`.
export function offerLand(result, waiver, repoArg = '') {
  result.waiver = waiver;
  if (waiver?.may !== true) return result;
  if (result.status === 'extension_check' && Array.isArray(result.dispatch) && result.dispatch[0]?.pass === JUDGE_PASS) {
    const [judge, ...rest] = result.dispatch;
    const record_extend = judge.record.replace(VERDICT_ARG, '--verdict extend ');
    result.dispatch = [{ ...judge, brief: `${judge.brief} ${LAND_BRIEF}`, record: `${judge.record.replace(VERDICT_ARG, '--verdict land|stop ')}${JUDGE_ARG}`, record_extend }, ...rest];
  } else if (result.status === 'round_limit' && typeof result.head === 'string') {
    result.dispatch = [{ pass: WAIVER_PASS, agent: JUDGE_AGENT, brief: WAIVER_BRIEF, record: `aidrian pr extend ${result.pr} --verdict land|stop --reason "<evidence>" --head ${result.head}${JUDGE_ARG}${repoArg}` }];
  }
  return result;
}

// Whether the head at the cap is one no round reviewed: `last`, the last round ({ head, fix }), is on another head.
// Notes it on the entry as { head, from }, or clears it, and returns { head, from, fix } for the judge, or null.
function noteUnreviewed(entry, last, head) {
  if (!head || !last?.head || sameCommit(last.head, head)) {
    delete entry.unreviewed;
    return null;
  }
  entry.unreviewed = { head, from: last.head };
  return { head, from: last.head, fix: last.reviewed_fix ?? last.fix ?? null };
}

const trimRound = (round) => ({
  ...round,
  findings: Array.isArray(round.findings) ? round.findings.slice(0, MAX_FINDINGS) : null,
  ...(Array.isArray(round.findings) && round.findings.length > MAX_FINDINGS ? { findings_cut: round.findings.length - MAX_FINDINGS } : {}),
});

// The dispatch-log row of one decision: names and counts, never the judge's reason text.
const rowOf = (entry) => ({ event: 'review_extension', source: entry.source, round: entry.round, outcome: entry.status, by: entry.by ?? null, signals: redSignals(entry.signals) });
const redSignals = (sig) => (sig ? ['converging', 'looping', 'drifting', 'bloating'].filter((name) => (name === 'converging' ? sig[name] === false : sig[name] === true)) : []);


const compactSignals = (sig) => ({ converging: sig.converging, looping: sig.looping, drifting: sig.drifting, bloating: sig.bloating, unknown: sig.unknown, evidence: sig.evidence });
// The decisions still open for a head: a check waiting for its judge or the Human, and a grant whose round has not
// opened yet. Each is bound to the head its signals were read on.
const PENDING = new Set(['judging', 'asking', 'granted']);

// A pending decision whose head is not `head` any more is re-read on the new head: a push after the judge's verdict
// can grow the fixes past the bloat limit, and the verdict and any approval were for the head before. A new red flag
// sends it back to the judge, a grant or a check waiting for the Human included. With no new red flag, a grant stands,
// as one round for the fix it was given for, and so does a check waiting for the Human, on the new head: the push is
// most often the very fix the extra round would review, and the Human's answer, given or still to come, records with
// no second judge run. Returns the entry, or null.
export function revalidate({ state, source, round, head, history, reviewer = null, log = () => {}, now = () => new Date().toISOString() }) {
  const entry = (state?.extensions ?? []).find((each) => each.source === source && each.round === round && sameReviewer(each, reviewer) && PENDING.has(each.status));
  if (!entry || !head || sameCommit(entry.head, head)) return entry ?? null;
  const read = history();
  const sig = signals(read);
  const before = entry.head;
  entry.head = head;
  entry.signals = compactSignals(sig);
  noteUnreviewed(entry, read.rounds?.at(-1), head);
  const decide = (status, by, reasons) => {
    Object.assign(entry, { status, by, reasons, decided_at: now() });
    log(rowOf(entry));
  };
  // Only a flag the decision was not made over is new: not converging or looping stays raised across the very push
  // a round was granted for, and the judge and the Human already weighed it.
  const known = new Set((entry.red_flags ?? []).map(flagName));
  const fresh = sig.reasons.filter((reason) => !known.has(flagName(reason)));
  entry.red_flags = sig.reasons;
  if (fresh.length) {
    if (entry.judge) entry.stale_judge = entry.judge;
    delete entry.judge;
    delete entry.human;
    decide('judging', null, [...fresh, `read again on ${String(head).slice(0, 7)}, pushed after the decision on ${String(before).slice(0, 7)}`]);
  }
  return entry;
}

// The decision at the cap, written into `state` (an entry of `state.extensions` per source, round, and for the bot,
// reviewer). Returns the
// status and what it carries: round_limit with `extension` (off, the ceiling, the judge, or the Human
// said stop), extension_check with the history and the judge's `dispatch`, or extension_ask with the question.
// `history` is a function, called only when the signals need reading. `lastReviewed`, when given, is a function that
// returns the head of the last round without git work: the record's rounds, or the bot's last review; a stop that reads
// no signals, the ceiling or one made on an earlier head, asks it whether the head now is one no round reviewed.
// `log(row)` gets each new decision. `reviewer` is the bot whose rounds the check reads, for the bot's cap; null for the
// plan's. `raise` overrides what the `round_limit` question is computed from (raiseAsk): the
// rounds of the cap that stopped, when that is not `round`, and `withBot`.
export function atCap({ state, source, round, head, policy, history: readHistory, lastReviewed = null, pr, repo = null, repoArg = '', goal = null, command, log = () => {}, now = () => new Date().toISOString(), raise = {}, reviewer = null }) {
  if (policy.mode === 'off') return { status: 'round_limit', extension: { status: 'off', mode: 'off' }, ...raiseAsk({ pr, repo, source, round, ...raise }) };
  let cached = null;
  const history = () => (cached ??= readHistory());
  const granted = grantedRounds(state, source, policy, reviewer);
  state.extensions ??= [];
  let entry = state.extensions.find((each) => each.source === source && each.round === round && sameReviewer(each, reviewer));
  const decide = (status, by, reasons = []) => {
    Object.assign(entry, { status, by, reasons, decided_at: now() });
    log(rowOf(entry));
  };
  if (entry) revalidate({ state, source, round, head, history, reviewer, log, now });
  else {
    entry = { source, round, head, ...(reviewer ? { reviewer } : {}), at: now(), mode: policy.mode, max: policy.max, granted_before: granted, status: 'new', by: null, reasons: [] };
    state.extensions.push(entry);
    if (granted >= policy.max) decide('stopped', 'ceiling', [`${plural(granted, 'extra round')} granted already, and github.maxExtraRounds is ${policy.max}`]);
  }
  // A stop an older version made on a red flag, with no way on: it goes to the judge as a red flag now does.
  // It goes the way a fresh check does: the ceiling first, and the judge without any verdict made on the old head.
  if (entry.status === 'stopped' && entry.by === 'mechanical') {
    if (entry.judge) entry.stale_judge = entry.judge;
    delete entry.judge;
    delete entry.human;
    if (granted >= policy.max) decide('stopped', 'ceiling', [`${plural(granted, 'extra round')} granted already, and github.maxExtraRounds is ${policy.max}`]);
    else decide('judging', null, []);
  }
  // A grant the policy does not count (the base branch moved from "auto" to "ask") waits for the Human again.
  if (entry.status === 'granted' && policy.mode === 'ask' && entry.human?.answer !== 'approve') entry.status = 'asking';
  // On "auto", a judge's extend needs no Human, unless a red flag stands.
  if (entry.status === 'asking' && policy.mode === 'auto' && !entry.red_flags?.length) decide('granted', 'judge', entry.reasons);
  let read = null;
  let unreviewed = null;
  if (entry.status === 'new' || entry.status === 'judging') {
    read = history();
    const sig = signals(read);
    entry.head = head;
    entry.signals = compactSignals(sig);
    unreviewed = noteUnreviewed(entry, read.rounds?.at(-1), head);
    // A red flag is evidence for the judge, never a stop with no way on.
    entry.red_flags = sig.reasons;
    if (entry.status === 'new') decide('judging', null, sig.reasons);
  } else if (entry.status !== 'asking' && (entry.by === 'ceiling' ? lastReviewed : !sameCommit(entry.head, head))) {
    // The ceiling, or a stop made on an earlier head and a push since: the stop stands, and the head it ends on may be
    // one no round reviewed. The ceiling reads no signals, so it asks only `lastReviewed`.
    noteUnreviewed(entry, { head: lastReviewed ? lastReviewed() : history().rounds?.at(-1)?.head }, head);
  }
  const summary = { round, status: entry.status, by: entry.by ?? null, reasons: entry.reasons ?? [], ...(entry.red_flags?.length ? { red_flags: entry.red_flags } : {}), mode: policy.mode, extra_granted: granted, max_extra: policy.max, signals: entry.signals ?? null, ...(entry.judge ? { judge: entry.judge } : {}) };
  if (entry.status === 'judging') {
    return {
      status: 'extension_check',
      extension: {
        ...summary,
        ...(unreviewed ? { unreviewed_head: unreviewed } : {}),
        history: read.rounds.map(trimRound),
        files: read.files?.slice(0, MAX_FILES) ?? null,
        original_files: read.originalFiles?.slice(0, MAX_FILES) ?? null,
        goal: goal ? { title: goal.title ?? null, body: typeof goal.body === 'string' ? goal.body.slice(0, MAX_BODY) : null } : null,
      },
      dispatch: [{
        pass: JUDGE_PASS,
        agent: JUDGE_AGENT,
        brief: JUDGE_BRIEF,
        record: `aidrian pr extend ${pr} ${VERDICT_ARG}--reason "<evidence>" --head ${head}${checkArg(entry)}${repoArg}`,
      }],
    };
  }
  if (entry.status === 'asking') {
    return {
      status: 'extension_ask',
      extension: summary,
      question: askQuestion(pr, round + 1, entry.unreviewed, entry.red_flags, repo),
      options: askOptions(round + 1),
      record: `aidrian pr extend ${pr} --human approve|deny${checkArg(entry)}${repoArg}`,
      then: command,
    };
  }
  // The cap stands on a head no round reviewed: said in the result, and in the summary comment's Extra rounds list.
  return { status: 'round_limit', extension: summary, ...(sameCommit(entry.unreviewed?.head, head) ? { unreviewed_head: true } : {}), ...raiseAsk({ pr, repo, source, round, granted, ...raise }) };
}

// ` --check '<id>'`, quoted for any shell: a login's brackets are a glob unquoted, and a quote in a configured reviewer
// stays inside the one argument.
const checkArg = (entry) => ` --check ${shellQuote(checkId(entry))}`;

// The entry that waits for `status` ("judging" or "asking"): the latest one, of the check `check` names when given.
// With none named, checks of two sources or reviewers that wait at once are refused: a verdict or an answer meant for one
// would land on the other.
export function waiting(state, status, check = null) {
  const all = (state?.extensions ?? []).filter((entry) => entry.status === status && (check === null || checkId(entry) === check));
  const ids = [...new Set(all.map(checkId))];
  if (check === null && ids.length > 1) {
    throw new Error(`checks ${ids.join(' and ')} both wait for ${status === 'judging' ? 'a verdict' : 'the Human'}: name the one with --check <id>`);
  }
  return all.at(-1) ?? null;
}

// A decision is for the head its signals were read on: refused when the pull request has moved since.
function sameHead(entry, current) {
  if (current !== undefined && current !== null && !sameCommit(current, entry.head)) {
    throw new Error(`the check was for ${String(entry.head).slice(0, 7)}, and the pull request is at ${String(current).slice(0, 7)} now: run the review step again, which reads the signals on the new head and, with no new red flag, keeps a question to the Human waiting, so the same answer then records here`);
  }
}

// The judge's verdict into `state`: stop and land end the check; extend grants on "auto" and asks the Human on "ask",
// or whenever a red flag stands.
// `current` is the pull request's head now, when known.
export function recordVerdict(state, { verdict, reason, head = null, current = null, check = null, at = new Date().toISOString() }) {
  const entry = waiting(state, 'judging', check);
  if (!entry) throw new Error('no extension check waits for a verdict: run the review step at the cap first');
  if (head !== null && !sameCommit(head, entry.head)) throw new Error(`the check was for ${String(entry.head).slice(0, 7)}, not ${head.slice(0, 7)}: run the review step again`);
  sameHead(entry, current);
  entry.judge = { verdict, reason, head: entry.head, at };
  // A `land` stops the check as `stop` does: the cap stands, and the waiver's verdict is recorded beside it (runLanding).
  if (verdict === 'stop' || verdict === 'land') Object.assign(entry, { status: 'stopped', by: 'judge', reasons: [reason], decided_at: at });
  else if (entry.mode === 'auto' && !entry.red_flags?.length) Object.assign(entry, { status: 'granted', by: 'judge', reasons: [reason], decided_at: at });
  else Object.assign(entry, { status: 'asking', by: 'judge', reasons: [reason], decided_at: at });
  return entry;
}

// The Human's answer into `state`. An approval needs `current`, the pull request's head now, to be the head the judge
// ruled on: a push since may have raised a red flag the approval would skip. A deny needs no head.
export function recordHuman(state, { answer, by, session = null, current, check = null, at = new Date().toISOString() }) {
  const entry = waiting(state, 'asking', check);
  if (!entry) throw new Error('no extension waits for the Human: a judge must first record --verdict extend under github.extraRounds "ask"');
  if (answer === 'approve') {
    if (!current) throw new Error('the pull request\'s head could not be read, so the approval cannot be tied to the head the judge ruled on: try again');
    sameHead(entry, current);
  }
  entry.human = { answer, by, at, session };
  Object.assign(entry, { status: answer === 'approve' ? 'granted' : 'denied', by: 'human', decided_at: at });
  return entry;
}

const SHA = /^[0-9a-f]{7,40}$/iu;

// `aidrian pr extend <PR> (--verdict extend|stop|land --reason TEXT [--head SHA] [--judge AGENT_ID] | --human
// approve|deny) [--check ID]`: `land` needs `--judge`, which `stop` may give and `extend` may not.
export function parseExtend(args) {
  const [ref, ...rest] = args;
  const match = /^#?(\d+)$/u.exec(ref ?? '') ?? /\/pull\/(\d+)/u.exec(ref ?? '');
  if (!match) throw new Error('extend needs a pull request number');
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (!['--verdict', '--reason', '--head', '--human', '--repo', '--check', '--judge'].includes(flag)) throw new Error(`unknown argument: ${flag}`);
    const value = rest[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    flags[flag.slice(2)] = value;
  }
  if ((flags.verdict === undefined) === (flags.human === undefined)) throw new Error('give exactly one of --verdict or --human');
  if (flags.verdict !== undefined) {
    if (!['extend', 'stop', 'land'].includes(flags.verdict)) throw new Error('--verdict must be extend, stop, or land');
    if (!flags.reason?.trim()) throw new Error('--verdict needs --reason with the evidence');
    if (flags.verdict === 'land' && flags.judge === undefined) throw new Error('--verdict land needs --judge with the judge\'s agent id');
    if (flags.verdict === 'extend' && flags.judge !== undefined) throw new Error('--judge goes with --verdict land or stop');
    if (flags.judge !== undefined && !JUDGE_ID.test(flags.judge)) throw new Error('--judge must be the judge\'s agent id, as the host returned it when the judge was dispatched');
  } else {
    if (!['approve', 'deny'].includes(flags.human)) throw new Error('--human must be approve or deny');
    if (flags.head !== undefined) throw new Error('--head goes with --verdict');
    if (flags.judge !== undefined) throw new Error('--judge goes with --verdict');
  }
  if (flags.head !== undefined && !SHA.test(flags.head)) throw new Error('--head must be a commit SHA');
  return { pr: Number(match[1]), verdict: flags.verdict ?? null, reason: flags.reason?.trim() ?? null, head: flags.head ?? null, human: flags.human ?? null, repo: flags.repo === undefined ? null : givenRepo(flags.repo), check: flags.check ?? null, judge: flags.judge ?? null };
}

// What to run after a recorded decision.
function nextStep(entry, pr, repo, repoArg = '') {
  const again = entry.source === 'bot' ? `aidrian pr await-review ${pr} --request${repoArg}` : `aidrian pr review ${pr}${repoArg}`;
  if (entry.status === 'granted') return `round ${entry.round + 1} is granted: run ${again}`;
  if (entry.status === 'asking') return `ask the Human "${askQuestion(pr, entry.round + 1, entry.unreviewed, entry.red_flags, repo)}" with the options ${askOptions(entry.round + 1).map((each) => `"${each}"`).join(' and ')}, then record the answer: aidrian pr extend ${pr} --human approve|deny${checkArg(entry)}${repoArg}`;
  return 'the cap stands: report round_limit and the findings left open';
}

// The CLI body. It reads and writes the record where the review step does: this machine's state folder and, unless the
// base branch's `review.record` is "local", the pull request's summary comment, so another machine continues from it.
// The pull request's repository is the one the review step acts on, and the Human's answer names: `--repo`, else the
// forge's (review-gate.mjs prRepo), else origin. Its head, its record, and its summary comment are all that one
// repository's, so in a fork checkout an approval never lands on the fork's pull request of the same number.
// `deps.forge` replaces the forge (change, conversationComments, postComment, editComment, viewer) and `deps.repo` the
// resolved repository, in tests.
export async function runExtend(args, project, config, deps = {}) {
  const opts = parseExtend(args);
  const { prRepo } = await import('../review-gate.mjs');
  const forge = deps.forge ?? forgeFor(undefined);
  const repo = deps.repo ?? prRepo(project, opts.pr, opts.repo, forge);
  // The pull request now: a decision is for the head its signals were read on, and the record is read only from the
  // state.dir its base branch commits. A forge that cannot answer, or names no base, leaves no base to hold to, so the
  // decision stays on this machine: nothing publishes.
  let view = null;
  try {
    view = forge.change(String(opts.pr), 'number,headRefOid,baseRefName,url,title,body', { repo });
  } catch {}
  const held = view?.baseRefName ? holdToBase(project, config, { repo, base: view.baseRefName }) : null;
  const current = view?.headRefOid ?? null;
  const onPr = held !== null && held.committed.review.record !== 'local';
  let comments = [];
  if (onPr) {
    try {
      comments = forge.conversationComments(repo, opts.pr);
    } catch {}
  }
  const record = readRecord(project, opts.pr, comments, repo, () => readReading(forge, repo, opts.pr));
  if (record.held !== undefined) throw new Error(heldMessage(opts.pr, record.held, record.why, record.finding));
  const { state } = record;
  const env = deps.env ?? process.env;
  if (opts.judge !== null) return runLanding({ opts, project, config, forge, repo, view, held, onPr, comments, state, local: record.local, env, gate: deps.gate ?? {} });
  let entry;
  if (opts.verdict) entry = recordVerdict(state, { verdict: opts.verdict, reason: opts.reason, head: opts.head, current, check: opts.check });
  else {
    const by = runGit(['config', 'user.name'], project.root).stdout.trim() || 'unknown';
    entry = recordHuman(state, { answer: opts.human, by, session: sessionIdentity(env).session, current, check: opts.check });
  }
  writeLocalState(project, state, { repo });
  const unposted = held === null ? 'the forge named no base branch, so nothing was posted' : null;
  const summaryError = onPr ? publishState(state, { comments: () => comments, post: (body) => forge.postComment(repo, opts.pr, body), edit: (id, body) => forge.editComment(repo, id, body), viewer: () => forge.viewer() }, `extension ${entry.status}`, postContext({ forge, repo, n: opts.pr, project, configs: [held.committed, config], env })) : unposted;
  try {
    appendEvent(project, config, { ...rowOf(entry), ts: stamp(Date.now()), session_id: sessionIdentity(env).session, pr: opts.pr, repo });
  } catch {}
  console.log(JSON.stringify({ status: 'recorded', pr: opts.pr, extension: { source: entry.source, round: entry.round, head: entry.head, status: entry.status, by: entry.by, reasons: entry.reasons }, next: nextStep(entry, opts.pr, repo, repoFlag(project, repo)), ...(summaryError ? { summary_error: summaryError } : {}) }, null, 2));
  return 0;
}

// `aidrian pr extend <PR> --verdict land|stop --judge <agent id>`: the judge the cap dispatched rules on landing too.
// A check that waits for its verdict is stopped, as `stop` stops it, and the outcome, `extension_check` on its head,
// becomes the `round_limit` it then is (waiver-stand.mjs asLanded). At a `round_limit` no check waits for. Then the
// waiver's verdict goes into the record through the writer `aidrian pr waive` uses (waiver.mjs appendVerdict), naming
// the judge: `waive` for `land`, only once the gate `aidrian pr waive --gate` runs (waiver-stand.mjs readGate) says a
// judge may rule on this very record and head, and `refuse` for `stop`, so one judge rules per head. Any refusal writes
// nothing.
async function runLanding({ opts, project, config, forge, repo, view, held, onPr, comments, state, local, env, gate }) {
  const current = view?.headRefOid ?? null;
  if (typeof current !== 'string' || !SHA_REF.test(current)) throw new Error('cannot read the pull request\'s head: a verdict binds to one head');
  if (opts.head !== null && !sameCommit(opts.head, current)) throw new Error(`the pull request's head is ${current.slice(0, 7)}, not ${opts.head.slice(0, 7)}: the verdict binds to the current head`);
  // `local` is this machine's record file of the read `state` was built from: the write below is refused when the file
  // changed since (sameRevision), and its owed entries are kept.
  state.pending = mergePending(local?.pending, state.pending);
  const check = waiting(state, 'judging', opts.check);
  let entry = null;
  if (check) {
    if (check.source !== 'plan') throw new Error(`the check waiting for a verdict is the review bot's (${checkId(check)}): only the review step's check takes --judge`);
    entry = recordVerdict(state, { verdict: opts.verdict, reason: opts.reason, head: opts.head, current, check: opts.check });
    const outcome = state.outcome ?? null;
    if (outcome?.status !== 'extension_check' || !sameCommit(outcome.head, current)) {
      throw new Error(`the review step's outcome on #${opts.pr} is ${outcome?.status ?? 'none'}${outcome?.head ? ` on ${String(outcome.head).slice(0, 7)}` : ''}, not the check at the cap on ${current.slice(0, 7)}: run the review step again`);
    }
    state.outcome = asLanded(state).outcome;
  }
  if (opts.verdict === 'land') {
    const said = readGate({ pr: opts.pr, repo }, project, { forge, config, ...gate, record: () => state });
    if (said.code === 3) throw new Error(said.error);
    if (!said.may) throw new Error(`the unattended waiver may not land #${opts.pr}: ${said.why}`);
    if (!sameCommit(said.head, current)) throw new Error(`the pull request moved to ${said.head.slice(0, 7)} while the verdict was recorded: run the review step again`);
  }
  const waiver = appendVerdict(state, { project, config, pr: opts.pr, head: current, verdict: opts.verdict === 'land' ? 'waive' : 'refuse', reason: opts.reason, judge: opts.judge, env });
  sameRevision(project, opts.pr, repo, local);
  writeLocalState(project, state, { repo });
  const unposted = held === null ? 'the forge named no base branch, so nothing was posted' : null;
  const summaryError = onPr ? publishState(state, { comments: () => comments, post: (body) => forge.postComment(repo, opts.pr, body), edit: (id, body) => forge.editComment(repo, id, body), viewer: () => forge.viewer() }, `extension ${opts.verdict}`, postContext({ forge, repo, n: opts.pr, project, configs: [held.committed, config], env })) : unposted;
  if (entry) {
    try {
      appendEvent(project, config, { ...rowOf(entry), ts: stamp(Date.now()), session_id: sessionIdentity(env).session, pr: opts.pr, repo });
    } catch {}
  }
  const next = opts.verdict === 'land'
    ? `${verdictNext(waiver, opts.pr, project.paths.local)}; run no review step on this head first: a new step's outcome comes after the verdict, and the verdict no longer stands`
    : 'the cap stands: report round_limit, the judge\'s evidence, and the findings left open';
  const extension = entry ? { source: entry.source, round: entry.round, head: entry.head, status: entry.status, by: entry.by, reasons: entry.reasons } : null;
  console.log(JSON.stringify({ status: 'recorded', pr: opts.pr, extension, waiver, next, ...(summaryError ? { summary_error: summaryError } : {}) }, null, 2));
  return 0;
}

// The dispatch-log row writer the review commands share.
export const extensionLogger = (project, config, { pr, repo, env = process.env }) => (row) => {
  try {
    appendEvent(project, config, { ...row, ts: stamp(Date.now()), session_id: sessionIdentity(env).session, pr, repo });
  } catch {}
};
