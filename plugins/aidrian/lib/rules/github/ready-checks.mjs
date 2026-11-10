// Bash rule, and the decision of the GitHub MCP hook on a call that marks a draft ready: no draft is marked ready while a
// check on its head has not finished, or while a check its last edit re-queues has not shown yet. docs/hooks.md#ready-checks.
// It reads the same calls the ready hold reads (ready-hold.mjs readReady), in every project, product feedback or not.
//
// Editing a pull request's title or body re-runs the workflows that listen for the edit, such as a title check, and GitHub
// takes a few seconds to queue the run: until then the checks still show the run from before. So it holds, in this order:
//   1. a command that edits a title or body, or opens a pull request, and marks one ready, with no network call;
//   2. a check on the head whose run has not finished (queued, waiting, in progress) or a status that is pending or
//      expected, from one `pr view` through the forge facade;
//   3. a draft opened, or whose body or title changed, less than EDIT_WINDOW_MS ago, with no check started since: one
//      GraphQL read for the edit times, only when nothing is pending.
// It lets the command run when it cannot read the call or the state: what the ready hold cannot read, a view or a read that
// fails or passes the shared deadline (ready-hold.mjs deadlineForge), a pull request that is not a draft, an edit time
// ahead of this clock by more than the window. The ready hold's override, `AIDRIAN_ALLOW_UNHELD_READY=1` in the hook's
// own environment, lifts this hold too.

import { findProject } from '../../project.mjs';
import { walkCommands } from '../../shell-lex.mjs';
import { deadlineForge, OVERRIDE, readReady } from './ready-hold.mjs';
import { commandPath, readWords } from './review-request.mjs';

// How long after an edit a check it re-queues may take to show. Past it, an edit that re-queued nothing holds nothing.
export const EDIT_WINDOW_MS = 30_000;
const VIEW = 'url,number,isDraft,createdAt,statusCheckRollup';
const CANDIDATE = /\bready\b/u;
// The options of `gh pr edit` and `gh pr create` that take a value, so the words after them are read as gh reads them.
const VALUES = new Set(['-t', '--title', '-b', '--body', '-F', '--body-file', '-B', '--base', '-H', '--head', '-m', '--milestone',
  '-a', '--assignee', '-l', '--label', '-p', '--project', '-r', '--reviewer', '-T', '--template', '-R', '--repo',
  '--add-assignee', '--remove-assignee', '--add-label', '--remove-label', '--add-project', '--remove-project',
  '--add-reviewer', '--remove-reviewer', '--recover']);
const TEXT_FLAGS = new Set(['-t', '--title', '-b', '--body', '-F', '--body-file']);
const PULL_URL = /^https?:\/\/([^/]+)\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#]|$)/iu;

export const SAME_COMMAND_REASON =
  'Blocked: this edits a pull request\'s title or body, or opens one, and marks a pull request ready in the same call. ' +
  'The edit re-queues the checks that run on it, such as a title check, and the ready lands before they report. ' +
  'Make the edit alone, wait with `gh pr checks <n> --watch` until every check reports, then mark it ready with ' +
  '`gh pr ready <n>` in a separate call.';

// Whether one gh invocation edits a pull request's title or body, or opens a pull request.
function editsText({ program, args }) {
  if (program !== 'gh') return false;
  const [noun, verb] = commandPath(args);
  if (noun !== 'pr') return false;
  if (verb === 'create') return true;
  return verb === 'edit' && readWords(args, VALUES).flags.some(({ name }) => TEXT_FLAGS.has(name));
}

const millis = (text) => (typeof text === 'string' && text !== '' ? Date.parse(text) : Number.NaN);

// The names of the checks of `rollup` that have not finished: a check run whose status is not COMPLETED, and a status
// whose state is PENDING or EXPECTED (a required one that has not reported).
function pendingChecks(rollup) {
  return rollup.flatMap((row) => {
    if (row?.__typename === 'CheckRun') return row.status === 'COMPLETED' ? [] : [String(row.name)];
    if (row?.__typename === 'StatusContext') return ['PENDING', 'EXPECTED'].includes(row.state) ? [String(row.context)] : [];
    return [];
  });
}

// The latest start among the checks of `rollup`, in ms, or -Infinity with none.
const lastStart = (rollup) => Math.max(-Infinity, ...rollup.map((row) => millis(row?.startedAt)).filter(Number.isFinite));

const pendingReason = (n, names) =>
  `Blocked: pull request #${n} has checks that have not finished on its head: ${[...new Set(names)].join(', ')}. ` +
  'A check an edit or a push re-queued can still fail after the draft is marked ready. ' +
  `Wait with \`gh pr checks ${n} --watch\` until every check reports, then mark it ready with \`gh pr ready ${n}\` in a separate call.`;

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/u, 'Z');

