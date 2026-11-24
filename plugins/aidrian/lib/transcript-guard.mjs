// The host transcripts a project run reads custody from: a host records in the old session's transcript that it went on
// as another session (`capabilities.continuedIn`), and under the team's projectRun.fullAuto that row alone lets the session
// it names take the run's custody with no person (lib/project-run-gate.mjs resumeRun). No session needs to write a
// transcript, so until the project's run records its end the agent gate hook refuses every session and subagent
// (scripts/hook-agent-gates.mjs) one rule, failing closed: a write the shared reader reports (config-guard.mjs
// writeTargets), a `mkdir` among them, or any operand of `cp`, `mv`, `ln`, `rm`, `rmdir`, or `unlink`, in any place, is
// refused when it lies under a host's transcript folder outside a project folder's `memory` folder, where a host keeps
// its memory, or is the transcript folder or any folder above it. A glob counts by its literal prefix, the parts before
// its first `*`, `?`, or `[`.
// Accepted residuals: a script that writes the file, which the hooks never see, as for a forged typed turn; a link
// already on disk that a write passes through, since the guard is for cooperating agents (docs/hooks.md); an operand
// built from a variable, or of a command in a folder the shell may have left; and, failing closed, a `cp`, `mv`, `ln`,
// or `mkdir` of or into the home folder or any folder above the host's config folder, and any glob from there, are
// refused during a run.

import { userInfo } from 'node:os';
import path from 'node:path';

import { projectRuleReason } from './agent-gates.mjs';
import { bashCall, writeTargets } from './config-guard.mjs';
import { foldCase, isWithin } from './fs.mjs';
import { GLOB_WORD, globStarts } from './glob-links.mjs';
import { globPaths } from './handoff-guard.mjs';
import { transcriptFolders } from './hosts/index.mjs';
import { canonical } from './rules/main-checkout.mjs';
import { expandHome } from './rules/main-checkout/writers.mjs';
import { walkCommands } from './shell-lex.mjs';

const real = (file) => foldCase(canonical(file));
// A transcript as a text from a folder no path gives spells it: `projects/<folder>/<session>.jsonl`.
const SPELLED = /(?:^|[\\/])projects[\\/][^\\/\s'"]+[\\/][^\\/\s'"]+\.jsonl(?![\w.-])/iu;
// The programs whose every operand counts, wherever it stands.
const MOVERS = new Set(['cp', 'mv', 'ln', 'rm', 'rmdir', 'unlink']);
// A command that names none of them is not walked: most calls name none.
const NAMES_ONE = /(?<![\w.-])(?:cp|mv|ln|rm|rmdir|unlink)(?![\w.-])/u;

// Whether a write to the real path `target` may change a transcript of the real transcript folder `folder`: it is the
// folder or a folder above it, or lies under the folder outside a project folder's `memory` folder.
function reaches(folder, target) {
  if (isWithin(target, folder)) return true;
  if (!isWithin(folder, target)) return false;
  const parts = path.relative(folder, target).split(path.sep).filter(Boolean);
  return !(parts.length >= 2 && parts[1] === foldCase('memory'));
}

// Every operand word of `args`: each plain word, before `--` or after it, and the value of a `--name=value` option.
const operandWords = (args) => {
  let ended = false;
  return args.flatMap((token) => {
    if (!ended && token.text === '--') {
      ended = true;
      return [];
    }
    if (ended || !token.text.startsWith('-')) return [token];
    const at = token.text.indexOf('=');
    return token.text.startsWith('--') && at > 0 ? [{ ...token, text: token.text.slice(at + 1), literal: true }] : [];
  });
};

// The real paths of `tokens` from `folder`: a plain word by its path, a glob by its literal prefix; one built from a
// variable is left out.
const tokenPaths = (tokens, folder) => tokens.flatMap((token) => {
  const text = expandHome(token);
  if (text === '' || (token.dynamic && /[$`]/u.test(text))) return [];
  if (!GLOB_WORD.test(text)) return [real(path.resolve(folder, text))];
  return globStarts({ text, dirs: [folder] }).map(({ start }) => real(start));
});

// The real paths of every operand of a MOVERS command a Bash call runs, from the folder each runs in; a command in a
// folder the walk cannot know is left out.
function moverOperands(input) {
  if (!bashCall(input) || typeof input.tool_input?.command !== 'string' || !NAMES_ONE.test(input.tool_input.command)) return [];
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  return walkCommands(input.tool_input.command, cwd).filter(({ folder }) => folder !== null)
    .flatMap(({ invocation, folder }) => (MOVERS.has(invocation.program) ? tokenPaths(operandWords(invocation.args), folder) : []));
}

// Why the call in `input` may not run because it writes a host's session transcript while `runSession()` says the
// call's project has a project run whose ledger records no end (project-run-guard.mjs projectRunActive with
// `untilEnd`, the runs whose custody may still move), or null: { match, reason }. It
// holds for every session and subagent, attended or not, and asks `runSession()` only for a call that reaches one.
// `folders` are the host's transcript folders (hosts/index.mjs transcriptFolders), under this user's home and where the
// hook's environment moves a host's config folder.
export function transcriptWriteDenial(input, { names: { human } }, { runSession = () => false, folders = transcriptFolders(userInfo().homedir) } = {}) {
  const { files, names, globs } = writeTargets(input);
  // rmdir is no writer the shared reader lists, so its operands come from the walk alone.
  const operands = moverOperands(input);
  if (files.length === 0 && names.length === 0 && globs.length === 0 && operands.length === 0) return null;
  const guarded = folders.map(real);
  const prefixes = globs.filter((glob) => !glob.unsure).flatMap(globPaths).map(({ prefix }) => prefix);
  const targets = [...files.map(real), ...prefixes, ...operands];
  const hit = names.some((text) => SPELLED.test(text))
    || globs.some((glob) => (glob.unsure || glob.opaque) && SPELLED.test(glob.text))
    || guarded.some((folder) => targets.some((target) => reaches(folder, target)));
  if (!hit || !runSession()) return null;
  const why = 'it may change a host\'s session transcript, which a project run reads its driver\'s continuation from, and no session or subagent writes one while a project run is under way';
  return { match: 'may change a host\'s session transcript', reason: projectRuleReason(input, why, human) };
}
