// Why a reviewer's critical-flow passes ran again, from a project's review records, its checkout, and its dispatch log,
// all read only: a measurement for this repository's maintainers, never shipped in the plugin.
//
//   node scripts/report-flow-reruns.mjs --state <state folder> --project <checkout> [--reviewer product-manager] [--json]
//
// A re-run is a round after a pass's first in which the record shows the pass answered. Each goes to the first group that
// holds (GROUPS): an open finding of the pass was owed a re-check; a file of the pull request's that the pass covers changed
// since the earlier round, by name, as resultFor's delta counts it, so an edit of the base's to such a file counts; the
// pass's file list, or the flows it covers, changed; the base was merged, or the branch was rebased onto a newer one; none
// of these. A record keeps each pass's latest result alone, so a re-run whose pass found nothing and that a later run
// replaced is not seen, and the counts are a floor, as the report says. The file list at a head is the plan's,
// rebuilt from git with the plugin's own planner (lib/review/plan.mjs); the report says how often it equals the recorded.

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { baseBranchTip, committedConfig } from '../plugins/aidrian/lib/config.mjs';
import { runGit } from '../plugins/aidrian/lib/git.mjs';
import { readRows } from '../plugins/aidrian/lib/jsonl.mjs';
import { projectAt } from '../plugins/aidrian/lib/project.mjs';
import { contentFlows } from '../plugins/aidrian/lib/review/content.mjs';
import { changedFiles, diffLines, isAncestor, mergeBase } from '../plugins/aidrian/lib/review/diff.mjs';
import { buildPlan, flowsInForce } from '../plugins/aidrian/lib/review/plan.mjs';

export const GROUPS = ['open finding', 'files touched', 'file list changed', 'base merged', 'none of these'];
// A dispatch of the reviewer for something other than a review pass, by the label the dispatcher gave it.
const OTHER_WORK = /residual|quorum|decision|ruling|\brule\b|\bplan\b|prepare|draft|shape|interview/iu;
const GIT_READ = { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 };
const ENGINE = { name: 'code-reviewer', kind: 'agent', stage: 'local', agent: 'code-reviewer', builtIn: true };

const isPassOf = (reviewer) => (id) => typeof id === 'string' && (id === `agent:${reviewer}` || id.startsWith(`agent:${reviewer}:`) || (id.startsWith('flow:') && id.endsWith(`:${reviewer}`)));
const flowsOf = (id) => {
  const [kind, name, flows] = id.split(':');
  return kind === 'flow' ? [name] : (flows ?? '').split('+').filter(Boolean);
};
const overlaps = (a, b) => a === b || flowsOf(a).some((flow) => flowsOf(b).includes(flow));
const listKey = (files) => JSON.stringify(Array.isArray(files) ? [...files].sort() : null);

// Each round's heads, the ones a quiet push moved it from first.
const headsOf = (round) => [...(round.quiet ?? []).map(({ from }) => from), round.head];

// The rounds in which `record` shows the pass `id` answered, as a Map from the round's index to the head it answered for:
// its result, a finding of its that the round left open, and the heads its findings were seen, placed, and fixed at.
function roundsOf(record, id) {
  const found = new Map();
  const at = (head) => {
    const index = record.rounds.findIndex((round) => headsOf(round).includes(head));
    if (index !== -1 && !found.has(index)) found.set(index, head);
  };
  at(record.passes[id]?.head);
  record.rounds.forEach((round, index) => {
    if ((round.findings ?? []).some((finding) => finding.pass === id) && !found.has(index)) found.set(index, round.head);
  });
  for (const entry of Object.values(record.index ?? {}).filter((each) => each?.pass === id)) {
    for (const head of [entry.seen, entry.placed, entry.state === 'fixed' ? entry.closed_in?.to : null]) at(head);
  }
  return found;
}

