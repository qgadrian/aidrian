// Records a block by one of the plugin's own hooks: the Bash rules, the main-checkout rule for writes, the agent gates,
// and the config guard. It records the block twice over: a `hook_deny` row in the dispatch log while config.json
// `telemetry.enabled` and `telemetry.hookDenies` are on, and one count toward the automatic lesson for a rule that blocks
// one session again and again (lesson-signals.mjs noteDenial), which counts whether or not telemetry is on. The row names
// the rule and what it matched, never the command. hook-io.mjs block() loads this file only when a hook blocks, so a
// call the hooks let run never pays for it.

import { loadConfig } from './config.mjs';
import { appendEvent, denyRow } from './dispatch-log.mjs';
import { noteDenial } from './lesson-signals.mjs';
import { findProject } from './project.mjs';

// The first sentence of a deny reason, without its `Blocked: ` lead: the rule's own words for what it matched. An absolute
// path in parentheses, such as the main checkout's folder, names this machine rather than the match, and is left out.
export const firstSentence = (reason) =>
  reason.replace(/^Blocked: /u, '').split(/\n|(?<=\.)\s/u)[0].replace(/ \((?:\/|[A-Za-z]:\\)[^)]*\)/gu, '');

// Records the block of `rule` on the tool call in `input`, a PreToolUse payload. `match` is the row's reason: the first
// sentence of `reason` unless the caller has a shorter one. A hook that has the project and its config passes them.
// Never throws.
export function recordBlock(input, rule, reason, { match = firstSentence(reason), project, config } = {}) {
  try {
    const found = project ?? findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
    const settings = found ? (config ?? loadConfig(found).config) : null;
    if (settings?.telemetry.hookDenies) appendEvent(found, settings, denyRow(input, rule, match));
  } catch {
    // The row is lost; the lesson count still happens.
  }
  noteDenial(input, rule);
}
