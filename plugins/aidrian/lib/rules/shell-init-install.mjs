// Bash rule: no agent runs `aidrian shell-init <shell> --install` or `--uninstall`. Both write the Human's shell startup
// file, `~/.zshrc` or `~/.bashrc`, which every new terminal of the Human's runs, so the Human decides and runs them
// (docs/handoff.md#replacing-the-terminal). It holds for every agent call, the main session's too, in any folder. It
// denies each command run as `aidrian`, or as a node script that is the plugin's cli.mjs or bin/aidrian, wherever it runs
// (shell-lex walkCommands): in a substitution, `sh -c`, `eval`, or a heredoc fed to a shell. A shell fed text the rule
// cannot read as commands, such as a pipe into `bash`, is refused when that text names the command with either flag.
// So is a program that runs its arguments, or a string it is given, as a command (CARRIERS): `xargs`, `find -exec`,
// `watch`, `script`, `parallel`, and a shell the walk does not read, such as `fish -c`. Printing the function,
// `aidrian shell-init zsh`, runs, and so does a program that only prints or searches the words, such as `echo` or
// `grep`. Out of sight, as for every rule: a flag behind a variable, a script file or an interpreter (`python -c`,
// `node -e`) that runs the command, and a shell alias or function that hides it.

import { aidrianArgs, inlineShellCommand, walkCommands } from '../shell-lex.mjs';

export const REASON =
  'Blocked: `aidrian shell-init --install` and `--uninstall` write the Human\'s shell startup file, which only the Human decides to change. ' +
  'Hand the Human the command with the `!` prefix, such as `! aidrian shell-init zsh --install`, which runs it in this session as the Human\'s own; never run it for the Human.';

const FLAG = /^--(?:install|uninstall)$/u;
const UNREAD = /\bshell-init\b[^\n;|&]*--(?:install|uninstall)\b/u;
// The shells' own names, each a program that runs a string it is given as commands. The one list of them: the wrap
// refusal of lib/shell-init.mjs refuses each as a launcher name too.
export const SHELL_NAMES = Object.freeze(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'fish', 'csh', 'tcsh', 'yash', 'nu', 'elvish', 'xonsh', 'pwsh', 'powershell']);
// Whether walkCommands reads the `-c` string of the shell `name` as commands (shell-lex inlineShellCommand).
const walkReads = (name) => inlineShellCommand({ program: name, args: [{ text: '-c', dynamic: false }, { text: ':', dynamic: false }] }) !== null;
// The programs that run their arguments, or a string among them, as a command. A shell the walk reads, such as `sh -c`,
// is not one: walkCommands reads its body as commands.
const CARRIERS = new Set(['xargs', 'find', 'watch', 'script', 'parallel', ...SHELL_NAMES.filter((name) => !walkReads(name))]);
// An aidrian command run by its name, any path to it, or the plugin's cli.mjs, then `shell-init` and a flag.
const COMMAND_TEXT = /(?:^|[\s;&|(`'"])(?:\S*\/)?(?:aidrian|cli\.mjs)\s[^\n;|&]*\bshell-init\b[^\n;|&]*--(?:install|uninstall)\b/u;
const AIDRIAN_WORD = /(?:^|\/)(?:aidrian|cli\.mjs)$/u;

// The deny reason for `command`, or null.
export function check(command) {
  for (const { invocation, unread } of walkCommands(command, null)) {
    if (unread !== undefined && UNREAD.test(unread)) return REASON;
    const words = aidrianArgs(invocation);
    if (words && words[0]?.text === 'shell-init' && words.slice(1).some((word) => FLAG.test(word.text))) return REASON;
    if (CARRIERS.has(invocation.program) && carries(invocation.args.map((token) => token.text))) return REASON;
  }
  return null;
}

// Whether the words a carrier runs hold the command: as words of their own, `aidrian`, then `shell-init`, then a flag,
// or as one string, such as `watch 'aidrian shell-init zsh --install'`.
function carries(words) {
  const start = words.findIndex((word) => AIDRIAN_WORD.test(word));
  const init = start === -1 ? -1 : words.indexOf('shell-init', start + 1);
  if (init !== -1 && words.slice(init + 1).some((word) => FLAG.test(word))) return true;
  return words.some((word) => COMMAND_TEXT.test(word));
}
