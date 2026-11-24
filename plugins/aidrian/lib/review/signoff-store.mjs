// The sign-off store, `<state root>/signoffs/<owner>/<name>/<pr>.json`: the Human's flow sign-offs, which only
// `aidrian pr signoff` in a session the Human attends writes, and which a merge no Human asks for reads in place of the
// review record (merge-trust.mjs, docs/review.md#merge-trust). Kept apart from merge-trust.mjs, with only file and path
// imports, so the hooks that guard the folder load nothing that runs gh.

import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';

import { isObject } from '../fs.mjs';
import { stateRoot } from '../project.mjs';

// The sign-off store's folder under the state root; lib/handoff-guard.mjs guards it by this name.
export const SIGNOFF_FOLDER = 'signoffs';
// A sign-off store file this size or larger is not read.
const STORE_CAP = 256 * 1024;
const FULL_SHA = /^[0-9a-f]{40}$/iu;
// A repository's owner or name as a folder of the store: what GitHub allows, never `.` or `..`.
const PART = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/u;
const NO_FOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const processUid = () => (typeof process.getuid === 'function' ? process.getuid() : null);

// The folder the store is kept in, under the state root `env` names.
export const signoffFolder = (env = process.env) => path.join(stateRoot(env), SIGNOFF_FOLDER);

// Every folder the store may be kept in, for the guards that keep a session from writing one: the state root's, as `env`
// names it, and the user's own, under `home`, the home folder of the user this process runs as by default.
export function signoffFolders({ env = process.env, home } = {}) {
  const folders = [];
  try {
    folders.push(signoffFolder(env));
  } catch {}
  try {
    folders.push(path.join(home ?? userInfo().homedir, '.local/state', 'aidrian', SIGNOFF_FOLDER));
  } catch {}
  return [...new Set(folders.map((each) => path.resolve(each)))];
}

// `owner/name` as the store's two folders, lower-cased, or null for a name that is not one.
function repoParts(repo) {
  const parts = String(repo ?? '').toLowerCase().split('/');
  return parts.length === 2 && parts.every((part) => PART.test(part)) ? parts : null;
}

// The store file of pull request `pr` of `repo`: `<folder>/<owner>/<name>/<pr>.json`, or null.
export function signoffFile(repo, pr, { env = process.env } = {}) {
  const parts = repoParts(repo);
  if (!parts || !Number.isSafeInteger(pr) || pr < 1) return null;
  return path.join(signoffFolder(env), ...parts, `${pr}.json`);
}

