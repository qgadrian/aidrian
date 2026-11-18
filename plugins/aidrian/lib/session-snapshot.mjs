// `aidrian session snapshot`: what a status line shows about the session it runs for and the project at the current
// folder, as one JSON object or one line of plain text (docs/handoff.md#the-snapshot). Display data only: no hook, gate,
// skill, or agent decides anything from it, and the Stop hook keeps reading the whole transcript.
//   { session: { id, transcript, cwd }, handoff, prs, lessons, worktrees, decisions, audits, ticket, errors }
// The caller passes what it needs, `--session` and `--transcript`: the command reads no host variable and no stdin.
// Each section fails open: one that throws is null and its name goes in `errors`, which holds names alone, and the
// command exits 0 whenever its arguments parse. Every process it starts has a time limit: git's (lib/git.mjs), or the
// forge budget its forge calls share; it reaches the forge through lib/forges/index.mjs alone, for a repository the
// adapter serves. Every string from a file name, a cache, or a forge passes displayText. `prs` is always null.

import { lstatSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { listAudits } from './audits.mjs';
import { loadConfig } from './config.mjs';
import { scanDecisions } from './decisions-cli.mjs';
import { repoIdentity, servedRepository } from './forges/index.mjs';
import { checkoutHolding, resolvedPath } from './fs.mjs';
import { GIT_TIMEOUT_MS, mainRoot, runGit } from './git.mjs';
import { projectStore } from './handoff-continue.mjs';
import { latestBrief, MARKER_CAP, readArmed, readFrom, readOwnFile, SESSION_ID } from './handoff-markers.mjs';
import { HIDDEN } from './hidden-text.mjs';
import { inboxPath, lessons, lessonStats } from './lesson-inbox.mjs';
import { findProject, stateDir } from './project.mjs';
import { cachedValue } from './session-cached-value.mjs';
import { sessionFolder } from './session-folder.mjs';
import { handoffStatus, stopMarkerPath } from './session-length.mjs';
import { cachedSessionUsage } from './session-usage-cache.mjs';
import { usageLines } from './usage.mjs';
import { listWorktrees, mergedHeads } from './worktree.mjs';

export const SECTIONS = Object.freeze(['handoff', 'prs', 'lessons', 'worktrees', 'decisions', 'audits', 'ticket']);
// How long the forge calls of one snapshot may take together, in milliseconds; `--deadline-ms` shortens it.
export const FORGE_BUDGET_MS = 4000;
// The merged-heads cache: refreshed at most once a minute, and never read past 1 MiB.
export const MERGED_HEADS = Object.freeze({ name: 'merged-heads-cache.json', windowMs: 60_000, cap: 1024 * 1024 });
// Ticket prefixes: at most 32, each a letter and up to 15 letters or digits.
const PREFIX = /^[A-Za-z][A-Za-z0-9]{0,15}$/u;
const MAX_PREFIXES = 32;
// The git and gh calls this module starts, and the state folder read it asks for, hold no lock, so one past its limit
// is killed outright. The git reads inside findProject, projectStore, and inboxPath keep git's own signal, under the same
// 2 s limit.
const KILL = { killSignal: 'SIGKILL' };

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
    about: "print the session's status for a status line, as JSON or one plain line: handoff, lessons, worktrees, decisions, audits, and ticket",
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
export function snapshot({ cwd, session = null, transcript = null, ticketPrefixes = '', budgetMs = FORGE_BUDGET_MS }) {
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
    ctx = context(found, { session, transcript, validId }, errors);
  } catch {
    return { ...out, errors: [...SECTIONS] };
  }
  const { project } = ctx;
  if (validId && transcript !== null) section('handoff', () => handoffSection(ctx, session, transcript));
  section('lessons', () => lessonCounts(lessonStats(lessons(inboxPath(project, outsideCheckout(ctx).config))).open));
  section('worktrees', () => worktreesSection(ctx, validId, forgeBudget(budgetMs), errors));
  section('decisions', () => ({ provisional: unconfirmed(scanDecisions(project, { unindexed: false, config: ctx.config })) }));
  section('audits', () => ({ untriaged: listAudits(path.join(outsideCheckout(ctx).state, 'audits')).reduce((sum, each) => sum + Math.max(each.untriaged, 0), 0) }));
  section('ticket', () => ticketOf(cwd, ticketPrefixes));
  return { ...out, errors: SECTIONS.filter((name) => errors.has(name)) };
}

// What the sections share: { project, config, state, inside, folder }. `inside` says the state folder resolves inside a
// checkout, or cannot be resolved. `folder` is the session's folder, or null; a session
// that was given and has none, whether its id fails or its folder cannot be made, names the cached sections in `errors`:
// `worktrees`, `handoff` when the id fails or a transcript was given, and `prs` when the id fails or the state folder is
// inside a checkout.
function context(project, { session, transcript, validId }, errors) {
  const config = loadConfig(project).config;
  let state = null;
  try {
    state = stateDir(project, { config, read: () => KILL });
  } catch {
    // Each section that needs the state folder fails on its own.
  }
  const real = state === null ? null : resolvedPath(state);
  const inside = real === null || checkoutHolding(real, project.checkouts) !== undefined;
  const folder = validId && state !== null ? sessionFolder(state, session, { checkouts: project.checkouts }) : null;
  if (session !== null && folder === null) {
    const named = [['prs', !validId || inside], ['worktrees', true], ['handoff', !validId || transcript !== null]];
    for (const [name, failed] of named) if (failed) errors.add(name);
  }
  return { project, config, state, inside, folder };
}

