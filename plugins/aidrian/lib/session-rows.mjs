// The rows of a session file appended in place (lib/session-folder.mjs APPENDED_FILES), read by their tail: the pull
// request ledger `prs.jsonl` (lib/session-prs.mjs). Display data only: no hook, gate, skill, or agent decides anything
// from them. This file names no host, forge, or tracker.

import { readSessionTail } from './session-folder.mjs';

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
