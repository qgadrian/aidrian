// The guard that keeps a gated subagent from lifting its own gates: while `agents` sets any gate, no subagent may change
// a file that sets the project's configuration (project.mjs configFiles). The main session, which has no `agent_id`,
// still can. scripts/hook-agent-gates.mjs asks it before every tool call; docs/config.md#agents gives the rule.
// It reads the targets the way the main-checkout rule does: Edit, Write, NotebookEdit, and apply_patch by the path they
// name, and a Bash command by the paths it writes. Unlike that rule it follows each `cd` and reads `sh -c` strings, and
// when the shell's folder is unknown it judges a relative target by its name alone. A command in a shell the lexer cannot
// read (lib/hosts/index.mjs opaqueShellCommand) counts as a write to each file its words name, as code an interpreter
// runs does: it may read or write any of them, and the guard cannot tell which. An interpreter run with code on its
// command line or its input, such as `python3 -c` or a heredoc, counts as a write to each of the files its words name,
// unless its code is one of the few that only read (READS). The guard keeps a gate from changing for the next session;
// within a session, the gates a subagent started with hold anyway (lib/gate-snapshot.mjs).

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { projectRuleReason } from './agent-gates.mjs';
import { localForgeTokenKeychain } from './config-local.mjs';
import { checkDeadline } from './deadline.mjs';
import { foldCase, globParts, isEntry, isWithin } from './fs.mjs';
import { folderOf, GLOB_WORD, globLinksTo, globStarts, linkBelow, linkReaches, linkWalk, partMatches, reachesFile, realOf, sameFile } from './glob-links.mjs';
import { fileEditOf, isFileEditTool, opaqueShellCommand } from './hosts/index.mjs';
import { configFiles } from './project.mjs';
import { bashWrites, canonical, toolTargets } from './rules/main-checkout.mjs';
import { commandLines, givenCode, inlineShellCommand, interpreterOf, lexInputs, readGit, readInvocation, shellRedirections, SUBSTITUTION_DEPTH_LIMIT, walkCommands } from './shell-lex.mjs';

// A quoted text with no quote, backslash, `$`, or backtick in it, such as a path.
const TEXT = String.raw`(?:'[^'"\\$\x60\n]*'|"[^'"\\$\x60\n]*")`;
const FS = String.raw`(?:'(?:node:)?fs'|"(?:node:)?fs")`;
// Code that names a file only to read it: every statement is an import or a read, printed or not, followed by keys
// only, as in `print(json.load(open(p))['agents'])` or `console.log(require(p).agents)`. Anything else, such as a call
// that renames, replaces, or deletes the file, is not one, whatever its name.
const PYTHON_READ = String.raw`(?:json\.load\(\s*OPEN\s*\)|OPEN\.read\(\s*\))(?:\s*\[\s*(?:${TEXT}|\d+)\s*\])*`
  .replaceAll('OPEN', String.raw`open\(\s*${TEXT}(?:\s*,\s*(?:'[rbt]+'|"[rbt]+"))?\s*\)`);
const NODE_FILE = String.raw`(?:(?:require\(\s*${FS}\s*\)|fs)\s*\.\s*)?readFileSync\(\s*${TEXT}(?:\s*,\s*${TEXT})?\s*\)`;
const NODE_READ = String.raw`(?:require\(\s*${TEXT}\s*\)|JSON\.parse\(\s*${NODE_FILE}\s*\)|${NODE_FILE})(?:\s*\.\s*[A-Za-z_$][\w$]*|\s*\[\s*(?:${TEXT}|\d+)\s*\])*`;
// A read may also be bound to a name, as in `r = json.load(open(p))` or `const r = require(p)`, and a name followed by
// keys only, such as `r['agents']` or `r.agents`, printed: neither calls anything. A bound name is never one a read
// calls, such as `readFileSync` or `open`, so a binding cannot turn a later read into another call.
const PYTHON_BOUND = String.raw`(?!(?:open|json|print)\b)[A-Za-z_]\w*`;
const NODE_BOUND = String.raw`(?!(?:fs|require|readFileSync|JSON|console)(?![\w$]))[A-Za-z_$][\w$]*`;
const PYTHON_NAME = String.raw`[A-Za-z_]\w*(?:\s*\[\s*(?:${TEXT}|\d+)\s*\])*`;
const NODE_NAME = String.raw`[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*|\s*\[\s*(?:${TEXT}|\d+)\s*\])*`;
const PYTHON_VALUE = String.raw`(?:${PYTHON_READ}|${PYTHON_NAME})`;
const NODE_VALUE = String.raw`(?:${NODE_READ}|${NODE_NAME})`;
// The code of each interpreter (shell-lex.mjs INTERPRETERS) that only reads, by its name; perl and ruby have none, as
// ruby's `open('|rm x')` runs a command.
const READS = {
  python: new RegExp(String.raw`^(?:import\s+json|${PYTHON_BOUND}\s*=\s*${PYTHON_READ}|print\(\s*(?:json\.dumps\(\s*${PYTHON_VALUE}(?:\s*,\s*indent\s*=\s*\d+)?\s*\)|${PYTHON_VALUE})\s*\)|${PYTHON_READ})$`, 'u'),
  node: new RegExp(String.raw`^(?:(?:const|let|var)\s+(?:fs|\{\s*readFileSync\s*\})\s*=\s*require\(\s*${FS}\s*\)|(?:const|let|var)\s+${NODE_BOUND}\s*=\s*${NODE_READ}|console\.log\(\s*(?:JSON\.stringify\(\s*${NODE_VALUE}(?:\s*,\s*(?:null|\d+))*\s*\)|${NODE_VALUE})\s*\)|${NODE_READ})$`, 'u'),
};

