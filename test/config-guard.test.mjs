import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
    assert.match(reasonOf(command) ?? '', new RegExp(`^aidrian: Bash is blocked .* it may change ${file.replaceAll('.', '\\.')}, which sets`), command);
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
    assert.match(verdict(dir, subagent(dir, 'Bash', { command })) ?? '', /config\.json/, command);
  }
  assert.equal(verdict(dir, subagent(dir, 'Bash', { command: 'rm src/*' })), null);
  // An ordinary folder may hold a link to the config, which a glob there reaches.
  mkdirSync(path.join(dir, 'dist'));
  symlinkSync('../.aidrian/config.json', path.join(dir, 'dist/config.json'));
  assert.match(verdict(dir, subagent(dir, 'Bash', { command: "echo '{}' > dist/*.json" })) ?? '', /config\.json/);
  assert.equal(verdict(dir, subagent(dir, 'Bash', { command: 'rm dist/*.js' })), null);
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
  for (const command of ['rm src/*.js', 'ln -s /tmp/x src/link', 'rm -rf dist/*', 'cp a.txt out/*', 'cd build && rm -rf build/*']) {
    assert.equal(verdict(dir, subagent(dir, 'Bash', { command })), null, command);
  }
});
