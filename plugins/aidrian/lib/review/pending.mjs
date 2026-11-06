// The reviews a pull request still owes, kept in this machine's review record (lib/review/state.mjs) for the merge guard
// (lib/rules/github/merge-review.mjs). `aidrian pr request <PR>` records the bot review the Human asked for, the moment
// they ask, so a later instruction cannot drop it; `--kind review` records a gate review being dispatched.
// A request is owed until the bot answers it: `aidrian pr await-review` marks it sent when it posts it and answered when
// the bot's answer arrives, as `aidrian pr review --with-bot` does. `aidrian pr attest` and a finished review step
// answer a gate review.

import { ghJson } from '../forges/github-cli.mjs';
import { runGit } from '../git.mjs';
import { originRepo, prNumber, repoName } from '../review-gate.mjs';
import { isAncestor } from './diff.mjs';
import { answerPending, emptyState, entryId, ofRepo, readLocalState, writeLocalState } from './state.mjs';

const SHA = /^[0-9a-f]{7,40}$/iu;
const KINDS = ['request', 'review'];

// Records one entry owed on `pr` of `repo`. Returns the entry.
export function recordPending(project, { pr, repo, kind, head, by }) {
  const entry = { id: entryId(), kind, head, at: new Date().toISOString(), by, ...(repoName(repo) ? { repo: repoName(repo) } : {}) };
  const state = readLocalState(project, pr) ?? emptyState(pr, repoName(repo));
  state.pending = [...state.pending, entry];
  writeLocalState(project, state);
  return entry;
}

// Marks the requests on `pr` of `repo` (null: any) not yet sent as sent, for `head`. Returns how many it marked. A sent
// request stays owed until the bot answers it.
export function markRequestsSent(project, pr, head, repo = null) {
  const state = readLocalState(project, pr);
  const open = (state?.pending ?? []).filter((each) => each.kind === 'request' && !each.sent && !each.answered && ofRepo(state, each, repoName(repo)));
  if (!open.length) return 0;
  const at = new Date().toISOString();
  for (const entry of open) entry.sent = { at, head };
  writeLocalState(project, state);
  return open.length;
}

// Marks the entries of `kind` owed on `pr` of `repo` that an answer for `head` answers (answerPending), reading
// ancestry in this checkout: the bot's answer (`request`), or the gate review's recorded result (`review`). Returns 1
// when it marked any.
export function answerOwed(project, pr, kind, { head, by, repo = null, isAncestor: ancestor = (a, b) => isAncestor(project.root, a, b) }) {
  const state = readLocalState(project, pr);
  if (!state || !answerPending(state, kind, { head, by, repo: repoName(repo), isAncestor: ancestor })) return 0;
  writeLocalState(project, state);
  return 1;
}

// `aidrian pr request <PR> [--kind request|review] [--head SHA] [--repo OWNER/NAME]`. gh reads what is not given: the
// head and the pull request's repository, gh's default one, which in a fork checkout is the upstream, not origin.
// Exit 0 recorded, 1 a usage error or a head it cannot read.
export function runRequest(args, project, { viewPr = (pr) => ghJson(['pr', 'view', String(pr), '--json', 'headRefOid,url'], { cwd: project.root }) } = {}) {
  const [ref, ...rest] = args;
  const pr = prNumber(ref ?? '');
  if (pr === null) throw new Error('request needs a pull request number');
  const flags = { kind: 'request', head: null, repo: null };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (!['--kind', '--head', '--repo'].includes(flag)) throw new Error(`unknown argument: ${flag}`);
    const value = rest[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    flags[flag.slice(2)] = value;
  }
  if (!KINDS.includes(flags.kind)) throw new Error(`--kind must be one of ${KINDS.join(', ')}`);
  if (flags.head !== null && !SHA.test(flags.head)) throw new Error(`--head ${flags.head} is not a commit`);
  if (flags.repo !== null && !repoName(flags.repo)) throw new Error(`--repo ${flags.repo} is not OWNER/NAME`);
  let view = null;
  if (flags.head === null || flags.repo === null) {
    try {
      view = viewPr(pr);
    } catch (error) {
      if (flags.head === null) throw error;
    }
  }
  const head = flags.head ?? view?.headRefOid;
  if (typeof head !== 'string' || !SHA.test(head)) throw new Error(`cannot read the head of pull request #${pr}: pass --head <sha>`);
  // One repository per pull request number, for every kind: the one whose head gh read, as attest resolves it.
  const repo = repoName(flags.repo) ?? repoName(view?.url) ?? originRepo(project);
  const by = runGit(['config', 'user.name'], project.root).stdout?.trim() || 'unknown';
  recordPending(project, { pr, repo, kind: flags.kind, head, by });
  console.log(flags.kind === 'request'
    ? `recorded the bot review the Human asked for on ${repo ?? 'this repository'}#${pr} at ${head.slice(0, 7)}. A merge waits until \`aidrian pr await-review ${pr} --request\` sends it and the bot answers.`
    : `recorded the gate review of ${repo ?? 'this repository'}#${pr} at ${head.slice(0, 7)} as dispatched. A merge waits until \`aidrian pr attest ${pr}\` records its result.`);
  return 0;
}
