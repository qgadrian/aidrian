// The guard that keeps a gated subagent from lifting its own gates: while `agents` sets any gate, no subagent may change
// a file that sets the project's configuration (project.mjs configFiles). The main session, which has no `agent_id`,
// still can. scripts/hook-agent-gates.mjs asks it before every tool call; docs/config.md#agents gives the rule.
// It reads the targets the way the main-checkout rule does: Edit, Write, NotebookEdit, and apply_patch by the path they
// name, and a Bash command by the paths it writes. Unlike that rule it follows each `cd` and reads `sh -c` strings, and
// when the shell's folder is unknown it judges a relative target by its name alone. An interpreter run with code on its
// command line or its input, such as `python3 -c` or a heredoc, counts as a write to each of the files its words name,
// unless its code is one of the few that only read (READS). The guard keeps a gate from changing for the next session;
// within a session, the gates a subagent started with hold anyway (lib/gate-snapshot.mjs).

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { projectRuleReason } from './agent-gates.mjs';
import { isWithin } from './fs.mjs';
import { configFiles } from './project.mjs';
import { bashWrites, canonical, toolTargets } from './rules/main-checkout.mjs';
import { commandLines, inlineShellCommand, lexInputs, readInvocation, readShortOptions, SUBSTITUTION_DEPTH_LIMIT } from './shell-lex.mjs';

const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'apply_patch']);
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
export function configWriteDenial(input, project, { names: { human } }, { also = [] } = {}) {
  if (typeof input.agent_id !== 'string' || input.agent_id === '') return null;
  const { files: targets, names, globs } = writeTargets(input);
  if (targets.length === 0 && names.length === 0 && globs.length === 0) return null;
  const roots = project.checkouts.map((dir) => canonical(dir));
  const guarded = also.map((file) => canonical(file));
  const files = [...configFiles(project).map((file) => canonical(file)), ...guarded];
  const shown = (file) => (isWithin(roots[0], file) ? path.relative(roots[0], file) : file);
  for (const target of targets.map((each) => canonical(each))) {
    const holdsRoot = roots.some((root) => isWithin(target, root));
    const file = files.find((each) => each === target || sameFile(each, target) || (!holdsRoot && isWithin(target, each)));
    if (file) return blocked(input, shown(file), 'changes', human);
  }
  // A glob reaches a file by the path it is spelled with, which a symlink may place in another folder than its target.
  const spelled = [...configFiles(project), ...also].map((file, i) => [path.resolve(file), files[i]]);
  const named = namedFile(names, files, project, guarded) ?? globbedFile(globs, spelled, targets.length + names.length + globs.length > 1, input.tool_input?.command ?? '');
  return named ? blocked(input, shown(named), 'may change', human) : null;
}

// What the call writes: { files, names }. `files` are absolute paths; `names` are texts that may name a file in a folder
// no path gives: a relative target written after a `cd` to an unknown folder, and code an interpreter runs.
function writeTargets(input) {
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  if (WRITE_TOOLS.has(input.tool_name)) return { files: toolTargets(input).map((target) => path.resolve(cwd, target)), names: [], globs: [] };
  const command = input.tool_input?.command;
  if (input.tool_name !== 'Bash' || typeof command !== 'string') return { files: [], names: [], globs: [] };
  const writes = bashWrites(command, cwd, { followCd: true, shells: true, restores: true, globs: true });
  return {
    files: writes.flatMap((write) => write.files),
    names: [...writes.filter((write) => write.unsure && !write.glob && !path.isAbsolute(write.text)).map((write) => write.text), ...interpretedCode(command)],
    globs: writes.filter((write) => write.glob),
  };
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
  return patterns.find(([, pattern]) => names.some((name) => pattern.test(name)))?.[0] ?? null;
}

// The guarded file a glob target may match, or null: the path part right below the glob's folder, as `*.json` or `.aid*`,
// against the file's own name or the folder that holds it, which a recursive delete removes with it. When the glob's
// folder is known, only files inside it count, so `rm -rf dist/*` changes nothing guarded; when a glob or an unknown `cd`
// leaves the folder unknown, any file's name or folder counts: failing closed.
// `files` pairs each guarded file's spelled path with its canonical one; either may match, and the canonical is returned.
// `others` says the call has another write, a glob or not, which may create a link, in the glob's folder or above it,
// that the glob then follows after the disk was read; `command` is the call's whole command line.
function globbedFile(globs, files, others = true, command = '') {
  // The glob's folder is trusted only in one simple command the lexer reads exactly: a plain file tool, plain words, no
  // `..`. A `cd`, a wrapper (`env -C`), a variable, braces, quotes, or a second command may each move or hide what the
  // glob reaches, and every such shape is judged by name instead: failing closed.
  const simple =
    !others && SIMPLE_COMMAND.test(command) && !command.split(/[ \t/]+/u).includes('..');
  const regex = (glob) =>
    new RegExp(`^${glob.split(/([*?])/u).map((part) => ({ '*': '.*', '?': '.' })[part] ?? part.replace(/[.+^${}()|[\]\\]/gu, '\\$&')).join('')}$`, 'u');
  return files.find((pair) => pair.some((file) => globs.some(({ text, dirs = [], unsure = true }) => {
    const parts = text.replace(/\/+$/u, '').split('/');
    const pattern = regex(parts.pop());
    const head = parts.join('/') || (text.startsWith('/') ? '/' : '.');
    if (unsure || !simple || /[*?[]/u.test(head)) return pattern.test(path.basename(file)) || pattern.test(path.basename(path.dirname(file)));
    const folders = path.isAbsolute(head) ? [head] : dirs.map((dir) => path.resolve(dir, head));
    return folders.some((folder) =>
      [folder, canonical(folder)].some((dir) => isWithin(dir, file) && pattern.test(path.relative(dir, file).split(path.sep)[0])) ||
      // An entry the glob matches may be a symlink to the file from any folder, which a write follows.
      entries(folder).some((name) => pattern.test(name) && (isWithin(canonical(path.join(folder, name)), pair[1]) || sameFile(path.join(folder, name), pair[1]))));
  })))?.[1] ?? null;
}

// Whether two paths are one file on disk: a hard link keeps its own path, so only the device and inode tell.
function sameFile(a, b) {
  try {
    const [x, y] = [statSync(a), statSync(b)];
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}

// Spaces and tabs only: a newline separates commands, as `;` does.
const SIMPLE_COMMAND = /^[ \t]*(?:rm|cp|mv|touch|truncate|tee|echo|printf|cat|mkdir)(?:[ \t]+[\w./*?=>-]+)*[ \t]*$/u;

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
