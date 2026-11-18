// PostToolUse hook for Bash: the session's pull request ledger and its links (docs/hooks.md#session-ledger). After a
// shell call that succeeded, it appends one row to `<state>/sessions/<session id>/prs.jsonl` for each change request the
// call created, pushed a branch of, or acted on, as lib/session-prs.mjs reads the command, and one row to `links.jsonl`
// for each worktree an `aidrian worktree new` of the call created, as lib/session-links-writer.mjs reads the command and
// the command's printed result; the call's output comes from the host's adapter (`shellOutput`), never from a payload
// field. The ledger is written first, and the links apart from it, under their own time budget, so a link that fails or
// a git that stalls loses no ledger row. It never refuses, writes nothing outside the session folders
// (lib/session-folder.mjs), always exits 0, and prints nothing, so no ledger or output text reaches the model. It writes
// nothing for a call the host stopped, a session id that fails SESSION_ID, or a folder with no project.

import path from 'node:path';

import { runHook } from '../lib/hook-io.mjs';
import { detectHost } from '../lib/hosts/index.mjs';

// A command that holds none of these words can record nothing, and loads nothing more.
const MAY_RECORD = /push|\bpr\b|\bworktree\b/u;
// The most milliseconds the links' git reads take together: the ledger's own git reads, each stopped at 2 s, come first,
// and both must end inside the host's 5 second hook timeout.
const LINKS_BUDGET_MS = 1000;

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
  // The state folder lies outside every checkout of the repository, as the snapshot holds it; none when git cannot list them.
  const folderOf = (project) => sessionFolder(stateDir(project), input.session_id, { checkouts: projectCheckouts(project) });
  const project = findProject(input.cwd);
  if (project) {
    // Each forge's reader of its own command, by its adapter's id.
    const readers = { [calls.FORGE]: calls };
    const rows = ledgerRows({ command, cwd: input.cwd, output: response.output, env: process.env, forge: forgeFor(input.cwd), readers, agentId: input.agent_id });
    const folder = rows.length ? folderOf(project) : null;
    if (folder) appendLedger(folder, rows);
  }
  try {
    await recordWorktrees(command, input.cwd, response.output, { findProject, folderOf });
  } catch {
    // Display data: a link that cannot be recorded is left out.
  }
});

// Records the links of `command`, run from `cwd`, whose output was `output`: for each `aidrian worktree new` it ran
// that printed a created result, the worktree git now lists for its branch, in the main checkout of the project of the
// folder that command ran in, as walkCommands follows a `cd`, filed in that project's session folder. Each git read is
// stopped at its share of LINKS_BUDGET_MS. Loads the worktree reader only for a call that names one.
async function recordWorktrees(command, cwd, output, { findProject, folderOf }) {
  if (!/\bworktree\b/u.test(command)) return;
  const links = await import('../lib/session-links-writer.mjs');
  const created = links.createdWorktrees(output);
  const called = created.length ? links.worktreeBranches(command, cwd) : [];
  const projects = new Map();
  for (const { branch, folder } of called) {
    const project = findProject(folder);
    if (!project) continue;
    const group = projects.get(project.root) ?? { project, branches: [] };
    group.branches.push(branch);
    projects.set(project.root, group);
  }
  if (projects.size === 0) return;
  const [{ mainRoot }, { listWorktrees }, { canonical }] = await Promise.all([
    import('../lib/git.mjs'), import('../lib/worktree.mjs'), import('../lib/rules/main-checkout.mjs'),
  ]);
  const until = Date.now() + LINKS_BUDGET_MS;
  const left = () => until - Date.now();
  const git = () => ({ timeout: Math.max(1, left()), killSignal: 'SIGKILL' });
  for (const { project, branches } of projects.values()) {
    if (left() <= 0) return;
    const main = mainRoot(project.root, git());
    if (!main || left() <= 0) continue;
    const origin = links.originRepository(main, git());
    const list = (dir) => listWorktrees(dir, { timeoutMs: Math.max(1, left()), killSignal: 'SIGKILL' });
    const same = (listed, printed) => listed === printed || canonical(listed) === canonical(printed);
    const rows = links.worktreeRows({ branches, created, main, origin, list, same });
    const folder = rows.length ? folderOf(project) : null;
    if (folder) links.recordLinks(folder, rows);
  }
}
