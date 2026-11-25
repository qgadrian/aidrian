// The standard hook events the OpenCode bridge (bridge.mjs) runs, each to the OpenCode hook it runs on. The hooks
// themselves are routes.generated.json, every hooks.json hook as `npm run build` writes it; the bridge runs those whose
// event EVENTS names, a tool event's only where its matcher fires on the call's standard tool name.
//
// HOOKS is each standard event the bridge has an OpenCode hook or event for. SessionStart and SubagentStart have none of their
// own: they run once a session, in the first awaited callback that names it, and their lines reach the model on
// `context`, so they map there. A child session's idle runs no Stop route, so SubagentStop has none yet. SessionEnd has
// no hook either: it maps to OpenCode's `session.deleted` event (DELETED_EVENT), which the bridge reads from the event
// stream and runs for a root session alone.
//
// EVENTS is the part of HOOKS no hook can block a call on, by lib/hook-result.mjs's reading of each event's answer
// (canBlock), the one source of what Claude Code does with it. An event a hook can block on stays out until a live
// OpenCode session shows that hook refuse a call and let a control call run (docs/providers/opencode.md#hooks): today
// PreToolUse, UserPromptSubmit, PreCompact, and Stop. Tests reach those through the bridge's `events` seam.

import { canBlock } from '../lib/hook-result.mjs';

// The OpenCode event, not a hook, that SessionEnd runs on.
export const DELETED_EVENT = 'session.deleted';

export const HOOKS = Object.freeze({
  SessionStart: 'context',
  SubagentStart: 'context',
  UserPromptSubmit: 'prompt',
  PreToolUse: 'execute.before',
  PostToolUse: 'execute.after',
  PreCompact: 'compaction',
  Stop: 'experimental.idle',
  SessionEnd: DELETED_EVENT,
});

export const EVENTS = Object.freeze(Object.fromEntries(Object.entries(HOOKS).filter(([event]) => !canBlock(event))));
