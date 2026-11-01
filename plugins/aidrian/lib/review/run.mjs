// `aidrian pr review [PR]`: run a pull request's review plan one step at a time. Every call plans the review for the
// pull request's head, reads what has happened so far, does the next thing it can do itself (run an exec reviewer, ask
// the review bot), and returns the next action. Calling it again is always safe. The review skill is a loop around it:
//
//   running         a split review ran some of its slices: call again for the rest
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
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runGh } from '../gh.mjs';
import { runGit } from '../git.mjs';
import { markerFor } from '../review-gate.mjs';
import { isolate } from './env.mjs';
import { changedFiles, diffLines, fileAt, isAncestor, isClean, mergeBase, resolve } from './diff.mjs';
import { checkReview } from './config.mjs';
import { citationProblem, flowState, invariantsOf, parseVerdicts } from './flows.mjs';
import { computeVerdict } from '../pr-checks.mjs';
import { isDirectory } from '../fs.mjs';
import { dedupe, packageRoots } from './split.mjs';
import { buildPlan, classify, flowsInForce, HARNESS_FLOW, mergePlans, pathPattern, validatePlan } from './plan.mjs';
import { BUILT_IN, resolveEngine, reviewerMap, runExec, satisfies } from './reviewers.mjs';
import { emptyState, isSummary, newer, readLocalState, stateFromComment, summaryBody, writeLocalState } from './state.mjs';

export const EXIT = Object.freeze({
  dispatch: 0, running: 0, fix_required: 0, received: 0, none_needed: 0, human_required: 9,
  timed_out: 2, checks_pending: 2, blocked_quota: 3, round_limit: 4, unsatisfied: 6, incomplete: 7, stuck: 8, too_large: 8,
});
export const MAX_ATTEMPTS = 3;
// The folders of installed dependencies linked into a base worktree.
export const DEPENDENCY_DIRS = Object.freeze(['node_modules', 'vendor', '.venv', 'venv']);
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
  // The check runs of one commit, as `gh pr checks` rows: the evidence must be for the head under review.
  checks: (repo, sha) => JSON.parse(runGh(['api', `repos/${repo}/commits/${sha}/check-runs`, '--paginate', '--slurp']) || '[]')
    .flatMap((page) => page.check_runs ?? [])
    .map((run) => ({ name: run.name, state: run.status === 'completed' ? String(run.conclusion ?? 'unknown').toUpperCase() : 'PENDING' })),
};

// The `review` config in force: the base branch's, which a pull request cannot weaken, plus what the head adds.
// `changed` lists the review settings the head changes, which trigger the harness-config flow.
export function reviewInForce(baseReview, headReview) {
  if (!baseReview) {
    const pending = Object.fromEntries(Object.entries(headReview.reviewers).map(([name, reviewer]) => [name, { ...reviewer, pending: true }]));
    return { review: { ...headReview, engine: null, planCommand: null, reviewers: pending }, changed: ['engine', 'planCommand', 'reviewers'].filter((key) => JSON.stringify(key === 'engine' ? headReview.engine ?? null : headReview[key]) !== JSON.stringify(key === 'reviewers' ? {} : null)) };
  }
  const changed = [];
  for (const key of ['engine', 'rules', 'ignore', 'nonBehaviour', 'flows', 'planCommand', 'reviewers', 'split']) {
    if (JSON.stringify(baseReview[key]) !== JSON.stringify(headReview[key])) changed.push(key);
  }
  return {
    review: {
      ...headReview,
      rules: [...baseReview.rules, ...headReview.rules.filter((rule) => !baseReview.rules.some((each) => JSON.stringify(each) === JSON.stringify(rule)))],
      ignore: baseReview.ignore,
      nonBehaviour: baseReview.nonBehaviour,
      split: baseReview.split,
      // The project's engine is policy, like the plan command: a pull request's own pick runs once it is merged.
      engine: baseReview.engine ?? null,
      flows: flowsInForce(baseReview.flows, headReview.flows),
      // The plan command and the reviewers a project defines are code: only the base branch's run. A head may add a
      // reviewer under a new name, never redefine one, and a plan command it adds runs once it is merged.
      planCommand: baseReview.planCommand,
      reviewers: {
        ...Object.fromEntries(Object.entries(headReview.reviewers).filter(([name]) => !Object.hasOwn(baseReview.reviewers, name)).map(([name, reviewer]) => [name, { ...reviewer, pending: true }])),
        ...baseReview.reviewers,
      },
    },
    changed,
  };
}

