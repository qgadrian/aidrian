// The host transcripts a project run reads custody from: a host records in the old session's transcript that it went on
// as another session (`capabilities.continuedIn`), and under the team's projectRun.fullAuto that row alone lets the session
// it names take the run's custody with no person (lib/project-run-gate.mjs resumeRun). No session needs to write a
// transcript, so until the project's run records its end the agent gate hook refuses every session and subagent a write
// under a host's transcript folder (scripts/hook-agent-gates.mjs), but in a project folder's `memory` folder, where a
// host keeps its memory. A literal path and a glob's literal prefix count alike. A folder above it, the folder itself
// included, counts only when the call removes, moves away, or replaces it whole, as `rm -rf`, `rmdir`, a source of `mv`,
// or the `-T` destination of `mv`, `cp`, or `ln` does: a write into a folder above it is judged by its own path, and a
// copy, move, or link into a folder by each child it makes there, `<destination>/<source's name>`, too. An operand with
// `*`, `?`, or `[` is a glob, judged by its literal prefix.
// Accepted residuals: a script that writes the file, which the hooks never see, as for a forged typed turn; a link
// already on disk that a write passes through, since the guard is for cooperating agents (docs/hooks.md); an operand of
// those commands built from a variable, or in a folder the shell may have left; and a glob such a command takes whose
// prefix lies above the transcript folder, such as one beside a host's config folder, is refused though it may reach none.

import { userInfo } from 'node:os';
import path from 'node:path';

import { projectRuleReason } from './agent-gates.mjs';
import { bashCall, writeTargets } from './config-guard.mjs';
import { foldCase, globParts, isWithin } from './fs.mjs';
import { GLOB_WORD, globStarts } from './glob-links.mjs';
import { globPaths } from './handoff-guard.mjs';
import { transcriptFolders } from './hosts/index.mjs';
import { canonical } from './rules/main-checkout.mjs';
import { expandHome, written } from './rules/main-checkout/writers.mjs';
import { walkCommands } from './shell-lex.mjs';

