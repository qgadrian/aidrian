// `aidrian pr delegate <PR> --issue <REF> [--head <SHA>] [--repo <OWNER/NAME>]`: records, in the review record
// (lib/review/state.mjs) under `delegations`, that the Human answered the merge guard's round-limit question in their own
// words that the session decides, with the follow-up issue the session filed what the review left open as.
// docs/hooks.md#merge-guard describes the flow.
//
// The command cannot see the transcript, so the Bash rule lib/rules/review-delegate.mjs lets it run only when this
// session's transcript holds that answer (`delegates`). The command checks the rest: the review on the pull request's
// current head is stopped at its round limit with nothing owed (`cappedOn`), on this machine's own record as well, with
// the same open count, since the rule read the question from that record; every open finding of that head is low
// (`lowOnly`); and the follow-up issue the forge reads is an open issue in the pull request's own repository, not a pull
// request, filed at or after the review stopped, that names the pull request and lists every open finding's id. The merge guard
// (lib/rules/github/merge-review.mjs) then takes the entry (`delegationFor`) for a merge that names that head, while
// every open finding stays low; it makes no call for it.
//
// The trust limit is the transcript's, as for `aidrian pr extend --human approve`: a file in the agent's own account, as
// is the review record. The issue check runs only in this command: an entry written straight into the record skips it
// and the rule both. What holds at merge time is the guard's own test, so a forged answer or entry ships low findings
// only, on the head the review stopped on.
//
// SHORTCUT: the rule and this command each resolve the project and repository on their own, the question names the
// pull request by number and short head only, the command may adopt a newer posted record with the same head and
// count, and a posted copy withholds the entry's session. Each needs the agent's own working directory, gh default,
// fork, or record to differ from the review's; within the trust limit above, the most it ships is low findings on the
// capped head. Accepted residuals of the round-limit delegation review (round 1).
//
// SHORTCUT: readCurrent and runDelegate repeat the read, check, write, and publish sequence of waiver.mjs runWaive and
// extension.mjs runExtend, so a fix to one writer, such as the revision race, is made in all three. Accepted residual of
// the round-limit delegation review; one shared record writer would remove it.

import { forgeFor } from '../forges/index.mjs';
import { isObject } from '../fs.mjs';
import { runGit } from '../git.mjs';
import { sessionIdentity } from '../hosts/index.mjs';
import { givenRepo, namesChange, repoName } from '../remotes.mjs';
import { prNumber } from '../review-gate.mjs';
import { isFindingId, noHigher, RESIDUAL_CAP, severityOf } from './findings.mjs';
import { CAPPED, heldMessage, mergePending, openCount, owed, publishState, readLocalState, readRecord, sameCommit, SHA_REF, writeLocalState } from './state.mjs';

export const KIND = 'round_cap';
export const ANSWER = 'delegate';
// The answers that leave the decision to the session, each matched against the whole answer: a word before or after
// one, such as a condition ("if CI is green"), a lean ("I would rather grant more rounds"), or an option, makes the
// answer more than that. "your" stands for "you" too, as the Human types it ("whatever your recommend best").
const VERB = '(?:recommend|suggest|think|prefer|decide|choose|pick|judge|want|see fit)';
const NOUN = '(?:call|choice|decision|pick|judge?ment|recommendation)';
const LEAVES = new RegExp('^(?:(?:ok|okay|sure|fine|alright)[,.]? )?(?:' + [
  `(?:just )?(?:do |go with )?(?:what|whatever|whichever) you'?r? ${VERB}(?: is)?(?: (?:best|right|fine))?`,
  `(?:it'?s |that'?s )?(?:all )?up to you`,
  `you (?:decide|choose|pick)`,
  `(?:it'?s |that'?s )?your ${NOUN}(?:'s| is)?(?: fine)?`,
  `(?:go with|follow|i trust) your ${NOUN}`,
  `as you (?:recommend|suggest|see fit|think best)`,
  'decide for me',
  'i trust you',
].join('|') + ')$', 'u');

