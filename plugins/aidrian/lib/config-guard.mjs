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
import { checkDeadline } from './deadline.mjs';
import { globParts, isEntry, isWithin } from './fs.mjs';
import { folderOf, GLOB_WORD, globLinksTo, globStarts, linkBelow, linkReaches, linkWalk, partMatches, reachesFile, realOf, sameFile } from './glob-links.mjs';
import { fileEditOf, isFileEditTool, opaqueShellCommand } from './hosts/index.mjs';
import { configFiles } from './project.mjs';
import { bashWrites, canonical, toolTargets } from './rules/main-checkout.mjs';
import { commandLines, inlineShellCommand, lexInputs, readInvocation, readShortOptions, SUBSTITUTION_DEPTH_LIMIT } from './shell-lex.mjs';

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
const READS = {
  python: new RegExp(String.raw`^(?:import\s+json|print\(\s*(?:json\.dumps\(\s*${PYTHON_READ}(?:\s*,\s*indent\s*=\s*\d+)?\s*\)|${PYTHON_READ})\s*\)|${PYTHON_READ})$`, 'u'),
  node: new RegExp(String.raw`^(?:(?:const|let|var)\s+(?:fs|\{\s*readFileSync\s*\})\s*=\s*require\(\s*${FS}\s*\)|console\.log\(\s*(?:JSON\.stringify\(\s*${NODE_READ}(?:\s*,\s*(?:null|\d+))*\s*\)|${NODE_READ})\s*\)|${NODE_READ})$`, 'u'),
};
// Interpreters, the options that hand them code on the command line, a short one also inside a cluster, and the code
// of theirs that only reads; perl and ruby have none, as ruby's `open('|rm x')` runs a command. node takes `-pe` as one
// option, so its code is the next word, not `e`.
const INTERPRETERS = [
  [/^python[\d.]*$/u, ['-c'], READS.python],
  [/^(?:node|nodejs|bun)$/u, ['-e', '-p', '-pe', '--eval', '--print'], READS.node],
  [/^perl[\d.]*$/u, ['-e', '-E'], null],
  [/^ruby[\d.]*$/u, ['-e'], null],
];

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
  // In a pretty-printed file the value sits on its own line, under a key the patch does not touch.
  Object.freeze({ key: 'productFeedback', valueIn: (parsed) => parsed?.review?.productFeedback, name: 'review.productFeedback', why: 'only the main session may choose whether this machine owes product feedback', patched: /^[+-].*(?:productFeedback|"auto"\s*:)/mu }),
]);

// Why the subagent call in `input` may not set one of the machine's switches, the auto-merge switch, the unattended waiver, review approvals, or
// the product feedback choice, or null: { match, reason }. It targets the project's local file and either changes the
// switch (changesSwitch) or is a Bash command that names its key. It targets the file by its name, in any folder and
// case, by a Bash glob whose last part matches that name, such as its name with a `*` for its end, or by a Bash glob from
// a folder the lexer knows that passes a link to the file already on disk (globLinksTo), as `tee out/alias*` does
// when `out/alias` links to it. This holds with no
// gates set, and other writes to that file stay allowed. Like the rest of this guard, it is for agents that cooperate.
// A command in a shell the lexer cannot read that names the local file, or has a glob that may reach it
// (opaqueGlobReaches), is refused whether or not it names a key: it may set a switch by a key it builds, and the guard
// cannot tell.
export function machineSwitchWriteDenial(input, project, { names: { human } }) {
  if (typeof input.agent_id !== 'string' || input.agent_id === '') return null;
  const opaque = opaqueShellCommand(input) !== null;
  const isBash = bashCall(input);
  const named = SWITCHES.filter(({ key }) => !isBash || String(input.tool_input?.command).includes(key));
  if (named.length === 0) return null;
  const { files, names, globs } = writeTargets(input);
  const local = project.paths.local;
  const targets = files.filter((file) => path.basename(file).toLowerCase() === local);
  const locals = configFiles(project).filter((file) => path.basename(file) === local).map((file) => [file]);
  const seen = linkWalk(input);
  const linked = (glob) => glob.unsure === false && locals.some(([file]) => globLinksTo(glob, canonical(file), seen));
  const globbed = globs.some((glob) => !glob.opaque && (globParts(glob.text, [], 'i').pattern.test(local) || linked(glob)));
  const aimed = targets.length > 0 || globbed || names.some((name) => name.toLowerCase().includes(local));
  const reached = !aimed && opaque && opaqueGlobbedFile(globs, locals, seen, project.checkouts) !== null;
  if (!aimed && !reached) return null;
  if (opaque) {
    const how = aimed ? 'names' : 'has a glob that may reach';
    const why = `it ${how} ${local} in a shell command the guard cannot read, so it may set one of the machine's switches there, which only the main session may set`;
    return { match: `may set a switch in ${local}`, reason: projectRuleReason(input, `${why}; to read the file, use Read`, human) };
  }
  const hit = isBash ? named[0] : named.find((each) => changesSwitch(input, targets[0], each));
  if (!hit) return null;
  return { match: `sets ${hit.name} in ${local}`, reason: projectRuleReason(input, `it sets ${hit.name} in ${local}, and ${hit.why}`, human) };
}

// Whether `input` is a Bash call; lib/handoff-guard.mjs asks it too.
export const bashCall = (input) => input.tool_name === 'Bash';

