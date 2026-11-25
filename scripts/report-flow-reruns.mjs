// Why a reviewer's critical-flow passes ran again, from a project's review records, its checkout, and its dispatch log,
// all read only: a measurement for this repository's maintainers, never shipped in the plugin.
//
//   node scripts/report-flow-reruns.mjs --state <state folder> --project <checkout> [--reviewer product-manager] [--json]
//
// A run is one the record shows: a pass's result, the earlier result a later dispatch named as its base, or a finding the
// pass first raised in that round. A re-run is a run in a round after an earlier run. Each goes to the first group that
// holds (GROUPS): an open finding of the reviewer's on the pass's flows was owed a re-check; a file of the pass's recorded
// list changed, by name, as resultFor's delta counts it, so an edit of the base's to such a file counts; the recorded file
// list changed, as of a pass that covers other flows; none of these. What the record cannot settle is not sorted: whether
// a round's finding was carried, whether a run the record no longer holds lies between, which files the pass covered
// then, and whether a merge (its resolution, or the base's edits) is the cause. So the counts are a floor, the shares are
// of the sorted re-runs alone, and the costs are an estimate, matched by time, label, and session ledger.

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { runGit } from '../plugins/aidrian/lib/git.mjs';
import { readRows } from '../plugins/aidrian/lib/jsonl.mjs';
import { changedFiles } from '../plugins/aidrian/lib/review/diff.mjs';

export const GROUPS = ['open finding', 'files touched', 'file list changed', 'none of these'];
// A dispatch of the reviewer for something other than a review pass, by the label the dispatcher gave it.
const OTHER_WORK = /residual|quorum|decision|ruling|\brule\b|\bplan\b|prepare|draft|shape|interview/iu;
const GIT_READ = { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 };

const isPassOf = (reviewer) => (id) => typeof id === 'string' && (id === `agent:${reviewer}` || id.startsWith(`agent:${reviewer}:`) || (id.startsWith('flow:') && id.endsWith(`:${reviewer}`)));
const flowsOf = (id) => {
  const [kind, name, flows] = id.split(':');
  return kind === 'flow' ? [name] : (flows ?? '').split('+').filter(Boolean);
};
const overlaps = (a, b) => a === b || flowsOf(a).some((flow) => flowsOf(b).includes(flow));
const listKey = (files) => JSON.stringify(Array.isArray(files) ? [...files].sort() : null);

// Each round's heads, the ones a quiet push moved it from first.
const headsOf = (round) => [...(round.quiet ?? []).map(({ from }) => from), round.head];
const roundOf = (record, head) => record.rounds.findIndex((round) => headsOf(round).includes(head));

// Whether `finding`, open in the round at `index`, was first raised there: its id names the round, and the first round carries none.
const raisedIn = (finding, index) => index === 0 || String(finding.id).startsWith(`R${index + 1}-`);

// The runs of the pass `id` the record shows, a Map from the round's index to the head: its result, the earlier result its
// last dispatch named as `base`, and a finding it first raised in a round that no quiet push moved, which has one head.
function runsOf(record, id) {
  const found = new Map();
  for (const head of [record.passes[id]?.head, record.dispatched?.[id]?.base]) {
    const index = roundOf(record, head);
    if (index !== -1) found.set(index, head);
  }
  record.rounds.forEach((round, index) => {
    const raised = (round.findings ?? []).some((finding) => finding.pass === id && raisedIn(finding, index));
    if (raised && !round.quiet?.length && !found.has(index)) found.set(index, round.head);
  });
  return found;
}

// The group of the run of pass `id` at `head` in the round `index`: { from, group }, or { unread } with why the record cannot
// tell. `earlier` is the last run before it, { id, index, head }, and `checkout` readCheckout's, or a stand-in.
function groupOf({ record, id, index, head, earlier, checkout, mine }) {
  const before = record.rounds[index - 1];
  const note = record.dispatched?.[id]?.head === head ? record.dispatched[id] : null;
  const owed = (before.findings ?? []).some((finding) => mine(finding.pass) && overlaps(finding.pass, id));
  if (owed || note?.listed?.length) return { from: before.head, group: 'open finding' };
  // The dispatch names the head its delta ran from: the pass's result just before this run, over the same file list.
  const base = note ? roundOf(record, note.base) : -1;
  const exact = base !== -1 && base < index;
  const from = exact ? note.base : earlier.head;
  if (!exact && earlier.index !== index - 1) return { unread: 'a run the record no longer holds may lie between' };
  const files = (record.passes[id]?.head === head ? record.passes[id] : note)?.files;
  if (files === undefined) return { unread: 'the record keeps no file list for this run' };
  const changed = checkout.changed(from, head);
  const merged = checkout.merges(from, head) > 0;
  if (Array.isArray(files) ? changed.some((file) => files.includes(file)) : changed.length && !merged) return { from, group: 'files touched' };
  const known = Array.isArray(before.findings) || Array.isArray(note?.listed);
  if (!known) return { unread: 'the earlier round keeps no findings' };
  const other = !exact && earlier.id !== id && record.passes[earlier.id]?.head === earlier.head ? record.passes[earlier.id] : null;
  if (other && listKey(other.files) !== listKey(files)) return { from, group: 'file list changed' };
  if (!exact) return { unread: 'the record does not say which files the pass covered before' };
  if (merged) return { unread: 'a merge since: its resolution or the base may be the cause' };
  return { from, group: 'none of these' };
}

