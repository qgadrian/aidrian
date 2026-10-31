// Critical flows at review time: the invariants a flow's reviewer answers, the check of each verdict's evidence, and
// whether a flow is signed off. docs/review.md#flows describes them.

import { isObject } from '../fs.mjs';
import { runGit } from '../git.mjs';

// The invariant a flow with none stated is held to. Lint and the summary mark such a flow "unspecified".
export const UNSPECIFIED = Object.freeze({
  id: 'unspecified',
  text: 'The change keeps this flow working as before: no entry point, user action, or guarantee of the flow is removed or weakened.',
});

const slug = (text) => text.toLowerCase().replace(/[`*_]/gu, '').replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '');

// The invariants of a flow. A list is used as written. A doc's invariants are its `##` and `###` headings, each with
// the paragraph under it; `read(path)` returns the doc's text or null. Returns { invariants, unspecified, problem }.
export function invariantsOf(flow, read) {
  if (Array.isArray(flow.invariants)) return { invariants: flow.invariants, unspecified: false, problem: null };
  if (typeof flow.invariants !== 'string') return { invariants: [UNSPECIFIED], unspecified: true, problem: null };
  const text = read(flow.invariants);
  if (text === null) return { invariants: [UNSPECIFIED], unspecified: true, problem: `${flow.invariants} is missing` };
  const invariants = [];
  let current = null;
  for (const line of text.split('\n')) {
    const heading = /^#{2,3}\s+(.+?)\s*$/u.exec(line);
    if (heading) {
      current = { id: slug(heading[1]), text: heading[1], cite: `${flow.invariants}#${slug(heading[1])}` };
      invariants.push(current);
    } else if (current && line.trim() && current.body === undefined) current.body = line.trim();
  }
  const list = invariants.map(({ body, ...rest }) => ({ ...rest, text: body ? `${rest.text}: ${body}` : rest.text }));
  return list.length ? { invariants: list, unspecified: false, problem: null } : { invariants: [UNSPECIFIED], unspecified: true, problem: `${flow.invariants} has no ## headings` };
}

// Whether a verdict's evidence names something real at `head`: `path:line` of a file that has that line, or
// `test:<name>` that appears in a file at head. A citation proves the place exists, not that it shows the invariant
// holds; the independent stage challenges that, and the summary says so.
export function citationProblem(evidence, { root, head }) {
  if (typeof evidence !== 'string' || evidence.trim() === '') return 'no evidence';
  const test = /^test:(.+)$/u.exec(evidence.trim());
  if (test) {
    const found = runGit(['grep', '-F', '-q', '-e', test[1].trim(), head], root, { timeout: 15_000 });
    return found.status === 0 ? null : `no file at ${head.slice(0, 7)} names the test "${test[1].trim()}"`;
  }
  const place = /^(.+?):(\d+)(?:-\d+)?$/u.exec(evidence.trim());
  if (!place) return `"${evidence}" is not path:line or test:<name>`;
  const shown = runGit(['show', `${head}:${place[1]}`], root, { timeout: 15_000 });
  if (shown.status !== 0) return `${place[1]} is not in ${head.slice(0, 7)}`;
  const lines = shown.stdout.split('\n').length;
  return Number(place[2]) >= 1 && Number(place[2]) <= lines ? null : `${place[1]} has no line ${place[2]}`;
}

// The sign-off state of one flow from its verdicts: { signed, open, unverified } where `open` lists the invariants a
// verdict says are violated, and `unverified` those with no valid holds or not_affected verdict. A verdict that fails
// its citation counts as cannot_verify.
export function flowState(invariants, verdicts, check) {
  const open = [];
  const unverified = [];
  for (const invariant of invariants) {
    const mine = verdicts.filter((verdict) => verdict.invariant === invariant.id);
    if (mine.some((verdict) => verdict.verdict === 'violated')) open.push(invariant.id);
    else if (!mine.some((verdict) => ['holds', 'not_affected'].includes(verdict.verdict) && check(verdict.evidence) === null)) unverified.push(invariant.id);
  }
  return { signed: open.length === 0 && unverified.length === 0, open, unverified };
}

// The verdicts in a file an agent pass recorded: [{ flow, invariant, verdict, evidence }]; throws on a bad file.
export function parseVerdicts(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('--verdicts must be a JSON file');
  }
  const list = Array.isArray(raw) ? raw : raw?.verdicts;
  if (!Array.isArray(list)) throw new Error('--verdicts must hold a list of { flow, invariant, verdict, evidence }');
  for (const [i, verdict] of list.entries()) {
    const ok = isObject(verdict) && typeof verdict.flow === 'string' && typeof verdict.invariant === 'string' &&
      ['holds', 'violated', 'not_affected', 'cannot_verify'].includes(verdict.verdict) && typeof verdict.evidence === 'string';
    if (!ok) throw new Error(`--verdicts[${i}] must be { flow, invariant, verdict: holds|violated|not_affected|cannot_verify, evidence }`);
  }
  return list;
}
