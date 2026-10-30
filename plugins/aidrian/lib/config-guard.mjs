// The guard that keeps a gated subagent from lifting its own gates: while `agents` sets any gate, no subagent may change
// a file that sets the project's configuration (project.mjs configFiles). The main session, which has no `agent_id`,
// still can. scripts/hook-agent-gates.mjs asks it before every tool call; docs/config.md#agents gives the rule.
// It reads the targets the way the main-checkout rule does: Edit, Write, NotebookEdit, and apply_patch by the path they
// name, and a Bash command by the paths it writes. Unlike that rule it follows each `cd` and reads `sh -c` strings, and
// when the shell's folder is unknown it judges a relative target by its name alone. An interpreter run with code on its
// command line or its input, such as `python3 -c` or a heredoc, counts as a write to each of the files that code names
// when the code can change a file (WRITE_MARKERS); code that only reads runs. The guard keeps a gate from changing for
// the next session; within a session, the gates a subagent started with hold anyway (lib/gate-snapshot.mjs).

import path from 'node:path';

import { projectRuleReason } from './agent-gates.mjs';
import { isWithin } from './fs.mjs';
import { configFiles } from './project.mjs';
import { bashWrites, canonical, toolTargets } from './rules/main-checkout.mjs';
import { commandLines, inlineShellCommand, lexInputs, readInvocation, readShortOptions, SUBSTITUTION_DEPTH_LIMIT } from './shell-lex.mjs';

