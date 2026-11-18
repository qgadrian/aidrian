// The held start of a session no Human attends, shared by every gate that starts one: the background route of
// `aidrian handoff continue` (lib/handoff-continue.mjs), and `aidrian project start` (lib/project-run-gate.mjs), which
// starts a session for one issue of a project run in that issue's worktree.
// The sequence is hold, start, floor, mark, record, and stop when unheld (docs/handoff.md#the-background-route):
// 1. hold: before the host starts anything, the adapter calls `hold` with the start folder and the ids of the sessions
//    the host lists. The hold first takes the claim of `session` on a start, a file made only when none is there
//    (handoff-markers.mjs claimStart), so two runs of one session never both pass it. Then one start per session:
//    while the start record of `session` lives, it refuses, unless `ended(record)`, the host's read of its own
//    listing, is true for the session that record names; a listing that gives no answer refuses too. Then it files a
//    pending mark (lib/unattended-mark.mjs), so the hooks hold every session the host had not listed, from its first
//    call, wherever it runs. No pending mark, no start. The checks run at the hold, just before the start, so a start
//    the adapter refuses earlier says why as it always did.
//    Once the claim is kept, `intent()`, the caller's write-ahead record of the start, runs before the host starts
//    anything: one that fails starts nothing.
// 2. start: `launch(hold, identify)`, the caller's call into its host adapter, which knows the prompt, the name, and
//    the folder. An adapter that learns the new session's id before it returns, and waits on it further, calls
//    `identify({ id, session })`, which files steps 3 and 4 at once, so the hooks hold the session by its own mark.
// 3. floor: the new session's chain floor, `floor`, under its full id or the short one the host printed.
// 4. mark: its unattended mark, under the same id, with the caller's `tags` (lib/unattended-mark.mjs).
// 5. record: the start record of `session`, the session that ran the gate: `record` with the started session's fields.
// No floor, mark, and record, no success: a session that cannot be held is stopped through `stop`, and one that cannot
// be stopped keeps its pending mark until it lapses. A launch whose outcome is unknown keeps its pending mark too. Both
// keep the claim for a day (keepClaim), so no later run of `session` starts another beside what may run.
// It names no host, but it still writes the handoff's markers: `store` is the continuation store
// (lib/handoff-markers.mjs), and `floor` and `record` must pass its isFrom and isStarted: a slug and a chain, with an
// absolute brief path and a sha256, or, for a session started from no brief, a null brief and, in the record, the
// project run's `project`.

import { claimStart, dropClaim, keepClaim, noteFrom, noteStarted, readStarted } from './handoff-markers.mjs';
import { dropPending, markPending, markUnattended } from './unattended-mark.mjs';

// What `act` returns, or null when it throws: a store write the disk refuses.
export function safely(act) {
  try {
    return act() ?? null;
  } catch {
    return null;
  }
}

// Starts a session for `session`, the one that runs the gate, and holds it: one of
//   { outcome: 'refused', busy, earlier, answer }  the hold refused, and nothing was filed or started: `busy` names a
//                                    claim it could not take (claimStart), or `earlier` is the live start record of
//                                    `session` and `answer` what `ended` said of it, false or null;
//   { outcome: 'started', marker }   held to its floor, marked, and recorded; `marker` is the start record's value;
//   { outcome: 'none', problem, ended } surely nothing started, and the pending mark is gone; `ended` is true when the
//                                    hold passed because the host listed the session of a live start record as ended;
//   { outcome: 'uncertain', problem } the launch may have started a session no one can name, so its pending mark stays;
//   { outcome: 'unheld', started, stopped } a session started that could not be held, or that the adapter started though
//                                    the hold refused: stopped, with its pending mark removed, or, when `stopped` is
//                                    false, still running and held by that mark.
// `launch(hold)` returns the adapter's { id, session, name, cwd, mode }, or { problem, uncertain }. `stop(id)` stops a
// started session: whether it did. `ended(record)` says whether the host lists the session a start record names as
// ended: true, false, or null when it cannot tell; without it, a live record always refuses. `store` is the
// continuation store, `root` the main checkout of the project the gate ran in, `floor` the new session's chain floor,
// { slug, chain, brief, route }, as handoff-markers.mjs noteFrom takes it, and `record` the fields of the start record
// beside the started session's own, { sha256, slug, brief, chain, project }, as noteStarted takes them. `tags`, the
// unattended mark's { project, issue } or null, are written into the new session's mark. `now` dates what it writes;
// every read of the claim and the start record takes the time afresh, so a record written after `now` holds.
// `intent()`, when given, is the caller's write-ahead record, which must return true for the start to go on; each
// outcome then says, as `intended`, whether it ran, so the caller knows whether a record of the start is there to settle.
// The background handoff route gives none, and its outcomes are as they were.
export function startHeld({ session, launch, stop, ended, store, root, floor, record, tags = null, env, now, intent }) {
  const state = { pending: null, claimed: false, refusal: null, ended: false, intended: false, identified: null, cwd: null };
  const answer = held({ session, launch, stop, ended, store, root, floor, record, tags, env, now, intent }, state);
  return typeof intent === 'function' ? { ...answer, intended: state.intended } : answer;
}