// Why `folder` is no folder of this user's alone that a store may use, or null: a link, not a folder, another user's,
// or one another user may write.
function folderProblem(folder, uid) {
  let stat;
  try {
    stat = lstatSync(folder);
  } catch (error) {
    return error.code === 'ENOENT' ? null : `${folder} cannot be read (${error.code ?? 'no code'})`;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return `${folder} is not a plain folder`;
  if (uid !== null && stat.uid !== uid) return `${folder} belongs to another user`;
  if ((stat.mode & 0o022) !== 0) return `${folder} may be written by another user`;
  return null;
}

// Why a store file `file` under the state root `root` cannot be trusted, or null. Checked from a trusted ancestor: the
// real path of the folder above `root`, where a link is resolved, must be a folder of this user's that no other user may
// write; then `root` itself and every folder below it down to `file`'s must be a plain folder of this user's alone, no
// link among them (folderProblem). A folder not there yet passes, as does an ancestor not there yet, which holds
// nothing. The recorded-decision store (lib/project-decision-store.mjs) and the start's sandbox denies
// (lib/project-run-gate.mjs guardedStore) hold their folders to this too.
export const storePathProblem = (file, root) => {
  const uid = processUid();
  let anchor;
  try {
    anchor = realpathSync(path.dirname(root));
  } catch (error) {
    return error.code === 'ENOENT' ? null : `${path.dirname(root)} cannot be resolved (${error.code ?? 'no code'})`;
  }
  const above = folderProblem(anchor, uid);
  if (above) return above;
  const below = path.relative(root, path.dirname(file));
  if (below.startsWith('..') || path.isAbsolute(below)) return `${file} is not under the state root ${root}`;
  const chain = [path.join(anchor, path.basename(root))];
  for (const part of below === '' ? [] : below.split(path.sep)) chain.push(path.join(chain.at(-1), part));
  for (const each of chain) {
    const problem = folderProblem(each, uid);
    if (problem) return problem;
  }
  return null;
};

// Whether an entry of the store is one `recordHumanSignoff` writes.
const isEntry = (entry) => isObject(entry) && typeof entry.head === 'string' && FULL_SHA.test(entry.head) && typeof entry.by === 'string' && typeof entry.at === 'string';

// The Human's sign-offs of pull request `pr` of `repo` on this machine: { flows: { <flow>: { head, by, at } } }, or
// { problem }. No file is no sign-off. The file is read without following a link, only when it and every folder above it
// to the store's are this user's alone, and only entries of the shape the store writes count.
export function readHumanSignoffs({ repo, pr, env = process.env }) {
  const file = signoffFile(repo, pr, { env });
  if (!file) return { problem: `${JSON.stringify(String(repo))}#${pr} names no repository and pull request the sign-off store keeps` };
  const above = storePathProblem(file, stateRoot(env));
  if (above) return { problem: `the sign-off store cannot be trusted: ${above}` };
  const read = readStoreJson(file, 'a sign-off store file');
  if (read.missing) return { flows: {} };
  if (read.problem) return { problem: read.problem };
  const { value } = read;
  if (!isObject(value) || value.version !== 1 || value.pr !== pr || String(value.repo).toLowerCase() !== String(repo).toLowerCase() || !isObject(value.flows)) {
    return { problem: `${file} is not a sign-off store file of ${repo}#${pr}` };
  }
  return { flows: Object.fromEntries(Object.entries(value.flows).filter(([, entry]) => isEntry(entry))) };
}

// The JSON of the store file `file`, read without following a link and only as a regular file of this user's alone with
// one link, under STORE_CAP: { value }, { missing: true } when nothing is there, or { problem }, `kind` naming the file;
// `malformed: true` marks a problem of the content alone, past STORE_CAP or no JSON, once those checks passed.
export function readStoreJson(file, kind) {
  let fd;
  try {
    fd = openSync(file, NO_FOLLOW);
  } catch (error) {
    if (error.code === 'ENOENT') return { missing: true };
    return { problem: `the store file ${file} cannot be read (${error.code ?? 'no code'})` };
  }
  try {
    const stat = fstatSync(fd);
    const uid = processUid();
    if (!stat.isFile()) return { problem: `${file} is not a regular file` };
    if (uid !== null && stat.uid !== uid) return { problem: `${file} belongs to another user` };
    if ((stat.mode & 0o022) !== 0 || stat.nlink !== 1) return { problem: `${file} may be written another way than by the store` };
    if (stat.size >= STORE_CAP) return { problem: `${file} is too large to be ${kind}`, malformed: true };
    const buffer = Buffer.alloc(stat.size);
    const read = readSync(fd, buffer, 0, stat.size, 0);
    const text = buffer.subarray(0, read).toString('utf8');
    try {
      return { value: JSON.parse(text) };
    } catch (error) {
      return { problem: `${file} cannot be read as ${kind} (${String(error?.message ?? error).split('\n')[0]})`, malformed: true };
    }
  } catch (error) {
    return { problem: `${file} cannot be read as ${kind} (${String(error?.message ?? error).split('\n')[0]})` };
  } finally {
    closeSync(fd);
  }
}

// Records the Human's sign-off of `flow` on `head`, a full commit SHA, of pull request `pr` of `repo`, by `by`, in the
// sign-off store, and returns the entry. Each folder is made this user's alone, and the file is written whole and
// moved into place. Throws, writing nothing, when the store cannot be read or written: a sign-off the store does not
// hold would count for no merge no Human asks for.
export function recordHumanSignoff({ repo, pr, flow, head, by, env = process.env, now = Date.now() }) {
  if (typeof head !== 'string' || !FULL_SHA.test(head)) throw new Error(`the sign-off store takes a full commit SHA, not ${JSON.stringify(head)}`);
  const file = signoffFile(repo, pr, { env });
  if (!file) throw new Error(`${repo}#${pr} names no repository and pull request the sign-off store keeps`);
  makeStoreFolder(file, stateRoot(env), 'the sign-off store');
  const current = readHumanSignoffs({ repo, pr, env });
  if (current.problem) throw new Error(current.problem);
  const entry = { head: head.toLowerCase(), by: String(by), at: new Date(now).toISOString() };
  writeStoreFile(file, `${JSON.stringify({ version: 1, repo: String(repo).toLowerCase(), pr, flows: { ...current.flows, [flow]: entry } }, null, 2)}\n`);
  return entry;
}

// Makes the folders of a store from the state root `root` down to `file`'s, each this user's alone, mode 0700, only
// once the trusted ancestor and every one already there passed storePathProblem: a link, the state root's among them,
// another user's folder, or one another user may write throws before anything is made, so no folder lands where a link
// points. Throws, too, when a folder it made fails the check; `what` names the store in the error.
export function makeStoreFolder(file, root, what) {
  const before = storePathProblem(file, root);
  if (before) throw new Error(`${what} cannot be trusted: ${before}`);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const after = storePathProblem(file, root);
  if (after) throw new Error(`${what} cannot be trusted: ${after}`);
}

// Writes `text` to `file` of a store whole, owner-only, through a temporary file beside it moved into place, which a
// write that fails removes. Throws what the write throws.
export function writeStoreFile(file, text) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {}
    throw error;
  }
}
