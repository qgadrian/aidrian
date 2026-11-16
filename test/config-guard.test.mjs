import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { configWriteDenial } from '../plugins/aidrian/lib/config-guard.mjs';
import { globParts } from '../plugins/aidrian/lib/fs.mjs';
import { configFiles, findProject, stateDir } from '../plugins/aidrian/lib/project.mjs';

// The hooks this file runs record their blocks in the state folder; keep those rows out of the real one.
process.env.XDG_STATE_HOME = mkdtempSync(path.join(tmpdir(), 'aidrian-state-'));
after(() => rmSync(process.env.XDG_STATE_HOME, { recursive: true, force: true }));

const FOLDS = process.platform === 'darwin' || process.platform === 'win32';
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
      // An interpreter whose code only reads the config, in one of the few shapes the guard knows.
      "python3 -c \"import json; print(json.load(open('.aidrian/config.json')))\"",
      "python3 -c \"print(open('.aidrian/config.json').read())\"",
      "python3 -c \"import json; print(json.dumps(json.load(open('.aidrian.local.json', 'r'))['agents'], indent=2))\"",
      "node -e \"console.log(require('./.aidrian/config.json'))\"",
      "node -p \"JSON.parse(require('fs').readFileSync('.aidrian/config.json', 'utf8')).agents\"",
      "node -e \"console.log(require('node:fs').readFileSync('.aidrian.json', 'utf8'))\"",
      "node -e \"const { readFileSync } = require('fs'); console.log(JSON.stringify(JSON.parse(readFileSync('.aidrian/config.json')), null, 2))\"",
      "python3 - <<'EOF'\nimport json\nprint(json.load(open('.aidrian/config.json'))['agents'])\nEOF",
      // A heredoc counts for its own command only, so a read after it is a read.
      "python3 - <<'EOF'\nprint(1)\nEOF\ncat .aidrian/config.json",
      "python3 - <<'EOF'\nopen('notes.md', 'w').write('x')\nEOF\ncat .aidrian/config.json",
      "python3 <<< \"print(open('.aidrian/config.json').read())\"",
      // The same reads with the code in the option's word, and node's `-pe`, whose code is the next word.
      "python3 -c\"print(open('.aidrian/config.json').read())\"",
      "python3 -Bc\"import json; print(json.load(open('.aidrian/config.json')))\"",
      "node -pe \"require('./.aidrian/config.json').agents\"",
      "node --print=\"require('./.aidrian/config.json').agents\"",
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
    // Code that writes, deletes, moves, or runs a program, from any place an interpreter reads code.
    ["python3 - <<'EOF'\nimport os\nos.remove('.aidrian/config.json')\nEOF", '.aidrian/config.json'],
    ["cat x | python3 - <<'EOF'\nimport json\nEOF\npython3 <<< \"import os; os.rename('.aidrian.json', 'x')\"", '.aidrian.json'],
    ["echo \"open('.aidrian/config.json', 'w')\" | python3", '.aidrian/config.json'],
    ['node -e "require(\'fs\').unlinkSync(\'.aidrian/config.json\')"', '.aidrian/config.json'],
    ['node -e "require(\'child_process\').execSync(\'rm .aidrian.local.json\')"', '.aidrian.local.json'],
    ['python3 -c "import pathlib; pathlib.Path(\'.aidrian/config.json\').write_text(\'{}\')"', '.aidrian/config.json'],
    ['python3 -c "import shutil; shutil.move(\'.aidrian/config.json\', \'/tmp/x\')"', '.aidrian/config.json'],
    ["perl -pi.bak -e 's/deny/allow/' .aidrian/config.json", '.aidrian/config.json'],
    ['perl -e "open(my \\$f, \'>\', \'.aidrian/config.json\')"', '.aidrian/config.json'],
    ['ruby -i -pe "sub(/deny/, \'allow\')" .aidrian/config.json', '.aidrian/config.json'],
    // Code in the same word as its option, alone or after others in a cluster.
    ["python3 -c\"open('.aidrian/config.json','w').write('{}')\"", '.aidrian/config.json'],
    ["python3 -Bc\"import os; os.remove('.aidrian.local.json')\"", '.aidrian.local.json'],
    ["node -e\"require('fs').unlinkSync('.aidrian/config.json')\"", '.aidrian/config.json'],
    ["node -p\"require('fs').rmSync('.aidrian.json')\"", '.aidrian.json'],
    ["perl -e'unlink \".aidrian/config.json\"'", '.aidrian/config.json'],
    ["perl -lE'unlink \".aidrian.json\"'", '.aidrian.json'],
    ["ruby -e\"File.delete('.aidrian/config.json')\"", '.aidrian/config.json'],
    ["ruby -we\"File.delete('.aidrian.local.json')\"", '.aidrian.local.json'],
  ]) {
    // perl -i and ruby -i are certain writes, so they read "changes"; the rest are code the guard cannot follow.
    assert.match(reasonOf(command) ?? '', new RegExp(`^aidrian: Bash is blocked .* it (?:may change|changes) ${file.replaceAll('.', '\\.')}, which sets`), command);
  }
  // Code that names a file and is not one of the few reads, whatever it calls: a rename or replace the guard has no
  // name for, a read beside a change, a read whose function the code first redefines, ruby and perl, and a write mode.
  for (const [command, file] of [
    ['python3 -c "from pathlib import Path; Path(\'.aidrian/config.json\').replace(\'old.json\')"', '.aidrian/config.json'],
    ['python3 -c "import os; os.rename(\'.aidrian/config.json\', \'old.json\')"', '.aidrian/config.json'],
    ['python3 -c "import os; os.unlink(\'.aidrian.local.json\')"', '.aidrian.local.json'],
    ['node -e "require(\'fs\').renameSync(\'.aidrian/config.json\', \'old.json\')"', '.aidrian/config.json'],
    ["python3 -c \"import json, os; print(json.load(open('.aidrian/config.json'))); os.replace('.aidrian/config.json', 'x')\"", '.aidrian/config.json'],
    ["python3 -c \"open = lambda p: __import__('os').remove(p); open('.aidrian/config.json').read()\"", '.aidrian/config.json'],
    ["node -e \"const fs = { readFileSync: require('fs').unlinkSync }; fs.readFileSync('.aidrian/config.json')\"", '.aidrian/config.json'],
    ["python3 -c \"open('.aidrian/config.json', 'w').read()\"", '.aidrian/config.json'],
    ["node -e \"require('fs').readFileSync('.aidrian/config.json', { flag: 'w' })\"", '.aidrian/config.json'],
    ["python3 -c \"print(open('.aidrian/config.json').read())\" .aidrian.json", '.aidrian.json'],
    ["ruby -e \"puts File.read('.aidrian/config.json')\"", '.aidrian/config.json'],
    ["ruby -e \"open('|rm .aidrian/config.json').read\"", '.aidrian/config.json'],
    ["perl -ne 'print' .aidrian/config.json", '.aidrian/config.json'],
  ]) {
    const reason = reasonOf(command) ?? '';
    assert.match(reason, new RegExp(`^aidrian: Bash is blocked .* it may change ${file.replaceAll('.', '\\.')}, which sets`), command);
    assert.match(reason, /only the main session may change it; to read it, use Read, cat, or jq\. This is a project rule/, command);
  }
  // A `cd` may fail, so the folder before it still counts, and there the target is certain.
  for (const command of ['cd .aidrian && echo {} > config.json', 'cd - && rm -rf .aidrian']) {
    assert.match(reasonOf(command), / it changes \.aidrian\/config\.json,/, command);
  }
});

