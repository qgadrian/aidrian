// The plan-mode checks of `aidrian quorum check`: objection ids, the Human's answers, merges, the mode rules, a complete
// ledger, and checkLedger, which checks every citation of a plan ledger in place.

import { citationKey, collapse, passing, shown } from './citations.mjs';
import { carriesMode } from './ledger.mjs';
import { MAX_MODE_OBJECTIONS } from './plan-schema.mjs';
import { coverageProblem, inferenceEvidenceProblems, inferenceProblems, supported } from './verdicts.mjs';

// The objection ids the coordinator writes: A1 to A7 for adversary A, B1 to B7 for B. check prints ids in its lines,
// so any other id, as one holding a newline that would forge a line, stops the check.
export const OBJECTION_ID = /^[AB][1-7]$/u;

// A repeated id is refused too: a Human answer, a rebuttal, or a ruling names its objection by id alone.
export function idProblems(ledger) {
  const ids = ledger.objections.map((objection) => objection.id);
  const bad = ids.filter((id) => !OBJECTION_ID.test(id)).map((id) => `objection id "${shown(id)}" is not A1 to A7 or B1 to B7`);
  const twice = [...new Set(ids.filter((id, i) => OBJECTION_ID.test(id) && ids.indexOf(id) !== i))].map((id) => `objection id ${id} is used more than once`);
  return [...bad, ...twice];
}

// Why the Human's answers do not fit the ledger: an answer for an objection the ledger does not hold, or two answers
// for one objection.
export function answerProblems(ledger) {
  const known = new Set(ledger.objections.map((objection) => objection.id));
  const ids = ledger.human_answers.map((answer) => answer.objection_id);
  const problems = [];
  for (const id of new Set(ids.filter((id) => !known.has(id)))) problems.push(`human_answers names ${id}, not an objection in this ledger`);
  for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) problems.push(`human_answers answers ${id} more than once`);
  return problems;
}

// A citation as a merge copies it: kind, ref, and the quote with whitespace collapsed.
const copyKey = (citation) => `${citation.kind}\0${citation.ref}\0${collapse(citation.quote)}`;

// Why a merged objection does not fit, in any ledger: a merged objection is neither ruled nor rebutted, and names in
// `merged_into` a live objection of the other adversary, one neither merged nor an opinion, whose `citations` hold
// each of its own, so the architect's `tested` covers them. An objection that names `merged_into` is merged. Run after
// idProblems: these lines print ids.
export function mergeProblems(ledger) {
  const byId = new Map(ledger.objections.map((objection) => [objection.id, objection]));
  return ledger.objections.flatMap((objection) => {
    const where = `objection ${objection.id}`;
    const into = objection.merged_into ?? null;
    if (objection.status !== 'merged') return into === null ? [] : [`${where} names merged_into ${shown(into)} but is ${objection.status}, not merged`];
    const problems = [];
    if (objection.ruling !== null) problems.push(`${where} is merged but has a ruling`);
    if (objection.rebuttal !== null) problems.push(`${where} is merged but has a rebuttal`);
    const survivor = byId.get(into);
    if (into === null) problems.push(`${where} is merged into no objection`);
    else if (!survivor) problems.push(`${where} is merged into ${shown(into)}, not an objection in this ledger`);
    else if (survivor.by === objection.by) problems.push(`${where} is merged into ${into}, an objection of the same adversary`);
    else if (survivor.status === 'merged' || survivor.status === 'opinion') problems.push(`${where} is merged into ${into}, which is ${survivor.status}`);
    if (survivor) {
      const held = new Set(survivor.citations.map(copyKey));
      objection.citations.forEach((citation, i) => {
        if (!held.has(copyKey(citation))) problems.push(`${where} is merged into ${into}, which lacks its citation ${i}`);
      });
    }
    return problems;
  });
}

// Whether the objection's first or final ruling accepts: a change the plan takes on.
const accepts = (objection) => objection.ruling?.decision === 'accept' || objection.rebuttal?.ruling?.decision === 'accept';

