// The merge guard and the review gate on Codex's GitHub app connector, through the real hook. The connector names its tools and
// their inputs its own way, so without the fix each of these passed unchecked. The payloads are test/fixtures/hosts/codex/github.json,
// which says what they come from: no hook on Codex has run them (docs/providers/codex.md#github-through-the-app-connector).

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { githubCall, HOSTS, UNKNOWN_HOST } from '../plugins/aidrian/lib/hosts/index.mjs';
import { projectAt } from '../plugins/aidrian/lib/project.mjs';
import { emptyState, writeLocalState } from '../plugins/aidrian/lib/review/state.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const RECORDED = JSON.parse(readFileSync(path.join(ROOT, 'test/fixtures/hosts/codex/github.json'), 'utf8'));
const MATCHER = JSON.parse(readFileSync(path.join(ROOT, 'plugins/aidrian/hooks/hooks.json'), 'utf8')).hooks.PreToolUse
  .find((group) => group.hooks.some(({ command }) => command.includes('hook-mcp-github.mjs'))).matcher;
const HEAD = RECORDED.merge.tool_input.expected_head_sha;

// A git repository with an origin, holding a project whose state folder lies beside it.
function repo(t, config = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-github-app-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'repo');
  mkdirSync(dir);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('remote', 'add', 'origin', 'git@github.com:Acme/Notes.git');
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: '../state' }, ...config }));
  return dir;
}

// Pull request 5 owes a bot review the Human asked for and nobody sent.
function owed(dir) {
  const state = emptyState(5, 'acme/notes');
  state.pending.push({ kind: 'request', head: HEAD, at: '2026-11-03T13:50:00.000Z', by: 'the Human' });
  writeLocalState(projectAt(dir), state);
}

const hook = (dir, call, change = {}, env = {}) => spawnSync(process.execPath, [path.join(ROOT, 'plugins/aidrian/scripts/hook-mcp-github.mjs')], {
  input: JSON.stringify({ ...RECORDED.pre, cwd: dir, tool_name: call.tool_name, tool_input: { ...call.tool_input, ...change } }),
  encoding: 'utf8',
  env: { ...process.env, ...RECORDED.env, AIDRIAN_TELEMETRY: '0', ...env },
});

test('the payloads say they are not live', () => {
  assert.equal(RECORDED.live, false);
  assert.match(RECORDED.provenance, /^NOT LIVE/u);
});

test('the merge guard holds a merge through the connector, on its own fields', (t) => {
  const dir = repo(t);
  owed(dir);
  const denied = hook(dir, RECORDED.merge);
  assert.equal(denied.status, 2, denied.stderr);
  assert.match(denied.stderr, /pull request #5 at abcdef1/u);
  assert.match(denied.stderr, /never sent/u);
  assert.equal(hook(dir, RECORDED.merge, { pr_number: 6 }).status, 0, 'another pull request');
  assert.equal(hook(dir, RECORDED.merge, { repository_full_name: 'other/notes' }).status, 0, 'its repository is read');
});

test('the name the model sees is held as well, in case Codex sends that one', (t) => {
  const dir = repo(t);
  owed(dir);
  const flat = { ...RECORDED.merge, tool_name: 'mcp__codex_apps__github_merge_pull_request' };
  assert.equal(hook(dir, flat).status, 2);
});

test('a merge through the connector whose number it cannot read is refused', (t) => {
  const denied = hook(repo(t), RECORDED.merge, { pr_number: 'five' });
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /could not read/u);
});

test('turning on auto-merge through the connector counts as a merge, as gh pr merge --auto does', (t) => {
  const dir = repo(t);
  owed(dir);
  // That tool names no head, so the guard reads it through gh, which answers here from a script.
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho '{"number":5,"headRefOid":"${HEAD}"}'\n`, { mode: 0o755 });
  const denied = hook(dir, RECORDED.autoMerge, {}, { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  assert.equal(denied.status, 2, denied.stderr);
  assert.match(denied.stderr, /pull request #5 at abcdef1/u);
  assert.match(denied.stderr, /never sent/u);
});

for (const call of RECORDED.comments) {
  test(`the review-round rule reads ${call.tool_name} on its own text field`, (t) => {
    const dir = repo(t, { github: { reviewer: 'chatgpt-codex-connector[bot]' } });
    const denied = hook(dir, call, { [call.field]: '@codex review' });
    assert.equal(denied.status, 2, denied.stderr);
    assert.match(denied.stderr, /aidrian pr await-review --request/u);
    assert.equal(hook(dir, call, { [call.field]: 'thanks' }).status, 0);
  });

  test(`the review gate reads the pull request and repository of ${call.tool_name}`, (t) => {
    const dir = repo(t, { github: { reviewer: 'none', reviewGate: { enabled: true, checklist: 'docs/review-checklist.md' } } });
    const denied = hook(dir, call, { [call.field]: '@codex review' });
    assert.equal(denied.status, 2, denied.stderr);
    assert.match(denied.stderr, /pull request #5, and no review/u);
    const elsewhere = { [call.field]: '@codex review', repo_full_name: 'other/notes' };
    assert.equal(hook(dir, call, elsewhere).status, 0, 'a request to another repository passes');
  });
}

test('every name the matcher lists is one the hook judges, and the matcher is a plain list on both hosts', () => {
  assert.match(MATCHER, /^[A-Za-z0-9_|]+$/u, 'no regular expression: each host then compares whole names');
  for (const name of MATCHER.split('|')) {
    const standard = UNKNOWN_HOST.toolName(name);
    const { tool } = githubCall(standard, {});
    assert.match(tool, /^mcp__github__/u, `${name} reaches the hook and nothing there reads it`);
  }
});

test('a host with connector tools has each of them in the matcher, in both forms', () => {
  const tools = HOSTS.flatMap((host) => Object.keys(host.githubTools ?? {}).map((standard) => [host, standard]));
  assert.ok(tools.length > 0);
  for (const [host, standard] of tools) {
    assert.ok(MATCHER.split('|').includes(host.rawToolName(standard)), host.rawToolName(standard));
    assert.ok(MATCHER.split('|').includes(host.nativeToolName(standard)), host.nativeToolName(standard));
  }
});

test('a standard call stays as it is, and an unreadable repository names none', () => {
  const given = { owner: 'acme', repo: 'notes', pullNumber: 5 };
  assert.deepEqual(githubCall('mcp__github__merge_pull_request', given), { tool: 'mcp__github__merge_pull_request', given });
  const { given: read } = githubCall('mcp__codex_apps_github__merge_pull_request', { repository_full_name: 'not-a-repo', pr_number: 5 });
  assert.equal(read.owner, undefined);
  assert.equal(read.repo, undefined);
  assert.equal(read.pullNumber, 5);
});
