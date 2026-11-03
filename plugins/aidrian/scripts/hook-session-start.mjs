// SessionStart and SubagentStart hook: one line that tells the agent which knowledge docs to read now and how to find
// the rest, one line with the names to call the human and the AI, one voice line (push back with a reason; ask the human
// plain, one-decision questions), and, for the main session only, a format line for chat replies, a line when the
// lesson inbox holds open lessons, which escalates when the inbox needs triage, and a line when the plugin copy running
// is older than the version the project requires (`requires` in config.json). Last, in the main session while
// config.json `git.mainCheckout.guard` is on (lib/main-commits.mjs): a line when the session inherited the commit
// guard's override, and up to three lines about the main checkout: local commits not on origin, a branch other than
// the default or a detached HEAD, and changed tracked files. SessionStart adds plain
// stdout to the context; SubagentStart (`--subagent`) needs it wrapped in JSON. Prints nothing outside a project.
// At SessionStart it also saves the project's agent gates for the session (lib/gate-snapshot.mjs), which the gate hook
// holds every subagent to until the session ends.

import path from 'node:path';

import { loadConfig, versionFloorProblem } from '../lib/config.mjs';
import { saveGateSnapshot } from '../lib/gate-snapshot.mjs';
import { runHook } from '../lib/hook-io.mjs';
import { indexRows, loadKnowledge } from '../lib/knowledge.mjs';
import { inboxPath, nudge } from '../lib/lesson-inbox.mjs';
import { inheritedOverrideLine, unpushedMainLine } from '../lib/main-commits.mjs';
import { findProject } from '../lib/project.mjs';

const BIN = path.resolve(import.meta.dirname, '../bin');
// The main session only: its replies are read by the human, while a subagent's report feeds commits and pull requests.
const FORMAT = 'Format: in chat replies, use headers, quotes, and a few emoji to aid scanning; never in commits, pull requests, docs, or code.';

await runHook((input) => {
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (!project) return;
  const subagent = process.argv.includes('--subagent');
  // The gates first: an error loading the knowledge below must not leave the session without its snapshot.
  if (!subagent) saveGateSnapshot(input.session_id, project.root, loadConfig(project).config.agents);
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
  const human = JSON.stringify(config.names.human);
  const names = `Names: call the human ${human} and yourself ${JSON.stringify(ai)}, in replies and questions alike; never "I", "me", "you", or "your".`;
  const lines = `${line}\n${names}\n${voiceLine(human)}`;

  if (subagent) {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: lines } }));
  } else {
    console.log(`${lines}\n${FORMAT}`);
    const floor = versionFloorProblem(config);
    if (floor) console.log(`Plugin too old: ${floor}. Its hooks and commands may reject this project's config until then.`);
    const lessons = nudge(inboxPath(project, config), { command: binCommand('aidrian'), config });
    if (lessons) console.log(lessons);
    const inherited = inheritedOverrideLine(config);
    if (inherited) console.log(inherited);
    for (const warning of unpushedMainLine(project, config)) console.log(warning);
  }
});

// Every session and subagent: disagree out loud instead of going along, and ask questions the human can answer
// without the session's context. A subagent reports to its coordinator, so the voice still applies to it.
function voiceLine(human) {
  return `Voice: when a request or premise looks wrong, or worse than an alternative, say so in one line with the reason ` +
    `before acting, then follow the call of ${human}. A question to ${human} says what goes wrong in their terms, asks ` +
    'one decision, puts the recommended option first with one reason, and uses no internal IDs or labels.';
}

// The bare name when the plugin's bin/ is on PATH; the full path otherwise, so the line works on either host.
function binCommand(name) {
  if ((process.env.PATH ?? '').split(path.delimiter).includes(BIN)) return name;
  const full = path.join(BIN, name);
  return /\s/.test(full) ? `"${full}"` : full;
}
