// The second half of one `aidrian pr review` step: run the plan's stages in order, each as far as this step can take
// it (an exec reviewer, the review bot, an agent dispatch), judge each finished stage, then the evidence beyond the
// reviewers. Every return goes through the step's outcome writers on `s`, which lib/review/run.mjs defines.

import { markerFor } from '../review-gate.mjs';
import { ANSWERED, keepsRecordedCap } from '../pr-await-review.mjs';
import { sameCommit } from './state.mjs';
import { computeVerdict } from '../pr-checks.mjs';
import { lateRoundResidual } from '../finding-disposition.mjs';
import { isClean, resolve } from './diff.mjs';
import { blocks, recordFindings } from './findings.mjs';
import { withEndedWaivers } from './settled.mjs';
import { dedupe } from './split.mjs';
import { approveLine } from './approvals.mjs';
import { HARNESS_FLOW } from './plan.mjs';
import * as quota from './quota.mjs';
import { captureKeys } from './visual.mjs';
import { inBaseWorktree } from './base-worktree.mjs';
import { captureAndAttach, closingRange, dispatchFor, listedFor, passInput, planPasses } from './dispatch.mjs';
import { refusedAtHead } from './in-force.mjs';

export const MAX_ATTEMPTS = 3;

// The check runs of one commit as `gh pr checks` rows: the evidence must be for the head under review.
const checkRows = (runs) => runs.map((run) => ({ name: run.name, state: run.status === 'completed' ? String(run.conclusion ?? 'unknown').toUpperCase() : 'PENDING' }));

// A pass that can still run as two halves. A plan command's own slice pass is cut once on the record and never runs as
// halves, so the record's mark ends its cutting and the attempt limit still stops it.
const canHalve = (state, pass) => pass.role === 'slice' && (pass.files?.length ?? 0) > 1 && !state.halved?.[pass.id];

// Counts a step's failed passes on the record and cuts the ones that should run as two halves: the step's first failure
// of any kind, and every other timeout that can be cut, or that slice would run whole once more for nothing.
// A timeout cuts at once, since the same input again costs another full time limit; any other failure may pass on a
// retry, so it cuts at the second. Returns each counted failure's { halve, attempts, reason }.
function countFailures(state, head, failures) {
  const counted = failures.filter(([pass, outcome], index) => index === 0 || (outcome.status === 'timed_out' && canHalve(state, pass)));
  return counted.map(([pass, outcome, seconds]) => {
    const key = `${head}:${pass.id}`;
    state.failures[key] = (state.failures[key] ?? 0) + 1;
    const strikes = outcome.status === 'timed_out' ? 1 : 2;
    const halve = canHalve(state, pass) && state.failures[key] >= strikes;
    if (halve) state.halved = { ...(state.halved ?? {}), [pass.id]: true };
    const next = halve ? '; it runs as two halves next' : '';
    return { halve, attempts: state.failures[key], reason: `${pass.id}: ${outcome.reason} after ${seconds} s${next}` };
  });
}

