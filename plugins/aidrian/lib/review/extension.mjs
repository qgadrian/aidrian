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
//
// Each decision is an entry in the review record (lib/review/state.mjs) and a `review_extension` row in the dispatch
// log. docs/review.md#extra-rounds describes it.

import { appendEvent, stamp } from '../dispatch-log.mjs';
import { forgeFor } from '../forges/index.mjs';
import { runGit } from '../git.mjs';
import { sessionIdentity } from '../hosts/index.mjs';
import { changedFiles, diffLines, mergeBase, resolve } from './diff.mjs';
import { holdToBase } from './in-force.mjs';
import { classify } from './plan.mjs';
import { postContext } from './dispatch.mjs';
// One reading of a red flag, a full reason or the bare name a posted copy keeps (publish.mjs flagName).
import { flagName } from './publish.mjs';
import { isFindingId, twinMatch } from './findings.mjs';
import { heldMessage, publishState, readRecord, sameCommit, writeLocalState } from './state.mjs';

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

const entriesOf = (state, source) => (state.extensions ?? []).filter((entry) => entry.source === source);

// The extra rounds the base branch's policy lets count: each granted entry, once its mode allows it ("auto" takes the
// judge's word, "ask" needs the Human's approval), up to the ceiling. "off" counts none.
export function grantedRounds(state, source, policy) {
  if (!state || policy.mode === 'off') return 0;
  const granted = entriesOf(state, source).filter((entry) => entry.status === 'granted' && (policy.mode === 'auto' || entry.human?.answer === 'approve'));
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
// `rounds`: [{ round, head, open, findings: [{ title, file, line }] | null, fix: { added, code_added, removed, files } | null }],
// where `fix` is the change from that round's head to the next round's, or to the current head for the last, and
// `code_added` the lines of `added` outside prose files. Bloat counts `code_added` when it is there.
export function signals({ rounds = [], originalFiles = null, originalAdded = null, originalCodeAdded = null } = {}) {
  const reasons = [];
  const unknown = [];
  const evidence = {};
  const last = rounds.at(-1);
  const previous = rounds.at(-2);

  let converging = null;
  if (last && previous && Number.isInteger(last.open) && Number.isInteger(previous.open)) {
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
// inline comments.
export function botRounds(reviews, reviewComments, reviewer) {
  return (reviews ?? [])
    .filter((review) => review?.user?.login === reviewer)
    .sort((a, b) => String(a.submitted_at ?? '').localeCompare(String(b.submitted_at ?? '')))
    .map((review, index) => {
      const findings = (reviewComments ?? [])
        .filter((comment) => comment.pull_request_review_id === review.id && !comment.in_reply_to_id)
        .map((comment) => ({ title: findingTitle(comment.body), file: comment.path ?? null, line: Number.isInteger(comment.line) ? comment.line : Number.isInteger(comment.original_line) ? comment.original_line : null }));
      return { round: index + 1, head: review.commit_id ?? null, open: findings.length, findings };
    });
}

// The question `extension_ask` asks, and the options, for `aidrian pr review` and `aidrian pr extend` alike.
// lib/rules/review-extend.mjs reads the Human's answer by `#<PR>` and `round <N>`, so the question names no other
// round: an answer to it would approve that round too. `unreviewed` is the entry's { head }, when no round reviewed it.
// `flags`, the red flags' reasons, are named so the Human approves past them knowingly: by name only, so the question
// names no round but the one it grants.
export const askQuestion = (pr, round, unreviewed = null, flags = []) => {
  const warn = flags?.length ? ` The round history raised red flags (${[...new Set(flags.map(flagName))].join(', ')}), and the judge still recommends one more round.` : '';
  return unreviewed?.head
    ? `Pull request #${pr} reached its review-round cap, and its fix head ${String(unreviewed.head).slice(0, 7)} is reviewed by no pass.${warn} Grant one extra review round, round ${round}, to review that fix?`
    : `Pull request #${pr} reached its review-round cap.${warn} Grant one extra review round, round ${round}?`;
};
export const askOptions = (round) => [`Approve round ${round}`, 'Deny'];

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
// sends it back to the judge, a grant included, and so does a check waiting for the Human: the judge has not seen
// the push. A grant with no new red flag stands, as one round for the fix it was given for. Returns the entry, or null.
export function revalidate({ state, source, round, head, history, log = () => {}, now = () => new Date().toISOString() }) {
  const entry = (state?.extensions ?? []).find((each) => each.source === source && each.round === round && PENDING.has(each.status));
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
  if (fresh.length || entry.status === 'asking') {
    if (entry.judge) entry.stale_judge = entry.judge;
    delete entry.judge;
    delete entry.human;
    decide('judging', null, fresh.length ? [...fresh, `read again on ${String(head).slice(0, 7)}, pushed after the decision on ${String(before).slice(0, 7)}`] : []);
  }
  return entry;
}

// The decision at the cap, written into `state` (an entry of `state.extensions` per source and round). Returns the
// status and what it carries: round_limit with `extension` (off, the ceiling, the judge, or the Human
// said stop), extension_check with the history and the judge's `dispatch`, or extension_ask with the question.
// `history` is a function, called only when the signals need reading. `lastReviewed`, when given, is a function that
// returns the head of the last round without git work: the record's rounds, or the bot's last review; a stop that reads
// no signals, the ceiling or one made on an earlier head, asks it whether the head now is one no round reviewed.
// `log(row)` gets each new decision.
export function atCap({ state, source, round, head, policy, history: readHistory, lastReviewed = null, pr, goal = null, command, log = () => {}, now = () => new Date().toISOString() }) {
  if (policy.mode === 'off') return { status: 'round_limit', extension: { status: 'off', mode: 'off' } };
  let cached = null;
  const history = () => (cached ??= readHistory());
  const granted = grantedRounds(state, source, policy);
  state.extensions ??= [];
  let entry = state.extensions.find((each) => each.source === source && each.round === round);
  const decide = (status, by, reasons = []) => {
    Object.assign(entry, { status, by, reasons, decided_at: now() });
    log(rowOf(entry));
  };
  if (entry) revalidate({ state, source, round, head, history, log, now });
  else {
    entry = { source, round, head, at: now(), mode: policy.mode, max: policy.max, granted_before: granted, status: 'new', by: null, reasons: [] };
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
        record: `aidrian pr extend ${pr} --verdict extend|stop --reason "<evidence>" --head ${head}`,
      }],
    };
  }
  if (entry.status === 'asking') {
    return {
      status: 'extension_ask',
      extension: summary,
      question: askQuestion(pr, round + 1, entry.unreviewed, entry.red_flags),
      options: askOptions(round + 1),
      record: `aidrian pr extend ${pr} --human approve|deny`,
      then: command,
    };
  }
  // The cap stands on a head no round reviewed: said in the result, and in the summary comment's Extra rounds list.
  return { status: 'round_limit', extension: summary, ...(sameCommit(entry.unreviewed?.head, head) ? { unreviewed_head: true } : {}) };
}

