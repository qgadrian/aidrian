// PreToolUse hook for Edit, Write, NotebookEdit, and Codex's apply_patch: the main-checkout rule for file writes, then
// the terms rule (lib/terms.mjs) on the lines the write adds. lib/rules/main-checkout.mjs decides the first; anything
// this hook cannot read lets the write run. A block is recorded as the Bash hook records its blocks (lib/hook-deny.mjs).
// A terms hit of severity `warn` lets the write run and tells the agent, through the hook's additional context.

import path from 'node:path';

import { loadConfig } from '../lib/config.mjs';
import { block, runHook } from '../lib/hook-io.mjs';
import { findProject } from '../lib/project.mjs';
import { checkTool } from '../lib/rules/main-checkout.mjs';

const MAX_REPORTED = 10;

await runHook(async (input) => {
  const reason = checkTool(input);
  if (reason) await block(input, 'main-checkout', reason);
  const hits = await termHits(input);
  if (!hits.length) return;
  const { formatHit } = await import('../lib/terms.mjs');
  const shown = (list) => [...list.slice(0, MAX_REPORTED).map(({ file, hit }) => `  ${formatHit(file, hit)}`), ...(list.length > MAX_REPORTED ? [`  ... and ${list.length - MAX_REPORTED} more`] : [])];
  const blocking = hits.filter(({ hit }) => hit.rule.severity === 'block');
  if (blocking.length) {
    await block(input, 'terms', [
      `Blocked: this write adds ${blocking.length} banned term(s) from the project's terms file:`,
      ...shown(blocking),
      'Write it again with the replacement each line names. A term that is right here belongs in the rule\'s "exclude", which the project decides.',
    ].join('\n'));
  }
  const context = [`The write adds ${hits.length} term(s) the project's terms file warns about; use the replacements in a follow-up edit:`, ...shown(hits)].join('\n');
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context } }));
});

// Every terms hit in the lines the write adds, as { file, hit }, with `file` relative to its project. Each file is
// judged by its own project, so a patch from a parent folder, or across projects, uses each file's rules. Silent outside
// a project and while its config.json `terms.file` is null.
async function termHits(input) {
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const terms = await import('../lib/terms.mjs');
  const rulesOf = new Map();
  const hits = [];
  for (const { file, lines } of terms.addedLines(input, cwd)) {
    const absolute = path.resolve(cwd, file);
    const project = findProject(path.dirname(absolute));
    if (!project) continue;
    if (!rulesOf.has(project.root)) {
      const config = loadConfig(project).config;
      rulesOf.set(project.root, config.terms.file === null ? [] : terms.loadTerms(project, config).rules);
    }
    const rel = path.relative(project.root, absolute);
    for (const hit of terms.scanLines(lines, rel, rulesOf.get(project.root))) hits.push({ file: rel, hit });
  }
  return hits;
}
