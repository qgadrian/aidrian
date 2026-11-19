// How many times in a row the SubagentStop hook has sent one subagent back because a background task it started still
// runs (dispatch-rows.mjs runningChildren). `stop_hook_active` is true on every stop after the first send-back of a turn,
// however many rounds of waiting follow, so it cannot count them; this counter, a file per agent in the hooks' counts
// folder (lesson-signals.mjs hookCountsFolder), which no confined session may write, can. It is opened without following
// a link and without waiting on a FIFO, and only as a regular file of this user with a single link (fs.mjs openOwnFile). A turn that a stop hook did not start (`stop_hook_active: false`) counts from zero, and a stop that finds no task of
// its own running clears the count. Past the cap the count stays until one of those, so a chain of stops gets at most
// CHILD_SEND_BACKS send-backs from this check, whatever other stop hooks do: it never loops.

import { closeSync, constants, ftruncateSync, lstatSync, readSync, rmSync, writeSync } from 'node:fs';
import path from 'node:path';

import { openOwnFile, ownFolderSync } from './fs.mjs';
import { hookCountsFolder } from './lesson-signals.mjs';

// Send-backs in a row for one subagent that keeps a background task running. Each costs one short turn; a task that
// outlasts them all is the lesson the hook records (lesson-signals.mjs idleChildrenSignal).
export const CHILD_SEND_BACKS = 5;

const ID = /^[\w-]+$/u;
// The counter's file for the subagent of `input`, in `dir`, the hooks' counts folder by default, or null.
function counterFile(input, dir, env = process.env) {
  if (typeof input.agent_id !== 'string' || !ID.test(input.agent_id)) return null;
  try {
    return path.join(dir ?? hookCountsFolder(env), `aidrian-child-send-backs-${input.agent_id}`);
  } catch {
    return null;
  }
}

// The send-backs this chain of stops already made. Without an agent id to key the count by, or with a count that cannot be
// read, the first stop of a turn counts as none made and any later one as all of them: one send-back, never a loop.
export function childSendBacks(input, { dir, env = process.env } = {}) {
  if (input.stop_hook_active === false) return 0;
  const file = counterFile(input, dir, env);
  if (!file) return CHILD_SEND_BACKS;
  const fd = openOwnFile(file, constants.O_RDONLY);
  // No count yet: a send-back by another check, or another hook, started this chain. Anything else there counts as all.
  if (fd === null) return entryMissing(file) ? 0 : CHILD_SEND_BACKS;
  let raw;
  try {
    const buffer = Buffer.alloc(32);
    raw = buffer.subarray(0, readSync(fd, buffer, 0, 32, 0)).toString('utf8');
  } catch {
    return CHILD_SEND_BACKS;
  } finally {
    closeSync(fd);
  }
  const count = Number.parseInt(raw, 10);
  return Number.isInteger(count) && count >= 0 ? count : CHILD_SEND_BACKS;
}

// Stores `count` for this subagent. Returns false when it cannot: the caller must not send back then, since nothing would
// count the next stop.
export function storeChildSendBacks(input, count, { dir, env = process.env } = {}) {
  const file = counterFile(input, dir, env);
  if (!file || !ownFolderSync(path.dirname(file))) return false;
  const fd = openOwnFile(file, constants.O_WRONLY | constants.O_CREAT);
  if (fd === null) return false;
  try {
    ftruncateSync(fd, 0);
    writeSync(fd, `${count}\n`, 0);
    return true;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

// Whether nothing at all is at `file`, read without following a link.
function entryMissing(file) {
  try {
    lstatSync(file);
    return false;
  } catch (error) {
    return error.code === 'ENOENT';
  }
}

// Clears the count, once the subagent stops with no task of its own running. Never throws.
export function forgetChildSendBacks(input, { dir, env = process.env } = {}) {
  const file = counterFile(input, dir, env);
  if (!file) return;
  try {
    rmSync(file, { force: true });
  } catch {
    // The next stop that finds none of its own tasks running clears it again.
  }
}
