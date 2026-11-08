// The product-mode checks of `aidrian quorum check`: the decide checks with no rebuttal round, the premise, the persona,
// and the provisional record.

import path from 'node:path';

import { MAX_PLAN_OBJECTIONS } from '../config.mjs';
import { isDecisionId } from '../decisions.mjs';
import { passing, refParts, shown } from './citations.mjs';
import { checkDecideLedger, decideIdProblems, decideVerdictProblems, firstRulingEntries } from './decide-check.mjs';
import { sameModelProblems, schemaProblems } from './ledger.mjs';
import { MAX_PRODUCT_POSITIONS, PRODUCT_CROSS_ID, PRODUCT_LEDGER_SCHEMA } from './product-schema.mjs';
import { continueGap, rulingGap } from './route.mjs';

// A product ledger as the decide rules see it: no rebuttal round, and no final ruling.
const decideView = (ledger) => ({ ...ledger, rebuttals: [], final_ruling: null });

// Why a product ledger does not fit, as lines that stop the check: the decide id rules on its positions, cases, and
// ruling; at most three positions; griller points U1 to E5, each once, by the id's letter, against a position; a draft
// for a position; an outcome only with a rule; a Human answer only to a ruling; and a provisional record only on a ledger
// `route --ledger` could continue on, naming an id a marker can hold. A complete ledger has a
// case per position, a ruling, and, on a rule, an outcome. Its ruling never stands without `human_answer`, so an
// unanswered one is complete and deferred.
export function productProblems(ledger, maxLoops = MAX_PLAN_OBJECTIONS) {
  const problems = decideIdProblems({ ...decideView(ledger), cross: [], human_answer: null });
  if (ledger.positions.length > MAX_PRODUCT_POSITIONS) problems.push(`product mode holds at most ${MAX_PRODUCT_POSITIONS} positions, not ${ledger.positions.length}`);
  const known = new Set(ledger.positions.map(({ id }) => id));
  const seen = new Set();
  for (const point of ledger.cross) {
    if (!PRODUCT_CROSS_ID.test(point.id)) problems.push(`cross id "${shown(point.id)}" is not U1 to U5 or E1 to E5`);
    else if (seen.has(point.id)) problems.push(`cross id ${point.id} is used more than once`);
    seen.add(point.id);
    if (point.by !== point.id[0]) problems.push(`cross ${shown(point.id)} is by ${point.by}, not ${shown(point.id[0])}`);
    if (!known.has(point.against)) problems.push(`cross ${shown(point.id)} is against ${point.against}, not a position in this ledger`);
  }
  if (ledger.premise.citations.some(({ kind }) => kind === 'plan')) problems.push('premise cites the question file, which only repeats it');
  const persona = ledger.witness?.persona;
  if (persona !== undefined && (path.isAbsolute(persona) || path.normalize(persona).startsWith('..'))) problems.push(`witness.persona "${shown(persona)}" is not a path inside the repository`);
  if (ledger.loops.length > maxLoops) problems.push(`loops: ${ledger.loops.length}, more than the ${maxLoops} allowed`);
  if (ledger.witness === null && ledger.loops.some(({ back_to }) => back_to === 'interview')) problems.push('loops: back to an interview, but no end user took part');
  if (ledger.draft && !known.has(ledger.draft.winner)) problems.push(`draft names ${ledger.draft.winner}, not a position in this ledger`);
  if (ledger.outcome !== null && ledger.ruling?.decision !== 'rule') problems.push('outcome: set but no ruling rules');
  if (ledger.human_answer !== null && ledger.ruling === null) problems.push('human_answer: set but nothing was ruled');
  if (ledger.provisional !== undefined) {
    const gap = rulingGap(ledger) ?? continueGap(ledger);
    if (gap) problems.push(`provisional: ${gap}`);
    if (!isDecisionId(ledger.provisional.marker)) problems.push(`provisional: marker ${JSON.stringify(ledger.provisional.marker)} is no decision marker's id`);
  }
  if (ledger.status === 'complete') {
    const cased = new Set(ledger.cases.map(({ position }) => position));
    for (const id of known) if (!cased.has(id)) problems.push(`position ${id} has no case in a complete ledger`);
    if (ledger.ruling === null) problems.push('ruling is null in a complete ledger');
    if (ledger.ruling?.decision === 'rule' && ledger.outcome === null) problems.push('outcome is null under a rule in a complete ledger');
  }
  return problems;
}

