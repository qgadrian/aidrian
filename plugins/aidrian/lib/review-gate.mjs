// The review gate (config.json `github.reviewGate`): the review bot is asked to review a pull request only once one
// review by an agent that did not write the change is on record for it. docs/config.md#review-gate describes it.
//
// The record is written once per pull request, by `aidrian pr attest`, to the state folder, which every worktree of the
// repository shares. A full-diff agent pass that `aidrian pr review` recorded (`aidrian pr attest --pass agent:<name>`)
// counts as that record too (gateReview); a pass over a flow's or a slice's files alone does not. A request comment may carry the marker that command prints instead: the local record dies with
// its machine, the marker stays on GitHub. Both are the author's word that the review happened; the gate forces the
// step, it cannot check the reading.
//
// Requests are seen in three places, each reading only its own path, all deciding here: `aidrian pr await-review
// --request` itself (lib/pr-await-review.mjs), the Bash rule for gh (lib/rules/github/review-request.mjs), and the hook
// on the GitHub MCP comment tools (scripts/hook-mcp-github.mjs).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { forgeFor, isTrustedCommenter } from './forges/index.mjs';
import { runGit } from './git.mjs';
import { unfencedLines } from './markdown-sections.mjs';
import { recordsFolder, stateDir } from './project.mjs';
import { givenRepo, originRepo, remoteRepos, repoName } from './remotes.mjs';
import { HUMAN } from './review/quota.mjs';
import { heldMessage, otherRecordMessage, otherRecordRepo, readLocalState, readRecord as readReviewRecord, sameCommit, SUMMARY_MARKER } from './review/state.mjs';
import { FINDING_MARKER } from './review/inline.mjs';

// The markers that start a post the engine itself makes: a finding's (lib/review/inline.mjs), the review summary's, and
// the product feedback comment's. Such a post is never outside evidence, whoever's login posted it.
const ENGINE_MARKERS = [`<!-- ${FINDING_MARKER}:`, SUMMARY_MARKER, '<!-- aidrian-product-feedback:'];
export const engineMarked = (body) => typeof body === 'string' && ENGINE_MARKERS.some((marker) => body.trimStart().startsWith(marker));

// Re-exported for the callers that read them here.
export { originRepo, remoteRepos, repoName };

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

// A pull request number from `123`, `#123`, or a `…/pull/123` or `…/issues/123` URL (gh issue comment takes one, and a
// pull request is also an issue); null otherwise.
export function prNumber(value) {
  if (typeof value !== 'string') return null;
  const match = /\/(?:pull|issues)\/(\d+)/u.exec(value) ?? /^#?(\d+)$/u.exec(value);
  return match ? Number(match[1]) : null;
}

const recordFile = (project, pr) => path.join(recordsFolder(stateDir(project)), `pr-${pr}.json`);

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

// A pass of one agent, as the review plan names it (lib/review/plan.mjs): `agent:<name>`, or `agent:<name>:<flow>+<flow>`
// when the agent's flows merged into it. It reviewed the whole diff when its recorded `files` is null; a merged pass
// limited to its flows' files, and a slice (`agent:<name>.<n>`, which always lists files), did not. A flow pass
// (`flow:<id>:<agent>`), the cross pass, and an engine pass are never one.
const AGENT_PASS = /^agent:[\w-]+(?::\S+)?$/u;

