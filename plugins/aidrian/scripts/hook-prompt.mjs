// UserPromptSubmit hook (Claude Code): the names reminder. When the main session's last reply said "I", "me", "my",
// "you", or "your" outside code and quotes, the next turn starts with one line that names the words and both names.
// The human has already read that reply, so a block could not undo it and would only show the reply twice; a nudge on
// the next turn stops the drift without a retry loop. lib/names.mjs finds the words.

import { loadConfig } from '../lib/config.mjs';
import { runHook } from '../lib/hook-io.mjs';
import { detectHost } from '../lib/hosts/index.mjs';
import { lastReply, replyWords } from '../lib/names.mjs';
import { findProject } from '../lib/project.mjs';
import { readText } from '../lib/transcript.mjs';

await runHook((input) => {
  if (typeof input.transcript_path !== 'string' || input.agent_id) return;
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (!project) return;
  const host = detectHost({ input });
  const text = host.capabilities.transcripts === false ? null : readText(input.transcript_path);
  const words = text ? [...new Set(replyWords(lastReply(text)))] : [];
  if (!words.length) return;
  const { names } = loadConfig(project).config;
  const ai = names.ai ?? host.ai;
  console.log(`Names: the last reply said ${words.map((w) => JSON.stringify(w)).join(', ')}. In this reply, call the human ` +
    `${JSON.stringify(names.human)} and yourself ${JSON.stringify(ai)}; a word that quotes someone goes in quotes or backticks.`);
});
