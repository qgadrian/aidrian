// `aidrian quorum`: the deterministic part of the expert quorum, where two adversaries attack a plan with cited
// objections and an architect rules on each one.
//   codex   runs Codex as adversary B, held to OBJECTIONS_SCHEMA (`--mode object`, the default) or, to answer the
//           architect's rulings on its objections in a ledger, to REBUTTALS_SCHEMA and that ledger (`--mode rebut`),
//           and prints one { status, reason } line
//   check   checks every citation of a ledger against the repository and the plan, relabels an objection with no
//           passing citation as `opinion`, and names each ruling or rebuttal with no passing citation
// LEDGER_SCHEMA, OBJECTIONS_SCHEMA, and REBUTTALS_SCHEMA are the one source of truth for these files. `check` runs no command but
// `git ls-files`, and never executes what a citation names.

import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { insidePath, isObject, linksOutside } from './fs.mjs';
import { runGit } from './git.mjs';
import { isolate } from './review/env.mjs';
import { sectionOf, slug } from './review/flows.mjs';
import { codexAvailable, runCodex } from './review/reviewers.mjs';

export const CITATION_KINDS = Object.freeze(['doc', 'adr', 'code', 'plan', 'absence']);
export const SEVERITIES = Object.freeze(['blocking', 'important', 'improvement']);
// The objection statuses: `pending` until the architect rules, `opinion` when no citation passes.
export const OBJECTION_STATUSES = Object.freeze(['pending', 'opinion', 'accepted', 'rejected', 'escalated']);
export const MAX_OBJECTIONS = 7;
export const MAX_QUOTE = 200;
// Codex's time for one adversary pass; the coordinator's shell timeout (15 minutes) stays above it.
export const CODEX_TIMEOUT_SEC = 780;
// The variables that change how git reads a pathspec. `check` passes --literal-pathspecs, which git refuses beside any
// of the others, so its one `git ls-files` call runs without them.
const PATHSPEC_VARS = Object.freeze(['GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS', 'GIT_LITERAL_PATHSPECS']);

// Codex holds its answer to the schema strictly: every property required, no other allowed, as FINDINGS_SCHEMA.
const CITATION = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'ref', 'quote'],
  properties: {
    kind: { type: 'string', enum: CITATION_KINDS },
    ref: { type: 'string' },
    quote: { type: 'string' },
  },
});
const CITATIONS = Object.freeze({ type: 'array', items: CITATION });

// What adversary B (Codex) answers: at most MAX_OBJECTIONS objections, each with its citations.
export const OBJECTIONS_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['objections'],
  properties: {
    objections: {
      type: 'array',
      maxItems: MAX_OBJECTIONS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'claim', 'citations'],
        properties: {
          severity: { type: 'string', enum: SEVERITIES },
          claim: { type: 'string' },
          citations: CITATIONS,
        },
      },
    },
  },
});

export const VERDICTS = Object.freeze(['rebut', 'concede']);

// What adversary B (Codex) answers to the architect's rulings: one rebuttal or concession per objection, named by its
// ledger id, at most one per id (rebuttalProblems checks the ids). An entry without `objection_id` is the ledger's
// `rebuttal` before its ruling, field for field. A concession may cite nothing.
export const REBUTTALS_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['rebuttals'],
  properties: {
    rebuttals: {
      type: 'array',
      maxItems: MAX_OBJECTIONS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['objection_id', 'verdict', 'claim', 'citations'],
        properties: {
          objection_id: { type: 'string' },
          verdict: { type: 'string', enum: VERDICTS },
          claim: { type: 'string' },
          citations: CITATIONS,
        },
      },
    },
  },
});

// `aidrian quorum codex --mode`: the schema Codex's answer is held to, and the list the done line counts.
const MODES = Object.freeze({
  object: { schema: OBJECTIONS_SCHEMA, list: 'objections' },
  rebut: { schema: REBUTTALS_SCHEMA, list: 'rebuttals' },
});