// The group of the re-run of pass `id` at `head`, after the round `before`: { group, list, base }, or { unread } with why it
// cannot be told. `list` and `base` say whether the file list changed and the base was merged too, whatever the group.
// `checkout` is readCheckout's, or a stand-in with the same calls.
function groupOf({ record, id, before, head, checkout, mine }) {
  const [then, now] = [checkout.plan(before.head), checkout.plan(head)];
  const planned = now?.passes.find((pass) => pass.id === id);
  const earlier = then?.passes.find((pass) => pass.id === id);
  const list = Boolean(then && planned) && (!earlier || listKey(earlier.files) !== listKey(planned.files));
  const base = Boolean(then && now) && then.base !== now.base;
  const is = (group) => ({ group, list, base });
  const note = record.dispatched?.[id]?.head === head ? record.dispatched[id] : null;
  const owed = (before.findings ?? []).some((finding) => mine(finding.pass) && overlaps(finding.pass, id));
  if (owed || note?.listed?.length) return is('open finding');
  if (!then || !now) return { unread: 'the plan at one of the heads cannot be rebuilt' };
  const result = record.passes[id]?.head === head ? record.passes[id] : note;
  const files = result ? result.files : planned?.files;
  const own = new Set([...then.files, ...now.files]);
  const touched = checkout.changed(before.head, head).filter((file) => own.has(file));
  if (touched.some((file) => !Array.isArray(files) || files.includes(file))) return is('files touched');
  // Without its findings the round cannot say whether one of this pass was open, so nothing below is sure.
  if (!Array.isArray(before.findings) && !Array.isArray(note?.listed)) return { unread: 'the earlier round keeps no findings' };
  if (!planned) return { unread: 'the rebuilt plan lacks the pass' };
  if (list) return is('file list changed');
  if (base) return is('base merged');
  return { ...is('none of these'), rewritten: !checkout.isAncestor(before.head, head) };
}

// The re-runs of `reviewer`'s passes on one review record: { reruns, first, lists }, with `reruns` one row a pass and round
// after the pass's first, { pr, repo, round, pass, from, to, group } or { ..., unread }, `first` the count of first runs, and
// `lists` how many recorded file lists were compared with the rebuilt plan's, and how many were equal.
export function sortReruns(record, checkout, reviewer = 'product-manager') {
  const mine = isPassOf(reviewer);
  const ids = new Set([...Object.keys(record.passes), ...record.rounds.flatMap((round) => (round.findings ?? []).map(({ pass }) => pass)),
    ...Object.values(record.index ?? {}).map((entry) => entry?.pass)].filter(mine));
  const seen = new Map([...ids].map((id) => [id, roundsOf(record, id)]));
  const out = { reruns: [], first: 0, lists: { compared: 0, equal: 0 } };
  for (const [id, rounds] of seen) {
    const result = record.passes[id];
    const rebuilt = result ? checkout.plan(result.head)?.passes.find((pass) => pass.id === id) : null;
    if (rebuilt) {
      out.lists.compared += 1;
      if (listKey(rebuilt.files) === listKey(result.files)) out.lists.equal += 1;
    }
    for (const [index, head] of [...rounds].sort(([a], [b]) => a - b)) {
      const ranAt = (i) => [...seen].some(([other, theirs]) => overlaps(other, id) && theirs.has(i))
        || (checkout.plan(record.rounds[i].head)?.passes ?? []).some((pass) => overlaps(pass.id, id));
      const last = Array.from({ length: index }, (_, i) => index - 1 - i).find(ranAt);
      if (last === undefined) out.first += 1;
      else {
        const before = record.rounds[last];
        out.reruns.push({ pr: record.pr, repo: record.repo, round: index + 1, pass: id, from: before.head, to: head, ...groupOf({ record, id, before, head, checkout, mine }) });
      }
    }
  }
  return out;
}

