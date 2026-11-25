// The OpenCode bridge's output half: what a hook script's answer does to OpenCode's callback. bridge.mjs runs the
// scripts and builds each callback from its steps here. Each answer is read as Claude Code reads it
// (lib/hook-result.mjs readHookResult), the answers of one call are merged (combineHookResults), and the merged verdict
// is applied to the event OpenCode passes. A context a tool call's hooks give reaches the model at the end of that
// call's result, once it completed (appendContext): the text a script printed is never written to the trace or to a
// request's `system`.
//
// Only an execute.before callback ever rejects, and only for a refusal: a hook's block, two different rewrites of the
// input, and the two fail-closed refusals of a subagent's call, a script that did not start, one not on disk included,
// and a call made in code mode. OpenCode 2.4.1's plugin adapter turns that rejection into a `Tool.Error` whose message
// is the error's (`toolError` in @opencode/plugin's promise adapter), which fails that call alone, so the bridge
// rejects with a plain Error and imports nothing of OpenCode's. Every other callback resolves whatever its steps do, and so does an
// execute.before callback whose own steps fail: a bridge crash lets the call run, as a hook error does on Claude Code.
//
// It also runs each script (run). The payload holds text a model wrote, so the spawn is pinned: the program is Node,
// resolved to an absolute file at setup, the arguments the script's absolute path and the route's literal flags, the
// options `cwd`, the session's folder, `env` as the process has it, with the plugin's bin/ first on a start script's
// PATH, and `stdio`, with no shell, and the payload reaches the child on stdin alone. It reads at most CAPTURE_BYTES of each script's stdout and stderr, and waits for its exit
// whatever it writes.
//
// It imports node: built-ins and the hook-result leaf, which imports node: built-ins alone, so it loads in OpenCode's
// Bun and under `node --test` alike.

import { Buffer } from 'node:buffer';
import { statSync } from 'node:fs';

import { combineHookResults, readHookResult } from '../lib/hook-result.mjs';

// The OpenCode tool hook whose callback runs before a call, the one callback that may refuse it.
export const BLOCKING_HOOK = 'execute.before';

// The bytes the bridge keeps of one script's stdout, and of its stderr: past them a stream keeps no text, and its
// answer is read as an overflow (readHookResult), which carries no text and never turns an exit 2 into an allow.
export const CAPTURE_BYTES = 256 * 1024;

// The fail-closed refusals of a subagent's call on a blocking route.
export const SPAWN_REFUSAL = 'aidrian could not start a hook that guards this call, so a subagent\'s call does not run.';
export const CODEMODE_REFUSAL = 'No recorded OpenCode session shows aidrian\'s hooks reading a code-mode call as they read a direct one, so a subagent\'s code-mode call does not run.';

// Whether `file` is a file on disk now.
export const isFile = (file) => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

// The bytes `stream` writes, read as they come so the child never waits on a full pipe: `text()` what it wrote, ''
// once it passed `bound`, and `overflow` whether it did. Past the bound it keeps reading and keeps nothing, and never
// stops the child: a killed script reads as no answer at all.
export function capture(stream, bound = CAPTURE_BYTES) {
  const chunks = [];
  let size = 0;
  let overflow = false;
  try {
    stream?.on?.('data', (chunk) => {
      if (overflow) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += bytes.length;
      if (size > bound) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(bytes);
    });
    stream?.on?.('error', () => {});
  } catch {
    // A stream that cannot be read gives no text.
  }
  return {
    get overflow() {
      return overflow;
    },
    text: () => (overflow ? '' : Buffer.concat(chunks).toString('utf8')),
  };
}

