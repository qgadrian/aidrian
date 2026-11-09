// The second half of one `aidrian pr review` step: run the plan's stages in order, each as far as this step can take
// it (an exec reviewer, the review bot, an agent dispatch), judge each finished stage, then the evidence beyond the
// reviewers. Every return goes through the step's outcome writers on `s`, which lib/review/run.mjs defines.

import { markerFor } from '../review-gate.mjs';
import { ROUNDS_OVERRIDE } from '../pr-await-review.mjs';
import { computeVerdict } from '../pr-checks.mjs';
import { lateRoundResidual } from '../finding-disposition.mjs';
import { isClean, resolve } from './diff.mjs';
import { blocks } from './findings.mjs';
import { withEndedWaivers } from './settled.mjs';
import { dedupe } from './split.mjs';
import { approveLine } from './approvals.mjs';
import { HARNESS_FLOW } from './plan.mjs';
import * as quota from './quota.mjs';
import { captureKeys } from './visual.mjs';
import { inBaseWorktree } from './base-worktree.mjs';
import { captureAndAttach, dispatchFor, passInput } from './dispatch.mjs';
import { refusedAtHead } from './in-force.mjs';

export const MAX_ATTEMPTS = 3;

// The check runs of one commit as `gh pr checks` rows: the evidence must be for the head under review.
const checkRows = (runs) => runs.map((run) => ({ name: run.name, state: run.status === 'completed' ? String(run.conclusion ?? 'unknown').toUpperCase() : 'PENDING' }));