// The checkout at `root` as sortReruns asks it, every answer read once: `plan(head)`, the pull request's files and the
// reviewer's passes at that head, rebuilt as the review step builds them and `base` the merge base, or null when git
// cannot say; `changed(from, to)`, the files between two heads; `isAncestor(from, to)`.
export function readCheckout(root, reviewer) {
  const project = projectAt(root);
  const tip = baseBranchTip(root);
  const mine = isPassOf(reviewer);
  const once = (read) => {
    const answers = new Map();
    return (...args) => {
      const key = args.join(' ');
      if (!answers.has(key)) answers.set(key, read(...args));
      return answers.get(key);
    };
  };
  // The base branch as it was before a merge brought `head` in: the newest of its own commits that does not hold `head`.
  const merged = runGit(['rev-list', '--first-parent', tip], root, GIT_READ).stdout.split('\n').filter(Boolean);
  const tipBefore = (head) => {
    let [first, past] = [0, merged.length];
    while (first < past) {
      const middle = Math.floor((first + past) / 2);
      if (isAncestor(root, head, merged[middle])) first = middle + 1;
      else past = middle;
    }
    return merged[first];
  };
  const plan = (head) => {
    try {
      const base = mergeBase(root, tipBefore(head), head);
      const changes = changedFiles(root, base, head);
      const { addedLines, removedFiles } = diffLines(root, base, head);
      const config = committedConfig(project, base);
      const flows = flowsInForce(config.review.flows, committedConfig(project, head).review.flows);
      const built = buildPlan({
        head, base, changes, addedLines, removedFiles, engine: ENGINE, config: { ...config, review: { ...config.review, flows } },
        extraFlows: contentFlows({ root, head, changes, addedLines, flows }),
      });
      const passes = built.stages.flatMap((stage) => stage.passes).filter((pass) => mine(pass.id)).map(({ id, files }) => ({ id, files }));
      return { base, files: changes.map(({ file }) => file), passes };
    } catch {
      return null;
    }
  };
  return { plan: once(plan), changed: once((from, to) => changedFiles(root, from, to).map(({ file }) => file)), isAncestor: once((from, to) => isAncestor(root, from, to)) };
}

// The review records of a state folder: one a pull request and repository, the latest written, that has rounds and passes.
export function readRecords(state) {
  const latest = new Map();
  const folder = path.join(state, 'reviews');
  for (const name of readdirSync(folder).filter((each) => /^pr-\d+.*\.json$/u.test(each))) {
    let record;
    try {
      record = JSON.parse(readFileSync(path.join(folder, name), 'utf8'));
    } catch {
      continue;
    }
    if (!Array.isArray(record?.rounds) || record.passes === null || typeof record.passes !== 'object') continue;
    const key = `${record.repo}#${record.pr}`;
    if (!latest.has(key) || String(record.updatedAt) > String(latest.get(key).updatedAt)) latest.set(key, record);
  }
  return [...latest.values()];
}

// The reviewer's runs in the dispatch log, oldest first, as { ts, agent, session, description, cost }: one a stop row, whose
// `cost` is what the agent spent since its stop before, since a stop row counts the agent's whole transcript.
export function reviewerRuns(rows, reviewer) {
  const dispatches = new Map(rows.filter(({ event }) => event === 'dispatch').map((row) => [row.agent_id, row]));
  const spent = new Map();
  return rows.filter((row) => row.event === 'stop' && String(row.agent_type).split(':').at(-1) === reviewer && Number.isFinite(row.cost_usd))
    .sort((a, b) => (a.ts < b.ts ? -1 : 1))
    .map((row) => {
      const cost = Math.max(0, row.cost_usd - (spent.get(row.agent_id) ?? 0));
      spent.set(row.agent_id, row.cost_usd);
      return { ts: row.ts, agent: row.agent_id, session: row.session_id, description: String(dispatches.get(row.agent_id)?.description ?? ''), cost };
    });
}

// When a round began: a quiet push moves its `at`, and keeps the time its first head had.
const startOf = (round) => round?.quiet?.[0]?.at ?? round?.at;

// Gives each re-run the cost of the run that answered it, where one can be told: a run between the round's start and the
// next round's, whose label names the pull request, or else of a session whose ledger names it, with a label that names
// no other number and no other work. A run answers one re-run. `touches(session, rerun)` says whether a ledger names it.
export function addCosts(reruns, records, runs, touches) {
  const taken = new Set();
  for (const rerun of reruns) {
    const record = records.find((each) => each.pr === rerun.pr && each.repo === rerun.repo);
    const start = startOf(record.rounds[rerun.round - 1]);
    const end = startOf(record.rounds[rerun.round]) ?? record.updatedAt;
    const inWindow = runs.filter((run) => run.ts >= start && run.ts <= end && !taken.has(run) && !OTHER_WORK.test(run.description));
    const numbers = (run) => (run.description.match(/\b\d{3,}\b/gu) ?? []).map(Number);
    const run = inWindow.find((each) => numbers(each).includes(rerun.pr)) ?? inWindow.find((each) => numbers(each).length === 0 && touches(each.session, rerun));
    if (!run) continue;
    taken.add(run);
    rerun.cost = run.cost;
  }
}

