// `aidrian session snapshot`: what a status line shows about the session it runs for and the project at the current
// folder, as one JSON object or one line of plain text (docs/handoff.md#the-snapshot). Display data only: no hook, gate,
// skill, or agent decides anything from it, and the Stop hook keeps reading the whole transcript.
//   { session: { id, transcript, cwd }, handoff, prs, lessons, worktrees, decisions, audits, ticket, errors }
// The caller passes what it needs, `--session` and `--transcript`: the command reads no host variable and no stdin.
// Each section fails open: one that throws is null and its name goes in `errors`, which holds names alone, and the
// command exits 0 whenever its arguments parse. Every process it starts has a time limit: git's (lib/git.mjs), or the
// forge budget its forge calls share; it reaches the forge through lib/forges/index.mjs alone, for a repository the
// adapter serves. Every string from a file name, a cache, the ledger, or a forge passes displayText.

import { lstatSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { scanDecisions } from './decisions-cli.mjs';
import { forgeFor, remoteIdentity, servedRepository } from './forges/index.mjs';
import { GIT_TIMEOUT_MS, killingGit, mainRoot, runGit } from './git.mjs';
import { latestBrief, MARKER_CAP, openStore, readArmed, readFrom, readOwnFile, SESSION_ID } from './handoff-markers.mjs';
import { HIDDEN } from './hidden-text.mjs';
import { findProject } from './project.mjs';
import { cachedValue } from './session-cached-value.mjs';
import { changesSummary, isChangeCache, readLedger, resolveSelection, sessionRefs, shownChanges } from './session-prs.mjs';
import { auditsSection, KILL, lessonsSection, ownState, snapshotContext } from './session-snapshot-state.mjs';
import { handoffStatus, stopMarkerPath } from './session-length.mjs';
import { cachedSessionUsage } from './session-usage-cache.mjs';
import { usageLines } from './usage.mjs';
import { listWorktrees, mergedHeads } from './worktree.mjs';

export const SECTIONS = Object.freeze(['handoff', 'prs', 'lessons', 'worktrees', 'decisions', 'audits', 'ticket']);
// How long the forge calls of one snapshot may take together, in milliseconds; `--deadline-ms` shortens it.
export const FORGE_BUDGET_MS = 4000;
// The merged heads' and the change requests' caches: each refreshed at most once a minute, and never read past 1 MiB.
export const MERGED_HEADS = Object.freeze({ name: 'merged-heads-cache.json', windowMs: 60_000, cap: 1024 * 1024 });
export const PRS_CACHE = Object.freeze({ name: 'prs-cache.json', windowMs: 60_000, cap: 1024 * 1024 });
// Ticket prefixes: at most 32, each a letter and up to 15 letters or digits.
const PREFIX = /^[A-Za-z][A-Za-z0-9]{0,15}$/u;
const MAX_PREFIXES = 32;
// `git remote get-url`'s exit status when the remote is not configured.
const NO_SUCH_REMOTE = 2;

// The longest text displayText keeps, in code points: a title, a name (a branch, an owner, a repository, a check, a
// slug, or a ticket key), and a path or URL.
export const DISPLAY_CAPS = Object.freeze({ title: 200, name: 100, path: 1024 });

// `text` without a hidden character (hidden-text.mjs), cut at `cap` code points. lib/feedback-record.mjs cleanTitle is its pattern.
export const displayText = (text, cap = DISPLAY_CAPS.name) => [...String(text).replace(HIDDEN, '')].slice(0, cap).join('');

const OPTIONS = Object.fromEntries([...['session', 'transcript', 'ticket-prefixes', 'deadline-ms'].map((name) => [name, { type: 'string' }]),
  ...['json', 'line'].map((name) => [name, { type: 'boolean' }])]);

export const commands = {
  session: {
    usage: 'snapshot [--session ID] [--transcript PATH] [--ticket-prefixes A|B] [--deadline-ms N] [--json|--line]',
    about: "print the session's status for a status line, as JSON or one plain line: handoff, pull requests, lessons, worktrees, decisions, audits, and ticket",
    run(args) {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: OPTIONS });
      const deadline = values['deadline-ms'] ?? String(FORGE_BUDGET_MS);
      const budget = /^\d{1,4}$/u.test(deadline) ? Number(deadline) : 0;
      if (positionals.join(' ') !== 'snapshot' || (values.json && values.line) || budget < 1 || budget > FORGE_BUDGET_MS) {
        console.error(usageLines('session', commands.session.usage, 'usage: ').join('\n'));
        return 1;
      }
      const snap = snapshot({
        cwd: process.cwd(), session: values.session ?? null, transcript: values.transcript ?? null,
        ticketPrefixes: values['ticket-prefixes'] ?? '', budgetMs: budget,
      });
      process.stdout.write(`${values.line ? snapshotLine(snap) : JSON.stringify(snap)}\n`);
      return 0;
    },
  },
};

