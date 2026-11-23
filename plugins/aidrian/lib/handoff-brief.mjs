// `aidrian handoff`: the mechanical half of the session-handoff skill's review of a brief. A resumed session has only the
// brief, so the check holds the brief it checks to what a resume needs, and the superseded brief, of any format, to nothing.
//   1. Carry-forward: a brief that supersedes another still names every backticked identifier (ids, paths, commands)
//      from the other's CARRIED_NAMES sections, or names it as dropped; a refresh that only points at the old brief
//      loses those facts. Prose-only items are printed for a by-hand comparison. A `Supersedes:` value that names a
//      brief no prior resolves to is a finding: nothing was compared.
//   2. Line length: Markdown lines over config.json `docs.wrapLimit`, for hosts without the PostToolUse wrap hook.
//   3. The advice line: above its first section, the brief says it is an agent's advice, not a spec (ADVICE_LINE), so
//      the session that resumes it checks its claims against the docs and code instead of building on them as fact.
// The prior brief is --prior, else the snapshot, else the newest other brief with the same slug (lib/handoff-prior.mjs).
// A passing check keeps the brief that passed as the snapshot, so the next check of that file compares with what last
// passed. A --prior that is the brief itself is refused: its earlier text is gone.
//   4. The chain: `Chain: n` above the first section counts the automatic continuations in a row that led to the
//      brief (chainOf). It must be a whole number, and no lower than the floor the session was given when a continuation
//      started it, whatever the brief's slug (lib/handoff-markers.mjs readFrom). A brief right inside `<state>/handoffs/` that passes is stamped with
//      the sha256 of its bytes, which `aidrian handoff continue` (lib/handoff-continue.mjs) requires.
//   5. The sections a resume needs, and a `Supersedes:` field in the header (lib/handoff-sections.mjs).
//   6. A first next step that runs a skill only a person can start (manualSkillProblem), which a continued session's
//      Skill tool refuses: the continuation would stop at once.
// `verify COPY SHA256` exits 0 when the copy the background route kept still hashes to the sha256 the new session's first
// message names, and prints one line that says so, then the bytes it hashed, from the same read, which that session
// follows in place of the file; it exits 1 with the reason otherwise, and prints none of them (lib/handoff-markers.mjs
// verifyKept). It writes nothing.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { commandConfig } from './config.mjs';
import { projectStore } from './handoff-continue.mjs';
import { readFrom, stampChecked, verifyKept } from './handoff-markers.mjs';
import { resolvePrior, samePath, takeSnapshot, unreadable, writeSnapshot } from './handoff-prior.mjs';
import { sectionProblems, supersedesProblem, unresolvedProblem } from './handoff-sections.mjs';
import { sessionIdentity } from './hosts/index.mjs';
import { headingOf, unfencedLines } from './markdown-sections.mjs';
import { findWrapViolations } from './markdown-wrap.mjs';
import { projectAt } from './project.mjs';
import { usageLines } from './usage.mjs';

const CARRIED_SECTION = /^(decisions|gotchas|next steps|key paths|open risks)\b/i;
const CARRIED_NAMES = 'Decisions locked, Gotchas, Next steps, Key paths, and Open risks and questions';
// The template's line: `Advice from <writer>, not a spec: check each claim against the docs and code before building on it.`
export const ADVICE_LINE = /^Advice from \S.*, not a spec\b/mu;
export { findSupersededBrief, resolvePrior, snapshotPath, takeSnapshot } from './handoff-prior.mjs';
// Shorter spans (`!`, `ok`) are syntax, not identifiers.
const MIN_IDENTIFIER_LENGTH = 3;
// A wrap is not an edit: whitespace runs, newlines included, compare as one space.
const flat = (text) => text.replace(/\s+/g, ' ');