const RULING = Object.freeze({
  type: ['object', 'null'],
  additionalProperties: false,
  required: ['decision', 'change_or_reason', 'citations'],
  properties: {
    decision: { type: 'string', enum: ['accept', 'reject', 'escalate'] },
    change_or_reason: { type: 'string' },
    citations: CITATIONS,
  },
});

// The objection ledger, `<state>/quorum/<name>-<plan-hash>.json`: `<name>` is the plan's file name without `.md`, or
// `<parent-folder>-plan` for a file named `plan.md`.
export const LEDGER_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['status', 'plan', 'plan_hash', 'same_model', 'same_model_reason', 'trigger', 'objections', 'human_answers'],
  properties: {
    status: { type: 'string', enum: ['open', 'complete'] },
    plan: { type: 'string' },
    plan_hash: { type: 'string' },
    same_model: { type: 'boolean' },
    same_model_reason: { type: ['string', 'null'] },
    trigger: { type: 'string' },
    objections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'by', 'severity', 'claim', 'citations', 'status', 'ruling', 'rebuttal'],
        properties: {
          id: { type: 'string' },
          by: { type: 'string', enum: ['A', 'B'] },
          severity: { type: 'string', enum: SEVERITIES },
          claim: { type: 'string' },
          citations: CITATIONS,
          status: { type: 'string', enum: OBJECTION_STATUSES },
          ruling: RULING,
          rebuttal: {
            type: ['object', 'null'],
            additionalProperties: false,
            required: ['verdict', 'claim', 'citations', 'ruling'],
            properties: {
              verdict: { type: 'string', enum: VERDICTS },
              claim: { type: 'string' },
              citations: CITATIONS,
              ruling: RULING,
            },
          },
        },
      },
    },
    human_answers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['objection_id', 'answer'],
        properties: { objection_id: { type: 'string' }, answer: { type: 'string' } },
      },
    },
  },
});

// The problems of `value` against `schema`, for the subset of JSON Schema the schemas above use: type (one or a
// list), enum, required, properties, additionalProperties: false, items, and maxItems. [] when it is valid.
export function schemaProblems(value, schema, where = '$') {
  const types = [schema.type].flat().filter(Boolean);
  if (types.length && !types.some((type) => isType(value, type))) return [`${where} must be ${types.join(' or ')}`];
  if (value === null) return [];
  if (schema.enum && !schema.enum.includes(value)) return [`${where} must be one of ${schema.enum.join(', ')}`];
  const problems = [];
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) problems.push(`${where} has ${value.length} items, more than ${schema.maxItems}`);
    if (schema.items) value.forEach((item, i) => problems.push(...schemaProblems(item, schema.items, `${where}[${i}]`)));
  } else if (isObject(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) problems.push(`${where}.${key} is missing`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties && Object.hasOwn(schema.properties, key)) problems.push(...schemaProblems(item, schema.properties[key], `${where}.${key}`));
      else if (schema.additionalProperties === false) problems.push(`${where}.${key} is not a known field`);
    }
  }
  return problems;
}

function isType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isObject(value);
  if (type === 'integer') return Number.isInteger(value);
  return typeof value === type;
}

// Why a rebuttals answer does not fit `ledger`, as one line per problem: an id named twice; an id that is not one of B's
// objections ruled `reject` or `accept` (a partial accept's rebuttal covers its rejected part) and not `escalated`, since
// an escalated objection goes to the Human and gets no rebuttal; or one of B's objections with status `rejected` and no
// entry. [] when it fits.
export function rebuttalProblems(answer, ledger) {
  const ids = answer.rebuttals.map((entry) => entry.objection_id);
  const answerable = ledger.objections.filter((each) => each.by === 'B' && ['reject', 'accept'].includes(each.ruling?.decision) && each.status !== 'escalated');
  const open = new Set(answerable.map((each) => each.id));
  const twice = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  const unknown = [...new Set(ids.filter((id) => !open.has(id)))];
  const missing = answerable.filter((each) => each.status === 'rejected' && !ids.includes(each.id)).map((each) => each.id);
  const problems = [];
  if (twice.length) problems.push(`the answer names ${twice.join(', ')} more than once`);
  if (unknown.length) problems.push(`the answer names ${unknown.join(', ')}, not B's objection ruled reject or accept, and not escalated, in the ledger`);
  if (missing.length) problems.push(`the answer has no entry for ${missing.join(', ')}, B's objection rejected in the ledger`);
  return problems;
}