// The review the gate counts for pull request `pr`, or null: the plain record `aidrian pr attest` writes, else an agent
// pass over the whole diff in the review step's record (AGENT_PASS with no files), as { pr, repo, head, reviewer, findings, fixed }. The pass
// is the reviewer's word, as the plain record is, and like it names a commit attest checked when it recorded it.
export function gateReview(project, pr) {
  const record = readRecord(project, pr);
  if (record) return record;
  const state = readLocalState(project, pr);
  for (const [id, pass] of Object.entries(state?.passes ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (!AGENT_PASS.test(id) || pass?.files !== null || typeof pass?.head !== 'string' || !SHA.test(pass.head)) continue;
    if (typeof pass.reviewer !== 'string' || pass.reviewer === '' || !Number.isInteger(pass.findings)) continue;
    const open = Number.isInteger(pass.open) ? pass.open : 0;
    return { pr, repo: typeof state.repo === 'string' ? state.repo : null, head: pass.head, reviewer: pass.reviewer, findings: pass.findings, fixed: Math.max(0, pass.findings - open), pass: id };
  }
  return null;
}

export function writeRecord(project, record) {
  const file = recordFile(project, record.pr);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...record, recordedAt: new Date().toISOString() }, null, 2)}\n`);
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
      if (pr !== null && !gateReview(project, pr)) writeRecord(project, { pr, repo: origin, head: null, reviewer: 'override', findings: 0, fixed: 0, note: OVERRIDE });
    }
    return null;
  }
  const attested = (request) => {
    const target = repoName(request.repo) ?? origin;
    return (request.markers ?? []).some((marker) => marker.pr === request.pr && target !== null && marker.repo === target);
  };
  const missing = ours.find((request) => request.pr === null || (!attested(request) && !gateReview(project, request.pr)));
  return missing ? denyReason(missing.pr, gate.checklist) : null;
}

export function denyReason(pr, checklist) {
  return [
    pr === null
      ? 'Blocked: this asks the review bot for a review, but the pull request number could not be read from the call. Name the pull request.'
      : `Blocked: this asks the review bot to review pull request #${pr}, and no review of its diff by an agent that did not write it is on record.`,
    `First, one reviewer that did not write the change reads the whole diff${checklist ? ` against ${checklist}` : ''}`,
    '(dispatch it as a read-only subagent, such as the code-reviewer agent); fix what it finds.',
    `Then record it: aidrian pr attest ${pr ?? '<PR>'} --head <sha> --reviewer <who> --findings <n> --fixed <n>, or, inside \`aidrian pr review\`,`,
    `the full-diff agent pass it dispatched: aidrian pr attest ${pr ?? '<PR>'} --pass agent:<name> --head <sha> --reviewer <who> --findings <n> --fixed <n>.`,
    'A pass over a flow\'s or a slice\'s files alone does not count.',
    '`aidrian pr await-review --request` then puts the marker in its request by itself; only a request posted by hand needs the',
    'marker line attest prints. Never post both: that is two requests.',
    `To override for an explicit, user-confirmed reason, set ${OVERRIDE}=1 in your own shell before starting the session ` +
      "(agents must never set it on the user's behalf).",
  ].join(' ');
}

// The repository of pull request `pr`, as `owner/name`: `--repo` (`given`), else the one `gh pr view` names, gh's
// default repository, which in a fork checkout is the upstream, else origin, so it works offline. `forge` reads the pull
// request; it is the test seam.
export function prRepo(project, pr, given, forge = forgeFor(project.root)) {
  if (given !== undefined && given !== null) return givenRepo(given);
  let url = null;
  try {
    url = forge.change(pr, 'url')?.url ?? null;
  } catch {}
  const name = repoName(url) ?? originRepo(project);
  if (!name) throw new Error("cannot read this repository's origin; the marker must name it: pass --repo OWNER/NAME");
  return name;
}

// The base branch the forge names for `pr`, or null when it cannot answer.
function namedBase(project, pr, repo, forge) {
  try {
    return (forge ?? forgeFor(project.root)).change(pr, 'baseRefName', { repo })?.baseRefName ?? null;
  } catch {
    return null;
  }
}

// Holds the working copy's state.dir to `base` before a command reads the review record (lib/review/in-force.mjs), and
// returns the config whose `review.record` applies: the one `base` commits. With no base, from a forge that cannot answer,
// the record stays local, whatever the working copy says: the command reads no comment, keeps this machine's record, and
// publishes nothing.
async function holdToNamedBase(project, config, repo, base) {
  if (!base) return { ...config, review: { ...config?.review, record: 'local' } };
  const { holdToBase } = await import('./review/in-force.mjs');
  return holdToBase(project, config, { repo, base }).committed;
}

