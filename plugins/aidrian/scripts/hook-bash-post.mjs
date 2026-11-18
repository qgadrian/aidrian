// PostToolUse hook for Bash: the session's pull request ledger and its links (docs/hooks.md#session-ledger). After a
// shell call that succeeded, it appends one row to `<state>/sessions/<session id>/prs.jsonl` for each change request the
// call created, pushed a branch of, or acted on, as lib/session-prs.mjs reads the command, and one row to `links.jsonl`
// for each worktree an `aidrian worktree new` of the call created, as lib/session-links-writer.mjs reads it; the call's output
// comes from the host's adapter (`shellOutput`), never from a payload field. It never refuses, writes nothing outside the
// session folder (lib/session-folder.mjs), always exits 0, and prints nothing, so no ledger or output text reaches the
// model. It writes nothing for a call the host stopped, a session id that fails SESSION_ID, or a folder with no project.

import path from 'node:path';

import { runHook } from '../lib/hook-io.mjs';
import { detectHost } from '../lib/hosts/index.mjs';

// A command that holds none of these words can record nothing, and loads nothing more.
const MAY_RECORD = /push|\bpr\b|\bworktree\b/u;

await runHook(async (input) => {
  const command = input.tool_input?.command;
  if (typeof command !== 'string' || !MAY_RECORD.test(command)) return;
  if (typeof input.session_id !== 'string' || typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd)) return;
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
  const links = await worktreeRows(command, project);
  if (rows.length === 0 && links.rows.length === 0) return;
  // The state folder lies outside every checkout of the repository, as the snapshot holds it; none when git cannot list them.
  const folder = sessionFolder(stateDir(project), input.session_id, { checkouts: projectCheckouts(project) });
  if (!folder) return;
  if (rows.length) appendLedger(folder, rows);
  if (links.rows.length) links.record(folder, links.rows);
});

// The links rows of `command`: for each `aidrian worktree new` it ran, the worktree git now lists for its branch, in the
// main checkout of `project`. Loads the worktree reader only for a call that names one.
async function worktreeRows(command, project) {
  const none = { rows: [], record: () => false };
  if (!/\bworktree\b/u.test(command)) return none;
  const links = await import('../lib/session-links-writer.mjs');
  const branches = links.worktreeBranches(command);
  if (branches.length === 0) return none;
  const [{ mainRoot }, { listWorktrees }] = await Promise.all([import('../lib/git.mjs'), import('../lib/worktree.mjs')]);
  const main = mainRoot(project.root);
  if (!main) return none;
  return { rows: links.worktreeRows({ branches, main, origin: links.originRepository(main), list: listWorktrees }), record: links.recordLinks };
}