// Runs the stages of the step that lib/review/step.mjs planned into `s`, and returns the step's result.
export async function runStages(s) {
  const { opts, config, env, forge, exec, awaitBot, root, cleanEnv, repo, n, head, baseTip, review, state, plan, map, resultFor, quietSince, dispositionTable, fallbacks, keptSignoffs, visualEntries, isVisual, passes, removedTests, maxRounds, grantFloor, flowStatus, finish, capReached, quotaStop } = s;

  // The stage the last round runs first: the last one that needs no earlier result, so never the review bot, which
  // waits for every earlier pass.
  const finalStage = [...plan.stages].reverse().find((stage) => stage.passes.every((pass) => map[pass.reviewer]?.kind !== 'remote')) ?? null;
  const current = state.rounds.at(-1);
  // A quiet push since the round's head keeps the round: it moves to this head, its number, cap, and last-round flag
  // as they were, and the heads it moved from go in its `quiet` list. The passes it touches still re-review it.
  const quiet = Boolean(current) && current.head !== head && quietSince(current.head);
  const newRound = current?.head !== head && !quiet;
  // The last round runs the final stage first, so an independent review always happens before the cap. A round that
  // started as the last one stays the last one on every later call for the same head, unless an extra round was
  // granted since: then a fix may have a new head again.
  const lastRound = newRound ? state.rounds.length + 1 === maxRounds : Boolean(current?.final) && state.rounds.length >= maxRounds;
  const roundsBefore = state.rounds.length;
  const roundBefore = current ? { head: current.head, at: current.at, quiet: current.quiet } : null;
  let opened = current?.head === head;
  let recorded = false;
  const openRound = () => {
    if (opened) return null;
    if (quiet) {
      current.quiet = [...(current.quiet ?? []), { from: current.head, at: current.at }];
      Object.assign(current, { head, at: new Date().toISOString() });
      opened = true;
      return null;
    }
    if (state.rounds.length >= maxRounds) return 'round_limit';
    state.rounds.push({ head, at: new Date().toISOString(), ...(lastRound ? { final: true } : {}) });
    if (lastRound && plan.stages.length > 1 && finalStage) state.overrides = [...new Set([...state.overrides, `round ${maxRounds} ran the ${finalStage.name} stage first`])];
    opened = true;
    return null;
  };
  // A run that produced nothing (a failure, a quota stop) gives its round back.
  const undoRound = () => {
    if (newRound && !recorded) state.rounds.length = roundsBefore;
    if (quiet && !recorded) {
      Object.assign(current, roundBefore);
      if (roundBefore.quiet === undefined) delete current.quiet;
    }
  };
  // A quiet push moves the round to this head before any pass runs, so a step whose passes all carry still moves it.
  if (quiet) {
    openRound();
    plan.reasons = [...plan.reasons, `a comment, doc, or test-only change since ${roundBefore.head.slice(0, 7)}: the round stays open; the passes it touches re-review it`];
  }

  // In the last round the final stage runs first and is judged last, once the earlier stages' verdicts are in.
  const order = lastRound && plan.stages.length > 1 && finalStage ? [{ stage: finalStage, runOnly: true }, ...plan.stages.map((stage) => ({ stage }))] : plan.stages.map((stage) => ({ stage }));
  for (const { stage, runOnly } of order) {
    const unfinished = stage.passes.filter((pass) => !resultFor(pass));
    // A pass runs once the passes it comes after have results: the cross-cutting pass waits for every slice.
    const pending = unfinished.filter((pass) => (pass.after ?? []).every((id) => resultFor(stage.passes.find((each) => each.id === id) ?? { id })));
    if (unfinished.length && !pending.length) return finish('incomplete', { reason: `${unfinished.map((pass) => pass.id).join(', ')} wait for passes that cannot finish`, retry_recommended: false });
    if (pending.length) {
      if (openRound() === 'round_limit') return capReached({ max_rounds: maxRounds });
      // At most `parallel` local reviewers per step: each runs up to its time limit, and a step must end inside one
      // shell call. The rest run on the next step, which `running` asks for.
      const ready = pending.filter((pass) => map[pass.reviewer]?.kind === 'exec');
      const execs = ready.slice(0, review.split?.parallel ?? 4);
      if (execs.length) {
        if (resolve(root, 'HEAD') !== head || !isClean(root)) {
          undoRound();
          const refused = refusedAtHead(s.project, baseTip, head, s.codex);
          if (refused) return finish('incomplete', { reason: refused, retry_recommended: false });
          return finish('incomplete', { reason: `a local reviewer reads the checkout: check out ${head.slice(0, 7)} with a clean working tree first`, retry_recommended: true });
        }
        // Codex reads the checkout at the head; a project's own reviewer runs as the base has it, and reads the head
        // through git (its input names both commits).
        const run = (tree) => Promise.all(execs.map((pass) => {
          const reviewer = map[pass.reviewer];
          return exec(reviewer, passInput(s, pass, stage), { root: reviewer.builtIn ? root : tree, env: cleanEnv }).then((outcome) => [pass, outcome]);
        }));
        const outcomes = execs.some((pass) => !map[pass.reviewer].builtIn) ? await inBaseWorktree(root, baseTip, run) : await run(root);
        for (const [pass, outcome] of outcomes) {
          if (outcome.status !== 'done') continue;
          // From review round N, the disposition table makes a low finding a residual: it is recorded accepted, blocks
          // nothing, and `residuals` names it for the pull request body. cleanOutput (reviewers.mjs) already limits a
          // reviewer's output to the schema's keys; this strip is the step's own rule for any exec outcome, so the three
          // this rule sets are dropped first: a printed `state: 'fixed'` closes nothing.
          const list = outcome.findings.map(({ state: _state, disposition: _disposition, accepted_by: _acceptedBy, ...finding }) => {
            const late = lateRoundResidual({ severity: finding.severity, source: 'bot', round: state.rounds.length }, dispositionTable);
            return late ? { ...finding, disposition: late.disposition, state: 'accepted', accepted_by: 'late-round' } : finding;
          });
          // A finding the reviewer returned as already ruled (lib/review/settled.mjs) counts among the findings, never as
          // open, and stays on the record as `ruled`, which the summary comment lists and the next head reads as settled.
          // The carried rulings the pass was offered, an anchored residual's among them, stay as `carried` whether or not
          // it repeated them, so a head with no repeat does not end them. A waiver above low it was no longer offered stays
          // there too, marked ended, so the hold on auto-merge outlives the anchor.
          const ruled = Array.isArray(outcome.ruled) ? outcome.ruled : [];
          const carried = withEndedWaivers(state, ruled, Array.isArray(outcome.carried) ? outcome.carried : []);
          state.passes[pass.id] = {
            head, reviewer: pass.reviewer, files: Array.isArray(pass.files) ? [...pass.files].sort() : null, findings: list.length + ruled.length, open: list.filter(blocks).length, list, verdicts: outcome.verdicts,
            ...(ruled.length ? { ruled } : {}), ...(carried.length ? { carried } : {}),
            ...(pass.role ? { contracts: outcome.contracts ?? [], cross_notes: outcome.cross_notes ?? [] } : {}), dropped: outcome.dropped,
          };
          recorded = true;
        }
        const outOfQuota = outcomes.find(([, outcome]) => outcome.status === 'quota');
        if (outOfQuota) {
          undoRound();
          return quotaStop(outOfQuota[0], stage, outOfQuota[1].reason);
        }
        const failed = outcomes.find(([, outcome]) => outcome.status !== 'done');
        if (failed) {
          const key = `${head}:${failed[0].id}`;
          state.failures[key] = (state.failures[key] ?? 0) + 1;
          // A slice that fails twice is cut in half on the next step: a smaller slice is likelier to fit.
          const halve = failed[0].role === 'slice' && state.failures[key] === 2 && (failed[0].files?.length ?? 0) > 1 && !failed[0].id.match(/\.[ab]$/u);
          if (halve) state.halved = { ...(state.halved ?? {}), [failed[0].id]: true };
          const stuck = state.failures[key] >= MAX_ATTEMPTS && !halve;
          undoRound();
          return finish(stuck ? 'stuck' : 'incomplete', { reason: `${failed[0].id}: ${failed[1].reason}${halve ? '; it runs as two halves next' : ''}`, attempts: state.failures[key], retry_recommended: !stuck });
        }
        // Passes still without a result, a cross pass included, keep the stage open: a partial review never passes.
        const left = stage.passes.filter((pass) => !resultFor(pass) && map[pass.reviewer]?.kind === 'exec');
        if (left.length) return finish('running', { stage: stage.name, done: stage.passes.filter((pass) => resultFor(pass)).length, total: stage.passes.length });
      }
      const remote = pending.find((pass) => map[pass.reviewer]?.kind === 'remote');
      if (remote) {
        // The bot is asked only after every earlier pass has a result, with the review-gate marker from the
        // code-reviewer's pass, and under the plan's own cap: nothing here raises the cap the request records.
        const waiting = plan.stages.slice(0, plan.stages.indexOf(stage)).flatMap((each) => each.passes).filter((pass) => !resultFor(pass));
        if (waiting.length) return finish('incomplete', { reason: `the review bot waits for ${waiting.map((pass) => pass.id).join(', ')}`, retry_recommended: true });
        // The marker sums every code-reviewer pass that counts for this head (a carried-forward one too); with the gate
        // on and none on record, nothing is posted.
        const reviewed = passes.filter((pass) => pass.kind === 'agent' && pass.reviewer === 'code-reviewer').map(resultFor).filter(Boolean);
        const gate = () => {
          if (!config.github.reviewGate.enabled) return {};
          if (!reviewed.length) return { reason: 'the review gate needs the code-reviewer pass on record before the bot is asked' };
          const findings = reviewed.reduce((total, result) => total + result.findings, 0);
          const open = reviewed.reduce((total, result) => total + result.open, 0);
          return { marker: markerFor({ pr: n, repo, head, reviewer: 'code-reviewer', findings, fixed: findings - open }) };
        };
        const wait = awaitBot ?? (await import('../pr-await-review.mjs')).awaitReview;
        // The plan's cap (the base branch's, plus valid extra rounds) is the bot's too: a cap an earlier request recorded
        // counts only under the Human's override.
        // A request past the base branch's cap uses an extra round, granted on the signals of this head: the wait posts
        // nothing for another head (head_moved), and the next step reads the grant again on it.
        const bot = await wait({ pr: String(n), repo, head, request: true, reviewer: config.github.reviewer, timeoutSec: opts.timeoutSec ?? 840, intervalSec: 60, maxRounds, keepRecordedCap: env[ROUNDS_OVERRIDE] === '1', validHead: head, grantFloor }, { gate });
        if (bot.status === 'head_moved') {
          undoRound();
          return finish('incomplete', { reason: `the pull request moved to ${String(bot.head_sha).slice(0, 7)} before the request on an extra round: run the step again, which reads the grant on the new head`, retry_recommended: true });
        }
        if (bot.status === 'review_required') {
          undoRound();
          return finish('incomplete', { reason: bot.reason, retry_recommended: false });
        }
        if (bot.status === 'timed_out' || bot.status === 'blocked_quota' || bot.status === 'round_limit') {
          if (!bot.requested) undoRound();
          if (bot.status === 'blocked_quota') return quotaStop(remote, stage, bot.reason ?? 'the review bot posted a usage-limit notice', { bot });
          return bot.status === 'round_limit' ? capReached({ bot }) : finish(bot.status, { bot });
        }
        // A push during the wait: the bot's answer is for another commit, so it counts for nothing here.
        if (bot.head_sha && bot.head_sha !== head) return finish('incomplete', { reason: `the pull request moved to ${String(bot.head_sha).slice(0, 7)} during the wait: run the step again`, retry_recommended: true });
        const open = bot.signal?.kind === 'thumbs_up' ? 0 : Math.max(1, bot.signal?.line_comments ?? 0);
        state.passes[remote.id] = { head, reviewer: remote.reviewer, findings: open, open, bot: { kind: bot.signal?.kind ?? null, review_id: bot.signal?.review_id ?? null } };
        recorded = true;
      }
      const agents = pending.filter((pass) => map[pass.reviewer]?.kind === 'agent' || pass.kind === 'agent');
      if (agents.length) {
        recorded = true;
        if (visualEntries.length && agents.some(isVisual) && s.manifest?.status !== 'captured') await captureAndAttach(s);
        // What each dispatched pass covers, so its attest records the same files.
        state.dispatched = { ...(state.dispatched ?? {}), ...Object.fromEntries(agents.map((pass) => [pass.id, { head, files: Array.isArray(pass.files) ? [...pass.files].sort() : null }])) };
        return finish('dispatch', { stage: stage.name, dispatch: agents.map((pass) => dispatchFor(s, pass, stage)) });
      }
    }
    if (runOnly) continue;
    const open = stage.passes.map((pass) => [pass, resultFor(pass)]).filter(([, result]) => result?.open > 0);
    const unsigned = plan.flows.filter((flow) => stage.passes.some((pass) => (pass.flows ?? []).includes(flow.id))).map((flow) => [flow, flowStatus(flow)]).filter(([, status]) => !status.signed);
    if (open.length || unsigned.length) {
      // A fix needs a new head, and in the last round there is none left: that is the cap, with the work named.
      return (lastRound ? capReached : (extra) => finish('fix_required', extra))({
        stage: stage.name,
        open: open.map(([pass, result]) => ({ pass: pass.id, reviewer: pass.reviewer, head: result.head, open: result.open, findings: result.list ?? null, ...(result.dropped?.length ? { dropped: result.dropped } : {}) })),
        // One entry per mistake when slices and the cross pass report the same one.
        ...(stage.passes.some((pass) => pass.role) ? { findings_merged: dedupe(open.map(([pass, result]) => [pass.id, result.list ?? []])) } : {}),
        flows: unsigned.map(([flow, status]) => ({
          flow: flow.id, violated: status.open, unverified: status.unverified,
          // Reviewers disagree: the Human decides, and the invariant then passes on the evidence.
          ...(status.disputed.some((id) => status.open.includes(id)) ? { disputed: status.disputed.filter((id) => status.open.includes(id)), overrule: status.disputed.filter((id) => status.open.includes(id)).map((id) => overruleCommand(s, flow, id)) } : {}),
          next: nextSteps(s, flow, status),
        })),
      });
    }
    // A stage the Human chose to review in place of an out-of-quota reviewer waits for their sign-off before the next.
    const unsignedStage = fallbacks.find((stop) => stop.stage === stage.name && stop.choice === quota.HUMAN && !stop.signoff);
    if (unsignedStage) return finish('human_required', { stage: stage.name, flows: [], command: [quota.signoffCommand(n, unsignedStage)] });
  }
  // Evidence beyond the reviewers: no flow test deleted without the Human's word, and the required checks of the
  // flows the change touches passed on this head.
  const unaccepted = removedTests.filter((each) => state.signoffs[each.flow]?.head !== head);
  if (unaccepted.length) return lastRound ? capReached({ stage: 'evidence', tests_removed: unaccepted }) : finish('fix_required', { stage: 'evidence', tests_removed: unaccepted });
  const wanted = [...new Set(plan.flows.flatMap((flow) => review.flows[flow.id]?.checks ?? []))];
  if (wanted.length) {
    const rows = checkRows(forge.checkRuns(repo, head)).filter((row) => wanted.some((part) => row.name.includes(part)));
    const verdict = computeVerdict(rows, { requiredChecks: wanted });
    if (verdict.verdict === 'pending') return finish('checks_pending', { checks: verdict.pending });
    if (verdict.verdict === 'failing') {
      const extra = { stage: 'evidence', checks_failing: [...verdict.failing, ...(verdict.unexpected_skips ?? [])] };
      return lastRound ? capReached(extra) : finish('fix_required', extra);
    }
  }
  const human = plan.flows.filter((flow) => flow.signoff === 'human' && !keptSignoffs.has(flow.id));
  if (human.length) return finish('human_required', { flows: human.map((flow) => flow.id), command: human.map((flow) => `aidrian pr signoff ${n} --flow ${flow.id} --head ${head}`) });
  return finish('received', {});
}

