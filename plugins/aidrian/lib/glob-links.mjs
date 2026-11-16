// The link walk the write guards share: whether a glob a command writes through, from a folder the guard knows, may
// reach a guarded file through a link that is already on disk, in any part a wildcard matches. A shell expands the
// glob against what is there and writes through each link it matches, so `tee /tmp/alias*` writes a guarded file that
// `/tmp/alias` links to, and `/va*/x` passes macOS's `/var` link to `/private/var/x`, although neither spells the file's
// path. lib/config-guard.mjs asks it for the config files and the local file, from Bash, Monitor, and PowerShell globs
// alike; lib/handoff-guard.mjs for the continuation store. A call walks each folder once (linkWalk), within the link
// budget and the guards' time budget (lib/deadline.mjs).

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { checkDeadline } from './deadline.mjs';
import { foldCase, globParts, isWithin, partsReach } from './fs.mjs';
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
// name. A relative glob is spelled from each of `dirs`; one with no wildcard part has none.
export function globStarts({ text, dirs = [] }) {
  const spelled = path.isAbsolute(text) ? [text] : dirs.map((dir) => path.join(dir, text));
  return spelled.flatMap((each) => {
    const parts = path.resolve(each).split(path.sep);
    const at = parts.findIndex((part) => GLOB_WORD.test(part));
    if (at <= 0) return [];
    // The root splits to an empty part, or a drive's name, that needs its separator back.
    const head = parts.slice(0, at).join(path.sep);
    return [{ start: at === 1 ? `${head}${path.sep}` : head, rest: parts.slice(at) }];
  });
}

// Whether a glob `{ text, dirs }` passes a link to `file`, or to a folder that holds it, in any folder its spellings
// reach (linkBelow). `below` says whether `file` is a folder a write inside reaches too, as the continuation store is.
export const globLinksTo = (glob, file, seen, { below = false } = {}) =>
  globStarts(glob).some(({ start, rest }) => linkBelow(start, rest, file, seen, below));

// Whether glob path parts `rest`, from the folder `start`, pass a link to `file`, or to a folder that holds it, in any
// folder they reach: each part is matched, in any case, against what is there, folder by folder, the folders a link
// leads to included. With `below`, a link that leads inside `file` counts too. Each folder is read once a call
// (entriesOf), so the entries count against `seen.left` once, however many guarded files and spellings walk it; past
// it, the glob counts as one that reaches it. Each link is resolved from the folder's spelling that reached it (realOf).
// A folder two links lead to is walked once a part, so the walk costs at most its parts times the entries it reads.
export function linkBelow(start, rest, file, seen, below = false) {
  let level = [start];
  for (const [i, part] of rest.entries()) {
    const matches = partMatcher(part);
    const next = new Set();
    for (const dir of level) {
      checkDeadline();
      const found = entriesOf(dir, seen);
      if (found === null) return true;
      for (const entry of found.filter(({ name }) => matches(name))) {
        if (entry.link) {
          const real = realOf(path.join(dir, entry.name), seen);
          if (linkReaches(real, rest.slice(i + 1), file, below)) return true;
          next.add(real);
        } else if (entry.folder) next.add(path.join(dir, entry.name));
      }
    }
    level = [...next];
  }
  return false;
}

// What a folder holds for linkBelow, cached in `seen.entries` by the folder on disk, so each folder counts against
// `seen.left` once a call: each entry's name, and whether it is a link or a folder; or null past the link budget. Where a
// link leads is not kept here, as another spelling of the folder resolves it to another path (realOf). `seen.keys` caches
// each spelling's folderKey.
function entriesOf(dir, seen) {
  if (!seen.keys.has(dir)) seen.keys.set(dir, folderKey(dir));
  const key = seen.keys.get(dir);
  if (!seen.entries.has(key)) {
    let found = [];
    try {
      found = readdirSync(dir, { withFileTypes: true });
    } catch {
      // A folder it cannot read holds nothing it can match.
    }
    seen.left -= found.length;
    seen.entries.set(key, seen.left < 0 ? null : found.map((entry) => ({ name: entry.name, link: entry.isSymbolicLink(), folder: entry.isDirectory() })));
  }
  return seen.entries.get(key);
}

// What a folder holds for a glob's first part: { dirs, real, links }, or null past the link budget. `dirs` are its
// spellings, as given and with its links resolved; `real` is the second; `links` are the names of the links in it, which
// a guard resolves from `real` (realOf) only when the glob matches one. The names are cached in `seen.folders` by the
// folder on disk, so another spelling of it, in another letter case or with `.` parts, reads and counts them once.
export function folderOf(folder, seen) {
  const real = canonical(folder);
  const key = folderKey(real);
  if (!seen.folders.has(key)) {
    let names = [];
    try {
      names = readdirSync(real, { withFileTypes: true }).filter((entry) => entry.isSymbolicLink()).map(({ name }) => name);
    } catch {
      // A folder it cannot read holds nothing it can match.
    }
    seen.left -= names.length;
    seen.folders.set(key, seen.left < 0 ? null : names);
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
// (reachesFile), or, with `below`, a path inside `file`. The paths are compared as the disk compares them (foldCase):
// on a disk that ignores case, `WEBAPP/conf` holds `webapp/conf/app.json`, though no string compare says so.
export function linkReaches(real, rest, file, below = false) {
  const [dir, target] = [foldCase(real), foldCase(file)];
  if (dir === target || sameFile(real, file)) return true;
  if (below && isWithin(target, dir)) return true;
  return isWithin(dir, target) && reachesFile(rest, path.relative(dir, target).split(path.sep), below);
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
