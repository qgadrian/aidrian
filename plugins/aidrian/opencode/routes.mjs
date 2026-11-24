// The hooks the OpenCode bridge runs (bridge.mjs), one row each: on the OpenCode event `on` of the tool `tool`, it runs
// `script` from the plugin's scripts/ as hooks.json runs it under `event` for the standard tool `standard`, stopped at
// `timeoutMs`, that entry's timeout. A hook runs on OpenCode only once a row names it; test/adapters.test.mjs holds each
// row to hooks.json. This version routes the session ledger alone, and no guard: no route blocks a call.

export const ROUTES = Object.freeze([
  Object.freeze({ on: 'execute.after', event: 'PostToolUse', tool: 'shell', standard: 'Bash', script: 'hook-bash-post.mjs', timeoutMs: 5000 }),
]);