test('the session`s gate snapshot, the file that marks the session gated, and their folder are guarded as the config is', (t) => {
  const { dir } = project(t);
  const sessions = path.join(process.env.XDG_STATE_HOME, 'aidrian/sessions');
  const snapshot = path.join(sessions, 's-1.json');
  const marker = path.join(sessions, 's-1.gated');
  const found = findProject(dir);
  const reasonOf = (command) => configWriteDenial(subagent(dir, 'Bash', { command }), found, loadConfig(found).config, { also: [snapshot, marker] })?.reason ?? null;
  for (const command of [
    `python3 -c "from pathlib import Path; Path('${snapshot}').replace('/tmp/old.json')"`,
    `python3 -c "import os; os.rename('${snapshot}', '/tmp/old.json')"`,
    `python3 -c "import shutil; shutil.move('${snapshot}', '/tmp/old.json')"`,
    `node -e "require('fs').renameSync('${snapshot}', '/tmp/old.json')"`,
    `node -e "require('fs').unlinkSync('${marker}')"`,
    `python3 -c "import os; os.unlink('${marker}')"`,
    `python3 -c "import shutil, os; shutil.rmtree(os.path.expanduser('~/.local/state/aidrian/sessions'))"`,
    `python3 -c "import glob, os; [os.remove(f) for f in glob.glob('${sessions}/*')]"`,
  ]) {
    assert.match(reasonOf(command) ?? '', /^aidrian: Bash is blocked .* it may change \/.*\/aidrian\/sessions\/s-1\.(?:json|gated), which sets/, command);
  }
  for (const command of [
    `python3 -c "import json; print(json.load(open('${snapshot}')))"`,
    `python3 -c "print(open('${snapshot}').read())"`,
    `node -e "console.log(require('${snapshot}'))"`,
    `node -p "require('fs').readFileSync('${snapshot}', 'utf8')"`,
    `node -p "JSON.parse(require('fs').readFileSync('${snapshot}')).gates"`,
    `cat ${snapshot}`,
  ]) {
    assert.equal(reasonOf(command), null, command);
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

test('a glob reaches a config file that is a symlink to another folder, by the path it is spelled with', (t) => {
  const { dir } = project(t);
  mkdirSync(path.join(dir, 'settings'));
  renameSync(path.join(dir, '.aidrian/config.json'), path.join(dir, 'settings/config.json'));
  symlinkSync('../settings/config.json', path.join(dir, '.aidrian/config.json'));
  for (const command of ["echo '{\"version\":1}' > .aidrian/*.json", 'rm settings/*']) {
    assert.match(verdict(dir, subagent(dir, 'Bash', { command })) ?? '', /may change/, command);
  }
  assert.equal(verdict(dir, subagent(dir, 'Bash', { command: 'rm src/*' })), null);
  // An ordinary folder may hold a link to the config, which a glob there reaches.
  mkdirSync(path.join(dir, 'dist'));
  symlinkSync('../.aidrian/config.json', path.join(dir, 'dist/config.json'));
  assert.match(verdict(dir, subagent(dir, 'Bash', { command: 'echo x > dist/*.json' })) ?? '', /config\.json/);
  assert.equal(verdict(dir, subagent(dir, 'Bash', { command: 'rm dist/*.js' })), null);
  // A hard link keeps its own path; only the file's identity shows it is the config, by its name or through a glob.
  mkdirSync(path.join(dir, 'hard'));
  linkSync(path.join(dir, 'settings/config.json'), path.join(dir, 'hard/alias'));
  for (const command of ['echo x > hard/alias', 'echo x > hard/*']) {
    assert.match(verdict(dir, subagent(dir, 'Bash', { command })) ?? '', /config\.json/, command);
  }
  // A `cd` before the glob, which `-P` resolves through links, and a folder the shell expands, as braces do, fail closed.
  for (const command of [
    "cd -P out/link/.. && echo '{}' > config*.json",
    'printf x | tee .{aidrian,unused}/*.json',
    `target=out/alias; ln -s ../.aidrian/config.json "$target" && echo '{}' > out/*`,
    "printf x | env -C out/link/.. bash -c 'tee config*.json'",
    'echo\n./prepare\ncat payload.json > out/*',
    'cp payload/config.json out/*',
    'cp -t out/* payload/config.json',
  ]) {
    assert.match(verdict(dir, subagent(dir, 'Bash', { command })) ?? '', /may change/, command);
  }
  // Past a symlink, `..` climbs out of the link's target, not back to the folder the path names.
  assert.match(verdict(dir, subagent(dir, 'Bash', { command: "echo '{}' > out/link/../*.json" })) ?? '', /\.aidrian/);
  // A link the same call creates before the glob runs, in its folder or above it, is not on disk yet: with any other
  // write in the call, a glob that may name a guarded file fails closed.
  mkdirSync(path.join(dir, 'out'));
  for (const command of [
    "ln -s ../.aidrian/config.json out/alias && echo '{}' > out/*",
    'cp x out/ && rm -rf out/*',
    "ln -s .. out/link && echo '{}' > out/link/.aidrian/*.json",
    "ln -sf ../.aidrian/config.json out/* && echo '{}' > out/*",
  ]) {
    assert.match(verdict(dir, subagent(dir, 'Bash', { command })) ?? '', /\.aidrian/, command);
  }
  assert.equal(verdict(dir, subagent(dir, 'Bash', { command: 'touch src/a.js && rm -rf out/*.js' })), null);
});

test('a link to a config file not made yet changes it: a write through the link creates the file', (t) => {
  const { dir } = project(t);
  mkdirSync(path.join(dir, 'out'));
  symlinkSync('../.aidrian.local.json', path.join(dir, 'out/alias'));
  for (const command of ["echo '{}' > out/alias", "printf x | tee out/alias", `echo x > ${path.join(dir, 'out/alias')}`]) {
    assert.match(verdict(dir, subagent(dir, 'Bash', { command })) ?? '', /changes \.aidrian\.local\.json/, command);
  }
  assert.match(verdict(dir, subagent(dir, 'Write', { file_path: path.join(dir, 'out/alias') })) ?? '', /changes \.aidrian\.local\.json/);
  assert.equal(verdict(dir, subagent(dir, 'Bash', { command: 'echo x > out/other' })), null);
});

test('ln, truncate, install, dd, git checkout --, git restore, and a glob that may name a guarded file change it', (t) => {
  const { dir } = project(t);
  for (const command of [
    'ln -sf /tmp/x.json .aidrian/config.json',
    'truncate -s 0 .aidrian/config.json',
    'install -m 644 /tmp/x.json .aidrian.local.json',
    'dd if=/tmp/x.json of=.aidrian/config.json',
    'git checkout HEAD~1 -- .aidrian/config.json',
    'git restore --source=HEAD~1 .aidrian/config.json',
    'rm .aidrian/*.json',
    'echo {} > .aidrian/conf?g.json',
    'rm -rf .aid*',
  ]) {
    assert.match(verdict(dir, subagent(dir, 'Bash', { command })) ?? '', /\.aidrian/, command);
  }
  // A glob whose folder is unknown, through a globbed folder or an unknown cd, still fails closed.
  for (const command of ['rm -rf */config.json', 'cd "$d" && rm -rf *', 'cd build && rm -rf *']) {
    assert.match(verdict(dir, subagent(dir, 'Bash', { command })) ?? '', /\.aidrian/, command);
  }
  // A glob in a known folder that holds no guarded file changes none: routine clean-ups run.
  for (const command of ['rm src/*.js', 'ln -s /tmp/x src/link', 'rm -rf dist/*', 'cp a.txt out/*.js']) {
    assert.equal(verdict(dir, subagent(dir, 'Bash', { command })), null, command);
  }
});

test('a subagent may not set the auto-merge switch, with or without gates; other local writes and the main session stay allowed', (t) => {
  const on = JSON.stringify({ github: { autoMerge: 'on' } });
  const gated = project(t).dir;
  const denied = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(subagent(gated, 'Write', { file_path: '.aidrian.local.json', content: on })), cwd: gated, encoding: 'utf8' });
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /github\.autoMerge/u, 'with gates, this rule answers first');
  {
    const { dir } = project(t, { version: 1 });
    const run = (input) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), cwd: dir, encoding: 'utf8' });
    for (const [tool, toolInput] of [
      ['Write', { file_path: path.join(dir, '.aidrian.local.json'), content: on }],
      ['Write', { file_path: '.aidrian.local.json', content: on }],
      ['Write', { file_path: '.AIDRIAN.LOCAL.JSON', content: on }],
      ['Edit', { file_path: '.aidrian.local.json', old_string: '"off"', new_string: '"autoMerge": "on"' }],
      ['Write', { file_path: '/elsewhere/main/.aidrian.local.json', content: on }],
      ['Bash', { command: `echo '${on}' > .aidrian.local.json` }],
      ['Bash', { command: `cd "$d" && echo '${on}' > .aidrian.local.json` }],
      ['Bash', { command: `python3 -c "open('.aidrian.local.json','w').write('autoMerge')"` }],
      // A patch is not applied here: the value on a line of its own, under a key on an unchanged context line.
      ['apply_patch', { command: '*** Begin Patch\n*** Update File: .aidrian.local.json\n@@\n     "autoMerge": {\n-      "enabled": false\n+      "enabled": true\n*** End Patch\n' }],
    ]) {
      const result = run(subagent(dir, tool, toolInput));
      assert.equal(result.status, 2, JSON.stringify(toolInput));
      assert.match(result.stderr, /github\.autoMerge/u);
    }
    for (const [tool, toolInput] of [
      ['Write', { file_path: '.aidrian.local.json', content: JSON.stringify({ names: { human: 'x' } }) }],
      ['Edit', { file_path: '.aidrian.local.json', old_string: 'a', new_string: 'b' }],
      ['Write', { file_path: 'docs/notes.md', content: 'autoMerge is a key of .aidrian.local.json' }],
      ['Read', { file_path: '.aidrian.local.json' }],
      ['Bash', { command: 'jq .github.autoMerge .aidrian.local.json' }],
      ['Bash', { command: 'echo autoMerge > docs/.aidrian.local.json.md' }],
    ]) {
      assert.equal(run(subagent(dir, tool, toolInput)).status, 0, JSON.stringify(toolInput));
    }
    const { agent_id: _ignored, agent_type: _alsoIgnored, ...main } = subagent(dir, 'Write', { file_path: '.aidrian.local.json', content: on });
    assert.equal(run(main).status, 0, 'the main session may');
  }
});

