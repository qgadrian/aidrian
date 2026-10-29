// `aidrian pr <await-review|checks|disposition>`: the pull request review loop's deterministic steps, each in its own
// module. The config's `github` group supplies the reviewer, the round limit, and the check policy.

import { commandConfig } from './config.mjs';
import { projectAt } from './project.mjs';

// `checks` exits 3 on a config with errors: its 1 is the failing verdict. `disposition` reads no config.
const config = (exitCode) => commandConfig(projectAt(process.cwd()), { exitCode });
const ACTIONS = {
  'await-review': async (args) => {
    const project = projectAt(process.cwd());
    return (await import('./pr-await-review.mjs')).runAwaitReview(args, commandConfig(project, { exitCode: 1 }), project);
  },
  checks: async (args) => (await import('./pr-checks.mjs')).runChecks(args, config(3)),
  disposition: async (args) => (await import('./finding-disposition.mjs')).runDisposition(args),
};

export const commands = {
  pr: {
    usage: 'await-review [PR] [--request] [--max-rounds N] | checks [PR] [--json] | disposition --severity S [--likelihood L --affects A] [--vocab]',
    about: 'wait for the review bot, give a one-line check verdict, or decide what to do with one review finding',
    async run(args) {
      const [action, ...rest] = args;
      if (!Object.hasOwn(ACTIONS, action ?? '')) {
        console.error(`usage: aidrian pr ${commands.pr.usage}`);
        return 1;
      }
      return ACTIONS[action](rest);
    },
  },
};
