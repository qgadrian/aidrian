// `aidrian pr <review|signoff|extend|await-review|request|attest|checks|auto-merge|resolve|disposition|product-feedback>`: the pull request review loop's deterministic steps, each in its own
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
  extend: async (args) => {
    const project = projectAt(process.cwd());
    const checked = commandConfig(project);
    try {
      return await (await import('./review/extension.mjs')).runExtend(args, project, checked);
    } catch (error) {
      console.error(`aidrian pr extend: ${error.message}`);
      return 1;
    }
  },
  checks: async (args) => (await import('./pr-checks.mjs')).runChecks(args, config(3)),
  // `auto-merge` reads the team keys from GitHub, and loads the working copy's config only to compare its check lists,
  // so a broken one is its off reason, never an error here.
  'auto-merge': async (args) => (await import('./pr-auto-merge.mjs')).runAutoMerge(args, projectAt(process.cwd())),
  // Like `checks`, it exits 3 on a config with errors.
  resolve: async (args) => (await import('./pr-resolve.mjs')).runResolve(args, config(3)),
  disposition: async (args) => (await import('./finding-disposition.mjs')).runDisposition(args),
  // Reads the team keys from GitHub, so a working copy config with errors is no error of `status`; the actions that write
  // take the state folder from `commandConfig`, and exit 3.
  'product-feedback': async (args) => (await import('./pr-product-feedback.mjs')).runProductFeedback(args, projectAt(process.cwd())),
  request: async (args) => {
    const project = projectAt(process.cwd());
    try {
      return (await import('./review/pending.mjs')).runRequest(args, project);
    } catch (error) {
      console.error(`aidrian pr request: ${error.message}`);
      return 1;
    }
  },
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
    usage: 'review [PR] [--with-bot] [--max-rounds N] [--quota-fallback agent:NAME|human] | signoff PR (--flow ID [--overrule INVARIANT --reason TEXT] | --stage NAME) --head SHA [--repo OWNER/NAME] [--check] | signoff PR --flow ID --accept INVARIANT --evidence URL --reason TEXT --head SHA [--repo OWNER/NAME] [--check] | extend PR (--verdict extend|stop --reason TEXT [--head SHA] | --human approve|deny) | await-review [PR] [--request] [--max-rounds N] [--head SHA] | request PR [--kind request|review] [--head SHA] [--repo OWNER/NAME] | attest PR --head SHA --reviewer WHO --findings N --fixed N [--note T] [--repo OWNER/NAME] | attest PR --pass ID --head SHA --reviewer WHO (--findings N --fixed N [--accepted N] | --findings-file FILE) [--verdicts FILE|-] [--repo OWNER/NAME] | attest PR --check | checks [PR] [-R OWNER/REPO] [--json] | auto-merge [PR] [--json] | resolve URL|NUMBER | disposition --severity S [--likelihood L --affects A] [--cost C] [--source bot [--round N]] [--vocab] | product-feedback status PR [--json] | product-feedback record PR [--report FILE] [--items FILE] [--none-found --read-by product-manager] | product-feedback answer PR ITEM DECISION [--by WHO] [--reason T] [--issue K] [--url U] [--doc D] | product-feedback recheck PR ITEM confirmed|reopened [--note T] | product-feedback post PR --body-file FILE | product-feedback items PR [--json] | product-feedback diff PR',
    about: 'run the review plan one step at a time, record a flow or stage sign-off, record the verdict on one more round past the cap, wait for the review bot, record a review the Human asked for or a gate review dispatched, record the review the review gate asks for, give a one-line check verdict, say whether a session may merge a pull request unasked, check a pull request link and print what a persona audit needs of it, decide what to do with one review finding, or record a pull request\'s product feedback and say when it is owed',
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
