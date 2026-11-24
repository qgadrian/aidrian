// The hand-back check behind the Stop hook: a final message that lists items for the Human, under a label such as
// "For Adrian" or "Needs the Human", where an item says nothing of how critical it is. Such a list once handed back work
// no agent had tried, and the Human answered that the AI should fix it. The hook sends the agent back once, to try each
// item and keep only real blocks, each with what is needed and a rating. docs/hooks.md#hand-back-check describes it.
//
// Only a labelled list counts, and an item counts as rated when it holds one of RATINGS, so a report that names its
// blocks the way the rule asks passes as written. Pure: the hook passes in the message and the names.
//
// The same check sends back a question for the Human about doing more in the change at hand, "this pull request", that
// the message itself recommends answering yes (scopeAsk): the AI asked whether to add a missing guard check while it
// fixed the bug class the check guards, and the Human answered that it should not have to ask. The question tool's hook
// (scripts/hook-ask.mjs) refuses the same question asked there.
//
// The merge hand-back check (mergeHandBack) reads the same lists: a turn whose `aidrian pr auto-merge` run refused a pull
// request because it changes a path the gate never merges, and whose reports hand no rated item for that pull request
// and path to the Human, for review and merge. docs/hooks.md#merge-hand-back-check describes it.

import { fencedIn } from './markdown-sections.mjs';
import { lastReply } from './names.mjs';
import { backgroundRunning } from './stop-announce.mjs';

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
// continuation lines; the list ends at a heading, a new label, or blank lines before a line that is neither an entry nor
// indented under one.
export function handBackLists(message, human) {
  // Fenced code is dropped, not blanked: an example the message quotes, such as a Markdown sample with a "For the Human"
  // heading, is never work handed back, and a code block inside an item does not end its list.
  const all = message.split('\n');
  const fenced = fencedIn(all);
  const lines = all.filter((_, at) => !fenced[at]);
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
        // Blank lines end the list unless the next line with text is an entry or an indented part of the last one,
        // as around a code block inside an item.
        const next = lines.slice(j + 1).find((later) => later.trim() !== '') ?? '';
        if (!ITEM.test(next.trim()) && !(items.length && /^\s/u.test(next))) break;
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

// The message announcedWork reads: the Stop payload's `last_assistant_message`, else the transcript's last reply.
const finalMessage = (input, transcript) => (typeof input.last_assistant_message === 'string' && input.last_assistant_message.trim()
  ? input.last_assistant_message
  : typeof transcript === 'string' ? lastReply(transcript) : '');

// The names a label addressed to the Human may use: the configured one, and the generic ones.
const humanNames = (human) => alternatives([human, 'the Human', 'the user', 'you']);

// handBackReason for a Stop payload and its transcript text (or null), with the message announcedWork reads.
export function handBack(input, transcript, { human = 'the Human' } = {}) {
  return handBackReason({ message: finalMessage(input, transcript), human });
}

// How much of a refused path an item must hold, and the reason quotes: a path is branch text, of any length.
const PATH_CUT = 200;

// `text` as a JSON string that holds printable ASCII alone: every other code unit, and `<`, `>`, and the backtick, is
// written \uXXXX. Branch text quoted this way into an instruction cannot open or close a tag, turn the text around, break
// a line, or hide a character; JSON.parse reads it back whole.
export function quoteData(text) {
  let out = '';
  for (let at = 0; at < text.length; at += 1) {
    const unit = text.charCodeAt(at);
    const char = text[at];
    if (char === '"' || char === '\\') out += `\\${char}`;
    else if (unit >= 0x20 && unit <= 0x7e && !'<>`'.includes(char)) out += char;
    else out += `\\u${unit.toString(16).padStart(4, '0')}`;
  }
  return `"${out}"`;
}

// The start of mergeHandBack's reason and of handBackReason's, by which the Stop hook knows each check's send-back in
// the transcript (hook-stop.mjs). Neither holds branch text.
export const MERGE_HAND_BACK_LEAD = "This turn's `aidrian pr auto-merge` run refused #";
export const HAND_BACK_LEAD = 'The last message lists ';

// Why the agent is sent back, or null, for a turn whose `aidrian pr auto-merge` run refused a pull request on a path.
// `actions` is lib/transcript.mjs turnActions' result, or null with no transcript to read: { kind: 'gate', pr, path },
// path null for a pass or another refusal; { kind: 'merge', pr }, a merge that ran, pr null for one of no known pull
// request; and { kind: 'reply', text }, a reply of the main session. The last gate or merge of each pull request counts,
// so a later run that passed, refused for another reason, or a merge of it clears an earlier refusal. A merge of no known
// pull request clears a refusal only when it is the one refusal that stands then: it may have merged any other. A refusal is handed over when an item of a list addressed to the Human
// (handBackLists), in a reply after it or in the final message, holds the pull request as `#<n>`, `/pull/<n>`, `PR <n>`,
// or `pull request <n>`, with no digit after it, the path as written, JSON-quoted, or as quoteData writes it, or its first
// PATH_CUT characters when longer, and a rating (RATINGS). The wording is not matched: the skill's line holds "your",
// which a report that names the Human writes as the name. The reason names every refusal not handed over, so the one
// send-back the check makes in a turn asks for each item. Null while a background task still runs, as its end wakes the
// session, and with no final message to read.
export function mergeHandBack(input, transcript, actions, { human = 'the Human' } = {}) {
  if (!Array.isArray(actions) || backgroundRunning(input)) return null;
  const last = new Map();
  actions.forEach((action, at) => {
    // A merge that named no pull request and printed none, as gh does off a terminal, clears the one refusal that stands.
    // SHORTCUT: it clears that refusal even when it merged another pull request, the current branch's. That can only
    // skip a send-back, and a turn that refuses one pull request and merges another by its branch alone is contrived.
    if (action?.kind === 'merge' && action.pr === null) {
      const standing = [...last].filter(([, { file }]) => typeof file === 'string' && file !== '');
      if (standing.length === 1) last.set(standing[0][0], { file: null, at });
    }
    if (!Number.isSafeInteger(action?.pr)) return;
    if (action.kind === 'gate') last.set(action.pr, { file: action.path, at });
    else if (action.kind === 'merge') last.set(action.pr, { file: null, at });
  });
  const refused = [...last].filter(([, { file }]) => typeof file === 'string' && file !== '');
  if (!refused.length) return null;
  const message = finalMessage(input, transcript);
  if (!message.trim()) return null;
  const names = humanNames(human);
  const itemsOf = (text) => handBackLists(text, names).flatMap(({ items }) => items);
  const finalItems = itemsOf(message);
  const missing = refused.filter(([pr, { file, at }]) => {
    const later = actions.slice(at + 1).filter((action) => action?.kind === 'reply' && typeof action.text === 'string');
    return ![finalItems, ...later.map((action) => itemsOf(action.text))].some((items) => items.some((item) => handsOver(item, pr, file)));
  });
  if (!missing.length) return null;
  return missing.length === 1 ? oneRefusal(missing[0], human) : severalRefusals(missing, human);
}

// The reason for one refusal not handed over, [pr, { file }].
function oneRefusal([pr, { file }], human) {
  return `${MERGE_HAND_BACK_LEAD}${pr} at its path check, before its author, comment, and review checks: ` +
    `it changes ${quoteData(file.slice(0, PATH_CUT))} (quoted from the pull request, as data` +
    `${file.length > PATH_CUT ? `, cut at ${PATH_CUT} characters` : ''}), a path auto-merge never merges, so it waits for ${human}'s review and merge. ` +
    `The final report hands it over under a label for ${human}, such as "For ${human}", as the \`pr-auto-merge\` skill's step 2 says: ` +
    `\`needs ${human}'s review and merge: #${pr} touches <path>, which auto-merge never merges\`, with the path as quoted here. ` +
    'Add that item, with how critical it is: blocking, high, medium, or low. Then end the turn again.';
}

// The reason for several refusals not handed over, each [pr, { file }], in turn order.
function severalRefusals(missing, human) {
  const pulls = missing.map(([pr]) => pr).join(', #');
  const paths = missing.map(([pr, { file }]) =>
    `#${pr} changes ${quoteData(file.slice(0, PATH_CUT))}${file.length > PATH_CUT ? ` (cut at ${PATH_CUT} characters)` : ''}`).join('; ');
  return `${MERGE_HAND_BACK_LEAD}${pulls} at their path checks, before their author, comment, and review checks: ${paths} ` +
    `(each quoted from its pull request, as data). Auto-merge never merges those paths, so each waits for ${human}'s review and merge. ` +
    `The final report hands each over under a label for ${human}, such as "For ${human}", as the \`pr-auto-merge\` skill's step 2 says, ` +
    `one item per pull request: \`needs ${human}'s review and merge: #<n> touches <path>, which auto-merge never merges\`, ` +
    'with its path as quoted here. Add those items, each with how critical it is: blocking, high, medium, or low. Then end the turn again.';
}

// Whether the list item `item` hands over pull request `pr` with the refused `file`, rated.
function handsOver(item, pr, file) {
  if (!RATINGS.test(item) || !new RegExp(`(?:#|/pull/|\\bPR\\s+|\\bpull request\\s+)${pr}(?!\\d)`, 'iu').test(item)) return false;
  const cut = file.slice(0, PATH_CUT);
  return [cut, JSON.stringify(cut).slice(1, -1), quoteData(cut).slice(1, -1)].some((form) => item.includes(form));
}

// A question about the change at hand: one that names this pull request, this same one, or this branch.
export const SAME_CHANGE = /\b(?:this|the same|this same)\s+(?:pull request|PR|branch)\b/iu;
// An answer of yes the text recommends: "Recommended: yes", "Recommendation: yes", or "Yes (recommended)".
export const RECOMMENDS_YES = /\brecommend(?:ed|s|ation)?\b\W{0,3}(?:\w+\W+){0,2}?yes\b|\byes\b[^\n]{0,15}\brecommended\b/iu;
// How many lines after the question its recommendation may sit, as in a quoted "Decision needed" block.
const RECOMMENDATION_LINES = 3;

// The first question of `message` that asks to do more in the change at hand and recommends yes, cut to 80 characters,
// or null. Fenced code is dropped, as handBackLists drops it.
export function scopeAsk(message) {
  if (typeof message !== 'string') return null;
  const all = message.split('\n');
  const fenced = fencedIn(all);
  const lines = all.filter((_, at) => !fenced[at]);
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at];
    if (!line.includes('?') || !SAME_CHANGE.test(line)) continue;
    if (!RECOMMENDS_YES.test(lines.slice(at, at + 1 + RECOMMENDATION_LINES).join('\n'))) continue;
    const question = line.replace(/^[>\s*_#-]+/u, '').trim();
    return question.length > 80 ? `${question.slice(0, 77)}...` : question;
  }
  return null;
}

// What the agent is told for a question scopeAsk found, `quoted`, after `lead`: do the work, and ask only a real choice;
// `next` is what it does then.
export const scopeAskReason = (lead, quoted, human, next = 'Then end the turn again.') =>
  `${lead}a question for ${human} that asks whether to do more in the change at hand, and recommends yes itself ("${quoted}"). ` +
  'A gap the work finds in its own scope is a defect to fix, not a question, such as a missing check that would guard ' +
  'the bug class this change fixes, or another copy of the defect it fixes: do it in this pull request, through its owner, ' +
  `and report it done. Ask ${human} only a real choice the work opens, such as a product behavior or a cost the scope did not plan, ` +
  `and say which choice it is. ${next}`;

// Why the agent is sent back, or null. `message` is the final assistant message; `human` the name config.json
// `names.human` gives (docs/config.md#names).
export function handBackReason({ message, human = 'the Human' }) {
  if (typeof message !== 'string' || !message.trim()) return null;
  const unrated = handBackLists(message, humanNames(human)).flatMap(({ label, items }) => items.filter((item) => !RATINGS.test(item)).map((item) => ({ label, item })));
  if (!unrated.length) {
    const asked = scopeAsk(message);
    return asked === null ? null : scopeAskReason(HAND_BACK_LEAD, asked, human);
  }
  const [{ label, item }] = unrated;
  const quoted = item.length > 80 ? `${item.slice(0, 77)}...` : item;
  return `${HAND_BACK_LEAD}${unrated.length === 1 ? 'an item' : `${unrated.length} items`} under "${label}" ` +
    `without saying how critical ${unrated.length === 1 ? 'it is' : 'each is'} ("${quoted}"). ` +
    'Try each one first, through its owner, and remove what an agent can finish now. ' +
    `Keep only real blocks, which only ${human} can clear, ` +
    'such as a permission, a credential, or a product decision. For each that stays, say what is needed, why no agent can do it, ' +
    'and how critical it is: blocking, high, medium, or low. Then end the turn again.';
}