function held({ session, launch, stop, ended, store, root, floor, record, tags, env, now, intent }, state) {
  const release = () => state.pending && safely(() => dropPending(state.pending));
  const settle = (result, keep = false) => {
    if (keep) safely(() => keepClaim(store, session, { now: Date.now() }));
    else if (state.claimed) dropClaim(store, session);
    return result;
  };
  let started;
  try {
    started = launch(holdFor({ session, ended, store, root, env, intent }, state), identifyFor({ store, root, floor, tags, env, now }, state));
  } catch (error) {
    // Thrown after the hold, the start may have run.
    started = { problem: `the host's start failed (${error?.code ?? error?.message ?? 'no message'})`, uncertain: true };
  }
  if (state.refusal) {
    // The hold refused, so the adapter starts nothing; one that started a session anyway has it stopped.
    if (!started.problem) return unheld({ started, stop, release, settle });
    return settle({ outcome: 'refused', ...state.refusal });
  }
  // No pending mark, no start: the adapter calls nothing that starts a session before the hold.
  if (started.problem && started.uncertain && state.pending !== null) return settle({ outcome: 'uncertain', problem: started.problem }, true);
  if (started.problem) {
    release();
    return settle({ outcome: 'none', problem: started.problem, ...(state.ended ? { ended: true } : {}) });
  }
  const id = started.session ?? started.id;
  const marker = { ...record, id: started.id, session: started.session, name: started.name, cwd: started.cwd, mode: started.mode };
  const kept = state.pending !== null && (state.identified === id || (safely(() => noteFrom(store, id, floor, { now })) && safely(() => markUnattended(id, { root, cwd: state.cwd, env, now, tags }))))
    && safely(() => noteStarted(store, session, marker, { now }));
  if (!kept) return unheld({ started, stop, release, settle });
  release();
  return settle({ outcome: 'started', marker });
}

// The identify startHeld gives the adapter: files the floor and the mark of the session `{ id, session }` names, under
// its full id or the id the host printed, while the pending mark still holds it: whether both were filed.
function identifyFor({ store, root, floor, tags, env, now }, state) {
  return ({ id, session } = {}) => {
    const own = session ?? id;
    if (state.pending === null || typeof own !== 'string') return false;
    const filed = Boolean(safely(() => noteFrom(store, own, floor, { now })) && safely(() => markUnattended(own, { root, cwd: state.cwd, env, now, tags })));
    if (filed) state.identified = own;
    return filed;
  };
}

// The hold startHeld gives the adapter: the claim, then one start per session, then the pending mark. It notes in
// `state` the pending mark's file, whether it took the claim, why it refused, as startHeld's `refused` outcome, and
// whether it passed a live start record because the host listed that session as ended. Once the pending mark is filed,
// it keeps the claim for a day (keepClaim), so a gate killed mid-start fails closed; startHeld drops it again on every
// outcome that knows no session runs unheld.
function holdFor({ session, ended, store, root, env, intent }, state) {
  return ({ cwd, known } = {}) => {
    const claim = safely(() => claimStart(store, session, { now: Date.now() })) ?? { busy: 'unknown' };
    if (claim.busy) {
      state.refusal = { busy: claim.busy };
      return false;
    }
    state.claimed = true;
    const earlier = safely(() => readStarted(store, session, { now: Date.now() }));
    const answer = earlier ? safely(() => ended?.(earlier)) : true;
    if (answer !== true) {
      state.refusal = { earlier, answer: answer === false ? false : null };
      return false;
    }
    state.ended = Boolean(earlier);
    state.pending = safely(() => markPending(session, { cwd, root, known, env, now: Date.now() }));
    // The folder the session starts in, which its own mark records too: the session's own worktree (unattended-write.mjs).
    state.cwd = cwd;
    if (state.pending === null) return false;
    // Kept before the start: a gate killed mid-start leaves a claim that holds for a day. No kept claim, no start; and
    // no write-ahead record, no start.
    if (safely(() => keepClaim(store, session, { now: Date.now(), starting: true })) !== null) {
      state.intended = typeof intent !== 'function' || safely(() => intent()) === true;
      if (state.intended) return true;
    }
    safely(() => dropPending(state.pending));
    state.pending = null;
    return false;
  };
}

// A session `started` that cannot be held: stopped, with its pending mark removed and the claim dropped, or, when the
// stop fails, left held by its pending mark, with the claim kept for a day.
function unheld({ started, stop, release, settle }) {
  const stopped = Boolean(safely(() => stop?.(started.id)));
  if (stopped) release();
  return settle({ outcome: 'unheld', started, stopped }, !stopped);
}