// Runs `route`'s script on `call` with `runner`'s spawn, Node, environment, and trace, in the session's folder, and
// resolves its answer once it closes: { exit, signal, stdout, stderr, overflow }, or { failed: true } when it does not
// start, Node gone since setup included, which ends this call alone. A script missing when its call checks it, or gone
// when it exits 1, is one that does not start, traced `missing`, so it refuses a subagent's call on a blocking route:
// Node exits 1 on a missing script, which would read as a hook error and let that call run. Once `ms`, counted from
// its spawn, ends, a script that has not exited is killed, and its answer is a signal's; one that exited is read with
// what it wrote.
export function run(runner, route, call, ms) {
  return new Promise((resolve) => {
    const answer = settler(runner, route, resolve);
    let text;
    let child;
    try {
      if (!isFile(route.file)) return answer.failed('missing');
      text = JSON.stringify(call.payload(route));
      child = runner.spawn(runner.node, [route.file, ...route.args], { cwd: call.base, env: runner.env, stdio: ['pipe', 'pipe', 'pipe'] });
      answer.read(child);
    } catch {
      answer.failed('error');
      return;
    }
    child.on('error', (error) => answer.failed(error?.code ?? 'error'));
    child.on('exit', (code, signal) => answer.exited(code, signal));
    child.on('close', (code, signal) => answer.closed(code, signal));
    answer.time(ms, () => kill(child));
    feed(child, text);
  });
}

// The one answer of one script, settled once: `read` captures the child's output, `exited` notes its exit, `closed`
// settles with what it wrote, or as `missing` when it exited 1 and its file is gone, `failed` settles as a script that
// did not start, and `time` settles at `ms`: with what it wrote when it exited, else killed, as a signal's answer.
// Each settle traces a `run` line.
function settler(runner, route, resolve) {
  let settled = false;
  let timer = null;
  let exit = null;
  let out = capture(null);
  let err = capture(null);
  const done = (status, answer) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    runner.trace('run', { script: route.script, status });
    resolve(answer);
  };
  const closed = (code, signal) => {
    // An exit 1 whose script is gone is Node failing to load it, the answer of a script the call's check found missing.
    if (code === 1 && !isFile(route.file)) return done('missing', { failed: true });
    return done(code ?? signal, { exit: code, signal, stdout: out.text(), stderr: err.text(), overflow: out.overflow || err.overflow });
  };
  return {
    read(child) {
      out = capture(child.stdout);
      err = capture(child.stderr);
    },
    exited: (code, signal) => {
      exit = { code, signal };
    },
    closed,
    failed: (status) => done(status, { failed: true }),
    time(ms, stop) {
      timer = setTimeout(() => {
        if (settled) return;
        if (exit) return closed(exit.code, exit.signal);
        stop();
        return done('timeout', { exit: null, signal: 'SIGKILL' });
      }, ms);
    },
  };
}

// Writes the payload to the child's stdin, where a child that exits first gives an EPIPE that changes nothing.
function feed(child, text) {
  try {
    child.stdin?.on('error', () => {});
    child.stdin?.end(text);
  } catch {
    // A child that cannot read its payload ends as it would without one.
  }
}

function kill(child) {
  try {
    child.kill('SIGKILL');
  } catch {
    // A child that already ended needs no signal.
  }
}

// The resolve-always wrapper of a callback that never rejects: whatever `step` throws or rejects with, it resolves.
export function settle(step) {
  return async (...args) => {
    try {
      await step(...args);
    } catch {
      // A callback that fails leaves OpenCode as it would be without the plugin.
    }
  };
}

// The callback of the OpenCode hook `hook`, from its steps, each a seam:
//   select(event)              what it runs, { routes, ... }; none or no routes ends it
//   call(event, selected)      what the routes are sent, { agent?, ... }, or { skip } to send nothing
//   run(route, call)           one script's answer, { exit, signal, stdout, stderr, overflow }, or { failed: true }
//                              when it did not start
//   apply(event, verdict, call) the merged verdict applied; on execute.before, only to a call no hook refused
//   trace(step, fields)        the bridge's trace writer
// On execute.before the refusal and the rewrite are applied here: a refusal rejects, and a rewrite replaces
// `event.input`; then `apply` runs, and what it throws or rejects with lets the call run.
export function transform(hook, steps) {
  if (hook !== BLOCKING_HOOK) {
    return settle(async (event) => {
      const outcome = await answer(steps, event, false);
      if (outcome?.verdict) await steps.apply?.(event, outcome.verdict, outcome.call);
    });
  }
  return async (event) => {
    const outcome = await answer(steps, event, true);
    if (outcome === null) return;
    const refused = outcome.refusal ?? refusalOf(outcome);
    if (refused) {
      traced(steps, 'refuse', refused.status);
      throw new Error(refused.reason);
    }
    if (outcome.verdict.updatedInput !== null) event.input = outcome.verdict.updatedInput;
    try {
      await steps.apply?.(event, outcome.verdict, outcome.call);
    } catch {
      // A context that cannot be kept leaves the call as it would be without it.
    }
  };
}