// The re-runs of `reviewer`'s passes on one review record: { reruns, first }, with `reruns` one row a pass and round, { pr,
// repo, round, pass, to, from, group } or { ..., unread }, and `first` the count of runs in the pull request's first round.
export function sortReruns(record, checkout, reviewer = 'product-manager') {
  const mine = isPassOf(reviewer);
  const ids = [...new Set([...Object.keys(record.passes), ...record.rounds.flatMap((round) => (round.findings ?? []).map(({ pass }) => pass))])].filter(mine);
  const runs = ids.flatMap((id) => [...runsOf(record, id)].map(([index, head]) => ({ id, index, head }))).sort((a, b) => a.index - b.index);
  const out = { reruns: [], first: runs.filter(({ index }) => index === 0).length };
  const row = ({ id, index, head }) => ({ pr: record.pr, repo: record.repo, round: index + 1, pass: id, to: head });
  for (const run of runs.filter(({ index }) => index > 0)) {
    const earlier = runs.findLast((each) => each.index < run.index && overlaps(each.id, run.id));
    let sorted = { unread: 'no earlier run is on record, so it may be a first run' };
    try {
      if (earlier) sorted = groupOf({ record, ...run, earlier, checkout, mine });
    } catch {
      sorted = { unread: 'git cannot read the change between the heads' };
    }
    out.reruns.push({ ...row(run), ...sorted });
  }
  record.rounds.forEach((round, index) => {
    const open = new Set((round.findings ?? []).map(({ pass }) => pass).filter(mine));
    const unseen = [...open].filter((id) => !runs.some((run) => run.id === id && run.index === index));
    for (const id of unseen) out.reruns.push({ ...row({ id, index, head: round.head }), unread: 'only an open finding, which may be carried' });
  });
  return out;
}

// The checkout at `root` as sortReruns asks it: `changed(from, to)`, the files between two heads, and `merges(from, to)`,
// how many merge commits. Either throws when git cannot say.
export function readCheckout(root) {
  return {
    changed: (from, to) => changedFiles(root, from, to).map(({ file }) => file),
    merges: (from, to) => {
      const counted = runGit(['rev-list', '--merges', '--count', `${from}..${to}`], root, GIT_READ);
      if (counted.status !== 0) throw new Error(`git cannot count the merges of ${from}..${to}`);
      return Number(counted.stdout.trim());
    },
  };
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

const isSorted = ({ unread }) => unread === undefined;

// The report's totals by group: [{ group, count, share, costed, cost }], `share` of the sorted re-runs, and `cost` the sum
// over the `costed` ones.
export function totals(reruns) {
  const sorted = reruns.filter(isSorted);
  return GROUPS.map((group) => {
    const rows = sorted.filter((each) => each.group === group);
    const costed = rows.filter(({ cost }) => cost !== undefined);
    return { group, count: rows.length, share: sorted.length ? rows.length / sorted.length : 0, costed: costed.length, cost: costed.reduce((sum, { cost }) => sum + cost, 0) };
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

export function reportLines({ reviewer, records, withPass, reruns, first, groups }) {
  const unread = reruns.filter((each) => !isSorted(each));
  const row = ({ group, count, share, costed, cost }) => [group, count, percent(share), `$${cost.toFixed(2)} over ${costed}`, costed ? `$${(cost / costed).toFixed(2)} each` : '-'].join('\t');
  const reasons = [...new Set(unread.map((each) => each.unread))].map((reason) => `  ${unread.filter((each) => each.unread === reason).length}\t${reason}`);
  const detail = reruns.filter(({ group }) => group === 'file list changed' || group === 'none of these')
    .map((each) => [each.group, `#${each.pr}`, `round ${each.round}`, each.pass, `${each.from.slice(0, 10)}..${each.to.slice(0, 10)}`].join('\t'));
  return [
    `${reviewer}: ${reruns.length - unread.length} re-runs sorted, ${unread.length} not sorted, and ${first} runs in a first round, on ${withPass} of ${records} review records`,
    'a floor: a record keeps each pass\'s latest result alone, so a clean re-run a later run replaced is not counted',
    'estimates: the shares are of the sorted re-runs, files touched goes by name, and the costs are matched by time, label, and session ledger',
    `not sorted: ${unread.length}`,
    ...reasons,
    'group\tre-runs\tshare of sorted\tcost\tmean',
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
  const checkout = readCheckout(path.resolve(values.project));
  const sorted = records.map((record) => sortReruns(record, checkout, reviewer));
  const reruns = sorted.flatMap((each) => each.reruns);
  const rows = ['dispatch-log.1.jsonl', 'dispatch-log.jsonl'].flatMap((name) => readRows(path.join(state, name)).rows);
  addCosts(reruns.filter(isSorted), records, reviewerRuns(rows, reviewer), ledgers(state));
  const report = {
    reviewer, records: records.length, withPass: sorted.filter((each) => each.first + each.reruns.length > 0).length, reruns,
    first: sorted.reduce((sum, each) => sum + each.first, 0), groups: totals(reruns),
  };
  console.log(values.json ? JSON.stringify(report, null, 2) : reportLines(report).join('\n'));
  return 0;
}

// Run only as the entry script, as scripts/code-shape.mjs does.
const entry = process.argv[1];
if (entry && existsSync(entry) && import.meta.url === pathToFileURL(realpathSync(entry)).href) process.exitCode = main(process.argv.slice(2));
