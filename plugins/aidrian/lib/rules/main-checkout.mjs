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
// guard off, matched by `git.mainCheckout.allowWrites`, or git-ignored, but never inside the main checkout's git folder,
// outside the project's state folder. A removal or move of the main checkout's top folder or a folder above it, and a
// target built from a variable the rule cannot read while the shell may be in the main checkout, are denied too. When
// git cannot tell, a tool write is denied to be safe and a Bash command runs: a command line is never as certain as a
// file path.

import path from 'node:path';

import { joinSpelled } from '../fs.mjs';
import { fileEditOf, isFileEditTool } from '../hosts/index.mjs';
import { bashTargets, bashWrites } from './main-checkout/bash-writes.mjs';
import { canonical, cdLead, decide, existingFolder, failedCdLead, guardedMain, holdsMainDenial, OVERRIDE, reason } from './main-checkout/checkout.mjs';
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
  return decide(bashTargets(command, cwd), cwd, false, 'this command writes') ?? removalDenial(command, cwd) ?? afterCdDenial(command, cwd)
    ?? expansionDenial(command, cwd, env) ?? gitStateDenial(command, cwd);
}

// A variable's name in a target: `$NAME` or `${NAME}`.
const VARIABLE = /\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/gu;
// The variables the shell sets for itself, whose value in the hook's environment is not the shell's.
const SHELL_OWN = new Set(['PWD', 'OLDPWD']);

// A write whose target is built from a variable, from a shell that may be in a guarded main checkout: the deny reason,
// or null. Each `$NAME` or `${NAME}` is read from a bare assignment or `export` earlier on the line, and else from the
// hook's environment `env`, which the session's shell starts with, so `S=/tmp/x; echo x > "$S/a"` and `"$TMPDIR/a"`
// are judged where they lead. A target that still holds a `$` or a backtick is blocked, unless the literal path before its first `$` is an absolute
// folder outside every guarded main checkout, as `/tmp/$x` is: it may name a tracked file there.
function expansionDenial(command, cwd, env) {
  for (const write of bashWrites(command, cwd, { followCd: true, shells: true, expansions: true })) {
    if (!write.expansion) continue;
    const vars = write.vars ?? new Map();
    const value = (name) => {
      if (vars.has(name)) return vars.get(name).dynamic ? null : vars.get(name).text;
      return SHELL_OWN.has(name) || typeof env[name] !== 'string' ? null : env[name];
    };
    const text = write.text.replace(VARIABLE, (whole, braced, bare) => value(braced ?? bare) ?? whole);
    // After a directory change, the shell is where the rule's own walk says (afterChanges), a worktree's trusted `cd`
    // taken as done; none when the line starts in no guarded main checkout.
    const walk = write.cds.length ? afterChanges(write.cds) : null;
    if (write.cds.length && !walk) continue;
    let dirs = write.dirs.length ? write.dirs : [cwd];
    if (walk) dirs = walk.at;
    if (!/[$`]/u.test(text)) {
      const denial = decide(dirs.map((dir) => joinSpelled(dir, text)), cwd, false, 'this command writes');
      if (denial) return denial;
      continue;
    }
    const main = dirs.map((dir) => guardedMain(dir)).find(Boolean);
    if (!main) continue;
    const literal = text.slice(0, text.search(/[$`]/u));
    const folder = literal.endsWith(path.sep) ? literal : path.dirname(literal);
    if (path.isAbsolute(literal) && !guardedMain(existingFolder(folder))) continue;
    return reason(`Blocked: this command writes '${write.text}', a path built from a variable this rule cannot read, while the shell may be in the main checkout (${main.roots.main}), where it may name a tracked file. Name the path literally, or set the variable earlier in the same command.`, main.project, main.config);
  }
  return null;
}

// What removes or moves a path it names: a folder that holds the main checkout goes with it.
const REMOVERS = new Set(['rm', 'unlink', 'mv', 'git rm', 'git mv']);

// The removal or move of the main checkout's top folder, or of a folder above it, the shell followed through each `cd`:
// the deny reason, or null.
function removalDenial(command, cwd) {
  const removed = bashWrites(command, cwd, { followCd: true }).filter((write) => REMOVERS.has(write.program));
  return holdsMainDenial(removed.flatMap((write) => write.files), cwd, 'this command removes or moves');
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
    const files = (list) => list.map((dir) => joinSpelled(through(dir), write.text));
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

// Edit, Write, NotebookEdit, and apply_patch: the deny reason for the hook payload, or null. A write tool whose payload
// names no file the host's adapter can read, such as a patch it cannot parse, is denied from a guarded main checkout,
// as a write git cannot judge is: the guard cannot tell it writes no tracked file.
export function checkTool(input, { env = process.env } = {}) {
  if (env[OVERRIDE] === '1') return null;
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const targets = toolTargets(input);
  if (targets.length === 0 && isFileEditTool(input.tool_name)) {
    const main = guardedMain(cwd);
    if (!main) return null;
    return reason(`Blocked: this writes with ${input.tool_name}, and the guard cannot read which files it writes from the main checkout (${main.roots.main}), so it writes nothing to be safe.`, main.project, main.config);
  }
  return decide(targets, cwd, true, 'this writes');
}

// Every path an Edit, Write, NotebookEdit, or apply_patch payload writes, as the host's adapter names them (hosts/index.mjs
// fileEditOf): relative to its cwd or absolute. None when the adapter reads none.
export function toolTargets(input) {
  return (fileEditOf(input)?.targets ?? []).filter((target) => typeof target === 'string' && target !== '');
}
