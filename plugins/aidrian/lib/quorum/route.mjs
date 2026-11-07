// `aidrian quorum route`'s rules: what happens to one product decision, before a quorum or after its ruling, from the
// base branch's `quorum.product` and `decisions resolve`'s answer.

import { committedQuorumProduct, DEFAULTS } from '../config.mjs';
import { answers as reversibleAnswers, resolveQuestion, scanDecisions } from '../decisions-cli.mjs';
import { DECISION_STATUSES } from '../decisions.mjs';
import { loadTable as severityTable } from '../finding-disposition.mjs';
import { isObject } from '../fs.mjs';
import { committedConfigFile } from '../project.mjs';
import { shown } from './citations.mjs';

// The deciding agent's five answers on how hard a call is, in the order docs/config.md gives them.
const HARDNESS_QUESTIONS = 5;

// Whether `--hard` says a call is small and clear: all five answers no. Any yes, any word that is no answer, and any
// answer missing leaves it hard.
export const isClearCall = (value) => {
  const words = String(value ?? '').split(',').map((word) => word.trim().toLowerCase());
  return words.length === HARDNESS_QUESTIONS && words.every((word) => word === 'no');
};

// The domains an automatic quorum may run in. Any other, an unknown one included, keeps resolve's answer as it is.
export const ROUTED_DOMAINS = Object.freeze(['product', 'ux']);
const otherDomain = (domain, answered = true) => `${JSON.stringify(domain ?? null)} is not a domain a quorum routes${answered ? ', so resolve\'s answer stands as it is' : ''}`;

// Why auto-start does not apply. Under resolve's `no-base`, something at the base could not be read, so the setting may
// be unknown: it counts as off, and resolve's own reason says what failed.
const autoStartOff = (answer) => (answer?.rule === 'no-base' ? `quorum.product.autoStart counts as off, because ${answer.reason}` : 'quorum.product.autoStart is off at the base branch');

// What happens to one product decision: { route, wait, reason }. `settings` is the base branch's `quorum.product`, `call`
// is { hard, runs, domain }, and `answer` is resolve's. Only `authority: "decide"` counts as a decision the agent may make, and only
// `approval: "review-later"` lets work go on, so a value this code does not know waits. `wait` is true when work on the
// decision waits for the Human. A quorum with `wait` false is the provisional one, and it needs resolve's decide:
// an ask under any setting stays with the Human.
export function routeFor({ autoStart, approval, maxAutoRuns }, { hard, runs = 0, domain }, answer) {
  const decides = answer.authority === 'decide';
  if (!ROUTED_DOMAINS.includes(domain)) return { route: 'as-today', wait: !decides, reason: otherDomain(domain) };
  if (!autoStart) return { route: 'as-today', wait: !decides, reason: `${autoStartOff(answer)}, so resolve\'s answer stands as it is` };
  if (!hard) {
    return decides
      ? { route: 'agent', wait: false, reason: `a small, clear call, and resolve says decide: ${answer.reason}` }
      : { route: 'human', wait: true, reason: `a small, clear call, and resolve says ask, so it runs no quorum: ${answer.reason}` };
  }
  if (runs >= maxAutoRuns) return { route: 'human', wait: true, reason: `a hard call, and this session has made ${runs} automatic runs, at quorum.product.maxAutoRuns ${maxAutoRuns}, so it waits with no quorum` };
  if (!decides) return { route: 'quorum', wait: true, reason: `a hard call, and resolve says ask, so the quorum recommends and the Human approves: ${answer.reason}` };
  if (approval === 'review-later') return { route: 'quorum', wait: false, reason: 'a hard call, and review-later with resolve\'s decide: work continues on the recommendation, recorded as provisional' };
  return { route: 'quorum', wait: true, reason: 'a hard call under approval first: the quorum recommends and the Human approves' };
}

const isBoolean = (value) => typeof value === 'boolean';
const isText = (value) => typeof value === 'string' && value.trim() !== '';

// The Ruling's question for `decisions resolve`, from a ledger read as JSON: { class, reversible, docs }, or null when any
// of the three is missing or holds no answer. `reversible` is as `--reversible` spells it, or a list of those words.
function rulingQuestion(ledger) {
  const ruling = isObject(ledger) ? ledger.ruling : null;
  if (!isObject(ruling)) return null;
  const { class: kind, reversible, docs } = ruling;
  const words = Array.isArray(reversible) ? reversible.join(',') : reversible;
  const parsed = typeof words === 'string' ? reversibleAnswers(words) : null;
  if (!isText(kind) || parsed === null || !Array.isArray(docs) || !docs.every(isText)) return null;
  return { class: kind, reversible: parsed, docs };
}

