// Extra review rounds past config.json `github.maxReviewRounds`. At the cap, `aidrian pr review` and
// `aidrian pr await-review --request` ask whether one more round is worth it instead of stopping outright:
//
//   1. The policy is the base branch's: `github.extraRounds` ("off", "ask", "auto") and `github.maxExtraRounds`, the hard
//      ceiling on grants. "off", or the ceiling reached, is round_limit as before.
//   2. Mechanical signals from the round history, computed here: converging (fewer open findings than the round before),
//      looping (a finding back at the same place or under the same title after a fix), drifting (a finding outside the
//      files the pull request first changed), bloating (fix commits adding more than BLOAT_PERCENT of the pull request's
//      first diff). Any red flag stops: round_limit, with the reasons.
//   3. Otherwise `extension_check` dispatches a read-only judge; `aidrian pr extend <PR> --verdict extend|stop` records
//      its word. "auto" grants on extend; "ask" returns `extension_ask` until the Human answers, recorded with
//      `aidrian pr extend <PR> --human approve|deny` (lib/rules/review-extend.mjs guards the approval).
//   4. A grant is one round. The next cap repeats the check.
//
// Each decision is an entry in the review record (lib/review/state.mjs) and a `review_extension` row in the dispatch
// log. docs/review.md#extra-rounds describes it.

import { appendEvent, stamp } from '../dispatch-log.mjs';
import { runGit } from '../git.mjs';
import { changedFiles, mergeBase, resolve } from './diff.mjs';
import { classify } from './plan.mjs';
import { emptyState, isSummary, newer, publishState, readLocalState, stateFromComment, writeLocalState } from './state.mjs';

export const MODES = Object.freeze(['off', 'ask', 'auto']);
// Fix commits that add more than this share of the lines the pull request first added are the change growing under
// review, not converging. Below BLOAT_MIN_LINES the share says nothing: a ten-line change may need a ten-line fix.
export const BLOAT_PERCENT = 50;
export const BLOAT_MIN_LINES = 40;
// Two findings this many lines apart in one file are at the same place, as split reviews dedupe them.
export const NEAR_LINES = 3;
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

// A finding's title as words: no markup, badges, links, or case, words of four letters or more, sorted. Two titles that
// differ only in wording order or markup are the same title.
export function normalizeTitle(title) {
  if (typeof title !== 'string') return '';
  const plain = title
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/<[^>]*>/gu, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, ' ');
  return [...new Set(plain.split(/\s+/u).filter((word) => word.length > 3))].sort().join(' ');
}

