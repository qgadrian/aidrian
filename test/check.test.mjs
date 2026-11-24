import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isNativeOnly, isScreenFile } from '../plugins/aidrian/lib/screen-check.mjs';
import { isIgnored } from '../plugins/aidrian/lib/git.mjs';
import { cliCall } from './cli-call.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXAMPLE = path.join(ROOT, 'examples/consumer');
const CLI = path.join(ROOT, 'plugins/aidrian/bin/aidrian');
const XDG = path.join(tmpdir(), 'aidrian-check-state');
const STATE = new RegExp(`^${XDG}/aidrian/projects/[a-z0-9-]+-[0-9a-f]{8}$`);
const REPOSITORY = JSON.parse(readFileSync(path.join(ROOT, 'plugins/aidrian/plugin.json'), 'utf8')).repository;

// A command in the test's process (test/cli-call.mjs), and one as a process: runProcess is kept where only a process shows
// the behaviour, docs/test-processes.md#commands-in-the-tests-process, and each one says why.
const run = (args, cwd) => cliCall(args, { cwd, env: { ...process.env, XDG_STATE_HOME: XDG } });
const runProcess = (args, cwd) => spawnSync(CLI, args, { cwd, encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: XDG } });
const ok = (stdout) => stdout.split('\n')[0];
const stateLine = (stdout) => stdout.split('\n')[1].replace(/^state: /, '');
// The record commands' refusal, which the check prints as a warning.
const insideText = (top) => `the state folder is inside this repository's checkout ${top}, and the review record is read from it: in .aidrian/config.json, set "state": { "dir": null } for the default folder, or any folder outside every checkout of this repository, and commit that change alone in its own pull request, which gets no local review record, so the Human merges it. Once it lands, on each machine, from a clean checkout on the base branch, move the old folder's contents to the folder \`aidrian state\` prints.`;

// A git repository with the example consumer's project folder, docs, and .gitignore copied in.
function exampleRepo(t) {
  // realpath: git prints real paths, and on macOS the temp folder is behind a symlink.
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-check-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  for (const entry of ['.aidrian', 'docs', '.gitignore']) cpSync(path.join(EXAMPLE, entry), path.join(dir, entry), { recursive: true });
  return dir;
}

// A git repository with the example's .gitignore and one bucket of one untagged 40-byte doc.
function tempRepo(t) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-check-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  cpSync(path.join(EXAMPLE, '.gitignore'), path.join(dir, '.gitignore'));
  mkdirSync(path.join(dir, '.aidrian/knowledge'), { recursive: true });
  mkdirSync(path.join(dir, 'kb'));
  writeFileSync(path.join(dir, 'kb/ref.md'), '# Reference\n\nA long reference doc here.\n');
  writeFileSync(path.join(dir, '.aidrian/knowledge/kb.json'), JSON.stringify({ dir: 'kb', description: 'Ref.', docs: { 'ref.md': { summary: 'The reference.' } } }));
  return dir;
}

test('check passes on a copy of the example consumer in its own repository', async (t) => {
  const dir = exampleRepo(t);
  // As a process, so the check command stays tested through bin/aidrian's own entry, the exit code it sets, and what it writes.
  const { status, stdout, stderr } = runProcess(['check'], path.join(dir, 'docs'));
  assert.deepEqual([status, ok(stdout), stderr], [0, 'ok: .aidrian (2 buckets, 8 docs)', '']);
  assert.match(stateLine(stdout), STATE);
  assert.match(stdout.split('\n')[2], /^budget: \d+ of 16384 always-doc bytes \(engineering \d+, product 0\)$/);
  assert.equal(stdout.split('\n').length, 4);
});

test('check fails, and session start warns, when the running plugin is older than the version config.json requires', async (t) => {
  const dir = exampleRepo(t);
  const file = path.join(dir, '.aidrian/config.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...config, requires: { aidrian: '999.0.0' } }));
  const { status, stderr } = await run(['check'], dir);
  assert.equal(status, 1);
  assert.match(stderr, /^this project requires aidrian 999\.0\.0 or later, and this session runs \d+\.\d+\.\d+ from \S+plugins\/aidrian: update the plugin, then start a new session$/mu);
  const hook = spawnSync(process.execPath, [path.join(ROOT, 'plugins/aidrian/scripts/hook-session-start.mjs')], { input: JSON.stringify({ cwd: dir }), encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: XDG } });
  assert.match(hook.stdout, /^Plugin too old: this project requires aidrian 999\.0\.0 or later/mu);
  writeFileSync(file, JSON.stringify({ ...config, requires: { aidrian: '0.1.0' } }));
  assert.equal((await run(['check'], dir)).status, 0, 'a floor at or below the running plugin passes');
  writeFileSync(file, JSON.stringify({ ...config, requires: { aidrian: 'latest' } }));
  assert.match((await run(['check'], dir)).stderr, /"requires\.aidrian" must be a plugin version such as "0\.17\.0", or null/u);
});

test('check warns past the knowledge budgets, and fails when the always docs pass twice theirs', async (t) => {
  const dir = exampleRepo(t);
  const bytes = (doc) => statSync(path.join(dir, 'docs/knowledge', doc)).size;
  const always = bytes('engineering/working-agreement.md');
  // branches-and-reviews.md is the largest tagged doc of the example, so it is the only one over this limit.
  const largest = bytes('engineering/branches-and-reviews.md');
  const check = async (budgets) => {
    writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, knowledge: { budgets } }));
    return run(['check'], dir);
  };
  const warned = await check({ alwaysBytes: always - 1, taggedDocBytes: largest - 1 });
  assert.equal(warned.status, 0);
  assert.match(warned.stdout, new RegExp(`\nbudget: ${always} of ${always - 1} always-doc bytes \\(engineering ${always}, product 0\\)\n$`));
  assert.deepEqual(warned.stderr.split('\n'), [
    `warning: always docs: ${always} bytes, over knowledge.budgets.alwaysBytes (${always - 1}); every session and subagent reads them: ` +
      'keep one or two short docs, and move the rest behind tags or to search',
    `warning: docs/knowledge/engineering/branches-and-reviews.md: ${largest} bytes, over knowledge.budgets.taggedDocBytes (${largest - 1}); ` +
      'every route to orchestration, review reads it whole: split it into a short rule card and a reference, or drop its tags so only search finds it',
    '',
  ]);
  const failed = await check({ alwaysBytes: Math.floor((always - 1) / 2) });
  assert.deepEqual([failed.status, failed.stdout], [1, '']);
  assert.match(failed.stderr, new RegExp(`^always docs: ${always} bytes, over twice knowledge\\.budgets\\.alwaysBytes \\(${Math.floor((always - 1) / 2)}\\); `));
});

