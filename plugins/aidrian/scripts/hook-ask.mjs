// PreToolUse hook for AskUserQuestion (Claude Code): a question to the Human may not say "I", "me", "you", or "your".
// The dialog shows only the question, often without the reply around it, so "How should I finish?" or "needs your
// approval" leaves the reader unsure who is meant. The start line asks for the names; this check makes it hold for
// questions. Text in backticks or quotes is left alone, since it may quote a command, a UI string, or the Human.

import { loadConfig } from '../lib/config.mjs';
import { block, runHook } from '../lib/hook-io.mjs';
import { findProject } from '../lib/project.mjs';

const APOSTROPHE = "['’]";
const FIRST = new RegExp(`\\bI(?:${APOSTROPHE}(?:m|ll|ve|d))?\\b`, 'g');
const OTHER = new RegExp(`\\b(?:me|my|mine|myself|you(?:${APOSTROPHE}(?:re|ll|ve|d))?|your|yours|yourself|yourselves)\\b`, 'gi');

// The words that break the names rule in `text`, outside code and quotes, in the order they appear.
function personalWords(text) {
  const bare = text
    .replace(/`[^`]*`/g, ' ')
    .replace(/"[^"]*"|“[^”]*”/g, ' ')
    .replace(/(^|[^\p{L}\p{N}])['‘][^'‘’\n]*['’](?![\p{L}\p{N}])/gu, '$1 ');
  return [...bare.matchAll(FIRST), ...bare.matchAll(OTHER)].sort((a, b) => a.index - b.index).map((m) => m[0]);
}

// Every text of the call the Human reads: each question, its header, and each option's label and description.
function texts(input) {
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  return questions.flatMap((q) => [
    q?.question,
    q?.header,
    ...(Array.isArray(q?.options) ? q.options.flatMap((o) => [o?.label, o?.description]) : []),
  ]).filter((t) => typeof t === 'string');
}

await runHook(async (input) => {
  if (input.tool_name !== 'AskUserQuestion') return;
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (!project) return;
  const words = [...new Set(texts(input.tool_input).flatMap(personalWords))];
  if (!words.length) return;
  const { config } = loadConfig(project);
  const { names } = config;
  const ai = names.ai ?? 'Claude';
  await block(input, 'ask-names', `Blocked: the question says ${words.map((w) => `"${w}"`).join(', ')}. ` +
    `The Human may see only the dialog, so name both sides: call the human "${names.human}" and yourself "${ai}". ` +
    `Rewrite it, for example "How should ${ai} finish?" or "This needs approval from ${names.human}.", and ask again.`, { project, config });
});
