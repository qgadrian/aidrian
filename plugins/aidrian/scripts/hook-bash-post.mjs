// PostToolUse hook for Bash, three records in the session folder (lib/session-folder.mjs), none of which it ever refuses on.
// The pull request ledger and its links (docs/hooks.md#session-ledger): after a shell call that succeeded, it appends
// one row to `<state>/sessions/<session id>/prs.jsonl` for each change request the call created, pushed a branch of, or
// acted on, as lib/session-prs.mjs reads the command, and one row to `links.jsonl` for each worktree an
// `aidrian worktree new` of the call created, as lib/session-links-writer.mjs reads the command and the command's printed
// result; the call's output comes from the host's adapter (`shellOutput`), never from a payload field. The ledger is
// written first, and the links apart from it, under their own time budget, so a link that fails or a git that stalls
// loses no ledger row. The check-run record (docs/hooks.md#check-runs): one row in `checks.jsonl` for each test run on the
// call's top level that the call ran to its end, with its status and counts (lib/check-runs.mjs), read through the
// adapter's `shellRun`, and from the tail of the file the host kept a long output in; a call stopped, or started in or moved to the background, records none. The hook writes nothing
// outside the session folders, always exits 0, and prints nothing, so no record or output text reaches the model. It
// writes nothing for a call the host stopped, a session id that fails SESSION_ID, or a folder with no project; a test run is
// filed in the project of the call's folder, else in that of the folder the line's first test run runs in after a `cd`.

import path from 'node:path';

import { isMain, runHook } from '../lib/hook-io.mjs';
import { detectHost } from '../lib/hosts/index.mjs';

// A command that holds none of these words can record no pull request or link; one of only programs that run no tests,
// such as git and grep, no check run (lib/check-runs.mjs mayRunTests).
const MAY_RECORD = /push|\bpr\b|\bworktree\b/u;
// The most milliseconds the links' git reads take together: the ledger's own git reads, each stopped at 2 s, come first,
// and both must end inside the host's 5 second hook timeout.
const LINKS_BUDGET_MS = 1000;

// The hook's body, for the payload `input` (lib/hook-io.mjs callHook).
export async function handle(input) {
  const command = input.tool_input?.command;
  if (typeof command !== 'string') return;
  if (typeof input.session_id !== 'string' || typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd)) return;
  const { mayRunTests } = await import('../lib/check-runs.mjs');
  const mayTest = mayRunTests(command, input.cwd);
  if (!MAY_RECORD.test(command) && !mayTest) return;
  if (mayTest) {
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
  // The state folder lies outside every checkout of the repository, as the snapshot holds it; none when git cannot list them.
  const folderOf = (project, read) => sessionFolder(stateDir(project, read ? { read } : {}), input.session_id, { checkouts: projectCheckouts(project, read) });
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
}

if (isMain(import.meta.url)) await runHook(handle);

// The check-run rows of a finished call, appended to the session's record.
async function recordCheckRuns(input, command) {
  const run = detectHost({ input }).shellRun?.(input.tool_response);
  if (!run?.finished) return;
  const [{ checkRows, appendCheckRuns, testRuns }, { findProject, projectCheckouts, stateDir }, { loadConfig }, { sessionFolder }, { walkCommands }] = await Promise.all([
    import('../lib/check-runs.mjs'),
    import('../lib/project.mjs'),
    import('../lib/config.mjs'),
    import('../lib/session-folder.mjs'),
    import('../lib/shell-lex.mjs'),
  ]);
  // A session whose starting folder another session removed gets the home folder as its cwd from the host, and runs its
  // tests after a `cd` into a worktree: the project is then the one of the folder its first test run runs in.
  const project = findProject(input.cwd) ?? runProject(command, input.cwd, { findProject, loadConfig, testRuns, walkCommands });
  if (!project) return;
  const { config } = loadConfig(project);
  const agentId = typeof input.agent_id === 'string' ? input.agent_id : null;
  const rows = checkRows({ command, cwd: input.cwd, output: run.output, persisted: run.persisted ?? null, exitZero: run.exitZero, testing: config.testing, agentId });
  if (rows.length === 0) return;
  const folder = sessionFolder(stateDir(project, { config }), input.session_id, { checkouts: projectCheckouts(project) });
  if (folder) appendCheckRuns(folder, rows);
}

// The project of the folder the line's first test run runs in, or null. Which commands are test runs is that project's
// config (`testing`), so each project a folder of the line is in is asked in turn, and the first whose config reads a
// top-level test run there names the run's own folder, whose project it is.
function runProject(command, cwd, { findProject, loadConfig, testRuns, walkCommands }) {
  const folders = walkCommands(command, cwd).map((entry) => entry.folder).filter((folder) => typeof folder === 'string' && path.isAbsolute(folder));
  for (const folder of new Set(folders)) {
    const asked = findProject(folder);
    if (!asked) continue;
    const run = testRuns(command, cwd, loadConfig(asked).config.testing).find((each) => typeof each.folder === 'string' && path.isAbsolute(each.folder));
    const project = run ? findProject(run.folder) : null;
    if (project) return project;
  }
  return null;
}

// Records the links of `command`, run from `cwd`, whose output was `output`: for each `aidrian worktree new` of the line
// whose own result, at its place among the line's results, says it created its worktree (session-links-writer.mjs
// createdWorktrees), the worktree git now lists for its branch, in the main checkout of the project of the folder that
// command ran in, with origin as that folder's checkout reads it, filed in that project's session folder. Every step
// after the worktree reader loads, finding each project, its main checkout, origin, the list, and the session folder,
// runs inside LINKS_BUDGET_MS, the calls of one line together: each git read, the tracked-file check of project
// discovery's local file too, is stopped at what is left of it, by SIGKILL, and none starts once it is spent.
async function recordWorktrees(command, cwd, output, { findProject, folderOf }) {
  if (!/\bworktree\b/u.test(command)) return;
  const links = await import('../lib/session-links-writer.mjs');
  const created = links.createdWorktrees(command, cwd, output);
  if (created.length === 0) return;
  const [{ mainRoot }, { listWorktrees }, { canonical }] = await Promise.all([
    import('../lib/git.mjs'), import('../lib/worktree.mjs'), import('../lib/rules/main-checkout.mjs'),
  ]);
  const until = Date.now() + LINKS_BUDGET_MS;
  const left = () => until - Date.now();
  const git = () => ({ timeout: Math.max(1, left()), killSignal: 'SIGKILL' });
  const list = (dir) => listWorktrees(dir, { timeoutMs: Math.max(1, left()), killSignal: 'SIGKILL' });
  const same = (listed, printed) => listed === printed || canonical(listed) === canonical(printed);
  // The calls by the folder they ran in, in the line's order.
  const byFolder = Map.groupBy(created, ({ folder }) => folder);
  for (const [ran, made] of byFolder) {
    if (left() <= 0) return;
    const project = findProject(ran, git);
    if (!project || left() <= 0) continue;
    const main = mainRoot(project.root, git());
    if (!main || left() <= 0) continue;
    const origin = links.originRepository(ran, git());
    const rows = left() > 0 ? links.worktreeRows({ branches: made.map(({ branch }) => branch), created: made, main, origin, list, same }) : [];
    const folder = rows.length && left() > 0 ? folderOf(project, git) : null;
    if (folder) links.recordLinks(folder, rows);
  }
}
