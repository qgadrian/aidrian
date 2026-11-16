// Where `aidrian handoff` (lib/handoff-brief.mjs) finds the brief a brief supersedes, and how it keeps one. The prior is
// --prior, else the snapshot at `<dir>/.prior/<name>`, else the newest other brief with the same slug (<date>-<slug>.md).
// A snapshot is written to a temporary file of a random name in `.prior/` and renamed over its name: a rename replaces a
// link planted at that name instead of writing through it, and a `.prior` that is itself a link is refused, as is a
// stale snapshot's removal through one. A `.prior/` this module creates is 0700, and every snapshot file is 0600, as the
// continuation store's files are, since a brief can carry ids and hand-edited data; a `.prior/` that exists keeps its mode.

import { randomBytes } from 'node:crypto';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BRIEF_NAME = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/;

// `<dir>/.prior/<name>`: where `snapshot` keeps the brief an overwrite destroys, and a pass keeps what passed.
export function snapshotPath(briefPath) {
  return path.join(path.dirname(briefPath), '.prior', path.basename(briefPath));
}

// The newest other `<date>-<slug>.md` beside the brief with the same slug, dated no later than it; or null.
export function findSupersededBrief(briefPath) {
  const dir = path.dirname(briefPath);
  const name = path.basename(briefPath);
  const match = name.match(BRIEF_NAME);
  if (!match || !existsSync(dir)) return null;
  const newest = readdirSync(dir)
    .filter((file) => {
      const other = file.match(BRIEF_NAME);
      return file !== name && other?.[2] === match[2] && other[1] <= match[1];
    })
    .sort()
    .at(-1);
  return newest ? path.join(dir, newest) : null;
}

export function resolvePrior(briefPath, explicitPrior) {
  if (explicitPrior) return { path: explicitPrior, source: 'explicit' };
  if (existsSync(snapshotPath(briefPath))) return { path: snapshotPath(briefPath), source: 'snapshot' };
  const sameSlug = findSupersededBrief(briefPath);
  return sameSlug ? { path: sameSlug, source: 'same slug' } : null;
}

// Whether two paths are one file: the same device and inode, which a symlink, a hard link, and a letter-case variant
// on a case-insensitive disk all share. false when either cannot be read.
export function samePath(a, b) {
  try {
    const [one, other] = [statSync(a, { bigint: true }), statSync(b, { bigint: true })];
    return one.dev === other.dev && one.ino === other.ino;
  } catch {
    return false;
  }
}

// Whether the brief's `.prior` folder is a link, which no snapshot is written or removed through.
const linkedPrior = (briefPath) => {
  try {
    return lstatSync(path.dirname(snapshotPath(briefPath))).isSymbolicLink();
  } catch {
    return false;
  }
};

// Writes `bytes` as the brief's snapshot, by a temporary file and a rename. Throws what the disk refuses. The temporary
// name is random and created exclusively before the try, so the cleanup only ever removes this call's own file.
export function writeSnapshot(briefPath, bytes) {
  const snapshot = snapshotPath(briefPath);
  mkdirSync(path.dirname(snapshot), { recursive: true, mode: 0o700 });
  if (linkedPrior(briefPath)) throw Object.assign(new Error('.prior is a symlink'), { code: 'ESYMLINK' });
  const temporary = path.join(path.dirname(snapshot), `.${path.basename(snapshot)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
  try {
    renameSync(temporary, snapshot);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return snapshot;
}

// Copies what the coming write supersedes into the snapshot, or clears a stale snapshot when nothing is. A snapshot the
// disk refuses to write or to clear, such as a folder at its name, is a problem: { source, problem }.
export function takeSnapshot(briefPath, explicitPrior) {
  const snapshot = snapshotPath(briefPath);
  const source = explicitPrior ?? (existsSync(briefPath) ? briefPath : findSupersededBrief(briefPath));
  if (!source) {
    try {
      if (!linkedPrior(briefPath)) rmSync(snapshot, { force: true });
    } catch (error) {
      return { source: briefPath, problem: `cannot be saved to ${snapshot} (${error.code ?? error.message})` };
    }
    return null;
  }
  const reason = unreadable(source);
  if (reason) return { source, problem: reason };
  try {
    writeSnapshot(briefPath, readFileSync(source));
  } catch (error) {
    return { source, problem: `cannot be saved to ${snapshot} (${error.code ?? error.message})` };
  }
  return { source, snapshot };
}

// Why a path cannot be read as a brief, or null.
export function unreadable(file) {
  try {
    if (!statSync(file).isFile()) return 'is not a file';
    accessSync(file, constants.R_OK);
    return null;
  } catch (error) {
    return error.code === 'ENOENT' ? 'does not exist' : `cannot be read (${error.code})`;
  }
}