test('knowledge.budgets.enforce "fail" makes an over-budget doc an error, and a pinned doc fails only once it grows', async (t) => {
  const dir = exampleRepo(t);
  const doc = 'docs/knowledge/engineering/branches-and-reviews.md';
  const largest = statSync(path.join(dir, doc)).size;
  const file = path.join(dir, '.aidrian/config.json');
  const check = async (budgets) => {
    writeFileSync(file, JSON.stringify({ version: 1, knowledge: { budgets: { taggedDocBytes: largest - 1, ...budgets } } }));
    return run(['check'], dir);
  };
  const over = `${doc}: ${largest} bytes, over knowledge.budgets.taggedDocBytes (${largest - 1})`;
  const escaped = over.replace(/[.()]/gu, '\\$&');
  assert.equal((await check({})).status, 0, 'the default, "warn", still passes');
  const failed = await check({ enforce: 'fail' });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, new RegExp(`^${escaped}; every route to orchestration, review reads it whole`, 'mu'));

  const pinned = await check({ enforce: 'fail', baseline: { [doc]: largest } });
  assert.deepEqual([pinned.status, pinned.stderr.split('\n')[0]], [0, `warning: ${over}, pinned in knowledge.budgets.baseline: every route to orchestration, review reads it whole: split it into a short rule card and a reference, or drop its tags so only search finds it`]);
  const grown = await check({ enforce: 'fail', baseline: { [doc]: largest - 1 } });
  assert.equal(grown.status, 1, 'a doc past its pin fails');
  assert.match(grown.stderr, new RegExp(`^${escaped}, and past its pin in knowledge\\.budgets\\.baseline \\(${largest - 1}\\); a pinned doc may only shrink`, 'mu'));
  const slack = await check({ enforce: 'fail', baseline: { [doc]: largest + 10, 'docs/gone.md': 5 } });
  assert.equal(slack.status, 0);
  assert.deepEqual(slack.stderr.split('\n').slice(0, 2), [
    `warning: ${over}, pinned at ${largest + 10} in knowledge.budgets.baseline: lower the pin to ${largest}; run aidrian lint budget --pin`,
    'warning: knowledge.budgets.baseline pins docs/gone.md, which is not an indexed doc: drop the pin; run aidrian lint budget --pin',
  ]);

  writeFileSync(path.join(dir, 'docs/knowledge/engineering/branches-and-reviews.md'), 'small\n');
  const always = statSync(path.join(dir, 'docs/knowledge/engineering/working-agreement.md')).size;
  writeFileSync(file, JSON.stringify({ version: 1, knowledge: { budgets: { enforce: 'fail', alwaysBytes: always - 1 } } }));
  assert.match((await run(['check'], dir)).stderr, new RegExp(`^always docs: ${always} bytes, over knowledge\\.budgets\\.alwaysBytes \\(${always - 1}\\)`, 'mu'), 'under "fail" the always total over its budget is an error too');
  assert.match((await check({ enforce: 'nope' })).stderr, /"knowledge\.budgets\.enforce" must be "warn" or "fail"/u);
  assert.match((await check({ baseline: { [doc]: 0 } })).stderr, /"knowledge\.budgets\.baseline" must be an object of doc paths, each to a whole number of bytes above 0/u);
});

test('knowledge.budgets.untaggedDocBytes caps the docs only search finds', async (t) => {
  const dir = tempRepo(t);
  const check = async (budgets) => {
    writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, knowledge: { budgets } }));
    return run(['check'], dir);
  };
  const note = 'note: 1 of 1 docs have no tags; no agent routes to them\n';
  assert.deepEqual([(await check({})).status, (await check({})).stderr], [0, note], 'no cap by default');
  const capped = await check({ untaggedDocBytes: 10, enforce: 'fail' });
  assert.deepEqual([capped.status, capped.stderr], [1, `${note}kb/ref.md: 40 bytes, over knowledge.budgets.untaggedDocBytes (10); agents read it whole once search finds it: split it by topic\n`]);
});

test('check passes on a config without tracker, and names the key of each tracker problem', async (t) => {
  const dir = exampleRepo(t);
  const check = async (config) => {
    writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, ...config }));
    return run(['check'], dir);
  };
  assert.deepEqual([(await check({})).status, (await check({})).stderr], [0, '']);
  const save = ['mcp__tracker__save_*'];
  const read = ['mcp__tracker__get_workspace'];
  const workspace = { expect: 'https://tracker.example/acme', field: 'url' };
  assert.equal((await check({ tracker: { enabled: true, workspace, readTools: read, writeTools: save } })).status, 0);
  const cases = [
    [{ enabled: 'yes' }, '"tracker.enabled" must be true or false'],
    [{ writeTools: ['mcp__*__save'] }, '"tracker.writeTools" has "mcp__*__save": a "*" can only end a pattern, as in mcp__github__*'],
    [{ workspace }, '"tracker.workspace" needs "tracker.readTools", the tools that read the connected workspace'],
    [{ readTools: read }, '"tracker.readTools" needs "tracker.workspace", the value those tools must report'],
    [{ enabled: true }, '"tracker.enabled" needs "tracker.writeTools", the tools the guard watches'],
    [{ enabled: true, writeTools: save }, '"tracker.enabled" needs one of "tracker.workspace", "tracker.team", or "tracker.project", the values a write is held to'],
    [{ enabled: true, writeTools: save, team: 'Notes' }, '"tracker.team" must be an object, or null'],
    [{ writeTools: ['Bash(git push)'] }, '"tracker.writeTools" has "Bash(git push)": a tracker tool is an MCP tool, so its pattern starts with "mcp__"'],
    [{ readTools: null }, '"tracker.readTools" must be a list of tool names'],
    [{ workspace: [] }, '"tracker.workspace" must be an object, or null'],
    [{ workspace, readTools: ['mcp__tracker__get_*'] }, '"tracker.readTools" has "mcp__tracker__get_*": a read tool is an exact tool name, with no "*"'],
    [{ workspace, readTools: read, writeTools: ['mcp__*'] }, '"tracker.readTools" has "mcp__tracker__get_workspace": a read tool cannot also match "tracker.writeTools", and "mcp__*" covers it'],
    [{ team: { key: 'NOTES-1', values: ['Notes'], createFields: ['team'], keyFields: ['id'] } }, '"tracker.team.key" must be a non-empty string with no hyphen or whitespace, such as NOTES'],
  ];
  for (const [tracker, problem] of cases) {
    const { status, stdout, stderr } = await check({ tracker });
    assert.deepEqual([status, stdout, stderr], [1, '', `.aidrian/config.json: ${problem}\n`], JSON.stringify(tracker));
  }
  const guarded = await check({ github: { autoMerge: { includeGuardedPaths: 'yes' } } });
  assert.equal(guarded.status, 1);
  assert.match(guarded.stderr, /"github\.autoMerge\.includeGuardedPaths" must be true or false/u);
});

