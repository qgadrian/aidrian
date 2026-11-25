// `aidrian plan`: a local plan's status marks, and the records that change no slice.
//
//   aidrian plan set FILE SLICE pending|in_progress|complete|blocked [--note TEXT]
//   aidrian plan set FILE --plan in-progress|complete|blocked
//   aidrian plan record FILE --by WHO (--text TEXT | --text-file FILE)
//
// `set` changes one slice's `status` line, and with `--note` its `notes` field, or the frontmatter's `status`. `record`
// appends one dated entry to `## Revision history`. Neither touches another byte: the edit works on the plan's own text,
// and never writes YAML again. What a slice must do is planning-agent's, and so are the statuses `ready` and
// `open-questions`, which say a plan is decision-complete, and every plan git tracks.
// Exit 0 prints the lines it changed, old and new. Exit 2 gives the reason, and writes nothing. An unknown option, an
// invalid config.json, a plan another process keeps locked, or a write the system refuses exits 1, and leaves the plan
// as it was. docs/project-folder.md#marking-a-plan has the rules. Which plan a session no Human attends may edit is the
// write guard's to judge, before the command runs (unattended-shell.mjs planTarget).

import { randomBytes } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { today } from './audits.mjs';
import { commandConfig } from './config.mjs';
import { isFile, joinSpelled, readOnce, systemPath } from './fs.mjs';
import { runGit, underGit, withoutLocation } from './git.mjs';
import { hasHidden, HIDDEN, plainLine } from './hidden-text.mjs';
import { LOCKED, withLocks } from './jsonl.mjs';
import { closes, fencedIn, fenceOf, LIST_ITEM } from './markdown-sections.mjs';
import { projectAt, stateDir } from './project.mjs';
import { usageLines } from './usage.mjs';

const SLICE_STATUSES = ['pending', 'in_progress', 'complete', 'blocked'];
// Without `ready` and `open-questions`: they say the plan is decision-complete, which planning-agent alone asserts.
const PLAN_STATUSES = ['in-progress', 'complete', 'blocked'];

const HISTORY = /^revision history$/iu;
const word = { type: 'string' };
const ACTIONS = {
  set: { options: { project: word, note: word, plan: word }, edit: setEdit },
  record: { options: { project: word, by: word, text: word, 'text-file': word }, edit: recordEdit },
};

export const commands = {
  plan: {
    usage: `set FILE SLICE ${SLICE_STATUSES.join('|')} [--note TEXT] [--project DIR] | set FILE --plan ${PLAN_STATUSES.join('|')} [--project DIR] ` +
      '| record FILE --by WHO (--text TEXT | --text-file FILE) [--project DIR]',
    about: 'mark a slice or a local plan with its status, or record an outcome that changes no slice in its revision history; any other line stays as it is',
    run: planCommand,
  },
};

const REFUSED = 'EPLANREFUSED';
function refuse(...lines) {
  throw Object.assign(new Error(lines.join('\n')), { code: REFUSED, lines });
}

export function planCommand([action, ...args]) {
  try {
    if (!Object.hasOwn(ACTIONS, action ?? '')) refuse(...usageLines('plan', commands.plan.usage, 'usage: '));
    const { options, edit } = ACTIONS[action];
    const { values, positionals: [given, ...rest] } = parseArgs({ args, allowPositionals: true, options });
    if (!given) refuse(`plan ${action} needs the plan file`);
    // Before the project is looked up, which asks git: a bad argument costs no process.
    const make = edit(rest, values);
    const project = projectAt(path.resolve(values.project ?? '.'));
    const file = planFile(given, stateDir(project, { config: commandConfig(project) }));
    const changes = change(file, make);
    console.log(visible([file, ...(changes.length ? changes.flatMap(shown) : ['nothing to change: the plan holds that already'])]));
    return 0;
  } catch (error) {
    const refused = error.code === REFUSED;
    // A lock held past its wait, or a write the system refuses: the plan is as it was.
    if (!refused && error.code !== LOCKED && error.syscall === undefined) throw error;
    console.error(visible(error.lines ?? [error.message]));
    return refused ? 2 : 1;
  }
}

// One change as the command prints it.
const shown = ({ at, old, now }) => [`line ${at + 1}:`, ...old.map((line) => `- ${line}`), ...now.map((line) => `+ ${line}`)];
// Every line the command prints, on either stream: a character that does not show is left out, so no text of a plan, a
// path, or a lock drives a terminal or starts a line of its own.
const visible = (lines) => lines.map((line) => line.replace(HIDDEN, '')).join('\n');

