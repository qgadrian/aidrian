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
// block it forever. A failed reviewer run makes its pull request incomplete; any incomplete one makes the whole run exit
// 2, never a pass. It costs two full reviews per pull request: run it by hand, not in CI.

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
  const query = `query($o:String!,$r:String!,$n:Int!,$after:String){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{isResolved comments(first:1){nodes{path line originalLine originalCommit{oid} author{login}}}}}}}}`;
  // Every page of threads: a pull request with more than 100 would otherwise lose problems from the denominator.
  const threads = [];
  let after = null;
  do {
    const page = JSON.parse(runGh(['api', 'graphql', '-f', `query=${query}`, '-F', `o=${owner}`, '-F', `r=${name}`, '-F', `n=${n}`, ...(after ? ['-f', `after=${after}`] : [])])).data.repository.pullRequest.reviewThreads;
    threads.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  const problems = [];
  const seen = [];
  for (const thread of threads) {
    const comment = thread.comments.nodes[0];
    if (!comment || !thread.isResolved) continue;
    const isBot = comment.author?.login === bot || comment.author?.login === bot.replace(/\[bot\]$/u, '');
    problems.push({ source: isBot ? 'bot' : 'human', file: comment.path, line: comment.originalLine ?? comment.line ?? null });
    if (comment.originalCommit?.oid) seen.push(comment.originalCommit.oid);
  }
  // The earliest commit any resolved thread was opened on, bot or person: the code before any reported bug was fixed.
  const first = seen.find((oid) => seen.every((other) => other === oid || runGit(['merge-base', '--is-ancestor', oid, other], root).status === 0)) ?? seen[0] ?? null;
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
export async function reviewAt(root, reviewer, { base, head, changes, roots, split, env }) {
  const sorted = classify(changes);
  const reviewed = changes.filter((change) => sorted.behaviour.includes(change.file) || sorted.nonBehaviour.includes(change.file));
  const manifest = changes.map((change) => ({ file: change.file, status: change.status, added: change.added, removed: change.removed }));
  const input = (extra) => ({ pr: null, repo: null, base, head, context: 'full', flows: [], priorFindings: [], ...extra });
  // A failed run is not a review that found nothing: it makes the sample incomplete, and the bench does not pass.
  const done = (outcome, what) => {
    if (outcome.status !== 'done') throw Object.assign(new Error(`${what}: ${outcome.status}: ${outcome.reason ?? ''}`), { incomplete: true });
    return outcome;
  };
  if (!split) return done(await runExec(reviewer, input({ files: null }), { root, env }), 'single pass').findings;
  const passes = splitPasses(reviewer.name, partition(reviewed, roots, SPLIT_DEFAULTS), { kind: 'exec' });
  const results = new Map();
  const slices = passes.filter((pass) => pass.role === 'slice');
  for (let i = 0; i < slices.length; i += SPLIT_DEFAULTS.parallel) {
    const batch = slices.slice(i, i + SPLIT_DEFAULTS.parallel);
    const outcomes = await Promise.all(batch.map((pass) => runExec(reviewer, input({ role: 'slice', slice: pass.slice, files: pass.files, manifest }), { root, env })));
    batch.forEach((pass, j) => results.set(pass.id, done(outcomes[j], pass.id)));
  }
  const cross = await runExec(reviewer, input({
    role: 'cross', files: null, manifest,
    slices: slices.map((pass) => ({ id: pass.id, slice: pass.slice, files: pass.files, ...results.get(pass.id) })),
  }), { root, env });
  return [...[...results.values()].flatMap((each) => each.findings), ...done(cross, 'cross pass').findings];
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
      const incomplete = [];
      for (const n of values.prs.split(',').map((each) => Number(each.trim()))) {
        const info = JSON.parse(runGh(['pr', 'view', String(n), '-R', repo, '--json', 'headRefOid,baseRefName,mergedAt']));
        // The base the pull request was opened against, not today's base tip: once merged, its head is an ancestor of
        // the base branch, and a merge base with the tip would be the head itself.
        const baseSha = JSON.parse(runGh(['api', `repos/${repo}/pulls/${n}`])).base.sha;
        runGit(['fetch', '-q', 'origin', `pull/${n}/head`, info.baseRefName, baseSha], root, { timeout: 120_000 });
        const base = mergeBase(root, baseSha, info.headRefOid);
        const { problems, reviewedAt } = knownProblems(root, repo, n, config.github.reviewer ?? '', { ...info, base, head: info.headRefOid });
        const at = mergeBase(root, base, reviewedAt) === base ? reviewedAt : info.headRefOid;
        const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-bench-'));
        const tree = path.join(dir, 'tree');
        runGit(['worktree', 'add', '--detach', '--quiet', tree, at], root, { timeout: 120_000 });
        try {
          const changes = changedFiles(tree, base, at);
          const roots = packageRoots(runGit(['ls-tree', '-r', '--name-only', at], tree, { timeout: 30_000 }).stdout.split('\n').filter(Boolean));
          const context = { base, head: at, changes, roots, env };
          if (!changes.length) throw Object.assign(new Error('the replayed change is empty'), { incomplete: true });
          const single = await reviewAt(tree, reviewer, { ...context, split: false });
          const split = await reviewAt(tree, reviewer, { ...context, split: true });
          results.push({ pr: n, reviewed: at, problems: problems.length, single: recall(problems, single), split: recall(problems, split) });
          console.error(`#${n}: ${problems.length} known problems; single ${JSON.stringify(results.at(-1).single)}; split ${JSON.stringify(results.at(-1).split)}`);
        } catch (error) {
          if (!error.incomplete) throw error;
          incomplete.push({ pr: n, reason: error.message });
          console.error(`#${n}: incomplete: ${error.message}`);
          continue;
        } finally {
          runGit(['worktree', 'remove', '--force', tree], root, { timeout: 60_000 });
          rmSync(dir, { recursive: true, force: true });
        }
      }
      const outcome = verdict(results, Number(values.tolerance ?? 1));
      // An incomplete sample, or none at all, is no evidence either way: exit 2, never a pass.
      const complete = incomplete.length === 0 && results.length > 0;
      console.log(JSON.stringify({ results, incomplete, ...outcome, passes: complete && outcome.passes, tolerance: Number(values.tolerance ?? 1), settings: { ...SPLIT_DEFAULTS } }, null, 2));
      return complete ? (outcome.passes ? 0 : 1) : 2;
    },
  },
};