// Why the subagent call in `input`, a PreToolUse payload, may not run because it changes one of `project`'s config files,
// or null: { match, reason }. `match` names the file, as in `changes <project folder>/config.json`; `reason` tells the agent.
// It changes one when it writes the file, or a folder that holds it, such as the project folder an `rm -rf` names, unless
// that folder also holds one of the project's checkouts, such as the project root or its worktree, as `cp notes.md .` does.
// `also` lists more files to guard the same way, as absolute paths: the session's gate snapshot and the file that marks
// the session gated (lib/gate-snapshot.mjs). Code an interpreter runs also may not name the folder that holds them.
// A command in a shell the lexer cannot read may only read the file it names, so its block says it may change it.
export function configWriteDenial(input, project, { names: { human } }, { also = [] } = {}) {
  if (typeof input.agent_id !== 'string' || input.agent_id === '') return null;
  const { files: targets, names, globs } = writeTargets(input);
  if (targets.length === 0 && names.length === 0 && globs.length === 0) return null;
  const verb = opaqueShellCommand(input) === null ? 'changes' : 'may change';
  const roots = project.checkouts.map((dir) => canonical(dir));
  const guarded = also.map((file) => canonical(file));
  const files = [...configFiles(project).map((file) => canonical(file)), ...guarded];
  const shown = (file) => (isWithin(roots[0], file) ? path.relative(roots[0], file) : file);
  for (const target of targets.map((each) => canonical(each))) {
    checkDeadline();
    const holdsRoot = roots.some((root) => isWithin(target, root));
    const file = files.find((each) => each === target || sameFile(each, target) || (!holdsRoot && isWithin(target, each)));
    if (file) return blocked(input, shown(file), verb, human);
  }
  // A glob reaches a file by the path it is spelled with, which a symlink may place in another folder than its target.
  const spelled = [...configFiles(project), ...also].map((file, i) => [path.resolve(file), files[i]]);
  const shell = globs.filter((glob) => !glob.opaque);
  const seen = linkWalk(input);
  const named = namedFile(names, files, project, guarded)
    ?? globbedFile(shell, spelled, seen, targets.length + names.length + globs.length > 1, input.tool_input?.command ?? '')
    ?? opaqueGlobbedFile(globs.filter((glob) => glob.opaque), spelled, seen, project.checkouts, new Set(spelled.slice(spelled.length - also.length).flat()));
  return named ? blocked(input, shown(named), 'may change', human) : null;
}

// The machine's switches in the local file, read from what it parses to: the key a write of one names, where it sits,
// the name the denial gives it, what a subagent may not do, and the shape of a patch line that changes it.
const SWITCHES = Object.freeze([
  Object.freeze({ key: 'autoMerge', valueIn: (parsed) => parsed?.github?.autoMerge, name: 'github.autoMerge', why: 'only the main session may turn merging without a Human on or off', patched: /^[+-].*(?:autoMerge|"enabled"\s*:)/mu }),
  Object.freeze({ key: 'unattendedWaiver', valueIn: (parsed) => parsed?.github?.unattendedWaiver, name: 'github.unattendedWaiver', why: 'only the main session may let a recorded judge verdict waive the merge guard', patched: /^[+-].*(?:unattendedWaiver|"enabled"\s*:)/mu }),
  Object.freeze({ key: 'reviewApprovals', valueIn: (parsed) => parsed?.reviewApprovals, name: 'reviewApprovals', why: 'only the main session may let a named approver\'s review close a flow invariant, or stop it', patched: /^[+-].*reviewApprovals/mu }),
  Object.freeze({ key: 'unattendedSignoff', valueIn: (parsed) => parsed?.unattendedSignoff, name: 'unattendedSignoff', why: 'only the main session may let a judge\'s ruling close a flow invariant in place of the Human', patched: /^[+-].*unattendedSignoff/mu }),
  Object.freeze({ key: 'background', valueIn: (parsed) => parsed?.handoff?.background, name: 'handoff.background', why: 'only the main session may let a handoff start sessions in the background with no Human', patched: /^[+-].*"background"\s*:/mu }),
  // In a pretty-printed file the value sits on its own line, under a key the patch does not touch.
  Object.freeze({ key: 'productFeedback', valueIn: (parsed) => parsed?.review?.productFeedback, name: 'review.productFeedback', why: 'only the main session may choose whether this machine owes product feedback', patched: /^[+-].*(?:productFeedback|"auto"\s*:)/mu }),
  // Which keychain entry gives a project run's issue sessions their forge token (lib/project-token.mjs), as the reader
  // takes it, so a sibling key that voids the whole setting changes it too. A patch, which is not applied here, changes
  // it when a line names projectRun or its keys, or, while the file selects an entry, when it adds or removes any line,
  // or deletes or moves a file, which no added or removed line shows.
  Object.freeze({
    key: 'forgeTokenKeychain', valueIn: (parsed) => localForgeTokenKeychain(parsed, []) ?? undefined, name: 'projectRun.forgeTokenKeychain', why: 'only the main session may choose which keychain entry gives a project run\'s sessions their forge token',
    patched: (text, before) => /^[+-].*(?:projectRun|forgeTokenKeychain|"service"\s*:|"account"\s*:)/mu.test(text) || (selectsKeychain(before) && /^(?:[+-](?![+-])|\*\*\* (?:Delete File|Move to):)/mu.test(text)),
  }),
]);

// Whether the local file's text `text` selects a keychain entry for the forge token, as the reader takes it.
function selectsKeychain(text) {
  const set = switchIn(text, (parsed) => localForgeTokenKeychain(parsed, []) ?? undefined);
  return set !== undefined;
}

// What a Bash write to the local file that names no key changes: every switch in it, a local "off" among them.
const EVERY_SWITCH = Object.freeze({ name: 'every machine switch', why: 'only the main session may change the machine\'s switches, a local "off" among them' });

