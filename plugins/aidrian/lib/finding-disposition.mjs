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
// An argument that starts with `--` and holds spaces is split into words first: zsh does not split a variable, so
// `aidrian pr disposition $flags` passes every flag as one argument.
//
//   aidrian pr disposition --manifest <state>/reviews/pr-42.json
//
// checks a pr-review manifest (skills/pr-review/references/manifest.md): every finding's `disposition` must be a value
// this table gives its axes, and every finding's axes must be in the vocabulary (manifestDrift). Output: { file, findings, drift: [{ id, disposition, expected }] }. Exit 0
// when none drifts, 1 when one does, 2 when the file does not read as a manifest. The file-write hook refuses a write
// that sets a drifting disposition (docs/hooks.md#review-dispositions).

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

// The dispositions this table gives one manifest finding's axes: the reading with no source, as the pr-review skill runs
// it, and, for a finding with a round, the reading of an agent's finding in that round (`--source bot --round`), which
// the late-round rule can change. `['invalid']` when its axes are not in the vocabulary.
export function toolValues(finding, table = loadTable()) {
  const axes = { severity: finding.severity, likelihood: finding.likelihood ?? undefined, affects: finding.affects ?? undefined, cost: finding.cost ?? undefined };
  const values = new Set([decideDisposition(axes, table).disposition]);
  if (Number.isInteger(finding.raised_in) && finding.raised_in >= 1) values.add(decideDisposition({ ...axes, source: 'bot', round: finding.raised_in }, table).disposition);
  return [...values];
}

// The findings of a review manifest whose `disposition` is not a value the table gives their axes, as
// [{ id, disposition, expected }]: a disposition set by hand, or kept after its axes changed. A finding whose axes are
// not in the vocabulary always drifts, with `expected` empty, whatever its disposition: only its axes can be fixed.
// A finding with no disposition yet is not judged. `manifest` is the parsed file; anything without a findings list has none.
export function manifestDrift(manifest, table = loadTable()) {
  const findings = Array.isArray(manifest?.findings) ? manifest.findings : [];
  const drift = [];
  for (const finding of findings) {
    if (finding === null || typeof finding !== 'object' || finding.disposition === undefined || finding.disposition === null) continue;
    const values = toolValues(finding, table);
    const expected = values.includes('invalid') ? [] : values;
    if (!expected.includes(finding.disposition)) drift.push({ id: finding.id ?? null, disposition: finding.disposition, expected });
  }
  return drift;
}

// Whether `file` is a review manifest or a temporary copy of one, as the pr-review skill writes them: a file in a
// `reviews` folder named pr-<n>.json, or a name that starts with it, with or without a leading dot, such as
// pr-42.json.tmp.
export const isManifestPath = (file) => path.basename(path.dirname(file)) === 'reviews' && /^\.?pr-\d+\.json(?:\.[\w.-]+)?$/u.test(path.basename(file));

// The refusal for a file write, as one message, or null. `writes` are { file, text, before } triples: `text` the
// file's content after the write, or null when the write does not show it (an apply_patch), and `before` its content
// before, or null for a new file. Such a write, a file that is no manifest, and text that does not parse are let
// through, as a hook lets through what it cannot read. Only drift the write brings is refused: a finding that drifted
// the same way before, with the same id, disposition, and axes, passes, so a run can still record its status. A new
// temporary copy is compared with the manifest beside it, pr-<n>.json, which it is written to replace.
export function manifestWriteProblem(writes, table = loadTable()) {
  const lines = [];
  for (const { file, text, before = null } of writes) {
    if (typeof text !== 'string' || !isManifestPath(file)) continue;
    const manifest = parsed(text);
    if (manifest === null) continue;
    const prior = parsed(before ?? siblingText(file));
    const known = new Set(manifestDrift(prior, table).map((entry) => driftKey(entry, prior)));
    for (const entry of manifestDrift(manifest, table)) {
      if (known.has(driftKey(entry, manifest))) continue;
      const want = entry.expected.length ? `where its axes give ${entry.expected.join(' or ')}` : 'and its axes are not in the vocabulary (`aidrian pr disposition --vocab`)';
      lines.push(`  ${path.basename(file)} ${entry.id ?? '(no id)'}: ${JSON.stringify(entry.disposition)}, ${want}`);
    }
  }
  if (!lines.length) return null;
  return [
    'Blocked: this write sets a review disposition that `aidrian pr disposition` does not give the finding\'s axes:',
    ...lines,
    'Run `aidrian pr disposition` with the finding\'s severity, likelihood, affects, and cost, each flag its own word, and write the disposition it prints.',
    'A disposition that looks wrong means its axes are wrong: change the axes, never the disposition alone.',
  ].join('\n');
}

const parsed = (text) => {
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// The text of the manifest a temporary copy replaces, or null for the manifest itself or one not there.
function siblingText(file) {
  const name = /^\.?(pr-\d+\.json)/u.exec(path.basename(file))?.[1];
  if (!name || name === path.basename(file)) return null;
  try {
    return readFileSync(path.join(path.dirname(file), name), 'utf8');
  } catch {
    return null;
  }
}

// What makes one drift the same before and after a write: the finding's id, its disposition, and its axes.
function driftKey({ id, disposition }, manifest) {
  const finding = (manifest?.findings ?? []).find((each) => each?.id === id) ?? {};
  return JSON.stringify([id, disposition, finding.severity, finding.likelihood, finding.affects, finding.cost, finding.raised_in]);
}

// One flag word per argument: an argument that starts with `--` and holds whitespace, as zsh passes an unsplit variable,
// becomes its words. A value never holds a space: every one is a vocabulary word, a number, or a path with none.
export const splitFlagWords = (args) => args.flatMap((arg) => (arg.startsWith('--') && /\s/u.test(arg) ? arg.trim().split(/\s+/u) : [arg]));

// The CLI body.
export function runDisposition(args) {
  const word = { type: 'string' };
  const { values } = parseArgs({ args: splitFlagWords(args), options: { severity: word, likelihood: word, affects: word, source: word, cost: word, round: word, manifest: word, vocab: { type: 'boolean' } } });
  if (values.vocab) {
    console.log(JSON.stringify(vocabulary(), null, 2));
    return 0;
  }
  if (values.manifest !== undefined) return checkManifest(values.manifest);
  const out = decideDisposition(values);
  console.log(JSON.stringify(out));
  return out.disposition === 'invalid' ? 2 : 0;
}

// `--manifest FILE`: exit 0 when every disposition is the table's, 1 when one drifts, 2 when the file is no manifest.
function checkManifest(file) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`aidrian pr disposition: ${file} does not read as JSON: ${error.message}`);
    return 2;
  }
  if (!Array.isArray(manifest?.findings)) {
    console.error(`aidrian pr disposition: ${file} has no findings list`);
    return 2;
  }
  const drift = manifestDrift(manifest);
  console.log(JSON.stringify({ file, findings: manifest.findings.length, drift }));
  return drift.length ? 1 : 0;
}