// A first ruling's faults no code change can cause, since they read only what it wrote: verdicts that miss what it rules on,
// and a rule with no verdict supporting its winner. Implementing a recommendation cannot excuse them.
function verdictFaults(ledger) {
  const { ruling } = ledger;
  if (!ruling) return [];
  const faults = decideVerdictProblems(ruling, firstRulingEntries(ledger));
  if (ruling.decision === 'rule' && !ruling.tested.some((verdict) => verdict.of === ruling.winner && verdict.supports === true)) faults.push("no verdict on the winner's case supports it");
  return faults.map((reason) => `ruling: invalid: ${reason}`);
}

// The marker statuses that keep a provisional ledger's stale exemption. Rejected or off the record, as after the Human's undo,
// the recommendation no longer stands, so a rerun must not ask on dead citations. A marker the writer has yet to see written reads as off the record.
const MARKER_KEEPS_EXEMPTION = Object.freeze(['unconfirmed', 'confirmed']);

// Checks a product ledger in place: the decide checks with no rebuttal round; the premise needs a passing citation;
// and a persona is a hypothesis, so a rule whose winner rests only on the persona's own doc goes back.
// `ctx.markerStatus` is what the docs on record say of a provisional ledger's marker, or null with none.
export function checkProductLedger(ledger, ctx) {
  const { problems, escapes, stale: decideStale } = checkDecideLedger(decideView(ledger), ctx);
  // The Human's answer settles a product ledger, and acting on it often changes the code a case quoted. So does
  // implementing a provisional recommendation, which settles nothing and yet must not void itself, while its marker stands.
  const exempt = ledger.provisional !== undefined && MARKER_KEEPS_EXEMPTION.includes(ctx.markerStatus);
  const holdsToEvidence = ledger.human_answer === null && !exempt;
  const stale = holdsToEvidence ? decideStale : [];
  const complete = ledger.status === 'complete';
  const invalid = (line) => {
    problems.push(line);
    if (complete && holdsToEvidence) stale.push(line);
  };
  if (!passing(ledger.premise.citations, 'premise', ctx, problems, escapes).length) invalid('premise: invalid: no citation passes');
  const personas = [...ledger.persona_docs, ...(ledger.witness ? [ledger.witness.persona] : [])].map((doc) => path.normalize(doc));
  const { ruling } = ledger;
  if (ruling?.decision === 'rule' && ledger.outcome === null && !complete) problems.push('ruling: invalid: a rule has no outcome');
  if (personas.length && ruling?.decision === 'rule') {
    const won = ledger.cases.find(({ position }) => position === ruling.winner);
    const held = passing(won?.citations ?? [], `case ${ruling.winner}`, ctx, [], []);
    const backing = ruling.tested
      .filter((verdict) => verdict.of === ruling.winner && verdict.supports)
      .map((verdict) => won?.citations[verdict.citation])
      .filter((citation) => held.includes(citation));
    if (backing.length && backing.every((citation) => personas.includes(path.normalize(refParts(citation).path ?? '')))) invalid('ruling: invalid: the winner rests only on the persona doc, which is a hypothesis');
  }
  // A deferred question must not be asked again on dead evidence, under a rule or an escalation alike.
  if (complete && holdsToEvidence) {
    // Only a coordinator-written escalate, with no verdicts, keeps the exemption from covering what it rules on.
    const hasVerdicts = ledger.ruling?.tested.length > 0;
    // One bad citation beside a passing one leaves a case or point standing: only an entry left with none is dead.
    const dead = (line) => /^(?:ruling|final ruling|premise)\.citations\[\d+\]/u.test(line) || /^(?:case|cross) \S+: no citation passes/u.test(line) || (line.startsWith('ruling: invalid: ') && (hasVerdicts || !/^ruling: invalid: (?:tested names|inference untested)/u.test(line)));
    stale.push(...problems.filter((line) => dead(line) && !stale.includes(line)));
  }
  // The exemption covers what implementing the recommendation can change, and only the Human's answer lifts the rest.
  if (complete && ledger.human_answer === null && ledger.provisional !== undefined) stale.push(...verdictFaults(ledger).filter((line) => !stale.includes(line)));
  return { ledger, problems, escapes, stale };
}

// A product ledger's lines that stop `check` before it reads a citation. `maxLoops` is asked for only on a ledger that fits its
// schema, since reading it can read config.json.
function productStops(ledger, maxLoops = () => undefined) {
  const stops = schemaProblems(ledger, PRODUCT_LEDGER_SCHEMA);
  if (!stops.length) stops.push(...productProblems(ledger, maxLoops()));
  if (!stops.length) stops.push(...sameModelProblems(ledger));
  return stops;
}

export { productStops };