test('check flags each write tool no read can clear, and only while the read rule applies', async (t) => {
  const dir = exampleRepo(t);
  const check = async (tracker) => {
    writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, tracker }));
    return run(['check'], dir);
  };
  const workspace = { expect: 'https://tracker.example/acme', field: 'url' };
  const team = { key: 'NOTES', values: ['Notes'], createFields: ['team'], keyFields: ['id'] };
  const readTools = ['mcp__a__read'];
  const noRead = (pattern) => `.aidrian/config.json: "tracker.writeTools" has "${pattern}": no tool in "tracker.readTools" is on its server, so no read can clear it\n`;
  const noServer = (pattern) => `.aidrian/config.json: "tracker.writeTools" has "${pattern}": it names no server, as in mcp__<server>__<tool>, so no read can clear it\n`;

  for (const pattern of ['mcp__b__save', 'mcp__b__save_*', 'mcp__b__*', 'mcp__a_b__save', 'mcp__a_b__*']) {
    const { status, stdout, stderr } = await check({ enabled: true, workspace, readTools, writeTools: [pattern] });
    assert.deepEqual([status, stdout, stderr], [1, '', noRead(pattern)], pattern);
  }
  for (const pattern of ['mcp__solo', 'mcp__solo_save', 'mcp__solo_']) {
    const { status, stdout, stderr } = await check({ enabled: true, workspace, readTools, writeTools: [pattern] });
    assert.deepEqual([status, stdout, stderr], [1, '', noServer(pattern)], pattern);
  }
  const several = await check({ workspace, readTools, writeTools: ['mcp__a__save_*', 'mcp__b__save_*', 'mcp__solo', 'mcp__c__*'] });
  assert.deepEqual([several.status, several.stderr], [1, `${noRead('mcp__b__save_*')}${noServer('mcp__solo')}${noRead('mcp__c__*')}`], 'each entry that cannot pass, with enabled off too');

  const passing = [
    ['a write on a read tool\'s server', ['mcp__a__save', 'mcp__a__save_*']],
    ['a * before the server name ends', ['mcp__b*', 'mcp__b_*']],
  ];
  for (const [label, writeTools] of passing) {
    const { status, stderr } = await check({ enabled: true, workspace, readTools, writeTools });
    assert.deepEqual([status, stderr], [0, ''], label);
  }
  const noWorkspace = await check({ enabled: true, team, writeTools: ['mcp__solo', 'mcp__b__save_*'] });
  assert.deepEqual([noWorkspace.status, noWorkspace.stderr], [0, ''], 'with no workspace there is no read rule');
  const badRead = await check({ workspace, readTools: [...readTools, 'mcp__a__get_*'], writeTools: ['mcp__b__save'] });
  assert.deepEqual([badRead.status, badRead.stderr], [1, '.aidrian/config.json: "tracker.readTools" has "mcp__a__get_*": a read tool is an exact tool name, with no "*"\n'], 'a bad read tool unsets the read rule, so it raises no second error');
});

test('check passes a tracker that lists both spellings of a server for reads and writes', async (t) => {
  const dir = exampleRepo(t);
  const tracker = {
    enabled: true,
    workspace: { expect: 'https://linear.app/acme', field: 'url' },
    readTools: ['mcp__plugin_linear_linear__get_workspace', 'mcp__linear__get_workspace'],
    writeTools: ['mcp__plugin_linear_linear__save_*', 'mcp__plugin_linear_linear__create_*', 'mcp__plugin_linear_linear__delete_*', 'mcp__linear__save_*', 'mcp__linear__create_*', 'mcp__linear__delete_*'],
    team: { key: 'NOTES', values: ['Notes'], createFields: ['team'], keyFields: ['id', 'issueId'] },
    project: { values: ['Notes launch'], field: 'project' },
  };
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, tracker }));
  const { status, stderr } = await run(['check'], dir);
  assert.deepEqual([status, stderr], [0, '']);
});

// The project's own OpenCode config sets OpenCode up for it, whichever host's shell runs the check
// (lib/hosts/opencode-setup.mjs), so the check warns of the tracker writes no hook reaches there.
test('check warns of OpenCode\'s unguarded tracker route once the project\'s OpenCode config names this plugin', async (t) => {
  const dir = exampleRepo(t);
  const tracker = { enabled: true, provider: 'linear', workspace: { expect: 'https://linear.app/acme' }, team: { key: 'NOTES', values: ['Notes'] } };
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, tracker }));
  assert.deepEqual(await run(['check'], dir).then(({ status, stderr }) => [status, stderr]), [0, ''], 'no OpenCode config');
  writeFileSync(path.join(dir, 'opencode.json'), JSON.stringify({ plugins: ['github:acme/aidrian#main::path:plugins/aidrian'] }));
  const { status, stderr } = await run(['check'], dir);
  assert.equal(status, 0, stderr);
  assert.match(stderr, /^warning: tracker\.enabled: on OpenCode, a write through any MCP tool passes unchecked: the bridge forwards no MCP tool call to a hook in this version$/mu);
  assert.match(stderr, /^warning: tracker\.enabled: nobody has verified the guard on OpenCode/mu);
});

// No aidrian guard holds an OpenCode session, which the tracker's one route understates: the check names that gap
// wherever OpenCode is set up, with no tracker on.
const UNGUARDED = /^warning: OpenCode is set up here, and no merge guard, Bash rule, or write guard holds an OpenCode session: work there only in a task worktree, and never merge from it \(docs\/providers\/opencode\.md#limits\)$/mu;
test('check warns that no guard holds an OpenCode session once OpenCode is set up, with no tracker too', async (t) => {
  const dir = exampleRepo(t);
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1 }));
  assert.deepEqual(await run(['check'], dir).then(({ status, stderr }) => [status, stderr]), [0, ''], 'no OpenCode config');
  mkdirSync(path.join(dir, '.opencode'));
  writeFileSync(path.join(dir, '.opencode/opencode.jsonc'), '{ "plugins": ["aidrian"] }');
  const { status, stderr } = await run(['check'], dir);
  assert.equal(status, 0, stderr);
  assert.match(stderr, UNGUARDED);
  assert.equal(stderr.match(new RegExp(UNGUARDED.source, 'gmu'))?.length, 1, 'once');
});

