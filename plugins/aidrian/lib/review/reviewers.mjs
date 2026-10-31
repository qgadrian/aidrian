// Reviewers: who does one pass of a review plan. Every reviewer is an entry in one map: the built-ins below, then the
// project's `review.reviewers`. Three kinds:
//   exec    a command: the pass's input as JSON on stdin, findings as JSON on stdout (FINDINGS_SCHEMA). run.mjs runs it.
//   agent   a Claude agent: a command cannot start one, so `aidrian pr review` returns a `dispatch` action and the
//           review skill runs the agent, then records its result with `aidrian pr attest`.
//   remote  the review bot on the pull request (lib/pr-await-review.mjs). Built in only, for now.
// docs/review.md#reviewers describes how to add one.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { isObject } from '../fs.mjs';

// The schema every exec reviewer's stdout follows, and the one Codex is held to with --output-schema.
export const FINDINGS_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['findings', 'verdicts'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'line', 'title', 'body', 'severity'],
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          title: { type: 'string' },
          body: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
        },
      },
    },
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['flow', 'invariant', 'verdict', 'evidence'],
        properties: {
          flow: { type: 'string' },
          invariant: { type: 'string' },
          verdict: { type: 'string', enum: ['holds', 'violated', 'not_affected', 'cannot_verify'] },
          evidence: { type: 'string' },
        },
      },
    },
  },
});

// The built-in reviewers. `codex-local` runs Codex on this machine, read-only; `self` is the plugin's code-reviewer
// agent, never the author; `pr-bot` is config.json `github.reviewer`.
export const BUILT_IN = Object.freeze({
  'codex-local': { kind: 'exec', builtIn: 'codex', stage: 'independent', independent: true, timeoutSec: 780 },
  self: { kind: 'agent', agent: 'code-reviewer', stage: 'local', independent: false },
  'pr-bot': { kind: 'remote', stage: 'remote', independent: true },
});

// The reviewer map for a project: built-ins, then the project's, each with its stage filled in.
export function reviewerMap(config) {
  const out = {};
  for (const [name, reviewer] of Object.entries({ ...BUILT_IN, ...config.review.reviewers })) {
    out[name] = { name, ...reviewer, stage: reviewer.stage ?? (reviewer.kind === 'agent' ? 'local' : reviewer.kind === 'remote' ? 'remote' : 'independent'), independent: reviewer.independent ?? reviewer.kind !== 'agent' };
  }
  return out;
}

// Whether Codex can run here: on the PATH and logged in. Read once per process.
let codexReady;
export function codexAvailable(run = spawnSync) {
  if (codexReady !== undefined) return codexReady;
  const status = run('codex', ['login', 'status'], { encoding: 'utf8', timeout: 10_000 });
  codexReady = status.status === 0 ? { ok: true } : { ok: false, reason: status.error?.code === 'ENOENT' ? 'the codex CLI is not installed' : 'codex is not logged in (`codex login`)' };
  return codexReady;
}

// The engine this machine reviews with, from the local file's `review.engine`: { reviewer, reason } or { problem }.
// `auto` takes codex-local, else the review bot, else self, and says which and why.
export function resolveEngine(config, { codex = codexAvailable } = {}) {
  const map = reviewerMap(config);
  const wanted = config.reviewEngine ?? 'auto';
  const botOn = config.github.reviewer !== null;
  if (wanted === 'auto') {
    const ready = codex();
    if (ready.ok) return { reviewer: map['codex-local'], reason: 'auto: codex is installed and logged in' };
    if (botOn) return { reviewer: map['pr-bot'], reason: `auto: ${ready.reason}, so the review bot` };
    return { reviewer: map.self, reason: `auto: ${ready.reason} and no review bot, so self` };
  }
  if (!Object.hasOwn(map, wanted)) return { problem: `review.engine "${wanted}" is not a built-in engine or a reviewer of review.reviewers` };
  if (wanted === 'pr-bot' && !botOn) return { problem: 'review.engine is "pr-bot", but config.json github.reviewer is none' };
  if (wanted === 'codex-local') {
    const ready = codex();
    if (!ready.ok) return { problem: `review.engine is "codex-local", but ${ready.reason}` };
  }
  return { reviewer: map[wanted], reason: `review.engine: ${wanted}` };
}

// Whether `reviewers` (the names of the passes a plan will run) meet a `require` word. `independent-model` needs a
// reviewer that is not the author's model; `agent:<name>` needs that agent.
export function satisfies(word, passes, map) {
  if (word === 'independent-model') return passes.some((pass) => map[pass.reviewer]?.independent);
  if (word.startsWith('agent:')) return passes.some((pass) => pass.kind === 'agent' && pass.reviewer === word.slice('agent:'.length));
  return false;
}

