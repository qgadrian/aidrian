import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { configWriteDenial } from '../plugins/aidrian/lib/config-guard.mjs';
import { configFiles, findProject } from '../plugins/aidrian/lib/project.mjs';

// The hooks this file runs record their blocks in the state folder; keep those rows out of the real one.
process.env.XDG_STATE_HOME = mkdtempSync(path.join(tmpdir(), 'aidrian-state-'));
after(() => rmSync(process.env.XDG_STATE_HOME, { recursive: true, force: true }));

const HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-agent-gates.mjs');
const GATED = { version: 1, agents: { explorer: { deny: ['WebFetch'] } }, names: { human: 'the product owner' } };

// A project with gates in `config`, a knowledge folder, and a source file. `spelled` is the folder as tmpdir() spells it,
// which on macOS reaches the real folder through a symlink.
function project(t, config = GATED) {
  const spelled = mkdtempSync(path.join(tmpdir(), 'aidrian-guard-'));
  t.after(() => rmSync(spelled, { recursive: true, force: true }));
  const dir = realpathSync(spelled);
  mkdirSync(path.join(dir, '.aidrian/knowledge'), { recursive: true });
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify(config));
  writeFileSync(path.join(dir, 'src/app.js'), 'export {};\n');
  return { dir, spelled };
}

const subagent = (cwd, tool, toolInput) => ({ tool_name: tool, tool_input: toolInput, agent_type: 'aidrian:explorer', agent_id: 'a5f0c1', cwd });
const verdict = (cwd, input) => {
  const found = findProject(cwd);
  return configWriteDenial(input, found, loadConfig(found).config)?.reason ?? null;
};

test('a subagent may not change a file that sets the gates, with any write tool or a Bash command that writes it', (t) => {
  const { dir, spelled } = project(t);
  const blocked = [
    ['Edit', { file_path: path.join(dir, '.aidrian/config.json') }],
    ['Edit', { file_path: '.aidrian/config.json' }],
    ['Edit', { file_path: path.join(spelled, '.aidrian/config.json') }],
    ['Write', { file_path: '.aidrian.local.json' }],
    ['Write', { file_path: '.aidrian.json' }],
    ['NotebookEdit', { notebook_path: '.aidrian/config.json' }],
    ['apply_patch', { command: '*** Begin Patch\n*** Update File: .aidrian/config.json\n@@\n-a\n+b\n*** End Patch\n' }],
    ...[
      "echo '{}' > .aidrian/config.json",
      'jq . other.json >> .aidrian.local.json',
      "sed -i '' 's/deny/allow/' .aidrian/config.json",
      'printf x | tee .aidrian.local.json',
      'cp /tmp/x.json .aidrian/config.json',
      'cp /tmp/config.json .aidrian/',
      'mv .aidrian.json /tmp/',
      'rm -rf .aidrian',
      'git mv .aidrian/config.json old.json',
      `cd src && echo x > ${dir}/.aidrian.local.json`,
      `echo "$(echo x > ${spelled}/.aidrian.json)"`,
      // A `cd` to a named folder is followed, and one that fails leaves the shell where it was.
      'cd .aidrian && echo {} > config.json',
      'cd src; cd ../.aidrian && rm config.json',
      'cd /nonexistent; echo {} > .aidrian/config.json',
      'pushd .aidrian && sed -i "" s/deny/allow/ config.json',
      // The command line of `sh -c` is read as this one is.
      "bash -c 'echo {} > .aidrian/config.json'",
      `sh -c "cd ${dir}/.aidrian && rm config.json"`,
    ].map((command) => ['Bash', { command }]),
  ];
  for (const [tool, toolInput] of blocked) {
    assert.match(verdict(dir, subagent(dir, tool, toolInput)) ?? '', /^aidrian: \S+ is blocked for the agent "aidrian:explorer"/, `${tool} ${JSON.stringify(toolInput)}`);
  }
  assert.equal(
    verdict(dir, subagent(dir, 'Edit', { file_path: '.aidrian/config.json' })),
    'aidrian: Edit is blocked for the agent "aidrian:explorer" in this project: it changes .aidrian/config.json, which sets this'
      + " project's agent gates, and while gates are set only the main session may change it. This is a project rule: do not reach"
      + ' the same result with another tool; tell the product owner what the task needs.',
  );
  assert.match(verdict(dir, subagent(dir, 'Bash', { command: 'rm -rf .aidrian' })), /^aidrian: Bash is blocked .* it changes \.aidrian\/config\.json,/);
});

