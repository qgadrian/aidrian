// The fixture of the review-run tests (review-run, review-run-signoff, review-run-posts): `repo`, a temporary
// repository with `main` and a `feat` branch, whose review step runs with GitHub faked in memory, the engines and
// findings a step is handed, and the builders of residuals, invariants, and rounds. Temporary repositories are made
// with `git init` under mkdtemp; no test sets GIT_DIR.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { projectAt } from '../plugins/aidrian/lib/project.mjs';
import { recordPass, reviewStep } from '../plugins/aidrian/lib/review/run.mjs';
import { HELD_LINE } from '../plugins/aidrian/lib/review/state.mjs';
import { runExtend } from '../plugins/aidrian/lib/review/extension.mjs';

// A repository with `main` (carrying `baseConfig`) and a `feat` branch made by `change(dir)`. Returns the helpers a
// review step needs, with GitHub faked in memory.
export function repo(t, { baseConfig = { version: 1 }, change, headConfig, baseFiles = {} } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-review-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'repo');
  mkdirSync(dir);
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'Tester');
  write('.aidrian/config.json', JSON.stringify(baseConfig));
  write('src/app.js', 'export const app = 1;\n');
  for (const [file, text] of Object.entries(baseFiles)) write(file, text);
  write('docs/flows/booking.md', '# Booking\n\n## No double booking\nTwo bookings never hold one slot.\n\n## Refund cap\nA refund never exceeds the charge.\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('switch', '-q', '-c', 'feat');
  change(write, dir);
  if (headConfig) write('.aidrian/config.json', JSON.stringify(headConfig));
  git('add', '-A');
  git('commit', '-q', '-m', 'change');
  const comments = [];
  // A private repository, and a pull request from inside the team: the summary comment carries the whole record
  // (lib/review/publish.mjs postedCopy). A test of another reading sets its own.
  const forge = {
    visibility: () => 'PRIVATE',
    pull: () => ({ author_association: 'MEMBER', base: { repo: { fork: false } } }),
    change: () => ({ number: 7, headRefOid: git('rev-parse', 'HEAD'), baseRefName: 'main', url: 'https://github.com/o/r/pull/7', isCrossRepository: false }),
    repo: () => 'o/r',
    conversationComments: () => comments,
    reviews: () => [],
    reviewComments: () => [],
    postComment: (_repo, _n, body) => comments.push({ id: comments.length + 1, body, author_association: 'MEMBER' }),
    editComment: (_repo, id, body) => (comments.find((c) => c.id === id).body = body),
  };
  const project = projectAt(dir);
  // A fresh project per step, so a local settings file written mid-test is read.
  const step = (deps = {}, opts = {}) => {
    const current = projectAt(dir);
    return reviewStep({ pr: '7', ...opts }, { project: current, config: loadConfig(current).config, forge, codex: () => ({ ok: true }), ...deps });
  };
  return { dir, git, write, forge, comments, project, step, commit: (msg = 'next') => (git('add', '-A'), git('commit', '-q', '-m', msg), git('rev-parse', 'HEAD')) };
}

export const clean = async () => ({ status: 'done', findings: [], verdicts: [], dropped: [] });
// A summary written on a private repository, from inside the team, whose checks pass every string.
export const OPEN = { reading: { visibility: 'PRIVATE', inside: true }, checker: { allows: () => true } };
// A residual row without the id the step names its finding by.
export const unnamed = ({ id: _id, ...row }) => row;
// The `next` entry of an unverified invariant: its acceptance command, and `notes` beside it.
export const acceptCommand = (flow, id, head) => `aidrian pr signoff 7 --flow ${flow} --accept ${id} --evidence "<URL of a comment or review of this pull request>" --reason "<what it shows>" --head ${head}`;
export const unverifiedNext = (flow, id, head, notes = []) => ({ invariant: id, state: 'unverified', commands: [acceptCommand(flow, id, head)], notes });
export const finding = { file: 'src/app.js', line: 1, title: 'off by one', body: 'x', severity: 'high' };

// An exec reviewer that keeps each input, and answers with `answers` in turn, then clean.
export const scripted = (...answers) => {
  const inputs = [];
  return { inputs, exec: async (_reviewer, input) => (inputs.push(input), answers[inputs.length - 1] ?? { status: 'done', findings: [], verdicts: [], dropped: [] }) };
};
export const found = (...findings) => ({ status: 'done', findings, verdicts: [], dropped: [] });

// The verdicts text that says every invariant of `pass` holds, citing `evidence`.
export const holdsAll = (pass, evidence) => JSON.stringify(pass.flows.flatMap((flow) => flow.invariants.map((each) => ({ flow: flow.id, invariant: each.id, verdict: 'holds', evidence }))));

// The summary comment as the machine that wrote it leaves it when its record is too large: the held marker in place
// of the record.
export const holdComment = (body, revision) => body.replace(/<!-- aidrian-review-state-br:[^>]*-->/u, `${HELD_LINE}\n<!-- aidrian-review-state-held:${revision} -->`);

// Two rounds to the cap of 2 on a booking flow: round 1 leaves `first` findings open, round 2 leaves `second`. Returns
// the repository and the step at the cap. With `fixFirst`, a fix is pushed after round 2 and before the step, so the
// cap meets a head no round reviewed.
export async function toTheCap(t, github, { first = 2, second = 1, fixFirst = false } = {}) {
  const flows = { booking: { files: ['src/booking/**'] } };
  const r = repo(t, { baseConfig: { version: 1, github: { maxReviewRounds: 2, ...github }, review: { flows } }, change: (write) => write('src/booking/a.js', '1\n') });
  const one = await r.step({ exec: clean });
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: one.dispatch[0].pass, head: one.head, reviewer: 'code-reviewer', findings: first, fixed: 0 });
  assert.equal((await r.step({ exec: clean })).status, 'fix_required');
  r.write('src/booking/a.js', '2\n');
  r.commit();
  const two = await r.step({ exec: clean });
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: two.dispatch[0].pass, head: two.head, reviewer: 'code-reviewer', findings: second, fixed: 0 });
  if (fixFirst) {
    r.write('src/booking/a.js', '3\n');
    r.commit('the fix of round 2');
  }
  return { r, capped: await r.step({ exec: clean }), pass: two.dispatch[0].pass, last: two.head };
}

// `aidrian pr extend` as the CLI runs it, its printed JSON returned.
export async function extend(t, r, args) {
  const log = t.mock.method(console, 'log', () => {});
  try {
    const code = await runExtend(['7', ...args], r.project, loadConfig(r.project).config, { repo: 'o/r', forge: r.forge, env: {} });
    return { code, out: JSON.parse(log.mock.calls.at(-1).arguments[0]) };
  } finally {
    log.mock.restore();
  }
}

// The body of the summary comment the step posted.
export const summaryOf = (r) => r.comments.find((c) => c.body.startsWith('<!-- aidrian-review-summary -->')).body;

// A flow whose design invariant no reviewer can verify, and whose base config names its approver.
export const APPROVED_FLOWS = { look: { files: ['src/ui/**'], invariants: [
  { id: 'matches-design', text: 'Does the screen still match the approved design?', approvers: ['amy-designer'] },
  { id: 'keeps-copy', text: 'Does the copy stay as written?' },
] } };
