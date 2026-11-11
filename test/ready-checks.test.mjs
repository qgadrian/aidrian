// The ready checks hold: no draft is marked ready while a check on its head has not finished, or while a check its last
// edit re-queues has not shown yet (lib/rules/github/ready-checks.mjs). Every gh here is test/fixtures/ready-checks/gh.mjs,
// in-process through gh's exec seam under the real forge adapter, or as a program on PATH: nothing reaches GitHub. Each
// repository is a temporary one, with no GIT_DIR.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runGh } from '../plugins/aidrian/lib/forges/github-cli.mjs';
import { createGithubForge } from '../plugins/aidrian/lib/forges/github.mjs';
import { check, checkMcp, EDIT_WINDOW_MS, SAME_COMMAND_REASON } from '../plugins/aidrian/lib/rules/github/ready-checks.mjs';
import { OVERRIDE } from '../plugins/aidrian/lib/rules/github/ready-hold.mjs';
import { answer, URL7 } from './fixtures/ready-checks/gh.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const FAKE_GH = path.join(ROOT, 'test/fixtures/ready-checks/gh.mjs');
const NOW = Date.parse('2026-11-11T12:00:00Z');
const at = (ms) => new Date(NOW + ms).toISOString().replace(/\.000Z$/u, 'Z');
const LONG_AGO = at(-3_600_000);

// A temporary aidrian project with an origin on acme/notes, and its state folder beside it.
function repo(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-ready-checks-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'repo');
  mkdirSync(dir);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', 'git@github.com:acme/notes.git');
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: '../state' } }));
  writeFileSync(path.join(dir, '.gitignore'), 'bin/\nspec.json\ngh.log\n');
  mkdirSync(path.join(root, 'state/tmp'), { recursive: true });
  return dir;
}

const run = (name, startedAt, status = 'COMPLETED', conclusion = 'SUCCESS') =>
  ({ __typename: 'CheckRun', name, status, conclusion: status === 'COMPLETED' ? conclusion : '', startedAt, workflowName: 'CI' });
const status = (context, state, startedAt) => ({ __typename: 'StatusContext', context, state, startedAt });

// The view of draft 7: opened long ago, with the checks `rollup` on its head.
const draft = (rollup, more = {}) => ({ url: URL7, number: 7, isDraft: true, createdAt: LONG_AGO, statusCheckRollup: rollup, ...more });
const GREEN = [run('Check (Node 22)', at(-600_000)), run('Conventional Commit title', at(-590_000))];

// The hold's forge seam over gh's exec seam: the real adapter and runner, with only gh's process replaced.
function seam(spec) {
  const calls = [];
  const exec = (file, args, options) => {
    assert.equal(file, 'gh');
    assert.equal(options.killSignal, 'SIGKILL');
    calls.push(args);
    return answer(args, spec);
  };
  const forge = (cwd, options) => createGithubForge({ ...options, cwd, run: (args, given) => runGh(args, { ...given, exec }) });
  return { calls, forge };
}

const judge = (dir, spec, command = 'gh pr ready 7', more = {}) => {
  const { calls, forge } = seam(spec);
  return { calls, reason: check(command, { cwd: dir, env: {}, forge, now: () => NOW, ...more }) };
};