// Whether the Human's free-text `answer` leaves the ship decision to the session: the whole answer, lower-cased, with
// its spaces collapsed and a closing `.` or `!` dropped, is one of LEAVES. A quote mark, a question mark, or any word
// beyond the phrase refuses it. Conservative: a miss costs one more question, the behaviour before this command.
export function delegates(answer) {
  if (typeof answer !== 'string') return false;
  const text = answer.trim().toLowerCase().replaceAll('’', '\'').replace(/\s+/gu, ' ').replace(/[.!]+$/u, '');
  return LEAVES.test(text);
}

// Whether the review of `head` is stopped at its round limit: nothing owed, and the outcome is on `head` with a status
// in CAPPED.
export function cappedOn(state, head) {
  const outcome = isObject(state?.outcome) ? state.outcome : null;
  if (!outcome || typeof outcome.head !== 'string' || typeof head !== 'string' || owed(state).length) return false;
  return sameCommit(outcome.head, head) && CAPPED.has(outcome.status);
}

// A finding as a deny names it: its id, never its title.
const named = (finding) => (isObject(finding) && isFindingId(finding.id) ? `finding ${finding.id}` : 'a finding with no id');

// Whether every open finding of `head` is low, read from the record's last round: { ok: true, count } or
// { ok: false, why }. A round for another head, a round with no count or no list of every open finding, a finding
// above low, one marked security, and one with no known severity (a violated flow invariant has none) are not.
export function lowOnly(state, head) {
  const sha7 = String(head).slice(0, 7);
  const last = Array.isArray(state?.rounds) ? state.rounds.at(-1) : null;
  if (!isObject(last) || !sameCommit(last.head, head)) return { ok: false, why: `the record's last round is not for head ${sha7}` };
  if (!Number.isInteger(last.open) || last.open <= 0 || !Array.isArray(last.findings) || last.findings.length !== last.open) {
    return { ok: false, why: `the record does not list every open finding of head ${sha7} with its severity` };
  }
  // The round's findings are the stage the cap was judged at: in the last round another stage can run first and leave
  // its own open findings. The cap's cause (run.mjs capCause, kept on the outcome) lists every pass's open findings and
  // whatever else stopped the review, and is read whole. A posted copy drops the cause, so it never delegates.
  const cap = isObject(state.outcome?.cap) ? state.outcome.cap : null;
  if (!cap || typeof cap.head !== 'string' || !sameCommit(cap.head, head) || cap.itemized !== true || !Array.isArray(cap.items) || !Array.isArray(cap.unrun)) {
    return { ok: false, why: `the record does not hold what stopped the review of head ${sha7} in every stage` };
  }
  const stops = [[cap.unrun, 'a pass that never reviewed it'], [cap.flows, 'a flow invariant not held'], [cap.unsigned, 'an unsigned flow'], [cap.tests_removed, 'a removed flow test'], [cap.human, 'a flow the Human signs off']];
  const stop = stops.find(([list]) => Array.isArray(list) && list.length);
  if (stop) return { ok: false, why: `the review of head ${sha7} stopped on ${stop[1]} too` };
  if (cap.bot === true || cap.checks_failing !== 0) return { ok: false, why: `the review of head ${sha7} stopped on ${cap.bot === true ? 'the review bot\'s own round limit' : 'a failing check'} too` };
  const listed = new Set(last.findings.map((finding) => finding?.id));
  const above = [...last.findings, ...cap.items].find((finding) => !isObject(finding) || finding.security === true || !noHigher(finding.severity, RESIDUAL_CAP));
  const elsewhere = cap.items.find((item) => !isObject(item) || !listed.has(item.id));
  if (above === undefined && elsewhere !== undefined) return { ok: false, why: `${named(elsewhere)} is open in another stage` };
  if (above === undefined) return { ok: true, count: last.open };
  if (above?.security === true) return { ok: false, why: `${named(above)} is marked security` };
  const severity = severityOf(above?.severity);
  return { ok: false, why: `${named(above)} ${severity ? `is ${severity}` : 'has no severity on record'}` };
}

