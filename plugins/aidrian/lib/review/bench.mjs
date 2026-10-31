// `aidrian review bench --prs <n,n,...> [-R owner/repo] [--engine NAME] [--tolerance N]`: does a split review find as
// much as one pass? It replays merged pull requests whose problems are known and reviews each one twice, once as a
// single pass and once split, at the commit the first review saw. Known problems come from three sources, and recall
// is reported for each:
//   bot     review threads the review bot opened and that were resolved: the bot found it and it was fixed
//   human   review threads a person opened and that were resolved
//   escaped fix: or revert: commits on the base branch within 14 days of the merge that touch a file the pull
//           request changed: a problem every review missed; matched by file only
// A finding matches a problem in the same file within 10 lines (any line for an escaped one). The verdict passes when
// split recall is at least single recall minus `--tolerance` problems (1 by default), so a small sample's noise cannot
// block it forever. It costs two full reviews per pull request: run it by hand, not in CI.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { runGh } from '../gh.mjs';
import { runGit } from '../git.mjs';
import { commandConfig } from '../config.mjs';
import { projectAt } from '../project.mjs';
import { changedFiles, mergeBase } from './diff.mjs';
import { isolate } from './env.mjs';
import { classify } from './plan.mjs';
import { reviewerMap, runExec } from './reviewers.mjs';
import { packageRoots, partition, SPLIT_DEFAULTS, splitPasses } from './split.mjs';

export const LINE_WINDOW = 10;
export const ESCAPE_DAYS = 14;

// Whether `findings` cover `problem`.
export const covers = (findings, problem) =>
  findings.some((finding) => finding.file === problem.file && (problem.line === null || Math.abs(finding.line - problem.line) <= LINE_WINDOW));

// The recall of each source: { bot: { found, total }, ... }.
export function recall(problems, findings) {
  const out = {};
  for (const problem of problems) {
    const entry = (out[problem.source] ??= { found: 0, total: 0 });
    entry.total += 1;
    if (covers(findings, problem)) entry.found += 1;
  }
  return out;
}

const sum = (byPr, key) => byPr.reduce((total, each) => total + Object.values(each[key]).reduce((n, entry) => n + entry.found, 0), 0);

// The verdict over every pull request's result: split passes when it finds at least as many problems as single,
// less the tolerance.
export function verdict(results, tolerance = 1) {
  const single = sum(results, 'single');
  const split = sum(results, 'split');
  const total = results.reduce((n, each) => n + Object.values(each.single).reduce((m, entry) => m + entry.total, 0), 0);
  return { single, split, total, passes: split >= single - tolerance };
}