test('a check on the head that has not finished holds the draft, and the deny names it and the route', (t) => {
  const dir = repo(t);
  const pending = [
    [run('Conventional Commit title', '0001-01-01T00:00:00Z', 'QUEUED')],
    [run('Check (Node 22)', at(-5_000), 'IN_PROGRESS')],
    [run('Deploy', at(-5_000), 'WAITING')],
    [status('ci/legacy', 'PENDING', at(-5_000))],
    [status('required/e2e', 'EXPECTED', null)],
  ];
  for (const rows of pending) {
    // The quoted spellings the shell runs as `gh pr ready 7`, which the ready hold's parser reads, are judged the same.
    for (const command of ['gh pr ready 7', `gh pr ready ${URL7}`, 'gh pr ready', 'gh -R acme/notes pr ready 7', 'git push && gh pr ready 7',
      'gh pr re""ady 7', 'gh pr rea\\dy 7', "gh pr 'ready' 7", 'gh pr r""eady 7', 'gh pr rea""""dy 7', 'gh pr re""""ady 7', 'gh pr r\\e\\a\\d\\y 7']) {
      const { reason, calls } = judge(dir, { view: draft([...GREEN, ...rows]) }, command);
      assert.match(reason ?? '', /^Blocked: pull request #7 has checks that have not finished/u, `${command}: ${JSON.stringify(rows)}`);
      assert.ok(reason.includes(rows[0].name ?? rows[0].context), reason);
      assert.match(reason, /`gh pr checks 7 --watch`/u);
      assert.match(reason, /`gh pr ready 7` in a separate call/u);
      assert.equal(calls.length, 1, 'one view of the pull request, and no edit read while a check is pending');
    }
  }
  // A check that finished and failed is not pending: the ready runs, and the failure is the review's to read.
  assert.equal(judge(dir, { view: draft([...GREEN, run('Lint', at(-500_000), 'COMPLETED', 'FAILURE')]), edits: {} }).reason, null);
});

test('a draft whose last edit no check has started since is held for the window, then runs', (t) => {
  const dir = repo(t);
  // The body was edited five seconds ago, and every check started before it: the re-queued title check has not shown.
  const edited = judge(dir, { view: draft(GREEN), edits: { lastEditedAt: at(-5_000) } });
  assert.match(edited.reason ?? '', /^Blocked: pull request #7 had its body edited at 2026-11-11T11:59:55Z, and no check has started since/u);
  assert.match(edited.reason, /`gh pr checks 7 --watch`/u);
  assert.match(edited.reason, /`gh pr ready 7` in a separate call/u);
  assert.ok(edited.reason.includes(at(-5_000 + EDIT_WINDOW_MS)), 'the deny says when the hold lifts with no check to wait for');
  assert.equal(edited.calls.length, 2);
  // A title renamed after the body edit is the newer change.
  assert.match(judge(dir, { view: draft(GREEN), edits: { lastEditedAt: at(-20_000), renamedAt: at(-3_000) } }).reason ?? '', /had its title changed at/u);
  // A draft opened seconds ago is held with no edit read.
  const opened = judge(dir, { view: draft([], { createdAt: at(-4_000) }) });
  assert.match(opened.reason ?? '', /was opened at/u);
  assert.equal(opened.calls.length, 1);
  // A check that started after the edit has shown: done, it runs; still running, it is pending.
  assert.equal(judge(dir, { view: draft([...GREEN, run('Conventional Commit title', at(-2_000))]), edits: { lastEditedAt: at(-5_000) } }).reason, null);
  // Past the window, or an edit time ahead of this clock by more than the window, it runs.
  assert.equal(judge(dir, { view: draft(GREEN), edits: { lastEditedAt: at(-EDIT_WINDOW_MS - 1) } }).reason, null);
  assert.equal(judge(dir, { view: draft(GREEN), edits: { lastEditedAt: at(EDIT_WINDOW_MS + 1_000) } }).reason, null);
  assert.equal(judge(dir, { view: draft(GREEN), edits: { lastEditedAt: null } }).reason, null);
});

test('a command that edits a title or body, or opens a pull request, and marks one ready is refused with no gh call', (t) => {
  const dir = repo(t);
  for (const command of [
    'gh pr edit 7 --body-file body.md && gh pr ready 7',
    'gh pr edit 7 -F body.md; gh pr ready 7',
    'gh pr edit 7 --title "fix: x" && gh pr ready 7',
    'gh pr ready 7 && gh pr edit 7 -b "new body"',
    'gh pr create --draft --title "fix: x" --body-file b.md && gh pr ready',
    'gh pr edit 7 --body-file body.md && gh pr re""ady 7',
  ]) {
    const { reason, calls } = judge(dir, { view: draft(GREEN), edits: {} }, command);
    assert.equal(reason, SAME_COMMAND_REASON, command);
    assert.equal(calls.length, 0, command);
  }
  // An edit of labels or reviewers re-queues nothing, and a read of an edit's or create's help edits nothing.
  for (const command of ['gh pr edit 7 --add-label bug && gh pr ready 7', 'gh pr edit --help --title x && gh pr ready 7', 'gh pr create --help; gh pr ready 7']) {
    assert.equal(judge(dir, { view: draft(GREEN), edits: {} }, command).reason, null, command);
  }
});

test('the hold lets the command run when it cannot read the checks, with no draft, with the override, and outside a project', (t) => {
  const dir = repo(t);
  assert.equal(judge(dir, { view: null }).reason, null, 'a view that fails');
  assert.equal(judge(dir, { view: draft(GREEN, { createdAt: at(-1_000) }), edits: null }).reason !== null, true, 'opened just now needs no edit read');
  assert.equal(judge(dir, { view: draft(GREEN), edits: null }).reason, null, 'an edit read that fails');
  assert.equal(judge(dir, { view: draft('not a list') }).reason, null, 'a rollup it cannot read');
  assert.equal(judge(dir, { view: { ...draft([run('CI', at(-1), 'IN_PROGRESS')]), isDraft: false } }).reason, null, 'not a draft: nothing to hold');
  // A read of gh's help marks nothing ready, and an edit's or create's help edits nothing.
  for (const command of ['gh pr ready 7 --undo', 'gh pr ready "$PR"', 'echo done', 'gh pr ready --help', 'gh pr ready -h',
    'gh pr edit --help --title x && gh pr ready --help', 'gh pr create -h; gh pr ready -h']) {
    const { reason, calls } = judge(dir, { view: draft([run('CI', at(-1), 'IN_PROGRESS')]) }, command);
    assert.equal(reason, null, command);
    assert.equal(calls.length, 0, command);
  }
  const lifted = check('gh pr ready 7', { cwd: dir, env: { [OVERRIDE]: '1' }, forge: seam({}).forge, now: () => NOW });
  assert.equal(lifted, null, 'the ready hold\'s override lifts this hold too');
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-ready-checks-none-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const none = judge(outside, { view: draft([run('CI', at(-1), 'IN_PROGRESS')]) });
  assert.deepEqual([none.reason, none.calls.length], [null, 0], 'a folder in no project');
  // A call past its deadline lets it run.
  const late = seam({ view: draft([run('CI', at(-1), 'IN_PROGRESS')]) });
  assert.equal(check('gh pr ready 7', { cwd: dir, env: {}, forge: late.forge, now: () => NOW, startedAt: NOW - 5_000 }), null);
  assert.equal(late.calls.length, 0);
});

test('the MCP form holds draft false while a check is pending, and refuses a body edit in the same call', (t) => {
  const dir = repo(t);
  const given = { owner: 'acme', repo: 'notes', pullNumber: 7 };
  const mcp = (input, spec) => {
    const { calls, forge } = seam(spec);
    return { calls, reason: checkMcp(input, { cwd: dir, env: {}, forge, now: () => NOW }) };
  };
  const held = mcp({ ...given, draft: false }, { view: draft([run('CI', at(-1_000), 'IN_PROGRESS')]) });
  assert.match(held.reason ?? '', /#7 has checks that have not finished/u);
  assert.deepEqual(held.calls[0].slice(0, 3), ['pr', 'view', '7']);
  assert.ok(held.calls[0].includes('acme/notes'), 'the repository the call names');
  assert.equal(mcp({ ...given, draft: true }, { view: draft([run('CI', at(-1_000), 'IN_PROGRESS')]) }).reason, null);
  const both = mcp({ ...given, draft: false, body: 'new body' }, {});
  assert.deepEqual([both.reason, both.calls.length], [SAME_COMMAND_REASON, 0]);
  assert.equal(mcp({ ...given, draft: false }, { view: draft(GREEN), edits: {} }).reason, null);
});

// One hook run with the fake gh first on PATH, its calls logged.
function hookRun(dir, script, payload, spec) {
  const bin = path.join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_GH}" "$@"\n`, { mode: 0o755 });
  writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(spec));
  const log = path.join(dir, 'gh.log');
  writeFileSync(log, '');
  const result = spawnSync(process.execPath, [path.join(ROOT, 'plugins/aidrian/scripts', script)], {
    input: JSON.stringify({ session_id: 's', hook_event_name: 'PreToolUse', ...payload, cwd: dir }),
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, READY_CHECKS_SPEC: path.join(dir, 'spec.json'), READY_CHECKS_LOG: log, AIDRIAN_TELEMETRY: '0' },
  });
  return { ...result, calls: readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}

test('the Bash and GitHub MCP hooks hold a ready while a check is pending, in a project without product feedback', (t) => {
  const dir = repo(t);
  // Real time, since the hooks read the clock: the checks started a minute ago and the draft is old.
  const minuteAgo = new Date(Date.now() - 60_000).toISOString();
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const pending = { view: draft([run('Conventional Commit title', minuteAgo, 'IN_PROGRESS')], { createdAt: hourAgo }) };
  const bash = hookRun(dir, 'hook-bash.mjs', { tool_name: 'Bash', tool_input: { command: 'gh pr ready 7' } }, pending);
  assert.equal(bash.status, 2, bash.stderr);
  assert.match(bash.stderr, /Conventional Commit title/u);
  const mcp = hookRun(dir, 'hook-mcp-github.mjs', { tool_name: 'mcp__github__update_pull_request_draft_state', tool_input: { owner: 'acme', repo: 'notes', pullNumber: 7, draft: false } }, pending);
  assert.equal(mcp.status, 2, mcp.stderr);
  assert.match(mcp.stderr, /#7 has checks that have not finished/u);
  const green = hookRun(dir, 'hook-bash.mjs', { tool_name: 'Bash', tool_input: { command: 'gh pr ready 7' } },
    { view: draft([run('Conventional Commit title', minuteAgo)], { createdAt: hourAgo }), edits: { lastEditedAt: hourAgo } });
  assert.equal(green.status, 0, green.stderr);
  assert.equal(green.calls.length, 2, green.calls.join('\n'));
});