// `aidrian pr attest <PR> --head <sha> --reviewer <who> --findings <n> --fixed <n> [--note <text>] [--repo OWNER/NAME]`, or `--check`.
// With --pass, `--findings-file <file>` replaces the counts with the findings one by one (lib/review/findings.mjs), and
// `--verdicts FILE|-` records the pass's verdicts: `-` reads them from stdin, so an agent's final JSON is piped as it is.
// Exit 0 recorded, 3 not recorded (--check), 1 a usage error.
export async function runAttest(args, project, config = null, { forge } = {}) {
  const [ref, ...rest] = args;
  const pr = prNumber(ref);
  if (pr === null) throw new Error('attest needs a pull request number');
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === '--check') flags.check = true;
    else if (['--head', '--reviewer', '--findings', '--fixed', '--note', '--pass', '--accepted', '--verdicts', '--findings-file', '--repo'].includes(flag)) {
      const value = rest[++i];
      if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`${flag} needs a value`);
      flags[flag.slice(2)] = value;
    } else throw new Error(`unknown argument: ${flag}`);
  }
  if (flags.check) {
    const found = gateReview(project, pr) !== null;
    console.log(`${found ? 'recorded' : 'not recorded'}: pull request #${pr}`);
    return found ? 0 : 3;
  }
  if (flags['findings-file'] !== undefined) {
    if (flags.pass === undefined) throw new Error('--findings-file needs --pass');
    if (flags['findings-file'] === '-') throw new Error('--findings-file - is not supported: stdin is read once, by --verdicts -; write the findings to a file');
    if (['findings', 'fixed', 'accepted'].some((key) => flags[key] !== undefined)) throw new Error('--findings-file replaces --findings, --fixed, and --accepted: pass one or the other');
    Object.assign(flags, { findings: '0', fixed: '0' });
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
  const repo = prRepo(project, pr, flags.repo, forge);
  const held = await holdToNamedBase(project, config, repo, namedBase(project, pr, repo, forge));
  if (flags.pass !== undefined) {
    const { recordPass, remoteState } = await import('./review/run.mjs');
    const verdictsText = flags.verdicts === undefined ? null : readFileSync(flags.verdicts === '-' ? 0 : flags.verdicts, 'utf8');
    const findingsText = flags['findings-file'] === undefined ? null : readFileSync(flags['findings-file'], 'utf8');
    const result = recordPass(project, { pr, repo, pass: flags.pass, head: flags.head, reviewer: flags.reviewer, findings, fixed, accepted, verdictsText, findingsText, remote: remoteState(repo, pr, undefined, held) });
    console.log(`recorded pass ${flags.pass} of pull request #${pr} at ${flags.head.slice(0, 7)}: ${result.open} open`);
    // A verdict with evidence the review cannot check leaves its invariant unverified: say so while the reviewer can still fix it.
    const { citationProblem } = await import('./review/flows.mjs');
    for (const verdict of result.verdicts) {
      if (!['holds', 'not_affected'].includes(verdict.verdict) || verdict.evidence.trim().startsWith('capture:')) continue;
      const problem = citationProblem(verdict.evidence, { root: project.root, head: flags.head });
      if (problem) console.log(`warning: the ${verdict.verdict} verdict on ${verdict.flow}/${verdict.invariant} counts as cannot_verify: ${problem}. Dispatch the reviewer again to cite path:line, test:<name>, or capture:<key>.`);
    }
    console.log('Run `aidrian pr review` again for the next step.');
    return 0;
  }
  const record = { pr, repo, head: flags.head, reviewer: flags.reviewer, findings, fixed, note: flags.note ?? null };
  writeRecord(project, record);
  // The gate review recorded as dispatched (`aidrian pr request --kind review`) is no longer owed.
  (await import('./review/pending.mjs')).answerOwed(project, pr, 'review', { head: flags.head, by: 'attest', repo });
  console.log(`recorded the review of pull request #${pr} at ${flags.head.slice(0, 7)}`);
  console.log('`aidrian pr await-review --request` adds this marker by itself; paste it only into a request posted by hand:');
  console.log(markerFor(record));
  return 0;
}

// The marker of the recorded review for `pr` in `repo` (null for this repository), for the one request await-review
// posts; null when there is no real review on record, or `repo` is another repository.
export function attestation(project, pr, repo = null, origin = originRepo(project)) {
  if (repo !== null && (origin === null || repoName(repo) !== origin)) return null;
  const record = gateReview(project, pr);
  return record?.head && record?.repo ? markerFor(record) : null;
}