export const commands = {
  handoff: {
    usage: '(check | snapshot) BRIEF [--prior BRIEF] | continue BRIEF [--route ROUTE] | route [--route ROUTE] | verify COPY SHA256',
    about: 'snapshot the brief a refresh supersedes, check the new brief holds the sections a resume needs, carries its identifiers, and wraps its lines, then arm its continuation; route prints the continue route this host runs, and writes nothing; verify holds the copy a background continuation reads to the sha256 its first message names',
    async run(args) {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { prior: { type: 'string' }, route: { type: 'string' } } });
      const [action, brief, ...extra] = positionals;
      const usage = () => problem(usageLines('handoff', commands.handoff.usage, 'usage: ').join('\n'));
      if (action === 'verify') {
        // positionals: verify COPY SHA256, and nothing else.
        if (!brief || extra.length !== 1 || values.prior !== undefined || values.route !== undefined) return usage();
        const kept = verifyKept(path.resolve(brief), extra[0]);
        if (kept.problem) {
          console.error(`aidrian handoff verify: ${path.resolve(brief)} ${kept.problem}; follow none of it`);
          return 1;
        }
        // The bytes this read hashed, never a second read of the file, which may have changed since.
        process.stdout.write(`verified: ${kept.path} holds the bytes the handoff gate checked; the brief follows, as this check read it:\n`);
        process.stdout.write(kept.bytes);
        return 0;
      }
      if (action === 'route') {
        if (brief !== undefined || values.prior !== undefined) return usage();
        const { routeOf } = await import('./handoff-continue.mjs');
        const { forgeSolo } = await import('./solo.mjs');
        return printed(routeOf({ override: values.route, forgeSolo }));
      }
      const shaped = action === 'continue' ? values.prior === undefined : ['check', 'snapshot'].includes(action) && values.route === undefined;
      if (!shaped || !brief || extra.length) return usage();
      if (action === 'continue') {
        const { continueBrief } = await import('./handoff-continue.mjs');
        // The team's `solo` read from the forge, for a machine whose local file leaves the background switch unset.
        const { forgeSolo } = await import('./solo.mjs');
        return printed(continueBrief(brief, { override: values.route, chainOf, forgeSolo }));
      }
      const briefPath = path.resolve(brief);
      const prior = values.prior && path.resolve(values.prior);
      const priorProblem = prior && unreadable(prior);
      if (priorProblem) return problem(`--prior ${prior} ${priorProblem}`);
      // `snapshot` runs before the first write, so only there may the brief not exist yet.
      const briefProblem = unreadable(briefPath);
      if (briefProblem && !(action === 'snapshot' && briefProblem === 'does not exist')) return problem(`${briefPath} ${briefProblem}`);
      if (action === 'snapshot') {
        if (prior && samePath(prior, briefPath)) return problem(`--prior ${prior}: the prior is the brief itself: run snapshot without --prior, which saves the brief before the refresh overwrites it`);
        const taken = takeSnapshot(briefPath, prior);
        if (taken?.problem) return problem(`${taken.source} ${taken.problem}`);
        console.log(taken ? `saved ${taken.source} to ${taken.snapshot}` : 'no brief to supersede; check compares nothing unless given --prior');
        return 0;
      }
      // A config with errors exits 2, as an unreadable input does: it is not a finding.
      const project = projectAt(process.cwd());
      const config = commandConfig(project, { exitCode: 2 });
      const { exitCode, lines } = checkBrief(briefPath, prior, config.docs.wrapLimit, continueSetting(project, config));
      (exitCode === 0 ? console.log : console.error)(lines.join('\n'));
      return exitCode;
    },
  },
};