const real = (file) => foldCase(canonical(file));
const FOLD_FLAG = foldCase('A') === 'a' ? 'i' : '';
// A transcript as a text from a folder no path gives spells it: `projects/<folder>/<session>.jsonl`.
const SPELLED = /(?:^|[\\/])projects[\\/][^\\/\s'"]+[\\/][^\\/\s'"]+\.jsonl(?![\w.-])/iu;
// The programs that remove each operand whole, with the value options none of them takes.
const REMOVERS = new Set(['rm', 'rmdir', 'unlink']);
// The programs whose destination `-T` (`--no-target-directory`) replaces whole, rather than writing into it.
const REPLACERS = new Set(['mv', 'cp', 'ln']);
// A command that names none of them is not walked: most calls name none.
const NAMES_ONE = /(?<![\w.-])(?:rm|rmdir|unlink|mv|cp|ln)(?![\w.-])/u;
const NO_TARGET = (text) => text === '--no-target-directory' || /^-[A-Za-z]*T[A-Za-z]*$/u.test(text);

// Whether the real path `target` lies under the real transcript folder `folder`, the folder itself included, and outside
// the `memory` folder of a project folder in it.
function underTranscripts(folder, target) {
  if (!isWithin(folder, target)) return false;
  const parts = path.relative(folder, target).split(path.sep).filter(Boolean);
  return !(parts.length >= 2 && parts[1] === foldCase('memory'));
}

// The operands of `invocation` it removes, moves away, or replaces whole: every operand of a remover, every source of
// `mv`, and the destination of `mv`, `cp`, or `ln` under `-T`. Each is a token as the lexer gives it.
function wholeOperands({ program, args }) {
  if (REMOVERS.has(program)) return written(program, args, new Set());
  if (!REPLACERS.has(program)) return [];
  const operands = written(program, args);
  const replaced = args.some(({ text }) => NO_TARGET(text));
  if (program === 'mv') return replaced ? operands : operands.slice(0, -1);
  return replaced ? operands.slice(-1) : [];
}

// The implicit children a `cp`, `mv`, or `ln` with no `-T` writes into its destination, a plain path: for each source,
// `<destination>/<source's last part>`, as { path } for a plain name, or { dir, pattern } for one with a wildcard.
// A source built from a variable is left out.
function childOperands({ program, args }, folder) {
  if (!REPLACERS.has(program) || args.some(({ text }) => NO_TARGET(text))) return [];
  // mv's reading of the operands, which cp and ln share: the sources, then the destination or the -t folder.
  const operands = written('mv', args);
  const destination = operands.at(-1);
  if (operands.length < 2 || destination.dynamic || GLOB_WORD.test(destination.text)) return [];
  const dir = real(path.resolve(folder, expandHome(destination)));
  return operands.slice(0, -1).flatMap((source) => {
    const name = path.basename(expandHome(source));
    if (/[$`]/u.test(name) || name === '') return [];
    return GLOB_WORD.test(name) ? [{ dir, pattern: name }] : [{ path: real(path.join(dir, name)) }];
  });
}

// What a Bash call writes that writeTargets does not judge: { whole, children }. `whole` are the real paths, or a glob's
// literal prefix, the parts before its first `*`, `?`, or `[`, that it removes, moves away, or replaces whole
// (wholeOperands); `children` the implicit children of a copy, move, or link into a folder (childOperands). An operand
// built from a variable, or of a command in a folder the walk cannot know, is left out.
function wholePaths(input) {
  const none = { whole: [], children: [] };
  if (!bashCall(input) || typeof input.tool_input?.command !== 'string' || !NAMES_ONE.test(input.tool_input.command)) return none;
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const read = walkCommands(input.tool_input.command, cwd).filter(({ folder }) => folder !== null);
  const whole = read.flatMap(({ invocation, folder }) => wholeOperands(invocation).flatMap((token) => {
    const text = expandHome(token);
    if (token.dynamic && /[$`]/u.test(text)) return [];
    if (!GLOB_WORD.test(text)) return [real(path.resolve(folder, text))];
    return globStarts({ text, dirs: [folder] }).map(({ start }) => real(start));
  }));
  return { whole, children: read.flatMap(({ invocation, folder }) => childOperands(invocation, folder)) };
}

// Whether the implicit child `child` (childOperands) may change a transcript of `folder`: a plain one under it as
// underTranscripts reads it, or the folder or a folder above it; one whose name has a wildcard when its destination is
// under the folder, or above it and the name may match the destination's next part toward the folder.
function childReaches(folder, child) {
  if (child.path) return underTranscripts(folder, child.path) || isWithin(child.path, folder);
  if (underTranscripts(folder, child.dir)) return true;
  if (!isWithin(child.dir, folder)) return false;
  const next = path.relative(child.dir, folder).split(path.sep)[0];
  return globParts(child.pattern, [], FOLD_FLAG).pattern.test(next);
}

// Why the call in `input` may not run because it writes a host's session transcript while `runSession()` says the
// call's project has a project run whose ledger records no end (project-run-guard.mjs projectRunActive with
// `untilEnd`, the runs whose custody may still move), or null: { match, reason }. It
// holds for every session and subagent, attended or not, and asks `runSession()` only for a call that reaches one.
// `folders` are the host's transcript folders (hosts/index.mjs transcriptFolders), under this user's home and where the
// hook's environment moves a host's config folder.
export function transcriptWriteDenial(input, { names: { human } }, { runSession = () => false, folders = transcriptFolders(userInfo().homedir) } = {}) {
  const { files, names, globs } = writeTargets(input);
  // rmdir is no writer the shared reader lists, so its operands come from wholePaths alone.
  const { whole, children } = wholePaths(input);
  if (files.length === 0 && names.length === 0 && globs.length === 0 && whole.length === 0) return null;
  const guarded = folders.map(real);
  const placed = files.map(real);
  const prefixes = globs.filter((glob) => !glob.unsure).flatMap(globPaths).map(({ prefix }) => prefix);
  const hit = names.some((text) => SPELLED.test(text))
    || globs.some((glob) => (glob.unsure || glob.opaque) && SPELLED.test(glob.text))
    || guarded.some((folder) => [...placed, ...prefixes].some((target) => underTranscripts(folder, target))
      || whole.some((target) => isWithin(target, folder)) || children.some((child) => childReaches(folder, child)));
  if (!hit || !runSession()) return null;
  const why = 'it may change a host\'s session transcript, which a project run reads its driver\'s continuation from, and no session or subagent writes one while a project run is under way';
  return { match: 'may change a host\'s session transcript', reason: projectRuleReason(input, why, human) };
}
