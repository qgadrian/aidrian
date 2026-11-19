// The sessions of a project run that run on after their issue settled (lib/project-run-gate.mjs `next`, `start`, `wait`,
// and `end`). An issue settles when `wait` takes in the result its session handed over, often while that session is
// still finishing its last turn; it can also keep working for good. Every session a start held counts toward the run's
// caps until the host lists it ended, not only the one of an issue that runs:
//   - a held start (`outcome: 'started'`) whose issue no longer runs from it, and that no `gone` row records ended, is
//     settled (settledStarts): `next` prints `wait` while the host lists one as working (lingeringStarts), `start` exits
//     75 (a wait, not a refusal) while it meets one, and `end` refuses while one runs;
//   - `wait` writes a `linger` row the first time it meets one, and once LINGER_GRACE has passed since, stops its chain
//     and writes a `gone` row with `how: 'stopped'`; one the host lists as ended gets a `gone` row with `how: 'ended'`,
//     from `wait`, `start`, or `end`. A session that cannot be stopped gets a line each wait, as an overdue one does,
//     which names that session and the host's command that stops it by hand (notStopped).
// The write-ahead row of a start asks settledStarts again under the ledger's lock, from the ledger alone, so no start
// passes beside a session the run still answers for.

import { SESSION_ID } from './handoff-markers.mjs';
import { hasHidden } from './hidden-text.mjs';
import { appendToRun, readRun } from './project-run.mjs';
import { issueChain, startRows, startsOf, timeOf } from './project-run-guard.mjs';
import { safely } from './session-start-gate.mjs';

// How long `wait` lets a session run on after its issue settled, from its `linger` row, before it stops it.
export const LINGER_GRACE = 2 * 60 * 1000;

const iso = (now) => new Date(now).toISOString();
const attemptOf = (row) => `${row.key}#${row.attempt}`;

// Whether every session of the chain a start record or row names, from `id` and `session`, is one the host lists as
// ended: true, false, or null when a listing gives no answer or the chain goes on past what was read (issueChain).
export function chainEnded({ cap, store, id, session, env, spawn, now }) {
  const { chain, complete } = issueChain(store, { id, child: session }, { now });
  if (!complete) return null;
  for (const member of chain) {
    const answer = safely(() => cap.ended({ id: member.id, session: member.session, env, run: spawn }));
    if (answer !== true) return answer === false ? false : null;
  }
  return true;
}

// The line about the session `member` of an issue's chain (stopChain) that the run could not stop, after `doing`, what
// it did first: `a session of it, <id>, ...could not be stopped; <how>`, with the id its start printed, the one the
// `started` line names, and how the Human stops it by hand, from the host adapter's `stopLine`
// (`capabilities.projectStart`, `cap`). An id of no session's shape (SESSION_ID) is neither printed nor passed to the
// adapter, and an empty answer, or one with a character no display text keeps (hidden-text.mjs hasHidden), as a
// control, a line or paragraph separator, a bidirectional mark, or a zero-width character, is not printed: the line
// then points to the host's own command.
export function notStopped(cap, member, doing = '') {
  const id = typeof member?.id === 'string' && SESSION_ID.test(member.id) ? member.id : null;
  const how = id && typeof cap?.stopLine === 'function' ? safely(() => cap.stopLine({ id })) : null;
  const plain = typeof how === 'string' && how !== '' && !hasHidden(how);
  return `a session of it${id ? `, ${id},` : ''} ${doing}could not be stopped; ${plain ? how : 'the host\'s own command stops it'}`;
}

// Stops every session of the issue's chain from the start row `start` that the host does not list as ended: the first
// member, { id, session }, that still runs and could not be stopped, or null once every one runs no more.
export function stopChain({ cap, store, start, env, spawn, now }) {
  const { chain } = issueChain(store, start, { now });
  return chain.find((member) => safely(() => cap.ended({ id: member.id, session: member.session, env, run: spawn })) !== true
    && safely(() => cap.stop({ id: member.session ?? member.id, started: member.id, env, run: spawn })) !== true) ?? null;
}