// Whitespace runs as one space, ends trimmed: a quote matches across line breaks and indentation.
export const collapse = (text) => String(text).replace(/\s+/gu, ' ').trim();

// A citation's ref path that leaves the repository root: `..`, an absolute path, or a symlink out.
class Escape extends Error {}

// Why one citation fails, or null when it passes. Throws Escape when its ref path leaves `root`.
// `ctx` is { root, plan (the plan text), env (for git), read(file) → text or null }.
export function citationProblem(citation, ctx) {
  const quote = collapse(citation.quote);
  if (!quote) return 'the quote is empty';
  if (quote.length > MAX_QUOTE) return `the quote is ${quote.length} characters, more than ${MAX_QUOTE}`;
  const { kind, ref } = citation;
  if (!CITATION_KINDS.includes(kind)) return `"${kind}" is not a citation kind`;
  const place = refParts(citation);
  if (place.problem) return place.problem;
  if (kind === 'plan') return inSection(ctx.plan, place.anchor, quote, 'the plan');
  const file = inside(ctx.root, place.path, ref, kind === 'absence');
  if (file.problem) return file.problem;
  if (kind === 'doc' || kind === 'adr') {
    const text = ctx.read(file.path);
    return text === null ? `${file.path} is missing` : inSection(text, place.anchor, quote, file.path);
  }
  if (kind === 'code') {
    const text = ctx.read(file.path);
    if (text === null) return `${file.path} is missing`;
    // The line is advisory: lines drift, so the quote may be anywhere in the file.
    return collapse(text).includes(quote) ? null : `${file.path} does not contain the quote`;
  }
  // absence: tracked files only, so a needle in an ignored or untracked file is not in the project.
  const env = { ...ctx.env };
  for (const key of PATHSPEC_VARS) delete env[key];
  const listed = runGit(['--literal-pathspecs', 'ls-files', '-z', '--', file.path], ctx.root, { timeout: 30_000, env, maxBuffer: 64 * 1024 * 1024 });
  if (listed.status !== 0) return `git ls-files failed on ${file.path}`;
  const files = listed.stdout.split('\0').filter(Boolean);
  if (!files.length) return `git tracks no file under ${file.path}`;
  const hit = files.find((each) => {
    const text = readRegular(ctx.root, each);
    return text !== null && collapse(text).includes(quote);
  });
  return hit ? `${hit} contains the quote` : null;
}

// The parts of a citation's ref by its kind: { path, anchor } (anchor slugged; path as written), or { problem }.
function refParts({ kind, ref }) {
  if (kind === 'plan') {
    if (!ref.startsWith('#')) return { problem: `"${ref}" is not #anchor` };
    return ref.length > 1 ? { path: null, anchor: ref.slice(1) } : { problem: 'the plan: the anchor is empty' };
  }
  if (kind === 'doc' || kind === 'adr') {
    const at = ref.indexOf('#');
    if (at === -1) return { problem: `"${ref}" is not path#anchor` };
    if (at === ref.length - 1) return { problem: `"${ref}": the anchor is empty` };
    return { path: ref.slice(0, at), anchor: ref.slice(at + 1) };
  }
  if (kind === 'code') {
    const place = /^(.*?):(\d+)(?:-\d+)?$/u.exec(ref);
    return place ? { path: place[1], anchor: null } : { problem: `"${ref}" is not path:line` };
  }
  return { path: ref, anchor: null };
}