// The one flow `aidrian pr signoff <PR> --last` signs off, from the review record `state` and the pull request's current
// `head`: { flow, head }, with the head the last review ran on, as recorded. It serves one stop only: the last review
// on that head stopped at human_required for a flow (`outcome`), and the Human took over no stage there (`quotaStops`
// with the Human's choice, a stage sign-off --last never records). A flow is pending when the last review left it to
// the Human (`signoffable`) and no sign-off on that head holds it. The record keeps no order among flows, so two
// pending flows are refused, each listed with its long command, and so is a flow that still owes an overrule or an
// accept, which --last never records. A violated invariant no reviewer disputes is no refusal: the long form
// records that sign-off too, and it counts for nothing until the fix lands.
export function lastSignoff(state, { pr, repo, head }) {
  const asked = state?.signoffable;
  if (!asked || typeof asked.head !== 'string') throw new Error(`no review of ${repo}#${pr} ran: run \`aidrian pr review ${pr}\` first, then sign off`);
  const h7 = asked.head.slice(0, 7);
  if (!sameCommit(asked.head, head)) throw new Error(`the last review of ${repo}#${pr} ran on ${h7}, and the pull request is at ${head.slice(0, 7)}: run \`aidrian pr review ${pr}\` on ${head.slice(0, 7)} first, then sign off`);
  const outcome = state.outcome;
  if (outcome?.status !== 'human_required' || !sameCommit(outcome.head, asked.head)) {
    const status = typeof outcome?.status !== 'string' ? null : sameCommit(outcome.head, asked.head) ? outcome.status : `${outcome.status} on ${String(outcome.head).slice(0, 7)}`;
    throw new Error(`the last review of ${repo}#${pr} on ${h7} ${status ? `stopped at ${status}` : 'recorded no stop'}, not at a flow's human_required: run \`aidrian pr review ${pr}\` for the next step`);
  }
  const pending = (Array.isArray(asked.flows) ? asked.flows : []).filter((flow) => !sameCommit(state.signoffs?.[flow]?.head, asked.head));
  // A head where the Human took over a stage is never --last's, signed or not: an unsigned stage is signed with
  // --stage, and once it is, each flow still waiting takes its long command.
  const takeovers = (Array.isArray(state.quotaStops) ? state.quotaStops : []).filter((stop) => sameCommit(stop?.head, asked.head) && stop?.choice === HUMAN);
  if (takeovers.length) {
    const stagesOf = (stops) => [...new Set(stops.map((stop) => stop.stage))];
    const unsigned = stagesOf(takeovers.filter((stop) => !stop.signoff));
    if (unsigned.length) {
      const commands = unsigned.map((stage) => `aidrian pr signoff ${pr} --stage ${stage} --head ${asked.head}`).join('; ');
      throw new Error(`the Human took over the ${unsigned.join(', ')} stage of ${repo}#${pr} on ${h7}, which --last never signs off: use the long form, ${commands}, then run \`aidrian pr review ${pr}\``);
    }
    const next = pending.length ? `run ${pending.map((flow) => `aidrian pr signoff ${pr} --flow ${flow} --head ${asked.head}`).join('; ')}` : `run \`aidrian pr review ${pr}\` for the next step`;
    throw new Error(`the Human took over the ${stagesOf(takeovers).join(', ')} stage of ${repo}#${pr} on ${h7}, so --last does not sign off this head: ${next}`);
  }
  if (pending.length === 0) throw new Error(`no flow of ${repo}#${pr} waits for a sign-off on ${h7}: every flow the last review named is signed off there, or none needed one. Run \`aidrian pr review ${pr}\` for the next step`);
  if (pending.length > 1) {
    const commands = pending.map((flow) => `aidrian pr signoff ${pr} --flow ${flow} --head ${asked.head}`).join('; ');
    throw new Error(`${pending.length} flows of ${repo}#${pr} wait for a sign-off on ${h7}: ${pending.join(', ')}. --last signs off one flow only: run one of ${commands}`);
  }
  const [flow] = pending;
  const listOf = (value) => (Array.isArray(value) ? value : []);
  const overruled = (invariant) => listOf(state.overrulings).some((each) => each?.flow === flow && each?.invariant === invariant && sameCommit(each?.head, asked.head));
  const disputed = sameCommit(state.disputes?.head, asked.head) ? listOf(state.disputes.items).filter((each) => each?.flow === flow && !overruled(each.invariant)).map((each) => each.invariant) : [];
  if (disputed.length) throw new Error(`flow ${flow} has a disputed invariant on ${h7} of ${repo}#${pr}: ${disputed.join(', ')}. --last never overrules: the Human settles it first with aidrian pr signoff ${pr} --flow ${flow} --overrule <invariant> --head ${asked.head} --reason "<why>"`);
  const outside = sameCommit(state.outside?.head, asked.head) ? [...listOf(state.outside.approvals), ...listOf(state.outside.acceptances)] : [];
  const closed = (invariant) =>
    listOf(state.acceptances).some((each) => each?.flow === flow && each?.invariant === invariant && sameCommit(each?.head, asked.head)) ||
    outside.some((each) => each?.flow === flow && each?.invariant === invariant);
  const unverified = sameCommit(state.invariants?.head, asked.head)
    ? listOf(state.invariants.items).filter((each) => each?.flow === flow && each?.state === 'unverified' && !closed(each.invariant)).map((each) => each.invariant)
    : [];
  if (unverified.length) throw new Error(`flow ${flow} has an unverified invariant on ${h7} of ${repo}#${pr}: ${unverified.join(', ')}. --last never accepts: run the --accept command the review printed first, aidrian pr signoff ${pr} --flow ${flow} --accept <invariant> --evidence <url> --reason "<what it shows>" --head ${asked.head}`);
  return { flow, head: asked.head };
}

