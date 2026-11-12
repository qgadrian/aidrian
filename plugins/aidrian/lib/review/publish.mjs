// What the review engine may post on a pull request, decided before the first post: GitHub keeps edit history.
//
// - The posted copy of the record (postedCopy). Every comment writer ends in state.mjs withRecord, which posts this
//   copy, never the record itself; the local record keeps everything. Unless the write read the repository's
//   visibility through the forge as exactly PRIVATE, on a pull request from inside the team (isPrivate), the copy holds
//   only the keys the allowlist below names, each value only when it passes the check of its shape, and a name only
//   where the plan or the config defines it. On a private repository it is the whole record, less every string the
//   text checks withhold.
// - The text checks (textChecker): token-shaped strings and local paths always, and the public-text patterns and the
//   private words where the rules ask for them. They fail closed.
// - Escaping (escapeLines): the final raw body of a post, with no line exempt; the engine's own marker lines are added
//   after it, in their fixed layout.
// - Which findings are security findings (securityReading), for the copy and the residual rows of a step's result.
// - What a machine keeps of its own record when it builds on another machine's posted copy (fillWithheld).
// - The findings table of review.publish.summary "findings" (findingsTable), every cell through one encoder (tableCell).
//
// docs/review.md#the-record describes the rules.

// This module loads no forge, no knowledge loader, and no command: the summary comment's writer (state.mjs) loads it, and
// a hook that reads the record pays for no more. What only a command can read, the forge's answers and the
// product-access terms, reaches it in a write's post context (lib/review/dispatch.mjs postContext).

import { homedir } from 'node:os';

import { bannedLines } from '../banned-terms.mjs';
import { boundedSearch, timeBudget } from '../bounded-regexp.mjs';
import { loadTable } from '../finding-disposition.mjs';
import { isObject } from '../fs.mjs';
import { runGit } from '../git.mjs';
import { NAME } from './config.mjs';
import { fileAt } from './diff.mjs';
import { blocks, FINDING_STATES, isClosed, isFindingId, isMint, MAX_PATH, recordedFindings, securitySeverity, severityOf, twinClosure } from './findings.mjs';
import { DEPTHS, ONLY_NON_BEHAVIOUR } from './plan.mjs';

// The words that report a withholding, whatever matched: never the matched text, its pattern, or the list it is on.
export const WITHHELD = 'text withheld';
// The engine's own budget for the text checks: a search, and a whole write or step.
export const SEARCH_MS = 200;
export const STEP_MS = 10_000;
const FLAGS = 'iu';
const NO_TERMS = Object.freeze({ hosts: [], accounts: [], variables: [] });

// ---- Reading the repository ----

// Whether a write may post the whole record: it read the repository's visibility through the forge as exactly
// PRIVATE, and the pull request comes from inside the team. INTERNAL, any other value, a failed read, and no reading
// are not private (R6).
export const isPrivate = (reading) => reading?.visibility === 'PRIVATE' && reading?.inside === true;

// ---- Paths at a commit ----

const SHA_REF = /^[0-9a-f]{7,40}$/u;

// The paths git tracks at `commit`, from `root`, as a Set, or null when git cannot list them, such as a commit the
// checkout lacks.
export function trackedSet(root, commit) {
  if (!root || typeof commit !== 'string' || !SHA_REF.test(commit)) return null;
  const result = runGit(['ls-tree', '-r', '--name-only', '-z', commit], root, { timeout: 30_000, maxBuffer: 256 * 1024 * 1024 });
  return result.status === 0 ? new Set(result.stdout.split('\0').filter(Boolean)) : null;
}

// The path checks of one write, read from git once per commit and file: `tracked(head, file)` is true, false, or null
// when the check cannot run; `lines(head, file)` is the file's line count at `head`, or null. `at(head)` binds a head,
// the shape recordFindings takes.
export function gitPaths(root) {
  const sets = new Map();
  const counts = new Map();
  const tracked = (head, file) => {
    if (typeof file !== 'string') return false;
    if (!sets.has(head)) sets.set(head, trackedSet(root, head));
    const set = sets.get(head);
    return set ? set.has(file) : null;
  };
  const lines = (head, file) => {
    const key = `${head}\0${file}`;
    if (!counts.has(key)) {
      const text = tracked(head, file) === true ? fileAt(root, head, file) : null;
      counts.set(key, typeof text === 'string' ? (text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)) : null);
    }
    return counts.get(key);
  };
  return { tracked, lines, at: (head) => ({ tracked: (file) => tracked(head, file), lines: (file) => lines(head, file) }) };
}

// ---- Text checks ----

// What a post may never hold, and how a reader may come to see it: the product feedback post (lib/pr-product-feedback.mjs)
// refuses on it, and the review engine withholds on it.
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
// A root that holds what is local to a machine or a runner; an ordinary route such as /settings/team is none of them.
const LOCAL_ROOTS = ['Users', 'home', 'root', 'tmp', 'private', 'var', 'etc', 'opt', 'mnt', 'srv', 'usr', 'Volumes', 'Library', 'System', 'Applications', 'workspace', '__w', 'builds', 'nix', 'proc'];
const LOCAL_PATH = new RegExp([
  `(?<![\\w./-])/(?:${LOCAL_ROOTS.join('|')})/`,
  '(?<![\\w./-])/(?:github/workspace|dev/shm|cygdrive|c/Users)(?![\\w-])',
  // The scheme of a URL keeps `https://home` out.
  '(?<![\\w.:/-])//home(?![\\w-])',
  '(?<![\\w./-])[A-Za-z]:[\\\\/]',
  '(?<![\\w-])file:[/\\\\]',
  '(?<![\\w\\\\])\\\\\\\\[\\w.-]+',
  '(?<![\\w\\\\])\\\\Users(?![\\w-])',
].join('|'), 'u');
const HOME = /(?<![\w./-])~[\\/]|\$\{?HOME\b|%USERPROFILE%/iu;
const LOCAL_HOST = new RegExp([
  '(?<![\\w-])localhost(?![\\w-])',
  '(?<![\\w.-])host\\.docker\\.internal(?![\\w-])',
  '(?<![\\w-])[\\w-]+\\.local(?!\\.?[\\w-])',
  '\\[::1\\]',
  '(?<![\\w.])169\\.254\\.',
  '(?<![\\w.])(?:127(?:\\.\\d{1,3}){1,3}|0\\.0\\.0\\.0|10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}|172\\.(?:1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3}|192\\.168\\.\\d{1,3}\\.\\d{1,3})(?!\\d)',
].join('|'), 'iu');
// A named host as a pattern: a leading `*.` is the host itself and its subdomains, and a templated first label, such as
// `<pr>` or `pr-*`, takes any label. The match lets a dot or a template stand before it.
function hostPattern(host) {
  const [first, ...rest] = host.split('.');
  if (first === '*') return escaped(rest.join('.'));
  const label = first.split(/<[^>]*>|\{+[^}]*\}+|\*/u).map(escaped).join('[\\w-]*');
  return [label, ...rest.map(escaped)].join('\\.');
}
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/u;
const REPORT_PATH = /(?<![\w./-])[\w+-]+-\d{4}-\d{2}-\d{2}(?:-\d+)?(?:\.md|\.json|\/\S+)/u;
const SECRETS = [
  /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{4,}/u,
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{4,}/u,
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}/u,
  /(?<![A-Za-z0-9])sk_(?:live|test)_[A-Za-z0-9]{4,}/u,
  /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{12,}/u,
  /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{4,}/u,
  /(?<![A-Za-z0-9])eyJ[\w-]+\.[\w-]+\.[\w-]+/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY/u,
];

