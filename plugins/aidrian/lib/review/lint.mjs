// `aidrian lint review`: the project's review config still points at real things, and stays small.
//   - a flow whose `files` match no tracked file protects nothing: an error
//   - a flow's invariants doc that is missing, or has no `##` heading: an error; a cite naming no heading: an error
//   - a flow with no invariants is reviewed against a generic one: a warning
//   - a focus that starts no block of its cited section: an error; a cited source past its limit: a warning
//   - an invariant question whose yes would be the breach, or a text that restates its cite: a warning
//   - more than FLOW_BUDGET flows, or INVARIANT_BUDGET invariants in one flow: a warning (a review plan, not a spec)

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { pathPattern } from './plan.mjs';
import { runGit } from '../git.mjs';
import { focusBlocks, focusesOf, invariantsOf, sectionOf, sourceOf } from './flows.mjs';

export const FLOW_BUDGET = 16;
export const INVARIANT_BUDGET = 10;
// Past this length, a question with a cite is restating the rule the cited doc already holds.
export const QUESTION_CHARS = 200;

// Words that make a question ask whether the change breaks the rule, so yes would be the breach. Such a word after
// "without", "no", "never", "not", or "nothing" reads the other way round, and is let through. A statement, such as
// "Two bookings never hold one slot", has no yes to invert, so only a question is checked.
const BREACH = /\b(?:break|breaks|remove|removes|weaken|weakens|bypass|bypasses|violate|violates|leak|leaks|regress|regresses|lose|loses|drop|drops)\b/iu;
const NEGATED = /\b(?:without|no|never|not|nothing)\b/iu;

// Warnings about how an invariant's own `text` is worded: a question whose yes would be the breach inverts holds and
// violated, and a long text with a cite restates the rule the cited doc already holds.
export function questionWarnings(invariant) {
  const text = typeof invariant.text === 'string' ? invariant.text.trim() : '';
  const warnings = [];
  const breach = text.endsWith('?') ? BREACH.exec(text) : null;
  if (breach && !NEGATED.test(text.slice(0, breach.index))) warnings.push(`text asks with "${breach[0]}", so yes would be the breach: ask whether the change still keeps the rule`);
  if (invariant.cite && text.length > QUESTION_CHARS) warnings.push(`text is ${text.length} characters, past ${QUESTION_CHARS}: leave the rule to ${invariant.cite} and ask only the question`);
  return warnings;
}

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
      const pattern = pathPattern(glob);
      if (!tracked.some((file) => pattern.test(file))) problems.push(`flow ${id}: files "${glob}" matches no tracked file`);
    }
    const { invariants, unspecified, problem } = invariantsOf(flow, read(project.root));
    if (problem) problems.push(`flow ${id}: invariants ${problem}`);
    else if (unspecified) warnings.push(`flow ${id} states no invariants: its reviewer checks only that nothing in it is removed or weakened`);
    if (invariants.length > INVARIANT_BUDGET) warnings.push(`flow ${id} has ${invariants.length} invariants, past ${INVARIANT_BUDGET}`);
    for (const invariant of Array.isArray(flow.invariants) ? flow.invariants : []) {
      warnings.push(...questionWarnings(invariant).map((warning) => `flow ${id}: invariant ${invariant.id} ${warning}`));
      if (!invariant.cite) continue;
      const [file, anchor] = invariant.cite.split('#');
      const text = read(project.root)(file);
      const section = text !== null && anchor ? sectionOf(text, anchor) : null;
      if (text === null) problems.push(`flow ${id}: invariant ${invariant.id} cites ${file}, which is missing`);
      else if (anchor && !section) {
        problems.push(`flow ${id}: invariant ${invariant.id} cites #${anchor}, a heading ${file} does not have`);
      } else if (section) {
        const { missing } = focusBlocks(section, focusesOf(invariant));
        for (const focus of missing) problems.push(`flow ${id}: invariant ${invariant.id} has focus "${focus}", which starts no top-level block of #${anchor}`);
        if (!section.body) {
          warnings.push(`flow ${id}: invariant ${invariant.id} cites #${anchor}, a section with no text under its heading for the reviewer to judge against`);
          continue;
        }
        const { length, limit } = sourceOf(section, invariant);
        if (!missing.length && length > limit) {
          const advice = focusesOf(invariant).length ? 'narrow its "focus"' : 'add "focus" to name the blocks it judges against';
          warnings.push(`flow ${id}: invariant ${invariant.id} cites ${length} characters of #${anchor}; the reviewer reads the first ${limit}: ${advice}`);
        }
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