test('a subagent may not set the review approvals switch, with or without gates; other local writes and the main session stay allowed', (t) => {
  const { dir } = project(t, { version: 1 });
  const local = path.join(dir, '.aidrian.local.json');
  writeFileSync(local, `${JSON.stringify({ names: { human: 'x' }, reviewApprovals: 'off' }, null, 2)}\n`);
  const on = JSON.stringify({ reviewApprovals: 'on' });
  const run = (input) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), cwd: dir, encoding: 'utf8' });
  for (const [tool, toolInput] of [
    ['Write', { file_path: '.aidrian.local.json', content: on }],
    ['Edit', { file_path: '.aidrian.local.json', old_string: '"off"', new_string: '"on"' }],
    ['Write', { file_path: '.aidrian.local.json', content: '{ "review\\u0041pprovals": "on" }' }],
    ['apply_patch', { command: '*** Begin Patch\n*** Update File: .aidrian.local.json\n@@\n-  "reviewApprovals": "off"\n+  "reviewApprovals": "on"\n*** End Patch\n' }],
    ['Bash', { command: `echo '${on}' > .aidrian.local.json` }],
  ]) {
    const result = run(subagent(dir, tool, toolInput));
    assert.equal(result.status, 2, JSON.stringify(toolInput));
    assert.match(result.stderr, /sets reviewApprovals in \.aidrian\.local\.json/u, JSON.stringify(toolInput));
  }
  for (const [tool, toolInput] of [
    ['Edit', { file_path: '.aidrian.local.json', old_string: '"human": "x"', new_string: '"human": "y"' }],
    ['Bash', { command: 'jq .reviewApprovals .aidrian.local.json' }],
    ['Write', { file_path: 'docs/notes.md', content: 'reviewApprovals is a key of .aidrian.local.json' }],
  ]) {
    assert.equal(run(subagent(dir, tool, toolInput)).status, 0, JSON.stringify(toolInput));
  }
  const { agent_id: _ignored, agent_type: _alsoIgnored, ...main } = subagent(dir, 'Write', { file_path: '.aidrian.local.json', content: on });
  assert.equal(run(main).status, 0, 'the main session may');
});

