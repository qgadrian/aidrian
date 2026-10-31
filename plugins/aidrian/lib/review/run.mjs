// `aidrian pr review [PR]`: run a pull request's review plan one step at a time. Every call plans the review for the
// pull request's head, reads what has happened so far, does the next thing it can do itself (run an exec reviewer, ask
// the review bot), and returns the next action. Calling it again is always safe. The review skill is a loop around it:
//
//   dispatch        run the listed agent passes, then record each with `aidrian pr attest <PR> --pass <id> ...`
//   fix_required    fix or disposition the listed findings and unsigned invariants, push, call again
//   human_required  a flow needs the Human's sign-off: `aidrian pr signoff <PR> --flow <id>`
//   received        every stage passed on this head; none_needed: the plan has nothing to review
//   unsatisfied     the plan requires a reviewer this machine cannot run; nothing ran
//   incomplete      a reviewer failed on this head and may be retried; stuck: it failed 3 times, the Human decides
//   too_large       the change is past what one review covers; the Human decides how to split it
//   checks_pending  a flow's required checks have not all finished on this head: call again later
//   timed_out, blocked_quota, round_limit   as `aidrian pr await-review`
//
// docs/review.md describes the plan, the stages, and the record.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runGh } from '../gh.mjs';
import { runGit } from '../git.mjs';
import { isolate } from './env.mjs';
import { changedFiles, diffLines, fileAt, isAncestor, isClean, mergeBase, resolve } from './diff.mjs';
import { checkReview } from './config.mjs';
import { citationProblem, flowState, invariantsOf, parseVerdicts } from './flows.mjs';
import { computeVerdict } from '../pr-checks.mjs';
import { globPattern } from '../fs.mjs';
import { buildPlan, classify, flowsInForce, HARNESS_FLOW, mergePlans, validatePlan } from './plan.mjs';
import { resolveEngine, reviewerMap, runExec, satisfies } from './reviewers.mjs';
import { emptyState, isSummary, newer, readLocalState, stateFromComment, summaryBody, writeLocalState } from './state.mjs';

export const EXIT = Object.freeze({
  dispatch: 0, fix_required: 0, received: 0, none_needed: 0, human_required: 9,
  timed_out: 2, checks_pending: 2, blocked_quota: 3, round_limit: 4, unsatisfied: 6, incomplete: 7, stuck: 8, too_large: 8,
});
export const MAX_ATTEMPTS = 3;
export const MAX_LINES = 20000;

const HARNESS_INVARIANT = Object.freeze({
  id: 'review-not-weakened',
  text: 'The change does not weaken how this project is reviewed: no flow, rule, required reviewer, ignore pattern, plan command, or invariant is removed or loosened.',
});