// `aidrian pr signoff <PR> --flow <id> --head <sha>`: the Human's sign-off of a critical flow on one head. It is an audit
// entry, not proof: an agent holds the same shell. The review summary on the pull request shows every sign-off.
// `--stage <name>` in place of `--flow` signs off a review stage the Human chose to review because its reviewer ran out
// of quota on that head (lib/review/quota.mjs). `--flow <id> --overrule <invariant> --reason <text>` settles a dispute
// between reviewers on that head. `--flow <id> --accept <invariant> --evidence <url> --reason <text>` closes, on that
// head, an invariant no reviewer could verify, on evidence outside the tool: a comment, review, or review comment of
// the pull request that the forge finds by its id.
// `--last`, alone or with `--repo` and `--check`, is the short form: it signs off the one flow the last review left
// waiting, on the head that review ran on, exactly as `--flow <id> --head <sha>` would (lastSignoff).
// `--check` runs every refusal of the same command and records nothing: it prints `ok` and returns 0, or throws the
// refusal, which `aidrian pr` prints before it exits 1. The review-signoff rule lets an agent run it, so a session can
// try a command before it hands it to the Human.
export async function runSignoff(args, project, config = null, { forge, by: ruledBy = null } = {}) {
  const [ref, ...rest] = args;
  const pr = prNumber(ref);
  if (pr === null) throw new Error('signoff needs a pull request number');
  const flags = {};
  let dryRun = false;
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === '--check') {
      dryRun = true;
      continue;
    }
    if (flag === '--last') {
      flags.last = true;
      continue;
    }
    if (!['--flow', '--stage', '--head', '--repo', '--overrule', '--accept', '--evidence', '--reason'].includes(flag)) throw new Error(`unknown argument: ${flag}`);
    const value = rest[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    flags[flag.slice(2)] = value;
  }
  if (flags.last) {
    const given = ['flow', 'stage', 'head', 'overrule', 'accept', 'evidence', 'reason'].filter((key) => flags[key] !== undefined);
    if (given.length) throw new Error(`--last takes no ${given.map((key) => `--${key}`).join(', ')}: it signs off the one flow the last review left waiting, on the head that review ran on. Give --last alone, or the long form with --flow and --head`);
  } else {
    if (!flags.head || Boolean(flags.flow) === Boolean(flags.stage)) throw new Error('--head and one of --flow or --stage are required');
    // The --last head comes from the record the review step wrote, so only a typed head must be a local commit.
    if (!SHA.test(flags.head) || runGit(['cat-file', '-e', `${flags.head}^{commit}`], project.root).status !== 0) throw new Error(`--head ${flags.head} is not a commit in this repository`);
  }
  const repo = prRepo(project, pr, flags.repo, forge);
  const by = ruledBy ?? (runGit(['config', 'user.name'], project.root).stdout.trim() || 'unknown');
  if (flags.overrule && flags.accept) throw new Error('--overrule and --accept are two rulings: give one');
  if (flags.evidence && !flags.accept) throw new Error('--evidence goes with --accept');
  if (flags.accept && !(flags.flow && flags.evidence && flags.reason)) throw new Error('--accept needs --flow, --evidence, and --reason');
  if (!flags.accept && (flags.overrule || flags.reason) && !(flags.flow && flags.overrule && flags.reason)) throw new Error('--overrule needs --flow and --reason');
  const { recordAccept, recordOverrule, recordSignoff, recordStageSignoff, remoteState } = await import('./review/run.mjs');
  // A dry run says what the command would record; a real one says it recorded it.
  const done = (recorded, line) => {
    console.log(dryRun ? `ok: the command would record ${recorded}; --check recorded nothing` : line);
    return 0;
  };
  if (flags.last) {
    // --repo steers the sign-off to another pull request's record: --last takes only this checkout's repository, a
    // fork's parent included, so a short command typed on a phone cannot sign off a pull request of another repository.
    const remotes = remoteRepos(project);
    if (remotes.length && !remotes.includes(repo)) throw new Error(`--last signs off a pull request of this checkout's repositories only (${[...new Set(remotes)].join(', ')}), not ${repo}: give the long form, aidrian pr signoff ${pr} --flow <id> --head <sha> --repo ${repo}`);
    const where = forge ?? forgeFor(project.root);
    let view = null;
    try {
      view = where.change(pr, 'headRefOid,baseRefName', { repo });
    } catch {}
    const current = view?.headRefOid ?? null;
    if (typeof current !== 'string' || !SHA.test(current)) throw new Error(`could not read the head of ${repo}#${pr} from the forge: give the long form, aidrian pr signoff ${pr} --flow <id> --head <sha>`);
    const remote = remoteState(repo, pr, forge, await holdToNamedBase(project, config, repo, view.baseRefName));
    const record = readReviewRecord(project, pr, remote ?? [], repo);
    if (record.held !== undefined) throw new Error(heldMessage(pr, record.held, record.why));
    const other = otherRecordRepo(record.state, repo);
    if (other) throw new Error(otherRecordMessage(pr, other, repo, '--last signs off'));
    const { flow, head } = lastSignoff(record.state, { pr, repo, head: current });
    // The choice reads the record once, and recordSignoff reads it again and re-runs the long form's refusals before it
    // writes. A record written between the two reads is checked by those refusals, not by lastSignoff's: deciding and
    // writing on one read belongs with run.mjs, which #124 changes.
    recordSignoff(project, { pr, repo, flow, head, by, remote, dryRun });
    return done(`${by}'s sign-off of flow ${flow} on ${head.slice(0, 7)}`, `recorded ${by}'s sign-off of flow ${flow} on ${head.slice(0, 7)}. Run \`aidrian pr review\` again.`);
  }
  const held = await holdToNamedBase(project, config, repo, namedBase(project, pr, repo, forge));
  if (flags.overrule) {
    recordOverrule(project, { pr, repo, flow: flags.flow, invariant: flags.overrule, head: flags.head, by, reason: flags.reason, remote: remoteState(repo, pr, undefined, held), dryRun });
    return done(`${by}'s ruling on invariant ${flags.overrule} of flow ${flags.flow} on ${flags.head.slice(0, 7)}`, `recorded ${by}'s ruling: invariant ${flags.overrule} of flow ${flags.flow} passes on ${flags.head.slice(0, 7)} on the reviewer evidence that it holds. Run \`aidrian pr review\` again.`);
  }
  if (flags.accept) {
    const where = forge ?? forgeFor(project.root);
    // The host the pull request lives on, from its own link: evidence on any other host is no part of it. When the
    // link cannot be read, the adapter's default host applies.
    let host = null;
    try {
      host = new URL(where.change(pr, 'url', { repo })?.url).hostname;
    } catch {}
    const checkEvidence = (url) => {
      let found;
      try {
        found = where.changeEvidence(repo, pr, url, { ...(host ? { host } : {}), withBody: true });
      } catch (error) {
        throw new Error(`--evidence ${url} could not be checked on ${repo}#${pr}: ${String(error?.message ?? error).split('\n')[0].slice(0, 200)}`);
      }
      if (!found?.kind) throw new Error(`--evidence ${url} is not a comment, review, or review comment of ${repo}#${pr} that the forge can find: cite the URL of the comment or review that holds an attachment, never the attachment's own URL`);
      if (engineMarked(found.body)) throw new Error(`--evidence ${url} is a post of the review engine itself (a finding, the review summary, or the product feedback), never outside evidence: cite a person's comment or review`);
      return found.kind;
    };
    recordAccept(project, { pr, repo, flow: flags.flow, invariant: flags.accept, head: flags.head, by, reason: flags.reason, evidence: flags.evidence, checkEvidence, remote: remoteState(repo, pr, undefined, held), dryRun });
    return done(`${by}'s acceptance of invariant ${flags.accept} of flow ${flags.flow} on ${flags.head.slice(0, 7)}`, `recorded ${by}'s acceptance: invariant ${flags.accept} of flow ${flags.flow} passes on ${flags.head.slice(0, 7)} on the outside evidence ${flags.evidence}. Run \`aidrian pr review\` again.`);
  }
  if (flags.stage) {
    recordStageSignoff(project, { pr, repo, stage: flags.stage, head: flags.head, by, remote: remoteState(repo, pr, undefined, held), dryRun });
    return done(`${by}'s sign-off of the ${flags.stage} stage on ${flags.head.slice(0, 7)}`, `recorded ${by}'s sign-off of the ${flags.stage} stage on ${flags.head.slice(0, 7)}, in place of the reviewer that ran out of quota. Run \`aidrian pr review\` again.`);
  }
  recordSignoff(project, { pr, repo, flow: flags.flow, head: flags.head, by, remote: remoteState(repo, pr, undefined, held), dryRun });
  return done(`${by}'s sign-off of flow ${flags.flow} on ${flags.head.slice(0, 7)}`, `recorded ${by}'s sign-off of flow ${flags.flow} on ${flags.head.slice(0, 7)}. Run \`aidrian pr review\` again.`);
}