// The snapshot of the folder `cwd`, for the session `session` whose transcript is `transcript` (each null when not
// given). In a folder with no project every section is null, `errors` is empty, and nothing is written.
export const snapshot = (options) => killingGit(() => snapshotOf(options));

function snapshotOf({ cwd, session = null, transcript = null, ticketPrefixes = '', budgetMs = FORGE_BUDGET_MS }) {
  const validId = typeof session === 'string' && SESSION_ID.test(session);
  const out = {
    session: { id: validId ? session : null, transcript: transcript === null ? null : displayText(transcript, DISPLAY_CAPS.path), cwd: displayText(cwd, DISPLAY_CAPS.path) },
    ...Object.fromEntries(SECTIONS.map((name) => [name, null])),
    errors: [],
  };
  const errors = new Set();
  const section = (name, read) => {
    try {
      out[name] = read();
    } catch {
      errors.add(name);
    }
  };
  let ctx;
  try {
    const found = findProject(cwd);
    if (!found) return out;
    ctx = snapshotContext(found, { session, transcript, validId }, errors);
  } catch {
    return { ...out, errors: [...SECTIONS] };
  }
  const { project } = ctx;
  if (validId && transcript !== null) section('handoff', () => handoffSection(ctx, session, transcript));
  const forge = forgeBudget(budgetMs);
  if (validId) section('prs', () => prsSection(ctx, cwd, forge));
  section('lessons', () => lessonsSection(ctx));
  section('worktrees', () => worktreesSection(ctx, validId, forge, errors));
  section('decisions', () => ({ provisional: unconfirmed(scanDecisions(project, { unindexed: false, config: ctx.config })) }));
  section('audits', () => auditsSection(ctx));
  section('ticket', () => ticketOf(cwd, ticketPrefixes));
  return { ...out, errors: SECTIONS.filter((name) => errors.has(name)) };
}

const needed = (value) => {
  if (value === null || value === undefined) throw new Error('missing');
  return value;
};

const unconfirmed = ({ decisions, unlisted }) => [...decisions, ...unlisted].filter(({ status }) => status === 'unconfirmed').length;

// The handoff numbers of the session, from its transcript through the usage cache, and the Stop hook's marker, at the
// hook's own path. Under `mode: off` the hook never reminds, so the level is quiet and the numbers stay. The continuation
// store is opened at the state folder's real path the context resolved, the same path the session folder was made under.
function handoffSection({ config, state, checkouts, folder }, session, transcript) {
  const usage = cachedSessionUsage({ transcript, cacheFile: path.join(needed(folder), 'usage.json') });
  const { handoff } = config.session;
  const status = handoffStatus(needed(usage), handoff, stopMarkerText(session));
  const { ratio, breakEven, nextRatio, context: tokens, ceiling } = status;
  return {
    ratio, breakEven, level: handoff.mode === 'off' ? 'quiet' : status.level, nextRatio, context: tokens, ceiling,
    ...continuationOf(openStore(state, { checkouts, maxChain: handoff.maxChain }), session, handoff.maxChain),
  };
}

// The marker's text, or null when there is none. One that is there but no regular file this user owns, under its cap,
// such as a FIFO or a symlink, throws: the section cannot tell what the hook recorded.
function stopMarkerText(session) {
  const file = needed(stopMarkerPath(session));
  if (!lstatSync(file, { throwIfNoEntry: false })) return null;
  return needed(readOwnFile(file, { cap: MARKER_CAP })).text;
}

