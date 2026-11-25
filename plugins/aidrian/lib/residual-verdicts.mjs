// The verdicts `aidrian decisions residuals --judged` keeps, so a residual found clean is not judged again while its text and
// the record it was set against are unchanged (docs/review.md#accepted-residuals-against-decisions). Each is a key of two
// hashes, the residual's text (residualHash) and the whole record (recordHash): no text of a body or a decision is stored,
// and any change to either is another key. Only a clean verdict is kept; decisions-cli.mjs says when nothing is.
//   <state>/decisions/residual-verdicts.json  { version: 1, kept: [{ residual, record, at }] }   newest last
// A store that is missing, does not read, or has another shape or version holds nothing, so every residual is owed.

import { createHash } from 'node:crypto';
import path from 'node:path';

import { writeJson } from './confine-guard.mjs';
import { isObject, readSmallJson } from './fs.mjs';
import { withLocks } from './jsonl.mjs';
import { stateDir } from './project.mjs';

export const VERDICTS_FILE = 'residual-verdicts.json';
const VERSION = 1;
// The most verdicts kept, and the largest store read: an entry takes about 200 bytes.
const MAX_KEPT = 1_000;
const STORE_CAP = 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/u;

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// The store of `project`, or null when its state folder cannot be told.
export function verdictsFile(project) {
  try {
    return path.join(stateDir(project), 'decisions', VERDICTS_FILE);
  } catch {
    return null;
  }
}

export const residualHash = (residual) => sha256(residual);

// The record `paired` lists (decisions.mjs pairResiduals): each decision's id, status, and wording, each ADR line with its
// path and number, and the ADR folder. `texts` are the docs of the decisions with no wording on record, which the judge
// reads there.
export const recordHash = ({ decisions, adrs }, adrFolder, texts) => sha256(JSON.stringify([
  decisions.map(({ id, status, wording }) => [id, status, wording]),
  adrs.map(({ path: file, line, text }) => [file, line, text]),
  adrFolder,
  texts,
]));

const isHash = (value) => typeof value === 'string' && HASH.test(value);
const isVerdict = (value) => isObject(value) && isHash(value.residual) && isHash(value.record) && typeof value.at === 'string';

function readVerdicts(file) {
  const store = readSmallJson(file, STORE_CAP);
  return store?.version === VERSION && Array.isArray(store.kept) ? store.kept.filter(isVerdict) : [];
}

const occurrences = (residuals, residual) => residuals.filter((each) => each.residual.trim() === residual.trim()).length;

// `residuals`, pairResiduals', each one whose verdict against `record` the store `file` holds with `kept: true`. One the body
// holds twice is never kept: judgeResiduals cannot tell the two apart.
export function markKept(residuals, file, record) {
  const kept = new Set(readVerdicts(file).filter((each) => each.record === record).map(({ residual }) => residual));
  return residuals.map((each) => (kept.has(residualHash(each.residual)) && occurrences(residuals, each.residual) === 1 ? { ...each, kept: true } : each));
}

const rowsFor = (rows, residual) => rows.filter((row) => typeof row?.residual === 'string' && row.residual.trim() === residual.trim());

// The judged file's `rows` with a clean row for each kept residual that has none of its own: a row given always counts.
export const withKept = (rows, residuals) => (!Array.isArray(rows) ? rows
  : [...rows, ...residuals.filter(({ kept, residual }) => kept && rowsFor(rows, residual).length === 0).map(({ residual }) => ({ residual, contradicts: null }))]);

// Takes a judged run into the store: with `clean`, a run that exited 0, the verdict of each residual with a row in `rows` is
// kept, and otherwise the verdict of each one a row says contradicts something is dropped. A residual filled in from the
// store has no row, so a run never restores what another dropped meanwhile. Returns null, or why the store was not written:
// the run's answer stands either way.
export function saveVerdicts(file, record, { residuals, rows, clean, at = new Date().toISOString() }) {
  const judged = residuals.filter(({ residual }) => {
    const own = Array.isArray(rows) ? rowsFor(rows, residual) : [];
    return clean ? own.length > 0 : own.some(({ contradicts }) => contradicts !== null);
  });
  const keys = new Set(judged.map(({ residual }) => residualHash(residual)));
  if (keys.size === 0) return null;
  const ours = (each) => each.record === record && keys.has(each.residual);
  try {
    return withLocks([file], () => {
      const held = readVerdicts(file);
      const same = held.filter(ours).length;
      if (same === (clean ? keys.size : 0)) return null;
      const added = clean ? [...keys].map((residual) => ({ residual, record, at })) : [];
      return writeJson(file, { version: VERSION, kept: [...held.filter((each) => !ours(each)), ...added].slice(-MAX_KEPT) });
    });
  } catch (error) {
    return error.code ?? error.message;
  }
}