// `aidrian pr settle <PR> --flow <id> (--accept <invariant> --evidence <url> | --overrule <invariant>) --reason <text>
// --head <sha> --judge <agent> [--repo OWNER/NAME] [--check]`: a judge's ruling in place of the Human's, so an unattended
// run can finish. It records the same entry as the matching sign-off, with `by` naming the judge, under every refusal
// of that sign-off. The refusal here is a courtesy: what enforces the switches is the review step, which reads the base
// branch's config and ignores a ruling while either is off (lib/review/evidence.mjs). A session's word, not proof.
export async function runSettle(args, project, config = null, { forge } = {}) {
  const [ref, ...rest] = args;
  const at = rest.indexOf('--judge');
  const judge = at === -1 ? undefined : rest[at + 1];
  if (typeof judge !== 'string' || !/^[\w.-]+$/u.test(judge)) throw new Error('settle needs --judge <agent>: the independent agent that ruled');
  const passed = [...rest.slice(0, at), ...rest.slice(at + 2)];
  if (!passed.includes('--accept') && !passed.includes('--overrule')) throw new Error('settle needs --accept or --overrule: a flow sign-off, a stage, and --last stay with the Human');
  if (passed.includes('--stage') || passed.includes('--last')) throw new Error('settle takes no --stage or --last: those stay with the Human');
  const { HARNESS_FLOW } = await import('./review/plan.mjs');
  if (passed[passed.indexOf('--flow') + 1] === HARNESS_FLOW) throw new Error(`flow ${HARNESS_FLOW} guards how the project is reviewed: only the Human settles it`);
  const { JUDGE_PREFIX, settleSwitch } = await import('./review/approvals.mjs');
  const { on, off } = settleSwitch(config?.review, project);
  if (!on) throw new Error(`a judge's ruling does not count here: ${off}. Ask the Human instead`);
  return runSignoff([ref, ...passed], project, config, { forge, by: `${JUDGE_PREFIX}${judge}` });
}

