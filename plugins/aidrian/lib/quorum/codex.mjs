// `aidrian quorum codex`: runs Codex as adversary B or as a position, holds its answer to the schema of its mode, and
// fits it to the ledger it answers.

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { isolate } from '../review/env.mjs';
import { codexAvailable, runCodex } from '../review/reviewers.mjs';
import { CASE_SCHEMA, CROSS_SCHEMA, DECIDE_REBUTTAL_SCHEMA } from './decide-schema.mjs';
import { carriesMode, modeOf, schemaOf, schemaProblems } from './ledger.mjs';
import { OBJECTIONS_SCHEMA, REBUTTALS_SCHEMA } from './plan-schema.mjs';

// Codex's time for one adversary pass; the coordinator's shell timeout (15 minutes) stays above it.
export const CODEX_TIMEOUT_SEC = 780;

// Why a rebuttals answer does not fit `ledger`, as one line per problem: an id named twice; an id that is not one of B's
// objections ruled `reject` or `accept` (a partial accept's rebuttal covers its rejected part) and not `escalated`, since
// an escalated objection goes to the Human and gets no rebuttal; or one of B's objections with status `rejected` and no
// entry; or, in a ledger that carries `mode`, a concession that cites nothing. [] when it fits.
export function rebuttalProblems(answer, ledger) {
  const ids = answer.rebuttals.map((entry) => entry.objection_id);
  const answerable = ledger.objections.filter((each) => each.by === 'B' && ['reject', 'accept'].includes(each.ruling?.decision) && each.status !== 'escalated');
  const open = new Set(answerable.map((each) => each.id));
  const twice = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  const unknown = [...new Set(ids.filter((id) => !open.has(id)))];
  const missing = answerable.filter((each) => each.status === 'rejected' && !ids.includes(each.id)).map((each) => each.id);
  const problems = [];
  if (twice.length) problems.push(`the answer names ${twice.join(', ')} more than once`);
  if (unknown.length) problems.push(`the answer names ${unknown.join(', ')}, not B's objection ruled reject or accept, and not escalated, in the ledger`);
  if (missing.length) problems.push(`the answer has no entry for ${missing.join(', ')}, B's objection rejected in the ledger`);
  const bare = carriesMode(ledger) ? answer.rebuttals.filter((entry) => entry.verdict === 'concede' && !entry.citations.length).map((entry) => entry.objection_id) : [];
  if (bare.length) problems.push(`the answer concedes ${bare.join(', ')} with no citation, which a ledger with a mode needs`);
  return problems;
}

// Why a cross-examination answer does not fit a decide ledger: a point against a position the ledger does not hold.
// Whether it is against Codex's own position the command cannot tell, so the coordinator drops such a point.
export function crossProblems(answer, ledger) {
  const positions = new Set(ledger.positions.map((position) => position.id));
  const unknown = [...new Set(answer.cross.map((point) => point.against).filter((id) => !positions.has(id)))];
  return unknown.length ? [`the answer cross-examines ${unknown.join(', ')}, not a position in the ledger`] : [];
}

// Why a decide-mode rebuttal answer does not fit: a concession cites the ruling's evidence it accepts.
export function decideRebuttalProblems(answer) {
  const { verdict, citations } = answer.rebuttal;
  return verdict === 'concede' && !citations.length ? ['the answer concedes with no citation, which a decide ledger needs'] : [];
}

// `aidrian quorum codex --mode`: the schema Codex's answer is held to, the field the done line counts (`noun` names
// what it counts), whether the answer must fit a ledger, and how it must fit one. `rebut` on a decide ledger is
// DECIDE_REBUT; `cross` answers a decide ledger only.
const MODES = Object.freeze({
  object: { schema: OBJECTIONS_SCHEMA, key: 'objections' },
  rebut: { schema: REBUTTALS_SCHEMA, key: 'rebuttals', ledger: true, fit: rebuttalProblems },
  case: { schema: CASE_SCHEMA, key: 'case' },
  cross: { schema: CROSS_SCHEMA, key: 'cross', noun: 'cross points', ledger: true, fit: crossProblems },
});
const DECIDE_REBUT = Object.freeze({ schema: DECIDE_REBUTTAL_SCHEMA, key: 'rebuttal', fit: decideRebuttalProblems });
const MODE_NAMES = `${Object.keys(MODES).slice(0, -1).join(', ')}, or ${Object.keys(MODES).at(-1)}`;
const LEDGER_MODES = Object.keys(MODES).filter((mode) => MODES[mode].ledger).join(' or ');

// `aidrian quorum codex`: { status, reason } where status is done, unavailable, failed, quota, or timed_out. `mode`
// (a key of MODES) picks the schema; `rebut` and `cross` also need `ledger`, the ledger file the answer must fit, whose
// mode picks the rebuttal schema. `deps` replaces Codex in tests: { spawnImpl, codex (codexAvailable), timeoutSec }.
export async function codexAnswer({ plan, brief, out, root, mode = 'object', ledger = null }, { spawnImpl = spawn, codex = codexAvailable, timeoutSec = CODEX_TIMEOUT_SEC } = {}) {
  if (!Object.hasOwn(MODES, mode)) return { status: 'failed', reason: `"${mode}" is not a mode: ${MODE_NAMES}` };
  if (MODES[mode].ledger && !ledger) return { status: 'failed', reason: `--mode ${mode} needs a ledger` };
  const ready = codex();
  if (!ready.ok) return { status: 'unavailable', reason: ready.reason };
  // A file that cannot be read or written is a failed run, so the command still prints its one line.
  try {
    // The ledger is read and checked before Codex starts, so a bad one costs no Codex run.
    let spec = MODES[mode];
    let fits = null;
    if (spec.ledger) {
      fits = JSON.parse(readFileSync(ledger, 'utf8'));
      const invalid = schemaProblems(fits, schemaOf(fits));
      if (invalid.length) return { status: 'failed', reason: `the ledger does not follow the schema: ${invalid[0]}` };
      if (modeOf(fits) === 'product') return { status: 'failed', reason: `--mode ${mode} does not answer a product ledger` };
      const decide = modeOf(fits) === 'decide';
      if (mode === 'cross' && !decide) return { status: 'failed', reason: '--mode cross answers a decide ledger, and this ledger is in plan mode' };
      if (mode === 'rebut' && decide) spec = DECIDE_REBUT;
    }
    const { schema, key, noun = key, fit } = spec;
    const prompt = `${readFileSync(brief, 'utf8').trimEnd()}\n\n${readFileSync(plan, 'utf8')}`;
    const result = await runCodex({ root, env: isolate({ ...process.env }), schema, prompt, timeoutSec, spawnImpl });
    if (result.status !== 'done') return { status: result.status, reason: result.reason };
    const problems = schemaProblems(result.raw, schema);
    if (problems.length) return { status: 'failed', reason: `the answer does not follow the schema: ${problems[0]}` };
    const misfits = fit ? fit(result.raw, fits) : [];
    if (misfits.length) return { status: 'failed', reason: `the answer does not fit the ledger: ${misfits.join('; ')}` };
    mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    writeFileSync(out, `${JSON.stringify(result.raw, null, 2)}\n`);
    const answered = result.raw[key];
    return { status: 'done', reason: `${Array.isArray(answered) ? answered.length : 1} ${noun} written to ${out}` };
  } catch (error) {
    return { status: 'failed', reason: error.message };
  }
}

export { LEDGER_MODES, MODE_NAMES, MODES };
