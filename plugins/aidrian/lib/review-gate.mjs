// The review gate (config.json `github.reviewGate`): the review bot is asked to review a pull request only once one
// review by an agent that did not write the change is on record for it. docs/config.md#review-gate describes it.
//
// The record is written once per pull request, by `aidrian pr attest`, to the state folder, which every worktree of the
// repository shares. A request comment may carry the marker that command prints instead: the local record dies with
// its machine, the marker stays on GitHub. Both are the author's word that the review happened; the gate forces the
// step, it cannot check the reading.
//
// Requests are seen in three places, each reading only its own path, all deciding here: `aidrian pr await-review
// --request` itself (lib/pr-await-review.mjs), the Bash rule for gh (lib/rules/github/review-request.mjs), and the hook
// on the GitHub MCP comment tools (scripts/hook-mcp-github.mjs).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { runGit } from './git.mjs';
import { unfencedLines } from './markdown-sections.mjs';
import { normalizeRemote, stateDir } from './project.mjs';

export const OVERRIDE = 'AIDRIAN_ALLOW_UNREVIEWED_REQUEST';

// Both review triggers the Codex bot documents.
const REQUEST = /@codex (?:security )?review\b/iu;
const MARKER = /<!--\s*aidrian-review:\s*pr=(\d+)\s+repo=([^\s/]+\/[^\s/]+)\s+head=[0-9a-f]{7,40}\b[^>]*-->/giu;
const SHA = /^[0-9a-f]{7,40}$/iu;