const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'apply_patch']);
// Interpreters, the options that hand them code on the command line, a short one also inside a cluster, and whether
// `-i` edits the named files in place.
const INTERPRETERS = [
  [/^python[\d.]*$/u, ['-c'], false],
  [/^(?:node|nodejs|bun)$/u, ['-e', '-p', '--eval', '--print'], false],
  [/^perl[\d.]*$/u, ['-e', '-E'], true],
  [/^ruby[\d.]*$/u, ['-e'], true],
];
// perl's and ruby's short options that take a value, so `-Mstrict` holds no `-i`; `-i` takes the rest of its word.
const VALUE_OPTIONS = new Set(['-e', '-E', '-M', '-m', '-I', '-F', '-x', '-0', '-l', '-C', '-d', '-D', '-r', '-K', '-T', '-W']);
const IN_PLACE = new Set(['-i']);
// Code that can change a file: it writes, appends to, truncates, deletes, moves, copies, or links one, opens one for
// writing (a mode such as 'w', 'a', or 'r+', or perl's '>'), runs a shell or another program, or builds code to run.
// Code with none of these, such as `json.load(open(...))` or `require(...)`, only reads.
const WRITE_MARKERS = [
  /write|appendFile|truncate|unlink|remove|rmtree|rmdir|\brm(?:Sync)?\b|\bdelete\b|rename|os\.replace|\bmove\b|\bmv\b|copy|\bcp(?:Sync)?\b|link/iu,
  /(['"])[rbtU]*[wax+][rbtwax+]*\1|['"]\s*(?:>|\+<)/u,
  /\b(?:system|popen|exec\w*|spawn\w*|subprocess|child_process|eval|__import__|getattr|compile|qx)\b|\bFunction\s*\(|\bimport\s*\(|`|%x/u,
];

// Why the subagent call in `input`, a PreToolUse payload, may not run because it changes one of `project`'s config files,
// or null: { match, reason }. `match` names the file, as in `changes <project folder>/config.json`; `reason` tells the agent.
// It changes one when it writes the file, or a folder that holds it, such as the project folder an `rm -rf` names, unless
// that folder also holds one of the project's checkouts, such as the project root or its worktree, as `cp notes.md .` does.
// `also` lists more files to guard the same way, as absolute paths: the session's gate snapshot (lib/gate-snapshot.mjs).
export function configWriteDenial(input, project, { names: { human } }, { also = [] } = {}) {
  if (typeof input.agent_id !== 'string' || input.agent_id === '') return null;
  const { files: targets, names } = writeTargets(input);
  if (targets.length === 0 && names.length === 0) return null;
  const roots = project.checkouts.map((dir) => canonical(dir));
  const files = [...configFiles(project), ...also].map((file) => canonical(file));
  const shown = (file) => (isWithin(roots[0], file) ? path.relative(roots[0], file) : file);
  for (const target of targets.map((each) => canonical(each))) {
    const holdsRoot = roots.some((root) => isWithin(target, root));
    const file = files.find((each) => each === target || (!holdsRoot && isWithin(target, each)));
    if (file) return blocked(input, shown(file), 'changes', human);
  }
  const named = namedFile(names, files, project);
  return named ? blocked(input, shown(named), 'may change', human) : null;
}

// What the call writes: { files, names }. `files` are absolute paths; `names` are texts that may name a file in a folder
// no path gives: a relative target written after a `cd` to an unknown folder, and code an interpreter runs.
function writeTargets(input) {
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  if (WRITE_TOOLS.has(input.tool_name)) return { files: toolTargets(input).map((target) => path.resolve(cwd, target)), names: [] };
  const command = input.tool_input?.command;
  if (input.tool_name !== 'Bash' || typeof command !== 'string') return { files: [], names: [] };
  const writes = bashWrites(command, cwd, { followCd: true, shells: true });
  return {
    files: writes.flatMap((write) => write.files),
    names: [...writes.filter((write) => write.unsure && !path.isAbsolute(write.text)).map((write) => write.text), ...interpretedCode(command)],
  };
}

// The config file one of `names` names, or null: by its file name, or, for config.json, by the project folder's name.
// A name counts only as a whole path part, so `tsconfig.json` is not `config.json`, and `<project folder>/knowledge`
// names a folder inside the project folder, not the folder itself.
function namedFile(names, files, project) {
  const folder = path.posix.basename(project.dir);
  const config = canonical(path.join(project.root, project.paths.config));
  const patterns = [
    ...files.map((file) => [file, wholePart(path.basename(file), '(?![\\w.-])')]),
    [config, wholePart(folder, '(?![\\w.-]|/[^\\s\'"/])')],
  ];
  return patterns.find(([, pattern]) => names.some((name) => pattern.test(name)))?.[0] ?? null;
}

const wholePart = (name, after) => new RegExp(`(?<![\\w.-])${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}${after}`, 'u');

// The code of every interpreter the command runs that can change a file: the words of one given code on its command
// line, joined, and for one that reads its code from its input, the heredocs and here-strings fed to it, or, when none
// is, the whole command line, which a pipe may feed it from.
function interpretedCode(command) {
  const found = [];
  const read = (text, depth) => {
    for (const line of commandLines(text)) {
      const { segments, inputs } = lexInputs(line);
      for (const [i, segment] of segments.entries()) {
        const invocation = readInvocation(segment);
        const inner = depth < SUBSTITUTION_DEPTH_LIMIT ? inlineShellCommand(invocation) : null;
        if (inner !== null) read(inner, depth + 1);
        const [, options, inPlace] = INTERPRETERS.find(([program]) => program.test(invocation.program)) ?? [];
        if (!options) continue;
        const words = invocation.args.map((token) => token.text);
        let code;
        if (words.some((word) => options.some((option) => givesCode(word, option)))) code = words.join(' ');
        else if ((words.find((word) => !word.startsWith('-') || word === '-') ?? '-') === '-') code = inputs[i].length ? inputs[i].join('\n') : line;
        else continue;
        if (WRITE_MARKERS.some((marker) => marker.test(code)) || (inPlace && words.some(editsInPlace))) found.push(code);
      }
    }
  };
  read(command, 0);
  return found;
}

// Whether the word is a short-option cluster that holds perl's or ruby's `-i`, as `-pi.bak` does and `-Mstrict` does not.
const editsInPlace = (word) => /^-[^-]/u.test(word) && readShortOptions(word, VALUE_OPTIONS, IN_PLACE).options.includes('-i');

// Whether the word is the option, or, for a short one, a cluster of short options that holds it, as `-Bc` holds `-c`.
function givesCode(word, option) {
  if (option.startsWith('--')) return word === option || word.startsWith(`${option}=`);
  return /^-[A-Za-z]+/u.test(word) && !word.startsWith('--') && word.slice(1).includes(option.slice(1));
}

function blocked(input, file, verb, human) {
  const why = `it ${verb} ${file}, which sets this project's agent gates, and while gates are set only the main session may change it`;
  return { match: `${verb} ${file}`, reason: projectRuleReason(input, why, human) };
}