// `aidrian pr ingest <PR> --head <sha> --source <text> [--repo OWNER/NAME] [--check] <file>...`: images taken outside
// the tool, such as an end-to-end run's screenshots, ingested as captures of one head (lib/review/visual.mjs
// ingestCaptures), so a reviewer may cite one as `capture:<key>`. The Human or an agent runs it, and the manifest names
// who: `by` is the git user, `session` whether the host layer detects an AI session, and `agent` the host's agent name
// when it gives one. Like a sign-off, an audit entry, not
// proof. `--check` runs every refusal and records nothing. Every argument after the pull request that is not a flag
// is a file.
export async function runIngest(args, project, config = null, { forge, env = process.env } = {}) {
  const [ref, ...rest] = args;
  const pr = prNumber(ref);
  if (pr === null) throw new Error('ingest needs a pull request number');
  const flags = {};
  const files = [];
  let dryRun = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--check') {
      dryRun = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      files.push(arg);
      continue;
    }
    if (!['--head', '--source', '--repo'].includes(arg)) throw new Error(`unknown argument: ${arg}`);
    const value = rest[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
    flags[arg.slice(2)] = value;
  }
  if (!flags.head || flags.source === undefined || !files.length) throw new Error('--head, --source, and at least one image file are required');
  if (!SHA.test(flags.head) || runGit(['cat-file', '-e', `${flags.head}^{commit}`], project.root).status !== 0) throw new Error(`--head ${flags.head} is not a commit in this repository`);
  // The review step reads a head's manifest by its full SHA.
  const head = runGit(['rev-parse', '--verify', `${flags.head}^{commit}`], project.root).stdout.trim();
  // The repository is not stored, since the capture folder is per pull request; it names where the captures comment is.
  const repo = prRepo(project, pr, flags.repo, forge);
  const base = namedBase(project, pr, repo, forge);
  const held = await holdToNamedBase(project, config, repo, base);
  const by = runGit(['config', 'user.name'], project.root).stdout.trim() || 'unknown';
  // The session kind, from the host layer: an AI session when it detects a host, so an agent's ingest is never
  // recorded as the Human's own; the agent when the host names one.
  const hosts = await import('./hosts/index.mjs');
  const session = hosts.detectHost({ env }).id === hosts.UNKNOWN_HOST.id ? 'shell' : 'ai';
  const { agent } = hosts.sessionIdentity(env);
  const visual = await import('./review/visual.mjs');
  const { manifest, ingested } = visual.ingestCaptures({ project, pr, head, files, source: flags.source, by, agent, session, dryRun });
  const sha = head.slice(0, 7);
  if (dryRun) {
    console.log(`ok: the command would ingest ${ingested.length} image(s) as captures of ${sha}; --check recorded nothing`);
    return 0;
  }
  for (const entry of ingested) {
    const given = files.find((file) => path.resolve(file) === entry.source.path) ?? entry.source.path;
    console.log(`ingested ${given} as capture:${entry.key} of ${sha} from ${entry.source.origin} by ${entry.source.by}${entry.source.session === 'ai' ? (entry.source.agent ? ` via ${entry.source.agent}` : ' in an AI session, agent unknown') : ''}`);
  }
  // A command publishes only after the hold, and with no base it never ran. With the review record local, the review
  // posts no captures comment, so the pull request is not read.
  if (!base) console.log('the forge named no base branch, so the ingest stays on this machine and no captures comment shows it');
  else if (held?.review?.record === 'local') console.log('the review record is local, so no captures comment shows the ingest');
  else await showIngest({ project, pr, repo, manifest, forge: forge ?? forgeFor(project.root), visual });
  console.log('Run `aidrian pr review` again.');
  return 0;
}