// Whether a text asks the bot for a review: the trigger anywhere outside a code fence, an inline code span, or a `>`
// quote. Wider than "opens a line" on purpose: for a gate, the safe error is a review that was not strictly needed.
export function asksForReview(text) {
  if (typeof text !== 'string') return false;
  return [...unfencedLines(text)].filter((line) => !/^\s*>/u.test(line)).some((line) => REQUEST.test(line.replace(/`[^`]*`/gu, '')));
}

// The marker names its repository and pull request: a number is unique only within one repository.
export const markerFor = ({ pr, repo, head, reviewer, findings, fixed }) =>
  `<!-- aidrian-review: pr=${pr} repo=${repo} head=${head} reviewer=${reviewer} findings=${findings} fixed=${fixed} -->`;

export const markersIn = (text) =>
  (typeof text === 'string' ? [...text.matchAll(MARKER)].map((match) => ({ pr: Number(match[1]), repo: match[2].toLowerCase() })) : []);

// `owner/name`, lower-cased, from any spelling gh takes: `[HOST/]OWNER/REPO`, a URL, a `.git` suffix; or null.
export function repoName(value) {
  if (typeof value !== 'string') return null;
  const parts = normalizeRemote(value.replace(/\/(?:pull|issues)\/.*$/u, '')).toLowerCase().split('/').filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join('/') : null;
}

// A pull request number from `123`, `#123`, or a `…/pull/123` or `…/issues/123` URL (gh issue comment takes one, and a
// pull request is also an issue); null otherwise.
export function prNumber(value) {
  if (typeof value !== 'string') return null;
  const match = /\/(?:pull|issues)\/(\d+)/u.exec(value) ?? /^#?(\d+)$/u.exec(value);
  return match ? Number(match[1]) : null;
}

const recordFile = (project, pr) => path.join(stateDir(project), 'reviews', `pr-${pr}.json`);

// The record for a pull request, or null when there is none or it is not a well-formed one for it: corrupt local state
// never passes the gate. A review names its head and reviewer; an override is marked as one.
export function readRecord(project, pr) {
  let record;
  try {
    record = JSON.parse(readFileSync(recordFile(project, pr), 'utf8'));
  } catch {
    return null;
  }
  if (record?.pr !== pr) return null;
  const review = typeof record.head === 'string' && SHA.test(record.head) && typeof record.reviewer === 'string' && record.reviewer !== '';
  const override = record.reviewer === 'override' && record.head === null;
  return review || override ? record : null;
}

export function writeRecord(project, record) {
  const file = recordFile(project, record.pr);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...record, recordedAt: new Date().toISOString() }, null, 2)}\n`);
}

// This repository's `owner/name`, from its origin, or null.
export function originRepo(project) {
  const { status, stdout } = runGit(['config', '--get', 'remote.origin.url'], project.root);
  return status === 0 ? repoName(stdout) : null;
}

// The deny reason for the requests in one tool call, each { pr, repo, markers }, or null. `pr` null is a request whose
// pull request could not be read; `repo` null is this repository. A request to another repository passes. The override
// records itself for the pull request, so a person who waived the review once is not asked again.
export function judgeRequests(requests, { project, config, env = process.env, origin = originRepo(project) }) {
  const gate = config.github.reviewGate;
  if (!gate.enabled || requests.length === 0) return null;
  const ours = requests.filter((request) => request.repo === null || origin === null || repoName(request.repo) === origin);
  if (env[OVERRIDE] === '1') {
    for (const { pr } of ours) {
      if (pr !== null && !readRecord(project, pr)) writeRecord(project, { pr, repo: origin, head: null, reviewer: 'override', findings: 0, fixed: 0, note: OVERRIDE });
    }
    return null;
  }
  const attested = (request) => {
    const target = repoName(request.repo) ?? origin;
    return (request.markers ?? []).some((marker) => marker.pr === request.pr && target !== null && marker.repo === target);
  };
  const missing = ours.find((request) => request.pr === null || (!attested(request) && !readRecord(project, request.pr)));
  return missing ? denyReason(missing.pr, gate.checklist) : null;
}

export function denyReason(pr, checklist) {
  return [
    pr === null
      ? 'Blocked: this asks the review bot for a review, but the pull request number could not be read from the call. Name the pull request.'
      : `Blocked: this asks the review bot to review pull request #${pr}, and no review of its diff by an agent that did not write it is on record.`,
    `First, one reviewer that did not write the change reads the whole diff${checklist ? ` against ${checklist}` : ''}`,
    '(dispatch it as a read-only subagent, such as the code-reviewer agent); fix what it finds.',
    `Then record it: aidrian pr attest ${pr ?? '<PR>'} --head <sha> --reviewer <who> --findings <n> --fixed <n>.`,
    '`aidrian pr await-review --request` then puts the marker in its request by itself; only a request posted by hand needs the',
    'marker line attest prints. Never post both: that is two requests.',
    `To override for an explicit, user-confirmed reason, set ${OVERRIDE}=1 in your own shell before starting the session ` +
      "(agents must never set it on the user's behalf).",
  ].join(' ');
}

