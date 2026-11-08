// `aidrian pr disposition`: the disposition of one review finding. Severity alone has no denominator: a contrived
// bypass and a main screen that breaks on a common phone both grade "high". This maps (severity, likelihood, affects,
// cost, phase) through finding-disposition.json, the only place the priority order lives, so a reviewer reports the
// axes and the table decides.
//
//   aidrian pr disposition --severity high --likelihood contrived --affects internal
//   aidrian pr disposition --severity medium --likelihood plausible --affects operators --source bot --round 6
//   aidrian pr disposition --vocab            # every word, defined
//
// Severity takes the reviewer scale (critical/high/medium/low) and the feedback scale (blocker/major/minor/nit).
// `affects` is the worst-hit audience. `cost` (trivial | bounded | structural) defaults to bounded. `round` is the
// review round the finding arrived in, for a bot finding only: `round` of `aidrian pr review`, or `codex_rounds` from
// `aidrian pr await-review` for the bot's own comments. From `lateRoundFrom` on, a medium, plausible finding for users
// or operators, unless its cost is trivial (still fix_now), and any low finding whatever its cost or citation
// (`lateRound`), become residuals instead of fixes.
// Output: { disposition, rule, reason }, one of fix_now | accepted_residual | drop_unless_cited | acceptable_as_is.
// A bot finding with no axis is acceptable_as_is until someone classifies it; a person's is needs_axis. Exit 2 when
// a word is not in the vocabulary.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

export const TABLE_PATH = path.join(import.meta.dirname, 'finding-disposition.json');
export const loadTable = () => JSON.parse(readFileSync(TABLE_PATH, 'utf8'));

const norm = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : undefined);
const severityOf = (value, table) => table.severitySynonyms?.[norm(value)] ?? norm(value);
const isLate = ({ source, round }, table) => source === 'bot' && Number.isInteger(round) && round >= (table.lateRoundFrom ?? Infinity);

// Every vocabulary word with its one-line definition, and its calibration examples when it has any.
export const vocabulary = (table = loadTable()) =>
  Object.fromEntries(
    [...table.severities, ...table.likelihoods, ...table.affects, ...(table.costs ?? []), ...(table.phases ?? []), ...new Set([...table.rules.map((r) => r.disposition), table.default, table.botSourceWithoutAxis, ...(table.lateRound ? [table.lateRound.disposition] : []), 'needs_axis'])]
      .map((w) => [w, table.examples?.[w] ? { definition: table.definitions[w] ?? null, examples: table.examples[w] } : (table.definitions[w] ?? null)]),
  );

// The late-round residual: from review round `lateRoundFrom`, a bot finding of a `lateRound` severity, with or without
// axes, cost, or citation. `{ disposition, rule, reason }`, or null when the rule does not apply. `round` is a number;
// the review step calls this for an exec reviewer's findings, which carry a severity and nothing else.
export const lateRoundResidual = ({ severity, source, round }, table = loadTable()) => {
  if (!table.lateRound || !isLate({ source, round }, table) || !table.lateRound.severities.includes(severityOf(severity, table))) return null;
  return { disposition: table.lateRound.disposition, rule: 'lateRound', reason: `a ${severityOf(severity, table)} bot finding from review round ${table.lateRoundFrom} on is a residual, whatever its cost or citation` };
};

// The decision; `table` defaults to the committed JSON.
export const decideDisposition = (input, table = loadTable()) => {
  const severity = severityOf(input.severity, table);
  const likelihood = norm(input.likelihood);
  const affects = norm(input.affects);
  const cost = norm(input.cost) ?? table.defaultCost;
  const source = norm(input.source) ?? 'human';
  const round = input.round === undefined ? undefined : Number(input.round);
  const bad = [];
  if (round !== undefined && !(Number.isInteger(round) && round >= 1 && source === 'bot')) bad.push('round (bot findings only)');
  if (!table.severities.includes(severity)) bad.push('severity');
  if (likelihood !== undefined && !table.likelihoods.includes(likelihood)) bad.push('likelihood');
  if (affects !== undefined && !table.affects.includes(affects)) bad.push('affects');
  if (!table.costs.includes(cost)) bad.push('cost');
  if (bad.length > 0) return { disposition: 'invalid', rule: null, reason: `invalid ${bad.join(', ')}` };
  const late = lateRoundResidual({ severity, source, round }, table);
  if (late) return late;
  if (likelihood === undefined || affects === undefined) {
    if (source === 'bot') {
      return { disposition: table.botSourceWithoutAxis, rule: 'botSourceWithoutAxis', reason: 'bot finding with no likelihood/affects axis stays acceptable as-is until classified' };
    }
    return { disposition: 'needs_axis', rule: null, reason: 'likelihood and affects are required' };
  }
  const phase = isLate({ source, round }, table) ? 'late' : 'early';
  const facts = { severity, likelihood, affects, cost, phase };
  for (const [i, rule] of table.rules.entries()) {
    if (Object.entries(rule.when).every(([k, vs]) => vs.includes(facts[k]))) return { disposition: rule.disposition, rule: i, reason: JSON.stringify(rule.when) };
  }
  return { disposition: table.default, rule: 'default', reason: 'no rule matched' };
};

// The CLI body.
export function runDisposition(args) {
  const word = { type: 'string' };
  const { values } = parseArgs({ args, options: { severity: word, likelihood: word, affects: word, source: word, cost: word, round: word, vocab: { type: 'boolean' } } });
  if (values.vocab) {
    console.log(JSON.stringify(vocabulary(), null, 2));
    return 0;
  }
  const out = decideDisposition(values);
  console.log(JSON.stringify(out));
  return out.disposition === 'invalid' ? 2 : 0;
}
