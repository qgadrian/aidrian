// `aidrian quorum`: the deterministic part of the expert quorum. In plan mode, two adversaries attack a plan with cited
// objections and an architect rules on each one; in decide mode, two to four positions argue a question with cited
// cases and cross-examination, and an architect rules on the question.
//   codex   runs Codex as adversary B or as a position, held to OBJECTIONS_SCHEMA (`--mode object`, the default), to
//           CASE_SCHEMA (`--mode case`), to CROSS_SCHEMA and a decide ledger (`--mode cross`), or, to answer the
//           architect's rulings in a ledger, to REBUTTALS_SCHEMA or DECIDE_REBUTTAL_SCHEMA by that ledger's mode
//           (`--mode rebut`), and prints one { status, reason } line
//   check   checks every citation of a ledger against the repository and the plan (the question file in decide mode),
//           relabels a `pending` objection or cross point by whether a citation passes, removes a note with none, and
//           names each ruling or rebuttal with no passing citation; on a ledger that carries `mode`, also the judge's
//           verdicts and, in plan mode, the moderation lines and, on an open ledger, the objection cap from
//           config.json `quorum.plan.maxObjections`
//   roles   prints the roles, judge, and caps of one mode from config.json `quorum`, as one JSON line
// The schemas below are the one source of truth for these files. `check` runs no command but `git ls-files`, and
// never executes what a citation names.

import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { commandConfig, MAX_PLAN_OBJECTIONS } from './config.mjs';
import { insidePath, isFile, isObject, linksOutside } from './fs.mjs';
import { runGit } from './git.mjs';
import { projectAt } from './project.mjs';
import { isolate } from './review/env.mjs';
import { anchor as anchorOf, sectionOf, slug } from './review/flows.mjs';
import { codexAvailable, runCodex } from './review/reviewers.mjs';

export const CITATION_KINDS = Object.freeze(['doc', 'adr', 'code', 'plan', 'absence']);
export const SEVERITIES = Object.freeze(['blocking', 'important', 'improvement']);
// The objection statuses: `pending` until the architect rules, `opinion` when no citation passes, `merged` when the
// coordinator folds it into the other adversary's duplicate.
export const OBJECTION_STATUSES = Object.freeze(['pending', 'opinion', 'accepted', 'rejected', 'escalated', 'merged']);
export const MAX_OBJECTIONS = 7;
// A ledger that carries `mode` holds at most config.json `quorum.plan.maxObjections` objections per adversary, and this
// is that key's ceiling; the rest of what Codex may answer (OBJECTIONS_SCHEMA keeps MAX_OBJECTIONS) the coordinator
// moves to `notes` or drops.
export const MAX_MODE_OBJECTIONS = MAX_PLAN_OBJECTIONS;
export const MAX_NOTES = 10;
// Why the judge rejects an objection, one per reject, on a ledger that carries `mode`.
export const GROUNDS = Object.freeze(['covered', 'implementation', 'settled', 'off-goal', 'disproportionate', 'speculative']);
export const MAX_QUOTE = 200;
// Codex's time for one adversary pass; the coordinator's shell timeout (15 minutes) stays above it.
export const CODEX_TIMEOUT_SEC = 780;
// The variables that change how git reads a pathspec. `check` passes --literal-pathspecs, which git refuses beside any
// of the others, so its one `git ls-files` call runs without them.
const PATHSPEC_VARS = Object.freeze(['GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS', 'GIT_LITERAL_PATHSPECS']);

// Codex holds its answer to the schema strictly: every property required, no other allowed, as FINDINGS_SCHEMA.
const CITATION = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'ref', 'quote'],
  properties: {
    kind: { type: 'string', enum: CITATION_KINDS },
    ref: { type: 'string' },
    quote: { type: 'string' },
  },
});
const CITATIONS = Object.freeze({ type: 'array', items: CITATION });
// Where a role ran: a host agent, or Codex.
const RUNNER = Object.freeze({ type: 'string', enum: ['agent', 'codex'] });

// What adversary B (Codex) answers: at most MAX_OBJECTIONS objections, each with its citations.
export const OBJECTIONS_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['objections'],
  properties: {
    objections: {
      type: 'array',
      maxItems: MAX_OBJECTIONS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'claim', 'citations'],
        properties: {
          severity: { type: 'string', enum: SEVERITIES },
          claim: { type: 'string' },
          citations: CITATIONS,
        },
      },
    },
  },
});

export const VERDICTS = Object.freeze(['rebut', 'concede']);

// What adversary B (Codex) answers to the architect's rulings: one rebuttal or concession per objection, named by its
// ledger id, at most one per id (rebuttalProblems checks the ids). An entry without `objection_id` is the ledger's
// `rebuttal` before its ruling, field for field. A concession may cite nothing only on a ledger without `mode`.
export const REBUTTALS_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['rebuttals'],
  properties: {
    rebuttals: {
      type: 'array',
      maxItems: MAX_OBJECTIONS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['objection_id', 'verdict', 'claim', 'citations'],
        properties: {
          objection_id: { type: 'string' },
          verdict: { type: 'string', enum: VERDICTS },
          claim: { type: 'string' },
          citations: CITATIONS,
        },
      },
    },
  },
});

