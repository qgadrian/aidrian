// A quorum ledger's mode, the schema it is held to, the schema validator, and the same-model record every mode keeps.

import { isObject } from '../fs.mjs';
import { DECIDE_LEDGER_SCHEMA } from './decide-schema.mjs';
import { LEDGER_SCHEMA } from './plan-schema.mjs';
import { PRODUCT_LEDGER_SCHEMA } from './product-schema.mjs';

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

export { carriesMode, schemaOf };
