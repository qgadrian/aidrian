// What happened in a pull request's review: the rounds, each pass's result per head, flow verdicts, the Human's
// sign-offs, and the overrides used. It is kept in two places that agree: a file in the state folder, and one summary
// comment on the pull request, edited in place, that carries the same record in a marker so another machine can read it.
// With config.json `review.record: "local"` it is kept in the state folder only, and another machine cannot read it.
//
// The record is the reviewers' word, not proof: an agent with a shell can write it. What protects the review is that
// every entry is visible in the pull request, overrides included.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { isObject } from '../fs.mjs';
import { stateDir } from '../project.mjs';

export const SUMMARY_MARKER = '<!-- aidrian-review-summary -->';
const STATE = /<!--\s*aidrian-review-state:([A-Za-z0-9+/=]+)\s*-->/u;

// Two spellings of one commit: equal, or one a prefix of the other, at least 7 hex long.
export const sameCommit = (a, b) => typeof a === 'string' && typeof b === 'string' && (a === b || (Math.min(a.length, b.length) >= 7 && (a.startsWith(b) || b.startsWith(a))));

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
    const human = !flow.humanSigned ? 'needed' : signoff?.head === plan.head ? 'recorded (an audit entry, not proof)' : `recorded on \`${String(signoff?.head).slice(0, 7)}\` and kept: nothing since touches the flow`;
    lines.push(`- flow **${flow.id}**${flow.unspecified ? ' (unspecified: no invariants stated)' : ''}: ${flow.signed ? 'signed by its reviewer' : 'not signed'}${flow.signoff === 'human' ? `; Human sign-off ${human}` : ''}`);
  }
  if (state.visual) {
    const visual = state.visual;
    lines.push('', `- visual capture of \`${String(visual.head).slice(0, 7)}\`: ${visual.status}${visual.status === 'captured' ? ` (${visual.captured} of ${visual.of})` : visual.reason ? ` (${visual.reason})` : ''}; attach **${visual.mode}**${visual.visibility ? `, ${String(visual.visibility).toLowerCase()} repository` : ', visibility unknown'}${visual.error ? `; ${visual.error}` : ''}`);
  }
  lines.push(...extensionLines(state));
  if (state.overrides.length) lines.push('', '**Overrides used:**', ...state.overrides.map((each) => `- ${each}`));
  lines.push('', 'A citation shows the cited line exists, not that it proves the invariant; the independent reviewer challenges each one.');
  lines.push(`<!-- aidrian-review-state:${Buffer.from(JSON.stringify(state)).toString('base64')} -->`);
  return lines.join('\n');
}

export const isSummary = (body) => typeof body === 'string' && body.startsWith(SUMMARY_MARKER);

const EXTRA_HEADING = '**Extra rounds:**';
// The decisions after which the cap stands.
const STOPS = new Set(['stopped', 'denied']);

// Every check at the round cap, and who decided it: the signals, the judge, the Human, or the ceiling. A blank line,
// the heading, and one line per check; nothing when there is none.
function extensionLines(state) {
  const extensions = (state.extensions ?? []).filter((entry) => entry.status !== 'new');
  if (!extensions.length) return [];
  const lines = ['', EXTRA_HEADING];
  for (const entry of extensions) {
    const who = entry.by === 'human' ? `the Human (${entry.human?.by ?? 'unknown'}; an audit entry, not proof)` : entry.by ? `the ${entry.by === 'mechanical' ? 'signals' : entry.by}` : null;
    const reasons = (entry.reasons ?? []).slice(0, 3).map((reason) => String(reason).replace(/\s+/gu, ' ').slice(0, 300));
    const at = entry.head ? ` on \`${String(entry.head).slice(0, 7)}\`` : '';
    const round = `${entry.source === 'bot' ? 'bot round' : 'round'} ${entry.round}`;
    lines.push(`- ${round}${at}: ${entry.status}${who ? ` by ${who}` : ''}${reasons.length ? `: ${reasons.join('; ')}` : ''}`);
    // The cap stood on a fix no round reviewed: the Human sees it before merging. A plan round on that head since, after
    // a later grant, reviewed it.
    const reviewed = entry.source !== 'bot' && (state.rounds ?? []).some((each) => sameCommit(each.head, entry.unreviewed?.head));
    if (entry.unreviewed?.head && STOPS.has(entry.status) && !reviewed) {
      lines.push(`- fix head \`${String(entry.unreviewed.head).slice(0, 7)}\`, pushed after ${round} on \`${String(entry.unreviewed.from).slice(0, 7)}\`, is reviewed by no pass: the cap stopped the review before it`);
    }
  }
  return lines;
}

// A summary comment's text with `state` in place of the record it carried, and its Extra rounds list rewritten from
// it; the rest, which only the review step can write, is kept as it was.
export function refreshSummary(body, state) {
  const kept = [];
  const lines = String(body).split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (STATE.test(lines[i])) continue;
    if (lines[i] === EXTRA_HEADING) {
      if (kept.at(-1) === '') kept.pop();
      while (lines[i + 1]?.startsWith('- ')) i += 1;
      continue;
    }
    kept.push(lines[i]);
  }
  const extra = extensionLines(state);
  const at = kept.findIndex((line) => line === '**Overrides used:**' || line.startsWith('A citation shows'));
  const before = at === -1 ? kept : kept.slice(0, at > 0 && kept[at - 1] === '' ? at - 1 : at);
  const after = at === -1 ? [] : kept.slice(before.length);
  return [...before, ...extra, ...after, `<!-- aidrian-review-state:${Buffer.from(JSON.stringify(state)).toString('base64')} -->`].join('\n');
}

// Writes `state`, already written to the state folder, to the pull request's summary comment, as the review step does,
// so another machine reads the same record. `io` is { comments(), post(body), edit(id, body) }. With no summary
// comment yet, it posts one under `status`. Returns the error message, or null.
export function publishState(state, io, status) {
  try {
    const summary = io.comments().filter((comment) => isSummary(comment.body)).at(-1) ?? null;
    if (summary) io.edit(summary.id, refreshSummary(summary.body, state));
    else io.post(summaryBody(state, null, status));
    return null;
  } catch (error) {
    return error.message;
  }
}