test('a subagent may not change the machine\'s product feedback choice, by any spelling; other local writes and the main session stay allowed', (t) => {
  const { dir } = project(t, { version: 1 });
  const local = path.join(dir, '.aidrian.local.json');
  const run = (input) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), cwd: dir, encoding: 'utf8' });
  writeFileSync(local, `${JSON.stringify({ names: { human: 'off' }, review: { productFeedback: { auto: true } } }, null, 2)}\n`);
  const edit = (from, to) => ['Edit', { file_path: local, old_string: from, new_string: to }];
  const patch = (file, ...lines) => ({ command: `*** Begin Patch\n*** Update File: ${file}\n@@\n${lines.join('\n')}\n*** End Patch\n` });
  for (const [tool, toolInput] of [
    ['Write', { file_path: local, content: JSON.stringify({ review: { productFeedback: { auto: false } } }) }],
    ['Write', { file_path: local, content: '{ "review": { "product\\u0046eedback": { "auto": false } } }' }],
    ['Write', { file_path: local, content: JSON.stringify({ names: { human: 'off' } }) }],
    ['Write', { file_path: local, content: '{ not json' }],
    edit('"auto": true', '"auto": false'),
    edit('"productFeedback": {\n      "auto": true', '"product\\u0046eedback": {\n      "auto": false'),
    edit('"auto": true', '"no longer JSON'),
    edit('"productFeedback": {\n      "auto": true\n    }', '"other": 1'),
    ['apply_patch', patch('.aidrian.local.json', '+    "productFeedback": { "auto": false }')],
    ['apply_patch', patch(local, '-    "productFeedback": { "auto": true }')],
    // Pretty-printed, the value sits on its own line, and the patch's context names the key or nothing.
    ['apply_patch', patch(local, '     "productFeedback": {', '-      "auto": true', '+      "auto": false')],
    ['apply_patch', patch('.aidrian.local.json', '-      "auto"  : true')],
    ['apply_patch', patch(local, '+    "productFeedback": {')],
    ['Bash', { command: `echo '{"review":{"productFeedback":{"auto":false}}}' > .aidrian.local.json` }],
    ['Bash', { command: `python3 -c "open('.aidrian.local.json','w').write('productFeedback')"` }],
  ]) {
    const result = run(subagent(dir, tool, toolInput));
    assert.equal(result.status, 2, JSON.stringify(toolInput));
    assert.match(result.stderr, /review\.productFeedback/u, JSON.stringify(toolInput));
  }
  for (const [tool, toolInput] of [
    edit('"human": "off"', '"human": "on"'),
    ['apply_patch', patch(local, '-  "names": {}', '+  "names": { "human": "x" }')],
    ['apply_patch', patch('docs/settings.json', '-      "auto": true', '+      "auto": false')],
    ['apply_patch', patch(local, '     "auto": true', '-  "names": {}')],
    ['Bash', { command: 'jq .review.productFeedback .aidrian.local.json' }],
    ['Bash', { command: 'echo productFeedback > docs/notes.md' }],
    ['Write', { file_path: 'docs/notes.md', content: 'productFeedback is a key' }],
  ]) {
    assert.equal(run(subagent(dir, tool, toolInput)).status, 0, JSON.stringify(toolInput));
  }
  const { agent_id: _ignored, agent_type: _alsoIgnored, ...main } = subagent(dir, 'Write', { file_path: local, content: JSON.stringify({ review: { productFeedback: { auto: false } } }) });
  assert.equal(run(main).status, 0, 'the main session may');
});

