// Where `aidrian handoff` (lib/handoff-brief.mjs) finds the brief a brief supersedes, and how it keeps one. The prior is
// --prior, else the snapshot at `<dir>/.prior/<name>`, else the newest other brief with the same slug (<date>-<slug>.md).
// A snapshot is written to a temporary file of a random name in `.prior/` and renamed over its name: a rename replaces a
// link planted at that name instead of writing through it, and a `.prior` that is itself a link is refused, as is a
// stale snapshot's removal through one. A `.prior/` this module creates is 0700, and every snapshot file is 0600, as the
// continuation store's files are, since a brief can carry ids and hand-edited data; a `.prior/` that exists keeps its mode.
// A project run's driver hands off under the slug `project-<run>`: in a state folder that keeps that run, its prior is
// only a brief whose sha256 a handoff row of the run's ledger records (lib/project-run-gate.mjs recordHandoff), the
// snapshot first, then each other brief of the slug, newest first. Any other session may have written a file there, and
// the check would ask the driver, which no sandbox holds, to carry its steps.

import { createHash, randomBytes } from 'node:crypto';
import { accessSync, closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BRIEF_NAME = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/;
// A project run's handoff slug, `project-<run>`, with the run id as lib/project-run.mjs RUN_ID shapes it.
const RUN_SLUG = /^project-([a-z0-9][a-z0-9-]{0,63})$/u;
// The longest ledger, and the longest brief, read to match a prior with a handoff row.
const LEDGER_CAP = 16 * 1024 * 1024;
const BRIEF_CAP = 4 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;

// `<dir>/.prior/<name>`: where `snapshot` keeps the brief an overwrite destroys, and a pass keeps what passed.
export function snapshotPath(briefPath) {
  return path.join(path.dirname(briefPath), '.prior', path.basename(briefPath));
}

// Every other `<date>-<slug>.md` beside the brief with the same slug, dated no later than it, newest first.
function supersededBriefs(briefPath) {
  const dir = path.dirname(briefPath);
  const name = path.basename(briefPath);
  const match = name.match(BRIEF_NAME);
  if (!match || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => {
      const other = file.match(BRIEF_NAME);
      return file !== name && other?.[2] === match[2] && other[1] <= match[1];
    })
    .sort()
    .reverse()
    .map((file) => path.join(dir, file));
}

// The newest other `<date>-<slug>.md` beside the brief with the same slug, dated no later than it; or null.
export function findSupersededBrief(briefPath) {
  return supersededBriefs(briefPath)[0] ?? null;
}

// The prior of the brief at `briefPath`: { path, source }, or null. `--prior` first; else, for a project run's brief
// (runHandoffs), the first of the snapshot and the other briefs of its slug, newest first, whose bytes a handoff row of
// the run's ledger records; else the snapshot, then the newest other brief of its slug.
export function resolvePrior(briefPath, explicitPrior) {
  if (explicitPrior) return { path: explicitPrior, source: 'explicit' };
  const handed = runHandoffs(briefPath);
  const snapshot = existsSync(snapshotPath(briefPath)) ? [{ path: snapshotPath(briefPath), source: 'snapshot' }] : [];
  const candidates = [...snapshot, ...supersededBriefs(briefPath).map((file) => ({ path: file, source: 'same slug' }))];
  if (handed === null) return candidates[0] ?? null;
  const recorded = candidates.find((each) => handed.has(fileSha256(each.path)));
  return recorded ? { ...recorded, source: `${recorded.source}, which the run's ledger recorded` } : null;
}

// The sha256 of every brief a handoff row of the ledger records, for a brief named `<date>-project-<run>.md` right in
// the handoffs folder of a state folder that keeps the run `<run>`: a set, empty when the ledger cannot be read; or null
// for any other brief, whose prior resolves as before.
export function runHandoffs(briefPath) {
  const run = path.basename(briefPath).match(BRIEF_NAME)?.[2].match(RUN_SLUG)?.[1];
  const folder = path.dirname(briefPath);
  if (!run || path.basename(folder) !== 'handoffs') return null;
  const runFolder = path.join(path.dirname(folder), 'runs', run);
  try {
    lstatSync(runFolder);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    return new Set();
  }
  const bytes = cappedRead(path.join(runFolder, 'ledger.jsonl'), LEDGER_CAP);
  const handed = new Set();
  for (const line of bytes === null ? [] : bytes.toString('utf8').split('\n')) {
    try {
      const row = JSON.parse(line);
      if (row?.event === 'handoff' && typeof row.sha256 === 'string' && SHA256.test(row.sha256)) handed.add(row.sha256);
    } catch {}
  }
  return handed;
}

// The bytes of the regular file `file`, opened with no link followed, when no longer than `cap`; null otherwise.
function cappedRead(file, cap) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > cap) return null;
    const buffer = Buffer.alloc(stat.size);
    return buffer.subarray(0, readSync(fd, buffer, 0, stat.size, 0));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// The sha256 of a brief's bytes, as recordHandoff hashes them, or null when it cannot be read.
