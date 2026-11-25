// Why a reviewer's critical-flow passes ran again, from a project's review records, its checkout, and its dispatch log,
// all read only: a measurement for this repository's maintainers, never shipped in the plugin.
//
//   node scripts/report-flow-reruns.mjs --state <state folder> --project <checkout> [--reviewer product-manager] [--json]
//
// A run is one the record shows: a pass's result, or a finding the pass first raised in that round. A re-run is a run in
// a round after an earlier run, and is set against the last run of each flow of its pass. Each goes to the first group
// that holds (GROUPS): an open finding was owed a re-check, as the dispatch listed it, or with no list as the reviewer's
// own findings on the pass's flows say; the base was merged, which is uncertain, since the merge may have touched the
// pass's files or not, so it comes before what it would hide; a file of the pass's recorded list changed; the recorded
// file list changed, as of a pass that covers other flows; none of these. What the record cannot settle is not sorted:
// whether a round's finding was carried, whether a run the record no longer holds lies between, which files the pass
// covered then, a branch rewritten since, as by a force-push, whose heads' diff says nothing of what was pushed, and
// earlier runs that point to other groups. So the counts are a floor, the shares are of the sorted re-runs alone, without
// the uncertain group, and the costs are an estimate, matched by time, label, and session ledger.

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { runGit } from '../plugins/aidrian/lib/git.mjs';
import { readRows } from '../plugins/aidrian/lib/jsonl.mjs';
import { changedFiles } from '../plugins/aidrian/lib/review/diff.mjs';

// The group no share counts, with why.
const UNCERTAIN = 'base merged';
const WHY = 'uncertain: a merge resolution may have touched the pass\'s files';
export const GROUPS = ['open finding', 'files touched', 'file list changed', UNCERTAIN, 'none of these'];
// A dispatch of the reviewer for something other than a review pass, by the label the dispatcher gave it.
const OTHER_WORK = /residual|quorum|decision|ruling|\brule\b|\bplan\b|prepare|draft|shape|interview/iu;
const GIT_READ = { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 };

const isPassOf = (reviewer) => (id) => typeof id === 'string' && (id === `agent:${reviewer}` || id.startsWith(`agent:${reviewer}:`) || (id.startsWith('flow:') && id.endsWith(`:${reviewer}`)));
const flowsOf = (id) => {
  const [kind, name, flows] = id.split(':');
  return kind === 'flow' ? [name] : (flows ?? '').split('+').filter(Boolean);
};
// What the pass `id` covers: its flows, or with none itself.
const partsOf = (id) => (flowsOf(id).length ? flowsOf(id) : [id]);
const overlaps = (a, b) => partsOf(a).some((part) => partsOf(b).includes(part));
const listKey = (files) => JSON.stringify(Array.isArray(files) ? [...files].sort() : null);

// The index of the round `head` is of, the heads a quiet push moved it from included.
const roundOf = (record, head) => record.rounds.findIndex((round) => round.head === head || round.quiet?.some(({ from }) => from === head));

// Whether `finding`, open in the round at `index`, was first raised there: its id names the round, and the first round carries none.
const raisedIn = (finding, index) => index === 0 || String(finding.id).startsWith(`R${index + 1}-`);

// The runs of the pass `id` the record shows, a Map from the round's index to the head: its result, and a finding it first
// raised in a round that no quiet push moved, which has one head.
function runsOf(record, id) {
  const head = record.passes[id]?.head;
  const found = new Map([[roundOf(record, head), head]]);
  found.delete(-1);
  record.rounds.forEach((round, index) => {
    const raised = (round.findings ?? []).some((finding) => finding.pass === id && raisedIn(finding, index));
    if (raised && !round.quiet?.length && !found.has(index)) found.set(index, round.head);
  });
  return found;
}

// The runs the run `run` came after: of each part of its pass, every run in the last round before it that had one. `runs`
// are in round order.
function predecessors(runs, run) {
  const before = runs.filter((each) => each.index < run.index);
  const last = (part) => {
    const covering = before.filter(({ id }) => partsOf(id).includes(part));
    return covering.filter(({ index }) => index === covering.at(-1).index);
  };
  return [...new Set(partsOf(run.id).flatMap(last))];
}