// Why the subagent call in `input` may not set one of the machine's switches, the auto-merge switch, the unattended waiver, review approvals, the forge token's keychain entry,
// the background handoff, or the product feedback choice, or null: { match, reason }. It targets the project's local file and either changes the
// switch (changesSwitch) or is a Bash command that writes it: any Bash write, move, remove, truncate, or copy over the
// file counts as changing every switch, whether or not it names a key, since erasing a local "off" lets the team's
// `solo` turn that switch on (config-local.mjs machineSwitch). It targets the file by its name, in any folder and
// case, by a Bash glob whose last part matches that name, such as its name with a `*` for its end, or by a Bash glob from
// a folder the lexer knows that passes a link to the file already on disk (globLinksTo), as `tee out/alias*` does
// when `out/alias` links to it. A write that names no key is judged by its paths and names, and by a glob spelled in
// a checkout's folder or an unknown one, with no walk of the links on disk: a write through a link named otherwise,
// such as `: > alias` where `alias` links to the file, is a known limit. This holds with no gates set; a Write or Edit
// that leaves every switch as it was stays allowed, and so does a read. Like the rest of this guard, it is for agents
// that cooperate.
// A command in a shell the lexer cannot read that names the local file, or has a glob that may reach it
// (opaqueGlobReaches), is refused whether or not it names a key: it may set a switch by a key it builds, and the guard
// cannot tell.
// A main session that `unattended()` says no Human attends, such as one the background handoff route started
// (lib/handoff-guard.mjs startedUnattended), is refused as a subagent is. It is asked only for a call that sets a switch.
export function machineSwitchWriteDenial(input, project, { names: { human } }, { unattended = () => false } = {}) {
  const subagent = typeof input.agent_id === 'string' && input.agent_id !== '';
  const opaque = opaqueShellCommand(input) !== null;
  const isBash = bashCall(input);
  const command = String(input.tool_input?.command ?? '');
  const named = SWITCHES.filter(({ key }) => !isBash || command.includes(key));
  // A Bash call that names no key may still erase a switch: a remove, move, truncate, link, or copy over the file lifts a
  // local "off", which the team's `solo` then turns on (config-local.mjs machineSwitch). Only a call that may name the
  // file, by its name, however quoted, or a glob, or that may clean or stash it away, is read further.
  const plain = unquoted(command);
  const erases = isBash && named.length === 0 && /aidrian|[*?[]|\bclean\b|\bstash\b/iu.test(plain);
  if (named.length === 0 && !erases) return null;
  const { files, names, globs } = writeTargets(input);
  const local = project.paths.local;
  const targets = files.filter((file) => path.basename(file).toLowerCase() === local);
  const locals = configFiles(project).filter((file) => path.basename(file) === local).map((file) => [file]);
  const seen = linkWalk(input);
  const linked = (glob) => glob.unsure === false && locals.some(([file]) => globLinksTo(glob, canonical(file), seen));
  // A write that names no key is judged by the folder a glob is spelled in, with no walk of the links on disk, so a
  // glob over another folder costs nothing: it reaches the file when its last part matches the name and its folder is
  // a checkout's, has a wildcard of its own, or is unknown.
  const folders = new Set(project.checkouts.map((dir) => foldCase(canonical(dir))));
  const here = (glob) => glob.unsure || (path.isAbsolute(glob.text) ? [glob.text] : (glob.dirs ?? []).map((dir) => path.resolve(dir, glob.text))).some((spelled) => {
    const folder = path.dirname(spelled);
    return GLOB_WORD.test(folder) || folders.has(foldCase(canonical(folder)));
  });
  const matches = (glob) => globParts(glob.text, [], 'i').pattern.test(local);
  const globbed = () => globs.some((glob) => !glob.opaque && (erases ? matches(glob) && here(glob) : matches(glob) || linked(glob)));
  // The paths and names first: a call they settle reads no folder on disk.
  const aimed = targets.length > 0 || names.some((name) => name.toLowerCase().includes(local)) || globbed();
  const reached = !aimed && opaque && opaqueGlobbedFile(globs, locals, seen, project.checkouts) !== null;
  if (!aimed && !reached && !(erases && !opaque && erasesOtherwise(input, project, plain, globs))) return null;
  const hit = opaque || isBash ? named[0] ?? EVERY_SWITCH : named.find((each) => changesSwitch(input, targets[0], each, local));
  if (!hit || (!subagent && !unattended())) return null;
  // A session no Human attends is a main session, so the reason names the Human, not the main session.
  const only = (text) => (subagent ? text : `${text.replace(/^only the main session/u, 'only a main session a Human attends')}, and the background handoff route started this one, with no Human`);
  if (opaque) {
    const how = aimed ? 'names' : 'has a glob that may reach';
    const why = `it ${how} ${local} in a shell command the guard cannot read, so it may set one of the machine's switches there, which ${only('only the main session may set')}`;
    return { match: `may set a switch in ${local}`, reason: projectRuleReason(input, `${why}; to read the file, use Read`, human) };
  }
  if (hit === EVERY_SWITCH) {
    return { match: `changes ${local}`, reason: projectRuleReason(input, `it writes, moves, links, or removes ${local}, or may, which holds the machine's switches, and ${only(hit.why)}; to read the file, use Read`, human) };
  }
  return { match: `sets ${hit.name} in ${local}`, reason: projectRuleReason(input, `it sets ${hit.name} in ${local}, and ${only(hit.why)}`, human) };
}

// `text` with its quotes, backslashes, and backticks taken out, so a word split by them, as `rm .aid""rian.local.json`
// or `git rem''ote`, still reads whole to a quick check of its words. lib/handoff-guard.mjs reads it too.
export const unquoted = (text) => text.replace(/['"`\\]/gu, '');

// The programs whose word built from a variable may be a file they write.
const WRITERS = new Set(['rm', 'mv', 'cp', 'ln', 'truncate', 'tee', 'touch', 'dd', 'install', 'rsync', 'unlink', 'shred', 'sed', 'perl']);
// cp's options that make a link instead of a copy, alone or in a cluster.
const LINK_COPY = /^(?:--link|--symbolic-link|-[A-Za-z]*[ls][A-Za-z]*)$/u;

// Whether a Bash call that names no key changes the local file in a way its write targets do not show: a link made
// from it (`ln`, `ln -s`, `cp -l`, `cp -s`), which a later write through the link changes; `git clean` with `-x` or `-X`,
// or `git stash` with `-a` or `--all`, run in the main checkout or a folder the guard cannot know, which takes the
// ignored file away; and, when `plain`, the command's unquoted text, names the file, a write to a word built from a
// variable, or a bracket glob, either of which may spell it. Known limits: a link already on disk under another name,
// and a program that deletes what it finds, such as `find -delete`.
function erasesOtherwise(input, project, plain, globs) {
  const local = project.paths.local;
  const names = plain.toLowerCase().includes(local.slice(1));
  const main = foldCase(canonical(project.checkouts.at(-1)));
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const isLocal = (text) => path.basename(text).toLowerCase() === local;
  if (names && globs.some((glob) => glob.text.includes('['))) return true;
  for (const { segment, invocation, folder } of walkCommands(input.tool_input.command, cwd)) {
    checkDeadline();
    const words = invocation.args.filter((token) => !token.dynamic).map((token) => token.text);
    const operands = words.filter((text) => !text.startsWith('-'));
    if (invocation.program === 'ln' && operands.some(isLocal)) return true;
    if (invocation.program === 'cp' && words.some((text) => LINK_COPY.test(text)) && operands.some(isLocal)) return true;
    const git = invocation.program === 'git' ? readGit(segment) : null;
    if (git && wipesIgnored(git)) {
      const at = git.globals.findIndex((token) => token.text === '-C');
      const where = folder === null ? null : path.resolve(folder, at === -1 ? '.' : git.globals[at + 1]?.text ?? '.');
      if (where === null || foldCase(canonical(where)) === main) return true;
    }
    if (!names) continue;
    if (invocation.dynamic || (WRITERS.has(invocation.program) && invocation.args.some((token) => token.dynamic))) return true;
    if (shellRedirections(segment).some((each) => /^\d*>/u.test(each) && /[$`]/u.test(each))) return true;
  }
  return false;
}

// Whether a git call readGit read takes ignored files away: `git clean` with `-x` or `-X`, or `git stash` with `-a` or
// `--all`, in a cluster or alone.
function wipesIgnored({ subcommand, rest }) {
  const words = rest.filter((token) => !token.dynamic).map((token) => token.text);
  if (subcommand === 'clean') return words.some((text) => /^-[A-Za-z]*[xX][A-Za-z]*$/u.test(text));
  if (subcommand === 'stash') return words.some((text) => text === '--all' || /^-[A-Za-z]*a[A-Za-z]*$/u.test(text));
  return false;
}

// Whether `input` is a Bash call; lib/handoff-guard.mjs asks it too.
export const bashCall = (input) => input.tool_name === 'Bash';

// Whether a Write, Edit, or apply_patch of the local `file` changes the switch. A Write or Edit changes it when its text
// names the key, or when the file it leaves parses to another value than the file on disk, which covers
// `"off"` to `"on"`, a JSON escape, a removed key, and a file left unparsable. A patch changes it when a line it adds or
// removes names the key, or the switch's own `patched` shape: a patch is not applied here, so a value on a line of its own
// that names neither, or a key spelled with a JSON escape, is not seen. Each operation of a patch whose file is the
// local file named `local` is judged alone, against that file as it is on disk, from the call's folder `cwd`; one that
// moves a file into it, by the moved file and its update lines, as the new local file.
function changesSwitch({ tool_name: tool, tool_input: given, cwd }, file, { key, valueIn, patched }, local = path.basename(file ?? '')) {
  const edit = fileEditOf({ tool_name: tool, tool_input: given });
  if (edit?.shape === 'patch') {
    const from = (each) => path.resolve(typeof cwd === 'string' ? cwd : process.cwd(), each);
    const isLocal = (each) => typeof each === 'string' && path.basename(each).toLowerCase() === local.toLowerCase();
    const judged = (text, before) => (typeof patched === 'function' ? patched(text, before) : patched.test(text));
    return patchOperations(edit.text).some(({ file, move, text }) => {
      if (isLocal(file) && judged(text, readText(from(file)))) return true;
      if (!isLocal(move)) return false;
      // A move into the local file leaves the moved file, with this operation's update lines, as the new local file.
      const moved = readText(from(file));
      return switchIn(moved, valueIn) !== switchIn(readText(from(move)), valueIn) || judged(text, moved);
    });
  }
  const written = edit?.shape === 'write' ? edit.content : edit?.shape === 'edit' ? edit.newText : undefined;
  if (typeof written !== 'string') return false;
  if (written.includes(key)) return true;
  const before = readText(file);
  return switchIn(before, valueIn) !== switchIn(edit.shape === 'write' ? written : editedText(before, given), valueIn);
}

// The operations of an apply_patch text, each { file, move, text }: the file its `*** Add File:`, `*** Update File:`, or
// `*** Delete File:` header names, the file a `*** Move to:` line moves it to, or null, and the operation's own lines,
// headers included.
function patchOperations(text) {
  const operations = [];
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    const header = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/u.exec(line);
    const move = /^\*\*\* Move to: (.+)$/u.exec(line);
    if (header) operations.push({ file: header[1].trim(), move: null, text: `${line}\n` });
    else if (/^\*\*\* (?:Begin|End) Patch/u.test(line)) continue;
    else if (operations.length) {
      if (move) operations.at(-1).move = move[1].trim();
      operations.at(-1).text += `${line}\n`;
    }
  }
  return operations;
}

// `text` after an Edit, with its new text taken literally: a replacer function keeps `$&` from meaning what it replaces.
function editedText(text, { old_string: from, new_string: to, replace_all: all }) {
  if (typeof from !== 'string') return text;
  return all === true ? text.replaceAll(from, () => to) : text.replace(from, () => to);
}

// The file's text, or an empty one when it cannot be read: a hook lets the action run when it cannot read its input.
function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

// The switch a text of the local file sets, as JSON text, or undefined when it sets none or is no JSON.
function switchIn(text, valueIn) {
  try {
    return JSON.stringify(valueIn(JSON.parse(text)));
  } catch {
    return undefined;
  }
}

// What the call writes: { files, names, globs }. `files` are absolute paths; `names` are texts that may name a file in a
// folder no path gives: a relative target written after a `cd` to an unknown folder, code an interpreter runs, and the
// words of a command in a shell the lexer cannot read (opaqueWords); `globs` are bashWrites's glob targets.
// lib/handoff-guard.mjs reads them too. A path with a bracket class is a file and a glob both. A command in a shell the
// lexer cannot read writes, failing closed, to the path each of its first OPAQUE_WORDS words gives, from the call's folder
// when it is relative and from the home folder after a leading `~`, and to the glob each such word with `*`, `?`, or `[`
// is, marked `opaque`: the guards judge it by the folder it reaches from the call's folder, and, since such a shell may
// change its folder first, by its name when that names a guarded file (opaqueGlobReaches). `names` holds every word.
// One pipeline of PowerShell's read-only cmdlets with plain words alone (READ_ONLY) writes nothing.
// Each guard of a call asks it, so it reads the call once.
export function writeTargets(input) {
  if (!written.has(input)) written.set(input, readTargets(input));
  return written.get(input);
}

const written = new WeakMap();

function readTargets(input) {
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  if (isFileEditTool(input.tool_name)) return { files: toolTargets(input).map((target) => path.resolve(cwd, target)), names: [], globs: [] };
  const opaque = opaqueShellCommand(input);
  if (opaque !== null) {
    if (READ_ONLY.test(opaque)) return { files: [], names: [], globs: [] };
    const words = opaqueWords(opaque);
    const read = words.slice(0, OPAQUE_WORDS).map(fromHome);
    return {
      files: read.filter((word) => !GLOB_WORD.test(word)).map((word) => path.resolve(cwd, word)),
      names: words,
      globs: read.filter((word) => GLOB_WORD.test(word)).map((text) => ({ text, dirs: path.isAbsolute(text) ? [] : [cwd], unsure: false, opaque: true })),
    };
  }
  const command = input.tool_input?.command;
  if (input.tool_name !== 'Bash' || typeof command !== 'string') return { files: [], names: [], globs: [] };
  const writes = bashWrites(command, cwd, { followCd: true, shells: true, restores: true, globs: true });
  const files = writes.flatMap((write) => write.files);
  return {
    files,
    names: [...writes.filter((write) => write.unsure && !write.glob && !path.isAbsolute(write.text)).map((write) => write.text), ...interpretedCode(command)],
    // The lexer reads a bracket class, as in `[.]continue`, as a plain word; the shell expands it as a glob.
    globs: [...writes.filter((write) => write.glob), ...files.filter((file) => BRACKET.test(file)).map((text) => ({ text, dirs: [], unsure: false }))],
  };
}

// PowerShell cmdlets that only read, by name and by the aliases PowerShell 7 gives them on every platform, so not `write`
// or `gsv`, aliases on Windows only, which on another system run a program of that name; the tool loads no profile that
// could change them. One pipeline of these alone, each word plain, writes nothing (writeTargets).
const READERS = ['Get-ChildItem', 'gci', 'dir', 'Get-Item', 'gi', 'Get-ItemProperty', 'gp', 'Get-Content', 'gc', 'Select-String', 'sls', 'Test-Path', 'Resolve-Path', 'rvpa', 'Split-Path', 'Get-Location', 'gl', 'pwd', 'Where-Object', 'where', '?', 'Select-Object', 'select', 'Sort-Object', 'Measure-Object', 'measure', 'Group-Object', 'group', 'Format-Table', 'ft', 'Format-List', 'fl', 'Format-Wide', 'fw', 'Out-String', 'Out-Host', 'Get-Command', 'gcm', 'Get-Help', 'Get-Process', 'gps', 'Get-Service', 'Get-Date', 'Write-Output', 'echo', 'Write-Host'];
// A plain word: no variable, subexpression, script block, splat, redirection, operator, escape, or comment; a bracket
// class; or a quoted text with no `$`, backtick, or typographic quote in it.
const PLAIN = String.raw`(?:[^\s$(){}\[\];&|<>\x60@#'"\u2018-\u201E]|\[[^\s\]$\x60]*\]|'[^'$\x60\u2018-\u201B\n]*'|"[^"$\x60\u201C-\u201E\n]*")+`;
const STEP = String.raw`(?:${READERS.map((name) => name.replace('?', '\\?')).join('|')})(?=[ \t|]|$)(?:[ \t]+${PLAIN})*`;
const READ_ONLY = new RegExp(String.raw`^[ \t]*${STEP}(?:[ \t]*\|[ \t]*${STEP})*[ \t]*$`, 'iu');
const BRACKET = /\[[^/]*\]/u;

// The most words of a command in a shell the lexer cannot read that the guards resolve as paths and globs. A command
// with more, of a subagent, a session no Human attends, or a run's driver, is refused (opaqueLimitDenial): a guarded file may hide in the rest. What the guards still cannot
// finish in time, the agent gate hook's time budget answers (deadlineDenial).
export const OPAQUE_WORDS = 512;

// The most targets of a Bash call the guards resolve: its paths, its globs, and the texts that may name a file. A call
// with more, of a subagent, a session no Human attends, or a run's driver, is refused (writeLimitDenial), as the guards
// resolve no more.
export const WRITE_TARGETS = 1024;

// A word as such a shell reads a leading `~`: `~` and `~/x` (`~\x`, its backslash read as a `/`) are in the home folder.
const fromHome = (word) => (word === '~' || word.startsWith('~/') ? path.join(homedir(), word.slice(1)) : word);

const isSubagent = (input) => typeof input.agent_id === 'string' && input.agent_id !== '';

// Who alone may change the files the guards keep, as a reason says it to a call the limits and the time budget hold, or
// null for a call they let run: a subagent's; a main session's `unattended()` says no Human attends; and a main session's
// `drove()` says has driven a project run (run-driver.mjs droveRun), held from the run's stores, the marks, and the
// sign-off store from its first call (scripts/hook-agent-gates.mjs), which a call the guards cannot read whole may reach.
// `issue()` says the session works an issue of a project run (unattended-mark.mjs issueHeld), which its reason names.
function onlyMain(input, { unattended, drove, issue }) {
  if (isSubagent(input)) return 'only the main session may change';
  if (issue()) return 'only a session a Human attends may change, and this session works an issue of a project run, which no Human attends';
  if (unattended()) return 'only a main session a Human attends may change, and the background handoff route started this one, with no Human';
  if (drove()) return 'only a main session a Human attends may change, and this session has driven a project run, whose driver mark holds it as one no Human attends';
  return null;
}

// Why the call in `input` may not run because its command, in a shell the lexer cannot read, has more words than the
// guards resolve (OPAQUE_WORDS), or null: { match, reason }. Past that many, a guarded file may hide in the rest. It holds
// for a subagent, and for a main session `unattended()` says no Human attends or `drove()` says has driven a project run
// (onlyMain), asked last. `mark`, the session's unattended mark, names an issue session as that in the reason.
export function opaqueLimitDenial(input, { names: { human } }, { unattended = () => false, drove = () => false, issue = () => false, mark = null } = {}) {
  const opaque = opaqueShellCommand(input);
  if (opaque === null) return null;
  const count = opaqueWords(opaque).length;
  if (count <= OPAQUE_WORDS) return null;
  const who = onlyMain(input, { unattended, drove, issue });
  if (who === null) return null;
  const why = `its command has ${count} words, counting each case, and the guards read at most ${OPAQUE_WORDS} in a shell command they cannot parse, so it may change a file ${who}`;
  return { match: `more than ${OPAQUE_WORDS} words`, reason: projectRuleReason(input, why, human, 'that the command is longer than the guards read, or run it as shorter commands', { mark }) };
}

// Why the Bash call in `input` may not run because it writes more targets than the guards resolve (WRITE_TARGETS), or
// null: { match, reason }. Past that many, a guarded file may hide in the rest. It holds as opaqueLimitDenial does.
export function writeLimitDenial(input, { names: { human } }, { unattended = () => false, drove = () => false, issue = () => false, mark = null } = {}) {
  if (!bashCall(input)) return null;
  const { files, names, globs } = writeTargets(input);
  const count = files.length + names.length + globs.length;
  if (count <= WRITE_TARGETS) return null;
  const who = onlyMain(input, { unattended, drove, issue });
  if (who === null) return null;
  const why = `its command writes ${count} targets, counting each folder a path may be in, and the guards read at most ${WRITE_TARGETS} in one call, so it may change a file ${who}`;
  return { match: `more than ${WRITE_TARGETS} write targets`, reason: projectRuleReason(input, why, human, 'that the command writes more files than the guards read, or run it as shorter commands', { mark }) };
}

// Whether the call in `input` is no shell and has no write target, such as a Read, a search, or an MCP tool's call:
// every guard of the agent gate hook reads a shell command or the files a call writes, so none refuses such a call,
// whoever makes it. A PowerShell pipeline of read-only cmdlets alone (writeTargets) has none either.
export function writesNothing(input) {
  if (bashCall(input)) return false;
  const { files, names, globs } = writeTargets(input);
  return files.length === 0 && names.length === 0 && globs.length === 0;
}

// Why the call in `input` may not run because the guards could not finish reading it within the agent gate hook's time
// budget (lib/deadline.mjs), or null for a main session a Human attends, whose call runs: { match, reason }. It holds
// for a subagent, and for a main session `unattended()` says no Human attends or `drove()` says has driven a project
// run (onlyMain): the guards it could not finish hold a run's driver from the run's stores, the marks, and the sign-off
// store. A call that writes nothing (writesNothing), which no guard refuses, runs for every session, so a loaded machine
// never stalls a session the guards hold on its reads; a shell call, such as a driver's `aidrian project wait`, is held.
// The time the guards take depends on the machine's load, as when many sessions or a test suite run at once, so the same
// call often passes a moment later: the refusal gives one ordered recovery, a retry of the call alone first, then shorter
// commands, then the report. An agent that read "tell the Human" first stopped at once, as a fix agent with one small
// Edit did.
const RETRY = 'only after these steps, in order: a busy machine slows the guards, so 1) retry this same call by itself,'
  + ' up to three times (a retry is the same tool, not another one); 2) if a shell call is still refused, run it as shorter commands;'
  + ' 3) when those are refused too, or the call is no shell call or cannot be split, stop and report that the command takes the guards longer than they have';
export function deadlineDenial(input, { names: { human } }, { unattended = () => false, drove = () => false, issue = () => false, mark = null } = {}) {
  if (writesNothing(input)) return null;
  const who = onlyMain(input, { unattended, drove, issue });
  if (who === null) return null;
  const why = `the guards could not finish reading this command in time, so it may change a file ${who}`;
  return { match: 'past the guards\' time budget', reason: projectRuleReason(input, why, human, RETRY, { mark }) };
}

// The texts a command in a shell the lexer cannot read is judged by: the command as given, and, when it differs, a copy
// with the joins such a shell makes undone: each backtick, its escape character, removed, each literal join of two quoted
// texts, as `'hand'+'off'`, folded into one, and each quote removed, so `hand`off`, `hand"off"`, and `'hand'+'off'`
// each read `handoff`. A typographic quote, U+2018 to U+201E, is a quote too, as PowerShell reads one.
// lib/handoff-guard.mjs reads them too.
export function opaqueTexts(command) {
  const joined = command.replaceAll('`', '').replace(/['"\u2018-\u201E]\s*\+\s*['"\u2018-\u201E]/gu, '').replace(/['"\u2018-\u201E]/gu, '');
  return joined === command ? [command] : [command, joined];
}

// The words of a command in a shell the lexer cannot read, each a text that may name a file: the words of each of its
// opaqueTexts, split at blanks, quotes, backticks, and the characters that join or group words, with each backslash read
// as a `/`, and each word also in lower case, since such a shell may reach a file by any case of its name. Failing closed:
// a word a read names counts too.
export function opaqueWords(command) {
  const split = opaqueTexts(command).flatMap((text) => text.replaceAll('\\', '/').split(/[\s'"\u2018-\u201E`;|&(){}<>,=+@]+/u).filter(Boolean));
  // A parameter given its value in the same word, as `-Path:x`, names `x` too; such a shell reads a dash of U+2013 to U+2015 as `-`.
  const words = split.flatMap((word) => { const value = /^[-\u2013-\u2015][\p{L}\d_]*:(.+)$/u.exec(word)?.[1]; return value ? [word, value] : [word]; });
  return [...new Set([...words, ...words.map((word) => word.toLowerCase())])];
}

// The guarded file one of `names` names, or null: by its file name, for config.json by the project folder's name, and
// for a file `also` lists by its folder's last two parts, such as `aidrian/sessions`, with or without a path below it.
// A name counts only as a whole path part, so `tsconfig.json` is not `config.json`, and `<project folder>/knowledge`
// names a folder inside the project folder, not the folder itself.
function namedFile(names, files, project, also) {
  const folder = path.posix.basename(project.dir);
  const config = canonical(path.join(project.root, project.paths.config));
  const lastTwo = (dir) => `${path.basename(path.dirname(dir))}/${path.basename(dir)}`;
  const patterns = [
    ...files.map((file) => [file, wholePart(path.basename(file), '(?![\\w.-])')]),
    [config, wholePart(folder, '(?![\\w.-]|/[^\\s\'"/])')],
    ...also.map((file) => [file, wholePart(lastTwo(path.dirname(file)), '(?![\\w.-])')]),
  ];
  return patterns.find(([, pattern]) => names.some((name) => {
    checkDeadline();
    return pattern.test(name);
  }))?.[0] ?? null;
}

// The guarded file a glob target may match, or null: the path part right below the glob's folder, as `*.json` or `.aid*`,
// against the file's own name or the folder that holds it, which a recursive delete removes with it. When the glob's
// folder is known, only files inside it count, so `rm -rf dist/*` changes nothing guarded; when a glob or an unknown `cd`
// leaves the folder unknown, any file's name or folder counts: failing closed.
// `files` pairs each guarded file's spelled path with its canonical one; either may match, and the canonical is returned.
// `others` says the call has another write, a glob or not, which may create a link, in the glob's folder or above it,
// that the glob then follows after the disk was read; `command` is the call's whole command line.
// A glob from a folder the lexer knows, simple or not, also reaches a file through a link already on disk in any part
// it expands, as `printf x | tee out/alias*` or `out/l*/config.json` do (globLinksTo, with `seen` the call's linkWalk).
function globbedFile(globs, files, seen, others = true, command = '') {
  // The glob's folder is trusted only in one simple command the lexer reads exactly: a plain file tool, plain words, no
  // `..`. A `cd`, a wrapper (`env -C`), a variable, braces, quotes, or a second command may each move or hide what the
  // glob reaches, and every such shape is judged by name instead: failing closed.
  const simple =
    !others && SIMPLE_COMMAND.test(command) && !command.split(/[ \t/]+/u).includes('..');
  const reaches = (pair, { text, dirs = [], unsure = true }) => pair.some((file) => {
    checkDeadline();
    const { head, pattern, folders } = globParts(text, dirs);
    if (unsure || !simple || /[*?[]/u.test(head)) return pattern.test(path.basename(file)) || pattern.test(path.basename(path.dirname(file)));
    return folders.some((folder) =>
      [folder, canonical(folder)].some((dir) => isWithin(dir, file) && pattern.test(path.relative(dir, file).split(path.sep)[0])) ||
      // An entry the glob matches may be a hard link to the file, which keeps its own path.
      entries(folder).some((name) => {
        checkDeadline();
        return pattern.test(name) && sameFile(path.join(folder, name), pair[1]);
      }));
  });
  return files.find((pair) => globs.some((glob) => reaches(pair, glob) || (glob.unsure === false && globLinksTo(glob, pair[1], seen))))?.[1] ?? null;
}

// The guarded file one of `globs`, glob words of a command in a shell the lexer cannot read, may reach, or null.
// `files` pairs each guarded file's spelled path with its canonical one, as globbedFile's do; the last of a pair is returned.
// `checkouts` are the project's checkouts, whose folder a glob never names by name alone, and `deep` the files, of either
// spelling, whose folder it names only with the folder above it, as `aidrian/sessions` for the gate snapshot.
// `seen` is the call's linkWalk, so a folder counts against the link budget once a call (lib/glob-links.mjs).
function opaqueGlobbedFile(globs, files, seen, checkouts = [], deep = new Set()) {
  if (globs.length === 0) return null;
  const roots = new Set(checkouts.flatMap((dir) => [path.resolve(dir), canonical(dir)]));
  const folderParts = (file) => (deep.has(file) ? 2 : roots.has(path.dirname(file)) ? 0 : 1);
  return files.find((pair) => globs.some((glob) => pair.some((file) => opaqueGlobReaches(glob, file, seen, folderParts(file)))))?.at(-1) ?? null;
}

// Whether `glob`, a glob word of a command in a shell the lexer cannot read as writeTargets gives it, may reach `file`:
// by its name (globNamesFile), or from the call's folder (`dirs`), when each of its parts matches the part of the file's
// path at that depth, in any case, as it names the file, a folder that holds it, or a link to either: a glob matches only
// what is there, so `src/*` or `*.json` in a folder without the file does not. `seen` caches what each folder holds and
// counts the entries left to read (LINK_BUDGET), each folder once (folderOf); `folderParts` is globNamesFile's.
function opaqueGlobReaches(glob, file, seen, folderParts) {
  checkDeadline();
  if (globNamesFile(glob.text, file, { folderParts })) return true;
  return globStarts(glob).some(({ start, rest }) => {
    // A wildcard before the last part may pass a link in any folder it reaches, not only the first.
    if (rest.slice(0, -1).some((part) => GLOB_WORD.test(part)) && linkBelow(start, rest, file, seen)) return true;
    const folder = folderOf(start, seen);
    if (folder === null) return true;
    const { dirs: here, real, links } = folder;
    const below = (dir) => {
      if (!isWithin(dir, file) || dir === file) return false;
      const reached = path.relative(dir, file).split(path.sep);
      return isEntry(path.join(dir, reached[0])) && reachesFile(rest, reached);
    };
    if (here.some(below)) return true;
    // An entry the glob's first part matches may be a link to the file, or to a folder that holds it, from anywhere.
    const first = globParts(rest[0], [], 'i').pattern;
    // The time budget is checked at each name, so no folder of many long names holds the guard past it.
    return links.some((name) => {
      checkDeadline();
      return first.test(name) && linkReaches(realOf(path.join(real, name), seen), rest.slice(1), file);
    });
  });
}

// Whether a glob word names `file` by its name alone, as one in a shell that changed its folder first may reach it: its
// last part matches the file's name, or its folder's, and starts with a plain text of at least NAMED_START characters
// past any dots, as the local file's name with a `*` for its end, `conf*`, `.aid*`, or `conf[i]g.json` do; or its last
// two parts match the file's folder and name, the folder by its name or such a glob, as `<project folder>/*` for its
// config.json. So `*`, `*.json`, `.*`, `c*`, and `.c*` alone name no file. `folderParts` says how its last part names the
// file's folder: 1 by its name; 0 never, for a checkout's folder, whose name a project's paths share; 2 only with the
// folder above it, as `aidrian/ses*` names `<state>/aidrian/sessions`. lib/handoff-guard.mjs reads it too.
const NAMED_START = 3;
export function globNamesFile(text, file, { folderParts = 1 } = {}) {
  const parts = text.split('/').filter(Boolean);
  const last = parts.at(-1) ?? '';
  const [name, folder, above] = [path.basename(file), path.basename(path.dirname(file)), path.basename(path.dirname(path.dirname(file)))];
  const names = (part, each) => partMatches(part, each) && (!GLOB_WORD.test(part) || part.split(/[*?[]/u)[0].replace(/^\.+/u, '').length >= NAMED_START);
  if (GLOB_WORD.test(last) && (names(last, name) || (folderParts === 1 && names(last, folder)))) return true;
  if (folderParts === 2 && parts.length > 1 && GLOB_WORD.test(`${parts.at(-2)}${last}`) && names(parts.at(-2), above) && names(last, folder)) return true;
  return parts.length > 1 && names(parts.at(-2), folder) && partMatches(last, name);
}

// Spaces and tabs only: a newline separates commands, as `;` does. No `cp` or `mv`: they write into a directory the glob
// matches, below the entry this check resolves. `rm` removes a link, never its target. A word may hold a bracket class,
// `[a-z]`, `[!x]`, or `[[:alpha:]]`, which reaches no further than `*` does.
const SIMPLE_COMMAND = /^[ \t]*(?:rm|touch|truncate|tee|echo|printf|cat|mkdir)(?:[ \t]+[\w./*?=>[\]!^:-]+)*[ \t]*$/u;

// A folder's entry names, or none when it cannot be read.
function entries(folder) {
  try {
    return readdirSync(folder);
  } catch {
    return [];
  }
}

const wholePart = (name, after) => new RegExp(`(?<![\\w.-])${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}${after}`, 'u');

// The texts to judge by the files they name, of every interpreter the command runs with code from its command line or
// its input: its code, unless that code only reads (READS), and the rest of its words, which may name a file the code
// changes, as `sys.argv[1]` does. Its code is the rest of the word that gives it, as in `-c<code>` or `--eval=<code>`,
// or the word after, or the heredocs and here-strings fed to it, or, when none is, the whole command line, which a pipe
// may feed it from.
function interpretedCode(command) {
  const found = [];
  const read = (text, depth) => {
    for (const line of commandLines(text)) {
      const { segments, inputs } = lexInputs(line);
      for (const [i, segment] of segments.entries()) {
        const invocation = readInvocation(segment);
        const inner = depth < SUBSTITUTION_DEPTH_LIMIT ? inlineShellCommand(invocation) : null;
        if (inner !== null) read(inner, depth + 1);
        const interpreter = interpreterOf(invocation.program);
        if (!interpreter) continue;
        const { options } = interpreter;
        const reads = READS[interpreter.name];
        const words = invocation.args.map((token) => token.text);
        const at = words.findIndex((word) => givenCode(word, options) !== undefined);
        let code;
        let rest = words;
        if (at >= 0) {
          const attached = givenCode(words[at], options);
          code = attached ?? words[at + 1] ?? '';
          rest = words.filter((_, j) => j !== at && (attached !== null || j !== at + 1));
        } else if ((words.find((word) => !word.startsWith('-') || word === '-') ?? '-') === '-') {
          code = inputs[i].length ? inputs[i].join('\n') : line;
        } else continue;
        if (rest.length) found.push(rest.join(' '));
        if (!(reads && onlyReads(code, reads))) found.push(code);
      }
    }
  };
  read(command, 0);
  return found;
}

// Whether every statement of `code`, split at `;` and line ends, is one `reads` matches.
function onlyReads(code, reads) {
  const statements = statementsOf(code).map((each) => each.replace(/\s+/gu, ' ').trim()).filter(Boolean);
  return statements.length > 0 && statements.every((each) => reads.test(each));
}

// `code` split at each `;` and line end outside quotes and brackets, except a line end right after `=` or before a line
// that starts with `.`, so a read written over several lines, as `const r =\n  require(p)\n  .agents` or
// `json.load(\n  open(p))`, is one statement.
function statementsOf(code) {
  const statements = [];
  let current = '';
  let quote = null;
  let depth = 0;
  // A line that starts with an accessor, as `.agents`, continues the one before it.
  // Each run of white space is read once, and what follows it decides, so the scan stays linear.
  const joined = code.replace(/\n\s*/gu, (run, at, text) => (text[at + run.length] === '.' ? ' ' : run));
  // `last` is the last character of `current` that is not white space, kept as the loop goes, so no line end rescans it.
  let last = '';
  for (const char of joined) {
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === "'" || char === '"') quote = char;
    else if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && (char === ';' || (char === '\n' && last !== '='))) {
      statements.push(current);
      current = '';
      last = '';
      continue;
    }
    current += char;
    if (!/\s/u.test(char)) last = char;
  }
  return [...statements, current];
}

function blocked(input, file, verb, human) {
  let why = `it ${verb} ${file}, which sets this project's agent gates, and while gates are set only the main session may change it`;
  if (verb === 'may change') why += '; to read it, use Read, cat, or jq';
  return { match: `${verb} ${file}`, reason: projectRuleReason(input, why, human) };
}
