// `aidrian pr <await-review|checks|disposition>`: the pull request review loop's deterministic steps, each in its own
// module. The config's `pr` group supplies the reviewer, the round limit, and the check policy.

import { loadConfig } from './config.mjs';
import { projectAt } from './project.mjs';

const ACTIONS = {
  'await-review': async (args, config) => (await import('./pr-await-review.mjs')).runAwaitReview(args, config),
  checks: async (args, config) => (await import('./pr-checks.mjs')).runChecks(args, config),
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
      return ACTIONS[action](rest, loadConfig(projectAt(process.cwd())).config);
    },
  },
};