test('a subagent may still read those files and write anything else, and the main session may change them', (t) => {
  const { dir } = project(t);
  const allowed = [
    ['Read', { file_path: '.aidrian/config.json' }],
    ['Grep', { pattern: 'deny', path: '.aidrian/config.json' }],
    ['Edit', { file_path: 'src/app.js' }],
    ['Write', { file_path: '.aidrian/knowledge/notes.md' }],
    ...[
      'cat .aidrian/config.json',
      'jq .agents .aidrian/config.json > /tmp/agents.json',
      'echo x > notes.md',
      'mkdir -p .aidrian/knowledge/new',
      'cp notes.md .aidrian/knowledge/',
      'cp notes.md .',
      `cp notes.md ${dir}`,
      'cd src && echo x > notes.md',
      'cd "$TMPDIR" && echo x > notes.md',
      "bash -c 'echo x > notes.md'",
      'python3 -c "print(1)"',
      "node -e \"require('fs').writeFileSync('tsconfig.json', '{}')\"",
      "python3 -c \"open('.aidrian/knowledge/notes.md', 'w').write('x')\"",
      'python3 -m json.tool .aidrian/config.json',
    ].map((command) => ['Bash', { command }]),
  ];
  for (const [tool, toolInput] of allowed) assert.equal(verdict(dir, subagent(dir, tool, toolInput)), null, `${tool} ${JSON.stringify(toolInput)}`);

  const main = { tool_name: 'Edit', tool_input: { file_path: '.aidrian/config.json' }, cwd: dir };
  assert.equal(verdict(dir, main), null, 'the main session');
  assert.equal(verdict(dir, { ...main, agent_type: 'aidrian:explorer' }), null, 'a session started with --agent is the main session');
});

test('a write to an unknown folder, or code an interpreter runs, is judged by the names it holds', (t) => {
  const { dir } = project(t);
  const reasonOf = (command) => verdict(dir, subagent(dir, 'Bash', { command }));
  for (const [command, file] of [
    ['cd "$DIR" && echo {} > config.json', '.aidrian/config.json'],
    ['cd && echo x > ../.aidrian.local.json', '.aidrian.local.json'],
    ['python3 -c "open(\'.aidrian/config.json\', \'w\').write(\'{\')"', '.aidrian/config.json'],
    ['python3 -Bc "import os; os.chdir(\'.aidrian\'); open(\'config.json\', \'w\')"', '.aidrian/config.json'],
    ['python3 -c "import shutil; shutil.rmtree(\'.aidrian/\')"', '.aidrian/config.json'],
    ['python3 -c "import sys; open(sys.argv[1], \'w\')" .aidrian.json', '.aidrian.json'],
    ['node -e "require(\'fs\').writeFileSync(\'.aidrian.local.json\', \'{}\')"', '.aidrian.local.json'],
    ['node --eval="require(\'fs\').rmSync(\'.aidrian/config.json\')"', '.aidrian/config.json'],
    ['perl -i -pe "s/deny/allow/" .aidrian/config.json', '.aidrian/config.json'],
    ['ruby -e "File.write(\'.aidrian/config.json\', \'{}\')"', '.aidrian/config.json'],
    ["python3 - <<'EOF'\nopen('.aidrian/config.json', 'w').write('{')\nEOF", '.aidrian/config.json'],
    ["bash -c 'python3 -c \"open(\\\".aidrian/config.json\\\", \\\"w\\\")\"'", '.aidrian/config.json'],
  ]) {
    assert.match(reasonOf(command) ?? '', new RegExp(`^aidrian: Bash is blocked .* it may change ${file.replaceAll('.', '\\.')}, which sets`), command);
  }
  // A `cd` may fail, so the folder before it still counts, and there the target is certain.
  for (const command of ['cd .aidrian && echo {} > config.json', 'cd - && rm -rf .aidrian']) {
    assert.match(reasonOf(command), / it changes \.aidrian\/config\.json,/, command);
  }
});

