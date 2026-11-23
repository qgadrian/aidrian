// PostToolUse hook for ExitPlanMode (Claude Code): once the Human approves a plan in a main session that already costs
// more per call than a fresh one, the agent is told to offer a handoff before it builds, as config.json
// `session.handoff` says (lib/session-length.mjs). The plan is on disk and nothing is in flight, so this is the
// cheapest moment for a fresh session, by the cost model with the project's B (lib/resume-tokens.mjs resolvedHandoff).
// Subagents are left alone. The offer follows the continue route the session's host
// can do (lib/session-length.mjs continuation): with `clear`, the build starts in the session the clear begins, and
// with `background` in the session the gate starts in the background.

import { loadConfig } from '../lib/config.mjs';
import { isMain, print, runHook } from '../lib/hook-io.mjs';
import { detectHost } from '../lib/hosts/index.mjs';
import { findProject } from '../lib/project.mjs';
import { resolvedHandoff, resumeState } from '../lib/resume-tokens.mjs';
import { continuation, planApprovedContext, sessionUsage } from '../lib/session-length.mjs';
import { readText } from '../lib/transcript.mjs';

// The hook's body, for the payload `input` (lib/hook-io.mjs callHook).
export async function handle(input) {
  if (input.tool_name !== 'ExitPlanMode' || input.agent_id || typeof input.transcript_path !== 'string') return;
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (!project) return;
  const { config } = loadConfig(project);
  const text = readText(input.transcript_path);
  if (!text || config.session.handoff.mode === 'off') return;
  const handoff = resolvedHandoff(config.session.handoff, resumeState(project, config));
  const context = planApprovedContext(handoff, sessionUsage(text), await continuation(handoff, detectHost({ input }), project, config));
  if (context) print(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } }));
}

if (isMain(import.meta.url)) await runHook(handle);
