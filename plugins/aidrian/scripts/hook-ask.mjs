// PreToolUse hook for AskUserQuestion (Claude Code): a question to the human may not say "I", "me", "my", "you", or
// "your". The dialog shows only the question, often without the reply around it, so "How should I finish?" or "needs
// your approval" leaves the reader unsure who is meant. The start line asks for the names; this check makes it hold for
// questions. lib/names.mjs finds the words and leaves text in backticks or quotes alone.

import { loadConfig } from '../lib/config.mjs';
import { block, runHook } from '../lib/hook-io.mjs';
import { detectHost } from '../lib/hosts/index.mjs';
import { personalWords } from '../lib/names.mjs';
import { findProject } from '../lib/project.mjs';

// Every text of the call the human reads: the title, and each question, its header and description, and each option's
// label and description. An option's preview holds mockups and code, so it is left out.
function texts(input) {
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  return [
    input?.title,
    ...questions.flatMap((q) => [
      q?.question,
      q?.header,
      q?.description,
      ...(Array.isArray(q?.options) ? q.options.flatMap((o) => [o?.label, o?.description]) : []),
    ]),
  ].filter((t) => typeof t === 'string');
}

await runHook(async (input) => {
  if (input.tool_name !== 'AskUserQuestion') return;
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (!project) return;
  const words = [...new Set(texts(input.tool_input).flatMap(personalWords))];
  if (!words.length) return;
  const { config } = loadConfig(project);
  const human = config.names.human;
  const ai = config.names.ai ?? detectHost({ input }).ai;
  await block(input, 'ask-names', `Blocked: the question says ${words.map((w) => JSON.stringify(w)).join(', ')}. ` +
    `${human} may see only the dialog, so name both sides: call the human ${JSON.stringify(human)} and yourself ` +
    `${JSON.stringify(ai)}, for example "How should ${ai} finish?" or "This needs approval from ${human}.". ` +
    'A word that quotes a command, a UI string, or the human goes in backticks or quotes. Rewrite it and ask again.',
    { project, config });
});
