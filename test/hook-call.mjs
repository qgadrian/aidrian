// Calls a hook script's exported `handle` in the test's own process, as a host runs the script, without starting a
// node process for each call: { status, stderr, stdout }, the shape a spawnSync of the script gives with encoding 'utf8'.
// `options` are spawnSync's: `input` (the JSON payload as text), `cwd`, and `env`; the rest, such as `timeout`, are
// ignored. A test still spawns a script where it checks what only a real process shows, such as its exit under a host's
// timeout. Calls run one at a time (lib/hook-io.mjs callHook), as a test file's tests do.
import { pathToFileURL } from 'node:url';

import { anchorClones } from '../plugins/aidrian/lib/attempt-clone.mjs';
import { resetGitStall } from '../plugins/aidrian/lib/git.mjs';
import { callHook } from '../plugins/aidrian/lib/hook-io.mjs';

const handles = new Map();

export async function hookCall(script, { input = '{}', cwd, env } = {}) {
  if (!handles.has(script)) handles.set(script, (await import(pathToFileURL(script).href)).handle);
  const handle = handles.get(script);
  if (typeof handle !== 'function') throw new Error(`${script} exports no handle`);
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    payload = {};
  }
  // What a host's fresh process starts without: no git call stopped yet, and no clone anchor of an earlier call.
  resetGitStall();
  anchorClones(null);
  return callHook(handle, payload, { cwd, env });
}
