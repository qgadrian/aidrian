// PreToolUse hook for AskUserQuestion (Claude Code): a question to the human may not say "I", "me", "my", "you", or
// "your". The dialog shows only the question, often without the reply around it, so "How should I finish?" or "needs
// your approval" leaves the reader unsure who is meant. The start line asks for the names; this check makes it hold for
// questions. Text in backticks or quotes is left alone, since it may quote a command, a UI string, or the human.
// Word edges are Unicode letters and marks, so "problème" or "Uděláme" does not read as "me". "mine" is left out on
// purpose: it is also a verb.

import { loadConfig } from '../lib/config.mjs';
import { block, runHook } from '../lib/hook-io.mjs';
import { findProject } from '../lib/project.mjs';

const APOSTROPHE = "['’]";
const START = '(?<![\\p{L}\\p{M}\\p{N}_])';
const END = '(?![\\p{L}\\p{M}\\p{N}_])';
// "I" alone, or a contraction of it; never the "I" of "I/O" or "I-beam".
const FIRST = new RegExp(`${START}I(?:${APOSTROPHE}(?:m|ll|ve|d))?${END}(?![/-])`, 'gu');
const OTHER = new RegExp(`${START}(?:me|my|myself|you(?:${APOSTROPHE}(?:re|ll|ve|d))?|your|yours|yourself|yourselves)${END}(?!-)`, 'giu');
// A single-quoted run, which may hold an apostrophe between two letters, as in 'Don't show me again'.
const SINGLE = /(^|[^\p{L}\p{N}])['‘](?:[^'‘’\n]|(?<=\p{L})['’](?=\p{L}))*['’](?![\p{L}\p{N}])/gu;

// The words that break the names rule in `text`, outside code and quotes, in the order they appear.
function personalWords(text) {
  const bare = text
    .replace(/`[^`]*`/g, ' ')
    .replace(/"[^"]*"|“[^”]*”/g, ' ')
    .replace(SINGLE, '$1 ');
  return [...bare.matchAll(FIRST), ...bare.matchAll(OTHER)].sort((a, b) => a.index - b.index).map((m) => m[0]);
}

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
  const ai = config.names.ai ?? 'Claude';
  await block(input, 'ask-names', `Blocked: the question says ${words.map((w) => JSON.stringify(w)).join(', ')}. ` +
    `${human} may see only the dialog, so name both sides: call the human ${JSON.stringify(human)} and yourself ` +
    `${JSON.stringify(ai)}, for example "How should ${ai} finish?" or "This needs approval from ${human}.". ` +
    'A word that quotes a command, a UI string, or the human goes in backticks or quotes. Rewrite it and ask again.',
    { project, config });
});