// What a ledger that carries `mode` must hold beyond the old rules, as lines that stop the check: at most
// `maxObjections` objections per adversary (config.json `quorum.plan.maxObjections` while it is open, the ceiling
// MAX_MODE_OBJECTIONS once complete), no `improvement` (it goes to `notes`), and the proportionality pass:
// present in a complete ledger with an accepted change, and each flagged objection one with an accept ruling that the
// Human holds, `escalated` or answered. A failed pass flags nothing, in any ledger. An `open` ledger without `mode`
// stops the check too. [] for a complete ledger without `mode` that holds no failed pass with flags.
export function modeProblems(ledger, maxObjections = MAX_MODE_OBJECTIONS) {
  const failed = ledger.proportionality?.failed === true && ledger.proportionality.flagged.length > 0;
  const problems = failed ? [`proportionality: failed, yet flags ${ledger.proportionality.flagged.length} objections`] : [];
  if (!carriesMode(ledger)) {
    // A legacy ledger is a complete one; the coordinator writes `mode` on every ledger it opens.
    if (ledger.status === 'open') problems.push('mode: missing in an open plan ledger');
    return problems;
  }
  for (const by of ['A', 'B']) {
    const count = ledger.objections.filter((objection) => objection.by === by).length;
    if (count > maxObjections) problems.push(`${by} raised ${count} objections, more than the ${maxObjections} quorum.plan.maxObjections allows in a ledger with a mode`);
  }
  for (const objection of ledger.objections) {
    if (objection.severity === 'improvement') problems.push(`objection ${objection.id} is an improvement, which goes to notes in a ledger with a mode`);
  }
  const proportionality = ledger.proportionality ?? null;
  if (proportionality === null) {
    if (ledger.status === 'complete' && ledger.objections.some(accepts)) problems.push('proportionality: missing in a complete ledger with accepted changes');
    return problems;
  }
  const byId = new Map(ledger.objections.map((objection) => [objection.id, objection]));
  const answered = new Set(ledger.human_answers.map((answer) => answer.objection_id));
  for (const { objection_id: id } of proportionality.flagged) {
    const objection = byId.get(id);
    if (!objection || !accepts(objection)) problems.push(`proportionality: flagged ${shown(id)} is not an objection with an accept ruling`);
    else if (objection.status !== 'escalated' && !answered.has(id)) problems.push(`proportionality: flagged ${id} is ${objection.status}, neither escalated nor answered in human_answers`);
  }
  return problems;
}

// The status each decision gives an objection.
const DECIDED = Object.freeze({ accept: 'accepted', reject: 'rejected', escalate: 'escalated' });

// The problems that make a `complete` ledger unfinished: an objection still pending, or one with a status that needs a
// ruling and has none. For an objection the Human did not settle (not `escalated`, not answered), also: a rebuttal that
// rebuts with no final ruling, a final ruling other than `accept` (any other escalates), or a status that is not the
// one its final decision gives (the final ruling's; else the first ruling's, which a concession keeps), or a rejection
// with no rebuttal or concession, which escalates instead. An opinion or a merged objection is never ruled on. [] for
// an `open` ledger.
export function completeProblems(ledger) {
  if (ledger.status !== 'complete') return [];
  const answered = new Set(ledger.human_answers.map((answer) => answer.objection_id));
  return ledger.objections.flatMap((objection) => {
    const where = `objection ${objection.id}`;
    if (objection.status === 'pending') return [`${where} is pending in a complete ledger`];
    const unruled = objection.status === 'opinion' || objection.status === 'merged';
    if (!unruled && objection.ruling === null) return [`${where} is ${objection.status} with no ruling in a complete ledger`];
    if (unruled || objection.status === 'escalated' || answered.has(objection.id)) return [];
    const { rebuttal } = objection;
    if (rebuttal?.verdict === 'rebut' && rebuttal.ruling === null) return [`${where} has a rebuttal with no final ruling in a complete ledger`];
    if (rebuttal?.ruling && rebuttal.ruling.decision !== 'accept') return [`${where} has a final ruling of ${rebuttal.ruling.decision} but is ${objection.status}, not escalated, in a complete ledger`];
    const decided = DECIDED[(rebuttal?.ruling ?? objection.ruling).decision];
    if (objection.status !== decided) return [`${where} is ${objection.status}, but its final decision makes it ${decided}, in a complete ledger`];
    // A rejection stands only once its adversary conceded or lost the final ruling: one never answered escalates.
    if (objection.status === 'rejected' && rebuttal === null) return [`${where} is rejected with no rebuttal or concession in a complete ledger`];
    return [];
  });
}

