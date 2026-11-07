// What a pull request's product feedback record holds, and where each item stands: the part of `aidrian pr
// product-feedback` (pr-product-feedback.mjs) that the answer rule reads too. Every Bash call loads that rule, so this file
// imports neither gh nor the knowledge loader. docs/config.md#product-feedback describes the record.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { allowedDecisions, FINAL, held } from './audits.mjs';
import { isObject, isWithin } from './fs.mjs';

export const RECORD_VERSION = 1;
// Highest first: a later run may raise a kind, never lower it.
export const KINDS = ['choice', 'defect', 'minor'];
export const PERSONA = 'persona';
export const PRODUCT_MANAGER = 'product-manager';
export const AUDIT_KEY = /^([^#\s]+\.md)#(F[1-9]\d*)$/u;
const HIDDEN = /[\p{Cc}\p{Cf}]/u;
const TITLE_LIMIT = 200;
// The fields that make a decision, apart from a priority or a verdict, which are set apart from it.
const DECISION_FIELDS = ['decision', 'by', 'reason', 'issue', 'url', 'doc', 'date', 'at'];

// A title as a record keeps it: one line, no control or format character, at most TITLE_LIMIT characters. It reaches a
// person, a terminal, and a deny, and the rule matches it against the question the Human answered.
export const cleanTitle = (title) => [...String(title).replace(/\s+/gu, ' ').replace(new RegExp(HIDDEN, 'gu'), '').trim()].slice(0, TITLE_LIMIT).join('');

// The fields of a decision that `record` found under a key it did not copy there, as an item keeps them.
export const decisionFields = (entry) => Object.fromEntries(DECISION_FIELDS.map((field) => [field, entry[field] ?? null]));
const sameDecision = (entry, kept) => DECISION_FIELDS.every((field) => (entry?.[field] ?? null) === (kept[field] ?? null));

// A re-check confirmed at another head than the one the item was found at. It reads no ancestry.
const confirmedElsewhere = ({ rechecked, head }) => rechecked?.status === 'confirmed' && typeof rechecked.head === 'string' && rechecked.head !== head;

// The verdict that holds this item's decision back, or null: audits `held`, and also one whose settle is no answer the
// Human gave on this item. A settle with no time, or none that can be read, still holds. On an item `record` adopted with
// its time (`adopted_at`), so does a settle not after it, whatever decision stands under the key now: only a `decided --by
// human` given through the commands after adoption releases it. An item of an older record, with no such time, is held
// by a settle that matches the `decided --by human` it found under the key (`unasked_decision`), by its time.
export function heldFor(item, entry) {
  const verdict = entry?.verdict;
  if (held(entry)) return verdict.value;
  if (!['conforms', 'silent'].includes(verdict?.value) || !isObject(verdict.settled)) return null;
  const settledAt = Date.parse(typeof verdict.settled.at === 'string' ? verdict.settled.at : '');
  if (Number.isNaN(settledAt)) return verdict.value;
  if (typeof item?.adopted_at === 'string') return settledAt > Date.parse(item.adopted_at) ? null : verdict.value;
  const word = item?.unasked_decision;
  return isObject(word) && word.decision === 'decided' && word.at === verdict.settled.at ? verdict.value : null;
}

// The decisions this item can take now: allowedDecisions, with a verdict heldFor finds held as it would be unsettled.
export function openDecisions(item, entry) {
  const verdict = heldFor(item, entry);
  return allowedDecisions({ decision: verdict ? { ...entry, verdict: { value: verdict } } : entry });
}

// Where an item stands, from its kind and its decision: `answered`, `unanswered`, or `not_rechecked`, a fix-now that
// otherwise counts and has no confirmed re-check. A decision with no `by` is the session's. A decision the record found
// under the item's key when it adopted it, and did not copy there itself, is no answer until another replaces it, and a
// verdict it settled still holds (heldFor): a session's decision a held item cannot take, such as fix-now, does not count.
export function itemState(item, entry) {
  const decision = entry?.decision;
  if (!FINAL.includes(decision)) return 'unanswered';
  if (isObject(item.unasked_decision) && sameDecision(entry, item.unasked_decision)) return 'unanswered';
  const human = entry.by === 'human';
  if (!human && !openDecisions(item, entry).includes(decision)) return 'unanswered';
  if (item.kind === 'minor') {
    if (decision === 'defer') return entry.reason?.trim() ? 'answered' : 'unanswered';
    return human ? 'answered' : 'unanswered';
  }
  if (item.kind === 'choice' ? !human : decision !== 'fix-now' && !human) return 'unanswered';
  return decision === 'fix-now' && !confirmedElsewhere(item) ? 'not_rechecked' : 'answered';
}

// The decision entry of an item: for a persona item from triage.json, and for a product-manager item its answer.
export function decisionOf(item, triage) {
  if (item.source !== PERSONA) return item.answer ?? null;
  const [, report, id] = AUDIT_KEY.exec(item.audit_key ?? '') ?? [];
  return report ? triage?.reports?.[report]?.[id] ?? null : null;
}

// `<state>/product-feedback/<owner>/<name>/pr-<n>/record.json`. Accepted residual: the GitHub host is not part of the
// identity, so the same owner/name and number on two hosts share one record. That needs two hosts on one machine.
export function recordPath(state, repo, number) {
  const base = path.join(state, 'product-feedback');
  const file = path.join(base, ...repo.split('/'), `pr-${number}`, 'record.json');
  if (!isWithin(base, file)) throw new Error(`the record of ${repo}#${number} would leave the state folder`);
  return file;
}

const itemProblem = (item) => {
  if (!isObject(item) || typeof item.id !== 'string' || typeof item.title !== 'string' || !KINDS.includes(item.kind)) return 'an item has no id, title, or kind';
  if (HIDDEN.test(item.title)) return `the title of item ${item.id} holds a control or format character`;
  if (item.source === PERSONA) return AUDIT_KEY.test(item.audit_key ?? '') ? null : `item ${item.id} has no audit key`;
  return item.source === PRODUCT_MANAGER ? null : `item ${item.id} has no known source`;
};

// The record at `file` for this pull request, or null when there is none or its repo, pr, or version does not match,
// which reads as not run. One that cannot be parsed, or whose items cannot be read, throws: never replaced, never clear.
export function readRecord(file, { repo, number }) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file}: invalid JSON (${error.message})`);
  }
  if (!isObject(value) || value.version !== RECORD_VERSION || value.pr !== number || typeof value.repo !== 'string' || value.repo.toLowerCase() !== repo.toLowerCase()) return null;
  if (!Array.isArray(value.items)) throw new Error(`${file}: items is not a list`);
  const problem = value.items.map(itemProblem).find(Boolean);
  if (problem) throw new Error(`${file}: ${problem}`);
  return value;
}

// Every record in the state folder that can be read, each as it would be for its own path: what the answer rule scans,
// since a hook runs no gh. A broken one is left out.
export function listRecords(state) {
  const names = (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  const base = path.join(state, 'product-feedback');
  const found = [];
  for (const owner of names(base)) {
    for (const name of names(path.join(base, owner))) {
      for (const folder of names(path.join(base, owner, name))) {
        const number = Number(/^pr-([1-9]\d*)$/u.exec(folder)?.[1]);
        if (!number) continue;
        try {
          const record = readRecord(recordPath(state, `${owner}/${name}`, number), { repo: `${owner}/${name}`, number });
          if (record) found.push(record);
        } catch {}
      }
    }
  }
  return found;
}
