// UserPromptSubmit hook (Claude Code): the names reminder. When the main session's last reply said "I", "me", "my",
// "you", or "your" outside code and quotes, the next turn starts with one line that names the words and both names.
// The human has already read that reply, so a block could not undo it and would only show the reply twice; a nudge on
// the next turn stops the drift without a retry loop. lib/names.mjs finds the words.
// First, on a host with a continuation route, the handoff lines (lib/handoff-continue.mjs promptLines): a prompt in a
// session that armed a `clear` handoff continuation cancels it with one line, unless the prompt is the host's own clear
// or compact command, and a prompt in a session that handed its work to a background session gets one line naming it.

import { loadConfig } from '../lib/config.mjs';
import { isMain, print, runHook } from '../lib/hook-io.mjs';
import { continueRoutes, detectHost } from '../lib/hosts/index.mjs';
import { lastReply, replyWords } from '../lib/names.mjs';
import { findProject } from '../lib/project.mjs';
import { readText } from '../lib/transcript.mjs';

// The hook's body, for the payload `input` (lib/hook-io.mjs callHook).
export async function handle(input) {
  if (input.agent_id) return;
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (!project) return;
  const host = detectHost({ input });
  const out = [];
  out.push(...await handoffLines(input, project, host));
  const text = typeof input.transcript_path !== 'string' || host.capabilities.transcripts === false ? null : readText(input.transcript_path);
  const words = text ? [...new Set(replyWords(lastReply(text)))] : [];
  if (words.length) {
    const { names } = loadConfig(project).config;
    const ai = names.ai ?? host.ai;
    out.push(`Names: the last reply said ${words.map((w) => JSON.stringify(w)).join(', ')}. In this reply, call the human ` +
      `${JSON.stringify(names.human)} and yourself ${JSON.stringify(ai)}; a word that quotes someone goes in quotes or backticks.`);
  }
  if (out.length) print(out.join('\n'));
}

if (isMain(import.meta.url)) await runHook(handle);

// The handoff lines, or none. Never throws: a store it cannot read leaves the prompt as it is.
async function handoffLines(input, project, host) {
  try {
    if (!continueRoutes(host).length) return [];
    const { promptLines, projectStore } = await import('../lib/handoff-continue.mjs');
    return promptLines(projectStore(project, loadConfig(project).config), host, { session: input.session_id, prompt: input.prompt });
  } catch {
    return [];
  }
}
