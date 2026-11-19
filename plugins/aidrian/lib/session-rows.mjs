// The rows of a session file appended in place (lib/session-folder.mjs APPENDED_FILES), read by their tail: the pull
// request ledger `prs.jsonl` (lib/session-prs.mjs) and the links `links.jsonl` (lib/session-links.mjs), and appended to. Display data only: no hook, gate, skill, or agent decides anything
// from them. This file names no host, forge, or tracker.

import { appendSessionFile, exclusive, LOCK_WINDOW_MS, readSessionTail, reserveSessionFile, writeSessionFile } from './session-folder.mjs';

export { LOCK_WAIT_MS, LOCK_WINDOW_MS } from './session-folder.mjs';

// The row objects of the last `maxBytes` of the file `name` in `folder`, oldest first, read no-follow and non-blocking
// through readSessionTail: a first line the cut fell inside and a last line still being written are dropped, and so is
// a line that is no row object. [] for a file that is not there. Null when the file cannot be read as the session
// folder's rules allow, such as a named pipe or a symlink there. Never throws.
export function readRows(folder, name, { maxBytes, ...options } = {}) {
  const read = readSessionTail(folder, name, { ...options, maxBytes });
  if (read === null) return null;
  return tailLines(read).flatMap((line) => {
    const row = parsed(line);
    return row === null ? [] : [row];
  });
}

// The whole lines of a tail readSessionTail gave, `{ text, cut }`: a first line the cut fell inside and a last line
// still being written are no lines.
export function tailLines({ text, cut }) {
  const lines = text.split('\n');
  lines.pop();
  if (cut) lines.shift();
  return lines;
}

// The row object a line holds, or null.
export function parsed(line) {
  try {
    const row = JSON.parse(line);
    return row !== null && typeof row === 'object' && !Array.isArray(row) ? row : null;
  } catch {
    return null;
  }
}

// Appends `rows` to the file `name`, one of APPENDED_FILES, in `folder`, which sessionFolder gave, under its cap
// `maxBytes`, as one step no other writer of the file runs beside (exclusive): it reads the file's last `maxBytes`
// through readSessionTail and writes nothing when that read is refused; a cut first line and a partial last line are no
// lines; `select(lines, rows)` gives the rows to write, all of them when none is given, so a writer that leaves out a
// repeat decides it from the lines it reads. The rows are appended in place while the tail was read whole and they keep
// the file within `maxBytes`, after a line end when the file ends inside a line, so a row cut short by a killed writer
// takes no new row with it. Else the file is rewritten through a temporary file and a rename: the newest rows of the
// batch that fit in `maxBytes`, after the newest lines read that fit in what is left, and in half of `maxBytes` at most,
// so the file never passes its cap. A file left past it, as by an older writer, is compacted the same way. Returns
// whether it wrote. Never throws.
export function appendRows(folder, name, rows, { maxBytes, select = (lines, given) => given, ...options } = {}) {
  if (typeof folder !== 'string' || !Array.isArray(rows) || rows.length === 0) return false;
  // A file the session folder's rules refuse waits for no reservation: it would never be written.
  if (readSessionTail(folder, name, { ...options, maxBytes: 0 }) === null) return false;
  const ids = { ...(options.uid === undefined ? {} : { uid: options.uid }), ...(options.gid === undefined ? {} : { gid: options.gid }) };
  return exclusive((at) => reserveSessionFile(folder, name, { windowMs: LOCK_WINDOW_MS, now: at, ...ids }), () => {
    const read = readSessionTail(folder, name, { ...options, maxBytes });
    if (read === null) return false;
    const lines = tailLines(read);
    const fresh = select(lines, rows);
    if (fresh.length === 0) return false;
    const text = fresh.map((row) => `${JSON.stringify(row)}\n`).join('');
    const lead = read.text !== '' && !read.text.endsWith('\n') ? '\n' : '';
    if (!read.cut && Buffer.byteLength(read.text) + Buffer.byteLength(lead + text) <= maxBytes) return appendSessionFile(folder, name, lead + text, { ...options, maxBytes });
    const added = newestLines(fresh.map((row) => JSON.stringify(row)), maxBytes);
    const room = Math.min(maxBytes / 2, maxBytes - bytesOf(added));
    const compacted = [...newestLines(lines, room), ...added].map((line) => `${line}\n`).join('');
    return writeSessionFile(folder, name, compacted, options) !== null;
  });
}

const bytesOf = (lines) => lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);

// The newest of `lines` that are row objects and fit in `budget` bytes, oldest first.
function newestLines(lines, budget) {
  const kept = [];
  let bytes = 0;
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    const size = Buffer.byteLength(lines[at]) + 1;
    if (parsed(lines[at]) === null) continue;
    if (bytes + size > budget) break;
    kept.unshift(lines[at]);
    bytes += size;
  }
  return kept;
}
