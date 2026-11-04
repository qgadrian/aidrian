// Who settles a product or design decision a session meets: the agent ("decide") or the Human ("ask").
// decisions.json is the only place the decision classes and the reversibility questions live; config.json `decisions`
// sets how far a project lets agents go (docs/config.md#decisions). resolveAuthority walks a fixed order and the first
// rule that matches wins, so no prompt weighs these by hand.
// config.mjs reads this file from every hook, so of the plugin's files it imports only markdown-sections.mjs, which imports nothing.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { slug } from './markdown-sections.mjs';

export const VOCAB_PATH = path.join(import.meta.dirname, 'decisions.json');

// The authority modes, lowest first: "ask" leaves every decision to the Human; "decide-reversible" lets an agent
// settle one that every reversibility question answers no to.
export const DECISION_MODES = ['ask', 'decide-reversible'];

// The domains config.json `decisions.domains` sets one by one.
export const DECISION_DOMAINS = ['product', 'ux', 'architecture', 'backlog'];

let vocab;
// decisions.json, read once.
export const loadVocab = () => (vocab ??= JSON.parse(readFileSync(VOCAB_PATH, 'utf8')));

// Every class name, floor classes first, as decisions.json lists them.
export const decisionClasses = (table = loadVocab()) => table.classes.map((entry) => entry.class);

// The lower of two modes; a mode outside DECISION_MODES counts as "ask".
export const lowerMode = (a, b) => DECISION_MODES[Math.min(Math.max(DECISION_MODES.indexOf(a), 0), Math.max(DECISION_MODES.indexOf(b), 0))];

// The decision on one question. `config` is a loaded config, or its `decisions` block. The question:
// - `domain`: one of DECISION_DOMAINS; `class`: a class of decisions.json;
// - `reversible`: { storedData, external, pricingOrContract, visibleBeforeReview }, each true (yes) or false (no);
//   an answer that is missing, or anything but false, asks;
// - `docs`: the doc paths the decision touches, from the project root, each with an optional `#section`, matched
//   against `escalateDocs`; one outside the project asks;
// - `pending`: the unreviewed decisions so far, as [{ domain, date }], for the domain pause.
// Returns { authority: "decide" | "ask", rule, reason }: `rule` names the rule that matched, `reason` says why.
export function resolveAuthority(config, { domain, class: kind, reversible, docs = [], pending = [] } = {}, { now = new Date(), table = loadVocab() } = {}) {
  const block = config.decisions ?? config;
  const ask = (rule, reason) => ({ authority: 'ask', rule, reason });
  const entry = table.classes.find((each) => each.class === kind);
  if (!entry) return ask('unknown-class', `${JSON.stringify(kind ?? null)} is no class of decisions.json, so it goes to the Human`);
  if (entry.floor) return ask('floor-class', `${kind} is a floor class: it always goes to the Human`);
  if (block.escalate.includes(kind)) return ask('escalate', `config.json decisions.escalate lists ${kind}`);
  const away = docs.find((each) => outsideProject(docParts(each)));
  if (away !== undefined) return ask('doc-outside-project', `${away} is outside the project, so no rule of the project covers it`);
  const doc = docs.find((each) => block.escalateDocs.some((listed) => docMatches(listed, each)));
  if (doc !== undefined) return ask('escalate-doc', `config.json decisions.escalateDocs covers ${doc}`);
  for (const key of Object.keys(table.reversibility)) {
    const answer = reversible?.[key];
    if (answer !== false) return ask('reversibility', `${key} is ${answer === true ? 'yes' : 'unanswered'}: ${table.reversibility[key]}`);
  }
  if (!DECISION_DOMAINS.includes(domain)) return ask('unknown-domain', `${JSON.stringify(domain ?? null)} is not one of ${DECISION_DOMAINS.join(', ')}`);
  const paused = pauseReason(block.unreviewed.pauseDomainAt, pending.filter((each) => each?.domain === domain), now);
  if (paused) return ask('domain-paused', `${domain} is paused: ${paused}`);
  const own = block.domains[domain];
  const [mode, rule] = own === 'inherit' ? [block.mode, 'mode'] : [own, `domains.${domain}`];
  const effective = lowerMode(mode, block.maxMode);
  if (effective !== mode) return ask('maxMode', `${rule} is ${mode}, above decisions.maxMode ${block.maxMode}`);
  if (effective === 'decide-reversible') return { authority: 'decide', rule, reason: `${rule} is decide-reversible and every reversibility answer is no` };
  return ask(rule, `${rule} is ask`);
}