// OpenCode reads the config of every folder above the one a session starts in, so a project nested below a folder
// whose config names this plugin is set up too.
test('check finds OpenCode set up by the config of a folder above the project', async (t) => {
  const outer = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-check-outer-')));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  const dir = path.join(outer, 'work', 'app');
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  for (const entry of ['.aidrian', 'docs', '.gitignore']) cpSync(path.join(EXAMPLE, entry), path.join(dir, entry), { recursive: true });
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1 }));
  assert.doesNotMatch((await run(['check'], dir)).stderr, UNGUARDED, 'no OpenCode config');
  mkdirSync(path.join(outer, '.opencode'));
  writeFileSync(path.join(outer, '.opencode/opencode.json'), JSON.stringify({ plugins: ['github:acme/aidrian#main::path:plugins/aidrian'] }));
  assert.match((await run(['check'], dir)).stderr, UNGUARDED, 'the .opencode folder two folders above');
});

test('check finds OpenCode set up by the config file OPENCODE_CONFIG names', async (t) => {
  const dir = exampleRepo(t);
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1 }));
  const elsewhere = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-check-config-')));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  const file = path.join(elsewhere, 'team.jsonc');
  writeFileSync(file, '{ "plugins": ["aidrian"], }');
  const checked = (env) => cliCall(['check'], { cwd: dir, env: { ...process.env, XDG_STATE_HOME: XDG, ...env } });
  assert.doesNotMatch((await checked({})).stderr, UNGUARDED, 'with no OPENCODE_CONFIG');
  assert.match((await checked({ OPENCODE_CONFIG: file })).stderr, UNGUARDED, 'the file OPENCODE_CONFIG names');
  assert.doesNotMatch((await checked({ OPENCODE_CONFIG: 'team.jsonc' })).stderr, UNGUARDED, 'a relative OPENCODE_CONFIG names no file');
});

test('state prints the state folder, with or without a project folder', async (t) => {
  const dir = exampleRepo(t);
  // As a process, so the state command stays tested through bin/aidrian's own entry.
  const { status, stdout } = runProcess(['state'], path.join(dir, 'docs'));
  assert.equal(status, 0);
  assert.match(stdout.trim(), STATE);
  assert.equal(stdout.trim(), stateLine((await run(['check'], dir)).stdout));
  assert.match((await run(['state'], tmpdir())).stdout.trim(), STATE);
});

test('check names the missing .gitignore line for the local sources file, and for a state folder inside the repository', async (t) => {
  const dir = exampleRepo(t);
  writeFileSync(path.join(dir, '.gitignore'), '');
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: '.state' } }));
  const { status, stdout, stderr } = await run(['check'], dir);
  assert.deepEqual([status, stdout], [1, '']);
  assert.equal(
    stderr,
    `warning: ${insideText(dir)}\n` +
      '.aidrian.local.json is not git-ignored: add the line ".aidrian.local.json" to .gitignore, or run aidrian init\n' +
      '.state/ is not git-ignored: in .aidrian/config.json set "state": { "dir": null } to move the state folder out of the repository, or while it stays add the line ".state/" to .gitignore, or run aidrian init\n' +
      '.worktrees/ is not git-ignored: add the line ".worktrees/" to .gitignore, or run aidrian init\n',
  );
  assert.match((await run(['init'], dir)).stdout, /^added to \.gitignore: \.aidrian\.local\.json, \.state\/, \.worktrees\/\n/);
  assert.equal(stateLine((await run(['check'], dir)).stdout), path.join(dir, '.state'));
});

test('a nested project ignores a state folder outside it in the repository root .gitignore', async (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-check-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  mkdirSync(path.join(dir, 'app/.aidrian'), { recursive: true });
  writeFileSync(path.join(dir, 'app/.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: '.state' } }));
  const init = await run(['init'], path.join(dir, 'app'));
  assert.equal(init.stdout, 'added to .gitignore: .aidrian.local.json\nadded to ../.gitignore: .state/, .worktrees/\n' +
    'next: add a knowledge index with aidrian-knowledge init <folder of docs>, then run aidrian check\n');
  assert.equal(readFileSync(path.join(dir, '.gitignore'), 'utf8'), '.state/\n.worktrees/\n');
  const checked = await run(['check'], path.join(dir, 'app'));
  assert.equal(checked.status, 0);
  assert.equal(checked.stderr, `warning: ${insideText(dir)}\n`);
});

test('check warns with the refusal\'s text on a state folder inside the repository, and still passes', async (t) => {
  const dir = exampleRepo(t);
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: '.state' } }));
  await run(['init'], dir);
  const { status, stdout, stderr } = await run(['check'], dir);
  assert.equal(status, 0, stderr);
  assert.equal(stderr, `warning: ${insideText(dir)}\n`);
  assert.deepEqual([ok(stdout), stateLine(stdout)], ['ok: .aidrian (2 buckets, 8 docs)', path.join(dir, '.state')]);
  // A folder outside the repository, or none set, says nothing.
  for (const config of [{ version: 1 }, { version: 1, state: { dir: null } }, { version: 1, state: { dir: '../elsewhere' } }]) {
    writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify(config));
    assert.equal((await run(['check'], dir)).stderr, '', JSON.stringify(config));
  }
});