// Whether a Write, Edit, or apply_patch of the local `file` changes the switch. A Write or Edit changes it when its text
// names the key, or when the file it leaves parses to another value than the file on disk, which covers
// `"off"` to `"on"`, a JSON escape, a removed key, and a file left unparsable. A patch changes it when a line it adds or
// removes names the key, or the switch's own `patched` shape: a patch is not applied here, so a value on a line of its own
// that names neither, or a key spelled with a JSON escape, is not seen.
function changesSwitch({ tool_name: tool, tool_input: given }, file, { key, valueIn, patched }) {
  const edit = fileEditOf({ tool_name: tool, tool_input: given });
  if (edit?.shape === 'patch') return patched.test(edit.text);
  const written = edit?.shape === 'write' ? edit.content : edit?.shape === 'edit' ? edit.newText : undefined;
  if (typeof written !== 'string') return false;
  if (written.includes(key)) return true;
  const before = readText(file);
  return switchIn(before, valueIn) !== switchIn(edit.shape === 'write' ? written : editedText(before, given), valueIn);
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

// The most words of a command in a shell the lexer cannot read that the guards resolve as paths and globs. A subagent's
// command with more is refused (opaqueLimitDenial): a guarded file may hide in the rest. What the guards still cannot
// finish in time, the agent gate hook's time budget answers (deadlineDenial).
export const OPAQUE_WORDS = 512;

// The most targets of a Bash call the guards resolve: its paths, its globs, and the texts that may name a file. A
// subagent's call with more is refused (writeLimitDenial), as the guards resolve no more.
export const WRITE_TARGETS = 1024;

// A word as such a shell reads a leading `~`: `~` and `~/x` (`~\x`, its backslash read as a `/`) are in the home folder.
const fromHome = (word) => (word === '~' || word.startsWith('~/') ? path.join(homedir(), word.slice(1)) : word);

// Why the subagent call in `input` may not run because its command, in a shell the lexer cannot read, has more words than
// the guards resolve (OPAQUE_WORDS), or null: { match, reason }. Past that many, a guarded file may hide in the rest.
export function opaqueLimitDenial(input, { names: { human } }) {
  if (typeof input.agent_id !== 'string' || input.agent_id === '') return null;
  const opaque = opaqueShellCommand(input);
  if (opaque === null) return null;
  const count = opaqueWords(opaque).length;
  if (count <= OPAQUE_WORDS) return null;
  const why = `its command has ${count} words, counting each case, and the guards read at most ${OPAQUE_WORDS} in a shell command they cannot parse, so it may change a file only the main session may change`;
  return { match: `more than ${OPAQUE_WORDS} words`, reason: projectRuleReason(input, why, human, 'that the command is longer than the guards read, or run it as shorter commands') };
}

// Why the subagent's Bash call in `input` may not run because it writes more targets than the guards resolve
// (WRITE_TARGETS), or null: { match, reason }. Past that many, a guarded file may hide in the rest.
export function writeLimitDenial(input, { names: { human } }) {
  if (typeof input.agent_id !== 'string' || input.agent_id === '' || !bashCall(input)) return null;
  const { files, names, globs } = writeTargets(input);
  const count = files.length + names.length + globs.length;
  if (count <= WRITE_TARGETS) return null;
  const why = `its command writes ${count} targets, counting each folder a path may be in, and the guards read at most ${WRITE_TARGETS} in one call, so it may change a file only the main session may change`;
  return { match: `more than ${WRITE_TARGETS} write targets`, reason: projectRuleReason(input, why, human, 'that the command writes more files than the guards read, or run it as shorter commands') };
}

// Why the subagent call in `input` may not run because the guards could not finish reading it within the agent gate
// hook's time budget (lib/deadline.mjs), or null for the main session, whose call runs: { match, reason }.
export function deadlineDenial(input, { names: { human } }) {
  if (typeof input.agent_id !== 'string' || input.agent_id === '') return null;
  const why = 'the guards could not finish reading this command in time, so it may change a file only the main session may change';
  return { match: 'past the guards\' time budget', reason: projectRuleReason(input, why, human, 'that the command takes the guards longer than they have, or run it as shorter commands') };
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
      entries(folder).some((name) => pattern.test(name) && sameFile(path.join(folder, name), pair[1])));
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
    return links.some((name) => first.test(name) && linkReaches(realOf(path.join(real, name), seen), rest.slice(1), file));
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
        const [, options, reads] = INTERPRETERS.find(([program]) => program.test(invocation.program)) ?? [];
        if (!options) continue;
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
  const statements = code.split(/[;\n]/u).map((each) => each.trim()).filter(Boolean);
  return statements.length > 0 && statements.every((each) => reads.test(each));
}

// The code the word gives when it is one of `options`, or, for a short one, a cluster of short options that holds it, as
// `-Bc` holds `-c`: the rest of the word, as in `--eval=<code>`, `-c<code>`, or `-Bc<code>`, or null when the code is the
// next word. Undefined when the word gives none.
function givenCode(word, options) {
  if (options.includes(word)) return null;
  const long = options.find((option) => option.startsWith('--') && word.startsWith(`${option}=`));
  if (long) return word.slice(long.length + 1);
  if (!/^-[^-]/u.test(word)) return undefined;
  const { value } = readShortOptions(word, new Set(options.filter((option) => /^-\w$/u.test(option))));
  return value ? value.attached : undefined;
}

function blocked(input, file, verb, human) {
  let why = `it ${verb} ${file}, which sets this project's agent gates, and while gates are set only the main session may change it`;
  if (verb === 'may change') why += '; to read it, use Read, cat, or jq';
  return { match: `${verb} ${file}`, reason: projectRuleReason(input, why, human) };
}
