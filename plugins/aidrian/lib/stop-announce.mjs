// The announce check behind the Stop hook: a main-session turn that ends by announcing work the AI is about to start,
// such as "Starting now unless the Human says otherwise", and then stops. Nothing wakes the session until the Human
// writes again, so the announced work never starts. The hook sends the agent back once, to do it, or to ask the Human
// with the question tool when it needs a decision first. docs/hooks.md#announced-work describes it.
//
// Only the last paragraph of the final message is read, and only a few phrases count, so a summary of work done or of a
// later step the Human owns is left alone. Pure: the hook reads the payload and the transcript and passes them in.

import { ENDED_STATUSES } from './dispatch-rows.mjs';
import { lastReply } from './names.mjs';

// The standard name of the tool that asks the Human a question, which the reason names as each host's model calls it.
// A turn whose last call is that tool never ended on it: the call waits for the answer, and the turn goes on after it.
export const QUESTION_TOOL = 'AskUserQuestion';

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const alternatives = (names) => [...new Set(names.filter((name) => typeof name === 'string' && name.trim()).map((name) => escape(name.trim())))].join('|');

// The last paragraph of a Markdown message: what follows its last blank line, trimmed.
export const lastParagraph = (message) => message.trim().split(/\n[ \t]*\n/u).at(-1).trim();

// A paragraph that ends on a question to the Human, before any closing emphasis, code, bracket, or quote.
const ENDS_ON_QUESTION = /[?？][\s*_`)\]"'”’]*$/u;

// The phrases that announce imminent work, for the AI named `ai`. `actor` is the AI by name, "I", or "we".
function announcePatterns(actor) {
  const will = `(?:\\s+will|\\s+shall|['’]ll|(?:\\s+(?:is|am|are)|['’](?:s|m|re))\\s+going\\s+to)`;
  return [
    // "unless the Human says otherwise", "unless told otherwise", "unless the Human objects".
    /\bunless\s+(?:told|instructed)\s+otherwise\b/iu,
    /\bunless\s+(?:[\p{L}\p{N}'’-]+\s+){1,3}?(?:says?|tells?|wants?)\s+(?:\S+\s+)?otherwise\b/iu,
    /\bunless\s+(?:[\p{L}\p{N}'’-]+\s+){1,3}?objects?\b/iu,
    // "Starting now", "Proceeding now", "Starting on it now".
    /\b(?:starting|beginning|proceeding|continuing)\s+(?:(?:on|with)\s+(?:it|that|this)\s+)?now\b/iu,
    // "Claude will now", "I'll now".
    new RegExp(`(?<![\\p{L}\\p{N}_])(?:${actor})${will}\\s+now\\b`, 'iu'),
    // "I'll start", "Claude will proceed", "we're going to begin".
    new RegExp(`(?<![\\p{L}\\p{N}_])(?:${actor})${will}\\s+(?:start|begin|proceed|get\\s+started|kick\\s+off|go\\s+ahead)\\b`, 'iu'),
    // "Next, Claude writes the plan", "Next up: Claude will".
    new RegExp(`\\bnext(?:\\s+(?:up|step))?\\s*[,:]?\\s+(?:${actor})(?:${will}|\\s+(?:writes|starts|begins|runs|opens|drafts|implements|builds|dispatches|creates|launches|pushes))\\b`, 'iu'),
  ];
}

// What the Human still has to do before the work starts: "once the Human approves", "waits for the Human".
const waitsOn = (human) => new RegExp(`\\b(?:once|after|when|if|until|wait(?:s|ing)?\\s+(?:for|on)|awaiting)\\s+(?:${human})(?![\\p{L}\\p{N}_])`, 'iu');

// Why the agent is sent back, or null. `message` is the final assistant message; `ai` and `human` the names config.json `names` gives (docs/config.md#names); `running`
// whether a background task still runs, whose end wakes the main session on its own; `questionTool` what the host's
// model calls the question tool (lib/hosts/ nativeToolName), for the reason to name.
export function announceReason({ message, ai = null, human = 'the Human', running = false, questionTool = QUESTION_TOOL }) {
  if (typeof message !== 'string' || !message.trim() || running) return null;
  const paragraph = lastParagraph(message);
  if (ENDS_ON_QUESTION.test(paragraph)) return null;
  if (waitsOn(alternatives([human, 'the Human', 'the user', 'you'])).test(paragraph)) return null;
  const actor = alternatives([ai, 'I', 'we']);
  // The earliest phrase is the one quoted back.
  const [match] = announcePatterns(actor).map((pattern) => pattern.exec(paragraph)).filter(Boolean).sort((a, b) => a.index - b.index);
  if (!match) return null;
  return `The last message announces work and ends the turn without doing it ("${match[0]}"). ` +
    `Nothing wakes this session until ${human} writes again, so the announced work would not start. Do it now. ` +
    `If it needs a decision from ${human} first, ask with the question tool (${questionTool}) instead of announcing a default. ` +
    'If the message only reports work already done, or work that waits on something that wakes this session, ' +
    'such as a background task, end the turn again.';
}

// announceReason for a Stop payload and its transcript text (or null): the message is the payload's
// `last_assistant_message`, else the transcript's last reply. `transcript` is null on a host whose transcripts
// lib/transcript.mjs cannot read, such as Codex: the payload's message alone then counts.
export function announcedWork(input, transcript, { ai = null, human = 'the Human', questionTool = QUESTION_TOOL } = {}) {
  const message = typeof input.last_assistant_message === 'string' && input.last_assistant_message.trim()
    ? input.last_assistant_message
    : typeof transcript === 'string' ? lastReply(transcript) : '';
  const running = Array.isArray(input.background_tasks)
    && input.background_tasks.some((task) => typeof task?.id === 'string' && !ENDED_STATUSES.has(task.status));
  return announceReason({ message, ai, human, running, questionTool });
}