test('check gives the default state folder inside the repository its own words, and sets no null state.dir as the way out', async (t) => {
  const dir = exampleRepo(t);
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1 }));
  const env = { ...process.env, XDG_STATE_HOME: path.join(dir, '.machine') };
  const checked = () => cliCall(['check'], { cwd: dir, env });
  const warning = `warning: the default state folder is inside this repository's checkout ${dir}, and the review record is read from it: in .aidrian/config.json, set "state": { "dir": "<path>" } to a folder outside every checkout of this repository, and commit that change alone in its own pull request, which gets no local review record, so the Human merges it, or set this machine's state root, \`$XDG_STATE_HOME\`, to a folder outside them. Once it is outside, on each machine whose folder moved, from a clean checkout on the base branch, move the old folder's contents to the folder \`aidrian state\` prints.\n`;
  const unignored = await checked();
  assert.equal(unignored.status, 1);
  assert.ok(unignored.stderr.startsWith(warning), unignored.stderr);
  assert.match(unignored.stderr, /^\.machine\/aidrian\/projects\/\S+\/ is not git-ignored: add the line /mu);
  assert.doesNotMatch(unignored.stderr, /"dir": null/u);
  writeFileSync(path.join(dir, '.gitignore'), `${readFileSync(path.join(dir, '.gitignore'), 'utf8')}\n.machine/\n`);
  const passing = await checked();
  assert.deepEqual([passing.status, passing.stderr], [0, warning]);
});

test('check from a linked worktree warns about a relative state folder in the main checkout', async (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-check-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const main = path.join(dir, 'main');
  const git = (...args) => execFileSync('git', ['-C', main, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args]);
  execFileSync('git', ['init', '-q', '-b', 'main', main]);
  mkdirSync(path.join(main, '.aidrian'));
  writeFileSync(path.join(main, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: '.state' } }));
  writeFileSync(path.join(main, '.gitignore'), '.aidrian.local.json\n.worktrees/\n.state/\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  const tree = path.join(dir, 'tree');
  git('worktree', 'add', '-q', '-b', 'task', tree);
  const { status, stderr, stdout } = await run(['check'], tree);
  assert.equal(status, 0, stderr);
  assert.equal(stderr, `warning: ${insideText(main)}\n`, 'the warning names the main checkout, and the ignore check adds no error');
  assert.equal(stateLine(stdout), path.join(main, '.state'));
});

test('check says nothing of a state folder when git cannot list the checkouts', async (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-check-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: '.state' } }));
  writeFileSync(path.join(dir, '.gitignore'), '.aidrian.local.json\n.worktrees/\n.state/\n');
  const outside = await run(['check'], dir);
  assert.deepEqual([outside.status, outside.stderr], [0, ''], 'outside a repository');

  execFileSync('git', ['init', '-q', dir]);
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" worktree list "*) exit 1;; esac\nexec "${real}" "$@"\n`, { mode: 0o755 });
  const stopped = await cliCall(['check'], { cwd: dir, env: { ...process.env, XDG_STATE_HOME: XDG, PATH: `${bin}:${process.env.PATH}` } });
  assert.deepEqual([stopped.status, stopped.stderr], [0, ''], 'a list git cannot answer');
});

test('init in a linked worktree writes only inside that worktree, never the main checkout .gitignore', async (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-check-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const main = path.join(dir, 'main');
  const git = (...args) => execFileSync('git', ['-C', main, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
  execFileSync('git', ['init', '-q', '-b', 'main', main]);
  writeFileSync(path.join(main, '.gitignore'), 'node_modules/\n');
  git('add', '.gitignore');
  git('commit', '-q', '-m', 'init');
  const tree = path.join(dir, 'tree');
  git('worktree', 'add', '-q', '-b', 'task', tree);
  const init = await run(['init'], tree);
  assert.equal(init.status, 0, init.stderr);
  assert.equal(readFileSync(path.join(main, '.gitignore'), 'utf8'), 'node_modules/\n', 'the main checkout .gitignore is untouched');
  assert.equal(existsSync(path.join(main, '.aidrian')), false, 'no project folder in the main checkout');
  assert.ok(existsSync(path.join(tree, '.aidrian/config.json')));
  assert.equal(readFileSync(path.join(tree, '.gitignore'), 'utf8'), 'node_modules/\n.aidrian.local.json\n');
  assert.doesNotMatch(init.stdout, /\.\.\/main|\.worktrees/);
  assert.equal((await run(['check'], tree)).status, 0);
});

test('check follows worktrees.dir: a folder inside the project needs a line, one outside the repository needs none', async (t) => {
  const dir = exampleRepo(t);
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, git: { worktrees: { dir: 'trees' } } }));
  assert.equal((await run(['check'], dir)).stderr, 'trees/ is not git-ignored: add the line "trees/" to .gitignore, or run aidrian init\n');
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, git: { worktrees: { dir: '../trees' } } }));
  assert.equal((await run(['check'], dir)).status, 0);
});

test('check names a bad name in config.json and in .aidrian.local.json', async (t) => {
  const dir = exampleRepo(t);
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, names: { human: '' } }));
  writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify({ names: { robot: 'the agent' } }));
  const { status, stdout, stderr } = await run(['check'], dir);
  assert.deepEqual([status, stdout], [1, '']);
  assert.equal(stderr, '.aidrian/config.json: "names.human" must be a non-empty string\n.aidrian.local.json: unknown key "names.robot"\n');
});

test('check names a bad agent gate in config.json and in .aidrian.local.json', async (t) => {
  const dir = exampleRepo(t);
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, agents: { explorer: { deny: ['Bash(git *)'] } } }));
  writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify({ agents: { main: { only: ['Read'] } } }));
  const { status, stdout, stderr } = await run(['check'], dir);
  assert.deepEqual([status, stdout], [1, '']);
  assert.equal(
    stderr,
    '.aidrian/config.json: "agents.explorer.deny" has "Bash(git *)": Bash(...) takes a command prefix without "*", such as Bash(git push)\n'
      + '.aidrian.local.json: unknown key "agents.main.only"\n',
  );
});

test('check fails on a version this plugin does not read, and reads no index then', async (t) => {
  const dir = exampleRepo(t);
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 2 }));
  writeFileSync(path.join(dir, '.aidrian/knowledge/engineering.json'), '{"a format": "of version 2"}');
  const { status, stderr } = await run(['check'], dir);
  assert.equal(status, 1);
  assert.equal(
    stderr,
    '.aidrian/config.json: project folder version 2; this plugin reads version 1; ' +
      `see ${REPOSITORY}/blob/main/docs/project-folder.md#migrating\n`,
  );
});