// Why `pending`, one domain's unreviewed decisions, pauses that domain under `limits` ({ pending, oldestDays } or
// null), or null. A date that does not parse still counts toward `pending`.
function pauseReason(limits, pending, now) {
  if (!limits) return null;
  if (pending.length >= limits.pending) return `${pending.length} unreviewed decisions, the pause is at ${limits.pending}`;
  const ages = pending.map((each) => Math.floor((now - Date.parse(each.date)) / 86_400_000)).filter(Number.isFinite);
  const oldest = ages.length ? Math.max(...ages) : -1;
  if (oldest >= limits.oldestDays) return `the oldest unreviewed decision is ${oldest} days old, the pause is at ${limits.oldestDays}`;
  return null;
}

// One spelling of a doc path: { file, anchor }, with `file` normalised and no trailing slash, so `docs//a.md`,
// `./docs/a.md`, and `docs/x/../a.md` are one doc; the project root is ".". `anchor` is the section's slug, or empty,
// so `#Refund-Policy` and `#refund policy` name one section.
function docParts(value) {
  const text = String(value).trim().replaceAll('\\', '/');
  const at = text.indexOf('#');
  const [file, anchor] = at === -1 ? [text, ''] : [text.slice(0, at), text.slice(at + 1)];
  return { file: path.posix.normalize(file || '.').replace(/(?<=.)\/+$/u, ''), anchor: slug(anchor) };
}

const outsideProject = ({ file }) => file === '..' || file.startsWith('../') || file.startsWith('/');

// Whether the folder or file `outer` is `inner` or holds it.
const holds = (outer, inner) => outer === '.' || inner === outer || inner.startsWith(`${outer}/`);

// Whether the `escalateDocs` entry `listed` covers the doc `doc`. A doc that is a folder holding the entry is covered:
// what it touches includes the entry. An entry with no section covers its file, whatever the doc's section, and every
// file of its folder. An entry `file#section` covers that section, and the file with no section named, which may
// include it; another section of the file is not covered. Paths compare in any case, so an entry asks alike on a disk
// that ignores case and on one that does not; two docs that differ only by case both ask, which fails closed.
function docMatches(listed, doc) {
  const entry = docParts(listed);
  const wanted = docParts(doc);
  const entryFile = entry.file.toLowerCase();
  const wantedFile = wanted.file.toLowerCase();
  if (wantedFile !== entryFile && holds(wantedFile, entryFile)) return true;
  if (!entry.anchor) return holds(entryFile, wantedFile);
  return wantedFile === entryFile && (!wanted.anchor || wanted.anchor === entry.anchor);
}

// What `aidrian check` warns about in a loaded config's `decisions`: a setting that lets unreviewed decisions pile up
// with nothing to say so or to stop them, and a `mode` or domain above `maxMode`, which the resolver holds to ask.
export function decisionWarnings(config) {
  const { mode, maxMode, domains, unreviewed: { remind, pauseDomainAt } } = config.decisions;
  const warnings = [];
  if (remind === 'off' && pauseDomainAt === null) {
    warnings.push('decisions.unreviewed: "remind" is "off" and "pauseDomainAt" is null, so unreviewed decisions pile up unseen; turn one back on');
  }
  const settings = [['decisions.mode', mode], ...Object.entries(domains).map(([domain, value]) => [`decisions.domains.${domain}`, value])];
  for (const [key, value] of settings) {
    if (value === 'inherit' || lowerMode(value, maxMode) === value) continue;
    warnings.push(`${key}: "${value}" is above decisions.maxMode "${maxMode}", so it has no effect; to turn it on, commit decisions.maxMode "${value}" in config.json`);
  }
  return warnings;
}

// What `aidrian check` warns about in `decisions.escalateDocs`: each entry whose file or folder no path of `tracked`,
// from the project root, matches exactly, case included. A typo escalates nothing. Another case still asks, since
// docMatches ignores case, but it names no doc as git does. Only a warning: a doc may be listed before it exists.
export function escalateDocWarnings(entries, tracked) {
  return entries
    .filter((entry) => {
      const { file: listed } = docParts(entry);
      return !tracked.some((file) => holds(listed, file));
    })
    .map((entry) => `decisions.escalateDocs: "${entry}" matches no tracked path, so it may escalate nothing; check its spelling and case`);
}