// Runs the stages of the step that lib/review/step.mjs planned into `s`, and returns the step's result.
export async function runStages(s) {
  const { opts, config, env, forge, exec, awaitBot, root, cleanEnv, repo, n, head, baseTip, review, state, plan, map, resultFor, quietSince, dispositionTable, fallbacks, keptSignoffs, visualEntries, isVisual, passes, removedTests, maxRounds, grantFloor, flowStatus, finish, capReached, quotaStop } = s;

  // The stage the last round runs first: the last one that needs no earlier result, so never the review bot, whose
  // answer is awaited after every earlier pass.
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

  // The review bot's request: the gate's marker sums every code-reviewer pass that counts for this head (a
  // carried-forward one too); with the gate on and none on record, nothing is posted. The plan's cap (the base branch's,
  // plus valid extra rounds) is the bot's too: a cap an earlier request recorded counts only under the Human's override
  // with no --max-rounds, so an approved raise runs at exactly its --max-rounds.
  // A request past the base branch's cap uses an extra round, granted on the signals of this head: the wait posts
  // nothing for another head (head_moved), and the next step reads the grant again on it.
  const gate = () => {
    if (!config.github.reviewGate.enabled) return {};
    const reviewed = passes.filter((pass) => pass.kind === 'agent' && pass.reviewer === 'code-reviewer').map(resultFor).filter(Boolean);
    if (!reviewed.length) return { reason: 'the review gate needs the code-reviewer pass on record before the bot is asked' };
    const findings = reviewed.reduce((total, result) => total + result.findings, 0);
    const open = reviewed.reduce((total, result) => total + result.open, 0);
    return { marker: markerFor({ pr: n, repo, head, reviewer: 'code-reviewer', findings, fixed: findings - open }) };
  };
  const wait = awaitBot ?? (await import('../pr-await-review.mjs')).awaitReview;
  const botWait = (extra) => wait({ pr: String(n), repo, head, request: true, reviewer: config.github.reviewer, timeoutSec: opts.timeoutSec ?? 840, intervalSec: 60, maxRounds, keepRecordedCap: keepsRecordedCap(env, opts.maxRounds !== undefined), validHead: head, grantFloor, ...extra }, { gate });
  const headMoved = (bot) => finish('incomplete', { reason: `the pull request moved to ${String(bot.head_sha).slice(0, 7)} before the request on an extra round: run the step again, which reads the grant on the new head`, retry_recommended: true });
  // The bot's answer for this head, recorded as its pass's result. A 👍, or the clean comment it answers a draft with
  // (pr-await-review.mjs latestBotSignal `clean`), leaves nothing open; any other answer holds at least one finding.
  const recordBot = (pass, bot) => {
    const clean = bot.signal?.kind === 'thumbs_up' || (bot.signal?.kind === 'comment' && bot.signal.clean === true);
    const open = clean ? 0 : Math.max(1, bot.signal?.line_comments ?? 0);
    state.passes[pass.id] = { head, reviewer: pass.reviewer, findings: open, open, bot: { kind: bot.signal?.kind ?? null, review_id: bot.signal?.review_id ?? null } };
    recorded = true;
  };
  // A request a wait posted, from either call, is on record for the head it asked about (`requested_head`), never
  // the last head the wait saw: the pull request may have moved past either since. Returns whether it asked about
  // this step's head.
  const noteRequest = (bot) => {
    if (!bot.requested) return false;
    const asked = typeof bot.requested_head === 'string' ? bot.requested_head : head;
    state.botRequest = { head: asked, at: new Date().toISOString() };
    return sameCommit(asked, head);
  };

  // The bot is asked as soon as a round opens on a head and the gate allows it, so it reviews while this machine's
  // passes, the agents, and CI run. Its stage still comes last: the step awaits its answer only once every earlier
  // stage passed, so nothing reads as reviewed before the bot answers. One request per head (`botRequest`): the wait
  // later only waits. A round the bot was asked on is kept, even when a local reviewer then fails. Every stop the
  // request can meet but a moved head (the cap, a usage limit) is left to the bot's stage, where it always was.
  const bot = passes.find((pass) => map[pass.reviewer]?.kind === 'remote' && !resultFor(pass));
  if (bot && !sameCommit(state.botRequest?.head, head) && !gate().reason && openRound() !== 'round_limit') {
    const asked = await botWait({ timeoutSec: 0 });
    if (asked.status === 'head_moved') {
      undoRound();
      return headMoved(asked);
    }
    // A request for a newer head: this step's head is no longer the pull request's, so no reviewer runs on it.
    if (asked.requested && !noteRequest(asked)) {
      undoRound();
      return finish('incomplete', { reason: `the pull request moved to ${String(asked.requested_head).slice(0, 7)}, and the review bot was asked about that head: run the step again`, retry_recommended: true });
    }
    if (ANSWERED.has(asked.status) && (!asked.head_sha || sameCommit(asked.head_sha, head))) recordBot(bot, asked);
    else if (asked.requested) recorded = true;
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
        // What each pass's input lists, kept for its write: the only ids a finding it returns may take.
        const listed = new Map(execs.map((pass) => [pass.id, listedFor(s, pass)]));
        const run = (tree) => Promise.all(execs.map((pass) => {
          const reviewer = map[pass.reviewer];
          const started = Date.now();
          return exec(reviewer, passInput(s, pass, stage), { root: reviewer.builtIn ? root : tree, env: cleanEnv }).then((outcome) => [pass, outcome, Math.round((Date.now() - started) / 1000)]);
        }));
        const outcomes = execs.some((pass) => !map[pass.reviewer].builtIn) ? await inBaseWorktree(root, baseTip, run) : await run(root);
        for (const [pass, outcome, seconds] of outcomes) {
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
          // Every finding gets its id, its security mark, and its checked file and line from the one function that
          // writes them (findings.mjs recordFindings), which stores the pass's result.
          recordFindings(state, pass.id, {
            head, reviewer: pass.reviewer, seconds, files: Array.isArray(pass.files) ? [...pass.files].sort() : null, findings: list.length + ruled.length, open: list.filter(blocks).length, list, verdicts: outcome.verdicts,
            ...(ruled.length ? { ruled } : {}), ...(carried.length ? { carried } : {}),
            ...(pass.role ? { contracts: outcome.contracts ?? [], cross_notes: outcome.cross_notes ?? [] } : {}), dropped: outcome.dropped,
          }, { mint: state.floored === true, securityPass: state.planNote?.passes?.[pass.id]?.security === true, paths: s.paths.at(head), listed: listed.get(pass.id), plan: planPasses(plan), stage: stage.name, reviewer: pass.reviewer, range: closingRange(root, s.base) });
          recorded = true;
        }
        const outOfQuota = outcomes.find(([, outcome]) => outcome.status === 'quota');
        if (outOfQuota) {
          undoRound();
          return quotaStop(outOfQuota[0], stage, outOfQuota[1].reason);
        }
        const failures = outcomes.filter(([, outcome]) => outcome.status !== 'done');
        if (failures.length) {
          const counted = countFailures(state, head, failures);
          const stuck = counted[0].attempts >= MAX_ATTEMPTS && !counted[0].halve;
          undoRound();
          return finish(stuck ? 'stuck' : 'incomplete', { reason: counted.map((each) => each.reason).join('; '), attempts: counted[0].attempts, retry_recommended: !stuck });
        }
        // Passes still without a result, a cross pass included, keep the stage open: a partial review never passes.
        const left = stage.passes.filter((pass) => !resultFor(pass) && map[pass.reviewer]?.kind === 'exec');
        if (left.length) return finish('running', { stage: stage.name, done: stage.passes.filter((pass) => resultFor(pass)).length, total: stage.passes.length });
      }
      const remote = pending.find((pass) => map[pass.reviewer]?.kind === 'remote');
      if (remote) {
        // The bot's answer is awaited only after every earlier pass has a result, under the plan's own cap: nothing here
        // raises the cap the request records. A head already asked about is only waited for, never asked about again.
        const waiting = plan.stages.slice(0, plan.stages.indexOf(stage)).flatMap((each) => each.passes).filter((pass) => !resultFor(pass));
        if (waiting.length) return finish('incomplete', { reason: `the review bot waits for ${waiting.map((pass) => pass.id).join(', ')}`, retry_recommended: true });
        const bot = await botWait({ request: !sameCommit(state.botRequest?.head, head) });
        noteRequest(bot);
        if (bot.status === 'head_moved') {
          undoRound();
          return headMoved(bot);
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
        recordBot(remote, bot);
      }
      const agents = pending.filter((pass) => map[pass.reviewer]?.kind === 'agent' || pass.kind === 'agent');
      if (agents.length) {
        recorded = true;
        if (visualEntries.length && agents.some(isVisual) && s.manifest?.status !== 'captured') await captureAndAttach(s);
        // What each dispatched pass covers, so its attest records the same files, its stage and whether the head's plan
        // requires the security reviewer for it, which its attest's findings take, the delta base its input named, and
        // the ids it listed, the only ids a finding it returns may take (findings.mjs recordFindings).
        const dispatch = agents.map((pass) => dispatchFor(s, pass, stage));
        state.dispatched = { ...(state.dispatched ?? {}), ...Object.fromEntries(agents.map((pass, i) => [pass.id, { head, files: Array.isArray(pass.files) ? [...pass.files].sort() : null, stage: stage.name, security: state.planNote?.passes?.[pass.id]?.security === true, base: dispatch[i].base, listed: listedFor(s, pass) }])) };
        return finish('dispatch', { stage: stage.name, dispatch });
      }
    }
    // Every pass of this stage has its result: what the stages whose every pass has one left out closes as not reported
    // again, through the one writer of finding ids (findings.mjs recordFindings).
    recordFindings(state, null, null, { plan: planPasses(plan), head, complete: new Set(plan.stages.filter((each) => each.passes.every((pass) => resultFor(pass))).map((each) => each.name)), range: closingRange(root, s.base) });
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