// Rewrites the pull request's captures comment with the manifest an ingest wrote, so an ingest made after the review
// captured the head still leaves its trace on the pull request. The comment counts only when a member wrote it, or the
// account of the session's forge token, as the review summary does; only a comment whose heading names this head is
// edited, and only from a manifest this machine's capture wrote (it names its `platform`), with the attach mode,
// visibility, and uploads the review record kept for it. A forge failure is a warning: the ingest is recorded.
async function showIngest({ project, pr, repo, manifest, forge, visual }) {
  const where = `${repo}#${pr}`;
  const sha = manifest.head.slice(0, 7);
  try {
    let viewer;
    const own = (comment) => {
      if (isTrustedCommenter(comment)) return true;
      if (viewer === undefined) {
        try {
          viewer = forge.viewer() ?? null;
        } catch {
          viewer = null;
        }
      }
      return viewer !== null && typeof comment?.user?.login === 'string' && comment.user.login.toLowerCase() === String(viewer).toLowerCase();
    };
    const comment = (forge.conversationComments(repo, pr) ?? []).find((each) => typeof each?.body === 'string' && each.body.startsWith(visual.VISUAL_MARKER) && own(each));
    if (!comment) {
      console.log(`no captures comment on ${where} yet: the review posts one when it captures this head`);
      return;
    }
    if (comment.body.split(/\r?\n/u)[1] !== `### Visual capture: \`${sha}\``) {
      console.log(`the captures comment on ${where} shows another head; it was not edited`);
      return;
    }
    if (typeof manifest.platform !== 'string') {
      // The ingest lives only in this machine's state folder, so only an ingest on the capturing machine can reach it.
      console.log(`the captures comment of ${sha} came from another machine's capture: this ingest counts only on this machine; ingest the same images on the machine that captured the head to show them on the pull request`);
      return;
    }
    const state = readLocalState(project, pr, repo);
    const kept = state?.visual?.head === manifest.head ? state.visual : null;
    forge.editComment(repo, comment.id, visual.capturesBody(manifest, state?.captures ?? {}, { mode: kept?.mode ?? 'local', visibility: kept?.visibility ?? null, error: kept?.error ?? null }));
    console.log(`updated the captures comment on ${where} with the ingest`);
  } catch (error) {
    console.error(`warning: the captures comment on ${where} was not updated (${String(error?.message ?? error).split('\n')[0].slice(0, 200)}); the ingest is recorded`);
  }
}
