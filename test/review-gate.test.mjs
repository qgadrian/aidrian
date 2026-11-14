import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { awaitReview, runAwaitReview } from '../plugins/aidrian/lib/pr-await-review.mjs';
import { projectAt, stateDir } from '../plugins/aidrian/lib/project.mjs';
import { asksForReview, gateReview, lastSignoff, markerFor, OVERRIDE, readRecord, runSignoff, writeRecord } from '../plugins/aidrian/lib/review-gate.mjs';
import { findingsTable, postedCopy } from '../plugins/aidrian/lib/review/publish.mjs';
import { emptyState, heldMessage, readLocalState, SUMMARY_MARKER, writeLocalState } from '../plugins/aidrian/lib/review/state.mjs';
import { check } from '../plugins/aidrian/lib/rules/github/review-request.mjs';

const STATE = process.env.XDG_STATE_HOME;
after(() => (STATE === undefined ? delete process.env.XDG_STATE_HOME : (process.env.XDG_STATE_HOME = STATE)));

const CLI = path.resolve('plugins/aidrian/lib/cli.mjs');
const GATE = { version: 1, github: { reviewGate: { enabled: true, checklist: 'docs/review-checklist.md' } } };

// A git repository with an origin and one commit, holding a project folder with `config`.
function repo(t, config = GATE, origin = 'git@github.com:Acme/Notes.git') {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-gate-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'repo');
  mkdirSync(dir);
  // The state folder is keyed by the origin, which every repository here shares: each gets its own, beside the checkout.
  process.env.XDG_STATE_HOME = path.join(root, 'state');
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('remote', 'add', 'origin', origin);
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify(config));
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init');
  const project = projectAt(dir);
  return { dir, project, head: git('rev-parse', 'HEAD'), run: (command, env = {}) => check(command, { cwd: dir, env }), write: (name, text) => writeFileSync(path.join(dir, name), text) };
}

const reviewed = (project, pr) => writeRecord(project, { pr, repo: 'acme/notes', head: 'abcdef1', reviewer: 'code-reviewer', findings: 1, fixed: 1, note: null });

test('a request is a body asking @codex review outside code and quotes', () => {
  assert.equal(asksForReview('@codex review'), true);
  assert.equal(asksForReview('please, @Codex security review this'), true);
  assert.equal(asksForReview('`@codex review` is the trigger'), false);
  assert.equal(asksForReview('> @codex review\nthanks'), false);
  assert.equal(asksForReview('```\n@codex review\n```'), false);
  assert.equal(asksForReview('```@codex review``` is the trigger.\n\n@codex review'), true, 'a line that opens with a code span is no fence');
  assert.equal(asksForReview('````\n```\n@codex review\n```\n````'), false, 'a nested fence');
  assert.equal(asksForReview('@codex reviewer'), false);
});

