// PreToolUse hook for AskUserQuestion (Claude Code): a question to the human may not say "I", "me", "my", "you", or
// "your". The dialog shows only the question, often without the reply around it, so "How should I finish?" or "needs
// your approval" leaves the reader unsure who is meant. The start line asks for the names; this check makes it hold for
// questions. lib/names.mjs finds the words and leaves text in backticks or quotes alone.
// It also refuses a question about doing more in the change at hand whose own options recommend yes, as the Stop hook's
// hand-back check sends back such a question in a final message (lib/stop-handback.mjs scopeAsk).

import { loadConfig } from '../lib/config.mjs';
import { block, isMain, runHook } from '../lib/hook-io.mjs';
import { detectHost } from '../lib/hosts/index.mjs';
import { personalWords } from '../lib/names.mjs';
import { findProject } from '../lib/project.mjs';
import { recommendsYes, SAME_CHANGE, scopeAskReason } from '../lib/stop-handback.mjs';

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

// The first question of the call that names the change at hand and whose options recommend yes, cut to 80 characters,
// or null.
function scopeQuestion(input) {
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  const found = questions.find((q) => typeof q?.question === 'string' && SAME_CHANGE.test(q.question)
    && (Array.isArray(q.options) ? q.options : []).some((o) => recommendsYes(`${o?.label ?? ''} ${o?.description ?? ''}`)));
  if (!found) return null;
  return found.question.length > 80 ? `${found.question.slice(0, 77)}...` : found.question;
}

// The hook's body, for the payload `input` (lib/hook-io.mjs callHook).
export async function handle(input) {
  if (input.tool_name !== 'AskUserQuestion') return;
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (!project) return;
  const asked = scopeQuestion(input.tool_input);
  if (asked !== null) {
    const { config } = loadConfig(project);
    await block(input, 'ask-scope', scopeAskReason('Blocked: this is ', asked, config.names.human, 'Ask again only for such a choice, with options that name it.'), { project, config });
    return;
  }
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
}

if (isMain(import.meta.url)) await runHook(handle);