// The delegation that stands for a merge of `head`: the last entry of `state.delegations` for that head, given at or
// after the outcome; else null. A review step that runs again writes a newer outcome, so an older entry stops counting.
// An outcome or entry whose time cannot be read lets none stand. With `session`, the merging session's id, an entry
// another session recorded is passed over; one that holds no session counts for any.
export function delegationFor(state, head, { session = null } = {}) {
  const other = (entry) => typeof session === 'string' && typeof entry.session === 'string' && entry.session !== '' && entry.session !== session;
  const entries = (Array.isArray(state?.delegations) ? state.delegations : [])
    .filter((entry) => isObject(entry) && sameCommit(entry.head, head) && entry.kind === KIND && entry.answer === ANSWER && !other(entry));
  const last = entries.at(-1) ?? null;
  if (!last) return null;
  const since = Date.parse(state.outcome?.at ?? '');
  const at = Date.parse(last.at ?? '');
  return !Number.isNaN(since) && !Number.isNaN(at) && at >= since ? last : null;
}

const ISSUE_URL = /^https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/issues\/\d+\/?$/u;
const ISSUE_ERROR = '--issue must be an issue number, <owner>/<name>#<n>, or an issue URL';

// The follow-up issue `value` names: { repo, number, host? }, `repo` null for the pull request's own repository, and
// `host` the host of an issue URL.
export function issueRef(value) {
  const text = String(value ?? '').trim();
  let repo = null;
  let number = null;
  const plain = /^#?(\d{1,10})$/u.exec(text);
  const qualified = /^([\w.-]+\/[\w.-]+)#(\d{1,10})$/u.exec(text);
  if (plain) number = Number(plain[1]);
  else if (qualified) [repo, number] = [repoName(qualified[1]), Number(qualified[2])];
  else if (ISSUE_URL.test(text)) [repo, number] = [repoName(text), prNumber(text)];
  if (!Number.isSafeInteger(number) || number < 1 || (repo === null && !plain)) throw new Error(ISSUE_ERROR);
  // A URL keeps its host: an issue on another forge instance is not the one of the same name on the pull request's.
  return ISSUE_URL.test(text) ? { repo, number, host: new URL(text).host.toLowerCase() } : { repo, number };
}

// `aidrian pr delegate <PR> --issue <REF> [--head <SHA>] [--repo <OWNER/NAME>]`: { pr, issue, head, repo }.
export function parseDelegate(args) {
  const [ref, ...rest] = args;
  const pr = typeof ref === 'string' && !ref.startsWith('-') ? prNumber(ref) : null;
  if (!pr) throw new Error('delegate needs a pull request number');
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (!['--issue', '--head', '--repo'].includes(flag)) throw new Error(`unknown argument: ${flag}`);
    const value = rest[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    flags[flag.slice(2)] = value;
  }
  if (flags.issue === undefined) throw new Error('--issue is required: the open follow-up issue that holds what the review left open');
  if (flags.head !== undefined && !SHA_REF.test(flags.head)) throw new Error('--head must be a commit SHA');
  return { pr, issue: issueRef(flags.issue), head: flags.head ?? null, repo: flags.repo === undefined ? null : givenRepo(flags.repo) };
}

const ONLY = 'an answer is recorded only for a review stopped at its round limit on the current head';

// Why no answer may be recorded for `head`, for runDelegate's error.
function notCapped(state, head, pr) {
  const sha7 = String(head).slice(0, 7);
  const owing = owed(state);
  if (owing.length) return `${owing.length} review ${owing.length === 1 ? 'entry is' : 'entries are'} still owed on #${pr}: ${ONLY}`;
  const outcome = state.outcome ?? null;
  if (!outcome) return `the review record of #${pr} holds no outcome: ${ONLY}`;
  if (sameCommit(outcome.head, head)) return `the review of head ${sha7} is ${outcome.status}: ${ONLY}`;
  return `the last review step covered ${String(outcome.head).slice(0, 7)}, not head ${sha7}: ${ONLY}`;
}

const escape = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

// Whether `text`, an issue's title and body, names pull request `pr` of `repo`: `<owner>/<name>#<PR>`, its URL, or `#<PR>`
// with no word, path, or URL glued before it, so `other/repo#<PR>` is not this one (namesChange's boundary).
function namesPr(text, { repo, pr, url }) {
  if (namesChange(text, repo, pr)) return true;
  if (typeof url === 'string' && url !== '' && new RegExp(`${escape(url)}(?!\\d)`, 'iu').test(text)) return true;
  return new RegExp(`(?<![\\w./-])#${pr}(?!\\d)`, 'u').test(text);
}

