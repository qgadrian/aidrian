// Bash rule: no skipping git hooks. Denies a hook-running git command (commit, push, merge) that carries `--no-verify`
// or a prefix git takes for it (`--no-veri`), `-n` on commit (alone or in a bundle such as `-an`), a core.hooksPath
// override (`-c`, `--config-env`, or GIT_CONFIG_PARAMETERS / GIT_CONFIG_KEY_<n> in its environment), or a
// `HUSKY=0|false|` assignment; and a `git config` that writes or unsets core.hooksPath. Reading the setting stays allowed.
// There is no override: a project that wants an exception changes its hooks, not this rule.

import { isLongOption, lexCommand, readGit } from '../shell-lex.mjs';

// The subcommands that run a hook. `-n` means --no-verify on commit only: it is --dry-run on push and --no-stat on merge.
const HOOK_RUNNING = new Set(['commit', 'push', 'merge']);
// `git commit` options whose value is the next token, so `-m "-n"` is a message, not a flag.
const COMMIT_VALUE_SHORTS = new Set(['-m', '-c', '-C', '-F', '-t']);
const HUSKY_OFF = new Set(['0', 'false', '']);
// `git config` options whose value is the next token, and the options that write or remove the name after them, each
// with the shortest prefix git takes for it.
const CONFIG_VALUE_OPTIONS = new Set(['-f', '--file', '--blob', '-t', '--type', '--value', '--comment', '--default', '--url']);
const CONFIG_WRITE_OPTIONS = [['--add', '--ad'], ['--replace-all', '--rep'], ['--unset-all', '--unset']];

export const REASON =
  'Blocked: this skips a git hook. A failing hook is a verdict, not a flake: fix the cause, and if the failure is unrelated ' +
  'to your change, report it and wait for instructions. There is no agent-side override for this rule.';

// The deny reason for `command`, or null.
export function check(command) {
  for (const segment of lexCommand(command)) {
    const git = readGit(segment);
    if (git?.subcommand === 'config' && writesHooksPath(git.rest)) return REASON;
    if (!git || !HOOK_RUNNING.has(git.subcommand)) continue;
    if (skipsHooks(git.rest, git.subcommand) || overridesHooksPath(git.globals) || disablesHusky(segment) || configuresByEnv(segment)) {
      return REASON;
    }
  }
  return null;
}

// Git config section and key names are case-insensitive: `CORE.HooksPath` is core.hooksPath.
const isHooksPath = (name) => name.toLowerCase() === 'core.hookspath';

function skipsHooks(rest, subcommand) {
  for (let i = 0; i < rest.length; i += 1) {
    const { text, dynamic } = rest[i];
    if (dynamic) continue;
    if (text === '--') return false;
    // Commit and push take `--no-veri`; merge rejects it as ambiguous with `--no-verify-signatures`, so a deny costs nothing.
    if (isLongOption(text, '--no-verify', '--no-veri')) return true;
    if (subcommand !== 'commit') continue;
    if (COMMIT_VALUE_SHORTS.has(text)) i += 1;
    else if (/^-[A-Za-z]+$/u.test(text) && text.includes('n')) return true;
  }
  return false;
}

// `-c name=value`, `--config-env name=VAR`, or `--config-env=name=VAR` naming core.hooksPath; readGit keeps each value
// with its option. Only the name is read, so a dynamic value denies too.
function overridesHooksPath(globals) {
  return globals.some(({ text }) => {
    const pair = text.replace(/^(?:-c|--config-env=)/u, '');
    return pair.includes('=') && isHooksPath(pair.slice(0, pair.indexOf('=')));
  });
}

// Read from the raw segment: readInvocation drops leading assignments.
function disablesHusky(segment) {
  return segment.some(({ text, dynamic, operator }) => !dynamic && !operator && text.startsWith('HUSKY=') && HUSKY_OFF.has(text.slice(6)));
}

// Config handed to git through its environment, as a prefix assignment or through `env`: GIT_CONFIG_PARAMETERS carries
// `-c` pairs, so any value denies; GIT_CONFIG_KEY_<n> names one key.
function configuresByEnv(segment) {
  return segment.some(({ text, operator }) => {
    if (operator) return false;
    if (text.startsWith('GIT_CONFIG_PARAMETERS=')) return true;
    const key = /^GIT_CONFIG_KEY_\d+=/u.exec(text);
    return key !== null && isHooksPath(text.slice(key[0].length));
  });
}

// Whether `git config` writes or unsets core.hooksPath: the `set` and `unset` subcommands, a write option such as
// `--unset`, or the classic `git config <name> <value>`. A read (`git config core.hooksPath`, `--get`, `get`) is allowed.
function writesHooksPath(rest) {
  const words = [];
  let writes = false;
  let reads = false;
  for (let i = 0; i < rest.length; i += 1) {
    const { text } = rest[i];
    if (!text.startsWith('-') || text === '-') words.push(text);
    else if (CONFIG_VALUE_OPTIONS.has(text)) i += 1;
    else if (CONFIG_WRITE_OPTIONS.some(([option, shortest]) => isLongOption(text, option, shortest))) writes = true;
    else if (text.startsWith('--get')) reads = true;
  }
  const name = words.findIndex(isHooksPath);
  if (name === -1) return false;
  if (words[0] === 'set' || words[0] === 'unset') return true;
  return writes || (!reads && words[0] !== 'get' && name < words.length - 1);
}