// The continuation store's part, through its read-only readers: { chain, maxChain, continueArmed, lastBrief }. A store
// refused leaves the first, third, and fourth null. `lastBrief` is the slug of the newest brief, any session's.
function continuationOf(store, session, maxChain) {
  if (store.refused) return { chain: null, maxChain, continueArmed: null, lastBrief: null };
  const armed = readArmed(store, session);
  const brief = latestBrief(store);
  return {
    chain: armed?.chain ?? readFrom(store, session)?.chain ?? 0, maxChain, continueArmed: armed !== null,
    lastBrief: brief ? displayText(brief.slug) : null,
  };
}

// The change requests the session's ledger names (lib/session-prs.mjs), newest first: those on a host the forge adapter
// declares from its one batched read, cached with its refs, as shownChanges shows them, then the rest, each
// `unsupported: true`, which start no forge call. The forge runs in the session's folder `cwd`, never in one a row names.
// A state folder not the user's own (ownState), a ledger that cannot be read, or a failed read with no cache throws.
function prsSection(ctx, cwd, forge) {
  const folder = needed(ownState(ctx) && ctx.folder);
  const { refs, unsupported } = sessionRefs(needed(readLedger(folder)), forgeFor(cwd));
  const refresh = () => forge((timeoutMs) => resolveSelection(forgeFor(cwd, { timeoutMs, ...KILL }), refs));
  const cached = refs.length ? needed(cachedValue({ folder, ...PRS_CACHE, isValue: isChangeCache, refresh })) : { value: { refs: [], rows: [] }, stale: false };
  return shownChanges({ forge: forgeFor(cwd), refs, unsupported, cache: cached.value, stale: cached.stale }).map(shownChange);
}

// A change request's row as shown: its documented keys alone, in order, strings through displayText, flags as booleans.
const same = (value) => value;
const flag = (value) => value === true;
const capped = (cap) => (value) => (typeof value === 'string' ? displayText(value, cap) : value);
const SHOWN = Object.entries({ forge: capped(DISPLAY_CAPS.name), host: capped(DISPLAY_CAPS.name), repo: capped(DISPLAY_CAPS.path), number: same, title: capped(DISPLAY_CAPS.title), url: capped(DISPLAY_CAPS.path), isDraft: same, state: same,
  mergeable: same, reviewDecision: same, unresolvedThreads: same, checks: (checks) => checks && { passed: checks.passed, failed: checks.failed, pending: checks.pending, skipped: checks.skipped }, stale: flag, unsupported: flag });
const shownChange = (row) => Object.fromEntries(SHOWN.filter(([key]) => Object.hasOwn(row, key)).map(([key, shape]) => [key, shape(row[key])]));

// { owned, mergedNotCleaned }, and `stale: true` when the merged count is a cached value past its window. `owned` counts
// the worktrees other than the main checkout. `mergedNotCleaned` counts those whose HEAD is the head commit of a merged
// pull request of their branch, without cleanup's tree and age checks; null without a session, with no origin, or for
// an origin the forge does not serve, and null, naming the section in `errors`, when origin cannot be read or the
// merged heads' read fails with no cached value.
function worktreesSection({ project, folder }, validId, forge, errors) {
  const main = needed(mainRoot(project.root, KILL));
  const worktrees = listWorktrees(main, { timeoutMs: GIT_TIMEOUT_MS, ...KILL }).filter((each) => !each.main);
  const out = { owned: worktrees.length, mergedNotCleaned: null };
  if (!validId) return out;
  // As git fetches in the checkout that asks: the first URL, after any `url.<base>.insteadOf` rewrite, with that
  // checkout's own config, such as a worktree's or an `includeIf "onbranch:"` one. Exit 2 is git's "No such remote".
  const origin = runGit(['remote', 'get-url', 'origin'], project.root, KILL);
  if (origin.status !== 0 && origin.status !== NO_SUCH_REMOTE) {
    errors.add('worktrees');
    return out;
  }
  const repo = origin.status === 0 ? servedRepository(remoteIdentity(origin.stdout.trim())) : null;
  if (repo === null) return out;
  const heads = mergedHeadsOf(main, repo, folder, forge);
  if (heads === null) {
    errors.add('worktrees');
    return out;
  }
  const merged = new Set(heads.value.pairs.map(([branch, head]) => `${branch}\n${head}`));
  out.mergedNotCleaned = worktrees.filter(({ branch, head }) => branch && head && merged.has(`${branch}\n${head}`)).length;
  return heads.stale ? { ...out, stale: true } : out;
}

