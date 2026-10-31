// `aidrian lint review`: the project's review config still points at real things, and stays small.
//   - a flow whose `files` match no tracked file protects nothing: an error
//   - a flow's invariants doc that is missing, or has no `##` heading: an error; a cite naming no heading: an error
//   - a flow with no invariants is reviewed against a generic one: a warning
//   - more than FLOW_BUDGET flows, or INVARIANT_BUDGET invariants in one flow: a warning (a review plan, not a spec)

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { globPattern } from '../fs.mjs';
import { runGit } from '../git.mjs';
import { invariantsOf } from './flows.mjs';

export const FLOW_BUDGET = 12;
export const INVARIANT_BUDGET = 10;

const read = (root) => (file) => {
  try {
    return readFileSync(path.join(root, file), 'utf8');
  } catch {
    return null;
  }
};

export function lintReview(project, config) {
  const problems = [];
  const warnings = [];
  const { flows, reviewers } = config.review;
  const tracked = runGit(['ls-files', '-z'], project.root, { timeout: 30_000, maxBuffer: 256 * 1024 * 1024 }).stdout.split('\0').filter(Boolean);
  const ids = Object.keys(flows);
  if (ids.length > FLOW_BUDGET) warnings.push(`${ids.length} flows is past ${FLOW_BUDGET}: name the critical ones, not every feature`);
  for (const [id, flow] of Object.entries(flows)) {
    for (const glob of flow.files) {
      const pattern = globPattern(glob);
      if (!tracked.some((file) => pattern.test(file))) problems.push(`flow ${id}: files "${glob}" matches no tracked file`);
    }
    const { invariants, unspecified, problem } = invariantsOf(flow, read(project.root));
    if (problem) problems.push(`flow ${id}: invariants ${problem}`);
    else if (unspecified) warnings.push(`flow ${id} states no invariants: its reviewer checks only that nothing in it is removed or weakened`);
    if (invariants.length > INVARIANT_BUDGET) warnings.push(`flow ${id} has ${invariants.length} invariants, past ${INVARIANT_BUDGET}`);
    for (const invariant of Array.isArray(flow.invariants) ? flow.invariants : []) {
      if (!invariant.cite) continue;
      const [file, anchor] = invariant.cite.split('#');
      const text = read(project.root)(file);
      if (text === null) problems.push(`flow ${id}: invariant ${invariant.id} cites ${file}, which is missing`);
      else if (anchor && !invariantsOf({ invariants: file }, () => text).invariants.some((each) => each.id === anchor)) {
        problems.push(`flow ${id}: invariant ${invariant.id} cites #${anchor}, a heading ${file} does not have`);
      }
    }
    for (const word of flow.require ?? []) {
      if (word.startsWith('agent:') && !agentExists(project.root, word.slice('agent:'.length))) {
        warnings.push(`flow ${id} requires agent ${word.slice('agent:'.length)}, which is not in .claude/agents or the plugin`);
      }
    }
  }
  for (const [name, reviewer] of Object.entries(reviewers)) {
    if (reviewer.kind === 'exec' && /[./]/u.test(reviewer.command[0]) && read(project.root)(reviewer.command[0]) === null) {
      problems.push(`reviewer ${name}: ${reviewer.command[0]} is missing`);
    }
  }
  return { problems, warnings, summary: `${ids.length} flows, ${Object.keys(reviewers).length} project reviewers, all pointing at real files` };
}

function agentExists(root, name) {
  const local = read(root)(`.claude/agents/${name}.md`) !== null;
  const plugin = read(path.join(import.meta.dirname, '../../agents'))(`${name}.md`) !== null;
  return local || plugin;
}