// Why no setting could let work continue on this ruling, as one line, or null. `route --ledger` waits on it, and `quorum check`
// holds a provisional ledger to it, so the two cannot drift.
function rulingGap(ledger) {
  const { ruling, outcome } = ledger;
  if (ledger.status !== 'complete') return 'the ledger is not complete';
  if (!isObject(ruling)) return 'the ledger holds no ruling';
  if (ruling.decision === 'escalate') return 'the ruling escalates';
  if (ruling.decision !== 'rule') return 'the ruling neither rules nor escalates';
  if (!isText(ruling.domain)) return 'the ruling names no domain';
  if (rulingQuestion(ledger) === null) return 'the ledger lacks the Ruling\'s class, reversible, or docs';
  if (!isText(ruling.winner)) return 'the ruling names no winner';
  // A continued ruling needs these for its record, as handoff.md's decided_provisional does, though resolve asks neither.
  if (!isText(ruling.severity) || !isText(ruling.reverts_by)) return 'the ledger lacks the Ruling\'s severity or reverts_by';
  const flips = isObject(outcome) ? outcome.flips_if : null;
  if (!Array.isArray(flips)) return 'the ledger lacks outcome.flips_if';
  if (!flips.every((entry) => isObject(entry) && isBoolean(entry.settles_from_repo) && isBoolean(entry.could_harden_undo))) return 'a flips_if entry lacks settles_from_repo or could_harden_undo';
  if (!flips.every((entry) => isText(entry.fact) && isText(entry.how_to_settle))) return 'a flips_if entry lacks its fact or how_to_settle';
  return null;
}

// The one `trigger` that lets work continue. A ledger written before the route existed, or a run the Human started, holds another and stays valid: it asks.
const CONTINUING_TRIGGER = "the route, with resolve's decide";

// The line that stops review later on a ledger with no rulingGap, or null. It stops only there: under first or ask, the Human
// sees the fact, and a hard-to-undo ruling keeps resolve's own answer. `route --ledger`, the writer, and `quorum check` on a provisional ledger all read it.
function continueGap(ledger) {
  if (ledger.trigger !== CONTINUING_TRIGGER) return `only a run the route started under resolve's decide continues, and this ledger's trigger is ${JSON.stringify(ledger.trigger ?? null)}`;
  return ledger.outcome.flips_if.some((entry) => entry.could_harden_undo) ? 'a flipping fact could make the decision harder to undo' : null;
}

// Why the writer waits for the second look on a ruling, as one line, or null: `look` is resolve's `secondLook`, null when it is off.
// An unknown severity counts as at or above `minSeverity`, as a missing one does for a specialist's decision.
function secondLookGap({ ruling, second_look: taken }, look) {
  if (!look) return null;
  const { severities, severitySynonyms } = severityTable();
  const word = ruling.severity.trim().toLowerCase();
  const rank = severities.indexOf(severitySynonyms[word] ?? word);
  if (rank > severities.indexOf(look.minSeverity) || (taken?.agent === look.agent && taken.sign_off === 'approved')) return null;
  const said = !taken ? 'is missing' : taken.agent !== look.agent ? `is from ${JSON.stringify(taken.agent)}` : `says ${JSON.stringify(taken.sign_off)}`;
  return `second look: ${look.agent} must approve a ruling of severity ${shown(ruling.severity)}, at or above ${look.minSeverity} or unknown, and second_look ${said}`;
}

// Why a provisional ledger's marker no longer carries it, as one line, or null. `status` is what the docs on record say, or
// null with no such marker, as after the Human's undo. Only `unconfirmed` carries it: `decisions set` writes `confirmed` for
// `changed` too, so a settled marker may hold wording that replaced the recommendation. A ledger with no provisional has nothing to look up.
function markerGap(ledger, status) {
  if (ledger.provisional === undefined || status === 'unconfirmed') return null;
  const id = shown(String(ledger.provisional?.marker));
  if (status === 'confirmed') return `the Human settled its marker ${id}, so read the rule in its doc`;
  if (status === 'rejected') return `its marker ${id} was rejected in the batch review`;
  return `its marker ${id} is not on record, as after the Human's undo`;
}