test('check warns on a tag outside the vocabulary, untagged docs, and a placeholder description, and still passes', async (t) => {
  const dir = exampleRepo(t);
  const file = path.join(dir, '.aidrian/knowledge/product.json');
  const index = JSON.parse(readFileSync(file, 'utf8'));
  index.description = 'Docs in docs/knowledge/product.';
  index.docs['product-rules.md'].tags = ['prodcut_sensitive', 'billing'];
  index.docs['sharing.md'].tags = [];
  writeFileSync(file, JSON.stringify(index));
  const { status, stderr } = await run(['check'], dir);
  assert.equal(status, 0);
  assert.deepEqual(stderr.split('\n'), [
    'warning: .aidrian/knowledge/product.json: "description" is still the placeholder "Docs in docs/knowledge/product."; say what the bucket covers',
    'warning: docs/knowledge/product/product-rules.md: tag "prodcut_sensitive" is not one the plugin asks for; did you mean "product_sensitive"?',
    'warning: docs/knowledge/product/product-rules.md: tag "billing" is not one the plugin asks for; only a skill or dispatch of your own routes to it',
    'note: 1 of 8 docs have no tags; no agent routes to them',
    '',
  ]);
});

test('check warns when auto-merge is allowed, review.visual is unset, and git tracks a screen file', async (t) => {
  const dir = exampleRepo(t);
  const write = (file, text = '') => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
    execFileSync('git', ['-C', dir, 'add', file]);
  };
  const config = (extra) => writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, github: { requiredChecks: ['test'], autoMerge: { allow: true } }, ...extra }));
  const warning = (count, first) => `warning: github.autoMerge.allow is true and review.visual is unset, so auto-merge can ship screen changes no capture checked (${count}, such as "${first}"): set review.visual.targets to the routes and files of the project's screens\n`;
  const check = async () => {
    const { status, stderr } = await run(['check'], dir);
    assert.equal(status, 0, stderr);
    return stderr;
  };

  config({});
  write('docs/site/index.html', '<p>docs</p>');
  write('src/app/page.test.tsx');
  write('e2e/fixtures/screen.html');
  write('.storybook/preview.tsx');
  assert.equal(await check(), '', 'docs, test, and dot-folder files are not screens');

  write('src/app/page.tsx', 'export default () => null;');
  writeFileSync(path.join(dir, 'src/app/draft.tsx'), '');
  assert.equal(await check(), warning('1 tracked screen file', 'src/app/page.tsx'), 'an untracked file does not count');
  write('src/app/layout.vue');
  assert.equal(await check(), warning('2 tracked screen files', 'src/app/layout.vue'));

  config({ review: { visual: { platform: 'web', targets: [{ files: ['src/app/**'], routes: ['/'] }], viewports: [390, 1024, 1440] } } });
  assert.equal(await check(), '', 'silent with review.visual set');
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, github: { requiredChecks: ['test'], autoMerge: { allow: false } } }));
  assert.equal(await check(), '', 'silent with auto-merge not allowed');
});

test('check warns when review.productFeedback.allWidths is set and review.visual lists no viewports', async (t) => {
  const dir = exampleRepo(t);
  const config = (review) => writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, ...(review && { review }) }));
  const visual = { platform: 'web', targets: [{ files: ['src/app/**'], routes: ['/'] }], viewports: [390, 1024, 1440] };
  const allWidths = { files: ['src/app/**'] };
  const check = async () => {
    const { status, stderr } = await run(['check'], dir);
    assert.equal(status, 0, stderr);
    return stderr;
  };

  config({ productFeedback: { allWidths } });
  assert.equal(await check(), 'warning: review.productFeedback.allWidths is set, but review.visual lists no viewports, so it has no effect\n');
  config({ productFeedback: { allWidths }, visual });
  assert.equal(await check(), '', 'silent with review.visual set');
  config({ productFeedback: { allWidths: null } });
  assert.equal(await check(), '', 'silent with the key null');
  config(null);
  assert.equal(await check(), '', 'silent with the key absent');

  // A review.visual with an error reads as unset, and its own error already says what to fix.
  config({ productFeedback: { allWidths }, visual: { ...visual, viewports: [] } });
  const broken = await run(['check'], dir);
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /review\.visual\.viewports/u);
  assert.doesNotMatch(broken.stderr, /allWidths/u, 'no warning on a config with errors');
});

test('the screen warning escapes control characters in the file it names, so a file name cannot forge a line', async (t) => {
  const dir = exampleRepo(t);
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, github: { requiredChecks: ['test'], autoMerge: { allow: true } } }));
  // A line break that would start a forged diagnostic, an ESC and a one-byte CSI that would drive the terminal, and a
  // Unicode line separator.
  const name = 'page\nerror: forged \u001b[31mred\u009b0m\u2028.tsx';
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src', name), '');
  execFileSync('git', ['-C', dir, 'add', '--', `src/${name}`]);
  const { status, stderr } = await run(['check'], dir);
  assert.equal(status, 0, stderr);
  assert.equal(stderr, `warning: github.autoMerge.allow is true and review.visual is unset, so auto-merge can ship screen changes no capture checked (1 tracked screen file, such as "src/page\\nerror: forged \\u001b[31mred\\u009b0m\\u2028.tsx"): set review.visual.targets to the routes and files of the project's screens\n`);
  assert.doesNotMatch(stderr, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/u, 'no raw control character reaches the terminal');
  assert.equal(stderr.split('\n').length, 2, 'one warning line');
});

test('the screen warning leaves out a native-only React Native app, whose screens no web capture reaches', async (t) => {
  const dir = exampleRepo(t);
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, github: { requiredChecks: ['test'], autoMerge: { allow: true } } }));
  mkdirSync(path.join(dir, 'src/screens'), { recursive: true });
  writeFileSync(path.join(dir, 'src/screens/Home.tsx'), '');
  execFileSync('git', ['-C', dir, 'add', 'src/screens/Home.tsx']);
  const pkg = (dependencies) => writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'app', dependencies }));
  const check = async () => {
    const { status, stderr } = await run(['check'], dir);
    assert.equal(status, 0, stderr);
    return stderr;
  };

  pkg({ react: '19.0.0', 'react-native': '0.80.0' });
  assert.equal(await check(), '', 'react-native without react-dom: its .tsx screens are native');
  pkg({ react: '19.0.0', 'react-native': '0.80.0', 'react-dom': '19.0.0' });
  assert.match(await check(), /^warning: github\.autoMerge\.allow is true and review\.visual is unset, .*"src\/screens\/Home\.tsx"/u, 'with react-dom it renders for the web too');
  pkg({ react: '19.0.0', 'react-native': '0.80.0' });
  writeFileSync(path.join(dir, 'src/screens/index.html'), '');
  execFileSync('git', ['-C', dir, 'add', 'src/screens/index.html']);
  assert.match(await check(), /"src\/screens\/index\.html"/u, 'an .html file still counts in a native app');
});