test('a project folder that .aidrian.json moves is guarded where it is, and so is the default one it falls back to', (t) => {
  const { dir } = project(t);
  mkdirSync(path.join(dir, 'tools/aidrian'), { recursive: true });
  writeFileSync(path.join(dir, '.aidrian.json'), JSON.stringify({ dir: 'tools/aidrian' }));
  writeFileSync(path.join(dir, 'tools/aidrian/config.json'), JSON.stringify(GATED));
  for (const command of ['echo x > tools/aidrian/config.json', 'rm -r tools', 'echo x > .aidrian/config.json', 'rm .aidrian.json']) {
    assert.notEqual(verdict(dir, subagent(dir, 'Bash', { command })), null, command);
  }
  assert.match(verdict(dir, subagent(dir, 'Bash', { command: 'rm -r tools' })), /it changes tools\/aidrian\/config\.json,/);
  assert.equal(verdict(dir, subagent(dir, 'Bash', { command: 'echo x > tools/aidrian/knowledge.md' })), null);
});

test('in a worktree, the main checkout`s .aidrian.local.json, which the worktree reads, is guarded too', (t) => {
  const { dir } = project(t);
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  writeFileSync(path.join(dir, '.gitignore'), '.aidrian.local.json\n.worktrees/\n');
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  const tree = path.join(dir, '.worktrees/task');
  git('worktree', 'add', '-q', '-b', 'task', tree);

  assert.deepEqual(findProject(tree).checkouts, [tree, dir]);
  assert.ok(configFiles(findProject(tree)).includes(path.join(dir, '.aidrian.local.json')));
  for (const file of [path.join(dir, '.aidrian.local.json'), path.join(tree, '.aidrian.local.json'), path.join(tree, '.aidrian/config.json')]) {
    assert.notEqual(verdict(tree, subagent(tree, 'Write', { file_path: file })), null, file);
  }
  const reason = verdict(tree, subagent(tree, 'Write', { file_path: path.join(dir, '.aidrian.local.json') }));
  assert.ok(reason.includes(`it changes ${path.join(dir, '.aidrian.local.json')},`), reason);
  assert.equal(verdict(tree, subagent(tree, 'Bash', { command: `rm -rf ${tree}` })), null, 'a folder that holds a checkout: the worktree itself');
  assert.equal(verdict(dir, subagent(dir, 'Bash', { command: 'rm -rf .worktrees/task' })), null, 'from the main checkout, a worktree is another project');
});

test('the hook blocks a subagent that changes the gates with exit 2, and lets it run without gates or as the main session', (t) => {
  const gated = project(t).dir;
  const open = project(t, { version: 1 }).dir;
  const run = (cwd, input) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), cwd, encoding: 'utf8' });
  const edit = (cwd) => subagent(cwd, 'Edit', { file_path: '.aidrian/config.json' });

  const blocked = run(gated, edit(gated));
  assert.deepEqual([blocked.status, blocked.stdout], [2, '']);
  assert.match(blocked.stderr, /^aidrian: Edit is blocked for the agent "aidrian:explorer" in this project: it changes \.aidrian\/config\.json,/);
  assert.match(blocked.stderr, /tell the product owner what the task needs\.\n$/);
  for (const [cwd, input] of [
    [open, edit(open)],
    [gated, { tool_name: 'Edit', tool_input: { file_path: '.aidrian/config.json' }, cwd: gated }],
    [gated, subagent(gated, 'Edit', { file_path: 'src/app.js' })],
  ]) {
    const { status, stdout, stderr } = run(cwd, input);
    assert.deepEqual([status, stdout, stderr], [0, '', ''], `${cwd}: ${JSON.stringify(input)}`);
  }
});
