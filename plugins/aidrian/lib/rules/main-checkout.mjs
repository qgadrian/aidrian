// Write rule: no writes to a tracked file in a project's main checkout; task work happens in a git worktree.
// It covers Edit, Write, and NotebookEdit, Codex's apply_patch, and the Bash commands whose target is certain:
// `>` and `>>`, tee, sed -i, perl -i, ruby -i, the destination of cp, ln, and install, every path of mv, git mv, rm, git rm, unlink, touch,
// mkdir, and truncate, dd's of=, and the local destination of rsync, with its sources too under --remove-source-files. A move removes its sources. A command
// substitution that runs is read as the command line is.
//
// It also keeps the main checkout's git state for the session that owns it: no `git switch` or `git checkout <branch>`
// away from the default branch, no staging of every change at once (`git add -A`, `--all`, `-u`, `.`, `:/`), which
// takes whatever other sessions left in the folder, and no git call that makes a commit or moves the branch (commit,
// merge and pull without --ff-only, cherry-pick, revert, rebase, am, commit-tree, and a reset that is not of paths).
//
// It is off until a project sets config.json `"git": { "mainCheckout": { "guard": true } }`. A target is allowed when it is outside
// every main checkout (in a worktree, or outside the repository), in a project without a project folder or with the
// guard off, matched by `git.mainCheckout.allowWrites`, or git-ignored. When git cannot tell, a tool write is denied to be
// safe and a Bash command runs: a command line is never as certain as a file path.

import path from 'node:path';

import { fileEditOf } from '../hosts/index.mjs';
import { bashTargets, bashWrites } from './main-checkout/bash-writes.mjs';
import { canonical, cdLead, decide, failedCdLead, guardedMain, OVERRIDE, reason } from './main-checkout/checkout.mjs';
import { afterChanges } from './main-checkout/directory-change.mjs';
import { gitStateDenial } from './main-checkout/git-state.mjs';

// The rule's parts live in lib/rules/main-checkout/: checkout.mjs reads the guarded main checkout and writes the deny
// reasons, directory-change.mjs follows a `cd`, writers.mjs and bash-writes.mjs read a command's write targets, and
// git-state.mjs and git-calls.mjs judge its git calls.
export { bashTargets, bashWrites, canonical, OVERRIDE };

// Bash: the deny reason for `command`, or null. git runs only for a write target or a git call in a guarded project,
// and for each folder a `cd` names from a guarded main checkout.
export function check(command, { cwd = process.cwd(), env = process.env } = {}) {
  if (env[OVERRIDE] === '1') return null;
  return decide(bashTargets(command, cwd), cwd, false, 'this command writes') ?? afterCdDenial(command, cwd) ?? gitStateDenial(command, cwd);
}

// The relative writes after a directory change, judged where the shell may still be: the deny reason, or null.
function afterCdDenial(command, cwd) {
  for (const write of bashWrites(command, cwd, { shells: true, globs: true })) {
    if (!write.cds.length || path.isAbsolute(write.text)) continue;
    const walk = afterChanges(write.cds);
    // A wrapper's `env -C` or git's `-C` after the change moves the target; one that may expand leaves it alone.
    if (!walk || write.via.some((token) => token.dynamic)) continue;
    const through = (dir) => write.via.reduce((at, token) => path.resolve(at, token.text), dir);
    const dirs = walk.at.map(through);
    if (write.glob) {
      // A glob fails closed, as it may match a tracked file: after an untrusted cd, at the folders before it; after cds
      // inside the main checkout, at the folders the shell is in only when the last one fails.
      if (walk.cd) {
        const main = dirs.map((dir) => guardedMain(dir)).find(Boolean);
        if (main) return reason(cdLead(`this command writes '${write.text}'`, 'the write lands in', walk.cd, main.roots.main), main.project, main.config);
      } else {
        const main = walk.at.filter((dir) => !walk.last.dests.includes(dir)).map((dir) => guardedMain(through(dir))).find(Boolean);
        if (main) return reason(failedCdLead(write.text, walk.last.shown, main.roots.main), main.project, main.config);
      }
      continue;
    }
    const files = (list) => list.map((dir) => path.resolve(through(dir), write.text));
    const verb = 'this command writes';
    if (walk.cd) {
      const denial = decide(files(walk.at), cwd, false, verb, (root) => cdLead(`${verb} '${write.text}'`, 'the write lands in', walk.cd, root));
      if (denial) return denial;
      continue;
    }
    // Inside the main checkout, a file where the last cd leads is judged as today; one the write reaches only when a
    // cd fails names that cd.
    const reached = walk.at.filter((dir) => walk.last.dests.includes(dir));
    const denial =
      decide(files(reached), cwd, false, verb) ??
      decide(files(walk.at.filter((dir) => !reached.includes(dir))), cwd, false, verb, (root) => failedCdLead(write.text, walk.last.shown, root));
    if (denial) return denial;
  }
  return null;
}

// Edit, Write, NotebookEdit, and apply_patch: the deny reason for the hook payload, or null.
export function checkTool(input, { env = process.env } = {}) {
  if (env[OVERRIDE] === '1') return null;
  return decide(toolTargets(input), typeof input.cwd === 'string' ? input.cwd : process.cwd(), true, 'this writes');
}

// Every path an Edit, Write, NotebookEdit, or apply_patch payload writes, as it names them: relative to its cwd or absolute.
export function toolTargets(input) {
  const toolInput = input.tool_input ?? {};
  const targets = fileEditOf(input)?.targets ?? [toolInput.file_path ?? toolInput.notebook_path];
  return targets.filter((target) => typeof target === 'string' && target !== '');
}