// The merged pull requests' [branch, head] pairs of `repo`, as the forge's repository check named it, cached with the
// repository: { value: { repo, pairs }, stale }, or null. A cache of another repository, as after origin moved, is none.
function mergedHeadsOf(main, repo, folder, forge) {
  const refresh = () => forge((timeoutMs) => {
    const heads = mergedHeads(main, { repo, timeoutMs, ...KILL });
    return heads && { repo, pairs: [...heads].flatMap(([branch, oids]) => oids.map((oid) => [branch, oid])) };
  });
  return cachedValue({ folder, ...MERGED_HEADS, isValue: (value) => value?.repo === repo && isPairs(value.pairs), refresh });
}

const isPairs = (value) => Array.isArray(value) && value.every((pair) => Array.isArray(pair) && pair.length === 2 && pair.every((part) => typeof part === 'string'));

// One snapshot's forge budget: the calls share `ms`, each gets what is left as its time limit, and none starts once spent.
function forgeBudget(ms) {
  let left = ms;
  return (call) => {
    if (left <= 0) return null;
    const start = Date.now();
    try {
      return call(left);
    } finally {
      left -= Date.now() - start;
    }
  };
}

// The ticket of the branch `cwd` is on: `{ key, source: "branch" }`, or null. `prefixes`, pipe-separated, are tracker
// keys, matched as `(^|/)(PREFIXES)-[0-9]+` in any case and given in capitals; with none matching, a branch named
// `<type>/<N>-<slug>` gives `#N`. A prefix of the wrong shape, or more than MAX_PREFIXES, throws.
function ticketOf(cwd, prefixes) {
  const list = prefixes === '' ? [] : prefixes.split('|');
  if (list.length > MAX_PREFIXES || !list.every((prefix) => PREFIX.test(prefix))) throw new Error('prefixes');
  const head = runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd, KILL);
  if (head.status !== 0) return null;
  const branch = head.stdout.trim();
  const escaped = list.map((prefix) => prefix.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
  const keyed = list.length ? new RegExp(`(?:^|/)(${escaped.join('|')})-([0-9]+)`, 'iu').exec(branch) : null;
  if (keyed) return { key: displayText(`${keyed[1].toUpperCase()}-${keyed[2]}`), source: 'branch' };
  const numbered = /^[^/]+\/([0-9]+)-/u.exec(branch);
  return numbered ? { key: displayText(`#${numbered[1]}`), source: 'branch' } : null;
}

// What each handoff level shows: the ratio, then the handoff's state, with the break-even when there is one.
const LEVEL_WORDS = {
  quiet: (ratio) => ratio,
  offer: (ratio, pays) => (pays ? `${ratio} · handoff ${pays}` : ratio),
  due: (ratio, pays) => `${ratio} · handoff due${pays ? `, ${pays}` : ''}`,
  ceiling: () => 'handoff now',
};
LEVEL_WORDS.reminded = LEVEL_WORDS.due;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The snapshot as one line of plain text for a status line: its segments that hold something, joined by ` · `, or ''.
export function snapshotLine({ handoff, prs, lessons: inbox, decisions, worktrees, audits }) {
  const segments = [];
  if (handoff?.ratio > 0) {
    const pays = handoff.breakEven === null ? '' : `pays back in ~${Math.round(handoff.breakEven)} calls`;
    const armed = handoff.continueArmed ? ` · armed ${handoff.chain}/${handoff.maxChain}` : '';
    segments.push(`${LEVEL_WORDS[handoff.level](`${handoff.ratio.toFixed(1)}x`, pays)}${armed}`);
  }
  if (Array.isArray(prs) && prs.length) segments.push(changesSummary(prs));
  const harness = [
    [inbox?.byTier?.P1, (n) => `📥 ${n} P1`],
    [decisions?.provisional, (n) => `⚖️ ${plural(n, 'decision')}`],
    [worktrees?.mergedNotCleaned, (n) => `🧹 ${plural(n, 'worktree')}`],
    [audits?.untriaged, (n) => `🔎 ${plural(n, 'finding')}`],
  ].filter(([n]) => n > 0).map(([n, words]) => words(n));
  if (harness.length) segments.push(harness.join(' · '));
  return segments.join(' · ');
}