// `ctx` when its state folder is outside every checkout, where its files are the user's own; else it throws.
const outsideCheckout = (ctx) => {
  if (ctx.inside) throw new Error('inside');
  return ctx;
};

const needed = (value) => {
  if (value === null || value === undefined) throw new Error('missing');
  return value;
};

const lessonCounts = ({ count, tiers }) => ({ open: count, byTier: tiers });
const unconfirmed = ({ decisions, unlisted }) => [...decisions, ...unlisted].filter(({ status }) => status === 'unconfirmed').length;

// The handoff numbers of the session, from its transcript through the usage cache, and the Stop hook's marker, at the
// hook's own path. Under `mode: off` the hook never reminds, so the level is quiet and the numbers stay.
function handoffSection({ project, config, folder }, session, transcript) {
  const usage = cachedSessionUsage({ transcript, cacheFile: path.join(needed(folder), 'usage.json') });
  const { handoff } = config.session;
  const status = handoffStatus(needed(usage), handoff, stopMarkerText(session));
  const { ratio, breakEven, nextRatio, context: tokens, ceiling } = status;
  return {
    ratio, breakEven, level: handoff.mode === 'off' ? 'quiet' : status.level, nextRatio, context: tokens, ceiling,
    ...continuationOf(projectStore(project, config), session, handoff.maxChain),
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

// { owned, mergedNotCleaned }, and `stale: true` when the merged count is a cached value past its window. `owned` counts
// the worktrees other than the main checkout. `mergedNotCleaned` counts those whose HEAD is the head commit of a merged
// pull request of their branch, without cleanup's tree and age checks; null without a session or for an origin the
// forge does not serve, and null, naming the section in `errors`, when the read fails with no cached value.
function worktreesSection({ project, folder }, validId, forge, errors) {
  const main = needed(mainRoot(project.root, KILL));
  const worktrees = listWorktrees(main, { timeoutMs: GIT_TIMEOUT_MS, ...KILL }).filter((each) => !each.main);
  const out = { owned: worktrees.length, mergedNotCleaned: null };
  const origin = runGit(['config', '--get', 'remote.origin.url'], main, KILL);
  const repo = origin.status === 0 ? servedRepository(repoIdentity(origin.stdout.trim())) : null;
  if (!validId || repo === null) return out;
  const heads = mergedHeadsOf(main, repo, folder, forge);
  if (heads === null) {
    errors.add('worktrees');
    return out;
  }
  const merged = new Set(heads.value.map(([branch, head]) => `${branch}\n${head}`));
  out.mergedNotCleaned = worktrees.filter(({ branch, head }) => branch && head && merged.has(`${branch}\n${head}`)).length;
  return heads.stale ? { ...out, stale: true } : out;
}

// The merged pull requests' [branch, head] pairs of `repo`, as the forge's repository check named it, cached:
// { value, stale }, or null.
function mergedHeadsOf(main, repo, folder, forge) {
  const refresh = () => forge((timeoutMs) => {
    const heads = mergedHeads(main, { repo, timeoutMs, ...KILL });
    return heads && [...heads].flatMap(([branch, oids]) => oids.map((oid) => [branch, oid]));
  });
  return cachedValue({ folder, ...MERGED_HEADS, isValue: isPairs, refresh });
}

const isPairs = (value) => Array.isArray(value) && value.every((pair) => Array.isArray(pair) && pair.length === 2 && pair.every((part) => typeof part === 'string'));

// The forge budget of one snapshot: the calls share `ms`, each gets what is left as its time limit, and none starts
// once it is spent.
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
export function snapshotLine({ handoff, lessons: inbox, decisions, worktrees, audits }) {
  const segments = [];
  if (handoff?.ratio > 0) {
    const pays = handoff.breakEven === null ? '' : `pays back in ~${Math.round(handoff.breakEven)} calls`;
    const armed = handoff.continueArmed ? ` · armed ${handoff.chain}/${handoff.maxChain}` : '';
    segments.push(`${LEVEL_WORDS[handoff.level](`${handoff.ratio.toFixed(1)}x`, pays)}${armed}`);
  }
  const harness = [
    [inbox?.byTier?.P1, (n) => `📥 ${n} P1`],
    [decisions?.provisional, (n) => `⚖️ ${plural(n, 'decision')}`],
    [worktrees?.mergedNotCleaned, (n) => `🧹 ${plural(n, 'worktree')}`],
    [audits?.untriaged, (n) => `🔎 ${plural(n, 'finding')}`],
  ].filter(([n]) => n > 0).map(([n, words]) => words(n));
  if (harness.length) segments.push(harness.join(' · '));
  return segments.join(' · ');
}