// The title of a review bot's inline comment: its first line with words, without badges and markup.
export function findingTitle(body) {
  if (typeof body !== 'string') return null;
  for (const line of body.split('\n')) {
    const text = line.replace(/!\[[^\]]*\]\([^)]*\)/gu, '').replace(/<[^>]*>/gu, '').replace(/[*_`#>]/gu, '').trim();
    if (/\p{L}/u.test(text)) return text.slice(0, 200);
  }
  return null;
}

const samePlace = (a, b) => typeof a.file === 'string' && a.file === b.file && Number.isInteger(a.line) && Number.isInteger(b.line) && Math.abs(a.line - b.line) <= NEAR_LINES;
const sameTitle = (a, b) => {
  const title = normalizeTitle(a.title);
  return title !== '' && title === normalizeTitle(b.title);
};
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// The mechanical signals of a round history: { converging, looping, drifting, bloating, unknown, evidence, reasons }.
// Each signal is true, false, or null when the history cannot tell. `reasons` lists every red flag; any stops the
// extension. A history from which no signal can be read stops too: nothing in it shows the review converging.
// `rounds`: [{ round, head, open, findings: [{ title, file, line }] | null, fix: { added, removed, files } | null }],
// where `fix` is the change from that round's head to the next round's, or to the current head for the last.
export function signals({ rounds = [], originalFiles = null, originalAdded = null } = {}) {
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
          const twin = itemized[j].findings.find((each) => samePlace(finding, each) || sameTitle(finding, each));
          if (twin) {
            loops.push({ round: itemized[k].round, earlier_round: itemized[j].round, file: finding.file ?? null, line: finding.line ?? null, title: finding.title ?? null, match: samePlace(finding, twin) ? 'place' : 'title' });
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
      reasons.push(`looping: ${plural(loops.length, 'finding')} came back after a fix, such as "${first.title ?? 'untitled'}"${where} in round ${first.round}, first in round ${first.earlier_round}`);
    }
  } else unknown.push('looping');

  const later = itemized.filter((round) => round !== rounds[0]);
  let drifting = null;
  if (Array.isArray(originalFiles) && later.length) {
    const original = new Set(originalFiles);
    const outside = later.flatMap((round) => round.findings.filter((finding) => typeof finding.file === 'string' && !original.has(finding.file)).map((finding) => ({ round: round.round, file: finding.file, line: finding.line ?? null, title: finding.title ?? null })));
    drifting = outside.length > 0;
    evidence.drifting = outside.slice(0, 10);
    if (drifting) reasons.push(`drifting: ${plural(outside.length, 'finding')} after round ${rounds[0].round} sit outside the files the pull request first changed, such as ${outside[0].file}`);
  } else unknown.push('drifting');

  const fixes = rounds.map((round) => round.fix).filter(Boolean);
  let bloating = null;
  if (fixes.length && Number.isInteger(originalAdded)) {
    const added = fixes.reduce((total, fix) => total + (fix.added ?? 0), 0);
    const limit = Math.max(Math.ceil((originalAdded * BLOAT_PERCENT) / 100), BLOAT_MIN_LINES);
    bloating = added > limit;
    evidence.bloating = { fix_added: added, original_added: originalAdded, limit };
    if (bloating) reasons.push(`bloating: the fixes since round ${rounds[0].round} added ${added} lines, past ${limit} (${BLOAT_PERCENT}% of the ${originalAdded} lines the pull request first added, and at least ${BLOAT_MIN_LINES})`);
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

// The round history `signals` reads, from git: each round's fix (its head to the next round's, or to `head`), the
// files and added lines of the pull request at its first round (merge base to that head), and its files now. Files
// review.ignore lists count nowhere, and a fix counts only the pull request's own files, so merging the base branch in
// is no bloat. A commit git cannot read leaves its part null.
export function buildHistory({ root, rounds, baseTip, head, review = {} }) {
  const kept = (changes) => {
    const ignored = new Set(classify(changes, review).ignored);
    return changes.filter((change) => !ignored.has(change.file));
  };
  const at = (ref) => (ref ? resolve(root, ref) : null);
  const first = at(rounds[0]?.head);
  const tip = at(baseTip);
  const now = at(head);
  const original = first && tip ? attempt(() => kept(changedFiles(root, mergeBase(root, tip, first), first))) : null;
  const current = now && tip ? attempt(() => kept(changedFiles(root, mergeBase(root, tip, now), now))) : null;
  const scope = new Set([...(original ?? []), ...(current ?? [])].map((change) => change.file));
  const out = rounds.map((round, index) => {
    const from = at(round.head);
    const to = at(rounds[index + 1]?.head ?? head);
    let fix = null;
    if (from && to) {
      fix = from === to ? { added: 0, removed: 0, files: [] } : attempt(() => {
        const changes = kept(changedFiles(root, from, to)).filter((change) => scope.size === 0 || scope.has(change.file));
        return { added: sum(changes), removed: changes.reduce((total, change) => total + (change.removed ?? 0), 0), files: changes.map((change) => change.file).slice(0, MAX_FILES) };
      });
    }
    return { ...round, fix };
  });
  return {
    rounds: out,
    originalFiles: original ? original.map((change) => change.file) : null,
    originalAdded: original ? sum(original) : null,
    files: current ? current.map((change) => change.file) : null,
  };
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

// The question `extension_ask` asks, and the options. lib/rules/review-extend.mjs reads the Human's answer by these words.
export const askQuestion = (pr, round) => `Pull request #${pr} reached its review-round cap. Grant one extra review round, round ${round}?`;
export const askOptions = (round) => [`Approve round ${round}`, 'Deny'];

const JUDGE_BRIEF =
  'Read-only. Decide whether this pull request earns one more review round past its cap. Read `extension.history` (each ' +
  "round's open findings, their files and lines, and each fix's size), `extension.files`, the goal in `extension.goal`, " +
  'and the code at the head. Answer each with evidence (path:line, round numbers): deviating, do the fixes stray from the ' +
  'goal; looping, do findings come back after their fix; over-engineering, do the fixes add more than the findings asked; ' +
  'and whether the open findings are valid and at least medium severity. Verdict `extend` only when none of the first three ' +
  'holds and at least one open finding is valid and at least medium; otherwise `stop`. Record it with `record`, the reason ' +
  'naming the evidence.';

const trimRound = (round) => ({
  ...round,
  findings: Array.isArray(round.findings) ? round.findings.slice(0, MAX_FINDINGS) : null,
  ...(Array.isArray(round.findings) && round.findings.length > MAX_FINDINGS ? { findings_cut: round.findings.length - MAX_FINDINGS } : {}),
});

// The dispatch-log row of one decision: names and counts, never the judge's reason text.
const rowOf = (entry) => ({ event: 'review_extension', source: entry.source, round: entry.round, outcome: entry.status, by: entry.by ?? null, signals: redSignals(entry.signals) });
const redSignals = (sig) => (sig ? ['converging', 'looping', 'drifting', 'bloating'].filter((name) => (name === 'converging' ? sig[name] === false : sig[name] === true)) : []);

// Two spellings of one commit: equal, or one a prefix of the other, at least 7 hex long.
const sameCommit = (a, b) => typeof a === 'string' && typeof b === 'string' && (a === b || (Math.min(a.length, b.length) >= 7 && (a.startsWith(b) || b.startsWith(a))));

const compactSignals = (sig) => ({ converging: sig.converging, looping: sig.looping, drifting: sig.drifting, bloating: sig.bloating, unknown: sig.unknown, evidence: sig.evidence });
// The decisions still open for a head: a check waiting for its judge or the Human, and a grant whose round has not
// opened yet. Each is bound to the head its signals were read on.
const PENDING = new Set(['judging', 'asking', 'granted']);

// A pending decision whose head is not `head` any more is re-read on the new head: a push after the judge's verdict
// can grow the fixes past the bloat limit, and the verdict and any approval were for the head before. A new red flag
// stops it, a grant included. A check waiting for the Human goes back to the judge, who has not seen the push; a
// grant without a red flag stands, as one round for the fix it was given for. Returns the entry, or null.
export function revalidate({ state, source, round, head, history, log = () => {}, now = () => new Date().toISOString() }) {
  const entry = (state?.extensions ?? []).find((each) => each.source === source && each.round === round && PENDING.has(each.status));
  if (!entry || !head || sameCommit(entry.head, head)) return entry ?? null;
  const sig = signals(history());
  const before = entry.head;
  entry.head = head;
  entry.signals = compactSignals(sig);
  const decide = (status, by, reasons) => {
    Object.assign(entry, { status, by, reasons, decided_at: now() });
    log(rowOf(entry));
  };
  if (sig.reasons.length) decide('stopped', 'mechanical', [...sig.reasons, `read again on ${String(head).slice(0, 7)}, pushed after the decision on ${String(before).slice(0, 7)}`]);
  else if (entry.status === 'asking') {
    entry.stale_judge = entry.judge;
    delete entry.judge;
    decide('judging', null, []);
  }
  return entry;
}

// The decision at the cap, written into `state` (an entry of `state.extensions` per source and round). Returns the
// status and what it carries: round_limit with `extension` (off, the ceiling, the signals, the judge, or the Human
// said stop), extension_check with the history and the judge's `dispatch`, or extension_ask with the question.
// `history` is a function, called only when the signals need reading. `log(row)` gets each new decision.
export function atCap({ state, source, round, head, policy, history: readHistory, pr, goal = null, command, log = () => {}, now = () => new Date().toISOString() }) {
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
  // A grant the policy does not count (the base branch moved from "auto" to "ask") waits for the Human again.
  if (entry.status === 'granted' && policy.mode === 'ask' && entry.human?.answer !== 'approve') entry.status = 'asking';
  // On "auto", a judge's extend needs no Human.
  if (entry.status === 'asking' && policy.mode === 'auto') decide('granted', 'judge', entry.reasons);
  let read = null;
  if (entry.status === 'new' || entry.status === 'judging') {
    read = history();
    const sig = signals(read);
    entry.head = head;
    entry.signals = compactSignals(sig);
    if (sig.reasons.length) decide('stopped', 'mechanical', sig.reasons);
    else if (entry.status === 'new') decide('judging', null);
  }
  const summary = { round, status: entry.status, by: entry.by ?? null, reasons: entry.reasons ?? [], mode: policy.mode, extra_granted: granted, max_extra: policy.max, signals: entry.signals ?? null, ...(entry.judge ? { judge: entry.judge } : {}) };
  if (entry.status === 'judging') {
    return {
      status: 'extension_check',
      extension: {
        ...summary,
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
      question: askQuestion(pr, round + 1),
      options: askOptions(round + 1),
      record: `aidrian pr extend ${pr} --human approve|deny`,
      then: command,
    };
  }
  return { status: 'round_limit', extension: summary };
}

// The entry that waits for `status` ("judging" or "asking"): the latest one.
export const waiting = (state, status) => (state?.extensions ?? []).filter((entry) => entry.status === status).at(-1) ?? null;

// A decision is for the head its signals were read on: refused when the pull request has moved since.
function sameHead(entry, current) {
  if (current !== undefined && current !== null && !sameCommit(current, entry.head)) {
    throw new Error(`the check was for ${String(entry.head).slice(0, 7)}, and the pull request is at ${String(current).slice(0, 7)} now: run the review step again, which reads the signals on the new head`);
  }
}

// The judge's verdict into `state`: stop ends the check; extend grants on "auto" and asks the Human on "ask".
// `current` is the pull request's head now, when known.
export function recordVerdict(state, { verdict, reason, head = null, current = null, at = new Date().toISOString() }) {
  const entry = waiting(state, 'judging');
  if (!entry) throw new Error('no extension check waits for a verdict: run the review step at the cap first');
  if (head !== null && !sameCommit(head, entry.head)) throw new Error(`the check was for ${String(entry.head).slice(0, 7)}, not ${head.slice(0, 7)}: run the review step again`);
  sameHead(entry, current);
  entry.judge = { verdict, reason, head: entry.head, at };
  if (verdict === 'stop') Object.assign(entry, { status: 'stopped', by: 'judge', reasons: [reason], decided_at: at });
  else if (entry.mode === 'auto') Object.assign(entry, { status: 'granted', by: 'judge', reasons: [reason], decided_at: at });
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
  if (entry.status === 'asking') return `ask the Human "${askQuestion(pr, entry.round + 1)}" with the options ${askOptions(entry.round + 1).map((each) => `"${each}"`).join(' and ')}, then record the answer: aidrian pr extend ${pr} --human approve|deny`;
  return 'the cap stands: report round_limit and the findings left open';
}

// The CLI body. It reads and writes the record where the review step does: this machine's state folder and, unless
// config.json `review.record` is "local", the pull request's summary comment, so another machine continues from it.
// `deps.gh` replaces the review step's gh (pr, comments, post, edit) and `deps.repo` the origin, in tests.
export async function runExtend(args, project, config, deps = {}) {
  const opts = parseExtend(args);
  const { originRepo } = await import('../review-gate.mjs');
  const gh = deps.gh ?? (await import('./run.mjs')).defaultGh;
  const repo = deps.repo ?? originRepo(project);
  const onPr = config.review.record !== 'local';
  let comments = [];
  if (onPr) {
    try {
      comments = gh.comments(repo, opts.pr);
    } catch {}
  }
  const remote = stateFromComment(comments.filter((comment) => isSummary(comment.body)).at(-1)?.body, opts.pr);
  const state = newer(readLocalState(project, opts.pr), remote) ?? emptyState(opts.pr, repo);
  const env = deps.env ?? process.env;
  // The pull request's head now: a decision is for the head its signals were read on.
  let current = null;
  try {
    current = gh.pr(String(opts.pr)).headRefOid ?? null;
  } catch {}
  let entry;
  if (opts.verdict) entry = recordVerdict(state, { verdict: opts.verdict, reason: opts.reason, head: opts.head, current });
  else {
    const by = runGit(['config', 'user.name'], project.root).stdout.trim() || 'unknown';
    entry = recordHuman(state, { answer: opts.human, by, session: env.CLAUDE_CODE_SESSION_ID || null, current });
  }
  writeLocalState(project, state);
  const summaryError = onPr ? publishState(state, { comments: () => comments, post: (body) => gh.post(repo, opts.pr, body), edit: (id, body) => gh.edit(repo, id, body) }, `extension ${entry.status}`) : null;
  try {
    appendEvent(project, config, { ...rowOf(entry), ts: stamp(Date.now()), session_id: env.CLAUDE_CODE_SESSION_ID || null, pr: opts.pr, repo });
  } catch {}
  console.log(JSON.stringify({ status: 'recorded', pr: opts.pr, extension: { source: entry.source, round: entry.round, head: entry.head, status: entry.status, by: entry.by, reasons: entry.reasons }, next: nextStep(entry, opts.pr), ...(summaryError ? { summary_error: summaryError } : {}) }, null, 2));
  return 0;
}

// The dispatch-log row writer the review commands share.
export const extensionLogger = (project, config, { pr, repo, env = process.env }) => (row) => {
  try {
    appendEvent(project, config, { ...row, ts: stamp(Date.now()), session_id: env.CLAUDE_CODE_SESSION_ID || null, pr, repo });
  } catch {}
};