test('a subagent may not change the auto-merge switch without naming it: the guard reads what an Edit, Write, or apply_patch leaves', (t) => {
  const { dir } = project(t, { version: 1 });
  const local = path.join(dir, '.aidrian.local.json');
  writeFileSync(local, `${JSON.stringify({ names: { human: 'off' }, models: { claude: { agents: {} } }, github: { autoMerge: 'off' } }, null, 2)}\n`);
  const run = (input) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), cwd: dir, encoding: 'utf8' });
  const patch = (file, ...lines) => ({ command: ['*** Begin Patch', `*** Update File: ${file}`, '@@', ...lines, '*** End Patch', ''].join('\n') });
  const edit = (old_string, new_string, more = {}) => ['Edit', { file_path: '.aidrian.local.json', old_string, new_string, ...more }];
  for (const [tool, toolInput] of [
    edit('"autoMerge": "off"', '"autoMerge": "on"'),
    ['Edit', { file_path: local, old_string: '"autoMerge": "off"', new_string: '"auto\\u004derge": "on"' }],
    // The second "off" is the switch, so only replace_all reaches it.
    edit('"off"', '"on"', { replace_all: true }),
    edit('"autoMerge": "off"', '"other": 1'),
    edit('"autoMerge": "off"', '"no longer JSON'),
    ['Write', { file_path: '.aidrian.local.json', content: '{ "github": { "auto\\u004derge": "on" } }' }],
    ['Write', { file_path: '.aidrian.local.json', content: '{}' }],
    ['apply_patch', patch('.aidrian.local.json', '-    "autoMerge": "off"', '+    "autoMerge": "on"')],
    ['apply_patch', patch(local, '+    "autoMerge": "on",')],
    ['apply_patch', patch('.aidrian.local.json', '-    "autoMerge": "off"')],
    ['apply_patch', { command: '*** Begin Patch\n*** Add File: .aidrian.local.json\n+{ "github": { "autoMerge": "on" } }\n*** End Patch\n' }],
    ['apply_patch', patch('old.json', '*** Move to: .aidrian.local.json', '+{ "github": { "autoMerge": "on" } }')],
  ]) {
    const result = run(subagent(dir, tool, toolInput));
    assert.equal(result.status, 2, JSON.stringify(toolInput));
    assert.match(result.stderr, /github\.autoMerge/u, JSON.stringify(toolInput));
  }
  for (const [tool, toolInput] of [
    edit('"agents": {}', '"agents": { "explorer": { "model": "opus" } }'),
    // The text is written as it is: `$&` is no reference to what it replaces.
    edit('"human": "off"', '"human": "$&"'),
    edit('"off"', '"on"'),
    edit('"absent"', '"on"'),
    ['Edit', { file_path: 'src/app.js', old_string: '"off"', new_string: '"on"' }],
    ['Write', { file_path: '.aidrian.local.json', content: '{ "github": { "auto\\u004derge": "off" } }' }],
    ['apply_patch', patch('.aidrian.local.json', '     "autoMerge": "off"', '-  "models": {}', '+  "models": { "claude": {} }')],
    ['apply_patch', patch('docs/notes.md', '+autoMerge is a key of the local file')],
  ]) {
    assert.equal(run(subagent(dir, tool, toolInput)).status, 0, JSON.stringify(toolInput));
  }
  const { agent_id: _ignored, agent_type: _alsoIgnored, ...main } = subagent(dir, ...edit('"autoMerge": "off"', '"autoMerge": "on"'));
  assert.equal(run(main).status, 0, 'the main session may');
});

