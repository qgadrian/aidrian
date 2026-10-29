// `aidrian handoff`: the mechanical half of the session-handoff skill's review of a brief.
//   1. Carry-forward: a brief that supersedes another still names every backticked identifier (ids, paths, commands)
//      from the other's "Decisions locked" and "Gotchas" sections, or names it as dropped. A refresh that only points
//      at the old brief silently loses those facts. Prose-only items have no identifier; they are printed for a
//      by-hand comparison instead.
//   2. Line length: Markdown lines over config.json `docs.wrapLimit`, for hosts without the PostToolUse wrap hook.
// The prior brief is --prior, else the snapshot `snapshot` took before an overwrite, else the newest other brief with
// the same slug (<date>-<slug>.md). A passing check removes the snapshot.

import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { commandConfig } from './config.mjs';
import { findWrapViolations, nextFenceState } from './markdown-wrap.mjs';
import { projectAt } from './project.mjs';

const CARRIED_SECTION = /^(decisions|gotchas)\b/i;
const BRIEF_NAME = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/;
// Shorter spans (`!`, `ok`) are syntax, not identifiers.
const MIN_IDENTIFIER_LENGTH = 3;
// A wrap is not an edit: whitespace runs, newlines included, compare as one space.
const flat = (text) => text.replace(/\s+/g, ' ');

export const commands = {
  handoff: {
    usage: '(check | snapshot) BRIEF [--prior BRIEF]',
    about: 'snapshot the brief a refresh supersedes, then check the new brief carries its identifiers and wraps its lines',
    run(args) {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { prior: { type: 'string' } } });
      const [action, brief, ...extra] = positionals;
      if (!['check', 'snapshot'].includes(action) || !brief || extra.length) return problem(`usage: aidrian handoff ${commands.handoff.usage}`);
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
      const { exitCode, lines } = checkBrief(briefPath, prior, commandConfig(projectAt(process.cwd()), { exitCode: 2 }).docs.wrapLimit);
      (exitCode === 0 ? console.log : console.error)(lines.join('\n'));
      return exitCode;
    },
  },
};

// Exit 2 with one line: an input that cannot be read is not a finding.
function problem(message) {
  console.error(message);
  return 2;
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

// { exitCode: 0 clean, 1 findings, 2 an unreadable prior; lines }. `limit` 0 skips the line-length check.
export function checkBrief(briefPath, explicitPrior, limit = 155) {
  const briefText = readFileSync(briefPath, 'utf8');
  const lines = [`handoff check: ${briefPath}`];
  let findings = 0;
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
    lines.push('OK');
  }
  return { exitCode: findings === 0 ? 0 : 1, lines };
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