// The `review` group of the project config at `commit`, or null when that commit has no config.
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

// A temporary worktree of the base tip, for running the project's own review code (a plan command, an exec
// reviewer) as the base branch has it: a pull request that edits that code cannot run its own version. The worktree
// shares the repository's objects, so the code can still read the head with git. `use(dir)` runs inside it.
async function inBaseWorktree(root, baseTip, use) {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-base-'));
  const tree = path.join(dir, 'base');
  const added = runGit(['worktree', 'add', '--detach', '--quiet', tree, baseTip], root, { timeout: 60_000 });
  if (added.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`could not check out the base to run the project's review code: ${(added.stderr || '').trim()}`);
  }
  // The checkout's installed dependencies, linked in, so base code that imports them runs. They are the checkout's
  // install, not the base's: the code is pinned to the base, its packages to what this machine has.
  for (const name of DEPENDENCY_DIRS) {
    if (isDirectory(path.join(root, name)) && !existsSync(path.join(tree, name))) symlinkSync(path.join(root, name), path.join(tree, name));
  }
  try {
    return await use(tree);
  } finally {
    runGit(['worktree', 'remove', '--force', tree], root, { timeout: 60_000 });
    rmSync(dir, { recursive: true, force: true });
  }
}

// A planCommand's plan: it reads { base, head, changes } on stdin and prints a plan. It runs in a worktree of the
// base, with an env isolated like a reviewer's.
function runPlanCommand(command, input, { root, env, baseTip }) {
  return inBaseWorktree(root, baseTip, (tree) => {
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
  });
}

