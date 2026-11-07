// The judge's verdicts every mode shares: `inference:` lines and their tests, and the coverage of `tested`.

import { collapse, shown } from './citations.mjs';

// An `inference:` line of a claim: a statement its author could not cite, for the judge to test. The spaces around the
// label stay on its line, and the statement starts with a non-space, so a bare `inference:`, or one followed by spaces
// only, is no inference and never takes the next line as its statement.
const INFERENCE = /^[^\S\n]*inference:[^\S\n]*(\S.*)$/gimu;

// The `inference:` lines of `lines` that no distinct statement tests: each statement settles one line, matched to the
// lines whose text holds it by augmenting paths, so one entry never answers two lines and no order of entries loses a fit.
function untestedLines(lines, statements) {
  const fits = lines.map((line) => statements.flatMap((statement, j) => (line.includes(statement) ? [j] : [])));
  const owner = statements.map(() => -1);
  const take = (i, seen) => fits[i].some((j) => {
    if (seen.has(j)) return false;
    seen.add(j);
    if (owner[j] !== -1 && !take(owner[j], seen)) return false;
    owner[j] = i;
    return true;
  });
  return lines.filter((_, i) => !take(i, new Set()));
}

// Why `named`, the citation indexes a ruling's `tested` gives an entry of `count` citations, does not name each exactly
// once, or null. `of` names the entry in a ruling over several.
function coverageProblem(named, count, of = '') {
  const inRange = (index) => index >= 0 && index < count;
  const once = named.filter((index) => inRange(index) && named.indexOf(index) === named.lastIndexOf(index)).length;
  const twice = [...new Set(named.filter((index, i) => inRange(index) && named.indexOf(index) !== i))];
  const outside = [...new Set(named.filter((index) => !inRange(index)))];
  if (once === count && !twice.length && !outside.length) return null;
  return `tested names ${once} of ${count} citations${of}${twice.length ? `; ${twice.join(', ')} more than once` : ''}${outside.length ? `; ${outside.join(', ')} out of range` : ''}`;
}

// Whether `tested` finds one of an entry's `citations` supporting that also passes now, one of `proof`: a verdict on a
// citation that stopped passing supports nothing.
const supported = (tested, citations, proof) => tested.some((verdict) => verdict.supports === true && Number.isInteger(verdict.citation) && proof.includes(citations[verdict.citation]));

// One line for each `inference:` line of `claims` that no distinct `inferences` statement tests.
export function inferenceProblems(claims, inferences) {
  // A judge retypes these lines, so a curly quote may come back straight. Only here: a citation's quote stays exact.
  const plain = (text) => collapse(text).replace(/[\u2018\u2019]/gu, "'").replace(/[\u201C\u201D]/gu, '"');
  const statements = (inferences ?? []).map((inference) => plain(inference.statement)).filter(Boolean);
  const lines = claims.flatMap((claim) => [...String(claim).matchAll(INFERENCE)].map(([, line]) => plain(line)));
  return untestedLines(lines, statements).map((text) => shown(`inference untested: "${text.slice(0, 60)}"`));
}

// The evidence of a ruling's `inferences`, on every ruling, first or final, in either mode: each citation goes through
// `pass` as every other citation does, named under `<where>.inferences[i]` when it fails, and an inference that holds
// rests on one that passes. One line for each that holds on none; one that does not hold may cite nothing.
function inferenceEvidenceProblems(inferences, where, pass) {
  return (inferences ?? []).flatMap((inference, i) => {
    const proof = pass(inference.citations, `${where}.inferences[${i}]`);
    return inference.holds === true && !proof.length ? [shown(`inference "${collapse(inference.statement).slice(0, 60)}" holds on no passing citation`)] : [];
  });
}

export { coverageProblem, inferenceEvidenceProblems, supported };
