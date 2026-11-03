// The reviews a pull request still owes, kept in this machine's review record (lib/review/state.mjs) for the merge guard
// (lib/rules/github/merge-review.mjs). `aidrian pr request <PR>` records the bot review the Human asked for, the moment
// they ask, so a later instruction cannot drop it; `--kind review` records a gate review being dispatched.
// A request is owed until the bot answers it: `aidrian pr await-review` marks it sent when it posts it and answered when
// the bot's answer arrives, as `aidrian pr review --with-bot` does. `aidrian pr attest` and a finished review step
// answer a gate review.

import { ghJson } from '../gh.mjs';
import { runGit } from '../git.mjs';
import { originRepo, prNumber, repoName } from '../review-gate.mjs';
import { isAncestor } from './diff.mjs';
import { answerPending, emptyState, newRunId, readLocalState, writeLocalState } from './state.mjs';

const SHA = /^[0-9a-f]{7,40}$/iu;
const KINDS = ['request', 'review'];

// Records one entry owed on `pr`. Returns the entry.
export function recordPending(project, { pr, repo, kind, head, by }) {
  const state = readLocalState(project, pr) ?? emptyState(pr, repo);
  const entry = { id: newRunId(), kind, head, at: new Date().toISOString(), by };
  state.pending = [...state.pending, entry];
  writeLocalState(project, state);
  return entry;
}

// Whether `repo` (null for this one) is another repository than the one `state` was recorded for.
const elsewhere = (state, repo) => Boolean(repo && state?.repo) && repoName(repo) !== repoName(state.repo);

// Marks the requests on `pr` of `repo` not yet sent as sent, for `head`. Returns how many it marked. A sent request
// stays owed until the bot answers it.
export function markRequestsSent(project, pr, head, repo = null) {
  const state = readLocalState(project, pr);
  if (elsewhere(state, repo)) return 0;
  const open = (state?.pending ?? []).filter((each) => each.kind === 'request' && !each.sent && !each.answered);
  if (!open.length) return 0;
  const at = new Date().toISOString();
  for (const entry of open) entry.sent = { at, head };
  writeLocalState(project, state);
  return open.length;
}

// Marks the entries of `kind` owed on `pr` that an answer for `head` answers (answerPending), reading ancestry in this
// checkout: the bot's answer (`request`), or the gate review's recorded result (`review`). Returns 1 when it marked any.
export function answerOwed(project, pr, kind, { head, by, repo = null, isAncestor: ancestor = (a, b) => isAncestor(project.root, a, b) }) {
  const state = readLocalState(project, pr);
  if (!state || elsewhere(state, repo) || !answerPending(state, kind, { head, by, isAncestor: ancestor })) return 0;
  writeLocalState(project, state);
  return 1;
}

// `aidrian pr request <PR> [--kind request|review] [--head SHA]`. Without --head, gh reads the pull request's head.
// Exit 0 recorded, 1 a usage error or a head it cannot read.
export function runRequest(args, project, { viewPr = (pr) => ghJson(['pr', 'view', String(pr), '--json', 'headRefOid'], { cwd: project.root }) } = {}) {
  const [ref, ...rest] = args;
  const pr = prNumber(ref ?? '');
  if (pr === null) throw new Error('request needs a pull request number');
  const flags = { kind: 'request', head: null };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (!['--kind', '--head'].includes(flag)) throw new Error(`unknown argument: ${flag}`);
    const value = rest[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    flags[flag.slice(2)] = value;
  }
  if (!KINDS.includes(flags.kind)) throw new Error(`--kind must be one of ${KINDS.join(', ')}`);
  if (flags.head !== null && !SHA.test(flags.head)) throw new Error(`--head ${flags.head} is not a commit`);
  const head = flags.head ?? viewPr(pr)?.headRefOid;
  if (typeof head !== 'string' || !SHA.test(head)) throw new Error(`cannot read the head of pull request #${pr}: pass --head <sha>`);
  const by = runGit(['config', 'user.name'], project.root).stdout?.trim() || 'unknown';
  recordPending(project, { pr, repo: originRepo(project), kind: flags.kind, head, by });
  console.log(flags.kind === 'request'
    ? `recorded the bot review the Human asked for on pull request #${pr} at ${head.slice(0, 7)}. A merge waits until \`aidrian pr await-review ${pr} --request\` sends it and the bot answers.`
    : `recorded the gate review of pull request #${pr} at ${head.slice(0, 7)} as dispatched. A merge waits until \`aidrian pr attest ${pr}\` records its result.`);
  return 0;
}