// `body` as a reader may come to see it: no format character, and numeric entities and %xx decoded.
export function decodedCopy(body) {
  const point = (code) => (code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '');
  return body.replace(/\p{Cf}/gu, '')
    .replace(/&#(\d+);/gu, (_, digits) => point(Number(digits)))
    .replace(/&#x([0-9a-f]+);/giu, (_, digits) => point(Number.parseInt(digits, 16)))
    .replace(/&commat;/giu, '@')
    .replace(/%([0-9a-f]{2})/giu, (_, digits) => String.fromCharCode(Number.parseInt(digits, 16)));
}

// The kind of the first local or secret thing `body` holds, in words safe to print, or null. The value never leaves here.
function kindIn(body, { home, state, roots, terms, env }) {
  if (state && body.includes(state)) return 'a path in the state folder';
  if ((home && body.includes(home)) || HOME.test(body)) return 'a path in the home folder';
  if (roots.some((root) => root && body.includes(root))) return 'a path in the checkout';
  if (LOCAL_PATH.test(body)) return 'an absolute local path';
  if (LOCAL_HOST.test(body)) return 'localhost or a private network address';
  // A named host's subdomains and templated labels match, so only a word character or a dash before it keeps it apart.
  if (terms.hosts.length && new RegExp(`(?<![\\w-])(?:${terms.hosts.map(hostPattern).join('|')})(?![\\w-])`, 'iu').test(body)) return 'a host product-access names';
  if (terms.accounts.length && new RegExp(`(?<![\\w.-])(?:${terms.accounts.map(escaped).join('|')})(?![\\w-])`, 'iu').test(body)) return 'an account product-access names';
  // A value this short would match ordinary text.
  if (terms.variables.some((name) => typeof env[name] === 'string' && env[name].length >= 4 && body.includes(env[name]))) return 'the value of a variable product-access names';
  if (EMAIL.test(body)) return 'an email address';
  if (SECRETS.some((shape) => shape.test(body))) return 'a secret';
  if (REPORT_PATH.test(body)) return 'a report or screenshot path';
  return null;
}

// The kind of what `body` holds, as written or as a reader may come to see it, or null.
export function refusedKind(body, { home = '', state = '', roots = [], terms, env = {} }) {
  const context = { home, state, roots, terms, env };
  return kindIn(body, context) ?? kindIn(decodedCopy(body), context);
}

const IMAGE = '(image removed)';
const AT_ENTITY = /&#0*64;|&#x0*40;|&commat;/giu;
const URL_TOKEN = /^[(<["']*https?:\/\/[^\s<]*$/u;

export function neutralized(body) {
  const out = body.replace(/!\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])?/gu, IMAGE)
    .replace(/<\s*(?:img|image|picture|source|video|svg)\b[^>]*>?/giu, IMAGE)
    .replaceAll('<!--', '&lt;!--')
    .replace(AT_ENTITY, '@');
  // GitHub reads a mention from the rendered text. A URL keeps its /@name.
  return out.replace(/(?<![A-Za-z0-9])@(?=[A-Za-z0-9])/gu, (at, offset, whole) => {
    const inUrl = whole[offset - 1] === '/' && URL_TOKEN.test(whole.slice(0, offset).split(/\s/u).at(-1));
    return inUrl ? at : '@\u200b';
  });
}



const flat = (text) => text.replace(/\s+/gu, ' ');

// The public-text patterns of every config given, joined: the base branch's committed config and the checkout's, never
// the pull request head's alone.
export const patternsOf = (configs) => [...new Set(configs.flatMap((config) => config?.github?.publicText?.patterns ?? []))];

// The one decision whether a string may be posted (R2), for every string of a post on every repository: `allows(text)`
// runs, on the raw text with each run of whitespace collapsed and on the decoded copy refusedKind builds, the always-on
// check (token-shaped strings and local paths, in `context`, which pr-product-feedback.mjs refusalContext builds, G5),
// the public-text `patterns`, and the private words of the checkout `root`, each under the budget. A hit in either copy
// withholds, and so does a dropped search (out of time, out of budget, or one that does not compile), a `context` of null
// (the knowledge index or a product-access doc could not be read), and a private-words copy that cannot be read (H4).
// It never throws. `words` replaces what `root` gives, in tests.
export function textChecker({ context = null, root = null, patterns = [], words, budget = timeBudget(STEP_MS, SEARCH_MS) } = {}) {
  const always = context;
  let privateWords = words;
  if (privateWords === undefined) {
    try {
      privateWords = root ? bannedLines(root) : [];
    } catch {
      privateWords = null;
    }
  }
  const sources = Array.isArray(patterns) ? patterns.filter((each) => typeof each === 'string') : [];
  // `failed` turns true once a string is withheld because a check could not run, not for what the string holds: the
  // context is missing, the private words cannot be read, or a search was dropped. A write then holds its record
  // (state.mjs withRecord), since a copy stripped that way would read as a record that lost its data.
  const checker = { failed: false };
  const fail = () => {
    checker.failed = true;
    return false;
  };
  const hit = (list, text) => list.some((source) => {
    const index = boundedSearch(source, FLAGS, text, budget);
    if (index === null) checker.failed = true;
    return index === null || index >= 0;
  });
  const decide = (text) => {
    if (always === null) return fail();
    if (refusedKind(flat(text), always) !== null) return false;
    if (privateWords === null) return fail();
    return ![flat(text), flat(decodedCopy(text))].some((copy) => hit(privateWords, copy) || hit(sources, copy));
  };
  // Each answer is cached with whether a check failed for it, so a string read again flags the failure again.
  const cache = new Map();
  checker.allows = (text) => {
    if (typeof text !== 'string') return true;
    const key = text;
    if (!cache.has(key)) {
      const before = checker.failed;
      checker.failed = false;
      const allowed = decide(text);
      cache.set(key, { allowed, failed: checker.failed });
      checker.failed ||= before;
    } else if (cache.get(key).failed) checker.failed = true;
    return cache.get(key).allowed;
  };
  return checker;
}

// The checker of a write that names no project: the always-on check in this machine's home, and no other list.
export const plainChecker = () => textChecker({ context: { home: homedir(), state: '', roots: [], terms: NO_TERMS, env: {} }, words: [], patterns: [] });

// ---- Escaping ----

// `lines` as a post shows them: a zero-width space after each `@` (neutralized), so a mention neither notifies nor
// triggers a bot, `<!--` and `-->` escaped, so no line opens or closes a marker, and a line that starts with `/`
// neutralized, so no line reads as a command. Code spans and blocks get the same: no line is exempt (R3). Escaping
// twice changes nothing more.
export function escapeLines(lines) {
  return lines.map((line) => neutralized(String(line)).replaceAll('-->', '--&gt;').replace(/^(\s*)\//u, '$1​/'));
}

// What an inline review posts of a finding's text, capped before it is escaped (G7): a title, a body, and a whole review
// body or fallback comment.
export const TITLE_CAP = 200;
export const TEXT_CAP = 2_000;
export const POST_CAP = 60_000;
// Every line break a body can hold: a post reads each line of it as it will show.
export const LINE_BREAK = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/u;
// A fence opener after any blockquote, list, and space prefix, with its info string: a fence keeps its info string only
// when that is a plain language name and not `suggestion` in any case, so a `suggestion` fence, one spelled with a
// character reference, and one quoted in reviewer text all post as a plain fence, and the forge offers no change to apply.
const FENCE_OPENER = /^((?:[ \t>]|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t]))*)(`{3,}|~{3,})(.*)$/u;
const LANGUAGE = /^[A-Za-z0-9_+#.-]{1,30}$/u;
export function plainFence(line) {
  const match = FENCE_OPENER.exec(line);
  if (!match) return line;
  const info = match[3].trim();
  return info === '' || (LANGUAGE.test(info) && !/suggestion/iu.test(info)) ? line : `${match[1]}${match[2]}`;
}

// Reviewer text with every link inert, the way the table cell encoder neutralizes an autolink, whatever the link's
// form: a zero-width space breaks each scheme's colon from what follows (`https://`, `https:/`, `https:\`), each `www.`,
// each `](` and `]:` (an inline link and a reference definition, a protocol-relative target among them), and each `<`
// that could open a tag or an autolink, such as `<a href>`.
const neutralLinks = (line) => line
  .replace(/([A-Za-z][A-Za-z0-9+.-]*):(?=[/\\])/gu, '$1:\u200b')
  .replace(/(?<![\w.-])www\./giu, 'www\u200b.')
  .replace(/\](?=[(:])/gu, ']\u200b')
  .replace(/<(?=[A-Za-z/!?])/gu, '<\u200b');

// One line of reviewer text as an inline review posts it (R3, G7), from its raw text: a suggestion fence made a plain
// fence; every `&` that could start a character reference (one followed by `#` or a letter) encoded as `&amp;`, so no
// reference reaches the renderer to spell a scheme, a mention, or a fence the steps below would miss, and code such as
// `a && b` stays readable; its links made inert first, so no at-sign in a link target escapes the mention
// check; escaped as every line of a post is (escapeLines); then quoted, so no line of it starts a command a bot reads. A
// marker line in the text is escaped like any other, so no reader of markers counts it.
export function quotedLines(text) {
  const lines = String(text).split(LINE_BREAK).map((line) => neutralLinks(plainFence(line).replace(/&(?=[#A-Za-z])/gu, '&amp;')));
  return escapeLines(lines).map((line) => plainFence(`> ${line}`));
}

// `text` cut to `cap` characters, with the count of what was cut: { text, cut }.
export const capped = (text, cap) => {
  const whole = String(text ?? '').trim();
  return whole.length > cap ? { text: whole.slice(0, cap), cut: whole.length - cap } : { text: whole, cut: 0 };
};

// ---- Security findings ----


const noteOf = (state) => (isObject(state?.planNote) && isObject(state.planNote.passes) ? state.planNote : null);

// The findings of `state` read as security findings (G6, K1), as a Set of the finding objects: one with the mark, a
// critical or high severity, its reviewer's flag (stored as the mark), no id yet, or a pass the plan note flags as
// requiring the security reviewer or does not hold, with no note a pass of any kind; then every twin of one, to a fixed
// point, over every finding the record holds. The posted copy and the residual rows take the reading from here.
export function securityReading(state) {
  const note = noteOf(state);
  const passOf = new Map();
  for (const [id, result] of Object.entries(isObject(state?.passes) ? state.passes : {})) {
    if (!isObject(result)) continue;
    for (const key of ['list', 'ruled', 'carried']) for (const finding of Array.isArray(result[key]) ? result[key] : []) if (isObject(finding)) passOf.set(finding, id);
  }
  const all = recordedFindings(state);
  const seed = (finding) => {
    if (finding.security === true || securitySeverity(finding.severity) || !isFindingId(finding.id)) return true;
    const pass = passOf.get(finding) ?? finding.pass;
    const entry = typeof pass === 'string' ? note?.passes?.[pass] : null;
    return !isObject(entry) || entry.security === true;
  };
  return twinClosure(all, seed);
}

// The ids of the findings securityReading reads as security.
// A security ruling counts for the finding it names too (`ruled_id`), and a finding for its aliases: a residual row is
// keyed by the finding a ruling repeats, which may no longer be listed.
export const securityIds = (state) => new Set([...securityReading(state)]
  .flatMap((finding) => [finding.id, finding.ruled_id, ...(Array.isArray(finding.aliases) ? finding.aliases : [])]).filter(isFindingId));

// ---- The posted copy ----

const TABLE = loadTable();
const SHA = /^[0-9a-f]{40}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const PASS_ID = /^[\w.:+-]{1,120}$/u;
const PENDING_ID = /^\d+-[0-9a-f]{8}$/u;
const REPO = /^[\w.-]{1,100}\/[\w.-]{1,100}$/u;
const URL = /^https:\/\/[^\s<>"'`]{1,500}$/u;
const WORD = /^[a-z_]{1,40}$/u;
const CAPTURE_KEY = /^[\w.:/@=+-]{1,200}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const OVERRIDE = /^round \d{1,4} ran the ([\w.:-]{1,80}) stage first$/u;
const JUDGE = /^judge:([\w.:-]{1,80})$/u;
const CHOICE = /^agent:([a-z0-9][a-z0-9-]*)$/u;
// The engine's own reviewer and agent names, and who decides at the cap.
const ENGINE_NAMES = ['codex-local', 'self', 'pr-bot', 'code-reviewer', 'security-engineer', 'critic'];
const AXES = { severity: TABLE.severities, likelihood: TABLE.likelihoods, affects: TABLE.affects, cost: TABLE.costs ?? [] };
const DISPOSITIONS = new Set([...TABLE.rules.map((rule) => rule.disposition), TABLE.default, TABLE.botSourceWithoutAxis, ...(TABLE.lateRound ? [TABLE.lateRound.disposition] : []), 'needs_axis'].filter(Boolean));
const STATES = new Set([...FINDING_STATES, 'not_reported']);
// The red flags of the check at the cap, by name: the part of a reason before its colon, or a bare name as a posted copy
// keeps it. extension.mjs reads them with this one function, so an adopted copy's flags are the same flags.
const FLAG_NAMES = new Set(['not converging', 'looping', 'drifting', 'bloating']);
export const flagName = (reason) => {
  const text = String(reason ?? '');
  const name = text.includes(':') ? text.slice(0, text.indexOf(':')) : text;
  return FLAG_NAMES.has(name) ? name : 'no readable signal';
};
// The plan reasons the copy keeps: the engine's fixed sentences.
const FIXED_REASONS = new Set([ONLY_NON_BEHAVIOUR]);

const isInt = (value) => Number.isSafeInteger(value) && value >= 0;
const isDate = (value) => typeof value === 'string' && DATE.test(value);
const isSha = (value) => typeof value === 'string' && SHA.test(value);
const isWord = (value) => typeof value === 'string' && WORD.test(value);

// The names a copy may hold, by value (G1): the plan note's pass ids, stages, reviewers, and flow and invariant pairs,
// with the dispatched passes, the config's reviewers (`names`), and the engine's own names. With no note, none.
function namesBy(state, names) {
  const note = noteOf(state);
  if (!note) return { passes: new Set(), stages: new Set(), reviewers: new Set(), pairs: new Set(), flows: new Set() };
  const entries = Object.entries(note.passes).filter(([id, entry]) => PASS_ID.test(id) && isObject(entry));
  const fit = (value) => typeof value === 'string' && NAME.test(value) && value.length <= 120;
  const pairs = [...(Array.isArray(note.pairs) ? note.pairs : []), ...(Array.isArray(state.invariants?.items) ? state.invariants.items : [])]
    .filter((each) => isObject(each) && fit(each.flow) && fit(each.invariant));
  return {
    passes: new Set([...entries.map(([id]) => id), ...Object.keys(isObject(state.dispatched) ? state.dispatched : {}).filter((id) => PASS_ID.test(id))]),
    stages: new Set(entries.map(([, entry]) => entry.stage).filter(fit)),
    reviewers: new Set([...entries.map(([, entry]) => entry.reviewer), ...names, ...ENGINE_NAMES].filter(fit)),
    pairs: new Set(pairs.map((each) => JSON.stringify([each.flow, each.invariant]))),
    flows: new Set(pairs.map((each) => each.flow)),
  };
}

// The copy of `state` a write posts, and how many values it left out: { copy, withheld }. `post` is the write's
// { reading, checker, root, names, diffPaths, isLogin }: the forge's reading (dispatch.mjs readReading), its
// textChecker, the checkout root the path checks run in, the reviewer and agent names of the base branch's and the
// checkout's config, the paths of the pull request's diff, which count as named by git, and the forge's login check.
// Missing, a reading is not private, a checker is the plain one, with no root no path check can run, so no path is
// kept, and with no login check no login is. `post.publish.publicSecurity` "full" posts a security finding's file and
// line as any other finding's, and nothing more: no title, body, evidence, or reason, as for every finding there;
// anything else withholds them on a reading that is not private (R5).
// What stays on this machine on every repository never posts: an index entry's recording reviewer, the title of an
// entry closed as fixed or not reported again, and the ids a dispatch note listed (Q2-A3).
export function postedCopy(state, post = {}) {
  const checker = post.checker ?? plainChecker();
  const counter = { n: 0 };
  if (isPrivate(post.reading)) return { copy: privateCopy(withoutLocal(state), checker, counter), withheld: counter.n };
  const copy = allowlisted(state, post, counter);
  return { copy: allChecked(copy, checker, counter), withheld: counter.n };
}

// The record's own key names, which carry no data: the checks read only the keys that do, such as a pass id, a flow,
// or a commit, and every value.
const FIXED_KEYS = new Set([
  'version', 'revision', 'pr', 'repo', 'updatedAt', 'idCounter', 'floored', 'rounds', 'head', 'at', 'final', 'quiet', 'from', 'open',
  'findings', 'passes', 'reviewer', 'seconds', 'files', 'bot', 'kind', 'review_id', 'list', 'ruled', 'carried', 'verdicts', 'flow',
  'invariant', 'verdict', 'evidence', 'reason', 'contracts', 'cross_notes', 'dropped', 'signoffs', 'by', 'overrides', 'overrulings',
  'acceptances', 'outside', 'approvals', 'login', 'url', 'failures', 'outcome', 'status', 'depth', 'carried_from', 'carried_base',
  'reasons', 'pending', 'id', 'sent', 'answered', 'dispatched', 'stage', 'security', 'planNote', 'pairs', 'halved', 'botRequest',
  'remerge', 'signoffable', 'flows', 'disputes', 'items', 'invariants', 'state', 'captured', 'captures', 'visual', 'mode',
  'visibility', 'of', 'quotaStops', 'chosen_at', 'choice', 'signoff', 'waivers', 'judge', 'extensions', 'source', 'max',
  'granted_before', 'decided_at', 'signals', 'converging', 'looping', 'drifting', 'bloating', 'unknown', 'previous_round',
  'previous_open', 'fix_added', 'fix_added_all', 'original_added', 'limit', 'earlier_round', 'match', 'red_flags', 'stale_judge',
  'human', 'answer', 'session', 'unreviewed', 'title', 'body', 'file', 'line', 'severity', 'likelihood', 'affects', 'cost',
  'disposition', 'accepted_by', 'settled_severity', 'settled_by', 'ended', 'residual', 'ruled_id', 'aliases', 'mint',
  'already_ruled', 'round', 'pass', 'requested_head', 'index', 'closed_in', 'seen', 'placed', 'current', 'to',
  'thread', 'reviewId', 'commentId', 'fallbackId', 'replyId', 'replied', 'resolved',
]);

// The record less what stays on this machine on every repository (postedCopy), as a copy.
function withoutLocal(state) {
  const view = JSON.parse(JSON.stringify(state));
  for (const entry of Object.values(isObject(view?.index) ? view.index : {})) {
    if (!isObject(entry)) continue;
    delete entry.reviewer;
    if (isClosed(entry)) delete entry.title;
  }
  for (const note of Object.values(isObject(view?.dispatched) ? view.dispatched : {})) if (isObject(note)) delete note.listed;
  return view;
}
const keyAllowed = (key, checker) => FIXED_KEYS.has(key) || checker.allows(key);

// The whole record, less every string and every data-bearing key the full checks withhold (G2), each counted.
function privateCopy(value, checker, counter) {
  if (typeof value === 'string') return checker.allows(value) ? value : undefined;
  if (Array.isArray(value)) {
    return value.flatMap((each) => {
      const kept = privateCopy(each, checker, counter);
      if (kept === undefined) {
        counter.n += 1;
        return [];
      }
      return [kept];
    });
  }
  if (!isObject(value)) return value;
  const out = {};
  for (const [key, each] of Object.entries(value)) {
    // `adopted`, `evidenceWithheld`, and `notesWithheld` are this machine's own marks (fillWithheld): no copy posts them.
    if (key === 'adopted' || key === 'evidenceWithheld' || key === 'notesWithheld') continue;
    const kept = keyAllowed(key, checker) ? privateCopy(each, checker, counter) : undefined;
    if (kept === undefined) counter.n += 1;
    else out[key] = kept;
  }
  return judgeKept(value, out);
}

// What marks a ruling as a judge's, not the Human's: the prefix of its `by` (lib/review/approvals.mjs JUDGE_PREFIX,
// which test/review-publish.test.mjs holds equal). A copy that cannot post the judge's name posts the prefix alone, so
// another machine never reads a judge's ruling as the Human's.
export const JUDGE_RULING = 'judge:';
function judgeKept(source, out) {
  if (typeof source.by === 'string' && source.by.startsWith(JUDGE_RULING) && typeof out.by !== 'string') out.by = JUDGE_RULING;
  return out;
}

// The allowlisted copy, every string and every data-bearing key of it through every text check, as a backstop (G1): a
// path or a defined name can match a configured pattern or a private word too.
function allChecked(value, checker, counter) {
  if (typeof value === 'string') return checker.allows(value) ? value : undefined;
  if (Array.isArray(value)) {
    return value.flatMap((each) => {
      const kept = allChecked(each, checker, counter);
      if (kept === undefined) counter.n += 1;
      return kept === undefined ? [] : [kept];
    });
  }
  if (!isObject(value)) return value;
  const out = {};
  for (const [key, each] of Object.entries(value)) {
    const kept = keyAllowed(key, checker) ? allChecked(each, checker, counter) : undefined;
    if (kept === undefined) counter.n += 1;
    else out[key] = kept;
  }
  return judgeKept(value, out);
}

// The allowlist (R1): one table, as code. Every key a function below does not name is left out and counted; a slice that
// adds a key to the record adds it here, or the key is not posted.
function allowlisted(state, post, counter) {
  const names = namesBy(state, post.names ?? []);
  const paths = post.root ? gitPaths(post.root) : null;
  const diffPaths = post.diffPaths instanceof Set ? post.diffPaths : new Set();
  const secure = securityReading(state);
  // Under publicSecurity "full" a security finding keeps its place, and only its place; its mark still posts.
  const full = post.publish?.publicSecurity === 'full';
  const placeless = full ? new Set() : secure;
  const secureIds = new Set([...placeless].map((finding) => finding.id).filter(isFindingId));
  const known = new Set(recordedFindings(state).map((finding) => finding.id).filter(isFindingId));
  const drop = () => {
    counter.n += 1;
    return undefined;
  };
  // A kept value, or undefined, counted.
  const keep = (value, ok) => (ok(value) ? value : drop());
  const name = (set) => (value) => typeof value === 'string' && set.has(value);
  const pair = (flow, invariant) => names.pairs.has(JSON.stringify([flow, invariant]));
  const path = (head) => (value) => typeof value === 'string' && value.length <= MAX_PATH && (diffPaths.has(value) || paths?.tracked(head, value) === true);
  const lineOk = (head, file, line) => Number.isSafeInteger(line) && line >= 1 && Number.isSafeInteger(paths?.lines(head, file)) && line <= paths.lines(head, file);
  // `fields` maps a key to its check, or to a function (value) => kept value; every other key is counted.
  const object = (source, fields) => {
    if (!isObject(source)) return drop();
    const out = {};
    for (const [key, value] of Object.entries(source)) {
      const rule = fields[key];
      if (!rule) {
        drop();
        continue;
      }
      const kept = rule(value);
      if (kept !== undefined) out[key] = kept;
    }
    return out;
  };
  const check = (ok) => (value) => keep(value, ok);
  const list = (map) => (value) => (Array.isArray(value) ? value.flatMap((each) => {
    const kept = map(each);
    return kept === undefined ? [] : [kept];
  }) : drop());
  const sha = check(isSha);
  const int = check(isInt);
  const date = check(isDate);
  const bool = check((value) => typeof value === 'boolean');
  const nullableBool = check((value) => value === null || typeof value === 'boolean');
  const word = (set) => check((value) => typeof value === 'string' && (set ? set.has(value) : WORD.test(value)));
  const passId = check(name(names.passes));
  const stage = check(name(names.stages));
  const reviewer = check(name(names.reviewers));
  const flowName = check(name(names.flows));
  const findingId = check(isFindingId);
  const paths_ = (head) => list(check(path(head)));

  // A finding: in `list`, `ruled`, `carried`, a round's `findings`, and the index (`local` names the index's local
  // keys, which are left out uncounted). Its file and line stay only for a finding the projection does not read as
  // security, as a path git tracks at `head` and a line within that file.
  const finding = (head, local = {}) => (source) => {
    if (!isObject(source)) return drop();
    const securityFinding = secure.has(source);
    const hidePlace = placeless.has(source);
    const out = object(source, {
      ...local,
      id: findingId,
      aliases: list(findingId),
      mint: check(isMint),
      file: () => undefined,
      line: () => undefined,
      severity: word(new Set(AXES.severity)),
      likelihood: word(new Set(AXES.likelihood)),
      affects: word(new Set(AXES.affects)),
      cost: word(new Set(AXES.cost)),
      state: word(STATES),
      disposition: word(DISPOSITIONS),
      accepted_by: word(new Set(['late-round'])),
      from: word(new Set(['prior', 'residual'])),
      settled_severity: word(new Set(AXES.severity)),
      pass: passId,
      settled_by: passId,
      stage,
      security: bool,
      ended: bool,
      carried: bool,
      residual: (value) => (typeof value === 'string' && value.trim() !== '') || value === true ? true : drop(),
      ruled_id: findingId,
      closed_in: (value) => object(value, { from: sha, to: sha }),
      seen: sha,
      placed: sha,
      // Where the finding was posted (lib/review/inline.mjs): the forge's ids, numbers alone, and the closing reply's
      // marks (answerThreads): its id, and whether it was posted and the thread resolved.
      thread: (value) => object(value, { reviewId: int, commentId: int, fallbackId: int, replyId: int, replied: bool, resolved: bool }),
    });
    const file = source.file;
    if (typeof file === 'string' && !hidePlace && path(head)(file)) {
      out.file = file;
      if (source.line !== undefined && source.line !== null) {
        if (lineOk(head, file, source.line)) out.line = source.line;
        else drop();
      }
    } else if (file !== undefined && file !== null) drop();
    else if (source.line !== undefined && source.line !== null) drop();
    if (securityFinding) out.security = true;
    return out;
  };
  const findings = (head) => list(finding(head));
  // An index entry: a finding, its place checked at the head that recorded it (`placed`), else, for an entry an earlier
  // write left without one, the head that last held it open, else the head that closed it.
  const indexEntry = (source) => (isObject(source) ? finding(source.placed ?? source.seen ?? source.closed_in?.to, { reviewer: () => undefined })(source) : drop());
  const verdict = (source) => {
    if (!isObject(source) || !pair(source.flow, source.invariant)) return drop();
    return object(source, { flow: (value) => value, invariant: (value) => value, verdict: word(new Set(['holds', 'violated', 'not_affected', 'cannot_verify'])) });
  };
  const pairEntry = (extra) => (source) => {
    if (!isObject(source) || !pair(source.flow, source.invariant)) return drop();
    return object(source, { flow: (value) => value, invariant: (value) => value, ...extra });
  };
  // A judge's ruling keeps `judge:<name>` for a name the plan or config defines, else `judge:` alone; a person's name
  // is left out.
  const judgeBy = (value) => {
    if (typeof value !== 'string' || !value.startsWith(JUDGE_RULING)) return drop();
    return JUDGE.test(value) && names.reviewers.has(JUDGE.exec(value)[1]) ? value : JUDGE_RULING;
  };
  const acceptance = pairEntry({ head: sha, at: date, by: judgeBy, kind: word(), evidence: check((value) => typeof value === 'string' && URL.test(value)) });
  const keyed = (map, keyOk) => (value) => {
    if (!isObject(value)) return drop();
    const out = {};
    for (const [key, each] of Object.entries(value)) {
      if (!keyOk(key)) {
        drop();
        continue;
      }
      const kept = map(each, key);
      if (kept !== undefined) out[key] = kept;
    }
    return out;
  };
  // An extension's looping or drifting evidence entry: its file and line only when its id names a finding the
  // projection does not read as security (J1).
  const evidenceEntry = (head) => (source) => {
    if (!isObject(source)) return drop();
    const out = object(source, { round: int, earlier_round: int, id: findingId, match: word(new Set(['id', 'place', 'title'])), file: () => undefined, line: () => undefined, title: () => drop() });
    const named = isFindingId(source.id) && known.has(source.id) && !secureIds.has(source.id);
    if (named && typeof source.file === 'string' && path(head)(source.file)) {
      out.file = source.file;
      if (source.line !== undefined && source.line !== null) {
        if (lineOk(head, source.file, source.line)) out.line = source.line;
        else drop();
      }
    } else {
      if (source.file !== undefined && source.file !== null) drop();
      if (source.line !== undefined && source.line !== null) drop();
    }
    return out;
  };
  const extension = (source) => {
    if (!isObject(source)) return drop();
    const head = source.head;
    const decision = check((value) => isObject(value));
    return object(source, {
      source: word(new Set(['plan', 'bot'])),
      mode: word(),
      status: word(),
      by: word(),
      round: int,
      max: int,
      granted_before: int,
      head: sha,
      at: date,
      decided_at: date,
      reasons: () => drop(),
      red_flags: (value) => (Array.isArray(value) ? value.map(flagName) : drop()),
      judge: (value) => (decision(value) ? object(value, { verdict: word(), head: sha, at: date }) : undefined),
      stale_judge: (value) => (decision(value) ? object(value, { verdict: word(), head: sha, at: date }) : undefined),
      human: (value) => (decision(value) ? object(value, { answer: word(), at: date }) : undefined),
      unreviewed: (value) => object(value, { head: sha, from: sha }),
      signals: (value) => object(value, {
        converging: nullableBool,
        looping: nullableBool,
        drifting: nullableBool,
        bloating: nullableBool,
        unknown: list(word()),
        evidence: (evidence) => object(evidence, {
          converging: (each) => object(each, { round: int, open: int, previous_round: int, previous_open: int }),
          bloating: (each) => object(each, { fix_added: int, fix_added_all: int, original_added: int, limit: int }),
          looping: list(evidenceEntry(head)),
          drifting: list(evidenceEntry(head)),
        }),
      }),
    });
  };
  const pass = (source, id) => {
    if (!isObject(source)) return drop();
    const head = source.head;
    return object(source, {
      head: sha,
      reviewer,
      seconds: int,
      findings: int,
      open: int,
      files: (value) => (value === null ? null : paths_(head)(value)),
      bot: (value) => object(value, { kind: word(), review_id: check((each) => each === null || isInt(each)) }),
      list: (value) => (value === null ? null : findings(head)(value)),
      ruled: findings(head),
      carried: findings(head),
      verdicts: list(verdict),
    });
  };
  const capture = check((value) => typeof value === 'string' && CAPTURE_KEY.test(value));

  return object(state, {
    version: int,
    revision: int,
    pr: int,
    idCounter: int,
    floored: bool,
    repo: check((value) => typeof value === 'string' && REPO.test(value)),
    updatedAt: date,
    rounds: list((round) => object(round, {
      head: sha,
      at: date,
      final: bool,
      quiet: list((each) => object(each, { from: sha, at: date })),
      open: int,
      findings: (value) => (value === null ? null : findings(round?.head)(value)),
    })),
    passes: keyed(pass, name(names.passes)),
    signoffs: keyed((value) => object(value, { head: sha, at: date, by: () => drop() }), name(names.flows)),
    overrides: list(check((line) => typeof line === 'string' && OVERRIDE.test(line) && names.stages.has(OVERRIDE.exec(line)[1]))),
    overrulings: list(acceptance),
    acceptances: list(acceptance),
    outside: (value) => object(value, {
      head: sha,
      approvals: list(pairEntry({ login: check((value) => typeof post.isLogin === 'function' && post.isLogin(value)), url: check((each) => typeof each === 'string' && URL.test(each)), at: date })),
      acceptances: list(acceptance),
    }),
    failures: keyed(int, (key) => {
      const at = key.indexOf(':');
      return at === 40 && SHA.test(key.slice(0, at)) && names.passes.has(key.slice(at + 1));
    }),
    outcome: (value) => (value === null ? null : object(value, {
      status: word(),
      depth: word(new Set(DEPTHS)),
      head: sha,
      carried_from: sha,
      carried_base: sha,
      at: date,
      reasons: list(check((reason) => FIXED_REASONS.has(reason))),
    })),
    pending: list((entry) => object(entry, {
      id: check((value) => typeof value === 'string' && PENDING_ID.test(value)),
      kind: word(new Set(['request', 'review'])),
      head: check((value) => typeof value === 'string' && SHA_REF.test(value)),
      at: date,
      repo: check((value) => typeof value === 'string' && REPO.test(value)),
      sent: (sent) => object(sent, { at: date, head: check((each) => typeof each === 'string' && SHA_REF.test(each)) }),
      answered: (answered) => object(answered, {
        at: date,
        head: check((each) => typeof each === 'string' && SHA_REF.test(each)),
        by: check((each) => isWord(each) || names.reviewers.has(each)),
      }),
    })),
    dispatched: keyed((value) => object(value, { head: sha, files: (files) => (files === null ? null : paths_(value?.head)(files)), stage, security: bool, base: sha, listed: () => undefined }), name(names.passes)),
    index: keyed(indexEntry, isFindingId),
    planNote: (value) => object(value, {
      head: sha,
      base: sha,
      current: list(passId),
      passes: keyed((entry) => object(entry, { stage, reviewer, security: bool }), name(names.passes)),
      pairs: list(pairEntry({})),
    }),
    halved: keyed(check((value) => value === true), name(names.passes)),
    botRequest: (value) => object(value, { head: sha, at: date }),
    remerge: (value) => object(value, { head: sha, from: sha }),
    signoffable: (value) => object(value, { head: sha, flows: list(flowName) }),
    disputes: (value) => object(value, { head: sha, items: list(pairEntry({})) }),
    invariants: (value) => object(value, { head: sha, items: list(pairEntry({ state: word() })) }),
    captured: keyed(list(capture), (key) => SHA.test(key)),
    captures: keyed(check((value) => typeof value === 'string' && URL.test(value)), (key) => SHA256.test(key)),
    visual: (value) => object(value, {
      head: sha,
      status: word(),
      mode: word(),
      visibility: check((each) => each === null || (typeof each === 'string' && /^[A-Z]{1,20}$/u.test(each))),
      captured: int,
      of: int,
    }),
    quotaStops: list((stop) => object(stop, {
      head: sha,
      stage,
      reviewer,
      passes: list(passId),
      at: date,
      chosen_at: date,
      choice: check((value) => value === null || value === 'human' || (typeof value === 'string' && CHOICE.test(value) && names.reviewers.has(CHOICE.exec(value)[1]))),
      signoff: (value) => (value === null ? null : object(value, { at: date, by: () => drop() })),
    })),
    waivers: list((entry) => object(entry, { head: sha, kind: word(), verdict: word(new Set(['waive', 'refuse'])), judge: reviewer, at: date })),
    extensions: list(extension),
  });
}

// ---- A machine keeps what was withheld ----

const sameHead = (a, b) => typeof a === 'string' && typeof b === 'string' && (a === b || (Math.min(a.length, b.length) >= 7 && (a.startsWith(b) || b.startsWith(a))));
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
// Every key of `source` that `target` lacks, copied.
const fillKeys = (target, source, only = null) => {
  if (!isObject(target) || !isObject(source)) return;
  for (const [key, value] of Object.entries(source)) if (!(key in target) && (!only || only.includes(key))) target[key] = clone(value);
};
const matching = (list, entry, keys) => (Array.isArray(list) ? list : []).find((each) => isObject(each) && keys.every((key) => each[key] === entry[key])) ?? null;

// `remote`, the higher-revision record a pull request's comment carried, with every field its projection withheld filled
// from `local`, this machine's own record: a finding's title, body, evidence, reasons, file, line, and security mark by
// its id and mint mark together (Q2-A2), and a string outside a finding by the entry's own key, with the head and the
// date it holds. A finding whose mint mark differs from this machine's finding of that id, or that has none, gets
// nothing, so a restarted record that reuses an id, or another machine that minted the same id, gets nothing either. The
// security mark is set when either copy holds it. Returns `remote`.
export function fillWithheld(remote, local) {
  if (!isObject(remote) || !isObject(local)) return remote;
  const mine = new Map();
  for (const finding of recordedFindings(local)) {
    if (!isFindingId(finding.id) || !isMint(finding.mint)) continue;
    const key = `${finding.id}:${finding.mint}`;
    if (!mine.has(key)) mine.set(key, finding);
  }
  for (const finding of recordedFindings(remote)) {
    const own = isFindingId(finding.id) && isMint(finding.mint) ? mine.get(`${finding.id}:${finding.mint}`) : null;
    // A finding this machine never recorded is marked adopted, on this machine's record only (no posted copy keeps the
    // key: the allowlist names it nowhere, and privateCopy leaves it out), so the review step still knows it holds no text for it once a command has written the adopted record.
    if (!own) {
      finding.adopted = true;
      continue;
    }
    delete finding.adopted;
    fillKeys(finding, own);
    if (finding.residual === true && typeof own.residual === 'string') finding.residual = own.residual;
    if (own.security === true) finding.security = true;
  }
  for (const [id, result] of Object.entries(isObject(remote.passes) ? remote.passes : {})) {
    const theirs = local.passes?.[id];
    if (!isObject(result)) continue;
    // A slice's report to the cross-cutting pass that another machine recorded, and a copy left out, is marked: the
    // review step does not count the slice as finished, so it runs again before the cross pass reads its report.
    if (!isObject(theirs) || !sameHead(result.head, theirs.head)) {
      if (id.startsWith('slice:') && !(Array.isArray(result.contracts) && Array.isArray(result.cross_notes))) result.notesWithheld = true;
      continue;
    }
    // This machine's copy of the pass keeps its own mark: an earlier adoption that wrote it holds no report either.
    if (theirs.notesWithheld === true) result.notesWithheld = true;
    else delete result.notesWithheld;
    fillKeys(result, theirs, ['contracts', 'cross_notes', 'dropped', 'files']);
    for (const verdict of Array.isArray(result.verdicts) ? result.verdicts : []) fillKeys(verdict, matching(theirs.verdicts, verdict, ['flow', 'invariant', 'verdict']));
  }
  // A pass whose holds or not_affected verdict arrived with no evidence, which a copy that is not private never posts,
  // is marked for this machine: the review step does not count it as finished, so its reviewer answers again here.
  for (const result of Object.values(isObject(remote.passes) ? remote.passes : {})) {
    if (!isObject(result)) continue;
    const unproven = (Array.isArray(result.verdicts) ? result.verdicts : []).some((verdict) => isObject(verdict) && ['holds', 'not_affected'].includes(verdict.verdict) && (typeof verdict.evidence !== 'string' || verdict.evidence.trim() === ''));
    if (unproven) result.evidenceWithheld = true;
    else delete result.evidenceWithheld;
  }
  for (const [flow, signoff] of Object.entries(isObject(remote.signoffs) ? remote.signoffs : {})) {
    const theirs = local.signoffs?.[flow];
    if (isObject(signoff) && isObject(theirs) && sameHead(signoff.head, theirs.head) && signoff.at === theirs.at) fillKeys(signoff, theirs);
  }
  const byEntry = (key, keys) => {
    for (const entry of Array.isArray(remote[key]) ? remote[key] : []) if (isObject(entry)) fillKeys(entry, matching(local[key], entry, keys));
  };
  byEntry('overrulings', ['flow', 'invariant', 'head', 'at']);
  byEntry('acceptances', ['flow', 'invariant', 'head', 'at']);
  byEntry('waivers', ['head', 'kind', 'at']);
  byEntry('pending', ['id']);
  for (const stop of Array.isArray(remote.quotaStops) ? remote.quotaStops : []) {
    const theirs = isObject(stop) ? matching(local.quotaStops, stop, ['head', 'stage', 'reviewer', 'at']) : null;
    if (!theirs) continue;
    fillKeys(stop, theirs);
    if (isObject(stop.signoff) && isObject(theirs.signoff) && stop.signoff.at === theirs.signoff.at) fillKeys(stop.signoff, theirs.signoff);
  }
  for (const entry of Array.isArray(remote.extensions) ? remote.extensions : []) {
    const theirs = isObject(entry) ? matching(local.extensions, entry, ['source', 'round', 'head', 'at']) : null;
    if (!theirs) continue;
    fillKeys(entry, theirs);
    if (Array.isArray(theirs.red_flags) && Array.isArray(entry.red_flags) && theirs.red_flags.map(flagName).join('\n') === entry.red_flags.join('\n')) entry.red_flags = clone(theirs.red_flags);
    for (const key of ['judge', 'stale_judge', 'human']) {
      if (isObject(entry[key]) && isObject(theirs[key]) && entry[key].at === theirs[key].at) fillKeys(entry[key], theirs[key]);
    }
    for (const kind of ['looping', 'drifting']) {
      for (const each of Array.isArray(entry.signals?.evidence?.[kind]) ? entry.signals.evidence[kind] : []) {
        fillKeys(each, matching(theirs.signals?.evidence?.[kind], each, ['round', 'earlier_round', 'id']), ['file', 'line', 'title']);
      }
    }
  }
  if (isObject(remote.outcome) && isObject(local.outcome) && sameHead(remote.outcome.head, local.outcome.head) && remote.outcome.at === local.outcome.at) fillKeys(remote.outcome, local.outcome);
  if (isObject(remote.visual) && isObject(local.visual) && sameHead(remote.visual.head, local.visual.head)) fillKeys(remote.visual, local.visual, ['reason', 'error']);
  if (isObject(remote.outside) && isObject(local.outside) && sameHead(remote.outside.head, local.outside.head)) {
    for (const entry of Array.isArray(remote.outside.acceptances) ? remote.outside.acceptances : []) fillKeys(entry, matching(local.outside.acceptances, entry, ['flow', 'invariant', 'at']));
  }
  for (const [id, entry] of Object.entries(isObject(remote.dispatched) ? remote.dispatched : {})) {
    const theirs = local.dispatched?.[id];
    if (isObject(entry) && isObject(theirs) && sameHead(entry.head, theirs.head)) fillKeys(entry, theirs);
  }
  // Override lines carry no key of their own: only a copy of this record's own review, the same first round, gets them.
  const lineage = isObject(remote.rounds?.[0]) && isObject(local.rounds?.[0]) && sameHead(remote.rounds[0].head, local.rounds[0].head) && remote.rounds[0].at === local.rounds[0].at;
  if (lineage && Array.isArray(remote.overrides) && Array.isArray(local.overrides)) {
    remote.overrides = [...remote.overrides, ...local.overrides.filter((line) => typeof line === 'string' && !remote.overrides.includes(line))];
  }
  return remote;
}

// ---- A machine without the text ----

// The id of the first open, blocking finding `state` holds with no text that is not this machine's own, as a record
// built on another machine's posted copy can, or null: one marked adopted (fillWithheld), or one `local`, this
// machine's record, does not hold by its id and mint mark. The review step stops on one: the review goes on on the
// machine that recorded it.
export function untextedBlocking(state, local = null) {
  const mine = new Set(recordedFindings(local).filter((each) => !each.adopted && isFindingId(each.id) && isMint(each.mint)).map((each) => `${each.id}:${each.mint}`));
  for (const result of Object.values(isObject(state?.passes) ? state.passes : {})) {
    for (const finding of Array.isArray(result?.list) ? result.list : []) {
      if (!isObject(finding) || !blocks(finding) || (typeof finding.title === 'string' && finding.title.trim())) continue;
      if (finding.adopted === true || !mine.has(`${finding.id}:${finding.mint}`)) return isFindingId(finding.id) ? finding.id : 'a finding with no id';
    }
  }
  return null;
}

// ---- The residual rows of a step's result ----

// The late-round residual rows a step's result lists for the pull request body, through the text decision: a row whose
// finding's text it withholds is named by its id and severity alone, with no title, so it anchors nothing. Text is
// withheld on a pull request from outside the team, for a security finding (securityIds, a row with no id among them)
// on a repository that is not private, and where the full checks withhold the title. Under `publish.publicSecurity`
// "full", a security finding's withheld row on a repository that is not private also keeps its file and line, which
// the checks pass, and never its text. Returns { rows, withheld }.
export function residualRows(rows, state, { reading, checker = plainChecker(), publish } = {}) {
  // The rows are the session's to copy, not the comment's: a check that fails here withholds the row's text and holds
  // no record, so the flag the summary reads is left as it was.
  const failedBefore = checker.failed;
  const secure = securityIds(state);
  const full = publish?.publicSecurity === 'full';
  let withheld = 0;
  // Every string a row keeps passes the checks: the title and the file decide whether the row keeps its text, and the
  // pass and the severity of a row by id are left out when they fail.
  const passes = (value) => typeof value !== 'string' || checker.allows(value);
  const out = rows.map((row) => {
    const security = !isFindingId(row.id) || secure.has(row.id);
    const unshown = security && reading?.visibility !== 'PRIVATE';
    const hidden = reading?.inside !== true || unshown || typeof row.title !== 'string' || !checker.allows(row.title) || !passes(row.file);
    if (!hidden && passes(row.pass) && passes(row.severity)) return row;
    withheld += 1;
    // "full" lifts the place of a security finding with an id, from inside the team, and nothing else.
    const placed = full && unshown && isFindingId(row.id) && reading?.inside === true && typeof row.file === 'string' && passes(row.file);
    const place = placed ? { file: row.file, ...(Number.isSafeInteger(row.line) && row.line >= 1 ? { line: row.line } : {}) } : {};
    return { ...(passes(row.pass) ? { pass: row.pass } : {}), ...(isFindingId(row.id) ? { id: row.id } : {}), ...place, ...(passes(row.severity) ? { severity: row.severity } : {}), text: WITHHELD };
  });
  if ('failed' in checker) checker.failed = failedBefore;
  return { rows: out, withheld };
}

// ---- The findings table (review.publish.summary "findings") ----

// The most rows the table shows; the rest is counted in one line under it.
export const MAX_ROWS = 40;
export const TABLE_HEADING = '**Findings:**';
const HREF = /^https:\/\/[^\s<>()[\]|`"'\\]{1,500}$/u;

// One cell of the findings table, the one encoder every cell goes through: one line; Markdown's `\ ` * _ [ ] |` and the
// HTML metacharacters `& < >` escaped, so no cell closes the row, opens a tag, or formats; and autolinks (`://`, `www.`)
// and `#<n>` and `GH-<n>` references, `owner/repo#<n>` among them, neutralized with a zero-width space. A `link` ({ label, href })
// follows the text, as a link only when `href` is a plain https URL, else as its label alone. The post's escaping
// (escapeLines) then runs on the whole line, as on every other.
export function tableCell(text, link = null) {
  const encode = (value) => String(value ?? '')
    .replace(/[\s\u0085\u2028\u2029]+/gu, ' ').trim()
    .replace(/[\\`*_[\]|]/gu, '\\$&')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replace(/:\/\//gu, ':\u200b//')
    .replace(/(?<![\w.-])www\./giu, 'www\u200b.')
    .replace(/#(?=\d)/gu, '#\u200b')
    .replace(/(?<![\w-])(GH)-(?=\d)/giu, '$1-\u200b');
  const shown = encode(text);
  if (!link || typeof link.label !== 'string') return shown;
  const label = encode(link.label);
  const target = typeof link.href === 'string' && HREF.test(link.href) ? `[${label}](${link.href})` : label;
  return [shown, target].filter(Boolean).join(' ');
}

const SEVERITY_RANK = TABLE.severities;
const rank = (entry) => {
  const at = SEVERITY_RANK.indexOf(severityOf(entry.severity));
  return at === -1 ? SEVERITY_RANK.length : at;
};
const idOrder = (id) => (FINDING_ID_PARTS.exec(id) ?? [0, 0, 0]).slice(1).map(Number);
const FINDING_ID_PARTS = /^R(\d+)-(\d+)$/u;
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// The summary's findings table, from the posted copy `copy`, its finding index: a heading, then at most MAX_ROWS rows,
// blocking findings first, then by severity, then by id, each with the id, the location, the severity, the disposition,
// and the outcome (`open`, `fixed in` or `not reported again in` its closing range, `accepted as` its disposition), and
// no finding text; then one line for the rows left out. A location is printed only from a file that is at most
// MAX_PATH characters and named by git at the entry's head or by the pull request's diff, and a line within that file:
// the File and line check, which runs here too, as for a record an older release wrote. A closing range is a link only
// where the forge builds one (`post.compareUrl`), else the two short SHAs as text. On a reading that is not private,
// under publicSecurity "counts", a security finding (the copy's mark, or a critical or high severity) is counted while
// open, and once closed its row holds its id, severity, outcome, and closing range only (R5).
export function findingsTable(copy, post = {}) {
  const entries = Object.values(isObject(copy?.index) ? copy.index : {}).filter((entry) => isObject(entry) && isFindingId(entry.id));
  if (!entries.length) return [];
  const shown = isPrivate(post.reading) || post.publish?.publicSecurity === 'full';
  const hidden = (entry) => !shown && (entry.security === true || securitySeverity(entry.severity));
  const counted = entries.filter((entry) => hidden(entry) && entry.state === 'open');
  const blocking = (entry) => entry.state === 'open' && blocks(entry);
  const rows = entries.filter((entry) => !counted.includes(entry)).sort((a, b) => {
    const keys = [[blocking(b), blocking(a)].map(Number), [rank(a), rank(b)], ...idOrder(a.id).map((part, i) => [part, idOrder(b.id)[i]])];
    for (const [x, y] of keys) if (x !== y) return x - y;
    return 0;
  });
  const paths = post.root ? gitPaths(post.root) : null;
  const diffPaths = post.diffPaths instanceof Set ? post.diffPaths : new Set();
  const place = (entry) => {
    const head = entry.placed ?? entry.seen ?? entry.closed_in?.to ?? copy.passes?.[entry.pass]?.head;
    const file = entry.file;
    if (hidden(entry) || typeof file !== 'string' || file.length > MAX_PATH || file.trim() === '') return '';
    if (!(diffPaths.has(file) || paths?.tracked(head, file) === true)) return '';
    const count = paths?.lines(head, file);
    const line = Number.isSafeInteger(entry.line) && entry.line >= 1 && Number.isSafeInteger(count) && entry.line <= count ? entry.line : null;
    return line === null ? file : `${file}:${line}`;
  };
  const range = (entry) => {
    const { from, to } = isObject(entry.closed_in) ? entry.closed_in : {};
    if (!isSha(from) || !isSha(to)) return null;
    const href = post.compareUrl?.(from, to);
    return { label: `${from.slice(0, 7)}...${to.slice(0, 7)}`, href: typeof href === 'string' ? href : null };
  };
  const disposition = (entry) => (!hidden(entry) && DISPOSITIONS.has(entry.disposition) ? entry.disposition : '');
  const outcome = (entry) => {
    if (entry.state === 'fixed') return tableCell(range(entry) ? 'fixed in' : 'fixed', range(entry));
    if (entry.state === 'not_reported') return tableCell(range(entry) ? 'not reported again in' : 'not reported again', range(entry));
    if (entry.state === 'accepted') return tableCell(disposition(entry) ? `accepted as ${disposition(entry)}` : 'accepted');
    return tableCell(entry.state === 'open' ? 'open' : 'unknown');
  };
  const row = (entry) => `| ${[tableCell(entry.id), tableCell(place(entry)), tableCell(severityOf(entry.severity) ?? ''), tableCell(disposition(entry)), outcome(entry)].join(' | ')} |`;
  const lines = ['', TABLE_HEADING];
  if (rows.length) lines.push('', '| Finding | Location | Severity | Disposition | Outcome |', '| --- | --- | --- | --- | --- |', ...rows.slice(0, MAX_ROWS).map(row));
  if (rows.length > MAX_ROWS) lines.push(`- ${plural(rows.length - MAX_ROWS, 'more finding')}, not listed: the table holds ${MAX_ROWS}.`);
  if (counted.length) lines.push(`- ${plural(counted.length, 'open security finding')}, counted and not listed: the repository does not read as private.`);
  return lines;
}

// ---- The closing reply (review.publish.replies) ----

// The outcome line a closed finding's reply may show, as candidates, the fullest first: `Fixed in <compare link>.`,
// `Not reported again in <compare link>.`, or `Accepted as <disposition>.`, each built from the engine's own values
// alone: the closing range's two full SHAs, a link only where the forge builds one (`compareUrl`) and it is a plain
// https URL, else the two short SHAs as text; and a disposition word of the table. Then the same line with less, down to
// the bare outcome, so a check that withholds the link still lets a reply post. No reviewer text is ever in one. An
// entry that is not closed gives none.
export function replyLines(entry, compareUrl = () => null) {
  if (!isObject(entry)) return [];
  if (entry.state === 'accepted') return [...(DISPOSITIONS.has(entry.disposition) ? [`Accepted as ${entry.disposition}.`] : []), 'Accepted.'];
  const words = { fixed: 'Fixed', not_reported: 'Not reported again' }[entry.state];
  if (!words) return [];
  const { from, to } = isObject(entry.closed_in) ? entry.closed_in : {};
  if (!isSha(from) || !isSha(to)) return [`${words}.`];
  const label = `${from.slice(0, 7)}...${to.slice(0, 7)}`;
  let href = null;
  try {
    href = compareUrl(from, to);
  } catch {}
  return [...(typeof href === 'string' && HREF.test(href) ? [`${words} in [${label}](${href}).`] : []), `${words} in ${label}.`, `${words}.`];
}