// The judge's verdict on one citation, by its index in the ruled entry's citations, and on one `inference:` line.
const CITATION_VERDICT = Object.freeze({ citation: { type: 'integer' }, supports: { type: 'boolean' }, reason: { type: 'string' } });
const INFERENCES = Object.freeze({
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['statement', 'holds', 'reason', 'citations'],
    properties: { statement: { type: 'string' }, holds: { type: 'boolean' }, reason: { type: 'string' }, citations: CITATIONS },
  },
});

// `tested`, `inferences`, and `ground` are the judge's verdicts: optional, since a ledger written before `mode` has
// none, and required by checkLedger on a ledger that carries `mode`.
const RULING = Object.freeze({
  type: ['object', 'null'],
  additionalProperties: false,
  required: ['decision', 'change_or_reason', 'citations'],
  properties: {
    decision: { type: 'string', enum: ['accept', 'reject', 'escalate'] },
    change_or_reason: { type: 'string' },
    citations: CITATIONS,
    tested: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['citation', 'supports', 'reason'], properties: CITATION_VERDICT } },
    inferences: INFERENCES,
    ground: { type: 'string', enum: GROUNDS },
  },
});

// The objection ledger, `<state>/quorum/<name>-<plan-hash>.json`: `<name>` is the plan's file name without `.md`, or
// `<parent-folder>-plan` for a file named `plan.md`. `mode`, `runners`, `notes`, `merged_into`, and `proportionality` are optional:
// a ledger written before `mode` has none of them, and check never adds one. `notes` comes after `objections`, so the
// citation shape is described at `objections[].citations` (the ledger.md test expands a shared node at its first place).
export const LEDGER_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['status', 'plan', 'plan_hash', 'same_model', 'same_model_reason', 'trigger', 'objections', 'human_answers'],
  properties: {
    mode: { type: 'string', enum: ['plan'] },
    status: { type: 'string', enum: ['open', 'complete'] },
    plan: { type: 'string' },
    plan_hash: { type: 'string' },
    same_model: { type: 'boolean' },
    same_model_reason: { type: ['string', 'null'] },
    // Each adversary's final runner: `codex` while every run of it went to Codex, `agent` once one did not. A has no
    // Codex path (`--mode rebut` answers only B's objections), so it is always `agent`.
    runners: { type: 'object', additionalProperties: false, required: ['A', 'B'], properties: { A: { type: 'string', enum: ['agent'] }, B: RUNNER } },
    trigger: { type: 'string' },
    objections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'by', 'severity', 'claim', 'citations', 'status', 'ruling', 'rebuttal'],
        properties: {
          id: { type: 'string' },
          by: { type: 'string', enum: ['A', 'B'] },
          severity: { type: 'string', enum: SEVERITIES },
          claim: { type: 'string' },
          citations: CITATIONS,
          status: { type: 'string', enum: OBJECTION_STATUSES },
          merged_into: { type: ['string', 'null'] },
          ruling: RULING,
          rebuttal: {
            type: ['object', 'null'],
            additionalProperties: false,
            required: ['verdict', 'claim', 'citations', 'ruling'],
            properties: {
              verdict: { type: 'string', enum: VERDICTS },
              claim: { type: 'string' },
              citations: CITATIONS,
              ruling: RULING,
            },
          },
        },
      },
    },
    notes: {
      type: 'array',
      maxItems: MAX_NOTES,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['by', 'claim', 'citations'],
        properties: { by: { type: 'string', enum: ['A', 'B'] }, claim: { type: 'string' }, citations: CITATIONS },
      },
    },
    human_answers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['objection_id', 'answer'],
        properties: { objection_id: { type: 'string' }, answer: { type: 'string' } },
      },
    },
    proportionality: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['flagged'],
      properties: {
        flagged: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['objection_id', 'reason', 'smaller_change'],
            properties: { objection_id: { type: 'string' }, reason: { type: 'string' }, smaller_change: { type: 'string' } },
          },
        },
        // The pass ran and returned no usable answer: nothing is flagged, and a reused ledger still reports the failure.
        failed: { type: 'boolean', enum: [true] },
      },
    },
  },
});

// Decide mode: positions A to D, in the question file's order, each with one case, and at most MAX_CROSS cross points
// by each, with ids A1 to D5.
export const POSITION_IDS = Object.freeze(['A', 'B', 'C', 'D']);
export const MAX_CROSS = 5;
export const CROSS_ID = /^[A-D][1-5]$/u;
export const CROSS_STATUSES = Object.freeze(['pending', 'opinion', 'backed']);

// A decide-mode ruling: `winner` is set exactly when `decision` is `rule`, and each `tested` entry names in `of` the
// case's position or the cross point's id (the rebuttal's position on a final ruling) its citation index belongs to.
const DECIDE_RULING = Object.freeze({
  type: ['object', 'null'],
  additionalProperties: false,
  required: ['decision', 'winner', 'change_or_reason', 'citations', 'tested', 'inferences'],
  properties: {
    decision: { type: 'string', enum: ['rule', 'escalate'] },
    winner: { type: ['string', 'null'], enum: POSITION_IDS },
    change_or_reason: { type: 'string' },
    citations: CITATIONS,
    tested: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['of', 'citation', 'supports', 'reason'], properties: { of: { type: 'string' }, ...CITATION_VERDICT } },
    },
    inferences: INFERENCES,
  },
});