// `rel`, a path relative to the root, as { path } inside it, or { problem } when it is not a relative path: empty, with
// an empty part (`a//b`), or with a backslash. Throws Escape when it leaves the root, as text (`..`, an absolute path) or
// through a symlink. `folder` allows `.`, the whole repository.
function inside(root, rel, ref, folder = false) {
  const notRelative = { problem: `"${ref}" is not a relative path` };
  if (path.isAbsolute(rel)) throw new Escape(`${rel} is outside the repository root`);
  if (rel.includes('\\') || rel.replace(/\/+$/u, '').split('/').includes('')) return notRelative;
  const normal = path.posix.normalize(rel).replace(/\/+$/u, '');
  if (normal === '..' || normal.startsWith('../')) throw new Escape(`${rel} is outside the repository root`);
  if (normal === '.') return folder ? { path: '.' } : notRelative;
  const joined = insidePath(root, '', normal);
  if (joined === null) throw new Escape(`${rel} is outside the repository root`);
  return { path: joined };
}

// A tracked file's text, when it is a regular file inside the root; null for a symlink, a folder (a submodule), or
// anything else, so a link cannot bring an outside file's text into the check.
function readRegular(root, file) {
  try {
    if (!lstatSync(path.join(root, file)).isFile() || linksOutside(root, file)) return null;
    return readFileSync(path.join(root, file), 'utf8');
  } catch {
    return null;
  }
}

// Why `quote` is not in the section of `text` under `anchor`, matched by heading text or slug; null when it is.
function inSection(text, anchor, quote, name) {
  const section = sectionOf(text, slug(anchor));
  if (!section) return `${name} has no heading #${slug(anchor)}`;
  return collapse(`${section.heading}\n${section.body}`).includes(quote) ? null : `${name}#${slug(anchor)} does not contain the quote`;
}

