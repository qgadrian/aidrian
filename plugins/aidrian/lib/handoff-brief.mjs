// `aidrian handoff`: the mechanical half of the session-handoff skill's review of a brief.
//   1. Carry-forward: a brief that supersedes another still names every backticked identifier (ids, paths, commands)
//      from the other's "Decisions locked" and "Gotchas" sections, or names it as dropped. A refresh that only points
//      at the old brief silently loses those facts. Prose-only items have no identifier; they are printed for a
//      by-hand comparison instead.
//   2. Line length: Markdown lines over config.json `docs.wrapLimit`, for hosts without the PostToolUse wrap hook.
//   3. The advice line: above its first section, the brief says it is an agent's advice, not a spec (ADVICE_LINE), so
//      the session that resumes it checks its claims against the docs and code instead of building on them as fact.
// The prior brief is --prior, else the snapshot `snapshot` took before an overwrite, else the newest other brief with
// the same slug (<date>-<slug>.md). A passing check removes the snapshot.
//   4. The chain: `Chain: n` above the first section counts the automatic continuations in a row that led to the
//      brief (chainOf). It must be a whole number, and no lower than the floor the session was given when a continuation
//      started it (lib/handoff-markers.mjs readFrom). A brief right inside `<state>/handoffs/` that passes is stamped with
//      the sha256 of its bytes, which `aidrian handoff continue` (lib/handoff-continue.mjs) requires.

import { createHash } from 'node:crypto';
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { commandConfig } from './config.mjs';
import { openStore, readFrom, slugOf, stampChecked } from './handoff-markers.mjs';
import { sessionIdentity } from './hosts/index.mjs';
import { findWrapViolations } from './markdown-wrap.mjs';
import { projectAt, stateDir } from './project.mjs';
import { usageLines } from './usage.mjs';

const CARRIED_SECTION = /^(decisions|gotchas)\b/i;
// The template's line: `Advice from <writer>, not a spec: check each claim against the docs and code before building on it.`
export const ADVICE_LINE = /^Advice from \S.*, not a spec\b/mu;
const BRIEF_NAME = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/;
// Shorter spans (`!`, `ok`) are syntax, not identifiers.
const MIN_IDENTIFIER_LENGTH = 3;
// A wrap is not an edit: whitespace runs, newlines included, compare as one space.
const flat = (text) => text.replace(/\s+/g, ' ');

export const commands = {
  handoff: {
    usage: '(check | snapshot) BRIEF [--prior BRIEF] | continue BRIEF [--route ROUTE]',
    about: 'snapshot the brief a refresh supersedes, check the new brief carries its identifiers and wraps its lines, then arm its continuation',
    async run(args) {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { prior: { type: 'string' }, route: { type: 'string' } } });
      const [action, brief, ...extra] = positionals;
      const shaped = action === 'continue' ? values.prior === undefined : ['check', 'snapshot'].includes(action) && values.route === undefined;
      if (!shaped || !brief || extra.length) return problem(usageLines('handoff', commands.handoff.usage, 'usage: ').join('\n'));
      if (action === 'continue') {
        const { continueBrief } = await import('./handoff-continue.mjs');
        const { exitCode, out, err } = continueBrief(brief, { override: values.route, chainOf });
        if (out.length) console.log(out.join('\n'));
        if (err.length) console.error(err.join('\n'));
        return exitCode;
      }
      const briefPath = path.resolve(brief);
      const prior = values.prior && path.resolve(values.prior);
      const priorProblem = prior && unreadable(prior);
      if (priorProblem) return problem(`--prior ${prior} ${priorProblem}`);
      // `snapshot` runs before the first write, so only there may the brief not exist yet.
      const briefProblem = unreadable(briefPath);
      if (briefProblem && !(action === 'snapshot' && briefProblem === 'does not exist')) return problem(`${briefPath} ${briefProblem}`);
      if (action === 'snapshot') {
        const taken = takeSnapshot(briefPath, prior);
        if (taken?.problem) return problem(`${taken.source} ${taken.problem}`);
        console.log(taken ? `saved ${taken.source} to ${taken.snapshot}` : 'no brief to supersede; check compares nothing unless given --prior');
        return 0;
      }
      // A config with errors exits 2, as an unreadable input does: it is not a finding.
      const project = projectAt(process.cwd());
      const config = commandConfig(project, { exitCode: 2 });
      const { exitCode, lines } = checkBrief(briefPath, prior, config.docs.wrapLimit, continueSetting(project, config, briefPath));
      (exitCode === 0 ? console.log : console.error)(lines.join('\n'));
      return exitCode;
    },
  },
};