// The decide ledger, `<state>/quorum/<name>-<hash>.json` for the question file `<name>.md`, whose path `plan` holds.
// Every field is required: every decide ledger is written under the decide briefs.
export const DECIDE_LEDGER_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['mode', 'status', 'plan', 'plan_hash', 'same_model', 'same_model_reason', 'trigger', 'positions', 'cases', 'cross', 'ruling', 'rebuttals', 'final_ruling', 'human_answer'],
  properties: {
    mode: { type: 'string', enum: ['decide'] },
    status: { type: 'string', enum: ['open', 'complete'] },
    plan: { type: 'string' },
    plan_hash: { type: 'string' },
    same_model: { type: 'boolean' },
    same_model_reason: { type: ['string', 'null'] },
    trigger: { type: 'string' },
    positions: {
      type: 'array',
      maxItems: POSITION_IDS.length,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'label', 'runner'],
        properties: { id: { type: 'string', enum: POSITION_IDS }, label: { type: 'string' }, runner: RUNNER },
      },
    },
    cases: {
      type: 'array',
      maxItems: POSITION_IDS.length,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['position', 'claim', 'citations'],
        properties: { position: { type: 'string', enum: POSITION_IDS }, claim: { type: 'string' }, citations: CITATIONS },
      },
    },
    cross: {
      type: 'array',
      maxItems: POSITION_IDS.length * MAX_CROSS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'by', 'against', 'claim', 'citations', 'status'],
        properties: {
          id: { type: 'string' },
          by: { type: 'string', enum: POSITION_IDS },
          against: { type: 'string', enum: POSITION_IDS },
          claim: { type: 'string' },
          citations: CITATIONS,
          status: { type: 'string', enum: CROSS_STATUSES },
        },
      },
    },
    ruling: DECIDE_RULING,
    rebuttals: {
      type: 'array',
      maxItems: POSITION_IDS.length - 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['position', 'verdict', 'claim', 'citations'],
        properties: { position: { type: 'string', enum: POSITION_IDS }, verdict: { type: 'string', enum: VERDICTS }, claim: { type: 'string' }, citations: CITATIONS },
      },
    },
    final_ruling: DECIDE_RULING,
    human_answer: { type: ['string', 'null'] },
  },
});

// A product-mode cross point comes from one examiner, X, so its ids are X1 to X9.
export const PRODUCT_CROSS_ID = /^X[1-9]$/u;
export const MAX_PRODUCT_POSITIONS = 3;

// The product ledger: a decide ledger with no rebuttal round, plus the premise check, the persona's reactions, and what
// the ruling leaves behind. Its ruling is a recommendation: only `human_answer` settles it. See modes/product.md.
export const PRODUCT_LEDGER_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['mode', 'status', 'plan', 'plan_hash', 'same_model', 'same_model_reason', 'trigger', 'premise', 'positions', 'witness', 'cases', 'cross', 'ruling', 'outcome', 'human_answer'],
  properties: {
    mode: { type: 'string', enum: ['product'] },
    status: DECIDE_LEDGER_SCHEMA.properties.status,
    plan: { type: 'string' },
    plan_hash: { type: 'string' },
    same_model: { type: 'boolean' },
    same_model_reason: { type: ['string', 'null'] },
    trigger: { type: 'string' },
    premise: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'citations'],
      properties: { summary: { type: 'string' }, citations: CITATIONS },
    },
    positions: DECIDE_LEDGER_SCHEMA.properties.positions,
    witness: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['persona', 'reactions'],
      properties: {
        persona: { type: 'string' },
        reactions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['position', 'reaction'],
            properties: { position: { type: 'string', enum: POSITION_IDS }, reaction: { type: 'string' } },
          },
        },
      },
    },
    cases: DECIDE_LEDGER_SCHEMA.properties.cases,
    cross: {
      type: 'array',
      maxItems: 9,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'by', 'against', 'claim', 'citations', 'status'],
        properties: {
          id: { type: 'string' },
          by: { type: 'string', enum: ['X'] },
          against: { type: 'string', enum: POSITION_IDS },
          claim: { type: 'string' },
          citations: CITATIONS,
          status: { type: 'string', enum: CROSS_STATUSES },
        },
      },
    },
    ruling: DECIDE_RULING,
    outcome: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['conditions', 'flips_if', 'disputes'],
      properties: {
        conditions: { type: 'array', items: { type: 'string' } },
        flips_if: {
          type: 'array',
          items: { type: 'object', additionalProperties: false, required: ['fact', 'how_to_settle'], properties: { fact: { type: 'string' }, how_to_settle: { type: 'string' } } },
        },
        disputes: {
          type: 'array',
          items: { type: 'object', additionalProperties: false, required: ['topic', 'owner'], properties: { topic: { type: 'string' }, owner: { type: 'string' } } },
        },
      },
    },
    human_answer: { type: ['string', 'null'] },
  },
});

// What a position run on Codex answers in decide mode: its opening case, its cross-examination points, and its
// rebuttal or concession of the first ruling. Each is the ledger entry without the fields the coordinator writes.
const claimOf = (extra = {}) => ({
  type: 'object',
  additionalProperties: false,
  required: [...Object.keys(extra), 'claim', 'citations'],
  properties: { ...extra, claim: { type: 'string' }, citations: CITATIONS },
});
export const CASE_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false, required: ['case'], properties: { case: claimOf() } });
export const CROSS_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['cross'],
  properties: { cross: { type: 'array', maxItems: MAX_CROSS, items: claimOf({ against: { type: 'string', enum: POSITION_IDS } }) } },
});
export const DECIDE_REBUTTAL_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['rebuttal'],
  properties: { rebuttal: claimOf({ verdict: { type: 'string', enum: VERDICTS } }) },
});