// `aidrian pr attest <PR> --head <sha> --reviewer <who> --findings <n> --fixed <n> [--note <text>]`, or `--check`.
// Exit 0 recorded, 3 not recorded (--check), 1 a usage error.
export async function runAttest(args, project, config = null) {
  const [ref, ...rest] = args;
  const pr = prNumber(ref);
  if (pr === null) throw new Error('attest needs a pull request number');
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === '--check') flags.check = true;
    else if (['--head', '--reviewer', '--findings', '--fixed', '--note', '--pass', '--accepted', '--verdicts'].includes(flag)) {
      const value = rest[++i];
      if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`${flag} needs a value`);
      flags[flag.slice(2)] = value;
    } else throw new Error(`unknown argument: ${flag}`);
  }
  if (flags.check) {
    const found = readRecord(project, pr) !== null;
    console.log(`${found ? 'recorded' : 'not recorded'}: pull request #${pr}`);
    return found ? 0 : 3;
  }
  for (const key of ['head', 'reviewer', 'findings', 'fixed']) if (flags[key] === undefined) throw new Error(`--${key} is required`);
  const [findings, fixed] = [flags.findings, flags.fixed].map((value, i) => {
    if (!/^\d+$/u.test(value)) throw new Error(`--${i ? 'fixed' : 'findings'} must be a whole number`);
    return Number(value);
  });
  if (fixed > findings) throw new Error('--fixed cannot exceed --findings');
  const accepted = flags.accepted === undefined ? 0 : /^\d+$/u.test(flags.accepted) ? Number(flags.accepted) : NaN;
  if (Number.isNaN(accepted)) throw new Error('--accepted must be a whole number');
  if (flags.pass === undefined && (flags.accepted !== undefined || flags.verdicts !== undefined)) throw new Error('--accepted and --verdicts need --pass');
  if (!SHA.test(flags.head) || runGit(['cat-file', '-e', `${flags.head}^{commit}`], project.root).status !== 0) {
    throw new Error(`--head ${flags.head} is not a commit in this repository`);
  }
  const repo = originRepo(project);
  if (repo === null) throw new Error("cannot read this repository's origin; the marker must name it");
  if (flags.pass !== undefined) {
    const { recordPass, remoteState } = await import('./review/run.mjs');
    const verdictsText = flags.verdicts === undefined ? null : readFileSync(flags.verdicts, 'utf8');
    const result = recordPass(project, { pr, repo, pass: flags.pass, head: flags.head, reviewer: flags.reviewer, findings, fixed, accepted, verdictsText, remote: remoteState(repo, pr, undefined, config) });
    console.log(`recorded pass ${flags.pass} of pull request #${pr} at ${flags.head.slice(0, 7)}: ${result.open} open`);
    console.log('Run `aidrian pr review` again for the next step.');
    return 0;
  }
  const record = { pr, repo, head: flags.head, reviewer: flags.reviewer, findings, fixed, note: flags.note ?? null };
  writeRecord(project, record);
  console.log(`recorded the review of pull request #${pr} at ${flags.head.slice(0, 7)}`);
  console.log('`aidrian pr await-review --request` adds this marker by itself; paste it only into a request posted by hand:');
  console.log(markerFor(record));
  return 0;
}

// The marker of the recorded review for `pr` in `repo` (null for this repository), for the one request await-review
// posts; null when there is no real review on record, or `repo` is another repository.
export function attestation(project, pr, repo = null, origin = originRepo(project)) {
  if (repo !== null && (origin === null || repoName(repo) !== origin)) return null;
  const record = readRecord(project, pr);
  return record?.head && record?.repo ? markerFor(record) : null;
}

// `aidrian pr signoff <PR> --flow <id> --head <sha>`: the Human's sign-off of a critical flow on one head. It is an audit
// entry, not proof: an agent holds the same shell. The review summary on the pull request shows every sign-off.
export async function runSignoff(args, project, config = null) {
  const [ref, ...rest] = args;
  const pr = prNumber(ref);
  if (pr === null) throw new Error('signoff needs a pull request number');
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (!['--flow', '--head'].includes(flag)) throw new Error(`unknown argument: ${flag}`);
    const value = rest[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    flags[flag.slice(2)] = value;
  }
  if (!flags.flow || !flags.head) throw new Error('--flow and --head are required');
  if (!SHA.test(flags.head) || runGit(['cat-file', '-e', `${flags.head}^{commit}`], project.root).status !== 0) throw new Error(`--head ${flags.head} is not a commit in this repository`);
  const repo = originRepo(project);
  const by = runGit(['config', 'user.name'], project.root).stdout.trim() || 'unknown';
  const { recordSignoff, remoteState } = await import('./review/run.mjs');
  recordSignoff(project, { pr, repo, flow: flags.flow, head: flags.head, by, remote: remoteState(repo, pr, undefined, config) });
  console.log(`recorded ${by}'s sign-off of flow ${flags.flow} on ${flags.head.slice(0, 7)}. Run \`aidrian pr review\` again.`);
  return 0;
}