// The entry that waits for `status` ("judging" or "asking"): the latest one.
export const waiting = (state, status) => (state?.extensions ?? []).filter((entry) => entry.status === status).at(-1) ?? null;

// A decision is for the head its signals were read on: refused when the pull request has moved since.
function sameHead(entry, current) {
  if (current !== undefined && current !== null && !sameCommit(current, entry.head)) {
    throw new Error(`the check was for ${String(entry.head).slice(0, 7)}, and the pull request is at ${String(current).slice(0, 7)} now: run the review step again, which reads the signals on the new head`);
  }
}

// The judge's verdict into `state`: stop ends the check; extend grants on "auto" and asks the Human on "ask", or
// whenever a red flag stands.
// `current` is the pull request's head now, when known.
export function recordVerdict(state, { verdict, reason, head = null, current = null, at = new Date().toISOString() }) {
  const entry = waiting(state, 'judging');
  if (!entry) throw new Error('no extension check waits for a verdict: run the review step at the cap first');
  if (head !== null && !sameCommit(head, entry.head)) throw new Error(`the check was for ${String(entry.head).slice(0, 7)}, not ${head.slice(0, 7)}: run the review step again`);
  sameHead(entry, current);
  entry.judge = { verdict, reason, head: entry.head, at };
  if (verdict === 'stop') Object.assign(entry, { status: 'stopped', by: 'judge', reasons: [reason], decided_at: at });
  else if (entry.mode === 'auto' && !entry.red_flags?.length) Object.assign(entry, { status: 'granted', by: 'judge', reasons: [reason], decided_at: at });
  else Object.assign(entry, { status: 'asking', by: 'judge', reasons: [reason], decided_at: at });
  return entry;
}

