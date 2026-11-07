// The decide-mode checks of `aidrian quorum check`: positions and their ids, a complete ledger, and checkDecideLedger,
// which checks every citation of a decide ledger in place.

import { citationKey, passing, shown } from './citations.mjs';
import { CROSS_ID, POSITION_IDS } from './decide-schema.mjs';
import { coverageProblem, inferenceEvidenceProblems, inferenceProblems, supported } from './verdicts.mjs';

// The position a decide ledger settles on: the final ruling's winner when it rules, else the first ruling's. A flip is
// final: the rounds stop after the final ruling.
export const governingWinner = (ledger) => (ledger.final_ruling?.decision === 'rule' ? ledger.final_ruling.winner : ledger.ruling?.winner ?? null);

// Why a decide ledger's ids do not fit, as lines that stop the check, run before any line that prints an id: positions
// A to D in order, 2 to 4; a case per position at most, for a position the ledger holds; cross ids A1 to D5, each once,
// by the position of the id's letter, against another position; a rebuttal per losing position of the first ruling at
// most; a winner exactly on a `rule`, one of the positions; rebuttals and a final ruling only after a first `rule`; a
// final `rule` only over a rebut, for the first ruling's winner or one that rebutted; and a Human answer only to an
// escalation, first or final.
export function decideIdProblems(ledger) {
  const problems = [];
  const ids = ledger.positions.map((position) => position.id);
  if (ids.length < 2 || ids.join() !== POSITION_IDS.slice(0, ids.length).join()) problems.push(`positions are ${ids.join(', ') || 'none'}, not 2 to 4 from A to D in order`);
  const known = new Set(ids);
  const twice = (list) => [...new Set(list.filter((id, i) => list.indexOf(id) !== i))];
  const cases = ledger.cases.map((each) => each.position);
  for (const id of new Set(cases.filter((id) => !known.has(id)))) problems.push(`case ${id} is not a position in this ledger`);
  for (const id of twice(cases)) problems.push(`position ${id} has more than one case`);
  const crossIds = ledger.cross.map((point) => point.id);
  for (const point of ledger.cross) {
    if (!CROSS_ID.test(point.id)) {
      problems.push(`cross id "${shown(point.id)}" is not A1 to D5`);
      continue;
    }
    const where = `cross ${point.id}`;
    if (point.by !== point.id[0]) problems.push(`${where} is by ${point.by}, not ${point.id[0]}`);
    else if (!known.has(point.by)) problems.push(`${where} is by ${point.by}, not a position in this ledger`);
    if (!known.has(point.against)) problems.push(`${where} is against ${point.against}, not a position in this ledger`);
    else if (point.against === point.by) problems.push(`${where} is against its own position`);
  }
  for (const id of twice(crossIds.filter((id) => CROSS_ID.test(id)))) problems.push(`cross id ${id} is used more than once`);
  const { ruling, final_ruling: final } = ledger;
  const rebuttals = ledger.rebuttals.map((rebuttal) => rebuttal.position);
  for (const id of new Set(rebuttals.filter((id) => !known.has(id)))) problems.push(`rebuttal ${id} is not a position in this ledger`);
  if (ruling?.winner && rebuttals.includes(ruling.winner)) problems.push(`rebuttal ${ruling.winner} is by the first ruling's winner`);
  for (const id of twice(rebuttals)) problems.push(`position ${id} has more than one rebuttal`);
  for (const [value, where] of [[ruling, 'ruling'], [final, 'final ruling']]) {
    if (!value) continue;
    if (value.decision === 'rule' && value.winner === null) problems.push(`${where} rules with no winner`);
    if (value.decision === 'escalate' && value.winner !== null) problems.push(`${where} escalates but names the winner ${value.winner}`);
    if (value.winner !== null && !known.has(value.winner)) problems.push(`${where} names the winner ${value.winner}, not a position in this ledger`);
  }
  const rebutted = new Set(ledger.rebuttals.filter((rebuttal) => rebuttal.verdict === 'rebut').map((rebuttal) => rebuttal.position));
  if (final?.winner && final.winner !== ruling?.winner && !rebutted.has(final.winner)) problems.push(`final ruling names the winner ${final.winner}, neither the first ruling's winner nor a position that rebutted`);
  if ((ledger.rebuttals.length || final) && ruling?.decision !== 'rule') problems.push('rebuttals and a final ruling follow a first ruling of rule only');
  if (final?.decision === 'rule' && !rebutted.size) problems.push('final ruling rules, but no position rebutted');
  if (ledger.human_answer !== null && ruling?.decision !== 'escalate' && final?.decision !== 'escalate') problems.push('human_answer: set but nothing escalated');
  return problems;
}