// The report's totals by group: [{ group, count, share, list, base, costed, cost }], `list` and `base` how many also had a
// changed file list or a merged base, and `cost` the sum over the `costed` re-runs.
export function totals(reruns) {
  const read = reruns.filter(({ unread }) => unread === undefined);
  return GROUPS.map((group) => {
    const rows = read.filter((each) => each.group === group);
    const costed = rows.filter(({ cost }) => cost !== undefined);
    const also = (key) => rows.filter((each) => each[key]).length;
    return { group, count: rows.length, share: read.length ? rows.length / read.length : 0, list: also('list'), base: also('base'), costed: costed.length, cost: costed.reduce((sum, { cost }) => sum + cost, 0) };
  });
}

// The sessions whose ledger names a pull request, as addCosts asks.
function ledgers(state) {
  const read = new Map();
  return (session, { pr, repo }) => {
    if (!/^[\w-]+$/u.test(String(session))) return false;
    if (!read.has(session)) read.set(session, readRows(path.join(state, 'sessions', session, 'prs.jsonl')).rows);
    return read.get(session).some((row) => row.number === pr && row.path === repo);
  };
}

const percent = (share) => `${Math.round(share * 100)}%`;

function reportLines({ reviewer, records, withPass, reruns, first, lists, groups }) {
  const unread = reruns.filter((each) => each.unread !== undefined);
  const prs = new Set(reruns.map(({ pr, repo }) => `${repo}#${pr}`)).size;
  const row = ({ group, count, share, list, base, costed, cost }) => [group, count, percent(share), list, base, `$${cost.toFixed(2)} over ${costed}`, costed ? `$${(cost / costed).toFixed(2)} each` : '-'].join('\t');
  const why = [...new Set(unread.map((each) => each.unread))].map((reason) => `${reason}: ${unread.filter((each) => each.unread === reason).length}`);
  const detail = reruns.filter(({ group }) => group === 'file list changed' || group === 'none of these')
    .map((each) => [each.group, `#${each.pr}`, `round ${each.round}`, each.pass, `${each.from.slice(0, 10)}..${each.to.slice(0, 10)}`, each.rewritten ? 'the earlier head is no ancestor' : ''].filter(Boolean).join('\t'));
  return [
    `${reviewer}: ${reruns.length} re-runs and ${first} first runs seen on ${withPass} of ${records} review records, the re-runs on ${prs}`,
    'a floor: a record keeps each pass\'s latest result alone, so a clean re-run a later run replaced is not counted',
    `not sorted: ${unread.length}${why.length ? ` (${why.join('; ')})` : ''}`,
    `rebuilt file lists equal to the recorded: ${lists.equal} of ${lists.compared}`,
    'group\tre-runs\tshare\tlist changed too\tbase merged too\tcost\tmean',
    ...groups.map(row),
    ...detail,
  ];
}

function main(args) {
  const word = { type: 'string' };
  const { values } = parseArgs({ args, options: { state: word, project: word, reviewer: { ...word, default: 'product-manager' }, json: { type: 'boolean' } } });
  if (!values.state || !values.project) {
    console.error('usage: node scripts/report-flow-reruns.mjs --state <state folder> --project <checkout> [--reviewer product-manager] [--json]');
    return 1;
  }
  const { state, reviewer } = values;
  const records = readRecords(state);
  const checkout = readCheckout(path.resolve(values.project), reviewer);
  const sorted = records.map((record) => sortReruns(record, checkout, reviewer));
  const reruns = sorted.flatMap((each) => each.reruns);
  const rows = ['dispatch-log.1.jsonl', 'dispatch-log.jsonl'].flatMap((name) => readRows(path.join(state, name)).rows);
  addCosts(reruns, records, reviewerRuns(rows, reviewer), ledgers(state));
  const sum = (pick) => sorted.reduce((total, each) => total + pick(each), 0);
  const report = {
    reviewer, records: records.length, withPass: sorted.filter((each) => each.first + each.reruns.length > 0).length, reruns, first: sum((each) => each.first),
    lists: { compared: sum((each) => each.lists.compared), equal: sum((each) => each.lists.equal) }, groups: totals(reruns),
  };
  console.log(values.json ? JSON.stringify(report, null, 2) : reportLines(report).join('\n'));
  return 0;
}

// Run only as the entry script, as scripts/code-shape.mjs does.
const entry = process.argv[1];
if (entry && existsSync(entry) && import.meta.url === pathToFileURL(realpathSync(entry)).href) process.exitCode = main(process.argv.slice(2));