// The files tracked at `commit`.
function trackedAt(root, commit) {
  const result = runGit(['ls-tree', '-r', '--name-only', '-z', commit], root, { timeout: 30_000, maxBuffer: 256 * 1024 * 1024 });
  return result.status === 0 ? result.stdout.split('\0').filter(Boolean) : [];
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
  // The head's review config is read from the head commit, not this checkout, which may be on another branch; only
  // machine settings (the engine) come from the checkout.
  const baseReview = baseReviewAt(project, baseTip);
  const headReview = baseReviewAt(project, head) ?? checkReview({}, project.paths.config, []);
  const { review, changed } = reviewInForce(baseReview, headReview);
  const effective = { ...config, review };
  const changes = changedFiles(root, base, head);
  const changedPaths = new Set(changes.map((change) => change.file));
  const harnessChanged = [];
  if (changed.length && changedPaths.has(project.paths.config)) harnessChanged.push(project.paths.config);
  for (const file of commandFiles(root, review.planCommand, baseTip)) if (changedPaths.has(file)) harnessChanged.push(file);
  for (const flow of Object.values(baseReview?.flows ?? {})) if (typeof flow.invariants === 'string' && changedPaths.has(flow.invariants)) harnessChanged.push(flow.invariants);
  for (const reviewer of Object.values(baseReview?.reviewers ?? {})) {
    for (const file of commandFiles(root, (reviewer.command ?? []).join(' '), baseTip)) if (changedPaths.has(file)) harnessChanged.push(file);
  }
  const { addedLines, removedFiles } = diffLines(root, base, head);

  // The record so far: the newer of this machine's and the pull request's. With config.json `review.record: "local"`
  // the pull request is never read or written: the record is this machine's state folder only.
  const onPr = config.review.record !== 'local';
  const summary = onPr ? gh.comments(repo, n).filter((comment) => isSummary(comment.body)).at(-1) ?? null : null;
  let state = newer(readLocalState(project, n), stateFromComment(summary?.body, n)) ?? emptyState(n, repo);

  const engine = resolveEngine(effective, codex ? { codex } : {});
  if (engine.problem) return { status: 'unsatisfied', pr: n, repo, head, reason: engine.problem };
  const planFor = (minDepth) => buildPlan({
    head, base, changes, addedLines, removedFiles, config: effective, harnessChanged: [...new Set(harnessChanged)],
    roots: packageRoots(trackedAt(root, head)), halved: state.halved ?? {},
    engine: { name: engine.reviewer.name, kind: engine.reviewer.kind, stage: engine.reviewer.stage, agent: engine.reviewer.agent, builtIn: Boolean(BUILT_IN[engine.reviewer.name]) },
    minDepth,
  });
  let plan = planFor('none');
  if (review.planCommand) {
    const project_ = await runPlanCommand(review.planCommand, { base, head, changes }, { root, env: cleanEnv, baseTip });
    // A plan command that raises the depth to split gets the slices too: the built-in plan is rebuilt at that depth.
    if (project_.depth === 'split' && plan.depth !== 'split') plan = planFor('split');
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
  // Every pass after the local stage answers for every flow: a violated from any reviewer blocks the flow, and a flow
  // only the independent model reviews is signed by it. The review bot gives no verdicts, so a flow needs another
  // pass that can answer for it.
  for (const stage of plan.stages) if (stage.name !== 'local') for (const pass of stage.passes) pass.flows = plan.flows.map((flow) => flow.id);
  for (const word of plan.require) {
    if (!satisfies(word, passes, map)) return { status: 'unsatisfied', pr: n, repo, head, reason: `the plan requires ${word}, and the engine here is ${engine.reviewer.name} (${engine.reason})`, plan };
  }
  // A flow's deleted test stops the review whatever else the change does, even when nothing else needs a review.
  const removedTests = [];
  for (const [id, definition] of Object.entries(review.flows)) {
    const tests = (definition.tests ?? []).map(pathPattern);
    const gone = changes.filter((each) => each.status === 'D' && tests.some((pattern) => pattern.test(each.file))).map((each) => each.file);
    if (gone.length) removedTests.push({ flow: id, deleted: gone, accept: `aidrian pr signoff ${n} --flow ${id} --head ${head}` });
  }
  const answerless = plan.flows.find((flow) => !passes.some((pass) => (pass.flows ?? []).includes(flow.id) && map[pass.reviewer]?.kind !== 'remote'));
  if (answerless) return { status: 'unsatisfied', pr: n, repo, head, reason: `flow ${answerless.id} needs a reviewer that answers its invariants, and the review bot does not: run codex-local, or require an agent for the flow`, plan };
  if (!passes.length && !removedTests.length) return { status: 'none_needed', pr: n, repo, head, base, depth: plan.depth, engine: plan.engine, plan: { depth: plan.depth, reasons: plan.reasons, flows: [], stages: [] } };

  const maxRounds = opts.maxRounds ?? config.github.maxReviewRounds;

  // A pass's result counts for this head when it is for this head, or for an earlier one the change since does not
  // touch and that left nothing open.
  const deltaCache = new Map();
  const delta = (from) => {
    if (!deltaCache.has(from)) deltaCache.set(from, isAncestor(root, from, head) ? changedFiles(root, from, head) : null);
    return deltaCache.get(from);
  };
  // A pass with a file list (a slice, a flow pass) keeps its history only while it covers the same files: when a fix
  // repacks slices, a slice's earlier result and findings are another set of files' and count for nothing.
  const sameFiles = (pass, result) => !Array.isArray(pass.files) || JSON.stringify([...pass.files].sort()) === JSON.stringify(result.files ?? null);
  const resultFor = (pass) => {
    const result = state.passes[pass.id];
    if (!result || !sameFiles(pass, result)) return null;
    if (result.head === head) return result;
    const since = delta(result.head);
    return since && !touches(since, pass.files) && result.open === 0 ? result : null;
  };
  const verdictsFor = (flowId) => passes.filter((pass) => (pass.flows ?? []).includes(flowId)).flatMap((pass) => {
    const result = resultFor(pass);
    return (result?.verdicts ?? []).filter((verdict) => verdict.flow === flowId).map((verdict) => ({ ...verdict, at: result.head }));
  });
  const flowStatus = (flow) => flowState(flow.invariants, verdictsFor(flow.id), (evidence) => citationProblem(evidence, { root, head }));


  // The stage the last round runs first: the last one that needs no earlier result, so never the review bot, which
  // waits for every earlier pass.
  const finalStage = [...plan.stages].reverse().find((stage) => stage.passes.every((pass) => map[pass.reviewer]?.kind !== 'remote')) ?? null;
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
    const unfinished = stage.passes.filter((pass) => !resultFor(pass));
    // A pass runs once the passes it comes after have results: the cross-cutting pass waits for every slice.
    const pending = unfinished.filter((pass) => (pass.after ?? []).every((id) => resultFor(stage.passes.find((each) => each.id === id) ?? { id })));
    if (unfinished.length && !pending.length) return finish('incomplete', { reason: `${unfinished.map((pass) => pass.id).join(', ')} wait for passes that cannot finish`, retry_recommended: false });
    if (pending.length) {
      if (openRound() === 'round_limit') return finish('round_limit', { max_rounds: maxRounds });
      // At most `parallel` local reviewers per step: each runs up to its time limit, and a step must end inside one
      // shell call. The rest run on the next step, which `running` asks for.
      const ready = pending.filter((pass) => map[pass.reviewer]?.kind === 'exec');
      const execs = ready.slice(0, review.split?.parallel ?? 4);
      if (execs.length) {
        if (resolve(root, 'HEAD') !== head || !isClean(root)) {
          undoRound();
          return finish('incomplete', { reason: `a local reviewer reads the checkout: check out ${head.slice(0, 7)} with a clean working tree first`, retry_recommended: true });
        }
        // Codex reads the checkout at the head; a project's own reviewer runs as the base has it, and reads the head
        // through git (its input names both commits).
        const run = (tree) => Promise.all(execs.map((pass) => {
          const reviewer = map[pass.reviewer];
          return exec(reviewer, passInput(pass, stage), { root: reviewer.builtIn ? root : tree, env: cleanEnv }).then((outcome) => [pass, outcome]);
        }));
        const outcomes = execs.some((pass) => !map[pass.reviewer].builtIn) ? await inBaseWorktree(root, baseTip, run) : await run(root);
        for (const [pass, outcome] of outcomes) {
          if (outcome.status !== 'done') continue;
          state.passes[pass.id] = {
            head, reviewer: pass.reviewer, files: Array.isArray(pass.files) ? [...pass.files].sort() : null, findings: outcome.findings.length, open: outcome.findings.length, list: outcome.findings, verdicts: outcome.verdicts,
            ...(pass.role ? { contracts: outcome.contracts ?? [], cross_notes: outcome.cross_notes ?? [] } : {}), dropped: outcome.dropped,
          };
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
        const bot = await wait({ pr: String(n), repo, head, request: true, reviewer: config.github.reviewer, timeoutSec: opts.timeoutSec ?? 840, intervalSec: 60, maxRounds }, { gate });
        if (bot.status === 'review_required') {
          undoRound();
          return finish('incomplete', { reason: bot.reason, retry_recommended: false });
        }
        if (bot.status === 'timed_out' || bot.status === 'blocked_quota' || bot.status === 'round_limit') {
          if (!bot.requested) undoRound();
          return finish(bot.status, { bot });
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
        // What each dispatched pass covers, so its attest records the same files.
        state.dispatched = { ...(state.dispatched ?? {}), ...Object.fromEntries(agents.map((pass) => [pass.id, { head, files: Array.isArray(pass.files) ? [...pass.files].sort() : null }])) };
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
        // One entry per mistake when slices and the cross pass report the same one.
        ...(stage.passes.some((pass) => pass.role) ? { findings_merged: dedupe(open.map(([pass, result]) => [pass.id, result.list ?? []])) } : {}),
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
    const rows = gh.checks(repo, head).filter((row) => wanted.some((part) => row.name.includes(part)));
    const verdict = computeVerdict(rows, { requiredChecks: wanted });
    if (verdict.verdict === 'pending') return finish('checks_pending', { checks: verdict.pending });
    if (verdict.verdict === 'failing') return finish(lastRound ? 'round_limit' : 'fix_required', { stage: 'evidence', checks_failing: [...verdict.failing, ...(verdict.unexpected_skips ?? [])] });
  }
  const human = plan.flows.filter((flow) => flow.signoff === 'human' && state.signoffs[flow.id]?.head !== head);
  if (human.length) return finish('human_required', { flows: human.map((flow) => flow.id), command: human.map((flow) => `aidrian pr signoff ${n} --flow ${flow.id} --head ${head}`) });
  return finish('received', {});

  // The input every reviewer of a pass reads.
  function passInput(pass, stage) {
    const recorded = state.passes[pass.id];
    const prior = resultFor(pass) ?? (recorded && sameFiles(pass, recorded) ? recorded : null);
    const from = prior && prior.head !== head && isAncestor(root, prior.head, head) ? prior.head : base;
    const flows = plan.flows.filter((flow) => (pass.flows ?? []).includes(flow.id) || stage.name !== 'local').map((flow) => ({
      id: flow.id,
      invariants: flow.invariants,
      files: flow.files,
      ...(stage.name !== 'local' ? { earlierVerdicts: verdictsFor(flow.id) } : {}),
    }));
    const checklist = config.github.reviewGate.enabled ? config.github.reviewGate.checklist : null;
    const split = pass.role ? {
      role: pass.role,
      manifest: changes.map((change) => ({ file: change.file, status: change.status, added: change.added, removed: change.removed })),
      ...(pass.role === 'slice' ? { slice: pass.slice } : {}),
      ...(pass.role === 'cross' ? {
        slices: stage.passes.filter((each) => each.role === 'slice').map((each) => {
          const result = resultFor(each);
          return { id: each.id, slice: each.slice, files: each.files, contracts: result?.contracts ?? [], cross_notes: result?.cross_notes ?? [], findings: result?.list ?? [] };
        }),
        interfaceFiles: plan.interfaceFiles ?? [],
      } : {}),
    } : {};
    return {
      ...split,
      pr: n, repo, base: from, head, context: from === base ? 'full' : 'delta', files: pass.files, flows, priorFindings: prior?.list ?? [],
      ...(checklist ? { checklist: { path: checklist, text: fileAt(root, baseTip, checklist) } } : {}),
    };
  }

  function dispatchFor(pass, stage) {
    const input = passInput(pass, stage);
    return {
      pass: pass.id,
      agent: map[pass.reviewer]?.agent ?? pass.reviewer,
      ...(input.checklist ? { brief: `Review the diff against the checklist in ${input.checklist.path} as well as for bugs.` } : {}),
      ...input,
      record: `aidrian pr attest ${n} --pass ${pass.id} --head ${head} --reviewer ${pass.reviewer} --findings <n> --fixed <n> [--accepted <n>]${input.flows.length ? ' --verdicts <file.json>' : ''}`,
    };
  }

  function finish(status, extra) {
    const result = { status, pr: n, repo, head, base, depth: plan.depth, round: state.rounds.length, max_rounds: maxRounds, engine: plan.engine, ...extra };
    writeLocalState(project, state);
    if (onPr) {
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
// With config.json `review.record: "local"` there is no summary comment, and the pull request is not read.
export function remoteState(repo, pr, gh = defaultGh, config = null) {
  if (config?.review.record === 'local') return null;
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
  // An agent slice writes its report to the cross pass in the same file: { verdicts, contracts, cross_notes }.
  let report = {};
  try {
    const raw = verdictsText === null ? null : JSON.parse(verdictsText);
    const strings = (list) => (Array.isArray(list) ? list.filter((each) => typeof each === 'string').slice(0, 50) : []);
    if (raw && !Array.isArray(raw)) report = { contracts: strings(raw.contracts), cross_notes: strings(raw.cross_notes) };
  } catch {}
  const state = current(project, pr, repo, remote);
  const before = state.passes[pass];
  const files = state.dispatched?.[pass]?.files ?? null;
  state.passes[pass] = { head, reviewer, files, findings, open: findings - fixed - accepted, verdicts, ...report, list: before?.head === head ? before.list : null };
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