test('each screen file asks its nearest package.json whether it is native, so a web workspace under a native root warns', async (t) => {
  const dir = exampleRepo(t);
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, github: { requiredChecks: ['test'], autoMerge: { allow: true } } }));
  const write = (file, text = '') => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
    execFileSync('git', ['-C', dir, 'add', file]);
  };
  const deps = (dependencies) => JSON.stringify({ name: 'pkg', dependencies });
  const check = async () => {
    const { status, stderr } = await run(['check'], dir);
    assert.equal(status, 0, stderr);
    return stderr;
  };
  const warns = (file) => new RegExp(`^warning: github\\.autoMerge\\.allow is true and review\\.visual is unset, so auto-merge can ship screen changes no capture checked \\(1 tracked screen file, such as "${file.replaceAll('/', '\\/').replaceAll('.', '\\.')}"\\)`, 'u');

  write('package.json', deps({ 'react-native': '0.80.0' }));
  write('apps/mobile/src/Home.tsx');
  assert.equal(await check(), '', 'a file under the native root, with no manifest of its own, is native');
  write('packages/web/package.json', deps({ react: '19.0.0', 'react-dom': '19.0.0' }));
  write('packages/web/src/App.tsx');
  assert.match(await check(), warns('packages/web/src/App.tsx'), 'the web workspace has its own react-dom');

  writeFileSync(path.join(dir, 'packages/web/package.json'), '{ not json');
  assert.match(await check(), warns('packages/web/src/App.tsx'), 'a manifest that does not parse keeps the warning');
  rmSync(path.join(dir, 'packages/web/package.json'));
  symlinkSync(path.join(dir, 'packages/web/gone.json'), path.join(dir, 'packages/web/package.json'));
  assert.match(await check(), warns('packages/web/src/App.tsx'), 'a manifest that is a broken link keeps the warning, not the native root above it');
  rmSync(path.join(dir, 'packages/web/package.json'));
  writeFileSync(path.join(dir, 'packages/web/package.json'), deps({ 'react-native': '0.80.0' }));
  assert.equal(await check(), '', 'a native workspace is native');
  writeFileSync(path.join(dir, 'package.json'), deps({ react: '19.0.0' }));
  writeFileSync(path.join(dir, 'packages/web/package.json'), deps({ 'react-native': '0.80.0', 'react-dom': '19.0.0' }));
  assert.match(await check(), /"apps\/mobile\/src\/Home\.tsx"/u, 'a file whose nearest manifest has no react-native counts');
});

test('a native-only project depends on react-native and not on react-dom', () => {
  assert.equal(isNativeOnly({ dependencies: { 'react-native': '1' } }), true);
  assert.equal(isNativeOnly({ devDependencies: { 'react-native': '1' } }), true);
  assert.equal(isNativeOnly({ dependencies: { 'react-native': '1' }, devDependencies: { 'react-dom': '1' } }), false);
  assert.equal(isNativeOnly({ dependencies: { react: '1', 'react-dom': '1' } }), false);
  assert.equal(isNativeOnly({ dependencies: 'react-native' }), false);
  assert.equal(isNativeOnly(null), false);
});

test('a screen file is a .tsx, .jsx, .vue, .svelte, or .html file outside docs, examples, tests, and dot folders', () => {
  for (const file of ['index.html', 'src/App.jsx', 'app/routes/home.svelte', 'web/src/pages/Floor.vue', 'src/app/staff/page.tsx']) assert.equal(isScreenFile(file), true, file);
  for (const file of ['src/app/page.ts', 'docs/index.html', 'packages/ui/docs/a.html', 'examples/demo/App.tsx', 'node_modules/x/a.jsx', 'test/a.tsx', 'src/__tests__/a.tsx', 'e2e/a.html', '.github/a.html', 'src/Button.stories.tsx', 'src/Button.spec.jsx', 'src/Button.test.tsx']) assert.equal(isScreenFile(file), false, file);
});

test('check fails on an index whose dir does not exist, apart from one outside the project', async (t) => {
  const dir = exampleRepo(t);
  const file = path.join(dir, '.aidrian/knowledge/product.json');
  writeFileSync(file, readFileSync(file, 'utf8').replace('"dir": "docs/knowledge/product"', '"dir": "docs/gone"'));
  const { status, stderr } = await run(['check'], dir);
  assert.deepEqual([status, stderr], [1, `.aidrian/knowledge/product.json: "dir": "docs/gone" does not exist (relative to ${dir})\n`]);
});

test('check fails on an index whose dir is not a folder inside the project', async (t) => {
  const dir = exampleRepo(t);
  const file = path.join(dir, '.aidrian/knowledge/product.json');
  writeFileSync(file, readFileSync(file, 'utf8').replace('"dir": "docs/knowledge/product"', '"dir": "../product"'));
  const { status, stderr } = await run(['check'], dir);
  assert.deepEqual([status, stderr], [1, '.aidrian/knowledge/product.json: "dir" must be a folder inside the project\n']);
});

test('a project whose .aidrian.json names another folder sets up and checks that folder', async (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-check-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  writeFileSync(path.join(dir, '.aidrian.json'), JSON.stringify({ dir: 'harness' }));
  const init = await run(['init'], dir);
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /^wrote harness\/config\.json\nadded to \.gitignore: \.aidrian\.local\.json, \.worktrees\/\n/);
  assert.equal(existsSync(path.join(dir, '.aidrian')), false);
  assert.deepEqual([ok((await run(['check'], dir)).stdout), (await run(['check'], dir)).status], ['ok: harness (0 buckets, 0 docs)', 0]);

  writeFileSync(path.join(dir, '.aidrian.json'), JSON.stringify({ dir: '../harness' }));
  const broken = await run(['init'], dir);
  assert.deepEqual([broken.status, broken.stderr], [1, '.aidrian.json: "dir" must be a relative folder inside the project\n']);
});

