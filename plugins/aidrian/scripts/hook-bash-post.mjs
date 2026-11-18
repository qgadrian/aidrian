// PostToolUse hook for Bash, two records in the session folder (lib/session-folder.mjs), neither of which it ever refuses on.
// The pull request ledger (docs/hooks.md#session-ledger): after a shell call that succeeded, it appends one row to
// `<state>/sessions/<session id>/prs.jsonl` for each change request the call created, pushed a branch of, or acted on, as
// lib/session-prs.mjs reads the command; the call's output comes from the host's adapter (`shellOutput`), never from a
// payload field. The check-run record (docs/hooks.md#check-runs): one row in `checks.jsonl` for each test run on the
// call's top level that the call ran to its end, with its status and counts (lib/check-runs.mjs), read through the
// adapter's `shellRun`; a call stopped, or started in or moved to the background, records none. The hook writes nothing
// outside the session folder, always exits 0, and prints nothing, so no record or output text reaches the model. It
// writes nothing for a call the host stopped, a session id that fails SESSION_ID, or a folder with no project.

import path from 'node:path';

import { runHook } from '../lib/hook-io.mjs';
import { detectHost } from '../lib/hosts/index.mjs';

// A command that holds neither word can record no pull request, and one with none of the test words no check run: either
// loads nothing more.
const MAY_RECORD = /push|\bpr\b/u;
const MAY_TEST = /test|check|vitest|jest|pytest|rspec/u;

await runHook(async (input) => {
  const command = input.tool_input?.command;
  if (typeof command !== 'string' || !(MAY_RECORD.test(command) || MAY_TEST.test(command))) return;
  if (typeof input.session_id !== 'string' || typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd)) return;
  if (MAY_TEST.test(command)) {
    try {
      await recordCheckRuns(input, command);
    } catch {
      // A record that cannot be written leaves the ledger to record.
    }
  }
  if (!MAY_RECORD.test(command)) return;
  const response = detectHost({ input }).shellOutput?.(input.tool_response) ?? { output: null, interrupted: false };
  if (response.interrupted) return;
  const [{ findProject, projectCheckouts, stateDir }, { sessionFolder }, { forgeFor }, { appendLedger, ledgerRows }, calls] = await Promise.all([
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
  // The state folder lies outside every checkout of the repository, as the snapshot holds it; none when git cannot list them.
  const folder = sessionFolder(stateDir(project), input.session_id, { checkouts: projectCheckouts(project) });
  if (folder) appendLedger(folder, rows);
});

// The check-run rows of a finished call, appended to the session's record.
async function recordCheckRuns(input, command) {
  const run = detectHost({ input }).shellRun?.(input.tool_response);
  if (!run?.finished) return;
  const [{ checkRows, appendCheckRuns }, { findProject, projectCheckouts, stateDir }, { loadConfig }, { sessionFolder }] = await Promise.all([
    import('../lib/check-runs.mjs'),
    import('../lib/project.mjs'),
    import('../lib/config.mjs'),
    import('../lib/session-folder.mjs'),
  ]);
  const project = findProject(input.cwd);
  if (!project) return;
  const { config } = loadConfig(project);
  const agentId = typeof input.agent_id === 'string' ? input.agent_id : null;
  const rows = checkRows({ command, cwd: input.cwd, output: run.output, exitZero: run.exitZero, testing: config.testing, agentId });
  if (rows.length === 0) return;
  const folder = sessionFolder(stateDir(project, { config }), input.session_id, { checkouts: projectCheckouts(project) });
  if (folder) appendCheckRuns(folder, rows);
}