// The known problems of one merged pull request.
function knownProblems(root, repo, n, bot, info) {
  const [owner, name] = repo.split('/');
  const query = `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100){nodes{isResolved comments(first:1){nodes{path line originalLine originalCommit{oid} author{login}}}}}}}}`;
  const data = JSON.parse(runGh(['api', 'graphql', '-f', `query=${query}`, '-F', `o=${owner}`, '-F', `r=${name}`, '-F', `n=${n}`]));
  const problems = [];
  let first = null;
  for (const thread of data.data.repository.pullRequest.reviewThreads.nodes) {
    const comment = thread.comments.nodes[0];
    if (!comment || !thread.isResolved) continue;
    const isBot = comment.author?.login === bot || comment.author?.login === bot.replace(/\[bot\]$/u, '');
    problems.push({ source: isBot ? 'bot' : 'human', file: comment.path, line: comment.originalLine ?? comment.line ?? null });
    if (isBot && !first) first = comment.originalCommit?.oid ?? null;
  }
  const files = new Set(changedFiles(root, info.base, info.head).map((change) => change.file));
  if (info.mergedAt) {
    const until = new Date(Date.parse(info.mergedAt) + ESCAPE_DAYS * 86_400_000).toISOString();
    const log = runGit(['log', `origin/${info.baseRefName}`, `--since=${info.mergedAt}`, `--until=${until}`, '--format=%H %s', '--name-only'], root, { timeout: 60_000 });
    let fixing = false;
    for (const line of log.stdout.split('\n')) {
      if (/^[0-9a-f]{40} /u.test(line)) fixing = /^[0-9a-f]{40} (fix|revert)(\(|:|!)/iu.test(line);
      else if (fixing && files.has(line)) problems.push({ source: 'escaped', file: line, line: null });
    }
  }
  return { problems, reviewedAt: first ?? info.head };
}

// One review of a commit, as one pass or split: the findings of every pass.
async function reviewAt(root, reviewer, { base, head, changes, roots, split, env }) {
  const sorted = classify(changes);
  const reviewed = changes.filter((change) => sorted.behaviour.includes(change.file) || sorted.nonBehaviour.includes(change.file));
  const manifest = changes.map((change) => ({ file: change.file, status: change.status, added: change.added, removed: change.removed }));
  const input = (extra) => ({ pr: null, repo: null, base, head, context: 'full', flows: [], priorFindings: [], ...extra });
  if (!split) {
    const outcome = await runExec(reviewer, input({ files: null }), { root, env });
    return outcome.status === 'done' ? outcome.findings : [];
  }
  const passes = splitPasses(reviewer.name, partition(reviewed, roots, SPLIT_DEFAULTS), { kind: 'exec' });
  const results = new Map();
  const slices = passes.filter((pass) => pass.role === 'slice');
  for (let i = 0; i < slices.length; i += SPLIT_DEFAULTS.parallel) {
    const batch = slices.slice(i, i + SPLIT_DEFAULTS.parallel);
    const outcomes = await Promise.all(batch.map((pass) => runExec(reviewer, input({ role: 'slice', slice: pass.slice, files: pass.files, manifest }), { root, env })));
    batch.forEach((pass, j) => results.set(pass.id, outcomes[j].status === 'done' ? outcomes[j] : { findings: [], contracts: [], cross_notes: [] }));
  }
  const cross = await runExec(reviewer, input({
    role: 'cross', files: null, manifest,
    slices: slices.map((pass) => ({ id: pass.id, slice: pass.slice, files: pass.files, ...results.get(pass.id) })),
  }), { root, env });
  return [...[...results.values()].flatMap((each) => each.findings), ...(cross.status === 'done' ? cross.findings : [])];
}

export const commands = {
  review: {
    usage: 'bench --prs N[,N...] [-R OWNER/REPO] [--engine NAME] [--tolerance N]',
    about: 'measure whether a split review finds as much as one pass, by replaying merged pull requests with known problems',
    async run(args) {
      const [action, ...rest] = args;
      if (action !== 'bench') {
        console.error(`usage: aidrian review ${commands.review.usage}`);
        return 1;
      }
      const { values } = parseArgs({ args: rest, options: { prs: { type: 'string' }, R: { type: 'string', short: 'R' }, engine: { type: 'string' }, tolerance: { type: 'string' } } });
      if (!values.prs) {
        console.error('aidrian review bench: --prs is required');
        return 1;
      }
      const project = projectAt(process.cwd());
      const config = commandConfig(project);
      const root = project.root;
      const repo = values.R ?? JSON.parse(runGh(['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner;
      const reviewer = reviewerMap(config)[values.engine ?? 'codex-local'];
      if (!reviewer || reviewer.kind !== 'exec') {
        console.error(`aidrian review bench: --engine must name an exec reviewer, such as codex-local`);
        return 1;
      }
      const env = isolate({ ...process.env });
      const results = [];
      for (const n of values.prs.split(',').map((each) => Number(each.trim()))) {
        const info = JSON.parse(runGh(['pr', 'view', String(n), '-R', repo, '--json', 'headRefOid,baseRefName,mergedAt']));
        runGit(['fetch', '-q', 'origin', `pull/${n}/head`, info.baseRefName], root, { timeout: 120_000 });
        const base = mergeBase(root, `origin/${info.baseRefName}`, info.headRefOid);
        const { problems, reviewedAt } = knownProblems(root, repo, n, config.github.reviewer ?? '', { ...info, base, head: info.headRefOid });
        const at = mergeBase(root, base, reviewedAt) === base ? reviewedAt : info.headRefOid;
        const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-bench-'));
        const tree = path.join(dir, 'tree');
        runGit(['worktree', 'add', '--detach', '--quiet', tree, at], root, { timeout: 120_000 });
        try {
          const changes = changedFiles(tree, base, at);
          const roots = packageRoots(runGit(['ls-tree', '-r', '--name-only', at], tree, { timeout: 30_000 }).stdout.split('\n').filter(Boolean));
          const context = { base, head: at, changes, roots, env };
          const single = await reviewAt(tree, reviewer, { ...context, split: false });
          const split = await reviewAt(tree, reviewer, { ...context, split: true });
          results.push({ pr: n, reviewed: at, problems: problems.length, single: recall(problems, single), split: recall(problems, split) });
          console.error(`#${n}: ${problems.length} known problems; single ${JSON.stringify(results.at(-1).single)}; split ${JSON.stringify(results.at(-1).split)}`);
        } finally {
          runGit(['worktree', 'remove', '--force', tree], root, { timeout: 60_000 });
          rmSync(dir, { recursive: true, force: true });
        }
      }
      const outcome = verdict(results, Number(values.tolerance ?? 1));
      console.log(JSON.stringify({ results, ...outcome, tolerance: Number(values.tolerance ?? 1), note: { ...SPLIT_DEFAULTS } }, null, 2));
      return outcome.passes ? 0 : 1;
    },
  },
};
