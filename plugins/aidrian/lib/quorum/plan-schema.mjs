// The plan-mode schemas of `aidrian quorum`: the citation shape every mode shares, what adversary B (Codex) answers,
// and the plan ledger. They are the one source of truth for these files; lib/quorum.mjs re-exports them.

import { MAX_PLAN_OBJECTIONS } from '../config.mjs';

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

export { CITATION_VERDICT, CITATIONS, INFERENCES, RUNNER };
