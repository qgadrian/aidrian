// What happened in a pull request's review: the rounds, each pass's result per head, flow verdicts, the Human's
// sign-offs, and the overrides used. It is kept in two places that agree: a file in the state folder, and one summary
// comment on the pull request, edited in place, that carries the same record in a marker so another machine can read it.
//
// The record is the reviewers' word, not proof: an agent with a shell can write it. What protects the review is that
// every entry is visible in the pull request, overrides included.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { isObject } from '../fs.mjs';
import { stateDir } from '../project.mjs';

export const SUMMARY_MARKER = '<!-- aidrian-review-summary -->';
const STATE = /<!--\s*aidrian-review-state:([A-Za-z0-9+/=]+)\s*-->/u;

export const emptyState = (pr, repo) => ({ version: 1, revision: 0, pr, repo, rounds: [], passes: {}, signoffs: {}, overrides: [], failures: {} });

const file = (project, pr) => path.join(stateDir(project), 'reviews', `pr-${pr}-review.json`);

function wellFormed(state, pr) {
  return isObject(state) && state.version === 1 && state.pr === pr && Array.isArray(state.rounds) && isObject(state.passes) && isObject(state.signoffs);
}

export function readLocalState(project, pr) {
  try {
    const state = JSON.parse(readFileSync(file(project, pr), 'utf8'));
    return wellFormed(state, pr) ? { failures: {}, overrides: [], ...state } : null;
  } catch {
    return null;
  }
}

// Every write raises the record's revision, so the newer of two records is the one written last.
export function writeLocalState(project, state) {
  state.revision = (state.revision ?? 0) + 1;
  state.updatedAt = new Date().toISOString();
  const target = file(project, state.pr);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(state, null, 2)}\n`);
}

// The record a summary comment carries, or null.
export function stateFromComment(body, pr) {
  const match = typeof body === 'string' ? STATE.exec(body) : null;
  if (!match) return null;
  try {
    const state = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
    return wellFormed(state, pr) ? { failures: {}, overrides: [], ...state } : null;
  } catch {
    return null;
  }
}

// The newer of two records: the higher revision, which every write raises, then the later write. Every write first
// reads the newer of this machine's record and the pull request's, so a revision always builds on the newest one
// either side has seen. Nothing merges half of each, so a record never mixes two reviews.
export function newer(a, b) {
  if (!a) return b;
  if (!b) return a;
  if ((a.revision ?? 0) !== (b.revision ?? 0)) return (b.revision ?? 0) > (a.revision ?? 0) ? b : a;
  return String(b.updatedAt ?? '') > String(a.updatedAt ?? '') ? b : a;
}

// The summary comment's text: a table a person reads, then the marker with the record.
export function summaryBody(state, plan, status) {
  const lines = [SUMMARY_MARKER, `### Review: ${status}`, ''];
  if (plan) {
    lines.push(`Head \`${plan.head.slice(0, 7)}\`, depth **${plan.depth}**, round ${state.rounds.length}.`);
    if (plan.reasons.length) lines.push('', ...plan.reasons.map((reason) => `- ${reason}`));
    if (plan.engine) lines.push(`- engine: ${plan.engine.name} (${plan.engine.reason})`);
  }
  const passes = Object.entries(state.passes);
  if (passes.length) {
    lines.push('', '| Pass | Head | Findings | Open |', '| --- | --- | --- | --- |');
    for (const [id, result] of passes) lines.push(`| ${id} | \`${String(result.head).slice(0, 7)}\` | ${result.findings ?? 0} | ${result.open ?? 0} |`);
  }
  for (const flow of plan?.flows ?? []) {
    const signoff = state.signoffs[flow.id];
    lines.push(`- flow **${flow.id}**${flow.unspecified ? ' (unspecified: no invariants stated)' : ''}: ${flow.signed ? 'signed by its reviewer' : 'not signed'}${flow.signoff === 'human' ? `; Human sign-off ${signoff?.head === plan.head ? 'recorded (an audit entry, not proof)' : 'needed'}` : ''}`);
  }
  if (state.overrides.length) lines.push('', '**Overrides used:**', ...state.overrides.map((each) => `- ${each}`));
  lines.push('', 'A citation shows the cited line exists, not that it proves the invariant; the independent reviewer challenges each one.');
  lines.push(`<!-- aidrian-review-state:${Buffer.from(JSON.stringify(state)).toString('base64')} -->`);
  return lines.join('\n');
}

export const isSummary = (body) => typeof body === 'string' && body.startsWith(SUMMARY_MARKER);