// The plan `given` names, where the system lands through every link, or a refusal. A local plan is a Markdown file directly
// in `<state>/plans/` itself: a subfolder, or a `plans` folder that is a link elsewhere, holds none.
function planFile(given, state) {
  const root = systemPath(path.resolve(state));
  const plans = path.join(root ?? path.resolve(state), 'plans');
  const file = systemPath(joinSpelled(process.cwd(), given));
  if (!file || path.dirname(file) !== plans) refuse(`${given} is not a plan directly in ${plans}: planning-agent edits any other plan, such as one git tracks`);
  if (!isFile(file) || path.extname(file) !== '.md') refuse(`${given} names no plan: no .md file is there`);
  if (tracked(file)) refuse(`${given} may be a file git tracks, and planning-agent edits a plan git tracks`);
  return file;
}

// Whether git tracks `file`, true when git cannot say. `state.dir` may put the state folder inside a checkout.
function tracked(file) {
  if (!underGit(path.dirname(file))) return false;
  const { status } = runGit(['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', path.basename(file)], path.dirname(file), { env: withoutLocation() });
  return status !== 1;
}

// Runs `edit` on the plan's text and writes what it gives, then returns its changes. `edit` runs once before the lock is
// taken, so a refusal leaves no lock file either, and again on the text the lock protects, so a mark another process
// made in between stays.
function change(file, edit) {
  edit(readPlan(file).text);
  return withLocks([file], () => {
    const before = readPlan(file);
    const { text, changes } = edit(before.text);
    if (text !== before.text) replaceFile(file, text, before.mode);
    return changes;
  });
}

// The text of the plan `file`, exactly as its bytes read, and its mode, from one open that follows no link and never
// waits. Bytes that are no UTF-8 would not write back as they were.
function readPlan(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (stat.isFile()) return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(fd)), mode: stat.mode & 0o777 };
  } catch {
    // Not there, a link, or no UTF-8.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return refuse(`${file} cannot be read as a file of UTF-8 text`);
}

// Writes `text` over `file` in one rename, with the mode `mode`, set on the open file so no path decides whose it is.
function replaceFile(file, text, mode) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, text);
      fchmodSync(fd, mode);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

