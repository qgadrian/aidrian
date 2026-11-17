// Bash rule: no agent runs `aidrian shell-init <shell> --install` or `--uninstall`. Both write the Human's shell startup
// file, `~/.zshrc` or `~/.bashrc`, which every new terminal of the Human's runs, so the Human decides and runs them
// (docs/handoff.md#replacing-the-terminal). It holds for every agent call, the main session's too, in any folder. It
// denies each command run as `aidrian`, or as a node script that is the plugin's cli.mjs or bin/aidrian, wherever it runs
// (shell-lex walkCommands): in a substitution, `sh -c`, `eval`, or a heredoc fed to a shell. A shell fed text the rule
// cannot read as commands, such as a pipe into `bash`, is refused when that text names the command with either flag.
// Printing the function, `aidrian shell-init zsh`, runs. A flag behind a variable is a known limit, as for every rule.

import { aidrianArgs, walkCommands } from '../shell-lex.mjs';

export const REASON =
  'Blocked: `aidrian shell-init --install` and `--uninstall` write the Human\'s shell startup file, which only the Human decides to change. ' +
  'Hand the Human the command with the `!` prefix, such as `! aidrian shell-init zsh --install`, which runs it in this session as the Human\'s own; never run it for the Human.';

const FLAG = /^--(?:install|uninstall)$/u;
const UNREAD = /\bshell-init\b[^\n;|&]*--(?:install|uninstall)\b/u;

// The deny reason for `command`, or null.
export function check(command) {
  for (const { invocation, unread } of walkCommands(command, null)) {
    if (unread !== undefined && UNREAD.test(unread)) return REASON;
    const words = aidrianArgs(invocation);
    if (words && words[0]?.text === 'shell-init' && words.slice(1).some((word) => FLAG.test(word.text))) return REASON;
  }
  return null;
}