// Appends `texts`, the hook contexts of one completed call, each a text part, to the end of `event.result.content`,
// the part of OpenCode 2.4.1's `Tool.Result` { output?, content?, metadata? } the model reads, and leaves `output` and
// `metadata` as they were. The result is replaced, never changed in place, so a route's payload, built from the
// result as it was, never holds a context. OpenCode reads a content that is text, or an empty list, from `output`
// (`normalizeContent` in its tool runtime), so the content is first written out as OpenCode would read it, and the
// output the model would have read stays first. A text that is no string or is empty adds nothing.
export function appendContext(event, texts) {
  const parts = texts.filter((text) => typeof text === 'string' && text !== '').map((text) => ({ type: 'text', text }));
  const result = event?.result;
  if (parts.length === 0 || typeof result !== 'object' || result === null || Array.isArray(result)) return;
  event.result = { ...result, content: [...contentOf(result), ...parts] };
}

// The content parts OpenCode 2.4.1 gives the model for a result: a text content as one text part, a list that is not
// empty as it is, and anything else as one text part of the output, as text or JSON (`normalizeContent`, `stringify`).
function contentOf({ content, output }) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content) && content.length > 0) return [...content];
  return [{ type: 'text', text: textOf(output) }];
}

function textOf(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// The outcome of one event's steps, or null when nothing ran or a step failed: { verdict, call, blocked } with
// `blocked` whether one hook's own answer refused, or on a blocking hook { refusal } for a fail-closed refusal.
async function answer(steps, event, blocking) {
  try {
    const selected = await steps.select(event);
    const routes = Array.isArray(selected?.routes) ? selected.routes : [];
    if (routes.length === 0) return null;
    const call = await steps.call(event, selected);
    if (!call || call.skip) return null;
    const subagent = typeof call.agent === 'string';
    if (blocking && subagent && event?.codemode === true) return { refusal: { status: 'codemode', reason: CODEMODE_REFUSAL } };
    const { verdict, blocked, failed } = await answered(routes, (route) => steps.run(route, call));
    if (blocking && subagent && failed) return { refusal: { status: 'spawn', reason: SPAWN_REFUSAL } };
    return { verdict, call, blocked };
  } catch {
    return null;
  }
}

// What `routes` answer together, each run by `runRoute(route)`, in parallel: `verdict` their merged answer, `blocked`
// whether one's own answer refused, and `failed` whether one did not start. A runner that throws or rejects is that
// script not starting, and never drops a peer's answer.
export async function answered(routes, runRoute) {
  const results = await Promise.all(routes.map((route) => Promise.resolve().then(() => runRoute(route)).catch(() => ({ failed: true }))));
  const verdicts = results.map((result, at) => readHookResult({ ...result, event: routes[at].event }));
  return { verdict: combineHookResults(verdicts), blocked: verdicts.some((one) => one.block), failed: results.some((result) => result?.failed === true) };
}

// The refusal of a merged verdict, { status, reason }, or null: `hook` when a hook refused, `rewrite` when only two
// rewrites that differ did.
function refusalOf({ verdict, blocked }) {
  if (!verdict.block) return null;
  return { status: blocked ? 'hook' : 'rewrite', reason: verdict.reason };
}

function traced(steps, step, status) {
  try {
    steps.trace?.(step, { status });
  } catch {
    // A trace that cannot be written changes nothing.
  }
}