// A plan's text by line: `lines` with their line ends, whose join is the text; `texts` without them; `code`, whether a
// line is fenced code or frontmatter; `front`, the frontmatter's lines as { from, to }, or null; and `headings` outside
// both, each { at, level, title }.
function outline(text) {
  const lines = text.split(/(?<=\n)/u);
  const texts = lines.map((line) => line.replace(/\r?\n$/u, ''));
  const close = texts[0].trimEnd() === '---' ? texts.findIndex((line, at) => at > 0 && line.trimEnd() === '---') : -1;
  const code = [...texts.slice(0, close + 1).fill(true), ...fencedIn(texts.slice(close + 1))];
  const headings = texts.flatMap((line, at) => {
    const found = code[at] ? null : /^ {0,3}(#{1,6})[ \t]+(\S.*)$/u.exec(line);
    return found ? [{ at, level: found[1].length, title: found[2].trimEnd().replace(/(?<=[ \t])#+$/u, '').trimEnd() }] : [];
  });
  return { lines, texts, code, front: close > 0 ? { from: 1, to: close } : null, headings };
}

// The line after the last of the section `heading` opens: the next heading of its level or above, or the end.
const sectionEnd = ({ headings, lines }, { at, level }) => headings.find((each) => each.at > at && each.level <= level)?.at ?? lines.length;

// Every `### Slice <id>` section, each { id, from, to }. The id is the first word, without the colon a title may follow.
const slices = (plan) => plan.headings.flatMap((heading) => {
  const id = heading.level === 3 ? /^Slice\s+(\S+)/u.exec(heading.title)?.[1].replace(/:$/u, '') : null;
  return id ? [{ id, from: heading.at + 1, to: sectionEnd(plan, heading) }] : [];
});

// The lines of the slice's own fenced block, as { from, to }: the one whose `slice_id` is the slice's id, or, when no block
// in its section holds a `slice_id`, the first that closes.
function ownBlock(plan, slice) {
  const blocks = [];
  for (let at = slice.from; at < slice.to; at += 1) {
    if (!plan.code[at]) continue;
    const open = fenceOf(plan.texts[at]);
    const from = at + 1;
    for (at = from; at < slice.to && plan.code[at] && !closes(fenceOf(plan.texts[at]), open); at += 1);
    if (at < slice.to && plan.code[at]) blocks.push({ from, to: at });
  }
  const named = blocks.map((block) => ({ block, at: fieldAt(plan, block, 'slice_id', sliceName(slice)) })).filter(({ at }) => at !== null);
  const own = named.filter(({ at }) => SLICE_ID.exec(plan.texts[at])?.[1] === slice.id);
  if (own.length > 1 || (own.length === 0 && named.length > 0)) refuse(`${sliceName(slice)} has ${own.length || 'no'} fenced blocks with its own slice_id`);
  return own[0]?.block ?? blocks[0] ?? refuse(`${sliceName(slice)} has no fenced block`);
}

// A `slice_id:` line's id: one word, quoted or not.
const SLICE_ID = /^slice_id:[ \t]+["']?([^\s"'#]+)/u;

const sliceName = ({ id }) => `slice ${JSON.stringify(id)}`;

// The line of the top-level field `key` in a block, or null. One held twice is refused: either could be the one in force.
function fieldAt({ texts }, { from, to }, key, where) {
  const found = [];
  for (let at = from; at < to; at += 1) if (new RegExp(`^${key}:(?![^ \\t])`, 'u').test(texts[at])) found.push(at);
  if (found.length > 1) refuse(`${where} holds ${found.length} ${key}: lines`);
  return found[0] ?? null;
}

// A `status:` line whose value is one word, quoted or not, with an optional comment after it.
const STATUS = /^status:([ \t]*)(?![ \t])(?:"([^"\\]*)"|'([^']*)'|([A-Za-z][\w-]*))?(?:[ \t]*(?<=[ \t])#.*)?$/u;

// The status line of a block: { at, value, write }, where `write` gives the line with another value, in the line's own
// quotes and without its comment.
function statusOf(plan, block, where) {
  const at = fieldAt(plan, block, 'status', where) ?? refuse(`${where} has no status: line`);
  const found = STATUS.exec(plan.texts[at].trimEnd());
  if (!found || (at + 1 < block.to && /^[ \t]+[^\s#]/u.test(plan.texts[at + 1]))) refuse(`${where} has a status: line whose value is not one word on that line`);
  const [, space, double, single, bare] = found;
  const quote = single === undefined ? '"' : "'";
  const write = (value) => `status:${space || ' '}${bare === undefined ? `${quote}${value}${quote}` : value}${lineEnd(plan.lines[at])}`;
  return { at, value: double ?? single ?? bare ?? '', write };
}

const lineEnd = (line) => /\r?\n$/u.exec(line)?.[0] ?? '\n';

const statusEdit = (status, value) => (status.value === value ? [] : [{ at: status.at, remove: 1, insert: [status.write(value)] }]);

// The edit that sets a block's `notes`, right after its status line when it has none. A note is one line in JSON's
// quoting, which YAML reads as it is. A value over several lines is replaced whole, up to the next field.
function noteEdit(plan, block, status, note, where) {
  const line = `notes: ${JSON.stringify(note)}${lineEnd(plan.lines[status.at])}`;
  const at = fieldAt(plan, block, 'notes', where);
  if (at === null) return [{ at: status.at + 1, remove: 0, insert: [line] }];
  let end = at + 1;
  while (end < block.to && /^(?:$|[ \t]|-(?:[ \t]|$))/u.test(plan.texts[end])) end += 1;
  if (end < block.to && !/^(?:#|[\w"'][^:]*:(?![^ \t]))/u.test(plan.texts[end])) refuse(`${where} has a notes: field whose end cannot be told`);
  while (plan.texts[end - 1].trim() === '') end -= 1;
  return plan.lines.slice(at, end).join('') === line ? [] : [{ at, remove: end - at, insert: [line] }];
}

// `plan` with each of `edits`, { at, remove, insert }, made: { text, changes }, with every other line as it was. A line
// put after a last line that has no line end gives it one.
function apply(plan, edits) {
  const lines = [...plan.lines];
  const changes = [];
  for (const { at, remove, insert } of [...edits].sort((a, b) => b.at - a.at)) {
    const lead = at > 0 && !lines[at - 1].endsWith('\n') ? lineEnd(plan.lines[0]) : '';
    lines.splice(at, remove, lead, ...insert);
    changes.unshift({ at, old: plan.lines.slice(at, at + remove), now: insert });
  }
  return { text: lines.join(''), changes };
}

function setEdit(rest, { note, plan: planStatus }) {
  if (planStatus !== undefined) {
    if (rest.length || note !== undefined) refuse('plan set takes --plan STATUS, or a slice and its status, never both, and --note with a slice alone');
    if (!PLAN_STATUSES.includes(planStatus)) refuse(`--plan takes ${PLAN_STATUSES.join(', ')}, not ${JSON.stringify(planStatus)}; planning-agent sets any other`);
    return (text) => planEdit(outline(text), planStatus);
  }
  const [id, value, ...more] = rest;
  if (!id || more.length) refuse('plan set takes one slice and its status, or --plan STATUS');
  if (!SLICE_STATUSES.includes(value)) refuse(`a slice's status is ${SLICE_STATUSES.join(', ')}, not ${JSON.stringify(value ?? '')}`);
  if (note !== undefined && hasHidden(note)) refuse(oneLine('--note'));
  return (text) => sliceEdit(outline(text), id, value, note);
}

const oneLine = (name) => `${name} is one line of text: no line break, tab, or other character that does not show`;

function planEdit(plan, value) {
  if (!plan.front) refuse('the plan has no frontmatter');
  if (value === 'complete') {
    const open = slices(plan).filter((slice) => statusOf(plan, ownBlock(plan, slice), sliceName(slice)).value !== 'complete');
    if (open.length) refuse(`not complete: ${open.map(sliceName).join(', ')}`);
    if (slices(plan).length === 0) refuse('the plan has no slice to read as complete');
  }
  return apply(plan, statusEdit(statusOf(plan, plan.front, 'the frontmatter'), value));
}

function sliceEdit(plan, id, value, note) {
  const all = slices(plan);
  const found = all.filter((slice) => slice.id === id);
  if (found.length === 0) refuse(`the plan has no ${sliceName({ id })}; it has ${all.map((slice) => slice.id).join(', ') || 'none'}`);
  if (found.length > 1) refuse(`the plan has ${found.length} slices named ${JSON.stringify(id)}`);
  const block = ownBlock(plan, found[0]);
  const status = statusOf(plan, block, sliceName({ id }));
  return apply(plan, [...statusEdit(status, value), ...(note === undefined ? [] : noteEdit(plan, block, status, note, sliceName({ id })))]);
}

function recordEdit(rest, { by, text, 'text-file': from }) {
  if (rest.length) refuse(`unexpected argument: ${rest[0]}`);
  if ((text === undefined) === (from === undefined)) refuse('plan record takes --text or --text-file, one of them');
  const who = plainLine(by)?.trim() ?? refuse(`--by names who decided or did what is recorded. ${oneLine('--by')}`);
  const words = text === undefined ? fileWords(from) : textWords(text);
  const entry = [`- ${today()}, ${who}: ${words[0]}`, ...words.slice(1).map((line) => line && `  ${line}`)];
  return (before) => historyEdit(outline(before), entry);
}

function textWords(text) {
  if (text.trim() === '') refuse('the record is empty');
  return [plainLine(text)?.trim() ?? refuse(`${oneLine('--text')}; --text-file takes more lines`)];
}

// A line that would open a heading or a code fence, or underline a heading, even behind list or quote markers.
const MARKERS = /^(?:\s|>|(?:[-*+]|\d+[.)])(?=\s))+/u;
const opensBlock = (line) => /^[\s>]*(?:=+|-+)\s*$/u.test(line) || /^(?:#{1,6}(?:\s|$)|`{3}|~{3})/u.test(line.replace(MARKERS, ''));

// The lines of a record's text file. They go in one list item, each after the first indented, so none starts an entry.
function fileWords(from) {
  const { text, missing } = readOnce(path.resolve(from));
  // A byte that is no UTF-8 reads as U+FFFD.
  if (text === undefined || text.includes('\ufffd')) refuse(missing ? `${from} is no file` : `${from} cannot be read as UTF-8 text`);
  if (text.trim() === '') refuse('the record is empty');
  return text.trim().split(/\r?\n/u).map((raw) => {
    const line = raw.trimEnd();
    if (hasHidden(line)) refuse(`${from} holds a tab or another character that does not show`);
    if (opensBlock(line)) refuse(`${from} holds a heading, a code fence, or a line of only dashes or equals signs, which a record takes none of: ${line.trim()}`);
    return line;
  });
}

function historyEdit(plan, entry) {
  const found = plan.headings.filter((heading) => heading.level === 2 && HISTORY.test(heading.title));
  if (found.length > 1) refuse('the plan has more than one Revision history section');
  const end = lineEnd(plan.lines[0]);
  let at = found.length ? sectionEnd(plan, found[0]) : plan.lines.length;
  while (found.length && plan.texts[at - 1].trim() === '') at -= 1;
  const before = plan.texts[at - 1];
  const gap = found.length ? !LIST_ITEM.test(before) && !/^[ \t]+\S/u.test(before) : before.trim() !== '';
  const title = found.length ? [] : ['## Revision history', ''];
  const insert = [...(gap ? [''] : []), ...title, ...entry];
  const result = apply(plan, [{ at, remove: 0, insert: insert.map((line) => `${line}${end}`) }]);
  // A fence the plan leaves open would take the entry, and the new section's heading, as code.
  if (outline(result.text).code.slice(at, at + insert.length).includes(true)) refuse('the plan leaves a code fence open before its end, so a record there would read as code');
  return result;
}
