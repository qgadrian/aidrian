// `aidrian session snapshot`: what a status line shows about the session it runs for and the project at the current
// folder, as one JSON object or one line of plain text (docs/handoff.md#the-snapshot). Display data only: no hook, gate,
// skill, or agent decides anything from it, and the Stop hook keeps reading the whole transcript.
//   { session: { id, transcript, cwd }, handoff, prs, lessons, worktrees, decisions, audits, tickets, links, ticket, errors }
// `ticket` is deprecated and no section: the first entry of `tickets`, or null, computed in snapshotOf alone, so an
// aidrian-mod older than the one that reads `tickets` still shows one ticket (docs/handoff.md#the-snapshot names when
// it goes). `errors` never names it. The caller passes what it needs, `--session` and `--transcript`: the command reads no host variable and no stdin.
// Each section fails open: one that throws is null and its name goes in `errors`, which holds names alone, and the
// command exits 0 whenever its arguments parse. Every process it starts has a time limit: git's (lib/git.mjs), or the
// forge budget its forge calls share; it reaches the forge through lib/forges/index.mjs alone, for a repository the
// adapter serves. Every string from a file name, a cache, the ledger, or a forge passes displayText.

import { lstatSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { scanDecisions } from './decisions-cli.mjs';
import { forgeFor, servedRepository } from './forges/index.mjs';
import { GIT_TIMEOUT_MS, killingGit, mainRoot } from './git.mjs';
import { latestBrief, MARKER_CAP, readArmed, readFrom, readOwnFile, SESSION_ID } from './handoff-markers.mjs';
import { HIDDEN } from './hidden-text.mjs';
import { findProject } from './project.mjs';
import { resumeTokens } from './resume-tokens.mjs';
import { cachedValue } from './session-cached-value.mjs';
import { LINKS, LINKS_MAX_BYTES, linksOf, sessionLinks, ticketsOf } from './session-links.mjs';
import { changesSummary, isChangeCache, LEDGER, LEDGER_MAX_BYTES, resolveSelection, sessionRefs, shownChanges } from './session-prs.mjs';
import { auditsSection, KILL, lessonsSection, originOf, ownState, snapshotContext } from './session-snapshot-state.mjs';
import { handoffStatus, stopMarkerPath } from './session-length.mjs';
import { cachedSessionUsage } from './session-usage-cache.mjs';
import { usageLines } from './usage.mjs';
import { listWorktrees, mergedHeads } from './worktree.mjs';

export const SECTIONS = Object.freeze(['handoff', 'prs', 'lessons', 'worktrees', 'decisions', 'audits', 'tickets', 'links']);
// How long the forge calls of one snapshot may take together, in milliseconds; `--deadline-ms` shortens it.
export const FORGE_BUDGET_MS = 4000;
// The merged heads' and the change requests' caches: each refreshed at most once a minute, and never read past 1 MiB.
export const MERGED_HEADS = Object.freeze({ name: 'merged-heads-cache.json', windowMs: 60_000, cap: 1024 * 1024 });
export const PRS_CACHE = Object.freeze({ name: 'prs-cache.json', windowMs: 60_000, cap: 1024 * 1024 });
// The session files the row reader reads, each with the most of the session's own it reads (lib/session-links.mjs).
const ROW_FILES = Object.freeze({ [LEDGER]: LEDGER_MAX_BYTES, [LINKS]: LINKS_MAX_BYTES });

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
    about: "print the session's status for a status line, as JSON or one plain line: handoff, pull requests, lessons, worktrees, decisions, audits, tickets, and links",
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
// given). In a folder with no project every section is null, `errors` is empty, and nothing is written. `io` is for a
// test that counts the reads of lib/session-links.mjs sessionLinks, and of the change requests' cache (`cachedValue`).
export const snapshot = (options) => killingGit(() => snapshotOf(options));

// The runner of a section: `read`'s value in `out[name]`, or, when it throws, the name in `errors`.
const sectionRunner = (out, errors) => (name, read) => {
  try {
    out[name] = read();
  } catch {
    errors.add(name);
  }
};

function snapshotOf({ cwd, session = null, transcript = null, ticketPrefixes = '', budgetMs = FORGE_BUDGET_MS, io = {} }) {
  const validId = typeof session === 'string' && SESSION_ID.test(session);
  const out = {
    session: { id: validId ? session : null, transcript: transcript === null ? null : displayText(transcript, DISPLAY_CAPS.path), cwd: displayText(cwd, DISPLAY_CAPS.path) },
    ...Object.fromEntries(SECTIONS.map((name) => [name, null])),
    ticket: null,
    errors: [],
  };
  const errors = new Set();
  const section = sectionRunner(out, errors);
  let ctx;
  try {
    const found = findProject(cwd);
    if (!found) return out;
    ctx = snapshotContext(found, { session, transcript, validId }, errors);
  } catch {
    return { ...out, errors: [...SECTIONS] };
  }
  const { project, state, checkouts, folder } = ctx;
  // What the handoff, prs, and tickets sections share: one store listing, one read of each session file and of the
  // remotes, and one of the change requests, for the prs section before the worktrees section spends the budget.
  const links = validId ? sessionLinks({ state, checkouts, maxChain: ctx.config.session.handoff.maxChain, folder, session, cwd, files: ROW_FILES, forge: forgeFor(cwd), git: KILL, io }) : null;
  if (validId && transcript !== null) section('handoff', () => handoffSection(ctx, links, session, transcript));
  const forge = forgeBudget(budgetMs);
  const changes = validId ? once(() => sessionChanges(ctx, links, cwd, forge, io)) : null;
  if (changes) section('prs', () => changes().map(shownChange));
  section('lessons', () => lessonsSection(ctx));
  // The worktree list, read once a snapshot for the worktrees and links sections; a failed read fails each that asks.
  const worktrees = once(() => listWorktrees(needed(mainRoot(project.root, KILL)), { timeoutMs: GIT_TIMEOUT_MS, ...KILL }));
  section('worktrees', () => worktreesSection(ctx, worktrees, validId, forge, errors));
  section('decisions', () => ({ provisional: unconfirmed(scanDecisions(project, { unindexed: false, config: ctx.config })) }));
  section('audits', () => auditsSection(ctx));
  section('tickets', () => ticketsSection(cwd, ticketPrefixes, { links, changes }, errors));
  // Without --session there are no links to read, and so no error, as for prs.
  if (session !== null) section('links', () => shownLink(linksOf(links?.rows ?? null, worktrees)));
  return { ...out, ticket: out.tickets?.[0] ?? null, errors: SECTIONS.filter((name) => errors.has(name)) };
}

// The tickets ticketsOf gives (lib/session-links.mjs), each key through displayText, from the change requests the prs
// section read, none with no session or when that read failed (`prs` names it), and origin as links.origin() reads it,
// when a `#N` needs it, spelled as the rows it is compared with record it: no `url.<base>.insteadOf` rewrite, unlike the
// worktrees section's originOf, which asks the forge as git fetches. An own session file that cannot be read names
// `tickets` in `errors`, the other keys kept; a bad prefix list throws.
function ticketsSection(cwd, prefixes, { links, changes }, errors) {
  let read = null;
  try {
    read = changes?.() ?? null;
  } catch { /* the prs section names the failure */ }
  const { tickets, unread } = ticketsOf(cwd, prefixes, { rows: links?.rows ?? null, changes: read, origin: links?.origin, git: KILL });
  if (unread) errors.add('tickets');
  return tickets.map(({ key, source }) => ({ key: displayText(key), source }));
}

const shownLink = (link) => link && { branch: displayText(link.branch), worktree: displayText(link.worktree, DISPLAY_CAPS.path), source: link.source };

// `read`'s value, or what it threw, read once and given again.
function once(read) {
  let done = null;
  return () => {
    if (done === null) {
      try {
        done = { value: read() };
      } catch (error) {
        done = { error };
      }
    }
    if (done.error) throw done.error;
    return done.value;
  };
}

const needed = (value) => {
  if (value === null || value === undefined) throw new Error('missing');
  return value;
};

const unconfirmed = ({ decisions, unlisted }) => [...decisions, ...unlisted].filter(({ status }) => status === 'unconfirmed').length;

// The handoff numbers of the session, from its transcript through the usage cache, and the Stop hook's marker, at the
// hook's own path, with the project's B (lib/resume-tokens.mjs resumeTokens), which `resume` shows, read from a state
// folder outside every checkout that no other user can replace (ownState's rule). Under `mode: off` the hook never reminds, so the level is quiet and the numbers stay. The continuation
// store is opened at the state folder's real path the context resolved, the same path the session folder was made under.
function handoffSection({ config, folder, state, inside, loose }, links, session, transcript) {
  const usage = cachedSessionUsage({ transcript, cacheFile: path.join(needed(folder), 'usage.json') });
  const resume = resumeTokens(config.session.handoff, inside || loose ? null : state);
  const handoff = { ...config.session.handoff, resumeTokens: resume.tokens };
  const status = handoffStatus(needed(usage), handoff, stopMarkerText(session));
  const { ratio, breakEven, nextRatio, context: tokens, ceiling } = status;
  return {
    ratio, breakEven, level: handoff.mode === 'off' ? 'quiet' : status.level, nextRatio, context: tokens, ceiling, resume,
    ...continuationOf(links, session, handoff.maxChain),
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
function continuationOf(links, session, maxChain) {
  const store = links.store();
  if (store.refused) return { chain: null, maxChain, continueArmed: null, lastBrief: null };
  const armed = readArmed(store, session);
  const brief = latestBrief(store);
  return {
    chain: armed?.chain ?? readFrom(store, session, { names: links.names() })?.chain ?? 0, maxChain, continueArmed: armed !== null,
    lastBrief: brief ? displayText(brief.slug) : null,
  };
}

// The change requests the session's ledger names (lib/session-prs.mjs), newest first: those on a host the forge adapter
// declares from its one batched read, cached with its refs, as shownChanges shows them, then the rest, each
// `unsupported: true`, which start no forge call. The forge runs in the session's folder `cwd`, never in one a row names.
// After the session's own refs come those of the sessions a handoff came from, read only while there are places left.
// A state folder not the user's own (ownState), a ledger that cannot be read, or a failed read with no cache throws.
// The rows are whole, `closes` and all: the prs section cuts each to its documented keys (shownChange).
function sessionChanges(ctx, links, cwd, forge, io) {
  const folder = needed(ownState(ctx) && ctx.folder);
  const { refs, unsupported } = sessionRefs(needed(links.rows.own(LEDGER)), forgeFor(cwd), links.rows.inherited(LEDGER));
  const refresh = () => forge((timeoutMs) => resolveSelection(forgeFor(cwd, { timeoutMs, ...KILL }), refs));
  const cached = refs.length ? needed((io.cachedValue ?? cachedValue)({ folder, ...PRS_CACHE, isValue: isChangeCache, refresh })) : { value: { refs: [], rows: [] }, stale: false };
  return shownChanges({ forge: forgeFor(cwd), refs, unsupported, cache: cached.value, stale: cached.stale });
}

// A change request's row as shown: its documented keys alone, in order, strings through displayText, flags as booleans.
const same = (value) => value;
const flag = (value) => value === true;
const capped = (cap) => (value) => (typeof value === 'string' ? displayText(value, cap) : value);
const SHOWN = Object.entries({ forge: capped(DISPLAY_CAPS.name), host: capped(DISPLAY_CAPS.name), repo: capped(DISPLAY_CAPS.path), number: same, title: capped(DISPLAY_CAPS.title), url: capped(DISPLAY_CAPS.path), isDraft: same, state: same,
  mergeable: same, reviewDecision: same, unresolvedThreads: same, checks: (checks) => checks && { passed: checks.passed, failed: checks.failed, pending: checks.pending, skipped: checks.skipped }, stale: flag, unsupported: flag, inherited: flag });
const shownChange = (row) => Object.fromEntries(SHOWN.filter(([key]) => Object.hasOwn(row, key)).map(([key, shape]) => [key, shape(row[key])]));

// { owned, mergedNotCleaned }, and `stale: true` when the merged count is a cached value past its window. `owned` counts
// the worktrees other than the main checkout. `mergedNotCleaned` counts those whose HEAD is the head commit of a merged
// pull request of their branch, without cleanup's tree and age checks; null without a session, with no origin, or for
// an origin the forge does not serve, and null, naming the section in `errors`, when origin cannot be read (originOf) or
// the merged heads' read fails with no cached value.
function worktreesSection({ project, folder }, list, validId, forge, errors) {
  const main = needed(mainRoot(project.root, KILL));
  const worktrees = list().filter((each) => !each.main);
  const out = { owned: worktrees.length, mergedNotCleaned: null };
  if (!validId) return out;
  const home = originOf(project.root);
  if (home.failed) {
    errors.add('worktrees');
    return out;
  }
  const repo = servedRepository(home.repo);
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
