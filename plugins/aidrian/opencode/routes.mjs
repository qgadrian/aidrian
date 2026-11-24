// The standard hook events the OpenCode bridge (bridge.mjs) runs, each to the OpenCode tool hook it runs on. The hooks
// themselves are routes.generated.json, every hooks.json hook as `npm run build` writes it; the bridge runs those whose
// event this map names and whose matcher fires on the call's standard tool name. PostToolUse alone: no PreToolUse or
// any other event yet, so no guard runs on OpenCode and no route blocks a call.

export const EVENTS = Object.freeze({ PostToolUse: 'execute.after' });