// The held starts of the run `found` whose issue does not run from that very start, and that no `gone` row records
// ended: the sessions the run still answers for beside its running issues, from the ledger alone.
export function settledStarts(found) {
  const gone = new Set(found.rows.filter((row) => row.event === 'gone').map(attemptOf));
  return startRows(found).filter((row) => row.outcome === 'started' && !gone.has(attemptOf(row))
    && !(found.states.get(row.key)?.state === 'running' && startsOf(found, row.key).at(-1) === row));
}

// The settled starts of `found` whose chain the host does not list as ended (chainEnded is false, or gives no answer),
// read without writing anything, as `next` reads them; and the ones it lists as ended, as `ended`.
export function lingeringStarts({ found, store, cap, env, spawn, now }) {
  const lingering = [];
  const ended = [];
  for (const row of settledStarts(found)) {
    const answer = cap && typeof cap.ended === 'function' ? chainEnded({ cap, store, id: row.id, session: row.child, env, spawn, now }) : null;
    (answer === true ? ended : lingering).push(row);
  }
  return { lingering, ended };
}

// The line a settled start's session that runs on prints in `next` and `wait`.
export const lingerLine = (row) => `lingering ${row.key} attempt ${row.attempt}`;

// Why the run `found` may start no session now, from the ledger alone, or null: a settled start no `gone` row closed.
export function lingerProblem(found) {
  const [row] = settledStarts(found);
  return row ? `the session of ${row.key} attempt ${row.attempt} runs on after its issue settled; \`aidrian project wait ${found.init.run}\` waits for it, and stops it once ${LINGER_GRACE / 60_000} minutes have passed` : null;
}

// Settles the sessions of the run `run` that run on after their issue settled, as `start`, `end`, and (with `wait`)
// `wait` do: each the host lists as ended gets a `gone` row. With `wait`, each other gets a `linger` row the first time,
// and once LINGER_GRACE has passed since that row, its chain is stopped and it gets a `gone` row too. Returns { lines,
// lingering }: a line for each one `wait` saw run on that runs no more (`lingered KEY attempt N ended|stopped`), or that
// could not be stopped, and the start rows still running on.
export function settleLingering({ state, run, store, cap, env, spawn, now, wait = false }) {
  const found = readRun(state, run);
  if (found.problem) return { lines: [], lingering: [], problem: found.problem };
  const { lingering, ended } = lingeringStarts({ found, store, cap, env, spawn, now });
  const lingered = new Map(found.rows.filter((row) => row.event === 'linger' && Number.isFinite(timeOf(row))).map((row) => [attemptOf(row), timeOf(row)]));
  const lines = [];
  const still = [];
  for (const row of ended) {
    if (gone(state, run, row, 'ended', now) && lingered.has(attemptOf(row)) && wait) lines.push(`lingered ${row.key} attempt ${row.attempt} ended`);
  }
  for (const row of lingering) {
    if (!wait) {
      still.push(row);
      continue;
    }
    const since = lingered.get(attemptOf(row));
    if (since === undefined) {
      safely(() => appendToRun(state, run, (fresh) => (fresh.rows.some((each) => each.event === 'linger' && attemptOf(each) === attemptOf(row)) ? { rows: [] } : { rows: [{ event: 'linger', key: row.key, attempt: row.attempt, at: iso(now) }] })));
      still.push(row);
      continue;
    }
    if (now - since < LINGER_GRACE) {
      still.push(row);
      continue;
    }
    const stuck = stopChain({ cap, store, start: row, env, spawn, now });
    if (stuck) {
      lines.push(`lingered ${row.key} attempt ${row.attempt}: ${notStopped(cap, stuck, 'ran on after its issue settled and ')}`);
      still.push(row);
      continue;
    }
    if (gone(state, run, row, 'stopped', now)) lines.push(`lingered ${row.key} attempt ${row.attempt} stopped`);
    else still.push(row);
  }
  return { lines, lingering: still };
}

// Writes the `gone` row of the start row `row`, once: whether the ledger holds one now.
function gone(state, run, row, how, now) {
  const written = safely(() => appendToRun(state, run, (fresh) => (fresh.rows.some((each) => each.event === 'gone' && attemptOf(each) === attemptOf(row))
    ? { rows: [] }
    : { rows: [{ event: 'gone', key: row.key, attempt: row.attempt, how, at: iso(now) }] })));
  return Boolean(written && !written.problem);
}