// The ids of `ids` that `text` does not name, each as a whole word: `R2-1` is not named by `R2-10`.
const unnamed = (text, ids) => ids.filter((id) => !new RegExp(`(?<![\\w-])${escape(id)}(?![\\w-])`, 'u').test(text));

// The follow-up issue, read through the forge and checked: { ref, url }. It is in the pull request's own repository,
// where the findings trace back to the pull request, names the pull request and every open finding by its id (`ids`),
// and was filed at or after the review stopped (`since`, the outcome's time, to the second, as GitHub gives a time), so
// it is not an older issue that predates what the review left open. Each failure throws.
function followUp(forge, opts, { repo, url, since, ids }) {
  const home = repoName(repo);
  const issueRepo = opts.issue.repo ?? home;
  const ref = `${issueRepo}#${opts.issue.number}`;
  if (issueRepo !== home) throw new Error(`issue ${ref} is not in the pull request's repository, ${home}: file the follow-up issue there`);
  let prHost = null;
  try {
    prHost = new URL(url).host.toLowerCase();
  } catch {}
  if (opts.issue.host !== undefined && opts.issue.host !== prHost) {
    throw new Error(`issue ${ref} is on ${opts.issue.host}, not on the pull request's host${prHost ? `, ${prHost}` : ''}: file the follow-up issue there`);
  }
  let found;
  try {
    found = forge.issue(issueRepo, opts.issue.number);
  } catch {
    throw new Error(`could not read issue ${ref}: the follow-up issue is read before the answer is recorded`);
  }
  if (!found) throw new Error(`issue ${ref} does not exist`);
  if (found.change) throw new Error(`${ref} is a pull request, not an issue`);
  if (found.state !== 'open') throw new Error(`issue ${ref} is closed: the follow-up issue stays open until its findings are handled`);
  const text = `${found.title}\n${found.body}`;
  if (!namesPr(text, { repo, pr: opts.pr, url })) {
    throw new Error(`issue ${ref} does not name pull request ${repo}#${opts.pr}: add it to the issue's body, so the findings trace back`);
  }
  const missing = unnamed(text, ids);
  if (missing.length) {
    throw new Error(`issue ${ref} does not list ${missing.length === 1 ? 'finding' : 'findings'} ${missing.join(', ')}: list each open finding's id in the issue's body, so each one traces back`);
  }
  const filed = Date.parse(found.created ?? '');
  const stopped = Date.parse(since ?? '');
  if (Number.isNaN(filed) || Number.isNaN(stopped)) throw new Error(`cannot read when issue ${ref} was filed, or when the review stopped: the follow-up issue must be filed after the review stopped`);
  if (filed < Math.floor(stopped / 1000) * 1000) {
    throw new Error(`issue ${ref} was filed before the review stopped at ${since}: file a new follow-up issue for what this review left open`);
  }
  return { ref, url: found.url };
}

// The ids of the open findings, when the session may ship `current` of `pr` on the Human's word: the review record is
// stopped at its round limit on that head, so is this machine's own record (`local`), with the same open count, and
// every open finding is low and has an id. Each failure throws.
function shippable({ state, local, current, pr }) {
  if (!cappedOn(state, current)) throw new Error(notCapped(state, current, pr));
  // The rule read the question the Human answered from this machine's record, before the posted copy was merged in:
  // so the answer is never recorded for a head or a count the Human was not asked about.
  const count = openCount(state, current);
  if (!cappedOn(local, current) || openCount(local, current) !== count) {
    throw new Error(`this machine's review record of #${pr} is not stopped at its round limit on head ${current.slice(0, 7)}${count === null ? '' : ` with ${count} open`}, as the record the review step reads is: ` +
      'the Human answered the question this machine\'s record words, so the answer is not recorded for another head or count. Run the review step on this machine, then follow the merge guard\'s denial');
  }
  const low = lowOnly(state, current);
  if (!low.ok) {
    throw new Error(`the session may ship on the Human's word only while every open finding is low: ${low.why}. Ask the Human the merge guard's question again: only "Merge with the findings filed" or "Grant more review rounds" decides this`);
  }
  const ids = state.rounds.at(-1).findings.map((finding) => finding.id);
  if (!ids.every(isFindingId)) throw new Error('an open finding of the record has no id, so the follow-up issue cannot list it: only "Merge with the findings filed" or "Grant more review rounds" decides this');
  return ids;
}