// The problems that make a `complete` decide ledger unfinished: a position with no case; no ruling; under a `rule`, a losing position with no
// rebuttal or concession, or a rebuttal that rebuts with no final ruling. A final `escalate` is exempt from both, since
// it ends a rebuttal round that fell short; an escalation the Human has not answered is deferred, and complete.
export function decideCompleteProblems(ledger) {
  if (ledger.status !== 'complete') return [];
  const { ruling, final_ruling: final } = ledger;
  const cased = new Set(ledger.cases.map((each) => each.position));
  const problems = ledger.positions.filter(({ id }) => !cased.has(id)).map(({ id }) => `position ${id} has no case in a complete ledger`);
  if (ruling === null) return [...problems, 'ruling is null in a complete ledger'];
  if (ruling.decision !== 'rule' || final?.decision === 'escalate') return problems;
  const answered = new Set(ledger.rebuttals.map((rebuttal) => rebuttal.position));
  for (const { id } of ledger.positions) if (id !== ruling.winner && !answered.has(id)) problems.push(`position ${id} lost the ruling and has no rebuttal in a complete ledger`);
  if (final === null) for (const rebuttal of ledger.rebuttals.filter((each) => each.verdict === 'rebut')) problems.push(`rebuttal ${rebuttal.position} rebuts with no final ruling in a complete ledger`);
  return problems;
}

// Why a decide ruling's verdicts do not cover `entries`, the cases and backed cross points (the rebuttals, for the final
// ruling) it rules on, each { of, label, citations, claim }: every citation of each once, keyed by `of`, nothing else,
// and every `inference:` line of their claims.
function decideVerdictProblems(value, entries) {
  const problems = [];
  for (const entry of entries) {
    const coverage = coverageProblem(value.tested.filter((verdict) => verdict.of === entry.of).map((verdict) => verdict.citation), entry.citations.length, ` of ${entry.label}`);
    if (coverage) problems.push(coverage);
  }
  const keys = new Set(entries.map((entry) => entry.of));
  const strays = [...new Set(value.tested.map((verdict) => verdict.of).filter((of) => !keys.has(of)))];
  if (strays.length) problems.push(shown(`tested names ${strays.join(', ')}, which the ruling does not rule on`));
  problems.push(...inferenceProblems(entries.map((entry) => entry.claim), value.inferences));
  return problems;
}

const ruledEntry = (of, label, { citations, claim }) => ({ of, label, citations, claim });
// What a first ruling rules on: every case and every backed cross point.
const firstRulingEntries = (ledger) => [
  ...ledger.cases.map((each) => ruledEntry(each.position, `case ${each.position}`, each)),
  ...ledger.cross.filter((point) => point.status === 'backed').map((point) => ruledEntry(point.id, `cross ${point.id}`, point)),
];