// Why a ruling on a ledger that carries `mode` is invalid beyond its citations, one reason per line: `entry` is what it
// rules on (the objection for the first ruling, the rebuttal for the final one), `proof` the ruling's own passing
// citations, and `backing` the entry's. An accept changes a plan section, so it cites one, and rests on a citation of
// the entry that passes and that the judge found supporting; `tested`
// names every citation of the entry once; every `inference:` line of the entry's claim has its own `inferences` entry,
// one whose statement the line holds; a reject names its ground and nothing else does; the reason opens with `Covers: `; and an
// accept states its `Cost: ` and the risk it `Removes: `. Whether a verdict is right is the judge's, never a script's.
function verdictProblems(value, entry, proof, backing) {
  const problems = [];
  const accept = value.decision === 'accept';
  if (accept && !proof.some((citation) => citation.kind === 'plan')) problems.push('an accept cites no plan section');
  const tested = value.tested ?? [];
  const coverage = coverageProblem(tested.map((verdict) => verdict.citation), entry.citations.length);
  if (coverage) problems.push(coverage);
  if (accept && !supported(tested, entry.citations, backing)) problems.push('an accept rests on no supporting citation');
  problems.push(...inferenceProblems([entry.claim], value.inferences));
  if (value.decision === 'reject' && value.ground === undefined) problems.push('a reject names no ground');
  if (value.decision !== 'reject' && value.ground !== undefined) problems.push(`ground on an ${value.decision}`);
  if (!/^Covers: /u.test(value.change_or_reason)) problems.push('no Covers line');
  if (accept && !(/^Cost: .+$/mu.test(value.change_or_reason) && /^Removes: .+$/mu.test(value.change_or_reason))) problems.push('an accept states no cost or removed risk');
  return problems;
}

