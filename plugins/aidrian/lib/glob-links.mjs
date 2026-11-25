// The link walk the write guards share: whether a glob a command writes through, from a folder the guard knows, may
// reach a guarded file through a link that is already on disk, in any part a wildcard matches. A shell expands the
// glob against what is there and writes through each link it matches, so `tee /tmp/alias*` writes a guarded file that
// `/tmp/alias` links to, and `/va*/x` passes macOS's `/var` link to `/private/var/x`, although neither spells the file's
// path. lib/config-guard.mjs asks it for the config files and the local file, from Bash, Monitor, and PowerShell globs
// alike; lib/handoff-guard.mjs for the continuation store. A call walks each folder once (linkWalk), within the link
// budget and the guards' time budget (lib/deadline.mjs).

import { lstatSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { checkDeadline } from './deadline.mjs';
import { foldCase, globParts, isWithin, joinSpelled, partsReach, systemPath } from './fs.mjs';
import { canonical } from './rules/main-checkout.mjs';

// A path part a shell expands as a glob.
export const GLOB_WORD = /[*?[]/u;

// The most entries the guards read and test for one call; past it, a glob counts as one that may reach the file.
export const LINK_BUDGET = 100000;

// What a call's guards have read on disk, shared by every guard of the call `input` so each folder counts against the
// link budget once: { folders, entries, keys, reals, left }, the caches of folderOf, entriesOf, and realOf, and the
// entries left to read.
export function linkWalk(input) {
  if (!walks.has(input)) walks.set(input, { folders: new Map(), entries: new Map(), keys: new Map(), reals: new Map(), left: LINK_BUDGET });
  return walks.get(input);
}

const walks = new WeakMap();

// Each spelling of a glob `{ text, dirs }`, as a guard reads it from a command, as { start, rest }: `start` is the
// folder of its parts before the first that holds a wildcard, and `rest` its parts from there on, each a glob or a plain
// name. A relative glob is spelled from each of `dirs`; one with no wildcard part has none. Each spelling is read twice
// when the two differ: folded as text, and as spelled with its folder where the system lands (fs.mjs systemPath), where
// a `..` after a link climbs from the link's target, its later parts as written; a guard refuses what either reaches.
// Accepted residual: a `..` after the first wildcard part is a plain part to the link walk, which cannot tell where it
// climbs from a link a wildcard matched; the unattended write allowlist refuses such a glob outright.
export function globStarts({ text, dirs = [] }) {
  const spelled = path.isAbsolute(text) ? [text] : dirs.map((dir) => joinSpelled(dir, text));
  const split = (parts) => {
    const at = parts.findIndex((part) => GLOB_WORD.test(part));
    if (at <= 0) return null;
    // The root splits to an empty part, or a drive's name, that needs its separator back.
    const head = parts.slice(0, at).join(path.sep);
    return { folder: at === 1 ? `${head}${path.sep}` : head, rest: parts.slice(at) };
  };
  return spelled.flatMap((each) => {
    const folded = split(path.resolve(each).split(path.sep));
    const starts = folded ? [{ start: folded.folder, rest: folded.rest }] : [];
    const raw = split(each.split(path.sep));
    const system = raw ? systemPath(raw.folder) : null;
    const rest = raw?.rest.filter((part) => part !== '' && part !== '.');
    const same = folded && foldCase(system ?? '') === foldCase(canonical(folded.folder)) && rest.join(path.sep) === folded.rest.join(path.sep);
    if (system && !same) starts.push({ start: system, rest });
    return starts;
  });
}

// Whether a glob `{ text, dirs }` passes a link to `file`, or to a folder that holds it, in any folder its spellings
// reach (linkBelow). `below` says whether `file` is a folder a write inside reaches too, as the continuation store is.
export const globLinksTo = (glob, file, seen, { below = false } = {}) =>
  globStarts(glob).some(({ start, rest }) => linkBelow(start, rest, file, seen, below));

// Whether glob path parts `rest`, from the folder `start`, pass a link to `file`, or to a folder that holds it, in any
// folder they reach: each wildcard part is matched, in any case, against what is there, folder by folder, the folders a
// link leads to included, and each plain part is looked up by its name (entryAt), as a shell passes it with search
// permission alone, so a link in a folder it may pass but not list counts too. A wildcard part in a folder it may not list
// counts as one that reaches the file (UNREADABLE): failing closed. The time budget is checked at each entry, so no
// folder of many long names holds the walk past it. With `below`, a link that leads inside `file` counts too. Each
// folder is read once a call (entriesOf), so the entries count against `seen.left` once, however many guarded files and
// spellings walk it, and so does each plain look-up; past it, the glob counts as one that reaches it. Each link is resolved from the folder's spelling that reached it (realOf).
// A part that is only stars, as zsh's `**`, spans any number of folders, none included, and a run of them reads as one.
// Inside it the walk follows a link to a folder too, though the shell may not: failing closed. It visits each folder on
// disk once a part (folderKey), so a link that loops ends the walk there. A folder two links lead to is walked once a
// part, so the walk costs at most its parts times the entries it reads, however many such parts the glob has.
export function linkBelow(start, rest, file, seen, below = false) {
  const parts = rest.filter((part, i) => !(MANY.test(part) && MANY.test(rest[i - 1] ?? '')));
  let level = [start];
  for (const [i, part] of parts.entries()) {
    const many = MANY.test(part);
    const plain = !many && !GLOB_WORD.test(part);
    const matches = many || plain ? () => true : partMatcher(part);
    // Past a link, the parts still to match: a `**` part may match more folders below the link's target.
    const after = parts.slice(many ? i : i + 1);
    const next = new Set();
    const visited = new Set();
    const queue = [...level];
    for (let at = 0; at < queue.length; at += 1) {
      const dir = queue[at];
      checkDeadline();
      if (many) {
        const key = keyOf(dir, seen);
        if (visited.has(key)) continue;
        visited.add(key);
        next.add(dir);
      }
      const found = plain ? entryAt(dir, part, seen) : entriesOf(dir, seen);
      if (found === null || (found === UNREADABLE && !many)) return true;
      for (const entry of found === UNREADABLE ? [] : found) {
        checkDeadline();
        if (!matches(entry.name)) continue;
        const reached = entry.link ? realOf(path.join(dir, entry.name), seen) : path.join(dir, entry.name);
        if (entry.link && linkReaches(reached, after, file, below)) return true;
        if (!entry.link && !entry.folder) continue;
        if (many) queue.push(reached);
        else next.add(reached);
      }
    }
    level = [...next];
  }
  return false;
}

// A glob part that is only stars, which zsh, and bash with globstar, read as any number of folders.
const MANY = /^\*{2,}$/u;

// A folder's folderKey, cached in `seen.keys` by its spelling.
function keyOf(dir, seen) {
  if (!seen.keys.has(dir)) seen.keys.set(dir, folderKey(dir));
  return seen.keys.get(dir);
}

// What a folder holds for linkBelow, cached in `seen.entries` by the folder on disk, so each folder counts against
// `seen.left` once a call: each entry's name, and whether it is a link or a folder; null past the link budget; or
// UNREADABLE for a folder that is there but may not be listed, which a shell may still pass by a plain name. Where a
// link leads is not kept here, as another spelling of the folder resolves it to another path (realOf). `seen.keys` caches
// each spelling's folderKey.
function entriesOf(dir, seen) {
  const key = keyOf(dir, seen);
  if (!seen.entries.has(key)) {
    let found = [];
    try {
      found = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      // A folder that is not there, or not a folder, holds nothing it can match.
      if (DENIED.has(error.code)) {
        seen.entries.set(key, UNREADABLE);
        return UNREADABLE;
      }
    }
    seen.left -= found.length;
    seen.entries.set(key, seen.left < 0 ? null : found.map((entry) => ({ name: entry.name, link: entry.isSymbolicLink(), folder: entry.isDirectory() })));
  }
  return seen.entries.get(key);
}

// What entriesOf gives for a folder that is there but may not be listed.
const UNREADABLE = Symbol('unreadable');
// The errors of a folder that is there but may not be listed.
const DENIED = new Set(['EACCES', 'EPERM']);

// The entry named `name` in the folder `dir`, as entriesOf gives one, in a list: one entry, or none when there is none
// the call may reach; or null past the link budget. Each look-up counts against `seen.left`.
function entryAt(dir, name, seen) {
  seen.left -= 1;
  if (seen.left < 0) return null;
  try {
    const stat = lstatSync(path.join(dir, name));
    return [{ name, link: stat.isSymbolicLink(), folder: stat.isDirectory() }];
  } catch {
    return [];
  }
}

// What a folder holds for a glob's first part: { dirs, real, links }, or null past the link budget or for a folder that
// is there but may not be listed, as the part may then match a link the guard cannot see: failing closed. `dirs` are its
// spellings, as given and with its links resolved; `real` is the second; `links` are the names of the links in it, which
// a guard resolves from `real` (realOf) only when the glob matches one. The names are cached in `seen.folders` by the
// folder on disk, so another spelling of it, in another letter case or with `.` parts, reads and counts them once.
export function folderOf(folder, seen) {
  const real = canonical(folder);
  const key = folderKey(real);
  if (!seen.folders.has(key)) {
    let names = [];
    let denied = false;
    try {
      names = readdirSync(real, { withFileTypes: true }).filter((entry) => entry.isSymbolicLink()).map(({ name }) => name);
    } catch (error) {
      // A folder that is not there, or not a folder, holds nothing it can match.
      denied = DENIED.has(error.code);
    }
    seen.left -= names.length;
    seen.folders.set(key, seen.left < 0 || denied ? null : names);
  }
  const links = seen.folders.get(key);
  return links === null ? null : { dirs: [...new Set([folder, real])], real, links };
}

// Where the link `at` leads, cached in `seen.reals` by its path as spelled: canonical keeps the letter case it is given,
// so each spelling of a folder resolves its links itself, never to another spelling's target. A link whose target is not
// made yet leads to that target, which a write through it creates.
export function realOf(at, seen) {
  checkDeadline();
  if (!seen.reals.has(at)) seen.reals.set(at, canonical(at));
  return seen.reals.get(at);
}

// Whether the link target `real` is `file`, or a folder that holds it that glob parts `rest` reach below it
// (reachesFile), or, with `below`, a path inside `file` that the glob ends at, or a folder there that it goes on into:
// nothing is written below a file. The paths are compared as the disk compares them (foldCase):
// on a disk that ignores case, `WEBAPP/conf` holds `webapp/conf/app.json`, though no string compare says so.
export function linkReaches(real, rest, file, below = false) {
  const [dir, target] = [foldCase(real), foldCase(file)];
  if (dir === target || sameFile(real, file)) return true;
  if (below && isWithin(target, dir) && (rest.every((part) => MANY.test(part)) || isFolder(real))) return true;
  return isWithin(dir, target) && reachesFile(rest, path.relative(dir, target).split(path.sep), below);
}

// Whether `file` is a folder on disk.
function isFolder(file) {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

// A folder's device and inode, or its path when it cannot be read.
function folderKey(folder) {
  try {
    const { dev, ino } = statSync(folder);
    return `${dev}:${ino}`;
  } catch {
    return folder;
  }
}

// Whether glob path parts reach a guarded file's path parts `reached` below the same folder, in any case (partsReach): one
// that ends above the file names a folder that holds it; one that goes on below the file reaches it only with `below`.
export const reachesFile = (glob, reached, below = false) => partsReach(glob, reached, partMatches, below);

// A test of one path part, a glob or a plain name, against a name in any case.
export function partMatcher(part) {
  if (!GLOB_WORD.test(part)) {
    const lower = part.toLowerCase();
    return (name) => lower === name.toLowerCase();
  }
  const { pattern } = globParts(part, [], 'i');
  return (name) => pattern.test(name);
}

export const partMatches = (part, name) => partMatcher(part)(name);

// Whether two paths are one file on disk: a hard link keeps its own path, so only the device and inode tell.
export function sameFile(a, b) {
  try {
    const [x, y] = [statSync(a), statSync(b)];
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}
