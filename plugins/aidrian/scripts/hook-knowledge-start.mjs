// SessionStart and SubagentStart hook: one line that tells the agent which knowledge docs to read now and how to find
// the rest. SessionStart adds plain stdout to the context; SubagentStart (`--subagent`) needs it wrapped in JSON.
// Prints nothing outside a project.

import path from 'node:path';

import { runHook } from '../lib/hook-io.mjs';
import { indexRows, loadKnowledge } from '../lib/knowledge.mjs';
import { findProject } from '../lib/project.mjs';

const BIN = path.resolve(import.meta.dirname, '../bin');

await runHook((input) => {
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (!project) return;
  const { buckets, errors } = loadKnowledge(project);
  const always = buckets.flatMap((bucket) => bucket.always);
  const command = binCommand('aidrian-knowledge');

  let line = `Project knowledge: ${buckets.length} buckets, ${indexRows(buckets).length} docs.`;
  if (always.length) line += ` Read now: ${always.join(', ')}.`;
  line += ` For more, run \`${command} route <tag>\` for your tags or \`${command} search <words>\` for a topic.`;
  if (errors.length) line += ` The project folder has ${errors.length} problems; run \`${binCommand('aidrian')} check\`.`;

  if (process.argv.includes('--subagent')) {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: line } }));
  } else {
    console.log(line);
  }
});

// The bare name when the plugin's bin/ is on PATH; the full path otherwise, so the line works on either host.
function binCommand(name) {
  if ((process.env.PATH ?? '').split(path.delimiter).includes(BIN)) return name;
  const full = path.join(BIN, name);
  return /\s/.test(full) ? `"${full}"` : full;
}
