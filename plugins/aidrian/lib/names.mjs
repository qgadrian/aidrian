// The names rule: agents name the human and the AI instead of saying "I", "me", "my", "you", or "your". Finds the
// words that break it in a question (hook-ask.mjs) or the last chat reply (hook-prompt.mjs), and the reply in a
// Claude Code transcript. Text in code or quotes is left alone, since it may quote a command, a UI string, or the human.
// Word edges are Unicode letters and marks, so "problème" or "Uděláme" does not read as "me". "mine" is left out on
// purpose: it is also a verb.

const APOSTROPHE = "['’]";
const START = '(?<![\\p{L}\\p{M}\\p{N}_])';
const END = '(?![\\p{L}\\p{M}\\p{N}_])';
// "I" alone, or a contraction of it; never the "I" of "I/O" or "I-beam".
const FIRST = new RegExp(`${START}I(?:${APOSTROPHE}(?:m|ll|ve|d))?${END}(?![/-])`, 'gu');
const OTHER = new RegExp(`${START}(?:me|my|myself|you(?:${APOSTROPHE}(?:re|ll|ve|d))?|your|yours|yourself|yourselves)${END}(?!-)`, 'giu');
// A single-quoted run, which may hold an apostrophe between two letters, as in 'Don't show me again'.
const SINGLE = /(^|[^\p{L}\p{N}])['‘](?:[^'‘’\n]|(?<=\p{L})['’](?=\p{L}))*['’](?![\p{L}\p{N}])/gu;

// The words that break the names rule in `text`, outside code and quotes, in the order they appear.
export function personalWords(text) {
  const bare = text
    .replace(/`[^`]*`/g, ' ')
    .replace(/"[^"]*"|“[^”]*”/g, ' ')
    .replace(SINGLE, '$1 ');
  return [...bare.matchAll(FIRST), ...bare.matchAll(OTHER)].sort((a, b) => a.index - b.index).map((m) => m[0]);
}

// personalWords for a Markdown reply: fenced code blocks and quoted lines (`> …`) are left out too.
export function replyWords(markdown) {
  const prose = markdown
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm, ' ')
    .split('\n')
    .filter((line) => !/^ {0,3}>/.test(line))
    .join('\n');
  return personalWords(prose);
}

// The text of the main session's last reply in a Claude Code transcript (JSON Lines): every text block the assistant
// wrote after the human's last prompt, or after the prompt before it when the newest prompt is already written.
// Subagent entries, tool output, and the host's own error entries are skipped. '' when there is none, and for a Codex
// rollout, whose entries never match.
export function lastReply(transcript) {
  const lines = transcript.split('\n');
  if (parse(lines[0])?.type === 'session_meta') return '';
  const parts = [];
  let turn = false;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const entry = parse(lines[i]);
    if (!entry || entry.isSidechain) continue;
    const content = entry.message?.content;
    if (entry.type === 'user' && !entry.isMeta && isPrompt(content)) {
      if (turn) break;
      continue;
    }
    if (entry.type !== 'assistant' || !Array.isArray(content)) continue;
    turn = true;
    if (entry.isApiErrorMessage || entry.message?.model === '<synthetic>') continue;
    parts.unshift(...content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text));
  }
  return parts.join('\n\n');
}

// A prompt the human sent: text, or text with images, but no tool output and no interruption marker.
function isPrompt(content) {
  if (typeof content === 'string') return true;
  if (!Array.isArray(content) || !content.length) return false;
  return content.every((block) => block?.type !== 'tool_result') &&
    !content.some((block) => block?.type === 'text' && String(block.text).startsWith('[Request interrupted'));
}

function parse(line) {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
