// How many times in a row the SubagentStop hook has sent one subagent back because a background task it started still
// runs (dispatch-rows.mjs runningChildren). `stop_hook_active` is true on every stop after the first send-back of a turn,
// however many rounds of waiting follow, so it cannot count them; this counter, a file per agent in the temporary folder,
// can. A turn that a stop hook did not start (`stop_hook_active: false`) counts from zero, and a stop that finds no task of
// its own running clears the count. Past the cap the count stays until one of those, so a chain of stops gets at most
// CHILD_SEND_BACKS send-backs from this check, whatever other stop hooks do: it never loops.

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Send-backs in a row for one subagent that keeps a background task running. Each costs one short turn; a task that
// outlasts them all is the lesson the hook records (lesson-signals.mjs idleChildrenSignal).
export const CHILD_SEND_BACKS = 5;

const ID = /^[\w-]+$/u;
const counterFile = (input, dir) =>
  typeof input.agent_id === 'string' && ID.test(input.agent_id) ? path.join(dir, `aidrian-child-send-backs-${input.agent_id}`) : null;

// The send-backs this chain of stops already made. Without an agent id to key the count by, or with a count that cannot be
// read, the first stop of a turn counts as none made and any later one as all of them: one send-back, never a loop.
export function childSendBacks(input, { dir = tmpdir() } = {}) {
  if (input.stop_hook_active === false) return 0;
  const file = counterFile(input, dir);
  if (!file) return CHILD_SEND_BACKS;
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    // No count yet: a send-back by another check, or another hook, started this chain.
    return error?.code === 'ENOENT' ? 0 : CHILD_SEND_BACKS;
  }
  const count = Number.parseInt(raw, 10);
  return Number.isInteger(count) && count >= 0 ? count : CHILD_SEND_BACKS;
}

// Stores `count` for this subagent. Returns false when it cannot: the caller must not send back then, since nothing would
// count the next stop.
export function storeChildSendBacks(input, count, { dir = tmpdir() } = {}) {
  const file = counterFile(input, dir);
  if (!file) return false;
  try {
    writeFileSync(file, `${count}\n`);
    return true;
  } catch {
    return false;
  }
}

// Clears the count, once the subagent stops with no task of its own running. Never throws.
export function forgetChildSendBacks(input, { dir = tmpdir() } = {}) {
  const file = counterFile(input, dir);
  if (!file) return;
  try {
    rmSync(file, { force: true });
  } catch {
    // The temporary folder clears it in time.
  }
}