test('a subagent may not run `aidrian handoff continue`, with or without gates, in or out of a project; the main session may', (t) => {
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-noproject-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const run = (cwd, input) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), cwd, encoding: 'utf8' });
  const blocked = [
    'aidrian handoff continue /tmp/2026-11-15-x.md',
    'aidrian handoff continue /tmp/2026-11-15-x.md --route clear',
    'aidrian handoff --route clear continue x.md',
    '/opt/plugin/bin/aidrian handoff continue x.md',
    'node /opt/plugin/lib/cli.mjs handoff continue x.md',
    'cd /tmp && aidrian handoff continue x.md',
    "bash -c 'aidrian handoff continue x.md'",
    'echo "$(aidrian handoff continue x.md)"',
    "echo 'aidrian handoff continue x.md' | bash",
    'aidrian handoff "$ACTION" x.md',
    // A command word the lexer cannot read.
    'aidrian "$SUB" continue x.md',
    'A=handoff; aidrian $A continue x.md',
    'aidrian "$(echo handoff)" continue x.md',
    'aidrian "$SUB" "$ACTION" x.md',
    'aidrian "$SUB"',
    'aidrian $CMD x.md',
    'A="handoff continue"; aidrian $A x.md',
    'aidrian "$CMD" x.md',
    // A command word built from a variable or a substitution, before plain words that read handoff, then continue.
    '$AIDRIAN handoff continue x.md',
    '"${AIDRIAN}" handoff continue x.md --route clear',
    '$(command -v aidrian) handoff continue x.md',
    '`command -v aidrian` handoff continue x.md',
    'env $AIDRIAN handoff --route clear continue x.md',
  ];
  const allowed = [
    'aidrian handoff check x.md',
    'aidrian handoff snapshot x.md',
    'aidrian "$SUB" check x.md',
    '$AIDRIAN handoff check x.md',
    '$TOOL continue x.md',
    '$EDITOR handoff.md',
    'echo aidrian handoff continue',
    "grep -n 'handoff continue' docs/handoff.md",
  ];
  for (const [cwd, label] of [[project(t, { version: 1 }).dir, 'no gates'], [project(t).dir, 'gates'], [outside, 'no project']]) {
    for (const command of blocked) {
      const result = run(cwd, subagent(cwd, 'Bash', { command }));
      assert.equal(result.status, 2, `${label}: ${command}`);
      assert.match(result.stderr, /it runs `aidrian handoff continue`, which arms a continuation of the main session/u, `${label}: ${command}`);
    }
    for (const command of allowed) assert.equal(run(cwd, subagent(cwd, 'Bash', { command })).status, 0, `${label}: ${command}`);
    // Claude Code's Monitor tool runs its command in a shell, as Bash does, and a subagent may call it.
    for (const command of [blocked[0], blocked[4], '$AIDRIAN handoff continue x.md']) {
      const result = run(cwd, subagent(cwd, 'Monitor', { command, description: 'watch' }));
      assert.equal(result.status, 2, `${label}: Monitor ${command}`);
      assert.match(result.stderr, /it runs `aidrian handoff continue`/u, `${label}: Monitor ${command}`);
    }
    assert.equal(run(cwd, subagent(cwd, 'Monitor', { command: allowed[0], description: 'watch' })).status, 0, `${label}: Monitor check`);
    assert.equal(run(cwd, subagent(cwd, 'Monitor', { ws: { url: 'wss://example.test/aidrian handoff continue' } })).status, 0, `${label}: a WebSocket watch runs no shell`);
    // Claude Code's PowerShell tool runs a shell the lexer cannot read: its words are judged as opaque text.
    for (const command of ['aidrian handoff continue x.md', 'node C:/plugin/lib/cli.mjs handoff continue x.md', '& $a Handoff @("Continue", "x.md")', "$w = 'continue'; aidrian handoff $w x.md"]) {
      const result = run(cwd, subagent(cwd, 'PowerShell', { command }));
      assert.equal(result.status, 2, `${label}: PowerShell ${command}`);
      assert.match(result.stderr, /^aidrian: PowerShell is blocked for the agent "aidrian:explorer"[^\n]*it runs `aidrian handoff continue`/u, `${label}: PowerShell ${command}`);
    }
    for (const command of ['Get-ChildItem C:/repo', 'aidrian handoff check x.md']) assert.equal(run(cwd, subagent(cwd, 'PowerShell', { command })).status, 0, `${label}: PowerShell ${command}`);
    const { agent_id: _id, agent_type: _type, ...mainShell } = subagent(cwd, 'PowerShell', { command: 'aidrian handoff continue x.md' });
    assert.equal(run(cwd, mainShell).status, 0, `${label}: the main session's PowerShell may`);
    const { agent_id: _ignored, agent_type: _alsoIgnored, ...main } = subagent(cwd, 'Bash', { command: blocked[0] });
    assert.equal(run(cwd, main).status, 0, `${label}: the main session may`);
  }
  const { dir } = project(t, { version: 1 });
  const patch = { command: '*** Begin Patch\n*** Add File: notes.md\n+aidrian handoff continue x.md\n*** End Patch\n' };
  assert.equal(run(dir, subagent(dir, 'apply_patch', patch)).status, 0, 'a patch that names the command runs nothing');
});