// The ledger schema of each mode. A ledger with no `mode` is a plan-mode ledger under the rules it was written with.
export const LEDGER_SCHEMAS = Object.freeze({ plan: LEDGER_SCHEMA, decide: DECIDE_LEDGER_SCHEMA, product: PRODUCT_LEDGER_SCHEMA });
export const modeOf = (ledger) => (isObject(ledger) ? ledger.mode ?? 'plan' : 'plan');
// The schema a ledger is held to; a mode with no schema is held to the plan schema, whose `mode` enum refuses it.
const schemaOf = (ledger) => {
  const mode = modeOf(ledger);
  return typeof mode === 'string' && Object.hasOwn(LEDGER_SCHEMAS, mode) ? LEDGER_SCHEMAS[mode] : LEDGER_SCHEMA;
};
// A ledger written under the mode briefs carries `mode`, and is held to their rules; one without it keeps the old ones.
const carriesMode = (ledger) => Object.hasOwn(ledger, 'mode');

// The problems of `value` against `schema`, for the subset of JSON Schema the schemas above use: type (one or a
// list), enum, required, properties, additionalProperties: false, items, and maxItems. [] when it is valid.
export function schemaProblems(value, schema, where = '$') {
  const types = [schema.type].flat().filter(Boolean);
  if (types.length && !types.some((type) => isType(value, type))) return [`${where} must be ${types.join(' or ')}`];
  if (value === null) return [];
  if (schema.enum && !schema.enum.includes(value)) return [`${where} must be one of ${schema.enum.join(', ')}`];
  const problems = [];
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) problems.push(`${where} has ${value.length} items, more than ${schema.maxItems}`);
    if (schema.items) value.forEach((item, i) => problems.push(...schemaProblems(item, schema.items, `${where}[${i}]`)));
  } else if (isObject(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) problems.push(`${where}.${key} is missing`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties && Object.hasOwn(schema.properties, key)) problems.push(...schemaProblems(item, schema.properties[key], `${where}.${key}`));
      else if (schema.additionalProperties === false) problems.push(`${where}.${key} is not a known field`);
    }
  }
  return problems;
}

function isType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isObject(value);
  if (type === 'integer') return Number.isInteger(value);
  return typeof value === type;
}

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

// Whitespace runs as one space, ends trimmed: a quote matches across line breaks and indentation.
export const collapse = (text) => String(text).replace(/\s+/gu, ' ').trim();