function fileSha256(file) {
  const bytes = cappedRead(file, BRIEF_CAP);
  return bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
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

// Writes `bytes` as the brief's snapshot, by a temporary file and a rename over whatever is at its name, as a passing
// check replaces the snapshot. With `exclusive`, a hard link publishes the file only where nothing is at its name, and
// an entry there throws EEXIST and stays as it is. Throws what the disk refuses. The temporary name is random and
// created exclusively before the try, so the cleanup only ever removes this call's own file.
export function writeSnapshot(briefPath, bytes, { exclusive = false } = {}) {
  const snapshot = snapshotPath(briefPath);
  mkdirSync(path.dirname(snapshot), { recursive: true, mode: 0o700 });
  if (linkedPrior(briefPath)) throw Object.assign(new Error('.prior is a symlink'), { code: 'ESYMLINK' });
  const temporary = path.join(path.dirname(snapshot), `.${path.basename(snapshot)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
  try {
    if (exclusive) linkSync(temporary, snapshot);
    else renameSync(temporary, snapshot);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  if (exclusive) rmSync(temporary, { force: true });
  return snapshot;
}

// Copies what the coming write supersedes into the snapshot, or clears a stale snapshot when nothing is. A snapshot the
// disk refuses to write or to clear, such as a folder at its name, is a problem: { source, problem }. A snapshot run
// replaces nothing, so one taken after the write never copies the new text over the good prior: an entry already at
// the snapshot's name is kept, and is a problem unless it is a regular file, not the brief's own, with the same bytes,
// which is { source, snapshot, unchanged: true } with no write. Only a vacant name is written, by an exclusive publish;
// only a passing check replaces the snapshot. The stale clear removes a regular file only when it is older than this
// call, so a snapshot another call published meanwhile stays. `now` (ms, wall clock) and `beforeOpen` (run between the
// look at the snapshot's entry and its open) are the test seams.
export function takeSnapshot(briefPath, explicitPrior, { now = () => performance.timeOrigin + performance.now(), beforeOpen = () => {} } = {}) {
  const started = now();
  const snapshot = snapshotPath(briefPath);
  const source = explicitPrior ?? (existsSync(briefPath) ? briefPath : findSupersededBrief(briefPath));
  if (!source) {
    try {
      if (!linkedPrior(briefPath) && !newerFile(snapshot, started)) rmSync(snapshot, { force: true });
    } catch (error) {
      return { source: briefPath, problem: `cannot be saved to ${snapshot} (${error.code ?? error.message})` };
    }
    return null;
  }
  const reason = unreadable(source);
  if (reason) return { source, problem: reason };
  const cannot = (error) => ({ source, problem: `cannot be saved to ${snapshot} (${error.code ?? error.message})` });
  let bytes;
  try {
    bytes = readFileSync(source);
    if (linkedPrior(briefPath)) throw Object.assign(new Error('.prior is a symlink'), { code: 'ESYMLINK' });
    const kept = keptSnapshot(briefPath, source, bytes, beforeOpen);
    if (kept) return kept;
    writeSnapshot(briefPath, bytes, { exclusive: true });
    return { source, snapshot };
  } catch (error) {
    // An entry that took the name after the look above is judged as one that was there before it.
    return (error.code === 'EEXIST' && bytes !== undefined && keptSnapshot(briefPath, source, bytes, beforeOpen)) || cannot(error);
  }
}

// Whether `file` is a regular file changed at or after `started`, which a stale clear leaves alone.
function newerFile(file, started) {
  try {
    const entry = lstatSync(file);
    return entry.isFile() && entry.mtimeMs >= started;
  } catch {
    return false;
  }
}

// What a snapshot run says of the entry at the snapshot's name, which it keeps; null when the name is vacant.
function keptSnapshot(briefPath, source, bytes, beforeOpen) {
  const snapshot = snapshotPath(briefPath);
  const notRegular = { source, problem: `cannot be saved: ${snapshot} is not a regular file, and a snapshot replaces nothing: remove it and run snapshot again` };
  try {
    if (!lstatSync(snapshot).isFile()) return notRegular;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return { source, problem: `cannot be saved to ${snapshot} (${error.code ?? error.message})` };
  }
  if (samePath(briefPath, snapshot)) return { source, problem: `cannot be saved: ${snapshot} is the brief's own file, a hard link, not a copy a refresh leaves alone: remove that link and run snapshot again` };
  beforeOpen(snapshot);
  const held = readHeld(snapshot, bytes.length + 1);
  if (held.code) return { source, problem: `cannot be compared with the snapshot ${snapshot}, which cannot be read (${held.code}), so it is kept: restore read access to it, or run aidrian handoff check with --prior naming a known-good readable brief` };
  if (!held.bytes) return notRegular;
  if (held.bytes.equals(bytes)) return { source, snapshot, unchanged: true };
  return { source, problem: `differs from the snapshot ${snapshot}, the prior a refresh is checked against, so it is kept: write the brief and run aidrian handoff check, which compares with it; remove the snapshot only when that prior is known to be wrong` };
}

// At most `cap` bytes of `file`, read to its end or the cap, opened with no link followed and no wait on a pipe: { bytes }, { bytes: null } when
// what was opened is not a regular file, or { code } when it cannot be opened or read.
function readHeld(file, cap) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    if (!fstatSync(fd).isFile()) return { bytes: null };
    const buffer = Buffer.alloc(cap);
    let length = 0;
    for (let read = 1; read > 0 && length < cap; length += read) read = readSync(fd, buffer, length, cap - length, length);
    return { bytes: buffer.subarray(0, length) };
  } catch (error) {
    return { code: error.code ?? error.message };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
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