test('a subagent may not write in the handoff continuation store, with or without gates; the main session may', (t) => {
  for (const config of [{ version: 1 }, GATED]) {
    const { dir } = project(t, config);
    const state = stateDir(findProject(dir));
    const root = path.join(process.env.XDG_STATE_HOME, 'aidrian');
    const handoffs = path.join(state, 'handoffs');
    const store = path.join(handoffs, '.continue');
    mkdirSync(store, { recursive: true });
    t.after(() => rmSync(state, { recursive: true, force: true }));
    const run = (input) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), cwd: dir, encoding: 'utf8' });
    const label = (toolInput) => `${config.agents ? 'gates' : 'no gates'}: ${JSON.stringify(toolInput)}`;
    for (const [tool, toolInput] of [
      ['Write', { file_path: path.join(store, 'armed-s1.json'), content: '{}' }],
      ['Edit', { file_path: path.join(store, 'from-s1.json'), old_string: '1', new_string: '2' }],
      ...[
        `echo {} > ${store}/ready-s1.json`,
        `cp /tmp/x.json ${store}/`,
        `mv /tmp/x.json ${store}/checked-2026-11-15-x.md.json`,
        `rm -rf ${handoffs}`,
        `rm -rf ${state}`,
        `rm -rf ${handoffs}/*`,
        `rm ${store}/*`,
        'cd "$STATE/handoffs" && echo {} > .continue/armed-s1.json',
        `python3 -c "open('${store}/armed-s1.json', 'w').write('{}')"`,
        'node -e "require(\'fs\').writeFileSync(process.env.S + \'/handoffs/.continue/armed-s1.json\', \'{}\')"',
        // A marker's name in a folder no path gives, in any case, and a bracket glob the shell expands.
        'cd "$X/handoffs/.continue" && echo {} > armed-s1.json',
        'cd "$X" && echo {} > READY-s1.json',
        `rm -rf ${handoffs}/[.]continue`,
        `rm -rf ${handoffs}/[.]cont*`,
        `rm -rf ${state}/handoff[s]/.continue`,
        // Bracket forms the guard does not model, or cannot compile, match any one character; `**` crosses folders.
        `cp /tmp/x.json ${handoffs}/.continu[]e]/`,
        `cp /tmp/x.json ${handoffs}/.continu[[:alpha:]]/`,
        `touch ${handoffs}/[z-a]; cp /tmp/x.json ${handoffs}/.continu[e]/`,
        `cp /tmp/x.json ${root}/**/.continue/`,
        `rm ${root}/**/.continue/armed-*.json`,
        'cd "$X/handoffs/.continue" && rm -f armed-*',
        // A glob in the first path part, right below the root.
        'rm -rf /*',
        `rm -rf /${state.split('/')[1].slice(0, 2)}*/${state.split('/').slice(2).join('/')}/handoffs/.continue`,
        `rm -rf /${realpathSync(state).split('/')[1].slice(0, 2)}*/${realpathSync(state).split('/').slice(2).join('/')}/handoffs/.continue`,
      ].map((command) => ['Bash', { command }]),
      // Claude Code's Monitor tool runs its command in a shell, as Bash does.
      ['Monitor', { command: `echo {} > ${store}/armed-S.json`, description: 'watch' }],
      ['Monitor', { command: `cp /tmp/x.json ${store}/ready-s1.json && tail -f /tmp/log`, description: 'watch' }],
      ['Monitor', { command: 'cd "$X/handoffs/.continue" && echo {} > armed-s1.json', description: 'watch' }],
      // Claude Code's PowerShell tool runs a shell the lexer cannot read: a word that names the store or a marker counts.
      ['PowerShell', { command: String.raw`Set-Content -Path "$env:S\handoffs\.continue\armed-s1.json" -Value '{}'` }],
      ['PowerShell', { command: String.raw`Copy-Item C:\tmp\x.json READY-s1.json` }],
      ['PowerShell', { command: "New-Item -ItemType Directory (Join-Path $s 'handoffs' '.Continue')" }],
      ['PowerShell', { command: `Get-Content ${store}/armed-s1.json` }],
      // On a disk that folds case, any spelling reaches the store.
      ...(FOLDS ? [
        ['Write', { file_path: path.join(handoffs, '.CONTINUE/armed-s1.json'), content: '{}' }],
        ['Write', { file_path: path.join(state, 'Handoffs/.continue/armed-s1.json'), content: '{}' }],
        ['Bash', { command: `echo {} > ${handoffs}/.Continue/armed-s1.json` }],
        ['Bash', { command: 'cd "$X" && echo {} > Handoffs/.Continue/notes.json' }],
      ] : []),
    ]) {
      const result = run(subagent(dir, tool, toolInput));
      assert.equal(result.status, 2, label(toolInput));
      assert.match(result.stderr, /the handoff continuation store, where only the main session's `aidrian handoff` commands write/u, label(toolInput));
    }
    for (const [tool, toolInput] of [
      ['Write', { file_path: path.join(handoffs, '2026-11-15-x.md'), content: '# Handoff\n' }],
      ['Write', { file_path: path.join(dir, 'src/app.js'), content: 'export {};\n' }],
      ['Bash', { command: `rm ${handoffs}/*.md` }],
      ['Bash', { command: `cat ${store}/armed-s1.json` }],
      ['Bash', { command: 'echo x > /tmp/aidrian-guard-unrelated.txt' }],
      ['Bash', { command: 'cd "$X" && echo {} > notes.json' }],
      // A chain floor's or task record's name is a common word: only the path rules cover them.
      ['Bash', { command: 'cd "$OUT" && echo {} > from-api.json' }],
      ['Bash', { command: 'cd "$OUT" && echo [] > tasks-list.json' }],
      ['Bash', { command: 'rm build/[a-z]*.o' }],
      ['Bash', { command: 'touch src/[z-a].js' }],
      ['Bash', { command: `rm -rf ${handoffs}/[0-9]*.md` }],
      ['Monitor', { command: `tail -f ${store}/armed-s1.json`, description: 'watch' }],
      ['PowerShell', { command: 'Get-ChildItem $env:TEMP | Select-Object -First 3' }],
      ['PowerShell', { command: `Remove-Item ${handoffs}/2026-11-15-x.md` }],
    ]) {
      assert.equal(run(subagent(dir, tool, toolInput)).status, 0, label(toolInput));
    }
    const { agent_id: _ignored, agent_type: _alsoIgnored, ...main } = subagent(dir, 'Write', { file_path: path.join(store, 'armed-s1.json'), content: '{}' });
    assert.equal(run(main).status, 0, 'the main session may');
    const { agent_id: _id, agent_type: _type, ...mainShell } = subagent(dir, 'PowerShell', { command: `Set-Content ${store}/armed-s1.json '{}'` });
    assert.equal(run(mainShell).status, 0, 'the main session\'s PowerShell may');
  }
});

