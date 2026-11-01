// `aidrian pr <await-review|attest|checks|disposition>`: the pull request review loop's deterministic steps, each in its own
// module. The config's `github` group supplies the reviewer, the round limit, and the check policy.

import { commandConfig } from './config.mjs';
import { projectAt } from './project.mjs';
import { usageLines } from './usage.mjs';

// `checks` exits 3 on a config with errors: its 1 is the failing verdict. `disposition` reads no config.
const config = (exitCode) => commandConfig(projectAt(process.cwd()), { exitCode });
const ACTIONS = {
  'await-review': async (args) => {
    const project = projectAt(process.cwd());
    return (await import('./pr-await-review.mjs')).runAwaitReview(args, commandConfig(project, { exitCode: 1 }), project);
  },
  review: async (args) => {
    const project = projectAt(process.cwd());
    return (await import('./review/run.mjs')).runReview(args, commandConfig(project, { exitCode: 1 }), project);
  },
  signoff: async (args) => {
    const project = projectAt(process.cwd());
    const checked = commandConfig(project);
    try {
      return await (await import('./review-gate.mjs')).runSignoff(args, project, checked);
    } catch (error) {
      console.error(`aidrian pr signoff: ${error.message}`);
      return 1;
    }
  },
  checks: async (args) => (await import('./pr-checks.mjs')).runChecks(args, config(3)),
  disposition: async (args) => (await import('./finding-disposition.mjs')).runDisposition(args),
  attest: async (args) => {
    const project = projectAt(process.cwd());
    const checked = commandConfig(project);
    try {
      return await (await import('./review-gate.mjs')).runAttest(args, project, checked);
    } catch (error) {
      console.error(`aidrian pr attest: ${error.message}`);
      return 1;
    }
  },
};

export const commands = {
  pr: {
    usage: 'review [PR] [--with-bot] [--max-rounds N] | signoff PR --flow ID --head SHA | await-review [PR] [--request] [--max-rounds N] [--head SHA] | attest PR --head SHA --reviewer WHO --findings N --fixed N [--note T] | attest PR --pass ID --head SHA --reviewer WHO (--findings N --fixed N [--accepted N] | --findings-file FILE) [--verdicts FILE] | attest PR --check | checks [PR] [-R OWNER/REPO] [--json] | disposition --severity S [--likelihood L --affects A] [--cost C] [--source bot [--round N]] [--vocab]',
    about: 'run the review plan one step at a time, record a flow sign-off, wait for the review bot, record the review the review gate asks for, give a one-line check verdict, or decide what to do with one review finding',
    async run(args) {
      const [action, ...rest] = args;
      if (!Object.hasOwn(ACTIONS, action ?? '')) {
        console.error(usageLines('pr', commands.pr.usage, 'usage: ').join('\n'));
        return 1;
      }
      return ACTIONS[action](rest);
    },
  },
};