test('gh comment requests are refused until a review is on record, in every way gh takes a body', (t) => {
  const { run, project, write } = repo(t);
  write('req.md', '@codex review\n');
  write('req.json', JSON.stringify({ body: '@codex review' }));
  const commands = [
    'gh pr comment 5 --body "@codex review"',
    'gh pr comment 5 -b"@codex review"',
    'gh issue comment 5 --body-file req.md',
    "gh pr review 5 --comment -b '@codex review'",
    "gh pr review 5 -r -b '@codex review'",
    "gh pr review 5 -a --body-file req.md",
    "gh pr review 5 -cb '@codex review'",
    `gh pr comment 5 --body "$(cat <<'EOF'\n@codex review\nEOF\n)"`,
    'gh api repos/acme/notes/issues/5/comments -f body="@codex review"',
    'gh api repos/{owner}/{repo}/issues/5/comments -F body=@req.md',
    'gh api -X POST repos/acme/notes/issues/5/comments --input req.json',
    'git push && gh pr comment https://github.com/acme/notes/pull/5 -b "@codex review"',
    'gh pr edit 5 --add-reviewer chatgpt-codex-connector',
    'gh issue comment https://github.com/acme/notes/issues/5 --body "@codex review"',
    "gh pr -b '@codex review' comment 5",
    "gh -X POST -f body='@codex review' api repos/acme/notes/issues/5/comments",
    "GH_REPO=acme/notes gh pr comment 5 -b '@codex review'",
    "GH_REPO=other/repo env GH_REPO=acme/notes gh pr comment 5 -b '@codex review'",
    "env -S 'GH_REPO=acme/notes gh' pr comment 5 -b '@codex review'",
    "GH_REPO=other/repo gh pr comment https://github.com/acme/notes/pull/5 -b '@codex review'",
    "GH_REPO=other/repo exec -c gh pr comment 5 -b '@codex review'",
    "GH_REPO=other/repo sudo gh pr comment 5 -b '@codex review'",
    "GH_REPO=other/notes gh api 'repos/acme/{repo}/issues/5/comments' -f body='@codex review'",
    "GH_REPO=github.com/acme/notes gh api 'repos/{owner}/{repo}/issues/5/comments' -f body='@codex review'",
    "GH_REPO=other/repo env --un=GH_REPO gh pr comment 5 -b '@codex review'",
    "GH_REPO=other/repo gh pr comment 5 -R \"$REPO\" -b '@codex review'",
    "GH_REPO=other/repo env -u \"$NAME\" gh pr comment 5 -b '@codex review'",
  ];
  for (const command of commands) assert.match(run(command) ?? 'passed', /^Blocked: this asks the review bot to review pull request #5,/, command);
  assert.match(run(commands[0]), /against docs\/review-checklist\.md/);
  assert.match(run(commands[0]), /aidrian pr attest 5 --head <sha>/);
  reviewed(project, 5);
  for (const command of commands) assert.equal(run(command), null, command);
});

test('what is not a request to this repository passes; a request without a number is refused', (t) => {
  const { run } = repo(t);
  for (const command of [
    'gh pr comment 5 --body "LGTM"',
    'gh pr comment 5 --body "`@codex review` is how to ask"',
    'gh api repos/acme/notes/issues/5/comments --jq ".[].body"',
    'gh api -X GET repos/acme/notes/issues/5/comments -f body="@codex review"',
    'gh pr comment 5 -R other/repo -b "@codex review"',
    'gh issue comment https://github.com/other/repo/issues/5 -b "@codex review"',
    'gh pr edit https://github.com/other/repo/pull/5 --add-reviewer chatgpt-codex-connector',
    'gh pr comment 5 --body-file - ',
    'echo "gh pr comment 5 -b @codex review"',
    'gh pr edit 5 --add-reviewer someone',
    "GH_REPO=other/repo gh pr comment 5 -b '@codex review'",
    "env GH_REPO=other/repo gh api 'repos/{owner}/{repo}/issues/5/comments' -f body='@codex review'",
    "env -S 'GH_REPO=other/repo gh' pr comment 5 -b '@codex review'",
  ]) assert.equal(run(command), null, command);
  assert.equal(run("gh pr comment 5 -b '@codex review'", { GH_REPO: 'other/repo' }), null, 'the ambient GH_REPO');
  for (const command of ["sudo -E gh pr comment 5 -b '@codex review'", "sudo --preserve-env gh pr comment 5 -b '@codex review'",
    "sudo --preserve-env=PATH,GH_REPO gh pr comment 5 -b '@codex review'", "sudo -nE gh pr comment 5 -b '@codex review'"]) {
    assert.equal(run(command, { GH_REPO: 'other/repo' }), null, command);
  }
  assert.match(run("sudo --preserve-env=\"$KEEP\" gh pr comment 5 -b '@codex review'", { GH_REPO: 'other/repo' }) ?? 'passed', /^Blocked/);
  assert.match(run("sudo --preserve-env=PATH gh pr comment 5 -b '@codex review'", { GH_REPO: 'other/repo' }) ?? 'passed', /^Blocked/);
  for (const command of ["env -u GH_REPO gh pr comment 5 -b '@codex review'", "env -i gh pr comment 5 -b '@codex review'",
    "env -i PATH=/bin gh pr comment 5 -b '@codex review'", "GH_REPO=acme/notes gh pr comment 5 -b '@codex review'"]) {
    assert.match(run(command, { GH_REPO: 'other/repo' }) ?? 'passed', /^Blocked/, command);
  }
  assert.equal(run("GH_REPO=acme/notes gh pr comment 5 -R other/repo -b '@codex review'"), null, '-R wins over GH_REPO');
  assert.match(run('gh pr comment -b "@codex review"'), /the pull request number could not be read/);
  assert.match(run('gh pr create -t x -b y --reviewer chatgpt-codex-connector[bot]'), /could not be read/, 'a new pull request has no review yet');
});

test('a marker for this pull request and repository passes; one for another does not', (t) => {
  const { run } = repo(t);
  const marker = (pr, repoName) => markerFor({ pr, repo: repoName, head: 'abcdef1', reviewer: 'x', findings: 0, fixed: 0 });
  assert.equal(run(`gh pr comment 5 -b "@codex review ${marker(5, 'acme/notes')}"`), null);
  assert.match(run(`gh pr comment 5 -b "@codex review ${marker(6, 'acme/notes')}"`), /^Blocked/);
  assert.match(run(`gh pr comment 5 -b "@codex review ${marker(5, 'other/notes')}"`), /^Blocked/);
});

test('the override passes the request and records itself for the pull request', (t) => {
  const { run, project } = repo(t);
  assert.equal(run('gh pr comment 9 -b "@codex review"', { [OVERRIDE]: '1' }), null);
  assert.equal(readRecord(project, 9).reviewer, 'override');
  assert.equal(run('gh pr comment 9 -b "@codex review"'), null);
});

test('the gate is off by default', (t) => {
  const { run } = repo(t, { version: 1 });
  assert.equal(run('gh pr comment 5 -b "@codex review"'), null);
  assert.deepEqual(loadConfig(projectAt(repo(t, { version: 1 }).dir)).config.github.reviewGate, { enabled: false, checklist: null });
});

test('aidrian pr attest records the review and prints the marker; --check reads it', (t) => {
  const { dir, head, project } = repo(t);
  const run = (...args) => spawnSync(process.execPath, [CLI, 'pr', 'attest', ...args], { cwd: dir, encoding: 'utf8', env: process.env });
  assert.equal(run('7', '--check').status, 3);
  assert.match(run('7', '--head', 'deadbee', '--reviewer', 'r', '--findings', '0', '--fixed', '0').stderr, /--head deadbee is not a commit/);
  assert.match(run('7', '--head', head, '--reviewer', 'r', '--findings', '1', '--fixed', '2').stderr, /--fixed cannot exceed --findings/);
  const done = run('#7', '--head', head, '--reviewer', 'code-reviewer', '--findings', '2', '--fixed', '1', '--repo', 'Acme/Notes');
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, new RegExp(`<!-- aidrian-review: pr=7 repo=acme/notes head=${head} reviewer=code-reviewer findings=2 fixed=1 -->`));
  assert.equal(run('7', '--check').status, 0);
  assert.equal(readRecord(project, 7).head, head);
});

