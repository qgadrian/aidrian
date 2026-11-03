// PostToolUse hook for ExitPlanMode (Claude Code): once the Human approves a plan in a main session that already costs
// more per call than a fresh one, the agent is told to offer a handoff before it builds, as config.json
// `session.handoff` says (lib/session-length.mjs). The plan is on disk and nothing is in flight, so this is the
// cheapest moment for a fresh session. Subagents are left alone.

import { loadConfig } from '../lib/config.mjs';
import { runHook } from '../lib/hook-io.mjs';
import { findProject } from '../lib/project.mjs';
import { planApprovedContext, sessionUsage } from '../lib/session-length.mjs';
import { readText } from '../lib/transcript.mjs';

await runHook((input) => {
  if (input.tool_name !== 'ExitPlanMode' || input.agent_id || typeof input.transcript_path !== 'string') return;
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (!project) return;
  const { handoff } = loadConfig(project).config.session;
  const text = readText(input.transcript_path);
  const context = text ? planApprovedContext(handoff, sessionUsage(text)) : null;
  if (context) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } }));
});
