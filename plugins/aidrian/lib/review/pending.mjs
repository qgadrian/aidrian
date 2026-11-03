// The reviews a pull request still owes, kept in this machine's review record (lib/review/state.mjs) for the merge guard
// (lib/rules/github/merge-review.mjs). `aidrian pr request <PR>` records the bot review the Human asked for, the moment
// they ask, so a later instruction cannot drop it; `--kind review` records a gate review being dispatched.
// `aidrian pr await-review` marks a request sent once it posts it or the bot has answered the head; `aidrian pr attest`
// and a finished review step clear a gate review.

import { ghJson } from '../gh.mjs';
import { runGit } from '../git.mjs';
import { originRepo, prNumber } from '../review-gate.mjs';
import { emptyState, readLocalState, writeLocalState } from './state.mjs';

const SHA = /^[0-9a-f]{7,40}$/iu;
const KINDS = ['request', 'review'];

// Records one entry owed on `pr`, replacing an unsent one of the same kind. Returns the entry.
export function recordPending(project, { pr, repo, kind, head, by }) {
  const state = readLocalState(project, pr) ?? emptyState(pr, repo);
  const entry = { kind, head, at: new Date().toISOString(), by };
  state.pending = [...(state.pending ?? []).filter((each) => each.kind !== kind || each.sent), entry];
  writeLocalState(project, state);
  return entry;
}

// Marks the requests owed on `pr` sent, for `head`. Returns how many it marked.
export function markRequestsSent(project, pr, head) {
  const state = readLocalState(project, pr);
  const open = (state?.pending ?? []).filter((each) => each.kind === 'request' && !each.sent);
  if (!open.length) return 0;
  const at = new Date().toISOString();
  for (const entry of open) entry.sent = { at, head };
  writeLocalState(project, state);
  return open.length;
}

// Drops the gate reviews owed on `pr`: their result is on record. Returns how many it dropped.
export function clearReviews(project, pr) {
  const state = readLocalState(project, pr);
  const before = state?.pending?.length ?? 0;
  if (!before) return 0;
  state.pending = state.pending.filter((each) => each.kind !== 'review');
  if (state.pending.length === before) return 0;
  writeLocalState(project, state);
  return before - state.pending.length;
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
    ? `recorded the bot review the Human asked for on pull request #${pr} at ${head.slice(0, 7)}. A merge waits until \`aidrian pr await-review ${pr} --request\` sends it.`
    : `recorded the gate review of pull request #${pr} at ${head.slice(0, 7)} as dispatched. A merge waits until \`aidrian pr attest ${pr}\` records its result.`);
  return 0;
}
