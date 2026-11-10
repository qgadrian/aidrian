// The hand-back check behind the Stop hook: a final message that lists items for the Human, under a label such as
// "For Adrian" or "Needs the Human", where an item says nothing of how critical it is. Such a list once handed back work
// no agent had tried, and the Human answered that the AI should fix it. The hook sends the agent back once, to try each
// item and keep only real blocks, each with what is needed and a rating. docs/hooks.md#hand-back-check describes it.
//
// Only a labelled list counts, and an item counts as rated when it holds one of RATINGS, so a report that names its
// blocks the way the rule asks passes as written. Pure: the hook passes in the message and the names.

import { lastReply } from './names.mjs';

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const alternatives = (names) => [...new Set(names.filter((name) => typeof name === 'string' && name.trim()).map((name) => escape(name.trim())))].join('|');

// The words that rate an item: the scale the orchestrator and issue-implement reports use, with `critical` and `blocker`.
export const RATINGS = /\b(?:blocking|blocker|critical|high|medium|low)\b/iu;

// A heading, a bold line, or a line that ends in a colon, with its markup and that colon removed; null for any other line.
// The text after a colon on the same line, such as "For Adrian: merge it", is returned as `inline`.
function labelOf(line) {
  const heading = /^#{1,6}\s+(.*)$/u.exec(line);
  const text = (heading ? heading[1] : line).trim();
  const bold = /^(?:\*\*|__)(.+?)(?:\*\*|__)\s*(?::\s*(.*))?$/u.exec(text);
  if (bold) return { label: bold[1].replace(/:\s*$/u, '').trim(), inline: bold[2]?.trim() ?? '' };
  const colon = /^([^:]{1,60}):\s*(.*)$/u.exec(text);
  if (colon) return { label: colon[1].trim(), inline: colon[2].trim() };
  return heading ? { label: text, inline: '' } : null;
}

// A label addressed to the Human: "For Adrian", "Open items for the Human", "Needs Adrian", "Waiting on the user",
// "Adrian's to-do".
const addressed = (human) => [
  new RegExp(`^(?:[\\p{L}-]+\\s+){0,3}?(?:for|needs?|on)\\s+(?:${human})$`, 'iu'),
  new RegExp(`^(?:${human})['’]s\\s+[\\p{L}-]+(?:\\s+[\\p{L}-]+)?$`, 'iu'),
];

const ITEM = /^(?:[-*+]|\d+[.)])\s+(.*)$/u;

// The items of each list addressed to the Human: [{ label, items }]. An item is a top-level list entry with its
// continuation lines; the list ends at a heading, a new label, or a blank line before a line that is not an entry.
export function handBackLists(message, human) {
  const lines = message.split('\n');
  const patterns = addressed(human);
  const lists = [];
  for (let i = 0; i < lines.length; i += 1) {
    const found = labelOf(lines[i].trim());
    if (!found || !patterns.some((pattern) => pattern.test(found.label))) continue;
    const items = found.inline ? [found.inline] : [];
    let j = i + 1;
    if (!items.length && lines[j]?.trim() === '') j += 1;
    for (; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim() === '') {
        if (!ITEM.test(lines[j + 1]?.trim() ?? '')) break;
        continue;
      }
      if (/^#{1,6}\s/u.test(line.trim())) break;
      const top = /^\s?(?:[-*+]|\d+[.)])\s+/u.test(line);
      if (top) items.push(line.trim().replace(ITEM, '$1'));
      else if (items.length && /^\s/u.test(line)) items[items.length - 1] += ` ${line.trim()}`;
      else break;
    }
    if (items.length) lists.push({ label: found.label, items });
    i = j - 1;
  }
  return lists;
}

// handBackReason for a Stop payload and its transcript text (or null), with the message announcedWork reads: the payload's
// `last_assistant_message`, else the transcript's last reply.
export function handBack(input, transcript, { human = 'the Human' } = {}) {
  const message = typeof input.last_assistant_message === 'string' && input.last_assistant_message.trim()
    ? input.last_assistant_message
    : typeof transcript === 'string' ? lastReply(transcript) : '';
  return handBackReason({ message, human });
}

// Why the agent is sent back, or null. `message` is the final assistant message; `human` the name config.json
// `names.human` gives (docs/config.md#names).
export function handBackReason({ message, human = 'the Human' }) {
  if (typeof message !== 'string' || !message.trim()) return null;
  const names = alternatives([human, 'the Human', 'the user', 'you']);
  const unrated = handBackLists(message, names).flatMap(({ label, items }) => items.filter((item) => !RATINGS.test(item)).map((item) => ({ label, item })));
  if (!unrated.length) return null;
  const [{ label, item }] = unrated;
  const quoted = item.length > 80 ? `${item.slice(0, 77)}...` : item;
  return `The last message lists ${unrated.length === 1 ? 'an item' : `${unrated.length} items`} under "${label}" ` +
    `without saying how critical ${unrated.length === 1 ? 'it is' : 'each is'} ("${quoted}"). ` +
    `Try each one first, through its owner, and remove what an agent can finish now. Keep only real blocks, which only ${human} can clear, ` +
    'such as a permission, a credential, or a product decision. For each that stays, say what is needed, why no agent can do it, ' +
    'and how critical it is: blocking, high, medium, or low. Then end the turn again.';
}
