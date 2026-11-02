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
  required: ['findings', 'verdicts', 'contracts', 'cross_notes'],
  properties: {
    // A slice's report to the cross-cutting pass: the contracts it changed, and what it saw about other slices.
    contracts: { type: 'array', items: { type: 'string' } },
    cross_notes: { type: 'array', items: { type: 'string' } },
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

// The engine this machine reviews with: config.json `review.engine` when the project sets it, which is policy and wins,
// else the local file's. { reviewer, reason } or { problem }. `auto` takes codex-local, else the review bot, else self,
// and says which and why; a project's engine says it came from the project config.
export function resolveEngine(config, { codex = codexAvailable } = {}) {
  const map = reviewerMap(config);
  const project = config.review?.engine ?? null;
  const wanted = project ?? config.reviewEngine ?? 'auto';
  const key = project ? 'config.json review.engine' : 'review.engine';
  const said = (reason) => (project ? `${reason} (set by the project config)` : reason);
  const botOn = config.github.reviewer !== null;
  if (wanted === 'auto') {
    const ready = codex();
    if (ready.ok) return { reviewer: map['codex-local'], reason: said('auto: codex is installed and logged in') };
    if (botOn) return { reviewer: map['pr-bot'], reason: said(`auto: ${ready.reason}, so the review bot`) };
    return { reviewer: map.self, reason: said(`auto: ${ready.reason} and no review bot, so self`) };
  }
  if (!Object.hasOwn(map, wanted)) return { problem: `${key} "${wanted}" is not a built-in engine or a reviewer of review.reviewers` };
  if (map[wanted].pending) return { problem: `${key} "${wanted}" is a reviewer this pull request adds: it runs once it is on the base branch` };
  if (wanted === 'pr-bot' && !botOn) return { problem: `${key} is "pr-bot", but config.json github.reviewer is none` };
  if (wanted === 'codex-local') {
    const ready = codex();
    if (!ready.ok) return { problem: `${key} is "codex-local", but ${ready.reason}` };
  }
  return { reviewer: map[wanted], reason: said(`review.engine: ${wanted}`) };
}

// Whether `reviewers` (the names of the passes a plan will run) meet a `require` word. `independent-model` needs a
// reviewer that is not the author's model; `agent:<name>` needs that agent.
export function satisfies(word, passes, map) {
  if (word === 'independent-model') return passes.some((pass) => map[pass.reviewer]?.independent);
  if (word.startsWith('agent:')) {
    const name = word.slice('agent:'.length);
    return passes.some((pass) => pass.kind === 'agent' && (pass.reviewer === name || map[pass.reviewer]?.agent === name));
  }
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
  const strings = (list) => (Array.isArray(list) ? list.filter((each) => typeof each === 'string').slice(0, 50) : []);
  return { findings, verdicts, contracts: strings(raw.contracts), cross_notes: strings(raw.cross_notes), dropped, valid: true };
}

// What a flow verdict means, whatever the wording of the invariant's question: a reviewer must not map yes or no to a
// verdict, because a question phrased so that yes is the breach would invert holds and violated.
export const VERDICT_MEANING = 'A verdict says whether the change keeps the rule, not how the question is worded: holds means the change keeps the rule (its `source`, or the invariant), violated means the change breaks it, whichever answer, yes or no, the question would take.';

// How a pass that reviews only the change since an earlier head judges its flows: from the merge base.
export const flowBaseBrief = (input) => `Find bugs in ${input.base}..${input.head}, but judge every flow invariant on the whole change, \`git diff ${input.flowBase} ${input.head}\`: an invariant compares the head with the base branch, so a change an earlier push of this pull request made counts as much as a new one, and narrowing something this pull request itself added weakens nothing the base had.`;

// The prompt a model reviewer reads: the pass input as instructions and data. The input is JSON, so a diff cannot
// close the instructions.
export function reviewPrompt(input) {
  return [
    'You are reviewing a pull request. You did not write it. Read-only: change nothing.',
    `Review the diff from ${input.base} to ${input.head} (run \`git diff ${input.base} ${input.head}\`; read any file at ${input.head} you need).`,
    input.role === 'slice'
      ? `This is one slice of a large change. Review the diff of these files only: ${input.files.join(', ')} (\`git diff ${input.base} ${input.head} -- <file>\`); \`manifest\` lists every changed file, and you may read any file at ${input.head}. Report findings only in your files. In \`contracts\`, list every exported or behavioural contract your files change (signatures, types, schemas, routes, events, config); in \`cross_notes\`, anything you saw that other changed files must agree with.`
      : input.role === 'cross'
        ? 'This is the cross-cutting pass of a review split into slices. `slices` holds each slice\'s contracts, notes, and findings. Report only bugs that cross slices: a changed contract a caller in another slice does not follow, a schema and its users disagreeing, an assumption one slice makes that another breaks. Do not repeat a slice\'s findings.'
        : input.files ? `Report findings only in these files: ${input.files.join(', ')}.` : 'Report findings in any changed file.',
    'Look for correctness bugs, regressions, edge cases, security, data consistency, error handling, and missing tests.',
    'When you find a mistake, search the whole change for every copy and list each in that finding. Finish the whole review before answering.',
    input.checklist ? `Also review the change against the project's checklist (${input.checklist.path}), included in the input.` : '',
    input.flows.length ? `For each critical flow below, give one verdict per invariant: holds, violated, not_affected, or cannot_verify. Evidence for holds or not_affected must cite file:line at the head commit, or a test name. Earlier reviewers' verdicts are listed: challenge every "holds" you cannot confirm yourself. Where an invariant has a \`source\`, the section of the project doc it cites, judge against that source: \`text\` is only the question. ${VERDICT_MEANING}` : '',
    input.flowBase ? flowBaseBrief(input) : '',
    'Answer with JSON only, in the schema you were given.',
    '',
    'Input (JSON):',
    JSON.stringify(input, null, 2),
  ].filter((line) => line !== '').join('\n');
}

const lastLine = (text) => text.trim().split('\n').filter(Boolean).at(-1) ?? '';

// Runs one exec reviewer on one pass: resolves to { status: 'done', findings, verdicts, dropped } or
// { status: 'failed' | 'quota' | 'timed_out', reason }. `env` must already be clean (run.mjs isolates it).
export async function runExec(reviewer, input, { root, env, spawnImpl = spawn }) {
  const timeoutSec = reviewer.timeoutSec ?? 600;
  const result = reviewer.builtIn === 'codex'
    ? await runCodex({ root, env, schema: FINDINGS_SCHEMA, prompt: reviewPrompt(input), timeoutSec, spawnImpl })
    : await runDetached({ argv: reviewer.command, stdinText: JSON.stringify(input), root, env, timeoutSec, spawnImpl, output: (stdout) => stdout });
  if (result.status !== 'done') return result;
  const clean = cleanOutput(result.raw);
  return clean.valid ? { status: 'done', findings: clean.findings, verdicts: clean.verdicts, contracts: clean.contracts, cross_notes: clean.cross_notes, dropped: clean.dropped } : { status: 'failed', reason: clean.dropped[0] };
}

// Runs Codex once, read-only, held to `schema` (--output-schema), with `prompt` on stdin: resolves to
// { status: 'done', raw }, the JSON Codex wrote, or { status: 'failed' | 'quota' | 'timed_out', reason }.
// It owns a temporary folder for the schema and the answer, and removes it. `env` must already be clean (env.mjs isolate),
// so a git hook's GIT_DIR cannot point Codex's git calls at another repository.
export async function runCodex({ root, env, schema, prompt, timeoutSec = 600, spawnImpl = spawn }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-review-'));
  try {
    const out = path.join(dir, 'out.json');
    const schemaFile = path.join(dir, 'schema.json');
    writeFileSync(schemaFile, JSON.stringify(schema));
    const argv = ['codex', 'exec', '--sandbox', 'read-only', '--ephemeral', '--cd', root, '--output-schema', schemaFile, '-o', out, '-'];
    return await runDetached({ argv, stdinText: prompt, root, env, timeoutSec, spawnImpl, output: () => readFileSync(out, 'utf8') });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Runs `argv` in its own process group with `stdinText` on stdin, and parses `output(stdout)` as JSON: resolves to
// { status: 'done', raw } or { status: 'failed' | 'quota' | 'timed_out', reason }.
function runDetached({ argv, stdinText, root, env, timeoutSec, spawnImpl, output }) {
  return new Promise((done) => {
    // Its own process group, so a timeout stops the reviewer and everything it started.
    const child = spawnImpl(argv[0], argv.slice(1), { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const limit = timeoutSec * 1000;
    const kill = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };
    // SIGTERM at the limit; SIGKILL 5 s later; and an answer 2 s after that even if a grandchild still holds the pipes.
    const timer = setTimeout(() => {
      timedOut = true;
      kill('SIGTERM');
      setTimeout(() => kill('SIGKILL'), 5000).unref?.();
      setTimeout(() => {
        // A grandchild in another process group can outlive the kill and hold the pipes: let go of them, so the
        // command can still exit.
        for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
        child.unref();
        finish({ status: 'timed_out', reason: `no answer in ${limit / 1000} s` });
      }, 7000).unref?.();
    }, limit);
    child.on('error', (error) => finish({ status: 'failed', reason: error.code === 'ENOENT' ? `${argv[0]} is not installed` : error.message }));
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => {
      if (timedOut) return finish({ status: 'timed_out', reason: `no answer in ${limit / 1000} s` });
      // Only a failed run can be a quota stop: a successful one logs its whole session to stderr, words included.
      if (code !== 0 && /usage limit|rate limit|quota/iu.test(stderr)) return finish({ status: 'quota', reason: lastLine(stderr) });
      if (code !== 0) return finish({ status: 'failed', reason: `exit ${code}: ${lastLine(stderr)}` });
      try {
        return finish({ status: 'done', raw: JSON.parse(output(stdout)) });
      } catch {
        return finish({ status: 'failed', reason: 'the reviewer did not print JSON' });
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(stdinText);
    let settled = false;
    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(result);
    }
  });
}