// The identity of a citation, for telling whether a rebuttal cites anything new: kind, the normalized path, the
// slugged anchor, and the collapsed quote. The line of a `code` ref is not part of it, since lines drift.
function citationKey(citation) {
  const place = refParts(citation);
  if (place.problem) return `${citation.kind}\0${citation.ref}\0${collapse(citation.quote)}`;
  const file = place.path === null ? '' : path.posix.normalize(place.path).replace(/\/+$/u, '').replace(/^\.\//u, '');
  return [citation.kind, file, place.anchor === null ? '' : slug(place.anchor), collapse(citation.quote)].join('\0');
}

// The problems that make a `complete` ledger unfinished: an objection still pending, or one with a status that needs a
// ruling and has none. [] for an `open` ledger.
export function completeProblems(ledger) {
  if (ledger.status !== 'complete') return [];
  return ledger.objections.flatMap((objection) => {
    if (objection.status === 'pending') return [`objection ${objection.id} is pending in a complete ledger`];
    if (objection.status !== 'opinion' && objection.ruling === null) return [`objection ${objection.id} is ${objection.status} with no ruling in a complete ledger`];
    return [];
  });
}

// Checks a ledger in place: { ledger, problems, escapes }. `problems` lists each failed citation, relabel, and
// invalid ruling or rebuttal with its reason; `escapes` lists each ref path outside the root, which fails the check.
export function checkLedger(ledger, ctx) {
  const problems = [];
  const escapes = [];
  // The citations of `list` that pass, naming each that fails.
  const passing = (list, where) => list.filter((citation, i) => {
    try {
      const problem = citationProblem(citation, ctx);
      if (problem) problems.push(`${where}.citations[${i}] (${citation.kind} ${citation.ref}): ${problem}`);
      return problem === null;
    } catch (error) {
      if (!(error instanceof Escape)) throw error;
      escapes.push(`${where}.citations[${i}]: ${error.message}`);
      return false;
    }
  });
  const ruling = (value, where) => {
    if (value && !passing(value.citations, where).length) problems.push(`${where}: invalid: the ruling has no passing citation`);
  };
  // What a rebuttal must add to: what the ledger held before the rebuttal round, every objection's citations and every
  // first ruling's. Rebuttals and their rulings are left out, so two rebuttals that bring the same new evidence are both new.
  const cited = new Set(ledger.objections.flatMap((objection) => [...objection.citations, ...(objection.ruling?.citations ?? [])]).map(citationKey));
  for (const objection of ledger.objections) {
    const where = `objection ${objection.id}`;
    if (!passing(objection.citations, where).length && objection.status !== 'opinion') {
      problems.push(`${where}: relabeled opinion (was ${objection.status}): no citation passes`);
      objection.status = 'opinion';
    }
    ruling(objection.ruling, `${where} ruling`);
    const rebuttal = objection.rebuttal;
    if (rebuttal) {
      // A concession needs no citation; a rebuttal needs a passing one the ledger does not already hold.
      const proof = passing(rebuttal.citations, `${where} rebuttal`);
      if (rebuttal.verdict === 'rebut') {
        if (!proof.length) problems.push(`${where} rebuttal: invalid: the rebuttal has no passing citation`);
        else if (proof.every((citation) => cited.has(citationKey(citation)))) problems.push(`${where} rebuttal: invalid: the rebuttal cites nothing new`);
      }
      ruling(rebuttal.ruling, `${where} rebuttal ruling`);
    }
  }
  return { ledger, problems, escapes };
}

// Reads a file under the root, or null when it is missing or not a file.
const reader = (root) => (file) => {
  try {
    return readFileSync(path.join(root, file), 'utf8');
  } catch {
    return null;
  }
};

// The top folder of the checkout `cwd` is in: the nearest folder above it that holds `.git`, a folder in a main
// checkout and a file in a linked worktree. Found without running git, so `check` runs no command but `git ls-files`.
export function checkoutTop(cwd) {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, '.git'))) return realpathSync(dir);
    if (path.dirname(dir) === dir) return null;
  }
}

const fail = (problem) => {
  console.error(`aidrian quorum: ${problem}`);
  return 1;
};

// `aidrian quorum codex`: { status, reason } where status is done, unavailable, failed, quota, or timed_out. `mode`
// (a key of MODES) picks the schema; `rebut` also needs `ledger`, the ledger file the answer must fit. `deps` replaces
// Codex in tests: { spawnImpl, codex (codexAvailable), timeoutSec }.
export async function codexAnswer({ plan, brief, out, root, mode = 'object', ledger = null }, { spawnImpl = spawn, codex = codexAvailable, timeoutSec = CODEX_TIMEOUT_SEC } = {}) {
  if (!Object.hasOwn(MODES, mode)) return { status: 'failed', reason: `"${mode}" is not a mode: ${Object.keys(MODES).join(' or ')}` };
  if (mode === 'rebut' && !ledger) return { status: 'failed', reason: '--mode rebut needs a ledger' };
  const { schema, list } = MODES[mode];
  const ready = codex();
  if (!ready.ok) return { status: 'unavailable', reason: ready.reason };
  // A file that cannot be read or written is a failed run, so the command still prints its one line.
  try {
    // The ledger is read and checked before Codex starts, so a bad one costs no Codex run.
    let rulings = null;
    if (mode === 'rebut') {
      rulings = JSON.parse(readFileSync(ledger, 'utf8'));
      const invalid = schemaProblems(rulings, LEDGER_SCHEMA);
      if (invalid.length) return { status: 'failed', reason: `the ledger does not follow the schema: ${invalid[0]}` };
    }
    const prompt = `${readFileSync(brief, 'utf8').trimEnd()}\n\n${readFileSync(plan, 'utf8')}`;
    const result = await runCodex({ root, env: isolate({ ...process.env }), schema, prompt, timeoutSec, spawnImpl });
    if (result.status !== 'done') return { status: result.status, reason: result.reason };
    const problems = schemaProblems(result.raw, schema);
    if (problems.length) return { status: 'failed', reason: `the answer does not follow the schema: ${problems[0]}` };
    const misfits = rulings ? rebuttalProblems(result.raw, rulings) : [];
    if (misfits.length) return { status: 'failed', reason: `the answer does not fit the ledger: ${misfits.join('; ')}` };
    mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    writeFileSync(out, `${JSON.stringify(result.raw, null, 2)}\n`);
    return { status: 'done', reason: `${result.raw[list].length} ${list} written to ${out}` };
  } catch (error) {
    return { status: 'failed', reason: error.message };
  }
}