// Checks a ledger in place: { ledger, problems, escapes, stale }. `stale` lists each invalid ruling or rebuttal of a
// complete ledger on an objection the Human did not settle. `problems` lists each failed citation, relabel, and
// invalid ruling or rebuttal with its reason, and each note removed; `escapes` lists each ref path outside the root,
// for a warning. An escape is also a failed citation in `problems`. On a ledger that carries `mode`, a ruling is also
// held to verdictProblems, and a concession needs a passing citation.
export function checkLedger(ledger, ctx) {
  const problems = [];
  const escapes = [];
  const pass = (list, where) => passing(list, where, ctx, problems, escapes);
  const strict = carriesMode(ledger);
  // In a `complete` ledger, an invalid ruling or rebuttal on an objection the Human did not settle (not `escalated`, no
  // answer) is stale: its evidence changed after the ledger was finished, so reusing it would skip the retry or the
  // escalation it now needs. Those lines go to `stale` as well, and `check` refuses the ledger. An unflagged valid
  // partial accept's first ruling (`accept` with a rebuttal) is stale even on a settled objection: its accepted part
  // always stands, and the Human's answer covers only the rejected part. A proportionality flag escalates the accepted
  // part too, so a flagged objection's first ruling is the Human's, answered or deferred, as any escalation is.
  const answered = new Set(ledger.human_answers.map((answer) => answer.objection_id));
  const flagged = new Set((ledger.proportionality?.flagged ?? []).map((flag) => flag.objection_id));
  const stale = [];
  const invalid = (objection, line, stands = false) => {
    problems.push(line);
    if (ledger.status === 'complete' && (stands || (objection.status !== 'escalated' && !answered.has(objection.id)))) stale.push(line);
  };
  const ruling = (objection, value, where, entry, backing, stands = false) => {
    if (!value) return;
    const proof = pass(value.citations, where);
    if (!proof.length) invalid(objection, `${where}: invalid: the ruling has no passing citation`, stands);
    if (strict) for (const reason of verdictProblems(value, entry, proof, backing)) invalid(objection, `${where}: invalid: ${reason}`, stands);
    for (const reason of inferenceEvidenceProblems(value.inferences, where, pass)) invalid(objection, `${where}: invalid: ${reason}`, stands);
  };
  // What a rebuttal must add to: what the ledger held before the rebuttal round, every objection's citations and every
  // first ruling's. Rebuttals and their rulings are left out, so two rebuttals that bring the same new evidence are both new.
  const cited = new Set(ledger.objections.flatMap((objection) => [...objection.citations, ...(objection.ruling?.citations ?? [])]).map(citationKey));
  const relabel = (objection) => {
    problems.push(`objection ${objection.id}: relabeled opinion (was pending): no citation passes`);
    objection.status = 'opinion';
  };
  // The objections no citation backs, and those relabeled opinion in this check.
  const unbacked = new Set();
  const relabeled = new Set();
  for (const objection of ledger.objections) {
    const where = `objection ${objection.id}`;
    // Only a `pending` objection becomes an opinion. One the architect or the Human already ruled on keeps its status
    // when its citations stop passing, as after the cited code changed, and is named: a reused ledger never loses it.
    const backing = pass(objection.citations, where);
    if (!backing.length) unbacked.add(objection.id);
    if (unbacked.has(objection.id) && objection.status !== 'opinion') {
      if (objection.status === 'pending') {
        relabel(objection);
        relabeled.add(objection.id);
      } else if (objection.status === 'merged') problems.push(`${where}: no citation passes; kept merged into ${objection.merged_into}`);
      else problems.push(`${where}: no citation passes; kept ${objection.status}, since it was ruled on`);
    }
    const stands = objection.ruling?.decision === 'accept' && objection.rebuttal !== null && !flagged.has(objection.id);
    ruling(objection, objection.ruling, `${where} ruling`, objection, backing, stands);
    const rebuttal = objection.rebuttal;
    if (rebuttal) {
      // A rebuttal needs a passing citation the ledger does not already hold. A concession needs none on a ledger
      // without `mode`; with it, one passing citation, the ruling's own included, since it cites what it accepts.
      const proof = pass(rebuttal.citations, `${where} rebuttal`);
      if (rebuttal.verdict === 'rebut') {
        if (!proof.length) invalid(objection, `${where} rebuttal: invalid: the rebuttal has no passing citation`);
        else if (proof.every((citation) => cited.has(citationKey(citation)))) invalid(objection, `${where} rebuttal: invalid: the rebuttal cites nothing new`);
      } else if (strict && !proof.length) invalid(objection, `${where} rebuttal: invalid: the concession has no passing citation`);
      ruling(objection, rebuttal.ruling, `${where} rebuttal ruling`, rebuttal, proof);
    }
  }
  // A survivor that became an opinion is never ruled on, so what was merged into it would be lost: each objection merged
  // into one goes back to `pending`, and becomes an opinion when none of its citations passes, which mergeProblems makes
  // the case, since the survivor holds them all.
  for (const objection of ledger.objections) {
    if (objection.status !== 'merged' || !relabeled.has(objection.merged_into)) continue;
    problems.push(`objection ${objection.id}: unmerged: ${objection.merged_into} became an opinion`);
    objection.status = 'pending';
    objection.merged_into = null;
    if (unbacked.has(objection.id)) relabel(objection);
  }
  // A note no citation backs is removed: no one rules on a note, so nothing else would drop it from the report.
  if (ledger.notes) {
    ledger.notes = ledger.notes.filter((note, i) => {
      if (pass(note.citations, `notes[${i}]`).length) return true;
      problems.push(`notes[${i}] (by ${note.by}): removed: no citation passes`);
      return false;
    });
  }
  return { ledger, problems, escapes, stale };
}