test('init writes nothing through a symlink that leaves the project, and follows one that stays inside', async (t) => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-init-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const outside = path.join(base, 'outside');
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'gitignore'), 'keep\n');
  const repo = (name) => {
    const dir = path.join(base, name);
    execFileSync('git', ['init', '-q', dir]);
    return dir;
  };

  // .aidrian.json names a folder that does not exist yet, below a link that leaves the project.
  const named = repo('named');
  symlinkSync(outside, path.join(named, 'link'));
  writeFileSync(path.join(named, '.aidrian.json'), JSON.stringify({ dir: 'link/new' }));
  const viaNamed = await run(['init'], named);
  assert.deepEqual([viaNamed.status, viaNamed.stderr], [1, '.aidrian.json: "dir" must be a relative folder inside the project\n']);

  // The project folder is a link that leaves the project, or a broken one.
  const linked = repo('linked');
  symlinkSync(outside, path.join(linked, '.aidrian'));
  const viaFolder = await run(['init'], linked);
  const refused = (rel, dir) => `${rel}: links outside ${dir}; init wrote nothing\n`;
  assert.deepEqual([viaFolder.status, viaFolder.stderr], [1, refused('.aidrian/knowledge', linked) + refused('.aidrian/config.json', linked)]);
  const broken = repo('broken');
  symlinkSync(path.join(outside, 'gone'), path.join(broken, '.aidrian'));
  assert.equal((await run(['init'], broken)).status, 1);

  // The .gitignore is a link that leaves the repository: init stops before it writes the project folder.
  const ignore = repo('ignore');
  symlinkSync(path.join(outside, 'gitignore'), path.join(ignore, '.gitignore'));
  const viaIgnore = await run(['init'], ignore);
  assert.deepEqual([viaIgnore.status, viaIgnore.stderr], [1, refused('.gitignore', ignore)]);
  assert.equal(existsSync(path.join(ignore, '.aidrian')), false);

  assert.deepEqual(readdirSync(outside), ['gitignore']);
  assert.equal(readFileSync(path.join(outside, 'gitignore'), 'utf8'), 'keep\n');

  const inside = repo('inside');
  mkdirSync(path.join(inside, 'harness'));
  symlinkSync(path.join(inside, 'harness'), path.join(inside, '.aidrian'));
  const followed = await run(['init'], inside);
  assert.equal(followed.status, 0, followed.stderr);
  assert.equal(readFileSync(path.join(inside, 'harness/config.json'), 'utf8'), '{\n  "version": 1\n}\n');
});

test('init sets up an empty repository, a second run changes nothing and says so, and check then passes', async (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-init-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  writeFileSync(path.join(dir, '.gitignore'), 'node_modules/');

  // As a process, so the init command stays tested through bin/aidrian's own entry.
  const first = runProcess(['init'], dir);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(
    first.stdout,
    'wrote .aidrian/config.json\nadded to .gitignore: .aidrian.local.json, .worktrees/\n' +
      'next: add a knowledge index with aidrian-knowledge init <folder of docs>, then run aidrian check\n',
  );
  assert.equal(readFileSync(path.join(dir, '.aidrian/config.json'), 'utf8'), '{\n  "version": 1\n}\n');
  assert.deepEqual(readdirSync(path.join(dir, '.aidrian/knowledge')), []);
  assert.equal(readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'node_modules/\n.aidrian.local.json\n.worktrees/\n');

  // Every file outside .git, with its content.
  const files = (folder) =>
    readdirSync(folder, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && !path.relative(folder, entry.parentPath).split(path.sep).includes('.git'))
      .map((entry) => [path.relative(folder, path.join(entry.parentPath, entry.name)), readFileSync(path.join(entry.parentPath, entry.name), 'utf8')])
      .sort();
  const before = files(dir);
  const second = await run(['init'], dir);
  assert.deepEqual([second.status, second.stdout], [0, 'nothing to do: .aidrian is set up\n']);
  assert.deepEqual(files(dir), before);
  assert.deepEqual([ok((await run(['check'], dir)).stdout), (await run(['check'], path.join(dir, '.aidrian'))).status], ['ok: .aidrian (0 buckets, 0 docs)', 0]);
});

test('init adds the missing lines to an existing project and keeps its config', async (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-init-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), '{"version": 1, "git": {"defaultBranch": "trunk"}}');
  const { status, stdout } = await run(['init'], dir);
  assert.equal(status, 0);
  assert.equal(stdout.split('\n')[0], 'added to .gitignore: .aidrian.local.json, .worktrees/');
  assert.equal(readFileSync(path.join(dir, '.aidrian/config.json'), 'utf8'), '{"version": 1, "git": {"defaultBranch": "trunk"}}');
});

// The tree in docs/project-folder.md is the folder contract: every committed entry exists in the example consumer, every
// git-ignored entry is ignored there and is a line `aidrian init` writes, and every file in the example's folder is in it.
test('the example consumer and aidrian init match the tree in docs/project-folder.md', async (t) => {
  const entries = docTree();
  assert.ok(entries.length >= 4, 'the tree block lists the folder');

  const committed = entries.filter((entry) => entry.kind === 'committed');
  const ignored = entries.filter((entry) => entry.kind === 'git-ignored').map((entry) => entry.path);
  const pattern = (entry) => new RegExp(`^${entry.path.replace(/[.]/g, '\\.').replace('<bucket-id>', '[a-z0-9][a-z0-9-]*')}$`);
  const exampleFiles = readdirSync(path.join(EXAMPLE, '.aidrian'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(EXAMPLE, path.join(entry.parentPath, entry.name)).replaceAll(path.sep, '/'));

  for (const entry of committed) {
    if (!entry.optional) assert.ok(exampleFiles.some((file) => pattern(entry).test(file)), `${entry.path} is in the example`);
  }
  for (const file of exampleFiles) assert.ok(committed.some((entry) => pattern(entry).test(file)), `${file} is in the tree`);
  for (const entry of ignored) assert.equal(isIgnored(EXAMPLE, entry), true, `${entry} is ignored in the example`);

  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-tree-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  assert.equal((await run(['init'], dir)).status, 0);
  assert.deepEqual(readFileSync(path.join(dir, '.gitignore'), 'utf8').trim().split('\n').sort(), [...ignored].sort());
});

// Each line of the tree block: { path, kind, optional }. A folder line without a note is the parent of the lines below it.
function docTree() {
  const doc = readFileSync(path.join(ROOT, 'docs/project-folder.md'), 'utf8');
  const block = /## Structure\n\n```text\n([\s\S]*?)\n```/.exec(doc)[1];
  const entries = [];
  let parent = '';
  for (const line of block.split('\n')) {
    const [, branch, name, note] = /^([├└]── )?(\S+)\s*(.*)$/.exec(line);
    const kind = /\((optional, )?(committed|git-ignored)\)$/.exec(note);
    if (!branch) parent = kind ? '' : name;
    if (kind) entries.push({ path: `${branch ? parent : ''}${name}`, kind: kind[2], optional: Boolean(kind[1]) });
  }
  return entries;
}