const missingReason = (n, what, changedAt) =>
  `Blocked: pull request #${n} ${what} at ${iso(changedAt)}, and no check has started since. GitHub takes a few seconds to ` +
  'queue the checks a change re-runs, such as a title check, and until then the checks shown are the ones from before. ' +
  `Run \`gh pr checks ${n} --watch\` once the new run shows, then mark it ready with \`gh pr ready ${n}\` in a separate call. ` +
  `With no check that runs on this change, the hold lifts at ${iso(changedAt + EDIT_WINDOW_MS)}.`;

// The newest change to the pull request that may re-queue a check and that is inside the window, as { what, at }, or null.
function recentChange(changes, now) {
  const inWindow = changes.filter(({ at }) => Number.isFinite(at) && now - at < EDIT_WINDOW_MS && at - now < EDIT_WINDOW_MS);
  return inWindow.sort((a, b) => b.at - a.at)[0] ?? null;
}

// The edits of the pull request `view` names, as changes, or [] when it cannot read them.
function editsOf(forge, view) {
  const link = PULL_URL.exec(view.url ?? '');
  if (!link) return [];
  const host = link[1].toLowerCase() === 'github.com' ? undefined : link[1];
  try {
    const pull = forge.changeEdits(link[2], Number(link[3]), { host })?.data?.repository?.pullRequest;
    const renamed = pull?.timelineItems?.nodes?.[0]?.createdAt;
    return [{ what: 'had its body edited', at: millis(pull?.lastEditedAt) }, { what: 'had its title changed', at: millis(renamed) }];
  } catch {
    return [];
  }
}

// The deny reason for one pull request, `view` as `pr view` gave it, or null.
function judgeView(view, forge, now) {
  if (view?.isDraft !== true || !Array.isArray(view.statusCheckRollup)) return null;
  const n = Number.isInteger(view.number) ? view.number : '<n>';
  const pending = pendingChecks(view.statusCheckRollup);
  if (pending.length) return pendingReason(n, pending);
  const started = lastStart(view.statusCheckRollup);
  const unseen = (change) => change && started < change.at;
  const opened = recentChange([{ what: 'was opened', at: millis(view.createdAt) }], now());
  if (unseen(opened)) return missingReason(n, opened.what, opened.at);
  const edited = recentChange(editsOf(forge, view), now());
  return unseen(edited) ? missingReason(n, edited.what, edited.at) : null;
}

// The deny reason for each ready call, { target, repo } at `folder`, read in turn under one deadline, or null.
function judgeCalls(calls, seams) {
  const forgeAt = deadlineForge(seams);
  const now = seams.now ?? Date.now;
  for (const { target, repo, folder } of calls) {
    const forge = forgeAt(folder);
    let view;
    try {
      view = forge.change(target, VIEW, { repo });
    } catch {
      continue;
    }
    const reason = judgeView(view, forge, now);
    if (reason) return reason;
  }
  return null;
}

// The deny reason for `command`, or null. `cwd` is the session's folder, `env` the hook's own environment; the rest are the
// seams of ready-hold.mjs deadlineForge.
export function check(command, { cwd = process.cwd(), env = process.env, ...seams } = {}) {
  if (env[OVERRIDE] === '1' || !CANDIDATE.test(command)) return null;
  const entries = walkCommands(command, cwd).filter((entry) => entry.unread === undefined);
  const readies = entries.flatMap((entry) => {
    const call = readReady(entry.invocation, env);
    return call && !call.unreadable && !call.ids ? [{ ...call, folder: entry.folder ?? cwd }] : [];
  });
  if (!readies.length) return null;
  if (!findProject(cwd) && !readies.some(({ folder }) => findProject(folder))) return null;
  if (entries.some((entry) => editsText(entry.invocation))) return SAME_COMMAND_REASON;
  return judgeCalls(readies, seams);
}

// The deny reason for one MCP call that marks ready, `given` as { owner, repo, pullNumber, draft, title?, body? }, or null.
export function checkMcp(given, { cwd = process.cwd(), env = process.env, ...seams } = {}) {
  if (env[OVERRIDE] === '1' || given?.draft === true || given?.draft === undefined || !findProject(cwd)) return null;
  const n = Number(given.pullNumber);
  if (!(Number.isInteger(n) && n > 0)) return null;
  if (typeof given.title === 'string' || typeof given.body === 'string') return SAME_COMMAND_REASON;
  const repo = typeof given.owner === 'string' && typeof given.repo === 'string' ? `${given.owner}/${given.repo}` : null;
  return judgeCalls([{ target: String(n), repo, folder: cwd }], seams);
}
