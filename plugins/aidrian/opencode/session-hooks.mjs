// The OpenCode bridge's session hooks: the start a session runs once, and what the plugin's text gives the model. Each
// text goes through the one mutable hook OpenCode 2.4.1 has for the moment it must reach the model:
//
//   start lines and notices  a system part of each model step, on `context`, and of the compaction request, on
//                            `compaction`, so the request a session sends keeps one cached prefix
//   prompt context           its own file part of the prompt, on `prompt`, marked as aidrian's, never the Human's text
//   compaction checklist     a system part of the compaction request, after the start lines
//
// Only plugin text goes into `system`: the start lines, the bridge's notices, and the compaction checklist. The start
// lines are the plugin's own sentences, filled with counts, doc paths, config.json values, folders, and the main
// checkout's branch name. The one text of a model's a start can print, a cleared session's handoff, needs a continue
// route OpenCode lacks. The prompt hook's context, which may quote a reply, goes into the prompt.
//
// The start: hook-session-start.mjs runs once for each root session for the life of one setup of the bridge, which
// OpenCode 2.4.1 runs once for each Location and again when it loads the plugin anew. It runs, awaited, in the first awaited callback that names a session of that root, before that callback's routes, and once more, with
// `--subagent`, for each child session after its root's. Its lines, the context its answer gives, are kept per session
// in `runner.starts`, and a run that fails is traced and kept as no lines, so it is never repeated. A session read that
// fails, or a folder that is not on disk, is no run: the next callback asks again. No script runs on a request whose
// session has started. Every hook here runs in the root session's own folder, from its session read, and a child's
// `--subagent` start in the child's own; a session whose folder is not on disk runs nothing.
//
// It imports node: built-ins, the hook-result leaf, and its own folder, so it loads in OpenCode's Bun and under
// `node --test` alike.

import { Buffer } from 'node:buffer';
import path from 'node:path';

import { combineHookResults, readHookResult } from '../lib/hook-result.mjs';
import { markOf, sessionCall, skipped } from './call.mjs';
import { run, settle, transform } from './output.mjs';

const START = 'SessionStart';
const SUBAGENT_START = 'SubagentStart';
// The mark of each part the plugin adds: a system part's `metadata`, and the prompt's file part's name and description.
export const PART_MARK = 'aidrian';
export const PROMPT_PART_DESCRIPTION = 'aidrian hook context';

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const startRoutes = (runner, event) => runner.routes.filter((route) => route.event === event && Object.hasOwn(runner.events, route.event));

// Runs the start of the session `sessionID`'s root, then, for a child, the child's own `--subagent` start, each once for
// the setup, and resolves once both ran; it never rejects. Two callbacks that name a new session at once run one
// start. A child's start waits for its root's, so a root whose folder is not on disk holds both back.
export async function started(runner, sessionID) {
  try {
    if (!path.isAbsolute(runner.node ?? '') || startRoutes(runner, START).length + startRoutes(runner, SUBAGENT_START).length === 0) return;
    if (typeof sessionID !== 'string' || sessionID === '') return;
    if (runner.starts.has(sessionID)) {
      await runner.starts.get(sessionID);
      return;
    }
    const who = await sessionCall(runner, sessionID);
    const held = who.skip ?? (who.rootDir === null && !runner.starts.has(who.root) ? 'cwd' : null);
    if (held) {
      skipped(runner, startRoutes(runner, START), { skip: held });
      return;
    }
    if (who.agent !== null && who.dir === null) skipped(runner, startRoutes(runner, SUBAGENT_START), { skip: 'cwd' });
    await once(runner, who.root, () => start(runner, START, { root: who.root, agent: null, cwd: who.rootDir }));
    if (who.agent !== null && who.dir !== null) await once(runner, sessionID, () => start(runner, SUBAGENT_START, { root: who.root, agent: who.agent, cwd: who.dir }));
  } catch {
    // A start that cannot run leaves the session as it would be without the plugin.
  }
}

function once(runner, id, begin) {
  if (!runner.starts.has(id)) runner.starts.set(id, Promise.resolve().then(begin).catch(() => null));
  return runner.starts.get(id);
}