// The Human's way out of a dispute on this head.
function overruleCommand({ n, head }, flow, id) {
  return `aidrian pr signoff ${n} --flow ${flow.id} --overrule ${id} --head ${head} --reason "<why>"`;
}

// What closes each open invariant of a flow on this head, so no session has to invent a command: a violated one is
// fixed in the code, or, when another reviewer disputes it, overruled by the Human. An unverified one closes on
// evidence: an approver's review when the invariant names approvers and both switches are on, the Human's
// acceptance, and, for a flow a visual reviewer judges with no capture of this head, the capture's own status line.
// `commands` holds only `aidrian pr signoff` commands, for the Human's shell once `--check` passes; `notes` holds
// the rest: the fix to make, the approval to ask for, the capture's status.
function nextSteps(s, flow, status) {
  const { n, head, passes, visualEntries, manifest, isVisual, approvalPath, rejectedVerdicts, settle } = s;
  const judged = settle?.on && flow.id !== HARNESS_FLOW;
  const violated = status.open.map((id) => (status.disputed.includes(id)
    ? { invariant: id, state: 'disputed', commands: [overruleCommand(s, flow, id)], notes: [], ...(judged ? { settle: `aidrian pr settle ${n} --flow ${flow.id} --overrule ${id} --head ${head} --judge <agent> --reason "<why>"` } : {}) }
    : { invariant: id, state: 'violated', commands: [], notes: ['fix the code'] }));
  const visualFlow = visualEntries.length > 0 && passes.some((pass) => isVisual(pass) && (pass.flows ?? []).includes(flow.id));
  const capture = visualFlow && captureKeys(manifest).size === 0
    ? (manifest ? `the visual capture of ${head.slice(0, 7)} is ${manifest.status}${manifest.reason ? `: ${manifest.reason}` : ''}` : `no visual capture of ${head.slice(0, 7)} ran`)
    : null;
  const unverified = status.unverified.map((id) => {
    const approvers = flow.invariants.find((each) => each.id === id)?.approvers ?? [];
    return {
      invariant: id,
      state: 'unverified',
      commands: [`aidrian pr signoff ${n} --flow ${flow.id} --accept ${id} --evidence "<URL of a comment or review of this pull request>" --reason "<what it shows>" --head ${head}`],
      ...(judged ? { settle: `aidrian pr settle ${n} --flow ${flow.id} --accept ${id} --evidence "<URL of a comment or review of this pull request>" --reason "<what it shows>" --head ${head} --judge <agent>` } : {}),
      notes: [
        ...(rejectedVerdicts?.(flow.id, id) ?? []).map((each) => `${each.reviewer} answered ${each.verdict}, but its evidence does not count (${each.problem}): dispatch that reviewer again to cite path:line, test:<name>, or capture:<key>, which closes this with no sign-off`),
        ...(approvers.length && approvalPath?.on ? [`ask for an approving review of ${head} by ${approvers.join(' or ')}, whose body holds the line: ${approveLine(flow.id, id)}`] : []),
        ...(capture ? [capture] : []),
      ],
    };
  });
  return [...violated, ...unverified];
}
