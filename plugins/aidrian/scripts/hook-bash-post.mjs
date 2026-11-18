// PostToolUse hook for Bash: the session's pull request ledger (docs/hooks.md#session-ledger). After a shell call that
// succeeded, it appends one row to `<state>/sessions/<session id>/prs.jsonl` for each change request the call created,
// pushed a branch of, or acted on, as lib/session-prs.mjs reads the command; the call's output comes from the host's
// adapter (`shellOutput`), never from a payload field. It never refuses, writes nothing outside the session folder
// (lib/session-folder.mjs), always exits 0, and prints nothing, so no ledger or output text reaches the model. It writes
// nothing for a call the host stopped, a session id that fails SESSION_ID, or a folder with no project.

import path from 'node:path';

import { runHook } from '../lib/hook-io.mjs';
import { detectHost } from '../lib/hosts/index.mjs';

// A command that holds neither word can record nothing, and loads nothing more.
const MAY_RECORD = /push|\bpr\b/u;

await runHook(async (input) => {
  const command = input.tool_input?.command;
  if (typeof command !== 'string' || !MAY_RECORD.test(command)) return;
  if (typeof input.session_id !== 'string' || typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd)) return;
  const response = detectHost({ input }).shellOutput?.(input.tool_response) ?? { output: null, interrupted: false };
  if (response.interrupted) return;
  const [{ findProject, stateDir }, { sessionFolder }, { forgeFor }, { appendLedger, ledgerRows }, calls] = await Promise.all([
    import('../lib/project.mjs'),
    import('../lib/session-folder.mjs'),
    import('../lib/forges/index.mjs'),
    import('../lib/session-prs.mjs'),
    import('../lib/rules/github/session-calls.mjs'),
  ]);
  const project = findProject(input.cwd);
  if (!project) return;
  // Each forge's reader of its own command, by its adapter's id.
  const readers = { [calls.FORGE]: calls };
  const rows = ledgerRows({ command, cwd: input.cwd, output: response.output, env: process.env, forge: forgeFor(input.cwd), readers, agentId: input.agent_id });
  if (rows.length === 0) return;
  const folder = sessionFolder(stateDir(project), input.session_id, { checkouts: project.checkouts });
  if (folder) appendLedger(folder, rows);
});