// The Human's answer into `state`. An approval needs `current`, the pull request's head now, to be the head the judge
// ruled on: a push since may have raised a red flag the approval would skip. A deny needs no head.
export function recordHuman(state, { answer, by, session = null, current, at = new Date().toISOString() }) {
  const entry = waiting(state, 'asking');
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

// `aidrian pr extend <PR> (--verdict extend|stop --reason TEXT [--head SHA] | --human approve|deny)`.
export function parseExtend(args) {
  const [ref, ...rest] = args;
  const match = /^#?(\d+)$/u.exec(ref ?? '') ?? /\/pull\/(\d+)/u.exec(ref ?? '');
  if (!match) throw new Error('extend needs a pull request number');
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (!['--verdict', '--reason', '--head', '--human'].includes(flag)) throw new Error(`unknown argument: ${flag}`);
    const value = rest[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    flags[flag.slice(2)] = value;
  }
  if ((flags.verdict === undefined) === (flags.human === undefined)) throw new Error('give exactly one of --verdict or --human');
  if (flags.verdict !== undefined) {
    if (!['extend', 'stop'].includes(flags.verdict)) throw new Error('--verdict must be extend or stop');
    if (!flags.reason?.trim()) throw new Error('--verdict needs --reason with the evidence');
  } else {
    if (!['approve', 'deny'].includes(flags.human)) throw new Error('--human must be approve or deny');
    if (flags.head !== undefined) throw new Error('--head goes with --verdict');
  }
  if (flags.head !== undefined && !SHA.test(flags.head)) throw new Error('--head must be a commit SHA');
  return { pr: Number(match[1]), verdict: flags.verdict ?? null, reason: flags.reason?.trim() ?? null, head: flags.head ?? null, human: flags.human ?? null };
}

// What to run after a recorded decision.
function nextStep(entry, pr) {
  const again = entry.source === 'bot' ? `aidrian pr await-review ${pr} --request` : `aidrian pr review ${pr}`;
  if (entry.status === 'granted') return `round ${entry.round + 1} is granted: run ${again}`;
  if (entry.status === 'asking') return `ask the Human "${askQuestion(pr, entry.round + 1, entry.unreviewed, entry.red_flags)}" with the options ${askOptions(entry.round + 1).map((each) => `"${each}"`).join(' and ')}, then record the answer: aidrian pr extend ${pr} --human approve|deny`;
  return 'the cap stands: report round_limit and the findings left open';
}

// The CLI body. It reads and writes the record where the review step does: this machine's state folder and, unless the
// base branch's `review.record` is "local", the pull request's summary comment, so another machine continues from it.
// `deps.forge` replaces the forge (change, conversationComments, postComment, editComment, viewer) and `deps.repo` the origin,
// in tests.
export async function runExtend(args, project, config, deps = {}) {
  const opts = parseExtend(args);
  const { originRepo } = await import('../review-gate.mjs');
  const forge = deps.forge ?? forgeFor(undefined);
  const repo = deps.repo ?? originRepo(project);
  // The pull request now: a decision is for the head its signals were read on, and the record is read only from the
  // state.dir its base branch commits. A forge that cannot answer, or names no base, leaves no base to hold to, so the
  // decision stays on this machine: nothing publishes.
  let view = null;
  try {
    view = forge.change(String(opts.pr), 'number,headRefOid,baseRefName,url,title,body');
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
  const record = readRecord(project, opts.pr, comments, repo);
  if (record.held !== undefined) throw new Error(heldMessage(opts.pr, record.held, record.why));
  const { state } = record;
  const env = deps.env ?? process.env;
  let entry;
  if (opts.verdict) entry = recordVerdict(state, { verdict: opts.verdict, reason: opts.reason, head: opts.head, current });
  else {
    const by = runGit(['config', 'user.name'], project.root).stdout.trim() || 'unknown';
    entry = recordHuman(state, { answer: opts.human, by, session: sessionIdentity(env).session, current });
  }
  writeLocalState(project, state);
  const unposted = held === null ? 'the forge named no base branch, so nothing was posted' : null;
  const summaryError = onPr ? publishState(state, { comments: () => comments, post: (body) => forge.postComment(repo, opts.pr, body), edit: (id, body) => forge.editComment(repo, id, body), viewer: () => forge.viewer() }, `extension ${entry.status}`, postContext({ forge, repo, n: opts.pr, project, configs: [held.committed, config], env })) : unposted;
  try {
    appendEvent(project, config, { ...rowOf(entry), ts: stamp(Date.now()), session_id: sessionIdentity(env).session, pr: opts.pr, repo });
  } catch {}
  console.log(JSON.stringify({ status: 'recorded', pr: opts.pr, extension: { source: entry.source, round: entry.round, head: entry.head, status: entry.status, by: entry.by, reasons: entry.reasons }, next: nextStep(entry, opts.pr), ...(summaryError ? { summary_error: summaryError } : {}) }, null, 2));
  return 0;
}

// The dispatch-log row writer the review commands share.
export const extensionLogger = (project, config, { pr, repo, env = process.env }) => (row) => {
  try {
    appendEvent(project, config, { ...row, ts: stamp(Date.now()), session_id: sessionIdentity(env).session, pr, repo });
  } catch {}
};