// The lines one start gives, the context of its routes' merged answer, or null when none ran or it failed. Each script
// runs under its own route's timeout, with the PATH a shell has (bridge.mjs startEnv), and its `run` trace line says how
// it ended.
async function start(runner, event, { root, agent, cwd }) {
  const routes = startRoutes(runner, event);
  if (routes.length === 0) return null;
  const mark = markOf(runner.context, {});
  const call = {
    base: cwd,
    payload: (route) => ({ hook_event_name: route.event, opencode: mark, session_id: root, ...(agent ? { agent_id: agent } : {}), cwd }),
  };
  const results = await Promise.all(routes.map((route) => run({ ...runner, env: runner.startEnv }, route, call, route.timeoutMs).catch(() => ({ failed: true }))));
  return combineHookResults(results.map((result, at) => readHookResult({ ...result, event: routes[at].event }))).context;
}

// The system parts each model step and compaction request of the session `sessionID` carries, once its start ran: the bridge's notices, and the
// session's own start lines, a root's or a child's `--subagent` ones.
async function systemParts(runner, sessionID) {
  const parts = [];
  if (runner.notices.length > 0) parts.push(systemPart(runner.notices.join('\n'), 'notice'));
  const lines = typeof sessionID === 'string' ? await runner.starts.get(sessionID) : null;
  if (typeof lines === 'string' && lines !== '') parts.push(systemPart(lines, 'start'));
  return parts;
}

const systemPart = (text, kind) => ({ type: 'text', text, metadata: { [PART_MARK]: kind } });

// Adds `parts` to the request `event`'s system parts, after OpenCode's own.
const addParts = (event, parts) => {
  if (parts.length > 0 && Array.isArray(event?.system)) event.system.push(...parts);
};

// The `context` callback: the session's start, then its system parts on the request. It never rejects.
export function contextHook(runner) {
  return settle(async (event) => {
    await started(runner, event?.sessionID);
    addParts(event, await systemParts(runner, event?.sessionID));
  });
}

// The `compaction` callback: the start and system parts as on `context`, then `checklist`, the PreCompact routes'
// callback, or null when none is routed. It never rejects.
export function compactionHook(runner, checklist) {
  return settle(async (event) => {
    await started(runner, event?.sessionID);
    addParts(event, await systemParts(runner, event?.sessionID));
    await checklist?.(event);
  });
}

// The callback of the standard event `standard`'s routes on the OpenCode session hook `hook`, `prompt` or `compaction`,
// through output.mjs transform: the start first, then each route, sent the root session's id, the calling session's as
// `agent_id` when it is a child, the root's folder as `cwd`, and `fields(event)`; `apply` takes the merged verdict.
// These callbacks never reject, so a block is not applied to a prompt or a compaction, and such an event stays out of
// EVENTS (routes.mjs).
export function sessionRoutes(runner, hook, standard, { fields = () => ({}), apply }) {
  return transform(hook, {
    async select(event) {
      await started(runner, event?.sessionID);
      return { routes: runner.routes.filter((route) => route.event === standard && runner.events[route.event] === hook) };
    },
    async call(event, { routes }) {
      const who = await sessionCall(runner, event?.sessionID);
      const skip = who.skip ?? (who.rootDir === null ? 'cwd' : null);
      if (skip) return skipped(runner, routes, { skip });
      const mark = markOf(runner.context, {});
      return {
        base: who.rootDir,
        agent: who.agent,
        payload: (route) => ({
          hook_event_name: route.event, opencode: mark, session_id: who.root, ...(who.agent ? { agent_id: who.agent } : {}), cwd: who.rootDir, ...fields(event),
        }),
      };
    },
    run: (route, call) => run(runner, route, call, route.timeoutMs),
    apply: (event, verdict) => {
      if (!verdict.block && verdict.context !== null) apply(event, verdict.context);
    },
    trace: runner.trace,
  });
}

// The prompt hook's payload field: the text the Human sent.
export const promptFields = (event) => (typeof event?.prompt?.text === 'string' ? { prompt: event.prompt.text } : {});

// Adds `text` to the prompt of `event` as its own file part, plain text inline, named and described as aidrian's, after
// any file the Human attached; the Human's text part stays as it is.
export function addPromptPart(event, text) {
  const prompt = event?.prompt;
  if (!isObject(prompt)) return;
  const part = { uri: `data:text/plain;base64,${Buffer.from(text, 'utf8').toString('base64')}`, source: { type: 'inline' }, name: PART_MARK, description: PROMPT_PART_DESCRIPTION };
  if (Array.isArray(prompt.files)) prompt.files.push(part);
  else prompt.files = [part];
}

// Adds the compaction checklist `text` to the compaction request `event` as a system part, after the start lines.
export const addChecklist = (event, text) => addParts(event, [systemPart(text, 'compaction')]);