const USAGE = 'codex --plan PLAN --brief BRIEF --out FILE [--mode object] | codex --mode rebut --ledger LEDGER --plan PLAN --brief BRIEF --out FILE | check LEDGER --plan PLAN';

export const commands = {
  quorum: {
    usage: USAGE,
    about: 'run Codex as the quorum\'s second adversary, to object or to rebut, and print one {status, reason} line, or check a ledger\'s citations against the repository and the plan',
    async run(args, deps = {}) {
      const [action, ...rest] = args;
      // Git and Codex run without the variables a git hook sets, so they act on the repository of this folder.
      const env = isolate({ ...process.env });
      const root = checkoutTop(deps.cwd ?? process.cwd());
      if (action === 'codex') {
        const { values } = parseArgs({ args: rest, options: { plan: { type: 'string' }, brief: { type: 'string' }, out: { type: 'string' }, mode: { type: 'string', default: 'object' }, ledger: { type: 'string' } } });
        if (!values.plan || !values.brief || !values.out) return fail('codex needs --plan, --brief, and --out');
        if (!Object.hasOwn(MODES, values.mode)) return fail(`codex --mode is ${Object.keys(MODES).join(' or ')}, not "${values.mode}"`);
        if (values.mode === 'rebut' && !values.ledger) return fail('codex --mode rebut needs --ledger');
        if (values.mode !== 'rebut' && values.ledger !== undefined) return fail('codex --ledger is only for --mode rebut');
        if (!root) return fail('run it inside a git repository');
        const result = await codexAnswer({ ...values, root }, deps);
        (deps.print ?? console.log)(JSON.stringify({ status: result.status, reason: result.reason }));
        return result.status === 'done' ? 0 : result.status === 'unavailable' ? 3 : 1;
      }
      if (action === 'check') {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { plan: { type: 'string' } } });
        if (positionals.length !== 1 || !values.plan) return fail('check needs one LEDGER and --plan');
        if (!root) return fail('run it inside a git repository');
        const [file] = positionals;
        let ledger;
        let plan;
        try {
          ledger = JSON.parse(readFileSync(file, 'utf8'));
          plan = readFileSync(values.plan, 'utf8');
        } catch (error) {
          return fail(error.message);
        }
        // A schema error, or a complete ledger left unfinished, stops the check before it writes anything.
        const invalid = schemaProblems(ledger, LEDGER_SCHEMA);
        if (!invalid.length) invalid.push(...completeProblems(ledger));
        if (invalid.length) {
          for (const problem of invalid) console.error(`${file}: ${problem}`);
          return 1;
        }
        const { problems, escapes } = checkLedger(ledger, { root, plan, env, read: reader(root) });
        if (escapes.length) {
          for (const escape of escapes) console.error(`${file}: ${escape}`);
          return 1;
        }
        const print = deps.print ?? console.log;
        for (const problem of problems) print(problem);
        writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`);
        const opinions = ledger.objections.filter((objection) => objection.status === 'opinion').length;
        print(`checked: ${ledger.objections.length} objections, ${opinions} opinion, ${problems.length} problems`);
        return 0;
      }
      return fail(`usage: aidrian quorum ${USAGE}`);
    },
  },
};
