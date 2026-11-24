// The recorded-decision store, `<state root>/recorded-decisions/<project key>/<ISSUE>.json`: each decision the Human
// recorded on an issue before a project run, as { heading, sha256, by: "human", at }, the heading and sha256 of the one
// section of the issue's description it pins (lib/project-decision.mjs). Only `aidrian project decision --record` in a
// session the Human attends writes it, and `--forget` removes an entry; the hooks and a confined session's sandbox keep
// every other session from writing the folder, as they keep the sign-off store's (lib/review/signoff-store.mjs, whose
// folder rules, atomic write, and guarded read it reuses). A start reads it only where the team's projectRun.recordedDecisions
// switch is on (lib/project-run-gate.mjs decisionFor). It lies apart from `<state>/decisions/`, the decision-review records.
// Only file and path imports, so the hooks that guard the folder load nothing more.

import { readdirSync, unlinkSync } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';

import { isObject } from './fs.mjs';
import { stateRoot } from './project.mjs';
import { makeStoreFolder, readStoreJson, storePathProblem, writeStoreFile } from './review/signoff-store.mjs';

// The store's folder under the state root; lib/handoff-guard.mjs guards it by this name.
export const DECISION_STORE_FOLDER = 'recorded-decisions';
// A project's key as a folder of the store (lib/project.mjs projectId), and an issue's key as its file's name.
const PROJECT_KEY = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,120}$/u;
const ISSUE_KEY = /^(?:[A-Z][A-Z0-9]{0,15}-)?[1-9][0-9]{0,8}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const KIND = 'a recorded-decision store file';

// The folder the store is kept in, under the state root `env` names.
export const decisionStoreFolder = (env = process.env) => path.join(stateRoot(env), DECISION_STORE_FOLDER);

// Every folder the store may be kept in, for the guards that keep a session from writing one: the state root's, as `env`
// names it, and the user's own, under `home`, the home folder of the user this process runs as by default.
export function decisionStoreFolders({ env = process.env, home } = {}) {
  const folders = [];
  try {
    folders.push(decisionStoreFolder(env));
  } catch {}
  try {
    folders.push(path.join(home ?? userInfo().homedir, '.local/state', 'aidrian', DECISION_STORE_FOLDER));
  } catch {}
  return [...new Set(folders.map((each) => path.resolve(each)))];
}

// The store file of issue `key` of the project `projectKey`, or null for a key that names none.
export function decisionFile(projectKey, key, { env = process.env } = {}) {
  if (typeof projectKey !== 'string' || !PROJECT_KEY.test(projectKey) || typeof key !== 'string' || !ISSUE_KEY.test(key)) return null;
  return path.join(decisionStoreFolder(env), projectKey, `${key}.json`);
}

// Whether `value` is an entry `recordDecision` writes.
const isEntry = (value) => isObject(value) && typeof value.heading === 'string' && value.heading.trim() !== '' && typeof value.sha256 === 'string'
  && SHA256.test(value.sha256) && value.by === 'human' && typeof value.at === 'string';

// The decision the Human recorded on issue `key` of the project `projectKey` on this machine: { entry } with
// { heading, sha256, by, at }, { entry: null } when none is recorded, or { problem }, with `malformed: true` when the file
// passed every check of its place, owner, type, and links and only its content is no entry. The file is read only when it
// and every folder above it to the store's are this user's alone (storePathProblem, readStoreJson), and only an entry of
// the shape the store writes counts.
export function readRecordedDecision({ projectKey, key, env = process.env }) {
  const file = decisionFile(projectKey, key, { env });
  if (!file) return { problem: `${JSON.stringify(String(projectKey))} and ${JSON.stringify(String(key))} name no project and issue the recorded-decision store keeps` };
  const above = storePathProblem(file, stateRoot(env));
  if (above) return { problem: `the recorded-decision store cannot be trusted: ${above}` };
  const read = readStoreJson(file, KIND);
  if (read.missing) return { entry: null };
  if (read.problem) return { problem: read.problem, ...(read.malformed ? { malformed: true } : {}) };
  if (!isEntry(read.value)) return { problem: `${file} is not ${KIND}`, malformed: true };
  const { heading, sha256, by, at } = read.value;
  return { entry: { heading, sha256, by, at } };
}

// How many decisions the Human recorded for the project `projectKey` on this machine: { count }, the files of its folder
// that readRecordedDecision reads as an entry, each read as a start reads it, or { problem } when the folder cannot be
// trusted (storePathProblem) or listed. A folder not made yet holds none. It gives a count only, never an entry.
export function countRecordedDecisions({ projectKey, env = process.env }) {
  if (typeof projectKey !== 'string' || !PROJECT_KEY.test(projectKey)) return { problem: `${JSON.stringify(String(projectKey))} names no project the recorded-decision store keeps` };
  const folder = path.join(decisionStoreFolder(env), projectKey);
  const above = storePathProblem(path.join(folder, 'entry.json'), stateRoot(env));
  if (above) return { problem: `the recorded-decision store cannot be trusted: ${above}` };
  let names;
  try {
    names = readdirSync(folder);
  } catch (error) {
    return error.code === 'ENOENT' ? { count: 0 } : { problem: `the recorded-decision store ${folder} cannot be listed (${error.code ?? 'no code'})` };
  }
  const keys = names.map((name) => /^(.+)\.json$/u.exec(name)?.[1]).filter((key) => key !== undefined && ISSUE_KEY.test(key));
  return { count: keys.filter((key) => readRecordedDecision({ projectKey, key, env }).entry).length };
}

// Records the decision on issue `key` of the project `projectKey` as the section headed `heading` whose sha256 is
// `sha256`, replacing any earlier one, a malformed one too, and returns { file, entry }. Each folder is made this user's
// alone, only once those there passed their checks (makeStoreFolder), and the file is written whole and moved into
// place. Throws, writing nothing, when the store cannot be trusted or written.
export function recordDecision({ projectKey, key, heading, sha256, env = process.env, now = Date.now() }) {
  const file = decisionFile(projectKey, key, { env });
  if (!file) throw new Error(`${JSON.stringify(String(projectKey))} and ${JSON.stringify(String(key))} name no project and issue the recorded-decision store keeps`);
  const entry = { heading: String(heading).trim(), sha256: String(sha256), by: 'human', at: new Date(now).toISOString() };
  if (!isEntry(entry)) throw new Error('a recorded decision takes a heading and a sha256 of 64 lowercase hex characters');
  makeStoreFolder(file, stateRoot(env), 'the recorded-decision store');
  const current = readRecordedDecision({ projectKey, key, env });
  if (current.problem && !current.malformed) throw new Error(current.problem);
  writeStoreFile(file, `${JSON.stringify(entry, null, 2)}\n`);
  return { file, entry };
}

// Removes the decision recorded on issue `key` of the project `projectKey`, a malformed one too: { file, removed },
// `removed` false when none was. Throws when the store cannot be trusted or the file cannot be removed.
export function forgetDecision({ projectKey, key, env = process.env }) {
  const file = decisionFile(projectKey, key, { env });
  if (!file) throw new Error(`${JSON.stringify(String(projectKey))} and ${JSON.stringify(String(key))} name no project and issue the recorded-decision store keeps`);
  const current = readRecordedDecision({ projectKey, key, env });
  if (current.problem && !current.malformed) throw new Error(current.problem);
  if (current.entry === null) return { file, removed: false };
  unlinkSync(file);
  return { file, removed: true };
}