test('a subagent\'s PowerShell command that names a guarded config file or the machine switches is refused; a Bash(prefix) allow never admits one', (t) => {
  const run = (cwd, input) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), cwd, encoding: 'utf8' });
  const gated = project(t).dir;
  for (const command of [String.raw`Set-Content .AIDRIAN\Config.json '{}'`, "Remove-Item -Recurse .aidrian/config.json"]) {
    const result = run(gated, subagent(gated, 'PowerShell', { command }));
    assert.equal(result.status, 2, command);
    assert.match(result.stderr, /^aidrian: PowerShell is blocked[^\n]*may change \.aidrian\/config\.json, which sets this project's agent gates/u, command);
  }
  assert.equal(run(gated, subagent(gated, 'PowerShell', { command: 'Get-ChildItem src' })).status, 0);
  const open = project(t, { version: 1 }).dir;
  for (const command of ["(Get-Content .aidrian.local.json) -replace 'off','on' | Set-Content .aidrian.local.json", '$j = gc .AIDRIAN.LOCAL.JSON | ConvertFrom-Json; $j.github.automerge = "on"']) {
    const result = run(open, subagent(open, 'PowerShell', { command }));
    assert.equal(result.status, 2, command);
    assert.match(result.stderr, /it names \.aidrian\.local\.json in a shell command the guard cannot read/u, command);
  }
  assert.equal(run(open, subagent(open, 'PowerShell', { command: 'Get-Content README.md' })).status, 0);
  const { agent_id: _id, agent_type: _type, ...main } = subagent(open, 'PowerShell', { command: "Set-Content .aidrian.local.json '{}'" });
  assert.equal(run(open, main).status, 0, 'the main session may');
  const limited = project(t, { version: 1, agents: { explorer: { allow: ['Read', 'Bash(git status)'] } } }).dir;
  const shell = run(limited, subagent(limited, 'PowerShell', { command: 'git status' }));
  assert.equal(shell.status, 2, 'a Bash(prefix) allow never admits a PowerShell command');
  assert.match(shell.stderr, /agents\.explorer\.allow does not list it/u);
});

test('globParts reads *, ?, and a [...] class, negated with !, in the last path part', () => {
  const { head, pattern, folders } = globParts('a/[.]cont*', ['/x', '/y']);
  assert.deepEqual([head, folders], ['a', ['/x/a', '/y/a']]);
  assert.ok(pattern.test('.continue'));
  assert.ok(!pattern.test('xcontinue'));
  assert.ok(globParts('/s/[!.]x?').pattern.test('ax1'));
  assert.ok(!globParts('/s/[!.]x?').pattern.test('.x1'));
  assert.ok(globParts('/s/[a-c].md').pattern.test('b.md'));
  assert.ok(globParts('/s/.CONTINUE', [], 'i').pattern.test('.continue'));
  // As the shell reads a class: a leading `]` is a member, and a POSIX class holds a `]` that does not close it.
  assert.ok(globParts('/s/.continu[]e]').pattern.test('.continue'));
  assert.ok(globParts('/s/[[:alpha:]x]y').pattern.test('zy'));
  // What it cannot compile or does not model matches any one character, and never throws.
  for (const text of ['/s/[z-a]*', '/s/[a-\\]*', '/s/.continu[[:alpha:]]', '/s/[[.a.]]x']) assert.doesNotThrow(() => globParts(text), text);
  assert.ok(globParts('/s/[z-a]*').pattern.test('.continue'));
  assert.ok(globParts('/s/.continu[[:alpha:]]').pattern.test('.continue'));
  assert.ok(globParts('/s/a[b').pattern.test('a[b'), 'an unclosed bracket is a plain character');
});

test('the store guard follows state.dir to a folder outside the state root', (t) => {
  const elsewhere = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-elsewhere-')));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  const { dir } = project(t, { version: 1, state: { dir: elsewhere } });
  const run = (input) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), cwd: dir, encoding: 'utf8' });
  assert.equal(run(subagent(dir, 'Write', { file_path: path.join(elsewhere, 'handoffs/.continue/armed-s1.json'), content: '{}' })).status, 2);
  assert.equal(run(subagent(dir, 'Write', { file_path: path.join(elsewhere, 'handoffs/2026-11-15-x.md'), content: '#\n' })).status, 0);
});

test('a gated subagent\'s bracket glob in a known folder gets the folder check, as a `*` glob does', (t) => {
  const { dir } = project(t);
  mkdirSync(path.join(dir, 'build'));
  const run = (command) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(subagent(dir, 'Bash', { command })), cwd: dir, encoding: 'utf8' });
  for (const command of ['rm -rf build/[a-z]*', 'rm -f build/[[:alpha:]]*', 'rm -f build/[!.]x']) assert.equal(run(command).status, 0, command);
  const refused = run('rm -f .aidrian/[c]onfig.json*');
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /\.aidrian\/config\.json/u);
});
