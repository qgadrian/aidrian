// SessionStart and SubagentStart hook: one line that tells the agent which knowledge docs to read now and how to find
// the rest, one line with the names to call the human and the AI, and, for the main session only, a last line when the
// lesson inbox holds open lessons, which escalates when the inbox needs triage. SessionStart adds plain stdout to the context; SubagentStart (`--subagent`) needs it
// wrapped in JSON. Prints nothing outside a project.
// At SessionStart it also saves the project's agent gates for the session (lib/gate-snapshot.mjs), which the gate hook
// holds every subagent to until the session ends.

import path from 'node:path';

import { saveGateSnapshot } from '../lib/gate-snapshot.mjs';
import { runHook } from '../lib/hook-io.mjs';
import { indexRows, loadKnowledge } from '../lib/knowledge.mjs';
import { inboxPath, nudge } from '../lib/lesson-inbox.mjs';
import { findProject } from '../lib/project.mjs';

const BIN = path.resolve(import.meta.dirname, '../bin');

await runHook((input) => {
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (!project) return;
  const { config, buckets, errors } = loadKnowledge(project);
  const always = buckets.flatMap((bucket) => bucket.always);
  const command = binCommand('aidrian-knowledge');

  const docs = indexRows(buckets).length;
  let line = `Project knowledge: ${buckets.length} bucket${buckets.length === 1 ? '' : 's'}, ${docs} doc${docs === 1 ? '' : 's'}.`;
  if (always.length) line += ` Read now: ${always.join(', ')}.`;
  line += ` For more, run \`${command} route <tag>\` for your tags or \`${command} search <words>\` for a topic.`;
  if (errors.length) line += ` The project folder has ${errors.length} problems; run \`${binCommand('aidrian')} check\`.`;
  // Claude Code sets CLAUDECODE=1 for its hooks; this hook runs only there and in Codex.
  const ai = config.names.ai ?? (process.env.CLAUDECODE === '1' ? 'Claude' : 'Codex');
  const names = `Names: call the human ${JSON.stringify(config.names.human)} and yourself ${JSON.stringify(ai)}; never "you"/"me".`;

  if (process.argv.includes('--subagent')) {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: `${line}\n${names}` } }));
  } else {
    saveGateSnapshot(input.session_id, project.root, config.agents);
    console.log(`${line}\n${names}`);
    const lessons = nudge(inboxPath(project, config), { command: binCommand('aidrian'), config });
    if (lessons) console.log(lessons);
  }
});

// The bare name when the plugin's bin/ is on PATH; the full path otherwise, so the line works on either host.
function binCommand(name) {
  if ((process.env.PATH ?? '').split(path.delimiter).includes(BIN)) return name;
  const full = path.join(BIN, name);
  return /\s/.test(full) ? `"${full}"` : full;
}