// Checks a decide ledger in place, as checkLedger checks a plan ledger: { ledger, problems, escapes, stale }. A pending
// cross point becomes `backed` or `opinion` by whether a citation passes; a case with none is named. A ruling, final
// ruling, rebuttal, or concession with no passing citation is invalid, as is a rebuttal that cites nothing the cases,
// cross points, and first ruling did not hold, and a ruling whose verdicts miss what it rules on. In a complete ledger
// the Human did not settle (no answer, no escalate, first or final), each invalid line is stale too; a governing winner whose
// case has no passing citation is stale in any complete ledger: a position wins on evidence or not at all.
export function checkDecideLedger(ledger, ctx) {
  const problems = [];
  const escapes = [];
  const stale = [];
  const pass = (list, where) => passing(list, where, ctx, problems, escapes);
  const complete = ledger.status === 'complete';
  const settled = ledger.human_answer !== null || ledger.ruling?.decision === 'escalate' || ledger.final_ruling?.decision === 'escalate';
  const invalid = (line) => {
    problems.push(line);
    if (complete && !settled) stale.push(line);
  };
  // Each position's passing case citations, and each rebuttal's: only a verdict on one of these supports a rule or a flip.
  const caseProof = new Map();
  const rebuttalProof = new Map();
  for (const each of ledger.cases) {
    const proof = pass(each.citations, `case ${each.position}`);
    caseProof.set(each.position, proof);
    if (!proof.length) problems.push(`case ${each.position}: no citation passes`);
  }
  const backed = new Set([...caseProof].filter(([, proof]) => proof.length).map(([id]) => id));
  for (const point of ledger.cross) {
    const where = `cross ${point.id}`;
    const proof = pass(point.citations, where);
    if (point.status === 'pending') {
      point.status = proof.length ? 'backed' : 'opinion';
      if (!proof.length) problems.push(`${where}: relabeled opinion (was pending): no citation passes`);
    } else if (point.status === 'backed' && !proof.length) problems.push(`${where}: no citation passes; kept backed`);
  }
  const { ruling, final_ruling: final } = ledger;
  if (ruling) {
    if (!pass(ruling.citations, 'ruling').length) invalid('ruling: invalid: the ruling has no passing citation');
    for (const reason of decideVerdictProblems(ruling, firstRulingEntries(ledger))) invalid(`ruling: invalid: ${reason}`);
    for (const reason of inferenceEvidenceProblems(ruling.inferences, 'ruling', pass)) invalid(`ruling: invalid: ${reason}`);
    if (ruling.decision === 'rule') {
      // A position wins on evidence or not at all, so a rule for one whose case has no passing citation goes back.
      if (!backed.has(ruling.winner)) invalid("ruling: invalid: the winner's case has no passing citation");
      const won = ledger.cases.find((each) => each.position === ruling.winner);
      if (!won || !supported(ruling.tested.filter((verdict) => verdict.of === ruling.winner), won.citations, caseProof.get(won.position))) invalid("ruling: invalid: a rule rests on no supporting citation of the winner's case");
    }
  }
  // What a rebuttal must add to: every case's, cross point's, and the first ruling's citations.
  const held = new Set([...ledger.cases, ...ledger.cross, ...(ruling ? [ruling] : [])].flatMap((each) => each.citations).map(citationKey));
  for (const rebuttal of ledger.rebuttals) {
    const where = `rebuttal ${rebuttal.position}`;
    const proof = pass(rebuttal.citations, where);
    rebuttalProof.set(rebuttal.position, proof);
    if (rebuttal.verdict === 'rebut') {
      if (!proof.length) invalid(`${where}: invalid: the rebuttal has no passing citation`);
      else if (proof.every((citation) => held.has(citationKey(citation)))) invalid(`${where}: invalid: the rebuttal cites nothing new`);
    } else if (!proof.length) invalid(`${where}: invalid: the concession has no passing citation`);
  }
  if (final) {
    if (!pass(final.citations, 'final ruling').length) invalid('final ruling: invalid: the ruling has no passing citation');
    for (const reason of inferenceEvidenceProblems(final.inferences, 'final ruling', pass)) invalid(`final ruling: invalid: ${reason}`);
    // A final escalate goes to the Human, and the coordinator writes one with no verdicts when the rebuttal round ends
    // short, so only a final rule is held to its verdicts.
    if (final.decision === 'rule') {
      if (!backed.has(final.winner)) invalid("final ruling: invalid: the winner's case has no passing citation");
      const entries = ledger.rebuttals.map((each) => ruledEntry(each.position, `rebuttal ${each.position}`, each));
      for (const reason of decideVerdictProblems(final, entries)) invalid(`final ruling: invalid: ${reason}`);
      // A flip overturns the first ruling, so it rests on the evidence of the rebuttal it upholds.
      const won = ledger.rebuttals.find((each) => each.position === final.winner);
      if (final.winner !== ruling?.winner && (!won || !supported(final.tested.filter((verdict) => verdict.of === final.winner), won.citations, rebuttalProof.get(won.position)))) invalid("final ruling: invalid: a flip rests on no supporting citation of the winner's rebuttal");
    }
  }
  const winner = governingWinner(ledger);
  if (complete && winner !== null && !backed.has(winner)) stale.push(`case ${winner}: the governing winner's case has no passing citation`);
  return { ledger, problems, escapes, stale };
}

export { decideVerdictProblems, firstRulingEntries };