// The problems with one finding or verdict list an exec reviewer printed; findings that fail are dropped and named.
export function cleanOutput(raw) {
  const dropped = [];
  if (!isObject(raw) || !Array.isArray(raw.findings)) return { findings: [], verdicts: [], dropped: ['the output is not { findings: [...] }'], valid: false };
  const findings = raw.findings.filter((finding, i) => {
    const ok = isObject(finding) && typeof finding.file === 'string' && Number.isInteger(finding.line) && typeof finding.title === 'string' &&
      ['critical', 'high', 'medium', 'low'].includes(finding.severity);
    if (!ok) dropped.push(`findings[${i}] is malformed`);
    return ok;
  });
  const verdicts = (Array.isArray(raw.verdicts) ? raw.verdicts : []).filter((verdict, i) => {
    const ok = isObject(verdict) && typeof verdict.flow === 'string' && typeof verdict.invariant === 'string' &&
      ['holds', 'violated', 'not_affected', 'cannot_verify'].includes(verdict.verdict) && typeof verdict.evidence === 'string';
    if (!ok) dropped.push(`verdicts[${i}] is malformed`);
    return ok;
  });
  return { findings, verdicts, dropped, valid: true };
}

// The prompt a model reviewer reads: the pass input as instructions and data. The input is JSON, so a diff cannot
// close the instructions.
export function reviewPrompt(input) {
  return [
    'You are reviewing a pull request. You did not write it. Read-only: change nothing.',
    `Review the diff from ${input.base} to ${input.head} (run \`git diff ${input.base} ${input.head}\`; read any file at ${input.head} you need).`,
    input.files ? `Report findings only in these files: ${input.files.join(', ')}.` : 'Report findings in any changed file.',
    'Look for correctness bugs, regressions, edge cases, security, data consistency, error handling, and missing tests.',
    'When you find a mistake, search the whole change for every copy and list each in that finding. Finish the whole review before answering.',
    input.flows.length ? 'For each critical flow below, give one verdict per invariant: holds, violated, not_affected, or cannot_verify. Evidence for holds or not_affected must cite file:line at the head commit, or a test name. Earlier reviewers\' verdicts are listed: challenge every "holds" you cannot confirm yourself.' : '',
    'Answer with JSON only, in the schema you were given.',
    '',
    'Input (JSON):',
    JSON.stringify(input, null, 2),
  ].filter((line) => line !== '').join('\n');
}

const lastLine = (text) => text.trim().split('\n').filter(Boolean).at(-1) ?? '';

// Runs one exec reviewer on one pass: resolves to { status: 'done', findings, verdicts, dropped } or
// { status: 'failed' | 'quota' | 'timed_out', reason }. `env` must already be clean (run.mjs isolates it).
export function runExec(reviewer, input, { root, env, spawnImpl = spawn }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-review-'));
  const out = path.join(dir, 'out.json');
  let argv;
  if (reviewer.builtIn === 'codex') {
    const schema = path.join(dir, 'schema.json');
    writeFileSync(schema, JSON.stringify(FINDINGS_SCHEMA));
    argv = ['codex', 'exec', '--sandbox', 'read-only', '--ephemeral', '--cd', root, '--output-schema', schema, '-o', out, '-'];
  } else argv = reviewer.command;
  const stdinText = reviewer.builtIn === 'codex' ? reviewPrompt(input) : JSON.stringify(input);
  return new Promise((done) => {
    const child = spawnImpl(argv[0], argv.slice(1), { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), (reviewer.timeoutSec ?? 600) * 1000);
    let timedOut = false;
    timer.unref?.();
    child.on('error', (error) => finish({ status: 'failed', reason: error.code === 'ENOENT' ? `${argv[0]} is not installed` : error.message }));
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code, signal) => {
      if (signal === 'SIGTERM') timedOut = true;
      if (timedOut) return finish({ status: 'timed_out', reason: `no answer in ${reviewer.timeoutSec ?? 600} s` });
      // Only a failed run can be a quota stop: a successful one logs its whole session to stderr, words included.
      if (code !== 0 && /usage limit|rate limit|quota/iu.test(stderr)) return finish({ status: 'quota', reason: lastLine(stderr) });
      if (code !== 0) return finish({ status: 'failed', reason: `exit ${code}: ${lastLine(stderr)}` });
      let raw;
      try {
        raw = JSON.parse(reviewer.builtIn === 'codex' ? readFileSync(out, 'utf8') : stdout);
      } catch {
        return finish({ status: 'failed', reason: 'the reviewer did not print JSON' });
      }
      const clean = cleanOutput(raw);
      finish(clean.valid ? { status: 'done', findings: clean.findings, verdicts: clean.verdicts, dropped: clean.dropped } : { status: 'failed', reason: clean.dropped[0] });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(stdinText);
    let settled = false;
    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      done(result);
    }
  });
}
