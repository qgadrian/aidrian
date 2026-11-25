// The `*** Begin Patch` format two hosts' file tools take: Codex's apply_patch and OpenCode's patch. A leaf that imports
// nothing, so each adapter reads a patch the same way, in time that grows with its size alone.
//
// The two hosts' parsers find a header alike (Codex 0.172.0's codex-rs/apply-patch/src/streaming_parser.rs, at the tag
// rust-v0.172.0, and OpenCode 2.4.1's packages/util/src/patch.ts): they split on `\n`, drop one `\r` at a line's end, and
// trim the line first, but inside an Update section, where an indented line is context, only its end. Each reading below
// is that one joined with a plain one, line by line, and gives every target, added line, and operation either finds.

const HEADERS = Object.freeze([['add', '*** Add File: '], ['update', '*** Update File: '], ['delete', '*** Delete File: ']]);
const MOVE = '*** Move to: ';

// `text` without the blank characters around it, as either host's trim reads blank: JavaScript's, and U+0085, which
// Rust's trims too.
const BLANK = /[\s\u0085]/u;
function trimmed(text, { start = true } = {}) {
  let [from, to] = [0, text.length];
  while (start && from < to && BLANK.test(text[from])) from += 1;
  while (to > from && BLANK.test(text[to - 1])) to -= 1;
  return text.slice(from, to);
}

// Each line of the patch `text` as { line, kind, file }: `kind` is the section a header opens (add, update, delete), move
// for a `*** Move to:`, or null, and `file` the path it names, as the hosts read it. A header's `line` is trimmed.
function hostLines(text) {
  let updating = false;
  return text.split('\n').map((each) => {
    const line = each.endsWith('\r') ? each.slice(0, -1) : each;
    const header = trimmed(line, { start: !updating });
    const [kind, marker] = HEADERS.find(([, prefix]) => header.startsWith(prefix)) ?? [];
    if (kind) {
      updating = kind === 'update';
      return { line: header, kind, file: trimmed(header.slice(marker.length)) };
    }
    return line.startsWith(MOVE) ? { line, kind: 'move', file: trimmed(line.slice(MOVE.length)) } : { line, kind: null, file: null };
  });
}

// The same of the plain reading. A section header's `line` is trimmed, as the hosts' is, so a blank after it gives no
// second operation.
const PLAIN = /^\*\*\* (?:(Add|Update|Delete) File|Move to): (.+)$/u;
const plainLines = (text) => text.split(/\r?\n/u).map((line) => {
  const [, kind, file] = PLAIN.exec(line) ?? [];
  if (file === undefined) return { line, kind: null, file: null };
  return { line: kind ? trimmed(line) : line, kind: kind ? kind.toLowerCase() : 'move', file: file.trim() };
});

// `read(lines)`, a list, of the hosts' reading of a patch, and each entry of the plain one's that differs from them all.
function bothReadings([host, plain], read) {
  const found = read(host);
  const seen = new Set(found.map((each) => JSON.stringify(each)));
  return [...found, ...read(plain).filter((each) => !seen.has(JSON.stringify(each)))];
}

// The files a patch adds to or updates, as [{ file, added }], each with the lines it adds, up to the next header; a
// deleted file adds none. A `*** Move to:` that names no path keeps the file it follows, and its lines.
function filesOf(lines) {
  const files = [];
  for (const { line, kind, file } of lines) {
    if (kind === 'add' || kind === 'update') files.push({ file, added: [] });
    else if (kind === 'delete') files.push({ file: null, added: [] });
    else if (files.at(-1)?.file) {
      if (kind === 'move' && file) files.at(-1).file = file;
      else if (line.startsWith('+')) files.at(-1).added.push(line.slice(1));
    }
  }
  return files.filter(({ file }) => file);
}

// The operations of a patch, each { kind, file, move, text }: what its header does to the file it names, the file a
// `*** Move to:` line moves it to, or null, and the operation's own lines, headers included.
function operationsOf(lines) {
  const operations = [];
  for (const { line, kind, file } of lines) {
    if (kind && kind !== 'move') operations.push({ kind, file, move: null, text: `${line}\n` });
    else if (operations.length && !/^\*\*\* (?:Begin|End) Patch/u.test(line)) {
      if (kind === 'move') operations.at(-1).move = file;
      operations.at(-1).text += `${line}\n`;
    }
  }
  return operations;
}

// The paths the plain reading finds anywhere a line may start.
const PLAIN_TARGET = new RegExp(PLAIN.source, 'gmu');

function read(text) {
  const readings = [hostLines(text), plainLines(text)];
  const targets = readings[0].filter(({ kind }) => kind).map(({ file }) => file);
  const named = new Set(targets);
  const plain = [...text.matchAll(PLAIN_TARGET)].map((match) => match[2].trim()).filter((file) => !named.has(file));
  return { shape: 'patch', text, files: bothReadings(readings, filesOf), operations: bothReadings(readings, operationsOf), targets: [...targets, ...plain] };
}

// A patch's file edit in the shape lib/hosts/index.mjs fileEditOf reads: { shape: 'patch', text, files, operations,
// targets }, with `targets` every path a section header or a move names, deleted files among them. Every guard of a call
// asks it, so the last patch is read once; nothing changes what it returns.
let last = null;
export function patchEdit(text) {
  if (last?.text !== text) last = read(text);
  return last;
}