test('aidrian pr attest records a short --head as its full commit, so a moved finding keeps its line in the findings table and the posted index', (t) => {
  const { dir, head: first, project } = repo(t, { ...GATE, review: { record: 'local' } });
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i}\n`).join('');
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src/a.js'), lines(3));
  git('add', '.');
  git('commit', '-qm', 'short file');
  const older = git('rev-parse', 'HEAD');
  assert.notEqual(older, first);
  const pass = 'agent:code-reviewer';
  writeLocalState(project, { ...emptyState(7, 'acme/notes'), floored: true, dispatched: { [pass]: { stage: 'local', files: null } } });
  const attest = (head, line) => {
    const file = path.join(dir, 'findings.json');
    writeFileSync(file, JSON.stringify([{ title: 'Null check missing', file: 'src/a.js', line, severity: 'medium', likelihood: 'plausible', affects: 'users', state: 'open' }]));
    const result = spawnSync(process.execPath, [CLI, 'pr', 'attest', '7', '--pass', pass, '--head', head, '--reviewer', 'code-reviewer', '--findings-file', file, '--repo', 'Acme/Notes'], { cwd: dir, encoding: 'utf8', env: process.env });
    assert.equal(result.status, 0, result.stderr);
  };
  attest(older, 3);
  writeFileSync(path.join(dir, 'src/a.js'), lines(10));
  git('commit', '-qam', 'longer file');
  const newer = git('rev-parse', 'HEAD');
  attest(newer.slice(0, 7), 8);

  const state = readLocalState(project, 7);
  assert.equal(state.passes[pass].head, newer, 'the pass is recorded at the full commit');
  const [entry] = Object.values(state.index);
  assert.deepEqual([entry.line, entry.placed], [8, newer], 'the location is checked at the head that moved it');
  assert.ok(findingsTable(state, { root: dir }).some((row) => row.includes(`src/a.js:8`)), 'the findings table shows the moved line');
  const { copy } = postedCopy(state, { reading: { visibility: 'PUBLIC', inside: true }, checker: { allows: () => true }, root: dir, names: [], publish: { publicSecurity: 'full' } });
  assert.deepEqual([copy.index[entry.id].file, copy.index[entry.id].line], ['src/a.js', 8], 'the posted index keeps the moved line');
});

test('no test reads a real pull request', () => {
  const gh = spawnSync('gh', ['--version'], { encoding: 'utf8' });
  assert.deepEqual([gh.status, gh.stdout], [1, '']);
});

test('aidrian pr attest --pass --verdicts - reads the agent`s JSON from stdin and stores its evidence as written', (t) => {
  const { dir, head, project } = repo(t, { ...GATE, review: { record: 'local' } });
  // --repo names the repository, which the forge cannot here: the suite's forge command always fails, so the test reads no network.
  const attest = (pass, input, ...more) => spawnSync(process.execPath, [CLI, 'pr', 'attest', '7', '--pass', pass, '--head', head, '--reviewer', 'product-manager', ...more, '--repo', 'Acme/Notes'], { cwd: dir, encoding: 'utf8', env: process.env, input });
  const counted = ['--findings', '0', '--fixed', '0'];
  const recorded = (pass) => readLocalState(project, 7)?.passes[pass];
  const evidence = 'The checkout copy says "Pay now" before the total, as the brief asks; no price moves (see the summary step).';
  const verdicts = [{ flow: 'checkout', invariant: 'price-shown', verdict: 'holds', evidence }];

  const bare = attest('agent:product-manager', JSON.stringify(verdicts), ...counted, '--verdicts', '-');
  assert.equal(bare.status, 0, bare.stderr);
  assert.deepEqual(recorded('agent:product-manager').verdicts, verdicts);
  assert.equal(recorded('agent:product-manager').verdicts[0].evidence, evidence, 'prose evidence is stored byte-identical');

  const whole = { findings: [], verdicts: [{ ...verdicts[0], invariant: 'copy-plain' }], contracts: ['c'], cross_notes: ['n'] };
  const object = attest('agent:product-manager', JSON.stringify(whole), ...counted, '--verdicts', '-');
  assert.equal(object.status, 0, object.stderr);
  assert.deepEqual(recorded('agent:product-manager').verdicts, whole.verdicts, 'the agent`s whole final object');
  assert.deepEqual(recorded('agent:product-manager').contracts, ['c']);
  assert.deepEqual(recorded('agent:product-manager').cross_notes, ['n']);

  const both = attest('agent:security-engineer', JSON.stringify(verdicts), '--verdicts', '-', '--findings-file', '-');
  assert.equal(both.status, 1);
  assert.match(both.stderr, /--findings-file - is not supported: stdin is read once, by --verdicts -; write the findings to a file/);
  assert.equal(recorded('agent:security-engineer'), undefined);

  for (const input of ['', 'not json']) {
    const bad = attest('agent:security-engineer', input, ...counted, '--verdicts', '-');
    assert.equal(bad.status, 1, `stdin ${JSON.stringify(input)}`);
    assert.match(bad.stderr, /--verdicts must be a JSON file/);
    assert.equal(recorded('agent:security-engineer'), undefined);
  }

  const file = path.join(dir, 'verdicts.json');
  writeFileSync(file, JSON.stringify(verdicts));
  const fromFile = attest('agent:code-reviewer', undefined, ...counted, '--verdicts', file);
  assert.equal(fromFile.status, 0, fromFile.stderr);
  assert.deepEqual(recorded('agent:code-reviewer').verdicts, verdicts, '--verdicts FILE reads the file as before');
});