// What the check needs of the continuation store: { store, floor }. `floor` is the chain the session running the
// check was given for this brief's slug when a continuation started it, else 0. Without a state folder git can tell,
// the brief is checked as before: no floor and no stamp.
function continueSetting(project, config, briefPath, env = process.env) {
  let store;
  try {
    store = openStore(stateDir(project, { config, env }), { checkouts: project.checkouts, maxChain: config.session.handoff.maxChain });
  } catch {
    return { store: null, floor: 0 };
  }
  const { session } = sessionIdentity(env);
  const from = session ? readFrom(store, session) : null;
  return { store, floor: from && from.slug === slugOf(briefPath) ? from.chain : 0 };
}

// The chain count of a brief: the whole number of its `Chain:` field above the first section, 0 when it has none, and
// null when the value is no whole number.
export function chainOf(text) {
  const header = String(text ?? '').split(/^##\s/mu)[0];
  const match = /(?<![\w-])Chain:[ \t]*([^|\n]*)/iu.exec(header);
  if (!match) return 0;
  const value = match[1].trim();
  return /^\d{1,9}$/u.test(value) ? Number(value) : null;
}

// The findings for a brief's chain count against the session's `floor`.
function chainProblems(text, floor) {
  const chain = chainOf(text);
  if (chain === null) return ['Chain: the value is not a whole number: write `Chain: <n>`, the automatic continuations in a row that led here, 0 or more'];
  if (chain < floor) return [`Chain: ${chain} is below ${floor}, the count this session continues: write \`Chain: ${floor}\``];
  return [];
}

// Exit 2 with one line: an input that cannot be read is not a finding.
function problem(message) {
  console.error(message);
  return 2;
}

const FENCE = /^(`{3,}|~{3,})(.*)$/;

// Fence state after `line`: null outside a fence. A fence closes only on its own character, at least as long as the
// opener, with nothing but spaces after it; so a ```` block can show a ``` line, and a ```js line inside a block is code.
function nextFenceState(fence, line) {
  const match = FENCE.exec(String(line ?? '').trimStart());
  if (!match) return fence;
  if (fence === null) return { char: match[1][0], length: match[1].length };
  if (match[1][0] !== fence.char || match[1].length < fence.length) return fence;
  return /^[ \t]*\r?$/.test(match[2]) ? null : fence;
}

// `<dir>/.prior/<name>`: where `snapshot` keeps the brief an overwrite destroys.
export function snapshotPath(briefPath) {
  return path.join(path.dirname(briefPath), '.prior', path.basename(briefPath));
}

// The top-level items of the carried sections: a line at column 0 with its indented lines and fenced blocks.
export function carriedItems(text) {
  const items = [];
  let section = null;
  let current = null;
  let fence = null;
  for (const line of String(text ?? '').split('\n')) {
    const wasFenced = fence !== null;
    fence = nextFenceState(fence, line);
    const fenced = wasFenced || fence !== null;
    const heading = !fenced && line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      section = CARRIED_SECTION.test(heading[1]) ? heading[1].replace(/\s*\(.*$/, '') : null;
      current = null;
      continue;
    }
    if (!section || !line.trim()) continue;
    if (!current || (!fenced && /^\S/.test(line))) {
      current = { section, text: line, spanSource: '' };
      items.push(current);
    } else {
      current.text += `\n${line}`;
    }
    // Prose lines join, since a span may wrap; a code line stands alone; a fence delimiter holds no span.
    current.spanSource += !fenced ? ` ${line}` : wasFenced && fence !== null ? `\n${line}\n` : '\n';
  }
  return items.map(({ spanSource, ...item }) => ({
    ...item,
    identifiers: [...new Set([...spanSource.matchAll(/`([^`\n]+)`/g)].map((match) => flat(match[1]).trim()).filter((span) => span.length >= MIN_IDENTIFIER_LENGTH))],
  }));
}

// { missing: [{ section, snippet, identifiers }], unchecked: [{ section, text }] }. An identifier the prior abbreviated
// (`sub_1SIK…`) counts as carried when its prefix is.
export function findCarryGaps(briefText, priorText) {
  const missing = [];
  const unchecked = [];
  const flatBrief = flat(briefText);
  for (const item of carriedItems(priorText)) {
    if (item.identifiers.length === 0) {
      unchecked.push({ section: item.section, text: item.text });
      continue;
    }
    const lost = item.identifiers.filter((identifier) => !flatBrief.includes(identifier.replace(/(…|\.\.\.)$/, '')));
    if (lost.length) missing.push({ section: item.section, snippet: item.text.split('\n')[0].trim().slice(0, 100), identifiers: lost });
  }
  return { missing, unchecked };
}

// The newest other `<date>-<slug>.md` beside the brief with the same slug, dated no later than it; or null.
export function findSupersededBrief(briefPath) {
  const dir = path.dirname(briefPath);
  const name = path.basename(briefPath);
  const match = name.match(BRIEF_NAME);
  if (!match || !existsSync(dir)) return null;
  const newest = readdirSync(dir)
    .filter((file) => {
      const other = file.match(BRIEF_NAME);
      return file !== name && other?.[2] === match[2] && other[1] <= match[1];
    })
    .sort()
    .at(-1);
  return newest ? path.join(dir, newest) : null;
}

