// The decide-mode schemas of `aidrian quorum`: the decide ledger, and what a position run on Codex answers.

import { CITATION_VERDICT, CITATIONS, INFERENCES, RUNNER, VERDICTS } from './plan-schema.mjs';

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

export { DECIDE_RULING };