// What happens after a product ruling: { route, wait, reason, settle, listed }. `answer` is resolve's on the Ruling's
// question, or null when the ledger asks none, and `domain` the one the caller named. A missing field reads as the Human's,
// whatever the settings, and so does a ledger the Human answered, one not complete, a ruling outside `domain`, or a provisional
// ledger whose marker, in `markerStatus`, is no longer unconfirmed: `wait` stays true there, so no caller goes on with the
// recommendation. Under review-later and resolve's decide, a fact that could make the decision
// harder to undo waits; one the repository can settle waits in `settle` for its one read-only dispatch; and every other
// is `listed`, for the batch review, as work continues. Anywhere else the Human sees all of them in `listed` before deciding.
export function routeAfterRuling({ autoStart, approval }, ledger, answer, domain, markerStatus = null) {
  const flips = isObject(ledger) && isObject(ledger.outcome) ? ledger.outcome.flips_if : null;
  const entries = Array.isArray(flips) ? flips.filter(isObject) : [];
  const shown = ({ fact, how_to_settle }) => ({ fact, how_to_settle });
  const waits = (route, reason, settle = [], listed = entries) => ({ route, wait: true, reason, settle: settle.map(shown), listed: listed.map(shown) });
  const human = (reason) => waits('human', reason);
  if (!ROUTED_DOMAINS.includes(domain)) return waits('as-today', otherDomain(domain, answer !== null));
  if (!isObject(ledger) || ledger.mode !== 'product') return human('this is no product ledger');
  if (ledger.human_answer === undefined) return human('the ledger lacks human_answer');
  if (ledger.human_answer !== null) return human('the Human has answered, so the Human\'s answer governs, not the recommendation');
  const gap = rulingGap(ledger);
  if (gap) return human(gap);
  if (ledger.ruling.domain !== domain) return human(`the ruling is in the domain ${JSON.stringify(ledger.ruling.domain)}, not ${JSON.stringify(domain)}, so the route continues only when they match, and resolve judges the class`);
  if (answer === null) return human('resolve gave no answer on the Ruling\'s question');
  const lost = markerGap(ledger, markerStatus);
  if (lost) return human(lost);
  if (!autoStart) return waits('as-today', `${autoStartOff(answer)}, so the Human answers a product ruling`);
  if (answer.authority !== 'decide') return waits('quorum', `resolve says ask, so the Human approves: ${answer.reason}`);
  if (approval !== 'review-later') return waits('quorum', 'approval is first, so the Human approves');
  const held = continueGap(ledger);
  if (held) return human(held);
  const settle = entries.filter((entry) => entry.settles_from_repo);
  const listed = entries.filter((entry) => !entry.settles_from_repo);
  if (settle.length) return waits('quorum', 'settle the facts in `settle` from the repository first: a result that keeps the winner is recorded and work continues, and any other waits for the Human', settle, listed);
  return { route: 'quorum', wait: false, reason: 'review-later with resolve\'s decide: work continues on the recommendation, recorded as provisional', settle: [], listed: listed.map(shown) };
}

// What the docs on record say of one marker, the furthest status any copy holds, or null with no such marker or none that can be read.
function markerOnRecord(project, id) {
  try {
    const { decisions, unlisted } = scanDecisions(project);
    const found = [...decisions, ...unlisted].filter((each) => each.id === id);
    return DECISION_STATUSES.findLast((status) => found.some((each) => each.status === status)) ?? null;
  } catch {
    return null;
  }
}

// The `quorum.product` of the commit resolve read: `base` is null with no readable base, and git failing reads the same.
function productInForce(project, base) {
  if (base === null) return DEFAULTS.quorum.product;
  try {
    return committedQuorumProduct(project, base, committedConfigFile(project, base));
  } catch {
    return DEFAULTS.quorum.product;
  }
}

// What `route --ledger` says of one ledger under `domain`, for that command and the writer alike: routeAfterRuling's answer, and `resolve`.
// A writer runs before its marker exists, so with `writing` no marker on record is what it expects, and a settled or rejected one still stops it.
function ledgerRoute(project, ledger, domain, { writing = false } = {}) {
  const asked = rulingQuestion(ledger);
  // A ruling outside the domain named asks nothing there, so resolve logs no row under a domain it was never in.
  const outside = ledger?.ruling?.domain !== domain;
  const resolve = asked === null || outside ? null : resolveQuestion(project, { domain, ...asked });
  const settings = productInForce(project, resolve?.base ?? null);
  const found = ledger?.provisional === undefined ? null : markerOnRecord(project, ledger.provisional?.marker);
  return { ...routeAfterRuling(settings, ledger, resolve, domain, found ?? (writing ? 'unconfirmed' : null)), resolve };
}

export { continueGap, ledgerRoute, markerOnRecord, productInForce, rulingGap, secondLookGap };