export function resolvePrior(briefPath, explicitPrior) {
  if (explicitPrior) return { path: explicitPrior, source: 'explicit' };
  if (existsSync(snapshotPath(briefPath))) return { path: snapshotPath(briefPath), source: 'snapshot' };
  const sameSlug = findSupersededBrief(briefPath);
  return sameSlug ? { path: sameSlug, source: 'same slug' } : null;
}

// Copies what the coming write supersedes into the snapshot, or clears a stale snapshot when nothing is.
export function takeSnapshot(briefPath, explicitPrior) {
  const snapshot = snapshotPath(briefPath);
  const source = explicitPrior ?? (existsSync(briefPath) ? briefPath : findSupersededBrief(briefPath));
  if (!source) {
    rmSync(snapshot, { force: true });
    return null;
  }
  const reason = unreadable(source);
  if (reason) return { source, problem: reason };
  mkdirSync(path.dirname(snapshot), { recursive: true });
  copyFileSync(source, snapshot);
  return { source, snapshot };
}

// The finding for a brief with no advice line above its first section, or null.
export const adviceProblem = (text) =>
  ADVICE_LINE.test(text.split(/^##\s/mu)[0]) ? null : 'No advice line above the first section: add "Advice from <writer>, not a spec: check each claim against the docs and code before building on it."';

// { exitCode: 0 clean, 1 findings, 2 an unreadable prior; lines }. `limit` 0 skips the line-length check. `floor` is the
// lowest chain count the brief may give; `store`, the continuation store, takes the stamp of a brief that passes.
export function checkBrief(briefPath, explicitPrior, limit = 155, { floor = 0, store = null } = {}) {
  const bytes = readFileSync(briefPath);
  const briefText = bytes.toString('utf8');
  const advice = adviceProblem(briefText);
  const chain = chainProblems(briefText, floor);
  const lines = [`handoff check: ${briefPath}`, ...(advice ? [advice] : []), ...chain];
  let findings = (advice ? 1 : 0) + chain.length;
  const wrap = limit > 0 ? findWrapViolations(briefText, limit) : [];
  if (wrap.length) {
    findings += wrap.length;
    lines.push(`Lines over ${limit} characters (wrap them): ${wrap.map((hit) => `L${hit.line} (${hit.length})`).join(', ')}`);
  }
  const prior = resolvePrior(briefPath, explicitPrior);
  const priorProblem = prior && unreadable(prior.path);
  if (priorProblem) return { exitCode: 2, lines: [`${prior.path} ${priorProblem}`] };
  if (!prior) {
    lines.push('Carry-forward: no superseded brief found; nothing to compare.');
  } else {
    const { missing, unchecked } = findCarryGaps(briefText, readFileSync(prior.path, 'utf8'));
    lines.push(`Carry-forward against ${prior.path} (${prior.source}):`);
    if (!missing.length) lines.push('  every identifier from its Decisions locked and Gotchas is still named.');
    else {
      const count = missing.reduce((sum, item) => sum + item.identifiers.length, 0);
      findings += count;
      lines.push(`  ${count} identifier(s) no longer named. Carry each, or name it with why it is obsolete:`);
      for (const item of missing) lines.push(`  - [${item.section}] ${item.identifiers.map((id) => `\`${id}\``).join(', ')}`, `      from: ${item.snippet}`);
    }
    if (unchecked.length) {
      lines.push(`  ${unchecked.length} prose-only item(s) carry no identifier; compare each by hand:`);
      for (const item of unchecked) {
        const [first, ...rest] = item.text.split('\n');
        lines.push(`  - [${item.section}] ${first.trim()}`, ...rest.map((line) => `    ${line}`));
      }
    }
  }
  if (findings === 0) {
    rmSync(snapshotPath(briefPath), { force: true });
    if (store) stamp(store, briefPath, bytes, lines);
    lines.push('OK');
  }
  return { exitCode: findings === 0 ? 0 : 1, lines };
}

// Stamps a brief that passed for the continue gate. A stamp the disk refuses changes no exit code: the gate then asks
// for the check again.
function stamp(store, briefPath, bytes, lines) {
  try {
    stampChecked(store, briefPath, createHash('sha256').update(bytes).digest('hex'));
  } catch (error) {
    lines.push(`The pass could not be recorded for \`aidrian handoff continue\` (${error.code ?? error.message}).`);
  }
}

// Why a path cannot be read as a brief, or null.
function unreadable(file) {
  try {
    if (!statSync(file).isFile()) return 'is not a file';
    accessSync(file, constants.R_OK);
    return null;
  } catch (error) {
    return error.code === 'ENOENT' ? 'does not exist' : `cannot be read (${error.code})`;
  }
}