// The review step's record of pull request `pr` with `passes`, as `aidrian pr attest --pass` writes them (recordPass).
function passes(project, pr, entries) {
  const state = emptyState(pr, 'acme/notes');
  for (const [id, pass] of Object.entries(entries)) state.passes[id] = { head: 'abcdef1', reviewer: 'code-reviewer', files: null, findings: 2, open: 0, verdicts: [], list: null, ...pass };
  writeLocalState(project, state);
}

test('a full-diff agent pass the review step recorded counts as the gate`s review; flow and slice passes do not', async (t) => {
  const { dir, run, project } = repo(t);
  const request = 'gh pr comment 5 -b "@codex review"';
  passes(project, 5, {
    'flow:billing:code-reviewer': { files: ['src/billing.mjs'] },
    'agent:code-reviewer:billing+auth': { files: ['src/billing.mjs', 'src/auth.mjs'] },
    'agent:code-reviewer.1': { files: ['src/a.mjs'] },
    'cross:code-reviewer': {},
    'engine:codex-local': {},
  });
  assert.match(run(request) ?? 'passed', /^Blocked: this asks the review bot to review pull request #5,/, 'flow, slice, cross, and engine passes alone');
  assert.match(run(request), /aidrian pr attest 5 --pass agent:<name> --head <sha>/, 'the deny names both forms');
  assert.match(run(request), /A pass over a flow's or a slice's files alone does not count\./);
  assert.equal(gateReview(project, 5), null);
  passes(project, 5, { 'agent:code-reviewer': { reviewer: '', findings: 1 } });
  assert.ok(run(request), 'a pass that names no reviewer');
  passes(project, 5, { 'agent:code-reviewer:billing': {} });
  assert.equal(run(request), null, 'an agent pass its flows merged into, with no file list, read the whole diff');
  assert.equal(gateReview(project, 5).pass, 'agent:code-reviewer:billing');
  passes(project, 5, { 'flow:billing:code-reviewer': { files: ['src/billing.mjs'] }, 'agent:code-reviewer': { findings: 3, open: 1 } });
  assert.equal(run(request), null, 'the full-diff agent pass lets the request through');
  assert.deepEqual(gateReview(project, 5), { pr: 5, repo: 'acme/notes', head: 'abcdef1', reviewer: 'code-reviewer', findings: 3, fixed: 2, pass: 'agent:code-reviewer' });
  const check = spawnSync(process.execPath, [CLI, 'pr', 'attest', '5', '--check'], { cwd: dir, encoding: 'utf8', env: process.env });
  assert.equal(check.status, 0, 'attest --check reads the same review');
  const config = loadConfig(project).config;
  const forge = quietForge();
  const quiet = { log: console.log, error: console.error };
  console.log = console.error = () => {};
  t.after(() => Object.assign(console, quiet));
  assert.equal(await runAwaitReview(['5', '--request', '--timeout-sec', '0'], config, project, { forge }), 2, 'await-review --request posts, not review_required');
  assert.match(forge.posts[0], /<!-- aidrian-review: pr=5 repo=acme\/notes head=abcdef1 reviewer=code-reviewer findings=3 fixed=2 -->$/, 'with the pass`s marker');
});

// A forge that answers the reads of one pull request with nothing, and records its posts.
const quietForge = () => {
  const posts = [];
  return {
    posts,
    repo: () => 'acme/notes',
    change: () => ({ number: 5 }),
    postComment: (_repo, _n, body) => posts.push(body) && { created_at: '2026-08-23T07:00:00Z' },
    pull: () => ({ head: { sha: 'abcdef1234' } }),
    commit: () => ({ commit: { committer: { date: '2026-08-23T06:00:00Z' } } }),
    reviews: () => [],
    reviewComments: () => [],
    conversationComments: () => [],
    reactions: () => [],
  };
};

test('aidrian pr await-review --request posts nothing without a review, and carries the marker with one', async (t) => {
  const { project } = repo(t);
  const config = loadConfig(project).config;
  const forge = quietForge();
  const quiet = { log: console.log, error: console.error };
  console.log = console.error = () => {};
  t.after(() => Object.assign(console, quiet));
  const opts = ['5', '--request', '--timeout-sec', '0'];
  assert.equal(await runAwaitReview(opts, config, project, { forge }), 5);
  assert.deepEqual(forge.posts, []);
  reviewed(project, 5);
  assert.equal(await runAwaitReview(opts, config, project, { forge }), 2);
  assert.equal(forge.posts.length, 1);
  assert.match(forge.posts[0], /^@codex review/);
  assert.match(forge.posts[0], /<!-- aidrian-review: pr=5 repo=acme\/notes head=abcdef1 reviewer=code-reviewer findings=1 fixed=1 -->$/);
  const plain = await awaitReview({ pr: '5', repo: null, reviewer: 'bot', request: true, timeoutSec: 0, intervalSec: 60 }, { forge: quietForge() });
  assert.equal(plain.status, 'timed_out', 'without a gate the request posts as before');
});

test('the MCP hook holds the gate for the GitHub comment tools', (t) => {
  const { dir, project } = repo(t);
  const hook = (toolInput, tool = 'mcp__github__add_issue_comment') =>
    spawnSync(process.execPath, ['plugins/aidrian/scripts/hook-mcp-github.mjs'], {
      input: JSON.stringify({ tool_name: tool, cwd: dir, tool_input: toolInput }),
      encoding: 'utf8',
      env: { ...process.env, AIDRIAN_TELEMETRY: '0' },
    });
  assert.equal(hook({ owner: 'acme', repo: 'notes', pullNumber: 5, body: 'thanks' }, 'mcp__github__pull_request_review_write').status, 0);
  // With a review bot set, the review-round rule sends every request through `aidrian pr`, record or not.
  for (const owner of ['acme', 'other']) {
    const denied = hook({ owner, repo: 'notes', issue_number: 5, body: '@codex review' });
    assert.equal(denied.status, 2);
    assert.match(denied.stderr, /aidrian pr await-review --request/);
  }
  reviewed(project, 5);
  assert.equal(hook({ owner: 'acme', repo: 'notes', issue_number: 5, body: '@codex review' }).status, 2);
});

test('the MCP hook holds the gate for the comment tools of a GitHub MCP server a Claude Code plugin installs', (t) => {
  const { dir, project } = repo(t, { ...GATE, github: { ...GATE.github, reviewer: 'none' } });
  const hook = (tool, toolInput) => spawnSync(process.execPath, ['plugins/aidrian/scripts/hook-mcp-github.mjs'], {
    input: JSON.stringify({ tool_name: tool, cwd: dir, tool_input: toolInput }),
    encoding: 'utf8',
    env: { ...process.env, AIDRIAN_TELEMETRY: '0' },
  });
  const calls = [
    ['mcp__plugin_github_github__add_issue_comment', { issue_number: 5 }],
    ['mcp__plugin_github_github__add_reply_to_pull_request_comment', { pullNumber: 5 }],
    ['mcp__plugin_github_github__pull_request_review_write', { pullNumber: 5 }],
  ];
  for (const [tool, number] of calls) {
    const denied = hook(tool, { owner: 'acme', repo: 'notes', ...number, body: '@codex review' });
    assert.equal(denied.status, 2, `${tool}: ${denied.stderr}`);
    assert.match(denied.stderr, /pull request #5, and no review/u);
  }
  reviewed(project, 5);
  for (const [tool, number] of calls) assert.equal(hook(tool, { owner: 'acme', repo: 'notes', ...number, body: '@codex review' }).status, 0, tool);
});

test('aidrian pr signoff --last signs off the one flow the last review left waiting, and refuses the rest', async (t) => {
  const { dir, project, head } = repo(t, { version: 1, review: { record: 'local' } });
  execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: dir });
  const h7 = head.slice(0, 7);
  const stale = 'f'.repeat(40);
  const recordFile = path.join(stateDir(project), 'reviews', 'pr-7-review.json');
  const seed = (fields = {}) => {
    // The stop --last serves, unless a case seeds another outcome.
    writeLocalState(project, { ...emptyState(7, 'acme/notes'), outcome: { status: 'human_required', head, at: 'x' }, ...fields });
    return readFileSync(recordFile, 'utf8');
  };
  let forgeHead = head;
  let forgeFails = false;
  const forge = {
    change: () => {
      if (forgeFails) throw new Error('gh: offline');
      return { url: 'https://github.com/acme/notes/pull/7', headRefOid: forgeHead };
    },
  };
  const { config } = loadConfig(project);
  const signoff = async (...args) => {
    const lines = [];
    t.mock.method(console, 'log', (line) => lines.push(line));
    try {
      return { code: await runSignoff(['7', ...args, ...(args.includes('--repo') ? [] : ['--repo', 'acme/notes'])], project, config, { forge }), lines };
    } finally {
      t.mock.restoreAll();
    }
  };
  // A refusal throws the same message with and without --check, and neither writes the record.
  const refuses = async (args, message) => {
    const before = readFileSync(recordFile, 'utf8');
    await assert.rejects(signoff(...args), message, args.join(' '));
    await assert.rejects(signoff(...args, '--check'), message, `${args.join(' ')} --check`);
    // The same bytes: no sign-off, overrule, or acceptance was written.
    assert.equal(readFileSync(recordFile, 'utf8'), before, `${args.join(' ')} wrote the record`);
  };
  const ok = (flow) => `ok: the command would record Tester's sign-off of flow ${flow} on ${h7}; --check recorded nothing`;

  // One flow waits: --check records nothing, --last records it as --flow pay --head <sha> would, and then none waits.
  const one = seed({ signoffable: { head, flows: ['pay'] } });
  assert.deepEqual(await signoff('--last', '--check'), { code: 0, lines: [ok('pay')] });
  assert.equal(readFileSync(recordFile, 'utf8'), one, '--check wrote the record');
  assert.deepEqual(await signoff('--last'), { code: 0, lines: [`recorded Tester's sign-off of flow pay on ${h7}. Run \`aidrian pr review\` again.`] });
  const signed = readLocalState(project, 7);
  assert.deepEqual({ ...signed.signoffs.pay, at: typeof signed.signoffs.pay.at }, { head, by: 'Tester', at: 'string' });
  assert.deepEqual([signed.overrulings ?? [], signed.acceptances ?? []], [[], []], '--last records no ruling');
  await refuses(['--last'], /no flow of acme\/notes#7 waits for a sign-off on/u);

  // Two flows wait: no order is invented; both are listed with their long commands. One signed: the other is the one.
  seed({ signoffable: { head, flows: ['harness-config', 'pay'] } });
  await refuses(['--last'], (error) => {
    assert.match(error.message, /2 flows of acme\/notes#7 wait .* harness-config, pay/u);
    assert.ok(error.message.includes(`--flow harness-config --head ${head}`) && error.message.includes(`--flow pay --head ${head}`), error.message);
    return true;
  });
  seed({ signoffable: { head, flows: ['harness-config', 'pay'] }, signoffs: { 'harness-config': { head, by: 'Tester', at: 'x' } } });
  assert.deepEqual(await signoff('--last', '--check'), { code: 0, lines: [ok('pay')] });

  // No review ran; the pull request moved past the reviewed head; the forge cannot say where it is.
  seed();
  await refuses(['--last'], /no review of acme\/notes#7 ran/u);
  seed({ signoffable: { head, flows: ['pay'] } });
  forgeHead = stale;
  await refuses(['--last'], new RegExp(`ran on ${h7}, and the pull request is at fffffff`, 'u'));
  forgeHead = head;
  forgeFails = true;
  await refuses(['--last'], /could not read the head of acme\/notes#7/u);
  forgeFails = false;

  // A disputed invariant owes an overrule, which --last never records; once overruled on that head, it passes.
  const disputes = { head, items: [{ flow: 'pay', invariant: 'cap' }] };
  seed({ signoffable: { head, flows: ['pay'] }, disputes });
  await refuses(['--last'], (error) => {
    assert.match(error.message, /--last never overrules/u);
    assert.ok(error.message.includes('--overrule <invariant>'), error.message);
    return true;
  });
  seed({ signoffable: { head, flows: ['pay'] }, disputes, overrulings: [{ flow: 'pay', invariant: 'cap', head, by: 'Tester', reason: 'r', at: 'x' }] });
  assert.deepEqual(await signoff('--last', '--check'), { code: 0, lines: [ok('pay')] });

  // An unverified invariant owes an accept, closed by an acceptance or by outside evidence on that head.
  const invariants = { head, items: [{ flow: 'pay', invariant: 'cap', state: 'unverified' }] };
  seed({ signoffable: { head, flows: ['pay'] }, invariants });
  await refuses(['--last'], /--last never accepts/u);
  seed({ signoffable: { head, flows: ['pay'] }, invariants, acceptances: [{ flow: 'pay', invariant: 'cap', head, by: 'Tester', reason: 'r', evidence: 'https://x', kind: 'comment', at: 'x' }] });
  assert.deepEqual(await signoff('--last', '--check'), { code: 0, lines: [ok('pay')] });
  seed({ signoffable: { head, flows: ['pay'] }, invariants, outside: { head, approvals: [{ flow: 'pay', invariant: 'cap' }], acceptances: [] } });
  assert.deepEqual(await signoff('--last', '--check'), { code: 0, lines: [ok('pay')] });
  // A violated invariant no reviewer disputes is no refusal, as with --flow: the sign-off counts for nothing until the fix.
  seed({ signoffable: { head, flows: ['pay'] }, invariants: { head, items: [{ flow: 'pay', invariant: 'cap', state: 'violated' }] } });
  assert.deepEqual(await signoff('--last', '--check'), { code: 0, lines: [ok('pay')] });

  // --last takes no free text and no flag of the long forms; only --repo and --check combine with it.
  seed({ signoffable: { head, flows: ['pay'] } });
  for (const extra of [['--head', head], ['--flow', 'pay'], ['--stage', 'x'], ['--overrule', 'cap'], ['--accept', 'cap'], ['--evidence', 'https://x'], ['--reason', 'x']]) {
    await refuses(['--last', ...extra], new RegExp(`--last takes no ${extra[0]}\\b`, 'u'));
  }
  await refuses(['--last', 'extra'], /unknown argument: extra/u);

  // --last serves only the human_required stop of a flow, on the reviewed head: any other recorded status refuses,
  // a flow that waits only for a deleted test (fix_required) included.
  for (const status of ['fix_required', 'dispatch', 'error']) {
    seed({ signoffable: { head, flows: ['pay'] }, outcome: { status, head, at: 'x' } });
    await refuses(['--last'], new RegExp(`the last review of acme/notes#7 on ${h7} stopped at ${status}, not at a flow's human_required`, 'u'));
  }
  seed({ signoffable: { head, flows: ['pay'] }, outcome: { status: 'human_required', head: stale, at: 'x' } });
  await refuses(['--last'], /stopped at human_required on fffffff, not at a flow's human_required/u);
  seed({ signoffable: { head, flows: ['pay'] }, outcome: null });
  await refuses(['--last'], /recorded no stop, not at a flow's human_required/u);
  // A head where the Human took over a stage is never --last's, signed or not: unsigned, the message gives the --stage
  // command; signed, each waiting flow's long command.
  const stop = { head, stage: 'independent', reviewer: 'codex', passes: ['p'], reason: 'quota', at: 'x', choice: 'human' };
  seed({ signoffable: { head, flows: [] }, quotaStops: [stop] });
  await refuses(['--last'], (error) => {
    assert.match(error.message, /the Human took over the independent stage of acme\/notes#7/u);
    assert.ok(error.message.includes(`aidrian pr signoff 7 --stage independent --head ${head}`), error.message);
    return true;
  });
  seed({ signoffable: { head, flows: ['pay'] }, quotaStops: [{ ...stop, signoff: { by: 'Tester', at: 'x' } }] });
  await refuses(['--last'], (error) => {
    assert.match(error.message, new RegExp(`the Human took over the independent stage of acme/notes#7 on ${h7}, so --last does not sign off this head`, 'u'));
    assert.ok(error.message.includes(`aidrian pr signoff 7 --flow pay --head ${head}`), error.message);
    assert.ok(!error.message.includes('--stage'), error.message);
    return true;
  });
  seed({ signoffable: { head, flows: ['pay'] }, quotaStops: [{ ...stop, head: stale }, { ...stop, choice: 'agent:critic' }] });
  assert.deepEqual(await signoff('--last', '--check'), { code: 0, lines: [ok('pay')] }, 'a stop on another head, or an agent fallback, is no takeover');

  // --repo steers --last only to this checkout's repositories, and only to the one the record names.
  seed({ signoffable: { head, flows: ['pay'] } });
  await refuses(['--last', '--repo', 'stranger/repo'], /--last signs off a pull request of this checkout's repositories only \(acme\/notes\), not stranger\/repo/u);
  execFileSync('git', ['remote', 'add', 'upstream', 'git@github.com:Other/X.git'], { cwd: dir });
  await refuses(['--last', '--repo', 'other/x'], /the review record of #7 is for acme\/notes, not other\/x/u);
  assert.deepEqual(await signoff('--last', '--check', '--repo', 'Acme/Notes'), { code: 0, lines: [ok('pay')] });
});

test('aidrian pr signoff --last refuses a review record held on another machine', async (t) => {
  const { dir, project, head } = repo(t, { version: 1 });
  execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: dir });
  writeLocalState(project, { ...emptyState(7, 'acme/notes'), signoffable: { head, flows: ['pay'] }, outcome: { status: 'human_required', head, at: 'x' } });
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', head], { cwd: dir });
  const recordFile = path.join(stateDir(project), 'reviews', 'pr-7-review.json');
  const before = readFileSync(recordFile, 'utf8');
  const forge = {
    change: () => ({ url: 'https://github.com/acme/notes/pull/7', headRefOid: head, baseRefName: 'main' }),
    conversationComments: () => [{ body: `${SUMMARY_MARKER}\n<!-- aidrian-review-state-held:99 -->`, author_association: 'OWNER' }],
  };
  const { config } = loadConfig(project);
  for (const args of [['--last'], ['--last', '--check']]) {
    await assert.rejects(runSignoff(['7', ...args, '--repo', 'acme/notes'], project, config, { forge }), { message: heldMessage(7, 99, 'size') }, args.join(' '));
  }
  assert.equal(readFileSync(recordFile, 'utf8'), before);
});

test('lastSignoff compares heads as commits, and a sign-off on another head leaves the flow pending', () => {
  const head = 'abcdef0123456789abcdef0123456789abcdef01';
  const where = { pr: 7, repo: 'acme/notes', head };
  const outcome = { status: 'human_required', head, at: 'x' };
  assert.deepEqual(lastSignoff({ signoffable: { head: head.slice(0, 7), flows: ['pay'] }, signoffs: {}, outcome }, where), { flow: 'pay', head: head.slice(0, 7) });
  assert.deepEqual(lastSignoff({ signoffable: { head, flows: ['pay'] }, signoffs: { pay: { head: '1234567890', by: 'T', at: 'x' } }, outcome }, where), { flow: 'pay', head });
  assert.throws(() => lastSignoff({ signoffable: { head, flows: ['pay'] }, signoffs: { pay: { head: head.slice(0, 7), by: 'T', at: 'x' } }, outcome }, where), /no flow of acme\/notes#7 waits/u);
});

// #304: the gate applies to the repository a request acts on, whatever remote names it, not to origin alone.
test('a review request to another remote`s repository is gated against a review of that repository', (t) => {
  const { dir, project, run } = repo(t);
  execFileSync('git', ['remote', 'add', 'upstream', 'https://github.com/Up/Notes.git'], { cwd: dir });
  const request = 'gh pr comment 5 -R up/notes -b "@codex review"';
  assert.match(run(request) ?? '', /pull request #5, and no review/u, 'the upstream is one of this checkout`s remotes');
  assert.match(run('gh api repos/Up/Notes/issues/5/comments -f body="@codex review"') ?? '', /pull request #5, and no review/u);
  reviewed(project, 5);
  assert.match(run(request) ?? '', /pull request #5, and no review/u, 'a review of acme/notes#5 is no review of up/notes#5');
  assert.equal(run('gh pr comment 5 -b "@codex review"'), null, 'origin`s own review counts for origin');
  writeRecord(project, { pr: 5, repo: 'up/notes', head: 'abcdef1', reviewer: 'code-reviewer', findings: 0, fixed: 0, note: null });
  assert.equal(run(request), null, 'the upstream`s review counts for the upstream');
  assert.equal(run('gh pr comment 5 -R stranger/repo -b "@codex review"'), null, 'a repository no remote names still passes');
});

test('await-review --request --repo of another remote`s repository is gated, and carries that repository`s marker', async (t) => {
  const { dir, project } = repo(t);
  execFileSync('git', ['remote', 'add', 'upstream', 'https://github.com/Up/Notes.git'], { cwd: dir });
  const { judgeRequests, attestation } = await import('../plugins/aidrian/lib/review-gate.mjs');
  const { config } = loadConfig(project);
  assert.match(judgeRequests([{ pr: 6, repo: 'up/notes', markers: [] }], { project, config, env: {} }) ?? '', /pull request #6, and no review/u);
  writeRecord(project, { pr: 6, repo: 'up/notes', head: 'abcdef1', reviewer: 'code-reviewer', findings: 0, fixed: 0, note: null });
  assert.equal(judgeRequests([{ pr: 6, repo: 'up/notes', markers: [] }], { project, config, env: {} }), null);
  assert.ok(attestation(project, 6, 'up/notes'), 'the request it posts carries the upstream review`s marker');
  assert.equal(attestation(project, 6, 'stranger/repo'), null);
});

// The attest record, as the review record (#305), is one file a repository and number.
test('attest records of one number in two repositories stay apart, and an old-name one is read once and moved', (t) => {
  const { dir, project } = repo(t);
  execFileSync('git', ['remote', 'add', 'upstream', 'https://github.com/Up/Notes.git'], { cwd: dir });
  writeRecord(project, { pr: 5, repo: 'acme/notes', head: 'abcdef1', reviewer: 'origin-reviewer', findings: 0, fixed: 0, note: null });
  writeRecord(project, { pr: 5, repo: 'up/notes', head: 'abcdef1', reviewer: 'upstream-reviewer', findings: 0, fixed: 0, note: null });
  assert.equal(readRecord(project, 5, 'acme/notes').reviewer, 'origin-reviewer', 'origin`s keeps its own');
  assert.equal(readRecord(project, 5, 'up/notes').reviewer, 'upstream-reviewer');
  assert.equal(gateReview(project, 5, 'acme/notes').reviewer, 'origin-reviewer');
  assert.equal(gateReview(project, 5, 'up/notes').reviewer, 'upstream-reviewer');
  const reviews = path.join(stateDir(project), 'reviews');
  assert.ok(existsSync(path.join(reviews, 'pr-5.json')) && existsSync(path.join(reviews, 'pr-5-up--notes.json')), 'origin keeps the old name');
  // An upstream record written under the old name before the key changed: read for the upstream, moved on its next write.
  writeFileSync(path.join(reviews, 'pr-6.json'), JSON.stringify({ pr: 6, repo: 'up/notes', head: 'abcdef1', reviewer: 'old', findings: 0, fixed: 0 }));
  assert.equal(gateReview(project, 6, 'up/notes').reviewer, 'old');
  assert.equal(gateReview(project, 6, 'acme/notes'), null, 'it is no review of origin`s #6');
  writeRecord(project, { pr: 6, repo: 'up/notes', head: 'abcdef1', reviewer: 'new', findings: 0, fixed: 0, note: null });
  assert.equal(existsSync(path.join(reviews, 'pr-6.json')), false);
  assert.equal(readRecord(project, 6, 'up/notes').reviewer, 'new');
});