// A control character, which no ref path holds; `shown` prints one as \uXXXX, so a NUL in a ref never reaches the output.
const CONTROL = /[\u0000-\u001f\u007f]/u;
const shown = (text) => String(text).replace(new RegExp(CONTROL.source, 'gu'), (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

// A citation's ref path that leaves the repository root: `..`, an absolute path, or a symlink out. checkLedger counts
// it as one failed citation and warns: the outside file is never read, so failing the whole ledger would protect nothing.
class Escape extends Error {}

// Why one citation fails, or null when it passes. Throws Escape when its ref path leaves `root`.
// `ctx` is { root, plan (the plan text), env (for git), read(file) → text or null }.
export function citationProblem(citation, ctx) {
  const quote = collapse(citation.quote);
  if (!quote) return 'the quote is empty';
  if (quote.length > MAX_QUOTE) return `the quote is ${quote.length} characters, more than ${MAX_QUOTE}`;
  const { kind, ref } = citation;
  if (!CITATION_KINDS.includes(kind)) return `"${kind}" is not a citation kind`;
  const place = refParts(citation);
  if (place.problem) return place.problem;
  if (kind === 'plan') return inSection(ctx.plan, place.anchor, quote, 'the plan');
  const file = inside(ctx.root, place.path, ref, kind === 'absence');
  if (file.problem) return file.problem;
  if (kind === 'doc' || kind === 'adr') {
    const text = ctx.read(file.path);
    return text === null ? `${file.path} is missing` : inSection(text, place.anchor, quote, file.path);
  }
  if (kind === 'code') {
    const text = ctx.read(file.path);
    if (text === null) return `${file.path} is missing`;
    // The line is advisory: lines drift, so the quote may be anywhere in the file.
    return collapse(text).includes(quote) ? null : `${file.path} does not contain the quote`;
  }
  // absence: tracked files only, so a needle in an ignored or untracked file is not in the project.
  const env = { ...ctx.env };
  for (const key of PATHSPEC_VARS) delete env[key];
  const listed = runGit(['--literal-pathspecs', 'ls-files', '-z', '--', file.path], ctx.root, { timeout: 30_000, env, maxBuffer: 64 * 1024 * 1024 });
  if (listed.status !== 0) {
    // git's exit code (or why it never ran) and its last stderr line, so a sandbox or a broken git is named, not guessed.
    const exit = listed.status ?? listed.error?.code ?? listed.signal;
    const last = shown(String(listed.stderr ?? '').trim().split('\n').at(-1).trim()).slice(0, MAX_QUOTE);
    return `git ls-files failed on ${file.path} (exit ${exit}${last ? `: ${last}` : ''})`;
  }
  const files = listed.stdout.split('\0').filter(Boolean);
  if (!files.length) return `git tracks no file under ${file.path}`;
  const hit = files.find((each) => {
    const text = readRegular(ctx.root, each);
    return text !== null && collapse(text).includes(quote);
  });
  return hit ? `${hit} contains the quote` : null;
}

// The parts of a citation's ref by its kind: { path, anchor } (anchor slugged; path as written), or { problem }.
function refParts({ kind, ref }) {
  if (kind === 'plan') {
    if (!ref.startsWith('#')) return { problem: `"${ref}" is not #anchor` };
    return ref.length > 1 ? { path: null, anchor: ref.slice(1) } : { problem: 'the plan: the anchor is empty' };
  }
  if (kind === 'doc' || kind === 'adr') {
    const at = ref.indexOf('#');
    if (at === -1) return { problem: `"${ref}" is not path#anchor` };
    if (at === ref.length - 1) return { problem: `"${ref}": the anchor is empty` };
    return { path: ref.slice(0, at), anchor: ref.slice(at + 1) };
  }
  if (kind === 'code') {
    const place = /^(.*?):(\d+)(?:-\d+)?$/u.exec(ref);
    return place ? { path: place[1], anchor: null } : { problem: `"${ref}" is not path:line` };
  }
  return { path: ref, anchor: null };
}

// `rel`, a path relative to the root, as { path } inside it, or { problem } when it is not a relative path: empty, with
// an empty part (`a//b`), a backslash, or a control character (a NUL would crash the git and file calls). Throws Escape
// when it leaves the root, as text (`..`, an absolute path) or through a symlink. `folder` allows `.`, the whole repository.
function inside(root, rel, ref, folder = false) {
  const notRelative = { problem: `"${shown(ref)}" is not a relative path` };
  if (CONTROL.test(rel)) return notRelative;
  if (path.isAbsolute(rel)) throw new Escape(`${rel} is outside the repository root`);
  if (rel.includes('\\') || rel.replace(/\/+$/u, '').split('/').includes('')) return notRelative;
  const normal = path.posix.normalize(rel).replace(/\/+$/u, '');
  if (normal === '..' || normal.startsWith('../')) throw new Escape(`${rel} is outside the repository root`);
  if (normal === '.') return folder ? { path: '.' } : notRelative;
  const joined = insidePath(root, '', normal);
  if (joined === null) throw new Escape(`${rel} is outside the repository root`);
  return { path: joined };
}

// A tracked file's text, when it is a regular file inside the root; null for a symlink, a folder (a submodule), or
// anything else, so a link cannot bring an outside file's text into the check.
function readRegular(root, file) {
  try {
    if (!lstatSync(path.join(root, file)).isFile() || linksOutside(root, file)) return null;
    return readFileSync(path.join(root, file), 'utf8');
  } catch {
    return null;
  }
}

// Why `quote` is not in the section of `text` under `anchor`, matched by heading text or slug; null when it is.
function inSection(text, anchor, quote, name) {
  const section = sectionOf(text, anchor);
  if (!section) return `${name} has no heading #${anchor}`;
  return collapse(`${section.heading}\n${section.body}`).includes(quote) ? null : `${name}#${anchorOf(section.heading)} does not contain the quote`;
}

// The identity of a citation, for telling whether a rebuttal cites anything new: kind, the normalized path, the
// slugged anchor, and the collapsed quote. The line of a `code` ref is not part of it, since lines drift.
function citationKey(citation) {
  const place = refParts(citation);
  if (place.problem) return `${citation.kind}\0${citation.ref}\0${collapse(citation.quote)}`;
  const file = place.path === null ? '' : path.posix.normalize(place.path).replace(/\/+$/u, '').replace(/^\.\//u, '');
  return [citation.kind, file, place.anchor === null ? '' : slug(place.anchor), collapse(citation.quote)].join('\0');
}

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

// Why `same_model` and `same_model_reason` disagree: a decide ledger records why two positions share a runner exactly
// when they do, as its `positions` show; a plan ledger with `runners` why A and B share a runner exactly when they do;
// and a plan ledger without it, written before `runners`, why B ran as an agent, which it cannot show.
export function sameModelProblems(ledger) {
  const decide = ['decide', 'product'].includes(modeOf(ledger));
  const runners = !decide && isObject(ledger.runners) ? ledger.runners : null;
  if (decide) {
    const ran = ledger.positions.map((position) => position.runner);
    const shared = new Set(ran).size < ran.length;
    if (ledger.same_model !== shared) return [`same_model is ${ledger.same_model}, but ${shared ? 'two positions share a runner' : 'no two positions share a runner'}`];
  } else if (runners) {
    const shared = runners.A === runners.B;
    if (ledger.same_model !== shared) return [`same_model is ${ledger.same_model}, but the runners ${shared ? 'match' : 'differ'}: A ${runners.A}, B ${runners.B}`];
  }
  const why = decide ? 'why two positions share a runner' : runners ? 'why A and B share a runner' : 'why B ran as an agent';
  const reason = typeof ledger.same_model_reason === 'string' && ledger.same_model_reason.trim() !== '';
  if (ledger.same_model && !reason) return [`same_model is true, so same_model_reason must say ${why}`];
  if (!ledger.same_model && ledger.same_model_reason !== null) return ['same_model is false, so same_model_reason must be null'];
  return [];
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

// The citations of `list` that pass, naming each that fails in `problems`, and each ref path outside the root in
// `escapes` as well.
function passing(list, where, ctx, problems, escapes) {
  return list.filter((citation, i) => {
    try {
      const problem = citationProblem(citation, ctx);
      // The whole line goes through `shown`: a problem built from a malformed ref (`is not path:line`) quotes it raw.
      if (problem) problems.push(shown(`${where}.citations[${i}] (${citation.kind} ${citation.ref}): ${problem}`));
      return problem === null;
    } catch (error) {
      if (!(error instanceof Escape)) throw error;
      problems.push(shown(`${where}.citations[${i}] (${citation.kind} ${citation.ref}): ${error.message}`));
      escapes.push(`${where}.citations[${i}]: ${error.message}, not read`);
      return false;
    }
  });
}

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
function inferenceProblems(claims, inferences) {
  const statements = (inferences ?? []).map((inference) => collapse(inference.statement)).filter(Boolean);
  const lines = claims.flatMap((claim) => [...String(claim).matchAll(INFERENCE)].map(([, line]) => collapse(line)));
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
  const entry = (of, label, { citations, claim }) => ({ of, label, citations, claim });
  const { ruling, final_ruling: final } = ledger;
  if (ruling) {
    if (!pass(ruling.citations, 'ruling').length) invalid('ruling: invalid: the ruling has no passing citation');
    const entries = [
      ...ledger.cases.map((each) => entry(each.position, `case ${each.position}`, each)),
      ...ledger.cross.filter((point) => point.status === 'backed').map((point) => entry(point.id, `cross ${point.id}`, point)),
    ];
    for (const reason of decideVerdictProblems(ruling, entries)) invalid(`ruling: invalid: ${reason}`);
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
      const entries = ledger.rebuttals.map((each) => entry(each.position, `rebuttal ${each.position}`, each));
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

// A product ledger as the decide rules see it: no rebuttal round, and no final ruling.
const decideView = (ledger) => ({ ...ledger, rebuttals: [], final_ruling: null });

// Why a product ledger does not fit, as lines that stop the check: the decide id rules on its positions, cases, and
// ruling; at most three positions; examiner points X1 to X9, each once, against a position; each persona reaction on a
// position, at most once; an outcome only with a rule; and a Human answer only to a ruling. A complete ledger has a
// case per position, a ruling, and, on a rule, an outcome. Its ruling never stands without `human_answer`, so an
// unanswered one is complete and deferred.
export function productProblems(ledger) {
  const problems = decideIdProblems({ ...decideView(ledger), cross: [], human_answer: null });
  if (ledger.positions.length > MAX_PRODUCT_POSITIONS) problems.push(`product mode holds at most ${MAX_PRODUCT_POSITIONS} positions, not ${ledger.positions.length}`);
  const known = new Set(ledger.positions.map(({ id }) => id));
  const seen = new Set();
  for (const point of ledger.cross) {
    if (!PRODUCT_CROSS_ID.test(point.id)) problems.push(`cross id "${shown(point.id)}" is not X1 to X9`);
    else if (seen.has(point.id)) problems.push(`cross id ${point.id} is used more than once`);
    seen.add(point.id);
    if (!known.has(point.against)) problems.push(`cross ${shown(point.id)} is against ${point.against}, not a position in this ledger`);
  }
  const persona = ledger.witness?.persona;
  if (persona !== undefined && (path.isAbsolute(persona) || path.normalize(persona).startsWith('..'))) problems.push(`witness.persona "${shown(persona)}" is not a path inside the repository`);
  const reacted = (ledger.witness?.reactions ?? []).map(({ position }) => position);
  for (const id of new Set(reacted)) {
    if (!known.has(id)) problems.push(`witness reacts to ${id}, not a position in this ledger`);
    if (reacted.indexOf(id) !== reacted.lastIndexOf(id)) problems.push(`witness reacts to ${id} more than once`);
  }
  if (ledger.outcome !== null && ledger.ruling?.decision !== 'rule') problems.push('outcome: set but no ruling rules');
  if (ledger.human_answer !== null && ledger.ruling === null) problems.push('human_answer: set but nothing was ruled');
  if (ledger.status === 'complete') {
    const cased = new Set(ledger.cases.map(({ position }) => position));
    for (const id of known) if (!cased.has(id)) problems.push(`position ${id} has no case in a complete ledger`);
    if (ledger.ruling === null) problems.push('ruling is null in a complete ledger');
    if (ledger.ruling?.decision === 'rule' && ledger.outcome === null) problems.push('outcome is null under a rule in a complete ledger');
  }
  return problems;
}

// Checks a product ledger in place: the decide checks with no rebuttal round; the premise needs a passing citation;
// and a persona is a hypothesis, so a rule whose winner rests only on the persona's own doc goes back.
export function checkProductLedger(ledger, ctx) {
  const { problems, escapes, stale: decideStale } = checkDecideLedger(decideView(ledger), ctx);
  // The Human's answer settles a product ledger, and acting on it often changes the code a case quoted.
  const stale = ledger.human_answer === null ? decideStale : [];
  const complete = ledger.status === 'complete';
  const invalid = (line) => {
    problems.push(line);
    if (complete && ledger.human_answer === null) stale.push(line);
  };
  if (!passing(ledger.premise.citations, 'premise', ctx, problems, escapes).length) invalid('premise: invalid: no citation passes');
  const persona = ledger.witness?.persona;
  const { ruling } = ledger;
  if (ruling?.decision === 'rule' && ledger.outcome === null && !complete) problems.push('ruling: invalid: a rule has no outcome');
  if (persona && ruling?.decision === 'rule') {
    const won = ledger.cases.find(({ position }) => position === ruling.winner);
    const held = passing(won?.citations ?? [], `case ${ruling.winner}`, ctx, [], []);
    const backing = ruling.tested
      .filter((verdict) => verdict.of === ruling.winner && verdict.supports)
      .map((verdict) => won?.citations[verdict.citation])
      .filter((citation) => held.includes(citation));
    if (backing.length && backing.every((citation) => path.normalize(refParts(citation).path ?? '') === path.normalize(persona))) invalid('ruling: invalid: the winner rests only on the persona doc, which is a hypothesis');
  }
  return { ledger, problems, escapes, stale };
}

// Reads a file under the root, or null when it is missing or not a regular file: a FIFO or a device would hang the read.
const reader = (root) => (file) => {
  try {
    if (!isFile(path.join(root, file))) return null;
    return readFileSync(path.join(root, file), 'utf8');
  } catch {
    return null;
  }
};

// The top folder of the checkout `cwd` is in: the nearest folder above it that holds `.git`, a folder in a main
// checkout and a file in a linked worktree. Found without running git, so `check` runs no command but `git ls-files`.
export function checkoutTop(cwd) {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, '.git'))) return realpathSync(dir);
    if (path.dirname(dir) === dir) return null;
  }
}

// The modes `aidrian quorum roles` resolves.
export const ROLE_MODES = Object.freeze(['plan', 'decide', 'product']);

// One configured role as the coordinator runs it: on `agent`, its agent and no fallback; on `codex`, no agent and the
// agent that takes over, with the same brief, when Codex cannot run.
const resolved = ({ provider, agent }) => (provider === 'codex' ? { provider, agent: null, fallback: agent } : { provider, agent, fallback: null });

// What `aidrian quorum roles <mode>` prints, from config.json `quorum` (its DEFAULTS when unset). Plan: adversaries A,
// always a host agent, and B, and the caps. Decide: the odd runner (positions A and C) and the even one (B and D),
// whether a claim's odd hash swaps A's and B's, and the dispatch cap for each position count N from 2 to 4,
// 3N + 2 + C, where C counts the first N positions whose runner is Codex, one fallback each. A swap exchanges one
// Codex and one agent runner, or two alike, so it never changes C.
export function quorumRoles(mode, quorum) {
  const judge = { agent: quorum.judge.agent };
  if (mode === 'plan') {
    const { a, b, maxObjections, maxDispatches } = quorum.plan;
    return { mode, roles: { A: resolved({ provider: 'agent', agent: a.agent }), B: resolved(b) }, judge, caps: { maxObjections, maxDispatches } };
  }
  if (mode === 'product') {
    // The trace, the frame, the second framing, the merge, the witness, one case per position, the examiner, the ruling, and one
    // retry, plus one fallback per position when advocates run on Codex.
    const { framer, second, witness, advocate, examiner, judge: ruler } = quorum.product;
    const caps = {};
    for (let n = 2; n <= MAX_PRODUCT_POSITIONS; n += 1) caps[n] = n + 8 + (advocate.provider === 'codex' ? n : 0);
    return { mode, roles: { tracer: resolved({ provider: 'agent', agent: 'explorer' }), framer: resolved({ provider: 'agent', agent: framer.agent }), second: resolved({ provider: 'agent', agent: second.agent }), witness: resolved({ provider: 'agent', agent: witness.agent }), advocate: resolved(advocate), examiner: resolved({ provider: 'agent', agent: examiner.agent }) }, judge: { agent: ruler.agent }, caps };
  }
  const { odd, even, swap } = quorum.decide;
  const runnerOf = (i) => (i % 2 === 0 ? odd : even);
  const caps = {};
  for (let n = 2; n <= POSITION_IDS.length; n += 1) {
    caps[n] = 3 * n + 2 + POSITION_IDS.slice(0, n).filter((_, i) => runnerOf(i).provider === 'codex').length;
  }
  const positions = (parity) => POSITION_IDS.filter((_, i) => i % 2 === parity);
  return { mode, roles: { odd: { positions: positions(0), ...resolved(odd) }, even: { positions: positions(1), ...resolved(even) } }, swap, judge, caps };
}

const fail = (problem) => {
  console.error(`aidrian quorum: ${problem}`);
  return 1;
};

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

const USAGE = 'codex --plan PLAN --brief BRIEF --out FILE [--mode object|case] | codex --mode rebut|cross --ledger LEDGER --plan PLAN --brief BRIEF --out FILE | check LEDGER --plan PLAN | roles plan|decide|product | premise FILE';

export const commands = {
  quorum: {
    usage: USAGE,
    about: 'run Codex as a quorum adversary or position, to object, argue a case, cross-examine, or rebut, and print one {status, reason} line; check a ledger\'s citations against the repository and the plan; or print one mode\'s roles and caps from config.json',
    async run(args, deps = {}) {
      const [action, ...rest] = args;
      // Git and Codex run without the variables a git hook sets, so they act on the repository of this folder.
      const env = isolate({ ...process.env });
      const cwd = deps.cwd ?? process.cwd();
      const root = checkoutTop(cwd);
      // The project's `quorum` config. commandConfig throws on an invalid config.json, which cli.mjs prints, naming each
      // key, and exits 1: a run never goes on with defaults the project did not choose.
      const quorum = () => commandConfig(projectAt(cwd)).quorum;
      if (action === 'roles') {
        if (rest.length !== 1 || !ROLE_MODES.includes(rest[0])) return fail(`roles takes one mode, plan, decide, or product${rest.length ? `, not "${shown(rest.join(' '))}"` : ''}`);
        (deps.print ?? console.log)(JSON.stringify(quorumRoles(rest[0], quorum())));
        return 0;
      }
      if (action === 'codex') {
        const { values } = parseArgs({ args: rest, options: { plan: { type: 'string' }, brief: { type: 'string' }, out: { type: 'string' }, mode: { type: 'string', default: 'object' }, ledger: { type: 'string' } } });
        if (!values.plan || !values.brief || !values.out) return fail('codex needs --plan, --brief, and --out');
        if (!Object.hasOwn(MODES, values.mode)) return fail(`codex --mode is ${MODE_NAMES}, not "${values.mode}"`);
        if (MODES[values.mode].ledger && !values.ledger) return fail(`codex --mode ${values.mode} needs --ledger`);
        if (!MODES[values.mode].ledger && values.ledger !== undefined) return fail(`codex --ledger is only for --mode ${LEDGER_MODES}`);
        if (!root) return fail('run it inside a git repository');
        const result = await codexAnswer({ ...values, root }, deps);
        (deps.print ?? console.log)(JSON.stringify({ status: result.status, reason: result.reason }));
        return result.status === 'done' ? 0 : result.status === 'unavailable' ? 3 : 1;
      }
      if (action === 'premise') {
        // Checks a framer's `open: false` answer, which ends a product run before any ledger exists.
        if (rest.length !== 1) return fail('premise needs one FILE');
        if (!root) return fail('run it inside a git repository');
        let citations;
        try {
          ({ citations } = JSON.parse(readFileSync(rest[0], 'utf8')).premise);
        } catch (error) {
          return fail(error.message);
        }
        const problems = [];
        const held = passing(Array.isArray(citations) ? citations : [], 'premise', { root, plan: '', env, read: reader(root) }, problems, []);
        const print = deps.print ?? console.log;
        for (const problem of problems) print(problem);
        print(`checked: premise, ${held.length} citations pass, ${problems.length} problems`);
        return held.length && !problems.length ? 0 : 1;
      }
      if (action === 'check') {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { plan: { type: 'string' } } });
        if (positionals.length !== 1 || !values.plan) return fail('check needs one LEDGER and --plan');
        if (!root) return fail('run it inside a git repository');
        const [file] = positionals;
        let ledger;
        let plan;
        try {
          ledger = JSON.parse(readFileSync(file, 'utf8'));
          plan = readFileSync(values.plan, 'utf8');
        } catch (error) {
          return fail(error.message);
        }
        // A schema error (by the ledger's mode), an id that does not fit, a same-model record that disagrees with itself
        // or with the runners, a Human answer that fits no objection, a merge that does not fit, a mode rule broken, or a
        // complete ledger left unfinished stops the check before it writes anything. The ids are checked before any line
        // that prints one. A decide ledger is held to the decide rules only.
        const product = modeOf(ledger) === 'product';
        const decide = modeOf(ledger) === 'decide';
        const invalid = schemaProblems(ledger, schemaOf(ledger));
        if (!invalid.length) invalid.push(...(product ? productProblems(ledger) : decide ? decideIdProblems(ledger) : idProblems(ledger)));
        if (!invalid.length && product) invalid.push(...sameModelProblems(ledger));
        else if (!invalid.length) {
          // An open plan ledger that carries `mode` is held to the configured objection cap, so only it reads config.json.
          // A complete one keeps the ceiling: a lower cap set after it finished never voids it and the Human's answers.
          const cap = !decide && carriesMode(ledger) && ledger.status === 'open' ? quorum().plan.maxObjections : MAX_MODE_OBJECTIONS;
          const rest = decide ? decideCompleteProblems(ledger) : [...answerProblems(ledger), ...mergeProblems(ledger), ...modeProblems(ledger, cap), ...completeProblems(ledger)];
          invalid.push(...sameModelProblems(ledger), ...rest);
        }
        if (invalid.length) {
          for (const problem of invalid) console.error(`${file}: ${problem}`);
          return 1;
        }
        const { problems, escapes, stale } = (product ? checkProductLedger : decide ? checkDecideLedger : checkLedger)(ledger, { root, plan, env, read: reader(root) });
        for (const escape of escapes) console.error(`${file}: warning: ${escape}`);
        // A complete ledger whose rulings lost their evidence is not settled any more: exit 1, unwritten, so it is not reused.
        if (stale.length) {
          for (const line of stale) console.error(`${file}: ${line} in a complete ledger`);
          return 1;
        }
        const print = deps.print ?? console.log;
        for (const problem of problems) print(problem);
        writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`);
        if (decide || product) {
          const opinions = ledger.cross.filter((point) => point.status === 'opinion').length;
          print(`checked: mode ${ledger.mode}, ${ledger.cases.length} cases, ${ledger.cross.length} cross points, ${opinions} opinion, ${problems.length} problems`);
          return 0;
        }
        const opinions = ledger.objections.filter((objection) => objection.status === 'opinion').length;
        print(`checked: mode ${modeOf(ledger)}, ${ledger.objections.length} objections, ${opinions} opinion, ${problems.length} problems`);
        return 0;
      }
      return fail(`usage: aidrian quorum ${USAGE}`);
    },
  },
};