export const defaultGh = {
  pr: (ref) => JSON.parse(runGh(['pr', 'view', ...(ref ? [String(ref)] : []), '--json', 'number,headRefOid,baseRefName,url'])),
  repo: () => JSON.parse(runGh(['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner,
  comments: (repo, n) => JSON.parse(runGh(['api', `repos/${repo}/issues/${n}/comments`, '--paginate', '--slurp']) || '[]').flat(),
  post: (repo, n, body) => JSON.parse(runGh(['api', `repos/${repo}/issues/${n}/comments`, '--method', 'POST', '-f', `body=${body}`])),
  edit: (repo, id, body) => JSON.parse(runGh(['api', `repos/${repo}/issues/comments/${id}`, '--method', 'PATCH', '-f', `body=${body}`])),
  checks: (repo, n) => {
    try {
      return JSON.parse(runGh(['pr', 'checks', String(n), '-R', repo, '--json', 'name,state']) || '[]');
    } catch (error) {
      // gh exits non-zero while checks fail or are pending, and still prints the rows.
      return JSON.parse(error.stdout || '[]');
    }
  },
};

// The `review` config in force: the base branch's, which a pull request cannot weaken, plus what the head adds.
// `changed` lists the review settings the head changes, which trigger the harness-config flow.
export function reviewInForce(baseReview, headReview) {
  if (!baseReview) return { review: { ...headReview, planCommand: null }, changed: headReview.planCommand ? ['planCommand'] : [] };
  const changed = [];
  for (const key of ['rules', 'ignore', 'nonBehaviour', 'flows', 'planCommand', 'reviewers']) {
    if (JSON.stringify(baseReview[key]) !== JSON.stringify(headReview[key])) changed.push(key);
  }
  return {
    review: {
      ...headReview,
      rules: [...baseReview.rules, ...headReview.rules.filter((rule) => !baseReview.rules.some((each) => JSON.stringify(each) === JSON.stringify(rule)))],
      ignore: baseReview.ignore,
      nonBehaviour: baseReview.nonBehaviour,
      flows: flowsInForce(baseReview.flows, headReview.flows),
      // The plan command and the reviewers a project defines are code: only the base branch's run. A head may add a
      // reviewer under a new name, never redefine one, and a plan command it adds runs once it is merged.
      planCommand: baseReview.planCommand,
      reviewers: { ...headReview.reviewers, ...baseReview.reviewers },
    },
    changed,
  };
}

// The base branch's `review` group, or null when the base has no config.
function baseReviewAt(project, commit) {
  const text = fileAt(project.root, commit, project.paths.config);
  if (text === null) return null;
  try {
    const raw = JSON.parse(text);
    return raw?.review === undefined ? checkReview({}, project.paths.config, []) : checkReview(raw.review, project.paths.config, []);
  } catch {
    return null;
  }
}

// The files a plan command line names that exist in the repository: a change to them is a change to the review.
function commandFiles(root, command, commit) {
  return (command ?? '').split(/\s+/u).filter((word) => /[./]/u.test(word) && !word.startsWith('-') && fileAt(root, commit, word) !== null);
}

// A planCommand's plan: it reads { base, head, changes } on stdin and prints a plan. It runs in a temporary worktree
// of the base branch, so a pull request that edits the planner cannot run its own version; the worktree shares the
// repository's objects, so the planner can still read the head. Its env is isolated like a reviewer's.
function runPlanCommand(command, input, { root, env, baseTip }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-plan-'));
  const tree = path.join(dir, 'base');
  const added = runGit(['worktree', 'add', '--detach', '--quiet', tree, baseTip], root, { timeout: 60_000 });
  if (added.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`review.planCommand: could not check out the base: ${(added.stderr || '').trim()}`);
  }
  try {
    const result = spawnSync('sh', ['-c', command], { cwd: tree, env, input: JSON.stringify(input), encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`review.planCommand failed: ${(result.stderr || '').trim().split('\n').at(-1) || `exit ${result.status}`}`);
    let plan;
    try {
      plan = JSON.parse(result.stdout);
    } catch {
      throw new Error('review.planCommand did not print a JSON plan');
    }
    const problems = validatePlan(plan);
    if (problems.length) throw new Error(`review.planCommand printed a bad plan: ${problems.join('; ')}`);
    return plan;
  } finally {
    runGit(['worktree', 'remove', '--force', tree], root, { timeout: 60_000 });
    rmSync(dir, { recursive: true, force: true });
  }
}

// Whether the change from `from` to `to` touches `files` (null: any reviewed file).
const touches = (changes, files) => (files === null ? changes.length > 0 : changes.some((change) => files.includes(change.file)));

// The whole step. `deps` replaces gh, the engine check, the reviewers, and the bot wait in tests.
export async function reviewStep(opts, { project, config, env = process.env, gh = defaultGh, exec = runExec, awaitBot = null, codex } = {}) {
  const root = project.root;
  const cleanEnv = isolate({ ...env });
  const info = gh.pr(opts.pr);
  const repo = opts.repo ?? gh.repo();
  const n = info.number;
  const head = info.headRefOid;
  if (!resolve(root, head)) throw new Error(`the head ${head.slice(0, 7)} of pull request #${n} is not in this checkout: git fetch first`);
  const baseTip = resolve(root, `origin/${info.baseRefName}`) ?? resolve(root, info.baseRefName);
  if (!baseTip) throw new Error(`the base branch ${info.baseRefName} is not in this checkout: git fetch first`);
  const base = mergeBase(root, baseTip, head);

  // The config in force, and what in the change touches how the project is reviewed.
  const baseReview = baseReviewAt(project, baseTip);
  const { review, changed } = reviewInForce(baseReview, config.review);
  const effective = { ...config, review };
  const changes = changedFiles(root, base, head);
  const changedPaths = new Set(changes.map((change) => change.file));
  const harnessChanged = [];
  if (changed.length && changedPaths.has(project.paths.config)) harnessChanged.push(project.paths.config);
  for (const file of commandFiles(root, review.planCommand, baseTip)) if (changedPaths.has(file)) harnessChanged.push(file);
  for (const flow of Object.values(baseReview?.flows ?? {})) if (typeof flow.invariants === 'string' && changedPaths.has(flow.invariants)) harnessChanged.push(flow.invariants);
  const { addedLines, removedFiles } = diffLines(root, base, head);

  const engine = resolveEngine(effective, codex ? { codex } : {});
  if (engine.problem) return { status: 'unsatisfied', pr: n, repo, head, reason: engine.problem };
  let plan = buildPlan({
    head, base, changes, addedLines, removedFiles, config: effective, harnessChanged: [...new Set(harnessChanged)],
    engine: { name: engine.reviewer.name, kind: engine.reviewer.kind, stage: engine.reviewer.stage, agent: engine.reviewer.agent },
  });
  if (review.planCommand) {
    const project_ = runPlanCommand(review.planCommand, { base, head, changes }, { root, env: cleanEnv, baseTip });
    plan = mergePlans(plan, project_);
  }
  // --with-bot (the skill's --await-codex): the review bot runs as the last stage too, after this machine's engine.
  if (opts.withBot && plan.depth !== 'none' && config.github.reviewer !== null && !plan.stages.some((stage) => stage.passes.some((pass) => pass.reviewer === 'pr-bot'))) {
    plan.stages = [...plan.stages.filter((stage) => stage.name !== 'remote'), { name: 'remote', passes: [...(plan.stages.find((stage) => stage.name === 'remote')?.passes ?? []), { id: 'engine:pr-bot', reviewer: 'pr-bot', kind: 'remote', files: null, context: 'full' }] }];
  }
  plan.engine = { name: engine.reviewer.name, reason: engine.reason };
  const { lines } = classify(changes, review);
  if (plan.depth !== 'none' && lines > MAX_LINES) return { status: 'too_large', pr: n, repo, head, lines, reason: `${lines} changed lines is past ${MAX_LINES}: split the pull request` };

  // The flows' invariants: a flow the base defines reads its doc from the base, so the change under review cannot
  // rewrite it; a flow the change adds reads it from the head, the only place it exists.
  const readAt = (commit) => (file) => fileAt(root, commit, file);
  for (const flow of plan.flows) {
    if (flow.id === HARNESS_FLOW) Object.assign(flow, { invariants: [HARNESS_INVARIANT], unspecified: false, signoff: 'human' });
    else Object.assign(flow, invariantsOf(review.flows[flow.id] ?? {}, readAt(baseReview?.flows?.[flow.id] ? baseTip : head)));
  }

  const map = reviewerMap(effective);
  const passes = plan.stages.flatMap((stage) => stage.passes);
  // A pass nobody can run would never finish and never block: refuse the plan instead.
  const orphan = passes.find((pass) => pass.kind !== 'agent' && !map[pass.reviewer]);
  if (orphan) return { status: 'unsatisfied', pr: n, repo, head, reason: `pass ${orphan.id} names reviewer "${orphan.reviewer}", which is not an agent pass or a reviewer of review.reviewers`, plan };
  for (const word of plan.require) {
    if (!satisfies(word, passes, map)) return { status: 'unsatisfied', pr: n, repo, head, reason: `the plan requires ${word}, and the engine here is ${engine.reviewer.name} (${engine.reason})`, plan };
  }
  // A flow's deleted test stops the review whatever else the change does, even when nothing else needs a review.
  const removedTests = [];
  for (const [id, definition] of Object.entries(review.flows)) {
    const tests = (definition.tests ?? []).map(globPattern);
    const gone = changes.filter((each) => each.status === 'D' && tests.some((pattern) => pattern.test(each.file))).map((each) => each.file);
    if (gone.length) removedTests.push({ flow: id, deleted: gone, accept: `aidrian pr signoff ${n} --flow ${id} --head ${head}` });
  }
  if (!passes.length && !removedTests.length) return { status: 'none_needed', pr: n, repo, head, base, depth: plan.depth, engine: plan.engine, plan: { depth: plan.depth, reasons: plan.reasons, flows: [], stages: [] } };

  // The record so far: the newer of this machine's and the pull request's.
  const comments = gh.comments(repo, n);
  const summary = comments.filter((comment) => isSummary(comment.body)).at(-1) ?? null;
  let state = newer(readLocalState(project, n), stateFromComment(summary?.body, n)) ?? emptyState(n, repo);
  const maxRounds = opts.maxRounds ?? config.github.maxReviewRounds;

  // A pass's result counts for this head when it is for this head, or for an earlier one the change since does not
  // touch and that left nothing open.
  const deltaCache = new Map();
  const delta = (from) => {
    if (!deltaCache.has(from)) deltaCache.set(from, isAncestor(root, from, head) ? changedFiles(root, from, head) : null);
    return deltaCache.get(from);
  };
  const resultFor = (pass) => {
    const result = state.passes[pass.id];
    if (!result) return null;
    if (result.head === head) return result;
    const since = delta(result.head);
    return since && !touches(since, pass.files) && result.open === 0 ? result : null;
  };
  const verdictsFor = (flowId) => passes.filter((pass) => (pass.flows ?? []).includes(flowId)).flatMap((pass) => {
    const result = resultFor(pass);
    return (result?.verdicts ?? []).filter((verdict) => verdict.flow === flowId).map((verdict) => ({ ...verdict, at: result.head }));
  });
  const flowStatus = (flow) => flowState(flow.invariants, verdictsFor(flow.id), (evidence) => citationProblem(evidence, { root, head }));

  // Every pass after the local stage answers for every flow: a violated from any reviewer blocks the flow, and a flow
  // only the independent model reviews is signed by it.
  for (const stage of plan.stages) if (stage.name !== 'local') for (const pass of stage.passes) pass.flows = plan.flows.map((flow) => flow.id);

  const finalStage = plan.stages.at(-1) ?? null;
  const current = state.rounds.at(-1);
  const newRound = current?.head !== head;
  // The last round runs the final stage first, so an independent review always happens before the cap. A round that
  // started as the last one stays the last one on every later call for the same head.
  const lastRound = newRound ? state.rounds.length + 1 === maxRounds : Boolean(current?.final);
  const roundsBefore = state.rounds.length;
  let opened = !newRound;
  let recorded = false;
  const openRound = () => {
    if (opened) return null;
    if (state.rounds.length >= maxRounds) return 'round_limit';
    state.rounds.push({ head, at: new Date().toISOString(), ...(lastRound ? { final: true } : {}) });
    if (lastRound && plan.stages.length > 1 && finalStage) state.overrides = [...new Set([...state.overrides, `round ${maxRounds} ran the ${finalStage.name} stage first`])];
    opened = true;
    return null;
  };
  // A run that produced nothing (a failure, a quota stop) gives its round back.
  const undoRound = () => {
    if (newRound && !recorded) state.rounds.length = roundsBefore;
  };

  // In the last round the final stage runs first and is judged last, once the earlier stages' verdicts are in.
  const order = lastRound && plan.stages.length > 1 && finalStage ? [{ stage: finalStage, runOnly: true }, ...plan.stages.map((stage) => ({ stage }))] : plan.stages.map((stage) => ({ stage }));
  for (const { stage, runOnly } of order) {
    const pending = stage.passes.filter((pass) => !resultFor(pass));
    if (pending.length) {
      if (openRound() === 'round_limit') return finish('round_limit', { max_rounds: maxRounds });
      const execs = pending.filter((pass) => map[pass.reviewer]?.kind === 'exec');
      if (execs.length) {
        if (resolve(root, 'HEAD') !== head || !isClean(root)) {
          undoRound();
          return finish('incomplete', { reason: `a local reviewer reads the checkout: check out ${head.slice(0, 7)} with a clean working tree first`, retry_recommended: true });
        }
        const outcomes = await Promise.all(execs.map((pass) => exec(map[pass.reviewer], passInput(pass, stage), { root, env: cleanEnv }).then((outcome) => [pass, outcome])));
        for (const [pass, outcome] of outcomes) {
          if (outcome.status !== 'done') continue;
          state.passes[pass.id] = { head, reviewer: pass.reviewer, findings: outcome.findings.length, open: outcome.findings.length, list: outcome.findings, verdicts: outcome.verdicts, dropped: outcome.dropped };
          recorded = true;
        }
        const quota = outcomes.find(([, outcome]) => outcome.status === 'quota');
        if (quota) {
          undoRound();
          return finish('blocked_quota', { reason: quota[1].reason, pass: quota[0].id });
        }
        const failed = outcomes.find(([, outcome]) => outcome.status !== 'done');
        if (failed) {
          const key = `${head}:${failed[0].id}`;
          state.failures[key] = (state.failures[key] ?? 0) + 1;
          const stuck = state.failures[key] >= MAX_ATTEMPTS;
          undoRound();
          return finish(stuck ? 'stuck' : 'incomplete', { reason: `${failed[0].id}: ${failed[1].reason}`, attempts: state.failures[key], retry_recommended: !stuck });
        }
      }
      const remote = pending.find((pass) => map[pass.reviewer]?.kind === 'remote');
      if (remote) {
        const wait = awaitBot ?? (await import('../pr-await-review.mjs')).awaitReview;
        const bot = await wait({ pr: String(n), repo, head: null, request: true, reviewer: config.github.reviewer, timeoutSec: opts.timeoutSec ?? 840, intervalSec: 60, maxRounds: Number.MAX_SAFE_INTEGER }, {});
        if (bot.status === 'timed_out' || bot.status === 'blocked_quota') {
          if (!bot.requested) undoRound();
          return finish(bot.status, { bot });
        }
        const open = bot.signal?.kind === 'thumbs_up' ? 0 : Math.max(1, bot.signal?.line_comments ?? 0);
        state.passes[remote.id] = { head, reviewer: remote.reviewer, findings: open, open, bot: { kind: bot.signal?.kind ?? null, review_id: bot.signal?.review_id ?? null } };
        recorded = true;
      }
      const agents = pending.filter((pass) => map[pass.reviewer]?.kind === 'agent' || pass.kind === 'agent');
      if (agents.length) {
        recorded = true;
        return finish('dispatch', { stage: stage.name, dispatch: agents.map((pass) => dispatchFor(pass, stage)) });
      }
    }
    if (runOnly) continue;
    const open = stage.passes.map((pass) => [pass, resultFor(pass)]).filter(([, result]) => result?.open > 0);
    const unsigned = plan.flows.filter((flow) => stage.passes.some((pass) => (pass.flows ?? []).includes(flow.id))).map((flow) => [flow, flowStatus(flow)]).filter(([, status]) => !status.signed);
    if (open.length || unsigned.length) {
      // A fix needs a new head, and in the last round there is none left: that is the cap, with the work named.
      return finish(lastRound ? 'round_limit' : 'fix_required', {
        stage: stage.name,
        open: open.map(([pass, result]) => ({ pass: pass.id, reviewer: pass.reviewer, head: result.head, open: result.open, findings: result.list ?? null })),
        flows: unsigned.map(([flow, status]) => ({ flow: flow.id, violated: status.open, unverified: status.unverified })),
      });
    }
  }
  // Evidence beyond the reviewers: no flow test deleted without the Human's word, and the required checks of the
  // flows the change touches passed on this head.
  const unaccepted = removedTests.filter((each) => state.signoffs[each.flow]?.head !== head);
  if (unaccepted.length) return finish(lastRound ? 'round_limit' : 'fix_required', { stage: 'evidence', tests_removed: unaccepted });
  const wanted = [...new Set(plan.flows.flatMap((flow) => review.flows[flow.id]?.checks ?? []))];
  if (wanted.length) {
    const rows = gh.checks(repo, n).filter((row) => wanted.some((part) => row.name.includes(part)));
    const verdict = computeVerdict(rows, { requiredChecks: wanted });
    if (verdict.verdict === 'pending') return finish('checks_pending', { checks: verdict.pending });
    if (verdict.verdict === 'failing') return finish(lastRound ? 'round_limit' : 'fix_required', { stage: 'evidence', checks_failing: [...verdict.failing, ...(verdict.unexpected_skips ?? [])] });
  }
  const human = plan.flows.filter((flow) => flow.signoff === 'human' && state.signoffs[flow.id]?.head !== head);
  if (human.length) return finish('human_required', { flows: human.map((flow) => flow.id), command: human.map((flow) => `aidrian pr signoff ${n} --flow ${flow.id} --head ${head}`) });
  return finish('received', {});

  // The input every reviewer of a pass reads.
  function passInput(pass, stage) {
    const prior = resultFor(pass) ?? state.passes[pass.id];
    const from = prior && prior.head !== head && isAncestor(root, prior.head, head) ? prior.head : base;
    const flows = plan.flows.filter((flow) => (pass.flows ?? []).includes(flow.id) || stage.name !== 'local').map((flow) => ({
      id: flow.id,
      invariants: flow.invariants,
      files: flow.files,
      ...(stage.name !== 'local' ? { earlierVerdicts: verdictsFor(flow.id) } : {}),
    }));
    return { pr: n, repo, base: from, head, context: from === base ? 'full' : 'delta', files: pass.files, flows, priorFindings: prior?.list ?? [] };
  }

  function dispatchFor(pass, stage) {
    const input = passInput(pass, stage);
    return {
      pass: pass.id,
      agent: map[pass.reviewer]?.agent ?? pass.reviewer,
      ...input,
      record: `aidrian pr attest ${n} --pass ${pass.id} --head ${head} --reviewer ${pass.reviewer} --findings <n> --fixed <n> [--accepted <n>]${input.flows.length ? ' --verdicts <file.json>' : ''}`,
    };
  }

  function finish(status, extra) {
    const result = { status, pr: n, repo, head, base, depth: plan.depth, round: state.rounds.length, max_rounds: maxRounds, engine: plan.engine, ...extra };
    {
      writeLocalState(project, state);
      const body = summaryBody(state, { ...plan, flows: plan.flows.map((flow) => ({ ...flow, signed: flowStatus(flow).signed })) }, status);
      try {
        if (summary) gh.edit(repo, summary.id, body);
        else gh.post(repo, n, body);
      } catch (error) {
        result.summary_error = error.message;
      }
    }
    result.plan = { depth: plan.depth, reasons: plan.reasons, flows: plan.flows.map((flow) => flow.id), stages: plan.stages.map((stage) => ({ name: stage.name, passes: stage.passes.map((pass) => pass.id) })) };
    return result;
  }
}

// The record to change: the newer of this machine's and the pull request's (`remote`, from its summary comment), so
// a write never builds on a stale copy.
function current(project, pr, repo, remote) {
  return newer(readLocalState(project, pr), remote) ?? emptyState(pr, repo);
}

// The record the pull request's summary comment carries, or null when it cannot be read (offline: the local record).
export function remoteState(repo, pr, gh = defaultGh) {
  try {
    return stateFromComment(gh.comments(repo, pr).filter((comment) => isSummary(comment.body)).at(-1)?.body, pr);
  } catch {
    return null;
  }
}

// `aidrian pr attest <PR> --pass <id> ...`: one pass's result, for this head, into the review record.
export function recordPass(project, { pr, repo, pass, head, reviewer, findings, fixed, accepted = 0, verdictsText = null, remote = null }) {
  if (fixed + accepted > findings) throw new Error('--fixed and --accepted together cannot exceed --findings');
  const verdicts = verdictsText === null ? [] : parseVerdicts(verdictsText);
  const state = current(project, pr, repo, remote);
  const before = state.passes[pass];
  state.passes[pass] = { head, reviewer, findings, open: findings - fixed - accepted, verdicts, list: before?.head === head ? before.list : null };
  writeLocalState(project, state);
  return state.passes[pass];
}

// `aidrian pr signoff <PR> --flow <id> --head <sha>`: the Human's sign-off of a flow on a head. An audit entry, not
// proof: the summary comment shows it, and who ran it.
export function recordSignoff(project, { pr, repo, flow, head, by, remote = null }) {
  const state = current(project, pr, repo, remote);
  state.signoffs[flow] = { head, by, at: new Date().toISOString() };
  writeLocalState(project, state);
  return state.signoffs[flow];
}


// The CLI body of `aidrian pr review [PR] [--with-bot] [--max-rounds N] [--timeout-sec S]`: prints the step's JSON, returns its exit code.
export async function runReview(args, config, project, deps = {}) {
  try {
    const opts = { pr: null, maxRounds: undefined, timeoutSec: undefined, withBot: false };
    for (let i = 0; i < args.length; i += 1) {
      const a = args[i];
      const value = () => {
        const next = args[++i];
        if (next === undefined) throw new Error(`${a} needs a value`);
        return next;
      };
      if (a === '--with-bot') opts.withBot = true;
      else if (a === '--max-rounds') opts.maxRounds = Number(value());
      else if (a === '--timeout-sec') opts.timeoutSec = Number(value());
      else if (a.startsWith('--')) throw new Error(`unknown argument: ${a}`);
      else if (opts.pr === null) opts.pr = a.replace(/^#/u, '');
      else throw new Error(`unexpected argument: ${a}`);
    }
    if (opts.maxRounds !== undefined && !(Number.isInteger(opts.maxRounds) && opts.maxRounds >= 1)) throw new Error('--max-rounds must be an integer >= 1');
    if (opts.timeoutSec !== undefined && !(Number.isFinite(opts.timeoutSec) && opts.timeoutSec >= 0)) throw new Error('--timeout-sec must be >= 0');
    const { roundCapProblem } = await import('../pr-await-review.mjs');
    const capped = opts.maxRounds === undefined ? null : roundCapProblem(opts.maxRounds, config.github.maxReviewRounds, deps.env ?? process.env);
    if (capped) throw new Error(capped);
    const result = await reviewStep(opts, { project, config, ...deps });
    if (result.status === 'round_limit') {
      const { recordSignal, roundLimitSignal } = await import('../lesson-signals.mjs');
      const env = deps.env ?? process.env;
      recordSignal(project, roundLimitSignal({ repo: result.repo, pr: result.pr, maxRounds: result.max_rounds, rounds: result.round, session: env.CLAUDE_CODE_SESSION_ID || null, agent: env.CLAUDE_CODE_AGENT || null }), { config });
    }
    console.log(JSON.stringify(result, null, 2));
    return EXIT[result.status] ?? 1;
  } catch (error) {
    console.error(`aidrian pr review: ${error.message}`);
    return 1;
  }
}