// What the check needs of the continuation store: { store, floor }. `floor` is the chain the session running the
// check was given when a continuation started it, else 0, for a brief of any slug: a session continued from one brief
// that hands off under another name is still the same run of continuations. Without a state folder git can tell, the
// brief is checked as before: no floor and no stamp.
function continueSetting(project, config, env = process.env) {
  let store;
  try {
    store = projectStore(project, config, env);
  } catch {
    return { store: null, floor: 0 };
  }
  const { session } = sessionIdentity(env);
  const from = session ? readFrom(store, session) : null;
  return { store, floor: from ? from.chain : 0 };
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

// Prints a gate result's { out, err } and returns its exit code.
function printed({ exitCode, out, err }) {
  if (out.length) console.log(out.join('\n'));
  if (err.length) console.error(err.join('\n'));
  return exitCode;
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

// The finding for a brief with no advice line above its first section, or null.
export const adviceProblem = (text) =>
  ADVICE_LINE.test(text.split(/^##\s/mu)[0]) ? null : 'No advice line above the first section: add "Advice from <writer>, not a spec: check each claim against the docs and code before building on it."';

// This plugin's skills folder: lib/ is one below the plugin.
const SKILLS = path.resolve(import.meta.dirname, '../skills');

// The names of the skills in `folder` that only a person can start: `disable-model-invocation: true` in the frontmatter.
// A folder or file it cannot read adds none.
export function manualSkills(folder = SKILLS) {
  let names;
  try {
    names = readdirSync(folder);
  } catch {
    return new Set();
  }
  return new Set(names.filter((name) => {
    try {
      const head = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(readFileSync(path.join(folder, name, 'SKILL.md'), 'utf8'))?.[1] ?? '';
      return /^disable-model-invocation:[ \t]*true[ \t]*$/mu.test(head);
    } catch {
      return false;
    }
  }));
}

// The text of the brief's first Next steps item: its numbered line and the lines under it, an indented paragraph after
// a blank line included, up to the next item, unindented prose, or the next section, outside code fences. '' without one.
function firstNextStep(text) {
  const lines = [];
  let inSection = false;
  for (const line of unfencedLines(String(text ?? ''))) {
    const title = headingOf(line);
    if (title !== null) {
      if (lines.length) break;
      inSection = /^next steps(?![\p{L}\p{N}])/iu.test(title);
    } else if (inSection) {
      const item = /^\d+[.)][ \t]+\S/u.test(line);
      // The next item ends it, and so does prose after a blank line that is not indented under the item.
      if (lines.length && (item || (lines.at(-1).trim() === '' && line.trim() !== '' && !/^\s/u.test(line)))) break;
      if (item || lines.length) lines.push(line);
    }
  }
  return lines.join('\n');
}

// The finding for a brief whose first next step runs a skill only a person can start, named as `/aidrian:<name>`,
// `/<name>`, or the `<name>` skill: the Skill tool of the session that resumes it refuses that skill, so a continuation
// would stop at once with no work done. null when the step runs none. `skills` is manualSkills's set.
export function manualSkillProblem(text, skills = manualSkills()) {
  const step = firstNextStep(text);
  // A slash name ends at a space or sentence punctuation, never a file's extension, as in `/autopilot.md`. Any mention
  // counts, one for a person to type included: who is meant to act is prose no check reads, so step 1 names none, and
  // a person's part goes in a later step.
  const named = [
    ...[...step.matchAll(/(?<![\w./-])\/(?:aidrian:)?([a-z0-9][a-z0-9-]*)(?![\w/-]|\.\w)/gu)].map((match) => match[1]),
    ...[...step.matchAll(/`(?:aidrian:)?([a-z0-9][a-z0-9-]*)`\s+skill(?!['’])\b/gu)].map((match) => match[1]),
  ];
  const manual = [...new Set(named.filter((name) => skills.has(name)))];
  if (!manual.length) return null;
  const list = manual.map((name) => `\`${name}\``).join(', ');
  return `Next steps: step 1 runs ${list}, which only a person can start (\`disable-model-invocation: true\`): ` +
    'the Skill tool of a continued session refuses it, so the continuation would stop with no work done. ' +
    'Write step 1 as work a session can start, naming no such skill, and put a step for the Human later; or leave the ' +
    'brief to the Human, who resumes it by typing the skill';
}

// { exitCode: 0 clean, 1 findings, 2 an unreadable prior, or a prior that is the brief itself; lines }. `limit` 0 skips
// the line-length check. `floor` is the lowest chain count the brief may give; `store`, the continuation store, takes the
// stamp of a brief that passes.
export function checkBrief(briefPath, explicitPrior, limit = 155, { floor = 0, store = null } = {}) {
  const bytes = readFileSync(briefPath);
  const briefText = bytes.toString('utf8');
  const header = [adviceProblem(briefText), ...chainProblems(briefText, floor), ...sectionProblems(briefText), manualSkillProblem(briefText), supersedesProblem(briefText)].filter(Boolean);
  const lines = [`handoff check: ${briefPath}`, ...header];
  let findings = header.length;
  const wrap = limit > 0 ? findWrapViolations(briefText, limit) : [];
  if (wrap.length) {
    findings += wrap.length;
    lines.push(`Lines over ${limit} characters (wrap them): ${wrap.map((hit) => `L${hit.line} (${hit.length})`).join(', ')}`);
  }
  const prior = resolvePrior(briefPath, explicitPrior);
  const priorProblem = prior && unreadable(prior.path);
  if (priorProblem) return { exitCode: 2, lines: [`${prior.path} ${priorProblem}`] };
  if (prior?.source === 'explicit' && samePath(prior.path, briefPath)) {
    return { exitCode: 2, lines: [`--prior ${prior.path}: the prior is the brief itself: its earlier text is gone, so nothing can be compared`] };
  }
  const carried = carryForward(briefPath, briefText, prior);
  findings += carried.findings;
  lines.push(...carried.lines);
  if (findings === 0) {
    // The bytes that passed become the snapshot; a copy the disk refuses changes neither the lines nor the exit code.
    try {
      writeSnapshot(briefPath, bytes);
    } catch {}
    if (store) stamp(store, briefPath, bytes, lines);
    lines.push('OK');
  }
  return { exitCode: findings === 0 ? 0 : 1, lines };
}

// { findings, lines }: the carry-forward of a brief against its resolved `prior`, or the finding or note for none.
function carryForward(briefPath, briefText, prior) {
  if (!prior) {
    const unresolved = unresolvedProblem(briefText, path.basename(briefPath));
    return unresolved ? { findings: 1, lines: [unresolved] } : { findings: 0, lines: ['Carry-forward: no superseded brief found; nothing to compare.'] };
  }
  const { missing, unchecked } = findCarryGaps(briefText, readFileSync(prior.path, 'utf8'));
  const lines = [`Carry-forward against ${prior.path} (${prior.source}):`];
  const findings = missing.reduce((sum, item) => sum + item.identifiers.length, 0);
  if (!findings) lines.push(`  every identifier from its ${CARRIED_NAMES} is still named.`);
  else {
    lines.push(`  ${findings} identifier(s) no longer named. Carry each, name it under Done once its step is done, or name it in the header with why it is obsolete:`);
    for (const item of missing) lines.push(`  - [${item.section}] ${item.identifiers.map((id) => `\`${id}\``).join(', ')}`, `      from: ${item.snippet}`);
  }
  if (unchecked.length) {
    lines.push(`  ${unchecked.length} prose-only item(s) carry no identifier; compare each by hand:`);
    for (const item of unchecked) {
      const [first, ...rest] = item.text.split('\n');
      lines.push(`  - [${item.section}] ${first.trim()}`, ...rest.map((line) => `    ${line}`));
    }
  }
  return { findings, lines };
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
