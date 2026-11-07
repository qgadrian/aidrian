// The product-mode schema of `aidrian quorum`: the product ledger, and the caps of a product run.

import { CROSS_STATUSES, DECIDE_LEDGER_SCHEMA, DECIDE_RULING, POSITION_IDS } from './decide-schema.mjs';
import { CITATIONS } from './plan-schema.mjs';

// A product-mode cross point comes from a griller, U for UX or E for the engineer, so its ids are U1 to E5.
export const PRODUCT_CROSS_ID = /^[UE][1-5]$/u;
// A run's dispatches with no loop, and what each loop may add: an interview or a reshape, two grills, a draft, a walkthrough, and a new ruling.
export const PRODUCT_DISPATCHES = 10;
export const PRODUCT_LOOP_DISPATCHES = 6;
export const MAX_PRODUCT_POSITIONS = 3;

// A product ruling: a decide ruling, plus the Ruling's answers on the decision itself. Each is optional, so a ledger written
// before them stays valid, and `aidrian quorum route` reads one without them as the Human's.
const PRODUCT_RULING = Object.freeze({
  ...DECIDE_RULING,
  properties: {
    ...DECIDE_RULING.properties,
    class: { type: 'string' },
    reversible: { type: ['string', 'array'], items: { type: 'string' } },
    docs: { type: 'array', items: { type: 'string' } },
    domain: { type: 'string' },
    severity: { type: 'string' },
    reverts_by: { type: 'string' },
  },
});

// The product ledger: a decide ledger with no rebuttal round, plus the premise check, the end user's interview and walkthrough, and what
// the ruling leaves behind. Its ruling is a recommendation: only `human_answer` settles it, and `provisional` records work
// continuing on it until then. See modes/product.md.
export const PRODUCT_LEDGER_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['mode', 'status', 'plan', 'plan_hash', 'same_model', 'same_model_reason', 'trigger', 'premise', 'trace', 'persona_docs', 'positions', 'witness', 'draft', 'loops', 'cases', 'cross', 'ruling', 'outcome', 'human_answer'],
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
    trace: { type: 'string' },
    persona_docs: { type: 'array', items: { type: 'string' } },
    positions: DECIDE_LEDGER_SCHEMA.properties.positions,
    witness: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['persona', 'interview', 'walkthrough'],
      properties: {
        persona: { type: 'string' },
        interview: {
          type: 'array',
          maxItems: 5,
          items: { type: 'object', additionalProperties: false, required: ['question', 'answer'], properties: { question: { type: 'string' }, answer: { type: 'string' } } },
        },
        walkthrough: { type: ['string', 'null'] },
      },
    },
    draft: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['winner', 'reason', 'walkthrough'],
      properties: { winner: { type: 'string', enum: POSITION_IDS }, reason: { type: 'string' }, walkthrough: { type: 'string' } },
    },
    loops: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['back_to', 'reason'], properties: { back_to: { type: 'string', enum: ['interview', 'shape', 'grill'] }, reason: { type: 'string' } } },
    },
    cases: DECIDE_LEDGER_SCHEMA.properties.cases,
    cross: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'by', 'against', 'claim', 'citations', 'status'],
        properties: {
          id: { type: 'string' },
          by: { type: 'string', enum: ['U', 'E'] },
          against: { type: 'string', enum: POSITION_IDS },
          claim: { type: 'string' },
          citations: CITATIONS,
          status: { type: 'string', enum: CROSS_STATUSES },
        },
      },
    },
    ruling: PRODUCT_RULING,
    outcome: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['conditions', 'flips_if', 'disputes'],
      properties: {
        conditions: { type: 'array', items: { type: 'string' } },
        flips_if: {
          type: 'array',
          items: { type: 'object', additionalProperties: false, required: ['fact', 'how_to_settle'], properties: { fact: { type: 'string' }, how_to_settle: { type: 'string' }, settles_from_repo: { type: 'boolean' }, could_harden_undo: { type: 'boolean' } } },
        },
        disputes: {
          type: 'array',
          items: { type: 'object', additionalProperties: false, required: ['topic', 'owner'], properties: { topic: { type: 'string' }, owner: { type: 'string' } } },
        },
      },
    },
    human_answer: { type: ['string', 'null'] },
    provisional: { type: 'object', additionalProperties: false, required: ['marker'], properties: { marker: { type: 'string' } } },
    second_look: { type: 'object', additionalProperties: false, required: ['agent', 'sign_off', 'reason'], properties: { agent: { type: 'string' }, sign_off: { type: 'string' }, reason: { type: 'string' } } },
  },
});