// The pull request now, and its review record as the review step reads it: { view, current, state, local, comments,
// committed, onPr }. Each failure throws.
async function readCurrent(project, config, { forge, repo, pr }) {
  const { holdToBase } = await import('./in-force.mjs');
  const { readReading } = await import('./dispatch.mjs');
  let view = null;
  try {
    view = forge.change(String(pr), 'number,headRefOid,baseRefName,url', { repo });
  } catch {}
  if (!view?.baseRefName) throw new Error('cannot read the pull request\'s base branch: the review record is read from the state.dir it commits');
  const current = view.headRefOid;
  if (typeof current !== 'string' || !SHA_REF.test(current)) throw new Error('cannot read the pull request\'s head: the answer binds to one head');
  const { committed } = holdToBase(project, config, { repo, base: view.baseRefName });
  const onPr = committed.review.record !== 'local';
  let comments = [];
  if (onPr) {
    try {
      comments = forge.conversationComments(repo, pr);
    } catch {}
  }
  const local = readLocalState(project, pr, repo);
  const record = readRecord(project, pr, comments, repo, () => readReading(forge, repo, pr));
  if (record.held !== undefined) throw new Error(heldMessage(pr, record.held, record.why, record.finding));
  const { state } = record;
  state.pending = mergePending(local?.pending, state.pending);
  return { view, current, state, local, comments, committed, onPr };
}

// The CLI body. It reads and writes the record where the review step does: this machine's state folder and, unless the
// base branch's `review.record` is "local", the pull request's summary comment. The entries owed on this machine are
// merged in first; when this machine's record changes before the write, nothing is written. `deps.forge` replaces the
// forge (change, issue, conversationComments, postComment, editComment, viewer), `deps.repo` the resolved repository, and
// `deps.env` the environment, in tests.
export async function runDelegate(args, project, config, deps = {}) {
  const opts = parseDelegate(args);
  const forge = deps.forge ?? forgeFor(undefined);
  const { prRepo } = await import('../review-gate.mjs');
  const repo = deps.repo ?? prRepo(project, opts.pr, opts.repo, forge);
  const pr = opts.pr;
  const { view, current, state, local, comments, committed, onPr } = await readCurrent(project, config, { forge, repo, pr });
  const head = opts.head ?? current;
  if (!sameCommit(head, current)) throw new Error(`the pull request's head is ${current.slice(0, 7)}, not ${head.slice(0, 7)}: the answer binds to the current head`);
  const ids = shippable({ state, local, current, pr });
  const issue = followUp(forge, opts, { repo, url: view.url, since: state.outcome?.at ?? null, ids });
  const env = deps.env ?? process.env;
  const by = runGit(['config', 'user.name'], project.root).stdout.trim() || 'unknown';
  const entry = { head: current, kind: KIND, answer: ANSWER, issue: issue.ref, url: issue.url, by, session: sessionIdentity(env).session ?? null, at: new Date().toISOString() };
  state.delegations = [...(Array.isArray(state.delegations) ? state.delegations : []), entry];
  // A request or a review step written since the read would be lost under this write: refused, and nothing written.
  const again = readLocalState(project, pr, repo);
  if ((again?.revision ?? null) !== (local?.revision ?? null)) throw new Error(`the review record of #${pr} changed while the answer was recorded: run again`);
  writeLocalState(project, state, { repo });
  let summaryError = null;
  if (onPr) {
    const { postContext } = await import('./dispatch.mjs');
    const io = { comments: () => comments, post: (body) => forge.postComment(repo, pr, body), edit: (id, body) => forge.editComment(repo, id, body), viewer: () => forge.viewer() };
    summaryError = publishState(state, io, 'delegation recorded', postContext({ forge, repo, n: pr, project, configs: [committed, config], env }));
  }
  const next = `merge with \`gh pr merge ${pr} --repo ${repoName(repo) ?? repo} --match-head-commit ${current}\`: the merge guard takes this answer only for a merge that names that head, while every open finding stays low`;
  const delegation = { head: entry.head, kind: entry.kind, answer: entry.answer, issue: entry.issue, url: entry.url };
  console.log(JSON.stringify({ status: 'recorded', pr, delegation, next, ...(summaryError ? { summary_error: summaryError } : {}) }, null, 2));
  return 0;
}