// The group of the run of pass `id` at `head` in the round `index`, against the run `earlier`, { id, index, head }: { from,
// group }, or { unread } with why the record cannot tell. `checkout` is readCheckout's, or a stand-in.
function groupOf({ record, id, index, head, earlier, checkout, mine }) {
  const { head: from } = earlier;
  if (!checkout.isAncestor(from, head)) return { unread: 'the branch was rewritten: the earlier head is no ancestor of this one' };
  const note = record.dispatched?.[id]?.head === head ? record.dispatched[id] : null;
  const owed = Array.isArray(note?.listed) ? note.listed : record.rounds[index - 1].findings?.filter(({ pass }) => mine(pass) && overlaps(pass, id));
  if (!owed) return { unread: 'the earlier round keeps no findings' };
  if (owed.length) return { from, group: 'open finding' };
  if (earlier.index !== index - 1) return { unread: 'a run the record no longer holds may lie between' };
  if (checkout.merges(from, head) > 0) return { from, group: UNCERTAIN };
  const files = (record.passes[id]?.head === head ? record.passes[id] : note)?.files;
  if (files === undefined) return { unread: 'the record keeps no file list for this run' };
  if (checkout.changed(from, head).some((file) => files?.includes(file) ?? true)) return { from, group: 'files touched' };
  const other = earlier.id !== id && record.passes[earlier.id]?.head === from ? record.passes[earlier.id] : null;
  if (!other) return { unread: 'the record does not say which files the pass covered before' };
  return { from, group: listKey(other.files) === listKey(files) ? 'none of these' : 'file list changed' };
}

// The group every one of the run's `earlier` runs points to, as groupOf gives it.
function agreedGroup({ earlier, ...run }) {
  if (earlier.length === 0) return { unread: 'no earlier run is on record, so it may be a first run' };
  const told = earlier.map((each) => groupOf({ ...run, earlier: each }));
  const groups = new Set(told.map(({ group, unread }) => group ?? unread));
  return groups.size === 1 ? told[0] : { unread: 'the earlier runs of its flows do not point to one group' };
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
    let sorted;
    try {
      sorted = agreedGroup({ record, ...run, earlier: predecessors(runs, run), checkout, mine });
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

// The checkout at `root` as sortReruns asks it: `isAncestor(from, to)`, `changed(from, to)`, the files between two heads,
// and `merges(from, to)`, how many merge commits. Each throws when git cannot say.
export function readCheckout(root) {
  return {
    isAncestor: (from, to) => {
      const { status } = runGit(['merge-base', '--is-ancestor', from, to], root, GIT_READ);
      if (status !== 0 && status !== 1) throw new Error(`git cannot tell whether ${from} is an ancestor of ${to}`);
      return status === 0;
    },
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

const isRead = ({ unread }) => unread === undefined;
const isSorted = (each) => isRead(each) && each.group !== UNCERTAIN;

// The report's totals by group: [{ group, count, share, costed, cost }], `share` of the sorted re-runs, null for the
// uncertain group, and `cost` the sum over the `costed` ones.
export function totals(reruns) {
  const sorted = reruns.filter(isSorted).length;
  return GROUPS.map((group) => {
    const rows = reruns.filter((each) => each.group === group);
    const costed = rows.filter(({ cost }) => cost !== undefined);
    const share = sorted ? rows.length / sorted : 0;
    return { group, count: rows.length, share: group === UNCERTAIN ? null : share, costed: costed.length, cost: costed.reduce((sum, { cost }) => sum + cost, 0) };
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
  const unread = reruns.filter((each) => !isRead(each));
  const sorted = reruns.filter(isSorted).length;
  const label = (group) => (group === UNCERTAIN ? `${group} (${WHY})` : group);
  const row = ({ group, count, share, costed, cost }) => [label(group), count, share === null ? '-' : percent(share), `$${cost.toFixed(2)} over ${costed}`, costed ? `$${(cost / costed).toFixed(2)} each` : '-'].join('\t');
  const reasons = [...new Set(unread.map((each) => each.unread))].map((reason) => `  ${unread.filter((each) => each.unread === reason).length}\t${reason}`);
  const detail = reruns.filter(({ group }) => group === 'file list changed' || group === 'none of these')
    .map((each) => [each.group, `#${each.pr}`, `round ${each.round}`, each.pass, `${each.from.slice(0, 10)}..${each.to.slice(0, 10)}`].join('\t'));
  return [
    `${reviewer}: ${sorted} re-runs sorted, ${reruns.length - unread.length - sorted} uncertain, ${unread.length} not sorted, and ${first} runs in a first round, on ${withPass} of ${records} review records`,
    'a floor: a record keeps each pass\'s latest result alone, so a clean re-run a later run replaced is not counted',
    'estimates: the shares are of the sorted re-runs, without the uncertain ones, files touched goes by name, and the costs are matched by time, label, and session ledger',
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
  addCosts(reruns.filter(isRead), records, reviewerRuns(rows, reviewer), ledgers(state));
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
