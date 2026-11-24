import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { configWriteDenial, machineSwitchWriteDenial, OPAQUE_WORDS } from '../plugins/aidrian/lib/config-guard.mjs';
import { PastDeadline, withinDeadline } from '../plugins/aidrian/lib/deadline.mjs';
import { globParts } from '../plugins/aidrian/lib/fs.mjs';
import { defaultSessionsFolders } from '../plugins/aidrian/lib/handoff-guard.mjs';
import { noteFrom, openStore } from '../plugins/aidrian/lib/handoff-markers.mjs';
import { forgetGateSnapshot, saveGateSnapshot } from '../plugins/aidrian/lib/gate-snapshot.mjs';
import { configFiles, findProject, LOCAL_FILE as LOCAL_NAME, stateDir, stateRoot } from '../plugins/aidrian/lib/project.mjs';
import { sessionFolder } from '../plugins/aidrian/lib/session-folder.mjs';
import { originFolder, readOrigins } from '../plugins/aidrian/lib/session-origins.mjs';

import { hookCall } from './hook-call.mjs';

// The hooks this file runs record their blocks in the state folder; keep those rows out of the real one.
process.env.XDG_STATE_HOME = mkdtempSync(path.join(tmpdir(), 'aidrian-state-'));
after(() => rmSync(process.env.XDG_STATE_HOME, { recursive: true, force: true }));

const FOLDS = process.platform === 'darwin' || process.platform === 'win32';
const HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-agent-gates.mjs');
// The agent gates hook, called in this process as the host runs its script: spawnSync's options, its result's shape.
const inHook = (options) => hookCall(HOOK, options);
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

test('a subagent may not change a file that sets the gates, with any write tool or a Bash command that writes it', async (t) => {
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
  // A move into the existing config folder by its name is the move onto the file it makes there.
  const into = verdict(dir, subagent(dir, 'Bash', { command: 'mv /tmp/x/config.json .aidrian' }));
  assert.match(into ?? '', /^aidrian: Bash is blocked .* it changes \.aidrian\/config\.json,/);
  assert.equal(into, verdict(dir, subagent(dir, 'Bash', { command: 'mv /tmp/x/config.json .aidrian/config.json' })));
});

test('a subagent may still read those files and write anything else, and the main session may change them', async (t) => {
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
      // A file named like a handoff store record outside the store: `follow-` and `ending-` are common words.
      'cd "$OUT" && echo {} > follow-up.json',
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
      // A read bound to a name, then that name printed by its keys.
      "node -e \"const r = require('./.aidrian/config.json'); console.log(r['github'].autoMerge)\"",
      "node -e \"const r = JSON.parse(require('fs').readFileSync('.aidrian/config.json', 'utf8')); console.log(JSON.stringify(r.agents, null, 2))\"",
      "python3 -c \"import json; r = json.load(open('.aidrian/config.json')); print(r['agents'])\"",
      // The same reads over several lines.
      "node - <<'EOF'\nconst r =\n  require('./.aidrian/config.json');\nconsole.log(r.agents)\nEOF",
      "node - <<'EOF'\nconst r = require('./.aidrian/config.json')\n  .agents\nconsole.log(r)\nEOF",
      "python3 - <<'EOF'\nimport json\nr = json.load(\n  open('.aidrian/config.json'))\nprint(r['agents'])\nEOF",
    ].map((command) => ['Bash', { command }]),
  ];
  for (const [tool, toolInput] of allowed) assert.equal(verdict(dir, subagent(dir, tool, toolInput)), null, `${tool} ${JSON.stringify(toolInput)}`);

  const main = { tool_name: 'Edit', tool_input: { file_path: '.aidrian/config.json' }, cwd: dir };
  assert.equal(verdict(dir, main), null, 'the main session');
  assert.equal(verdict(dir, { ...main, agent_type: 'aidrian:explorer' }), null, 'a session started with --agent is the main session');
});

test('interpreter code with a long run of blank lines is judged in linear time', async (t) => {
  const { dir } = project(t);
  for (const command of [`node -e "console.log(1)${'\n'.repeat(40000)}x"`, `node -e "const r =${'\n'.repeat(40000)}x"`]) {
    const before = process.cpuUsage();
    verdict(dir, subagent(dir, 'Bash', { command }));
    const { user, system } = process.cpuUsage(before);
    assert.ok((user + system) / 1000 < 1000, `took ${Math.round((user + system) / 1000)} ms of CPU`);
  }
});

test('a write to an unknown folder, or code an interpreter runs, is judged by the names it holds', async (t) => {
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
    // A write after a read on the next line, or inside brackets over several lines.
    ["node - <<'EOF'\nconst r = require('./x.json')\nrequire('fs').unlinkSync('.aidrian/config.json')\nEOF", '.aidrian/config.json'],
    ["python3 - <<'EOF'\nprint(\n  open('.aidrian/config.json', 'w'))\nEOF", '.aidrian/config.json'],
    // A binding that would turn a later read into another call.
    ["node -e \"const readFileSync = require('child_process').execSync; readFileSync('rm .aidrian/config.json')\"", '.aidrian/config.json'],
    ["node -e \"var JSON = require('./x.json'); console.log(JSON.parse(require('fs').readFileSync('.aidrian/config.json')))\"", '.aidrian/config.json'],
    ["python3 -c \"import json; open = json.load(open('x.json')); print(open('.aidrian/config.json').read())\"", '.aidrian/config.json'],
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

test('the session`s gate snapshot, the file that marks the session gated, and their folder are guarded as the config is', async (t) => {
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

test('a project folder that .aidrian.json moves is guarded where it is, and so is the default one it falls back to', async (t) => {
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

test('in a worktree, the main checkout`s .aidrian.local.json, which the worktree reads, is guarded too', async (t) => {
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

test('the hook blocks a subagent that changes the gates with exit 2, and lets it run without gates or as the main session', async (t) => {
  const gated = project(t).dir;
  const open = project(t, { version: 1 }).dir;
  const run = (cwd, input) => inHook({ input: JSON.stringify(input), cwd, encoding: 'utf8' });
  const edit = (cwd) => subagent(cwd, 'Edit', { file_path: '.aidrian/config.json' });

  const blocked = await run(gated, edit(gated));
  assert.deepEqual([blocked.status, blocked.stdout], [2, '']);
  assert.match(blocked.stderr, /^aidrian: Edit is blocked for the agent "aidrian:explorer" in this project: it changes \.aidrian\/config\.json,/);
  assert.match(blocked.stderr, /tell the product owner what the task needs\.\n$/);
  for (const [cwd, input] of [
    [open, edit(open)],
    [gated, { tool_name: 'Edit', tool_input: { file_path: '.aidrian/config.json' }, cwd: gated }],
    [gated, subagent(gated, 'Edit', { file_path: 'src/app.js' })],
  ]) {
    const { status, stdout, stderr } = await run(cwd, input);
    assert.deepEqual([status, stdout, stderr], [0, '', ''], `${cwd}: ${JSON.stringify(input)}`);
  }
});

test('a glob reaches a config file that is a symlink to another folder, by the path it is spelled with', async (t) => {
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

test('a link to a config file not made yet changes it: a write through the link creates the file', async (t) => {
  const { dir } = project(t);
  mkdirSync(path.join(dir, 'out'));
  symlinkSync('../.aidrian.local.json', path.join(dir, 'out/alias'));
  for (const command of ["echo '{}' > out/alias", "printf x | tee out/alias", `echo x > ${path.join(dir, 'out/alias')}`]) {
    assert.match(verdict(dir, subagent(dir, 'Bash', { command })) ?? '', /changes \.aidrian\.local\.json/, command);
  }
  assert.match(verdict(dir, subagent(dir, 'Write', { file_path: path.join(dir, 'out/alias') })) ?? '', /changes \.aidrian\.local\.json/);
  assert.equal(verdict(dir, subagent(dir, 'Bash', { command: 'echo x > out/other' })), null);
});

test('ln, truncate, install, dd, git checkout --, git restore, and a glob that may name a guarded file change it', async (t) => {
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

test('a subagent may not set the auto-merge switch, with or without gates; other local writes and the main session stay allowed', async (t) => {
  const on = JSON.stringify({ github: { autoMerge: 'on' } });
  const gated = project(t).dir;
  const denied = await inHook({ input: JSON.stringify(subagent(gated, 'Write', { file_path: '.aidrian.local.json', content: on })), cwd: gated, encoding: 'utf8' });
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /github\.autoMerge/u, 'with gates, this rule answers first');
  {
    const { dir } = project(t, { version: 1 });
    const run = (input) => inHook({ input: JSON.stringify(input), cwd: dir, encoding: 'utf8' });
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
      const result = await run(subagent(dir, tool, toolInput));
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
      assert.equal((await run(subagent(dir, tool, toolInput))).status, 0, JSON.stringify(toolInput));
    }
    const { agent_id: _ignored, agent_type: _alsoIgnored, ...main } = subagent(dir, 'Write', { file_path: '.aidrian.local.json', content: on });
    assert.equal((await run(main)).status, 0, 'the main session may');
  }
});

test('interpreter code that names the local file only in its comments sets no switch; a quoted text or any write names it, and the refusal points to Edit and Write', (t) => {
  const { dir } = project(t, { version: 1 });
  const found = findProject(dir);
  const denial = (tool, toolInput) => machineSwitchWriteDenial(subagent(dir, tool, toolInput), found, { names: { human: 'the owner' } });
  const judge = (command) => denial('Bash', { command })?.match ?? null;
  const L = '.aidrian.local.json';
  const py = (code) => `python3 - <<'PY'\n${code}\nPY`;
  const js = (code) => `node - <<'JS'\n${code}\nJS`;
  for (const command of [
    py(`# a note on ${L} and github.autoMerge\nopen('docs/x.md', 'a').write('its keys')`),
    py(`# See **${L}**.\nopen('docs/x.md', 'a').write('github.autoMerge')`),
    js(`// docs: \`${L}\`\nrequire('fs').appendFileSync('docs/x.md', 'github.autoMerge')`),
    // A block comment loses both its marks, so a name glued to the closing one is still a word of its own.
    js(`/* writes docs, not ${L}*/\nrequire('fs').appendFileSync('docs/x.md', 'github.autoMerge')`),
    // A read-only search of a transcript whose pattern names the key and the file, as the issue reports.
    `grep -n 'github.autoMerge' ~/.claude/projects/x/s.jsonl | grep ${L}`,
    `rg -n 'github\\.autoMerge.*${L}' ~/.claude/projects/x/`,
  ]) assert.equal(judge(command), null, command);
  // The Write and Edit tools are judged by the file they write, so a docs or test file whose text names both runs.
  for (const [tool, toolInput] of [
    ['Edit', { file_path: path.join(dir, 'docs/config.md'), old_string: 'x', new_string: `Set \`github.autoMerge\` in \`${L}\` to "on".` }],
    ['Write', { file_path: path.join(dir, 'test/x.test.mjs'), content: `writeFileSync(path.join(dir, '${L}'), JSON.stringify({ github: { autoMerge: 'on' } }));\n` }],
  ]) assert.equal(denial(tool, toolInput), null, JSON.stringify(toolInput));
  // A docs edit written from code, as the issue's subagent ran, stays refused, and the refusal says how to make it.
  for (const command of [
    py(`import pathlib\np = pathlib.Path('docs/config.md')\nt = p.read_text()\nt = t.replace('x', 'Set \`github.autoMerge\` in \`${L}\` to "on".')\np.write_text(t)`),
    py(`open('docs/x.md', 'a').write('the ${L} file')`),
  ]) assert.match(denial('Bash', { command })?.reason ?? '', /to edit a doc or test file that mentions \.aidrian\.local\.json, use the Edit or Write tool, which the guard judges by the file it writes/u, command);
  for (const [command, match] of [
    // Code can derive the path from any text: a bare word split, replaced, or sliced out, or a wrapped name stripped.
    [py(`open('see ${L} here'.split()[1], 'w').write('autoMerge')`), /sets github\.autoMerge/u],
    [py(`open('the ${L} file'.replace('the ', '').replace(' file', ''), 'w').write('autoMerge')`), /sets github\.autoMerge/u],
    [py(`p = 'x ${L}'[2:]\nopen(p, 'w').write('{}')`), /changes \.aidrian\.local\.json/u],
    [js(`const p = 'see ${L} here'.split(' ')[1]\nrequire('fs').writeFileSync(p, 'autoMerge')`), /sets github\.autoMerge/u],
    [py(`open('see \`${L}\` here'.split('\`')[1], 'w').write('autoMerge')`), /sets github\.autoMerge/u],
    [py(`open('(${L})'.strip('()'), 'w').write('{}')`), /changes \.aidrian\.local\.json/u],
    [py(`open('docs/x.md', 'a').write('Notes on **${L}**, and its keys.')  # autoMerge`), /sets github\.autoMerge/u],
    [py(`open('${L}', 'w').write('{"github": {"autoMerge": "on"}}')`), /sets github\.autoMerge/u],
    [py(`import json\np = '${L}'\nd = json.load(open(p))\nd['github'] = {'autoMerge': 'on'}\njson.dump(d, open(p, 'w'))`), /sets github\.autoMerge/u],
    [py(`import shutil\nshutil.copy('prepared.json', '${L}')`), /changes \.aidrian\.local\.json/u],
    [py(`import os\nos.system('cp prepared.json ${L}')  # autoMerge`), /sets github\.autoMerge/u],
    [py(`import os\ncmd = 'cp x'\nos.system(f"{cmd} ${L}")  # autoMerge`), /sets github\.autoMerge/u],
    [py(`import os\nopen(f"{os.path.join('.', "${L}")}", 'w').write('autoMerge')`), /sets github\.autoMerge/u],
    [py(`open('notes.md', 'w').write('see ${L} or ~/${L}')  # autoMerge`), /sets github\.autoMerge/u],
    [py(`open('x', 'w').write('a'); open("""${L}""", 'w')  # autoMerge`), /sets github\.autoMerge/u],
    [`python3 - ${L} <<'PY'\nimport sys, json\njson.dump({'github': {'autoMerge': 'on'}}, open(sys.argv[1], 'w'))\nPY`, /sets github\.autoMerge/u],
    [`python3 -c "open('${L}','w').write('autoMerge')"`, /sets github\.autoMerge/u],
    // A path quoted inside a longer text, as a test fixture written from code holds, still names the file.
    [js(`require('fs').writeFileSync('test/x.test.mjs', "writeFileSync(path.join(dir, '${L}'), JSON.stringify({ github: { autoMerge: 'on' } }))")`), /sets github\.autoMerge/u],
    [js(`require('child_process').execSync('echo autoMerge | tee ${L}')`), /sets github\.autoMerge/u],
    ['node -e "require(\'fs\').writeFileSync(`${process.cwd()}/' + L + '`, \'autoMerge\')"', /sets github\.autoMerge/u],
    [`ruby -e 'File.write("${L}", "autoMerge")'`, /sets github\.autoMerge/u],
    [`perl -e 'open(F, ">${L}"); print F "autoMerge"'`, /sets github\.autoMerge/u],
    // The shell's own writes are read as before, a copy over the file among them.
    [`echo autoMerge | tee ${L}`, /sets github\.autoMerge/u],
    [`sed -i '' 's/off/on/' ${L}  # autoMerge`, /sets github\.autoMerge/u],
    [`perl -pi -e 's/off/on/' ${L}`, /changes \.aidrian\.local\.json/u],
    [`cp prepared.json ${L}`, /changes \.aidrian\.local\.json/u],
    [`mv prepared.json ${L}`, /changes \.aidrian\.local\.json/u],
    [`echo '{}' > ${L}`, /changes \.aidrian\.local\.json/u],
  ]) assert.match(judge(command) ?? 'allowed', match, command);
});

test('a subagent may not set the review approvals switch, with or without gates; other local writes and the main session stay allowed', async (t) => {
  const { dir } = project(t, { version: 1 });
  const local = path.join(dir, '.aidrian.local.json');
  writeFileSync(local, `${JSON.stringify({ names: { human: 'x' }, reviewApprovals: 'off' }, null, 2)}\n`);
  const on = JSON.stringify({ reviewApprovals: 'on' });
  const run = (input) => inHook({ input: JSON.stringify(input), cwd: dir, encoding: 'utf8' });
  for (const [tool, toolInput] of [
    ['Write', { file_path: '.aidrian.local.json', content: on }],
    ['Edit', { file_path: '.aidrian.local.json', old_string: '"off"', new_string: '"on"' }],
    ['Write', { file_path: '.aidrian.local.json', content: '{ "review\\u0041pprovals": "on" }' }],
    ['apply_patch', { command: '*** Begin Patch\n*** Update File: .aidrian.local.json\n@@\n-  "reviewApprovals": "off"\n+  "reviewApprovals": "on"\n*** End Patch\n' }],
    ['Bash', { command: `echo '${on}' > .aidrian.local.json` }],
  ]) {
    const result = await run(subagent(dir, tool, toolInput));
    assert.equal(result.status, 2, JSON.stringify(toolInput));
    assert.match(result.stderr, /sets reviewApprovals in \.aidrian\.local\.json/u, JSON.stringify(toolInput));
  }
  for (const [tool, toolInput] of [
    ['Edit', { file_path: '.aidrian.local.json', old_string: '"human": "x"', new_string: '"human": "y"' }],
    ['Bash', { command: 'jq .reviewApprovals .aidrian.local.json' }],
    ['Write', { file_path: 'docs/notes.md', content: 'reviewApprovals is a key of .aidrian.local.json' }],
  ]) {
    assert.equal((await run(subagent(dir, tool, toolInput))).status, 0, JSON.stringify(toolInput));
  }
  const { agent_id: _ignored, agent_type: _alsoIgnored, ...main } = subagent(dir, 'Write', { file_path: '.aidrian.local.json', content: on });
  assert.equal((await run(main)).status, 0, 'the main session may');
});

test('a subagent may not turn on the background handoff; other local writes and the main session stay allowed', async (t) => {
  const { dir } = project(t, { version: 1 });
  writeFileSync(path.join(dir, '.aidrian.local.json'), `${JSON.stringify({ names: { human: 'x' }, handoff: { background: 'off' } }, null, 2)}\n`);
  const on = JSON.stringify({ handoff: { background: 'on' } });
  const run = (input) => inHook({ input: JSON.stringify(input), cwd: dir, encoding: 'utf8' });
  for (const [tool, toolInput] of [
    ['Write', { file_path: '.aidrian.local.json', content: on }],
    ['Edit', { file_path: '.aidrian.local.json', old_string: '"off"', new_string: '"on"' }],
    ['apply_patch', { command: '*** Begin Patch\n*** Update File: .aidrian.local.json\n@@\n-    "background": "off"\n+    "background": "on"\n*** End Patch\n' }],
    ['Bash', { command: `echo '${on}' > .aidrian.local.json` }],
  ]) {
    const result = await run(subagent(dir, tool, toolInput));
    assert.equal(result.status, 2, JSON.stringify(toolInput));
    assert.match(result.stderr, /sets handoff\.background in \.aidrian\.local\.json/u, JSON.stringify(toolInput));
  }
  for (const [tool, toolInput] of [
    ['Edit', { file_path: '.aidrian.local.json', old_string: '"human": "x"', new_string: '"human": "y"' }],
    ['Write', { file_path: 'docs/notes.md', content: 'background is a key of .aidrian.local.json' }],
  ]) {
    assert.equal((await run(subagent(dir, tool, toolInput))).status, 0, JSON.stringify(toolInput));
  }
  const { agent_id: _ignored, agent_type: _alsoIgnored, ...main } = subagent(dir, 'Write', { file_path: '.aidrian.local.json', content: on });
  assert.equal((await run(main)).status, 0, 'the main session may');
});

test('a main session the background handoff route started may not set any machine switch; an ordinary main session may', async (t) => {
  const { dir } = project(t, { version: 1 });
  const state = stateDir(findProject(dir));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const store = openStore(state, { checkouts: [dir], maxChain: 3 });
  const floor = (session, route) => assert.ok(noteFrom(store, session, { slug: 'widget', chain: 1, brief: path.join(state, 'handoffs/2026-11-15-widget.md'), route }));
  // One floor under the full id, one under the short id the start printed before the listing named the session.
  const full = 'abcd1234-0000-4000-8000-000000000001';
  const short = 'beef5678-0000-4000-8000-000000000002';
  floor(full, 'background');
  floor('beef5678', 'background');
  floor('cleared-session', 'clear');
  const run = (session, tool, toolInput) => inHook({ input: JSON.stringify({ session_id: session, tool_name: tool, tool_input: toolInput, cwd: dir }), cwd: dir, encoding: 'utf8' });
  const writes = [
    ['github.autoMerge', { github: { autoMerge: { enabled: true } } }],
    ['github.unattendedWaiver', { github: { unattendedWaiver: { enabled: true } } }],
    ['reviewApprovals', { reviewApprovals: 'on' }],
    ['unattendedSignoff', { unattendedSignoff: 'on' }],
    ['handoff.background', { handoff: { background: 'on' } }],
    ['review.productFeedback', { review: { productFeedback: { auto: true } } }],
    ['projectRun.forgeTokenKeychain', { projectRun: { forgeTokenKeychain: { service: 'other', account: 'me' } } }],
  ];
  for (const session of [full, short]) {
    for (const [name, value] of writes) {
      const written = await run(session, 'Write', { file_path: '.aidrian.local.json', content: JSON.stringify(value) });
      assert.equal(written.status, 2, `${session}: ${name}`);
      assert.ok(written.stderr.includes(`sets ${name} in .aidrian.local.json, and only a main session a Human attends may`), written.stderr);
      assert.match(written.stderr, /the background handoff route started this one, with no Human/u);
    }
    const shell = await run(session, 'Bash', { command: `echo '${JSON.stringify(writes[0][1])}' > .aidrian.local.json` });
    assert.equal(shell.status, 2, `${session}: a Bash write`);
    // Other writes to the local file, and anything else, stay its own.
    assert.equal((await run(session, 'Write', { file_path: '.aidrian.local.json', content: JSON.stringify({ names: { human: 'x' } }) })).status, 0, session);
    assert.equal((await run(session, 'Write', { file_path: 'src/app.js', content: 'export {};\n' })).status, 0, session);
  }
  // A main session with no floor, or one a clear started, has a Human: it may set them.
  for (const session of ['plain-session', 'cleared-session', undefined]) {
    for (const [name, value] of writes) {
      assert.equal((await run(session, 'Write', { file_path: '.aidrian.local.json', content: JSON.stringify(value) })).status, 0, `${session}: ${name}`);
    }
  }
});

// A project whose store holds a floor of route `background` for `full`, one under the short id of `short`, and one of
// route `clear`; `run` sends one call of a session, or of a subagent of it, to the agent gates hook.
function unattendedSetting(t) {
  const { dir } = project(t, { version: 1 });
  const state = stateDir(findProject(dir));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const handoffs = path.join(state, 'handoffs');
  const store = openStore(state, { checkouts: [dir], maxChain: 3 });
  const full = 'abcd1234-0000-4000-8000-000000000001';
  const short = 'beef5678-0000-4000-8000-000000000002';
  const floor = (session, route) => assert.ok(noteFrom(store, session, { slug: 'widget', chain: 1, brief: path.join(handoffs, '2026-11-15-widget.md'), route }));
  floor(full, 'background');
  floor('beef5678', 'background');
  floor('cleared-session', 'clear');
  const run = (session, command, { agent = false } = {}) => inHook({
    input: JSON.stringify({ session_id: session, tool_name: 'Bash', tool_input: { command }, cwd: dir, ...(agent ? { agent_id: 'a5f0c1', agent_type: 'aidrian:explorer' } : {}) }),
    cwd: dir, encoding: 'utf8',
  });
  return { dir, state, handoffs, store: store.dir, full, short, run };
}

test('a main session the background route started may not delete, overwrite, or hide its own floor; an attended one may', async (t) => {
  const { dir, state, handoffs, store, full, short, run } = unattendedSetting(t);
  const own = path.join(store, `from-${full}.json`);
  const blocked = [
    `rm ${own}`,
    `rm -f ${store}/from-beef5678.json`,
    `echo '{}' > ${own}`,
    `cp /tmp/x.json ${own}`,
    `rm -rf ${handoffs}`,
    // A mode or owner the store's reads refuse hides the floor as well as a delete does.
    `chmod 777 ${handoffs}`,
    `chmod o+w ${state}`,
    `chmod 000 ${own}`,
    `chmod -R go+w ${path.dirname(state)}`,
    `chown other ${store}`,
    'cd "$X" && chmod 777 handoffs/.continue',
    // The claim of a session on a start, which a removal would lift.
    'cd "$X" && rm claim-*',
    'cd "$X" && rm .continue/claim-*',
  ];
  for (const session of [full, short]) {
    for (const command of blocked) {
      const result = await run(session, command);
      assert.equal(result.status, 2, `${session}: ${command}`);
      assert.match(result.stderr, /the handoff continuation store, where only `aidrian handoff` commands write, and the background handoff route started this session, with no Human/u, command);
    }
    // A change of mode anywhere else stays its own.
    assert.equal((await run(session, `chmod +x ${path.join(dir, 'src/app.js')}`)).status, 0, session);
    assert.equal((await run(session, `ls ${store}`)).status, 0, session);
  }
  // The floor is read before the call runs: refused once, it is still there to refuse the next one.
  assert.equal((await run(full, `rm ${own}`)).status, 2);
  assert.equal((await run(full, `echo '${JSON.stringify({ github: { autoMerge: { enabled: true } } })}' > .aidrian.local.json`)).status, 2, 'the switches stay refused');
  for (const session of ['plain-session', 'cleared-session', undefined]) {
    for (const command of blocked) assert.equal((await run(session, command)).status, 0, `${session}: ${command}`);
  }
  // A subagent is refused the change of mode too.
  assert.equal((await run('plain-session', `chmod 777 ${handoffs}`, { agent: true })).status, 2);
});

test('a main session the background route started, and a subagent, may not start a host session outside the gate', async (t) => {
  const { full, short, run } = unattendedSetting(t);
  const starts = ['claude -p "go on"', 'claude --bg "go on"', 'claude --resume abcd', 'claude -c', 'claude', '/usr/local/bin/claude --print x', 'claude mcp serve', 'bash -c "claude -p x"', 'echo "claude -p x" | sh', 'codex exec "go on"', 'codex resume --last'];
  const allowed = ['claude agents --json', 'claude stop abcd1234', 'claude attach abcd1234', 'claude --version', 'claude mcp list', 'codex login status', 'cat CLAUDE.md', 'echo claude'];
  for (const session of [full, short]) {
    for (const command of starts) {
      const result = await run(session, command);
      assert.equal(result.status, 2, `${session}: ${command}`);
      assert.match(result.stderr, /starts or resumes a session of (?:Claude Code|Codex) outside the handoff gate, which holds every session it starts to a chain floor, and a session starts another only through `aidrian handoff continue`, and the background handoff route started this session, with no Human/u, command);
    }
    for (const command of allowed) assert.equal((await run(session, command)).status, 0, `${session}: ${command}`);
  }
  for (const command of starts) {
    assert.equal((await run('plain-session', command)).status, 0, `an attended session may: ${command}`);
    assert.equal((await run('plain-session', command, { agent: true })).status, 2, `a subagent may not: ${command}`);
  }
  assert.match((await run('plain-session', 'claude -p x', { agent: true })).stderr, /starts or resumes a session of Claude Code outside the handoff gate/u);
  assert.match((await run('plain-session', 'codex exec x', { agent: true })).stderr, /starts or resumes a session of Codex outside the handoff gate/u);
});

test('a main session the background route started, and a subagent, may not run the gate with a variable of their own that moves it', async (t) => {
  const { full, short, run } = unattendedSetting(t);
  const moved = [
    'XDG_STATE_HOME=/tmp/elsewhere aidrian handoff continue b.md',
    'HOME=/tmp/elsewhere aidrian handoff continue b.md',
    'CLAUDE_CODE_SESSION_ID=fresh aidrian handoff continue b.md',
    'CLAUDE_CODE_AGENT=other aidrian handoff continue b.md',
    'env PATH=/tmp/bin aidrian handoff continue b.md',
    'export XDG_STATE_HOME=/tmp/elsewhere; aidrian handoff continue b.md',
    'XDG_STATE_HOME=/tmp/elsewhere aidrian handoff route',
    // An unset moves the store as a set does: with no XDG_STATE_HOME, it is the user's own.
    'env -u XDG_STATE_HOME aidrian handoff continue b.md',
    'env --unset=HOME aidrian handoff continue b.md',
    'unset XDG_STATE_HOME; aidrian handoff continue b.md',
    'builtin unset PATH && aidrian handoff route',
    'env -i aidrian handoff continue b.md',
  ];
  const plain = ['aidrian handoff continue b.md', 'aidrian handoff route', 'XDG_STATE_HOME=/tmp/elsewhere aidrian handoff check b.md'];
  // Any other variable is refused too: the gate needs none.
  const other = ['FOO=1 aidrian handoff continue b.md', 'env -u FOO aidrian handoff continue b.md', 'unset FOO; aidrian handoff route'];
  for (const session of [full, short]) {
    for (const command of moved) {
      const result = await run(session, command);
      assert.equal(result.status, 2, `${session}: ${command}`);
      assert.match(result.stderr, /it runs `aidrian handoff` or `aidrian project` with \w+ set or unset by the command itself, which would move the continuation store, the session, or the host command the gate reads, or the policy it reads/u, command);
    }
    for (const command of other) {
      const result = await run(session, command);
      assert.equal(result.status, 2, `${session}: ${command}`);
      assert.match(result.stderr, /it runs `aidrian handoff` or `aidrian project` with FOO set or unset by the command itself, and the gate runs with no variable a command sets/u, command);
    }
    for (const command of plain) assert.equal((await run(session, command)).status, 0, `${session}: ${command}`);
  }
  for (const command of moved) assert.equal((await run('plain-session', command)).status, 0, `an attended session may: ${command}`);
  // A subagent may run no gate at all; the route, which writes nothing, it may run only as the host gave it.
  assert.equal((await run('plain-session', 'aidrian handoff route', { agent: true })).status, 0);
  assert.equal((await run('plain-session', 'XDG_STATE_HOME=/tmp/elsewhere aidrian handoff route', { agent: true })).status, 2);
});

test('a subagent may not change the machine\'s product feedback choice, by any spelling; other local writes and the main session stay allowed', async (t) => {
  const { dir } = project(t, { version: 1 });
  const local = path.join(dir, '.aidrian.local.json');
  const run = (input) => inHook({ input: JSON.stringify(input), cwd: dir, encoding: 'utf8' });
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
    const result = await run(subagent(dir, tool, toolInput));
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
    assert.equal((await run(subagent(dir, tool, toolInput))).status, 0, JSON.stringify(toolInput));
  }
  const { agent_id: _ignored, agent_type: _alsoIgnored, ...main } = subagent(dir, 'Write', { file_path: local, content: JSON.stringify({ review: { productFeedback: { auto: false } } }) });
  assert.equal((await run(main)).status, 0, 'the main session may');
});

test('a subagent may not change the keychain entry a project run takes its forge token from, nor void it by a sibling key', async (t) => {
  const { dir } = project(t, { version: 1 });
  const local = path.join(dir, LOCAL_NAME);
  const run = (input) => inHook({ input: JSON.stringify(input), cwd: dir, encoding: 'utf8' });
  writeFileSync(local, `${JSON.stringify({ names: { human: 'off' }, projectRun: { forgeTokenKeychain: { service: 'aidrian-forge', account: 'me' } } }, null, 2)}\n`);
  const edit = (from, to) => ['Edit', { file_path: local, old_string: from, new_string: to }];
  const patch = (file, ...lines) => ({ command: `*** Begin Patch\n*** Update File: ${file}\n@@\n${lines.join('\n')}\n*** End Patch\n` });
  for (const [tool, toolInput] of [
    // A sibling under projectRun makes the reader drop the whole setting, so the token falls to the next source.
    edit('"projectRun": {', '"projectRun": {\n    "x": 1,'),
    edit('"service": "aidrian-forge"', '"service": "aidrian-forge", "extra": 1'),
    edit('"account": "me"', '"account": "other"'),
    ['Write', { file_path: local, content: JSON.stringify({ names: { human: 'off' } }) }],
    // A patch is not applied: while the file selects an entry, any line it adds or removes counts.
    ['apply_patch', patch(local, '+    "x": 1,')],
    ['apply_patch', patch(local, '-  "names": { "human": "off" },')],
    ['apply_patch', patch(LOCAL_NAME, '+  "projectRun": {}')],
    // A delete or a move of the file has no line to add or remove, and drops the setting all the same.
    ['apply_patch', { command: `*** Begin Patch\n*** Delete File: ${local}\n*** End Patch\n` }],
    ['apply_patch', { command: `*** Begin Patch\n*** Update File: ${local}\n*** Move to: ${path.join(dir, 'moved.json')}\n*** End Patch\n` }],
    // Several operations, the second one on the local file: each is judged against its own file.
    ['apply_patch', { command: `*** Begin Patch\n*** Update File: ${path.join(dir, 'notes', LOCAL_NAME)}\n@@\n+{}\n*** Delete File: ${local}\n*** End Patch\n` }],
    ['apply_patch', { command: `*** Begin Patch\n*** Add File: ${path.join(dir, 'docs.md')}\n+notes\n*** Update File: ${local}\n*** Move to: ${path.join(dir, 'moved.json')}\n*** End Patch\n` }],
  ]) {
    const result = await run(subagent(dir, tool, toolInput));
    assert.equal(result.status, 2, JSON.stringify(toolInput));
    assert.match(result.stderr, /projectRun\.forgeTokenKeychain/u, JSON.stringify(toolInput));
  }
  // A local file that selects no entry takes a patch or an edit of another key, as before.
  writeFileSync(local, `${JSON.stringify({ names: { human: 'off' } }, null, 2)}\n`);
  // But a move into it of a file that would select one is judged as the new local file, and refused.
  writeFileSync(path.join(dir, 'staged.json'), JSON.stringify({ projectRun: { forgeTokenKeychain: { service: 'other', account: 'me' } } }));
  const into = await run(subagent(dir, 'apply_patch', { command: `*** Begin Patch\n*** Update File: ${path.join(dir, 'staged.json')}\n*** Move to: ${local}\n*** End Patch\n` }));
  assert.equal(into.status, 2, into.stderr);
  assert.match(into.stderr, /projectRun\.forgeTokenKeychain/u);
  assert.equal((await run(subagent(dir, 'apply_patch', patch(local, '-  "names": {}', '+  "names": { "human": "x" }')))).status, 0);
  assert.equal((await run(subagent(dir, 'Edit', { file_path: local, old_string: '"human": "off"', new_string: '"human": "on"' }))).status, 0);
});

test('a subagent may not change the auto-merge switch without naming it: the guard reads what an Edit, Write, or apply_patch leaves', async (t) => {
  const { dir } = project(t, { version: 1 });
  const local = path.join(dir, '.aidrian.local.json');
  writeFileSync(local, `${JSON.stringify({ names: { human: 'off' }, models: { claude: { agents: {} } }, github: { autoMerge: 'off' } }, null, 2)}\n`);
  const run = (input) => inHook({ input: JSON.stringify(input), cwd: dir, encoding: 'utf8' });
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
    const result = await run(subagent(dir, tool, toolInput));
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
    assert.equal((await run(subagent(dir, tool, toolInput))).status, 0, JSON.stringify(toolInput));
  }
  const { agent_id: _ignored, agent_type: _alsoIgnored, ...main } = subagent(dir, ...edit('"autoMerge": "off"', '"autoMerge": "on"'));
  assert.equal((await run(main)).status, 0, 'the main session may');
});

test('a subagent may not run `aidrian handoff continue`, with or without gates, in or out of a project; the main session may', async (t) => {
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-noproject-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const run = (cwd, input) => inHook({ input: JSON.stringify(input), cwd, encoding: 'utf8' });
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
    // A shell runs a script it cannot read, whose arguments read handoff, then continue, as separate words.
    'bash run.sh handoff continue x.md',
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
    // A test file's name is one word, not the two words handoff and continue, even passed to a script a shell runs.
    'zsh /tmp/hal-bak/run-tests.sh session-snapshot handoff-continue-hooks',
    'bash run-tests.sh test/handoff-continue-hooks.test.mjs test/handoff.continue.test.mjs',
  ];
  for (const [cwd, label] of [[project(t, { version: 1 }).dir, 'no gates'], [project(t).dir, 'gates'], [outside, 'no project']]) {
    for (const command of blocked) {
      const result = await run(cwd, subagent(cwd, 'Bash', { command }));
      assert.equal(result.status, 2, `${label}: ${command}`);
      assert.match(result.stderr, /it runs `aidrian handoff continue`, which arms a continuation of the main session/u, `${label}: ${command}`);
    }
    for (const command of allowed) assert.equal((await run(cwd, subagent(cwd, 'Bash', { command }))).status, 0, `${label}: ${command}`);
    // Claude Code's Monitor tool runs its command in a shell, as Bash does, and a subagent may call it.
    for (const command of [blocked[0], blocked[4], '$AIDRIAN handoff continue x.md']) {
      const result = await run(cwd, subagent(cwd, 'Monitor', { command, description: 'watch' }));
      assert.equal(result.status, 2, `${label}: Monitor ${command}`);
      assert.match(result.stderr, /it runs `aidrian handoff continue`/u, `${label}: Monitor ${command}`);
    }
    assert.equal((await run(cwd, subagent(cwd, 'Monitor', { command: allowed[0], description: 'watch' }))).status, 0, `${label}: Monitor check`);
    assert.equal((await run(cwd, subagent(cwd, 'Monitor', { ws: { url: 'wss://example.test/aidrian handoff continue' } }))).status, 0, `${label}: a WebSocket watch runs no shell`);
    // Claude Code's PowerShell tool runs a shell the lexer cannot read: its words are judged as opaque text.
    for (const command of ['aidrian handoff continue x.md', 'node C:/plugin/lib/cli.mjs handoff continue x.md', '& $a Handoff @("Continue", "x.md")', "$w = 'continue'; aidrian handoff $w x.md"]) {
      const result = await run(cwd, subagent(cwd, 'PowerShell', { command }));
      assert.equal(result.status, 2, `${label}: PowerShell ${command}`);
      assert.match(result.stderr, /^aidrian: PowerShell is blocked for the agent "aidrian:explorer"[^\n]*it runs `aidrian handoff continue`/u, `${label}: PowerShell ${command}`);
    }
    for (const command of ['Get-ChildItem C:/repo', 'aidrian handoff check x.md']) assert.equal((await run(cwd, subagent(cwd, 'PowerShell', { command }))).status, 0, `${label}: PowerShell ${command}`);
    const { agent_id: _id, agent_type: _type, ...mainShell } = subagent(cwd, 'PowerShell', { command: 'aidrian handoff continue x.md' });
    assert.equal((await run(cwd, mainShell)).status, 0, `${label}: the main session's PowerShell may`);
    const { agent_id: _ignored, agent_type: _alsoIgnored, ...main } = subagent(cwd, 'Bash', { command: blocked[0] });
    assert.equal((await run(cwd, main)).status, 0, `${label}: the main session may`);
  }
  const { dir } = project(t, { version: 1 });
  const patch = { command: '*** Begin Patch\n*** Add File: notes.md\n+aidrian handoff continue x.md\n*** End Patch\n' };
  assert.equal((await run(dir, subagent(dir, 'apply_patch', patch))).status, 0, 'a patch that names the command runs nothing');
});

test('a subagent may not write in the handoff continuation store, with or without gates; the main session may', async (t) => {
  for (const config of [{ version: 1 }, GATED]) {
    const { dir } = project(t, config);
    const state = stateDir(findProject(dir));
    const root = path.join(process.env.XDG_STATE_HOME, 'aidrian');
    const handoffs = path.join(state, 'handoffs');
    const store = path.join(handoffs, '.continue');
    mkdirSync(store, { recursive: true });
    t.after(() => rmSync(state, { recursive: true, force: true }));
    const run = (input) => inHook({ input: JSON.stringify(input), cwd: dir, encoding: 'utf8' });
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
        // The background route's start record and kept copy, by a glob of each.
        'cd "$X" && tee started-*',
        'cd "$X" && cp /tmp/x.md continued-*',
        'cd "$X" && echo {} > .continue/started-s1.json',
        // The record of a task worktree a session made, which grants it that worktree, by its name and by a glob.
        'cd "$X" && echo {} > worktree-s1.0123456789ab.json',
        'cd "$X" && rm -f worktree-*',
        'cd "$X" && cp /tmp/x.md .continue/continued-x.md',
        // The claim of a session on a start, which a removal would lift.
        'cd "$X" && rm claim-*',
        'cd "$X" && rm .continue/claim-*',
        // A request to end a session, or a record that a terminal follows one, by the id shape the store writes, in a
        // folder no path gives, and by a glob that may grow into one.
        'cd "$STORE" && printf xxx > ending-0c5bd1a2-7f3e-4b8a-9d10-2e4f6a8b0c1d.json',
        'cd "$STORE" && printf xxx > follow-ed95a7db.json',
        'cd "$X" && cp /tmp/x.json FOLLOW-ED95A7DB.json',
        'cd "$STORE" && tee ending-*',
        'cd "$STORE" && cp /tmp/x.json follow-ed9*.json',
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
      ['PowerShell', { command: `Get-Content ${store}/armed-s1.json | Set-Content x.json` }],
      // On a disk that folds case, any spelling reaches the store.
      ...(FOLDS ? [
        ['Write', { file_path: path.join(handoffs, '.CONTINUE/armed-s1.json'), content: '{}' }],
        ['Write', { file_path: path.join(state, 'Handoffs/.continue/armed-s1.json'), content: '{}' }],
        ['Bash', { command: `echo {} > ${handoffs}/.Continue/armed-s1.json` }],
        ['Bash', { command: 'cd "$X" && echo {} > Handoffs/.Continue/notes.json' }],
      ] : []),
    ]) {
      const result = await run(subagent(dir, tool, toolInput));
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
      // So are names that only start like a request to end or a follow record: their id is no session's shape.
      ['Bash', { command: 'cd "$OUT" && echo {} > follow-up.json' }],
      ['Bash', { command: 'cd "$OUT" && echo {} > follow-ups.json' }],
      ['Bash', { command: 'cd "$OUT" && echo {} > ending-notes.json' }],
      ['Bash', { command: 'cd "$OUT" && rm -f follow-up*' }],
      ['Bash', { command: 'rm build/[a-z]*.o' }],
      ['Bash', { command: 'touch src/[z-a].js' }],
      ['Bash', { command: `rm -rf ${handoffs}/[0-9]*.md` }],
      ['Monitor', { command: `tail -f ${store}/armed-s1.json`, description: 'watch' }],
      ['PowerShell', { command: 'Get-ChildItem $env:TEMP | Select-Object -First 3' }],
      ['PowerShell', { command: `Remove-Item ${handoffs}/2026-11-15-x.md` }],
      // One pipeline of read-only cmdlets with plain words writes nothing, as `cat` does not.
      ['PowerShell', { command: `Get-Content ${store}/armed-s1.json` }],
    ]) {
      assert.equal((await run(subagent(dir, tool, toolInput))).status, 0, label(toolInput));
    }
    const { agent_id: _ignored, agent_type: _alsoIgnored, ...main } = subagent(dir, 'Write', { file_path: path.join(store, 'armed-s1.json'), content: '{}' });
    assert.equal((await run(main)).status, 0, 'the main session may');
    const { agent_id: _id, agent_type: _type, ...mainShell } = subagent(dir, 'PowerShell', { command: `Set-Content ${store}/armed-s1.json '{}'` });
    assert.equal((await run(mainShell)).status, 0, 'the main session\'s PowerShell may');
  }
});

// A folder outside the project and the state root, which may hold links to guarded files.
function outside(t) {
  const out = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-links-')));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  return out;
}

test('a subagent\'s glob that passes an existing link to an armed marker or the store, in any part it expands, is refused', async (t) => {
  const { dir } = project(t, { version: 1 });
  const state = stateDir(findProject(dir));
  const handoffs = path.join(state, 'handoffs');
  const marker = path.join(handoffs, '.continue/armed-s1.json');
  mkdirSync(path.dirname(marker), { recursive: true });
  writeFileSync(marker, '{}');
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const out = outside(t);
  symlinkSync(marker, path.join(out, 'marker-alias'));
  symlinkSync(handoffs, path.join(out, 'hlink'));
  mkdirSync(path.join(out, 'a'));
  symlinkSync(handoffs, path.join(out, 'a/hl'));
  writeFileSync(path.join(out, 'other.txt'), '');
  const run = (tool, toolInput) => inHook({ input: JSON.stringify(subagent(dir, tool, toolInput)), cwd: dir, encoding: 'utf8' });
  for (const [tool, toolInput] of [
    // The glob's last match is a link to the marker.
    ['Bash', { command: `echo '{}' | tee ${out}/marker-alias*` }],
    ['Bash', { command: `echo '{}' > ${out}/marker-a?ias` }],
    ['Monitor', { command: `echo '{}' | tee ${out}/marker-al*`, description: 'watch' }],
    ['PowerShell', { command: `Set-Content ${out}/marker-al* '{}'` }],
    // A wildcard folder part passes a link to the folder that holds the store, at the glob's first folder or below it.
    ['Bash', { command: `echo '{}' > ${out}/hl*/.continue/armed-s1.json` }],
    ['Bash', { command: `echo '{}' > ${out}/*/h?/.continue/armed-s1.json` }],
    ['PowerShell', { command: `Set-Content ${out}/*/h?/.continue/armed-s1.json '{}'` }],
  ]) {
    const result = await run(tool, toolInput);
    assert.equal(result.status, 2, `${tool}: ${toolInput.command}`);
    assert.match(result.stderr, /the handoff continuation store, where only the main session's `aidrian handoff` commands write/u, toolInput.command);
  }
  for (const [tool, toolInput] of [
    ['Bash', { command: `echo x | tee ${out}/other*` }],
    ['Bash', { command: `rm -f ${out}/a/*.log` }],
    ['Monitor', { command: `echo x | tee ${out}/oth*.txt`, description: 'watch' }],
    ['PowerShell', { command: `Remove-Item ${out}/oth*.txt` }],
  ]) {
    const result = await run(tool, toolInput);
    assert.equal(result.status, 0, `${tool}: ${toolInput.command}: ${result.stderr}`);
  }
});

test('a subagent\'s ** glob passes a link to the store any number of folders down, through looping links in time; one that reaches nothing runs', async (t) => {
  const { dir } = project(t, { version: 1 });
  const state = stateDir(findProject(dir));
  const marker = path.join(state, 'handoffs/.continue/armed-s1.json');
  mkdirSync(path.dirname(marker), { recursive: true });
  writeFileSync(marker, '{}');
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const out = outside(t);
  mkdirSync(path.join(out, 'a/b'), { recursive: true });
  symlinkSync(marker, path.join(out, 'a/b/alias'));
  // Links that loop, to the folder above and to their own folder, with a link to the marker below them.
  const loop = outside(t);
  mkdirSync(path.join(loop, 'x/y'), { recursive: true });
  symlinkSync('..', path.join(loop, 'x/up'));
  symlinkSync('.', path.join(loop, 'x/self'));
  symlinkSync(marker, path.join(loop, 'x/y/alias'));
  const clean = outside(t);
  mkdirSync(path.join(clean, 'a/b'), { recursive: true });
  symlinkSync('..', path.join(clean, 'a/up'));
  writeFileSync(path.join(clean, 'a/b/notes.log'), '');
  const run = async (tool, toolInput) => {
    const started = performance.now();
    const result = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(subagent(dir, tool, toolInput)), cwd: dir, encoding: 'utf8', timeout: 5000 });
    return { ...result, took: performance.now() - started };
  };
  for (const [tool, toolInput] of [
    ['Bash', { command: `printf x | tee ${out}/**/alias*` }],
    ['Monitor', { command: `printf x | tee ${out}/**/alias*`, description: 'watch' }],
    ['PowerShell', { command: `Set-Content ${out}/**/alias* x` }],
    ['Bash', { command: `printf x | tee ${loop}/**/alias*` }],
    ['PowerShell', { command: `Set-Content ${loop}/**/alias* x` }],
  ]) {
    const result = await run(tool, toolInput);
    assert.equal(result.status, 2, `${tool}: ${toolInput.command}`);
    assert.match(result.stderr, /the handoff continuation store/u, toolInput.command);
    assert.ok(result.took < 4000, `${toolInput.command}: took ${Math.round(result.took)} ms`);
  }
  for (const [tool, toolInput] of [
    ['Bash', { command: `rm -f ${clean}/**/**/*.log` }],
    ['Monitor', { command: `rm -f ${clean}/**/*.log`, description: 'watch' }],
    ['PowerShell', { command: `Remove-Item ${clean}/**/*.log` }],
    // A link to the marker file under `**` leads to nothing below it.
    ['Bash', { command: `rm -f ${out}/**/*.log` }],
  ]) {
    const result = await run(tool, toolInput);
    assert.equal(result.status, 0, `${tool}: ${toolInput.command}: ${result.stderr}`);
    assert.ok(result.took < 4000, `${toolInput.command}: took ${Math.round(result.took)} ms`);
  }
});

test('a subagent\'s glob that passes an existing link to a config file or the local file is refused; one that reaches neither runs', async (t) => {
  const { dir } = project(t);
  writeFileSync(path.join(dir, '.aidrian.local.json'), '{}');
  const out = outside(t);
  symlinkSync(path.join(dir, '.aidrian/config.json'), path.join(out, 'conf-alias'));
  symlinkSync(path.join(dir, '.aidrian.local.json'), path.join(out, 'local-alias'));
  mkdirSync(path.join(out, 'dist'));
  symlinkSync(path.join(dir, '.aidrian/config.json'), path.join(out, 'dist/alias'));
  symlinkSync(path.join(out, 'dist'), path.join(out, 'dlink'));
  const run = (command) => inHook({ input: JSON.stringify(subagent(dir, 'Bash', { command })), cwd: dir, encoding: 'utf8' });
  for (const command of [`printf x | tee ${out}/conf-al*`, `printf x | tee ${out}/dl*/al*`]) {
    const result = await run(command);
    assert.equal(result.status, 2, command);
    assert.match(result.stderr, /may change \.aidrian\/config\.json/u, command);
  }
  const switched = await run(`echo '${JSON.stringify({ github: { autoMerge: 'on' } })}' | tee ${out}/local-al*`);
  assert.equal(switched.status, 2);
  assert.match(switched.stderr, /it sets github\.autoMerge in \.aidrian\.local\.json/u);
  for (const command of [`printf x | tee ${out}/other*`, `printf x | tee ${out}/dist/*.txt`]) {
    const result = await run(command);
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
  }
});

test('a subagent\'s glob that passes a link in a folder it may pass but not list is refused, and so is a wildcard there; a plain miss runs', async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    t.skip('folder modes do not keep this user from listing a folder');
    return;
  }
  const { dir } = project(t);
  writeFileSync(path.join(dir, '.aidrian.local.json'), '{}');
  const state = stateDir(findProject(dir));
  const marker = path.join(state, 'handoffs/.continue/armed-s1.json');
  mkdirSync(path.dirname(marker), { recursive: true });
  writeFileSync(marker, '{}');
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const out = outside(t);
  // A folder a shell may pass by name, with search permission, but not list: `x*/shut/marker` writes through its link.
  const shut = path.join(out, 'xdir/shut');
  mkdirSync(shut, { recursive: true });
  symlinkSync(marker, path.join(shut, 'marker'));
  symlinkSync(path.join(dir, '.aidrian/config.json'), path.join(shut, 'conf'));
  symlinkSync(path.join(dir, '.aidrian.local.json'), path.join(shut, 'local'));
  // A state folder spelled through a link inside such a folder, which a glob reaches by that spelling.
  const real = path.join(out, 'real');
  mkdirSync(path.join(real, 'st'), { recursive: true });
  mkdirSync(path.join(out, 'nr'));
  symlinkSync(real, path.join(out, 'nr/link'));
  const env = { ...process.env, XDG_STATE_HOME: path.join(out, 'nr/link/st') };
  const spelled = path.join(stateDir(findProject(dir), { env }), 'handoffs/.continue');
  mkdirSync(spelled, { recursive: true });
  writeFileSync(path.join(spelled, 'armed-s1.json'), '{}');
  const run = (tool, toolInput, given = process.env) => inHook({ input: JSON.stringify(subagent(dir, tool, toolInput)), cwd: dir, encoding: 'utf8', env: given });
  chmodSync(shut, 0o311);
  chmodSync(path.join(out, 'nr'), 0o311);
  try {
    for (const [tool, toolInput, reason, given] of [
      ['Bash', { command: `echo '{}' | tee ${out}/x*/shut/marker` }, /the handoff continuation store/u],
      ['Monitor', { command: `echo '{}' | tee ${out}/x*/shut/marker`, description: 'watch' }, /the handoff continuation store/u],
      ['Bash', { command: `printf x | tee ${out}/x*/shut/conf` }, /may change \.aidrian\/config\.json/u],
      ['PowerShell', { command: `Set-Content ${out}/x*/shut/conf x` }, /may change \.aidrian\/config\.json/u],
      ['Bash', { command: `echo '${JSON.stringify({ github: { autoMerge: 'on' } })}' | tee ${out}/x*/shut/local` }, /it sets github\.autoMerge in \.aidrian\.local\.json/u],
      ['Bash', { command: `echo '{}' | tee ${spelled.replace(`${out}/nr/`, `${out}/n*/`)}/armed-s1.json` }, /the handoff continuation store/u, env],
      // A wildcard part in a folder that may not be listed may match a link the guard cannot see.
      ['Bash', { command: `printf x | tee ${out}/xdir/shut/m*` }, /./u],
    ]) {
      const result = await run(tool, toolInput, given);
      assert.equal(result.status, 2, `${tool}: ${toolInput.command}: ${result.stderr}`);
      assert.match(result.stderr, reason, toolInput.command);
    }
    for (const command of [`printf x | tee ${out}/x*/shut/notes.txt`, `printf x | tee ${out}/n*/link/notes.txt`]) {
      const result = await run('Bash', { command });
      assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    }
  } finally {
    chmodSync(shut, 0o755);
    chmodSync(path.join(out, 'nr'), 0o755);
  }
});

test('a subagent\'s PowerShell command that names a guarded config file or the machine switches is refused; a Bash(prefix) allow never admits one', async (t) => {
  const run = (cwd, input) => inHook({ input: JSON.stringify(input), cwd, encoding: 'utf8' });
  const gated = project(t).dir;
  for (const command of [String.raw`Set-Content .AIDRIAN\Config.json '{}'`, "Remove-Item -Recurse .aidrian/config.json"]) {
    const result = await run(gated, subagent(gated, 'PowerShell', { command }));
    assert.equal(result.status, 2, command);
    assert.match(result.stderr, /^aidrian: PowerShell is blocked[^\n]*may change \.aidrian\/config\.json, which sets this project's agent gates/u, command);
  }
  assert.equal((await run(gated, subagent(gated, 'PowerShell', { command: 'Get-ChildItem src' }))).status, 0);
  const open = project(t, { version: 1 }).dir;
  for (const command of ["(Get-Content .aidrian.local.json) -replace 'off','on' | Set-Content .aidrian.local.json", '$j = gc .AIDRIAN.LOCAL.JSON | ConvertFrom-Json; $j.github.automerge = "on"']) {
    const result = await run(open, subagent(open, 'PowerShell', { command }));
    assert.equal(result.status, 2, command);
    assert.match(result.stderr, /it names \.aidrian\.local\.json in a shell command the guard cannot read/u, command);
  }
  assert.equal((await run(open, subagent(open, 'PowerShell', { command: 'Get-Content README.md' }))).status, 0);
  const { agent_id: _id, agent_type: _type, ...main } = subagent(open, 'PowerShell', { command: "Set-Content .aidrian.local.json '{}'" });
  assert.equal((await run(open, main)).status, 0, 'the main session may');
  const limited = project(t, { version: 1, agents: { explorer: { allow: ['Read', 'Bash(git status)'] } } }).dir;
  const shell = await run(limited, subagent(limited, 'PowerShell', { command: 'git status' }));
  assert.equal(shell.status, 2, 'a Bash(prefix) allow never admits a PowerShell command');
  assert.match(shell.stderr, /agents\.explorer\.allow does not list it/u);
});

test('a subagent\'s PowerShell command is judged also with its backtick escapes, quote joins, and literal + joins undone', async (t) => {
  const run = (cwd, input) => inHook({ input: JSON.stringify(input), cwd, encoding: 'utf8' });
  const refused = async (cwd, command, reason) => {
    const result = await run(cwd, subagent(cwd, 'PowerShell', { command }));
    assert.equal(result.status, 2, command);
    assert.match(result.stderr, reason, command);
  };
  const open = project(t, { version: 1 }).dir;
  for (const command of ['aidrian hand`off cont`inue x.md', 'aidrian hand"off" cont"inue" x.md', "aidrian ('hand'+'off') (\"cont\" + \"inue\") x.md"]) {
    await refused(open, command, /it runs `aidrian handoff continue`/u);
  }
  for (const command of [String.raw`Set-Content $env:S\handoffs\.cont` + '`' + String.raw`inue\arm` + '`' + 'ed-s1.json \'{}\'', "Set-Content ($env:S + '\\handoffs\\.cont' + 'inue\\armed-s1.json') '{}'"]) {
    await refused(open, command, /the handoff continuation store/u);
  }
  for (const command of ["Set-Content .aidrian.lo`cal.json '{}'", "Set-Content ('.aidrian.lo'+'cal.json') '{}'"]) {
    await refused(open, command, /it names \.aidrian\.local\.json in a shell command the guard cannot read/u);
  }
  const gated = project(t).dir;
  for (const command of ["Set-Content .aidrian/conf`ig.json '{}'", "Set-Content (\".aidrian/con\" + \"fig.json\") '{}'"]) {
    await refused(gated, command, /may change \.aidrian\/config\.json, which sets this project's agent gates/u);
  }
  for (const command of ['Write-Host "a`tb"', "Write-Host ('a' + 'b')"]) assert.equal((await run(gated, subagent(gated, 'PowerShell', { command }))).status, 0, command);
});

test('a subagent\'s PowerShell command that names the store, a folder that holds it, or a glob that reaches it by path is refused', async (t) => {
  const { dir } = project(t, { version: 1 });
  const state = stateDir(findProject(dir));
  const handoffs = path.join(state, 'handoffs');
  const store = path.join(handoffs, '.continue');
  mkdirSync(store, { recursive: true });
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const run = (input) => inHook({ input: JSON.stringify(input), cwd: dir, encoding: 'utf8' });
  const windows = (file) => file.replaceAll('/', '\\');
  for (const [cwd, command] of [
    [dir, `Remove-Item -Recurse -Force ${windows(handoffs)}`],
    [dir, `Remove-Item -Recurse -Force ${state}`],
    [dir, `Remove-Item -Recurse -Force ${windows(handoffs)}\\.c*`],
    [dir, `Copy-Item C:\\tmp\\x.json ${store}`],
    [dir, `Set-Location ${handoffs}; Remove-Item -Recurse -Force .c*`],
  ]) {
    const result = await run(subagent(cwd, 'PowerShell', { command }));
    assert.equal(result.status, 2, `${cwd}: ${command}`);
    assert.match(result.stderr, /may change [^\n]*, the handoff continuation store/u, command);
  }
  for (const command of [`Remove-Item ${handoffs}/2026-*.md`, `Get-ChildItem ${handoffs}/2026-11-15-x.md`]) {
    assert.equal((await run(subagent(dir, 'PowerShell', { command }))).status, 0, command);
  }
  const gated = project(t).dir;
  for (const command of [`Remove-Item -Recurse ${windows(gated)}\\.aidrian\\c*`, 'Remove-Item .aidrian/c*', 'Remove-Item .aidrian/conf[i]g.json']) {
    const result = await inHook({ input: JSON.stringify(subagent(gated, 'PowerShell', { command })), cwd: gated, encoding: 'utf8' });
    assert.equal(result.status, 2, command);
    assert.match(result.stderr, /may change \.aidrian\/config\.json/u, command);
  }
});

test('a subagent may not set a machine switch through a glob that matches the local file', async (t) => {
  const { dir } = project(t, { version: 1 });
  const run = (tool, toolInput) => inHook({ input: JSON.stringify(subagent(dir, tool, toolInput)), cwd: dir, encoding: 'utf8' });
  const on = JSON.stringify({ github: { autoMerge: 'on' } });
  for (const command of [`echo '${on}' > .aidrian.local.js*`, `echo '${on}' > .AIDRIAN.LOCAL.JS?N`, `echo '${on}' > .aidrian.local.[j]son`]) {
    const result = await run('Bash', { command });
    assert.equal(result.status, 2, command);
    assert.match(result.stderr, /it sets github\.autoMerge in \.aidrian\.local\.json/u, command);
  }
  const shell = await run('PowerShell', { command: "Set-Content .aidrian.local.js* '{}'" });
  assert.equal(shell.status, 2);
  assert.match(shell.stderr, /it has a glob that may reach \.aidrian\.local\.json in a shell command the guard cannot read/u);
  for (const command of [`echo '${on}' > notes.js*`, 'echo autoMerge > docs/*.md']) assert.equal((await run('Bash', { command })).status, 0, command);
  // With gates, a bracket class in a config file's name is read as the glob the shell expands, as `*` is.
  const gated = project(t).dir;
  const config = await inHook({ input: JSON.stringify(subagent(gated, 'Bash', { command: 'echo {} > .aidrian/conf[i]g.json' })), cwd: gated, encoding: 'utf8' });
  assert.equal(config.status, 2);
  assert.match(config.stderr, /may change \.aidrian\/config\.json/u);
});

test('a subagent\'s plain PowerShell glob is judged by the folder it reaches, and by its name only when that names a guarded file', async (t) => {
  const run = (cwd, command) => inHook({ input: JSON.stringify(subagent(cwd, 'PowerShell', { command })), cwd, encoding: 'utf8' });
  const plain = [
    String.raw`Get-ChildItem src\*`,
    'Get-ChildItem *.json',
    String.raw`Remove-Item -Recurse -Force dist\*`,
    'Copy-Item src/* out/',
    'dir .*',
    "(Get-Content notes.txt) -replace '.*', ''",
    '$n = 3 * 4',
    "Get-ChildItem | Where-Object Name -like '*config*'",
  ];
  // With no gates, nothing guarded lies where they reach; with gates, from a folder that holds none of the config.
  const open = project(t, { version: 1 }).dir;
  const gated = project(t).dir;
  for (const [cwd, label] of [[open, 'no gates'], [path.join(gated, 'src'), 'gates, from src']]) {
    for (const command of plain) {
      const result = await run(cwd, command);
      assert.equal(result.status, 0, `${label}: ${command}: ${result.stderr}`);
    }
  }
  for (const command of ['Get-ChildItem *.json', 'Copy-Item src/* out/', "Get-ChildItem | Where-Object Name -like '*config*'"]) assert.equal((await run(gated, command)).status, 0, `gates: ${command}`);
  // From the project root, a glob that reaches the config folder or the local file still counts, as it may delete them.
  for (const command of ['Remove-Item -Recurse -Force *', 'Remove-Item -Recurse .*', 'Remove-Item -Recurse .aidria?']) {
    const result = await run(gated, command);
    assert.equal(result.status, 2, command);
    assert.match(result.stderr, /may change \.aidrian\/config\.json/u, command);
  }
  // By name, from any folder, as a shell that changed its folder first may reach it.
  for (const command of [String.raw`Set-Location ..; Remove-Item -Recurse .aidrian\*`, 'Remove-Item -Recurse ../.aid*/*', 'Remove-Item conf*', 'Remove-Item conf[i]g.json']) {
    const result = await run(path.join(gated, 'src'), command);
    assert.equal(result.status, 2, command);
    assert.match(result.stderr, /may change \.aidrian\/config\.json/u, command);
  }
  writeFileSync(path.join(open, '.aidrian.local.json'), '{}');
  for (const command of ['Remove-Item *.json', 'Set-Location ..; Set-Content .aidrian.local.js* x', 'Copy-Item x.json .AIDRIAN.LOCAL.[j]son']) {
    const result = await run(path.join(open, command.startsWith('Set-Location') ? 'src' : ''), command);
    assert.equal(result.status, 2, command);
    assert.match(result.stderr, /it has a glob that may reach \.aidrian\.local\.json in a shell command the guard cannot read/u, command);
  }
  assert.equal((await run(path.join(open, 'src'), 'Remove-Item *.json')).status, 0, 'a folder without the local file');
});

test('a subagent\'s PowerShell command reads a typographic quote as a quote, for each guard', async (t) => {
  const run = (cwd, command) => inHook({ input: JSON.stringify(subagent(cwd, 'PowerShell', { command })), cwd, encoding: 'utf8' });
  const open = project(t, { version: 1 }).dir;
  const gated = project(t).dir;
  for (const [cwd, command, reason] of [
    [open, 'aidrian hand\u2018off\u2019 cont\u201Cinue\u201D x.md', /it runs `aidrian handoff continue`/u],
    [open, 'aidrian (\u201Chand\u201D + \u201Coff\u201D) continue x.md', /it runs `aidrian handoff continue`/u],
    [open, String.raw`Remove-Item -Recurse $env:S\handoffs\.cont` + '\u2019inue\u2019', /the handoff continuation store/u],
    [open, 'Set-Content .aidrian.lo\u2018cal\u2019.json x', /it names \.aidrian\.local\.json in a shell command the guard cannot read/u],
    [open, 'Set-Content (\u2018.aidrian.lo\u2019+\u201Acal.json\u201B) x', /it names \.aidrian\.local\.json in a shell command the guard cannot read/u],
    [gated, 'Set-Content .aidrian/conf\u201Eig\u201D.json x', /may change \.aidrian\/config\.json/u],
  ]) {
    const result = await run(cwd, command);
    assert.equal(result.status, 2, command);
    assert.match(result.stderr, reason, command);
  }
});

test('a subagent\'s PowerShell word that starts with ~ is read in the home folder, as a Bash one is', async (t) => {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-home-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { dir } = project(t, { version: 1 });
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_STATE_HOME: path.join(home, '.local/state') };
  const store = path.join(stateDir(findProject(dir), { env }), 'handoffs/.continue');
  mkdirSync(store, { recursive: true });
  const run = (tool, command) => inHook({ input: JSON.stringify(subagent(dir, tool, { command })), cwd: dir, encoding: 'utf8', env });
  for (const [tool, command] of [
    ['Bash', 'rm -rf ~/.local/state/aidrian'],
    ['PowerShell', 'Remove-Item -Recurse -Force ~/.local/state/aidrian'],
    ['PowerShell', String.raw`Remove-Item -Recurse -Force ~\.local\state\aidrian`],
  ]) {
    const result = await run(tool, command);
    assert.equal(result.status, 2, `${tool}: ${command}`);
    assert.match(result.stderr, /the handoff continuation store/u, command);
  }
  assert.equal((await run('PowerShell', 'Get-ChildItem ~/Documents')).status, 0);
});

test('a subagent\'s PowerShell command with more words than the guards read is refused; the main session\'s runs', async (t) => {
  const { dir } = project(t, { version: 1 });
  const words = (count) => Array.from({ length: count }, (_, i) => `w${i}`).join(' ');
  const run = (input) => inHook({ input: JSON.stringify(input), cwd: dir, encoding: 'utf8' });
  // Write-Host counts twice, as given and in lower case.
  const refused = await run(subagent(dir, 'PowerShell', { command: `Write-Host ${words(OPAQUE_WORDS - 1)}` }));
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, new RegExp(`its command has ${OPAQUE_WORDS + 1} words, counting each case, and the guards read at most ${OPAQUE_WORDS}`, 'u'));
  assert.equal((await run(subagent(dir, 'PowerShell', { command: words(OPAQUE_WORDS) }))).status, 0, 'as many as the guards read');
  const { agent_id: _id, agent_type: _type, ...main } = subagent(dir, 'PowerShell', { command: `Write-Host ${words(OPAQUE_WORDS)}` });
  assert.equal((await run(main)).status, 0, 'the main session may');
});

test('a glob of many thousand ** parts still reaches the store, for Bash and PowerShell, and never runs the guard out of stack', async (t) => {
  const { dir } = project(t, { version: 1 });
  const run = (tool, command) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(subagent(dir, tool, { command })), cwd: dir, encoding: 'utf8', timeout: 4000 });
  const deep = `${'/**'.repeat(17000)}/x`;
  for (const [tool, command] of [['Bash', `rm -rf ${deep}`], ['PowerShell', `Remove-Item -Recurse ${deep}`]]) {
    const result = await run(tool, command);
    assert.equal(result.status, 2, `${tool}: ${result.signal ?? ''}`);
    assert.match(result.stderr, /the handoff continuation store/u, tool);
  }
});

test('globParts answers in milliseconds on a part of many wildcards, as it reads them', async () => {
  for (const [part, name, expected] of [
    [`${'*'.repeat(40)}x`, '.aidrian.local.json', false],
    [`${'*'.repeat(40)}n`, '.aidrian.local.json', true],
    [`${'*a'.repeat(30)}b`, 'a'.repeat(60), false],
    [`${'?*'.repeat(30)}`, 'a'.repeat(30), true],
    [`${'[a-z]*'.repeat(30)}!`, 'a'.repeat(200), false],
  ]) {
    const started = performance.now();
    assert.equal(globParts(part, [], 'i').pattern.test(name), expected, part);
    assert.ok(performance.now() - started < 100, `${part} took ${performance.now() - started} ms`);
  }
});

test('globParts reads *, ?, and a [...] class, negated with !, in the last path part', async () => {
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

test('the store guard follows state.dir to a folder outside the state root', async (t) => {
  const elsewhere = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-elsewhere-')));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  const { dir } = project(t, { version: 1, state: { dir: elsewhere } });
  const run = (input) => inHook({ input: JSON.stringify(input), cwd: dir, encoding: 'utf8' });
  assert.equal((await run(subagent(dir, 'Write', { file_path: path.join(elsewhere, 'handoffs/.continue/armed-s1.json'), content: '{}' }))).status, 2);
  assert.equal((await run(subagent(dir, 'Write', { file_path: path.join(elsewhere, 'handoffs/2026-11-15-x.md'), content: '#\n' }))).status, 0);
});

test('a gated subagent\'s bracket glob in a known folder gets the folder check, as a `*` glob does', async (t) => {
  const { dir } = project(t);
  mkdirSync(path.join(dir, 'build'));
  const run = (command) => inHook({ input: JSON.stringify(subagent(dir, 'Bash', { command })), cwd: dir, encoding: 'utf8' });
  for (const command of ['rm -rf build/[a-z]*', 'rm -f build/[[:alpha:]]*', 'rm -f build/[!.]x']) assert.equal((await run(command)).status, 0, command);
  const refused = await run('rm -f .aidrian/[c]onfig.json*');
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /\.aidrian\/config\.json/u);
});

test('a subagent, and a session the background route started, may not write in the session folders; an attended main session may', async (t) => {
  const { dir, state, full } = unattendedSetting(t);
  const sessions = path.join(state, 'sessions');
  const own = path.join(sessions, 'abc-1');
  mkdirSync(own, { recursive: true, mode: 0o700 });
  symlinkSync(path.join(own, 'prs.jsonl'), path.join(dir, 'into-sessions'));
  const run = (session, tool, toolInput, { agent = false } = {}) => inHook({
    input: JSON.stringify({ session_id: session, tool_name: tool, tool_input: toolInput, cwd: dir, ...(agent ? { agent_id: 'a5f0c1', agent_type: 'aidrian:explorer' } : {}) }),
    cwd: dir, encoding: 'utf8',
  });
  const blocked = [
    ['Write', { file_path: path.join(own, 'prs.jsonl'), content: '{}\n' }],
    ['Write', { file_path: path.join(own, 'links.jsonl'), content: '{}\n' }],
    ['Bash', { command: `echo '{}' >> ${own}/prs.jsonl` }],
    ['Bash', { command: `rm -rf ${sessions}` }],
    ['Bash', { command: `cp /tmp/x ${state}/sess*/x/prs.jsonl` }],
    ['Bash', { command: `echo '{}' > ${path.join(dir, 'into-sessions')}` }],
    ['Bash', { command: `chmod -R 777 ${state}` }],
    ['Bash', { command: `chmod 777 ${sessions}` }],
    ['Bash', { command: 'cd "$X" && echo {} > sessions/x/prs.jsonl' }],
    // Interpreter code, where a closing quote follows the path.
    ['Bash', { command: `python3 -c "open('${own}/prs.jsonl', 'a').write('{}')"` }],
    ['Bash', { command: `node -e "require('fs').appendFileSync('${own}/links.jsonl', '{}')"` }],
    ['Bash', { command: 'python3 -c "open(\'sessions/abc-1/usage.json\', \'w\')"' }],
    // A placeholder path beside a real one hides neither, and one that climbs out of its placeholder with `..` counts.
    ['Bash', { command: `python3 -c "open('<state>/sessions/<id>/prs.jsonl'); open('${own}/prs.jsonl', 'a')"` }],
    ['Bash', { command: 'python3 -c "open(\'<x>/../sessions/abc-1/prs.jsonl\', \'a\')"' }],
    // A `>` that is no placeholder's ends the placeholder path: the name after it still counts.
    ['Bash', { command: 'python3 -c "open(\'<id>>prs.jsonl\', \'a\')"' }],
    // A file appended in place, by its name alone, after a `cd` the guard cannot follow.
    ['Bash', { command: 'cd "$X" && echo {} >> prs.jsonl' }],
    ['Bash', { command: 'cd "$X" && echo {} >> links.jsonl' }],
    ['Bash', { command: 'cd "$X" && echo {} > prs-cache.json' }],
    ['Bash', { command: 'cd "$X" && echo {} > merged-heads-cache.json' }],
    // A native Windows path in interpreter code, its `\` doubled in a string or not.
    ...['usage.json', 'prs-cache.json', 'merged-heads-cache.json'].flatMap((file) => [
      ['Bash', { command: `python3 -c 'open("C:\\\\state\\\\sessions\\\\abc-1\\\\${file}", "w")'` }],
      ['Bash', { command: `node -e 'require("fs").writeFileSync("C:\\state\\sessions\\abc-1\\${file}", "{}")'` }],
    ]),
  ];
  const passing = [
    ['Write', { file_path: path.join(dir, 'src/sessions/store.js'), content: 'export {};\n' }],
    ['Write', { file_path: path.join(dir, 'sessions'), content: 'notes\n' }],
    ['Bash', { command: 'cd "$X" && echo {} > sessions/notes.md' }],
    ['Bash', { command: 'cd "$X" && echo {} > usage.json' }],
    ['Bash', { command: 'cd "$X" && echo {} > old-prs.jsonl.bak' }],
    // Interpreter code that writes a plan whose text names a session file by a placeholder path: prose, not a write there.
    ['Bash', { command: "python3 - <<'EOF'\np='plan.md'\nnew='''a row lands in `<state>/sessions/<session id>/prs.jsonl`'''\nopen(p,'w').write(new)\nEOF" }],
    ['Bash', { command: "node -e \"require('fs').writeFileSync('plan.md', 'see <state>/sessions/<id>/checks.jsonl')\"" }],
    // In a Markdown link's destination, and in parentheses.
    ['Bash', { command: "python3 - <<'EOF'\nopen('plan.md','w').write('''the [ledger](<state>/sessions/<id>/prs.jsonl), (or <state>/sessions/[draft]/links.jsonl)''')\nEOF" }],
    // Heredoc data written to another file is no write to the paths it quotes.
    ['Bash', { command: `cat > ${path.join(dir, 'plan.md')} <<'EOF'\nThe hook appends to ${own}/prs.jsonl.\nEOF` }],
  ];
  for (const [session, agent] of [['plain-session', true], [full, false]]) {
    for (const [tool, toolInput] of blocked) {
      const result = await run(session, tool, toolInput, { agent });
      assert.equal(result.status, 2, `${session}: ${JSON.stringify(toolInput)}`);
    }
    for (const [tool, toolInput] of passing) assert.equal((await run(session, tool, toolInput, { agent })).status, 0, `${session}: ${JSON.stringify(toolInput)}`);
  }
  const named = await run('plain-session', 'Write', { file_path: path.join(own, 'prs.jsonl'), content: '{}\n' }, { agent: true });
  assert.match(named.stderr, /the session folders, where only the hooks and the `aidrian` commands write/u);
  for (const [tool, toolInput] of blocked.filter(([, input]) => !String(input.command ?? '').startsWith('chmod -R'))) {
    assert.equal((await run('plain-session', tool, toolInput)).status, 0, `an attended session may: ${JSON.stringify(toolInput)}`);
  }
});

test('a placeholder path is prose only while no state folder has a bracket in its path: a state.dir with one stays guarded', async (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-bracketed-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bracketed = path.join(root, '<team>', 'state');
  mkdirSync(path.join(bracketed, 'sessions', 'abc-1'), { recursive: true });
  const { dir } = project(t, { version: 1, state: { dir: bracketed } });
  const command = `python3 -c "open('${bracketed}/sessions/abc-1/prs.jsonl', 'a')"`;
  const refused = await inHook({ input: JSON.stringify({ ...subagent(dir, 'Bash', { command }), session_id: 's1' }), cwd: dir, encoding: 'utf8' });
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.stderr, /the session folders/u);
  // A state.dir spelled with no bracket, through a link to that folder, is guarded the same.
  const linked = path.join(root, 'linked-state');
  symlinkSync(bracketed, linked);
  const viaLink = project(t, { version: 1, state: { dir: linked } }).dir;
  const throughLink = `python3 -c "open('${bracketed}/sessions/abc-1/prs.jsonl', 'a')"`;
  const linkRefused = await inHook({ input: JSON.stringify({ ...subagent(viaLink, 'Bash', { command: throughLink }), session_id: 's1' }), cwd: viaLink, encoding: 'utf8' });
  assert.equal(linkRefused.status, 2, linkRefused.stderr);
  // A long interpreter body, in a project whose folders have no bracket so the placeholder read runs, takes linear time.
  const plain = project(t, { version: 1 }).dir;
  const long = `python3 -c "x='${'a'.repeat(200_000)}<'; y='<id>'; open('prs.jsonl', 'a')"`;
  const started = process.cpuUsage();
  const longRefused = await inHook({ input: JSON.stringify({ ...subagent(plain, 'Bash', { command: long }), session_id: 's1' }), cwd: plain, encoding: 'utf8' });
  assert.equal(longRefused.status, 2, longRefused.stderr);
  const { user } = process.cpuUsage(started);
  assert.ok(user < 2_000_000, `${user} µs of processor time`);
  // Placeholder prose cannot be told from such a path here, so it is refused too: the guard stays closed.
  const prose = "python3 - <<'EOF'\nopen('plan.md','w').write('''rows land in `<state>/sessions/<session id>/prs.jsonl`''')\nEOF";
  const held = await inHook({ input: JSON.stringify({ ...subagent(dir, 'Bash', { command: prose }), session_id: 's1' }), cwd: dir, encoding: 'utf8' });
  assert.equal(held.status, 2, held.stderr);
});

// A session folder of `session` under the state folder of the project at `dir`, as the hooks make it.
function sessionFolderOf(dir, session) {
  const found = findProject(dir);
  const made = sessionFolder(stateDir(found), session, { checkouts: found.checkouts });
  assert.ok(made, 'the session folder is made');
  return made;
}

const subagentWrite = (cwd, session, toolInput) => inHook({
  input: JSON.stringify({ session_id: session, tool_name: 'Write', tool_input: toolInput, cwd, agent_id: 'a5f0c1', agent_type: 'aidrian:explorer' }),
  cwd, encoding: 'utf8',
});

test('a subagent that works in another project, or in no project, may not write the session folders of the project it started in', async (t) => {
  const { dir: home } = project(t, { version: 1 });
  const { dir: elsewhere } = project(t, { version: 1 });
  const loose = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-loose-')));
  t.after(() => rmSync(loose, { recursive: true, force: true }));
  const own = sessionFolderOf(home, 'moved-1');
  const homeState = stateDir(findProject(home));
  t.after(() => rmSync(homeState, { recursive: true, force: true }));
  const write = { file_path: path.join(own, 'prs.jsonl'), content: '{}\n' };
  for (const cwd of [elsewhere, loose]) {
    const result = await subagentWrite(cwd, 'moved-1', write);
    assert.equal(result.status, 2, `from ${cwd}: ${result.stderr}`);
    assert.match(result.stderr, /the session folders/u);
  }
  assert.equal((await subagentWrite(elsewhere, 'moved-1', { file_path: path.join(elsewhere, 'src/app.js'), content: 'x\n' })).status, 0, 'its own work in the other project');
});

test('a subagent in another project meets the session folders of a state.dir its gate snapshot`s project moves', async (t) => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-origin-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const moved = path.join(base, 'moved-state');
  const gates = { 'some-other-agent': { deny: ['WebFetch'] } };
  const { dir: home } = project(t, { version: 1, state: { dir: moved }, agents: gates });
  const { dir: elsewhere } = project(t, { version: 1 });
  const session = 'origin-1';
  assert.ok(saveGateSnapshot(session, home, gates));
  t.after(() => forgetGateSnapshot(session));
  const own = sessionFolderOf(home, session);
  assert.ok(own.startsWith(realpathSync(moved)));
  const result = await subagentWrite(elsewhere, session, { file_path: path.join(own, 'links.jsonl'), content: '{}\n' });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /the session folders/u);
});

test('a state.dir of ".." in a checkout named sessions leaves the checkout writable: no session folder lies there', { skip: process.platform === 'win32' }, async (t) => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-parent-state-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, 'sessions');
  mkdirSync(path.join(dir, '.aidrian'), { recursive: true });
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: '..' } }));
  assert.equal(stateDir(findProject(dir)), base);
  for (const file of ['src/app.js', 'README.md']) {
    const result = await subagentWrite(dir, 'plain-session', { file_path: path.join(dir, file), content: 'x\n' });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
});

const SESSION_START = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-session-start.mjs');
const gitIn = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });

test('an ungated session`s subagent in another project may not write the session folders the session started with, before they exist', async (t) => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-origins-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const moved = path.join(base, 'moved-state');
  const { dir: custom } = project(t, { version: 1, state: { dir: moved } });
  const { dir: plain } = project(t, { version: 1 });
  const { dir: elsewhere } = project(t, { version: 1 });
  const started = (cwd, session) => {
    const ran = spawnSync(process.execPath, [SESSION_START], { input: JSON.stringify({ session_id: session, cwd, hook_event_name: 'SessionStart' }), cwd, encoding: 'utf8' });
    assert.equal(ran.status, 0, ran.stderr);
  };
  started(custom, 'origin-custom-1');
  started(plain, 'origin-plain-1');
  const plainState = stateDir(findProject(plain));
  t.after(() => rmSync(plainState, { recursive: true, force: true }));
  const targets = [
    ['origin-custom-1', path.join(moved, 'sessions', 'origin-custom-1', 'prs.jsonl')],
    ['origin-plain-1', path.join(plainState, 'sessions', 'origin-plain-1', 'links.jsonl')],
  ];
  for (const [session, file] of targets) {
    assert.equal(existsSync(path.dirname(path.dirname(file))), false, 'no sessions folder yet');
    const result = await subagentWrite(elsewhere, session, { file_path: file, content: '{}\n' });
    assert.equal(result.status, 2, `${file}: ${result.stderr}`);
    assert.match(result.stderr, /the session folders/u);
  }
  const record = path.join(originFolder(), 'origin-custom-1.json');
  assert.ok(existsSync(record));
  const forged = await subagentWrite(elsewhere, 'origin-custom-1', { file_path: record, content: '{"states":[]}\n' });
  assert.equal(forged.status, 2, 'a subagent may not rewrite the session`s origins');
  assert.match(forged.stderr, /the session origins/u);
});

test('the sessions folder of a state.dir the session folder writer refuses, below a repository or in a sibling worktree, stays writable', { skip: process.platform === 'win32' }, async (t) => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-refused-store-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo');
  const sub = path.join(repo, 'sub');
  mkdirSync(path.join(sub, '.aidrian'), { recursive: true });
  mkdirSync(path.join(repo, 'sessions', 'notes'), { recursive: true });
  writeFileSync(path.join(sub, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: '.' } }));
  writeFileSync(path.join(repo, 'sessions/notes/a.md'), 'x\n');
  gitIn(repo, 'init', '-q', '-b', 'main');
  gitIn(repo, 'add', '.');
  gitIn(repo, 'commit', '-q', '-m', 'start');
  assert.equal(stateDir(findProject(sub)), repo, 'a relative state.dir resolves against the repository root');
  const nested = await subagentWrite(sub, 'plain-session', { file_path: path.join(repo, 'sessions/notes/a.md'), content: 'y\n' });
  assert.equal(nested.status, 0, nested.stderr);
  const sibling = path.join(base, 'sibling');
  gitIn(repo, 'worktree', 'add', '-q', '-b', 'side', sibling);
  writeFileSync(path.join(sub, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: sibling } }));
  const inSibling = await subagentWrite(sub, 'plain-session', { file_path: path.join(sibling, 'sessions/notes/a.md'), content: 'y\n' });
  assert.equal(inSibling.status, 0, inSibling.stderr);
});

test('the default sessions folders are scanned once a call, with the guards` deadline checked at each', async () => {
  const projects = path.join(stateRoot(), 'projects');
  for (let i = 0; i < 40; i += 1) mkdirSync(path.join(projects, `scan-${i}`, 'sessions'), { recursive: true });
  const input = { tool_name: 'Write', tool_input: {}, cwd: '/' };
  let reads = 0;
  const read = (folder) => (reads += 1, readdirSync(folder));
  const first = defaultSessionsFolders(input, { read });
  assert.ok(first.length >= 40);
  assert.equal(defaultSessionsFolders(input, { read }), first, 'the second pass reuses the first');
  assert.equal(reads, 1);
  let entries = 0;
  assert.throws(() => withinDeadline(0, () => defaultSessionsFolders({}, { entry: () => (entries += 1, true) })), PastDeadline);
  assert.ok(entries <= 1, `${entries} folders read past the deadline`);
});

test('a gated subagent`s Read in the project its session started in runs one git, to find the project, and no other', { skip: process.platform === 'win32' }, async (t) => {
  const { dir } = project(t, GATED);
  gitIn(dir, 'init', '-q', '-b', 'main');
  const session = 'git-count-1';
  assert.ok(saveGateSnapshot(session, dir, GATED.agents));
  t.after(() => forgetGateSnapshot(session));
  const bin = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-git-log-')));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const log = path.join(bin, 'calls.log');
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
  const calls = async (toolName, toolInput) => {
    rmSync(log, { force: true });
    const ran = await inHook({
      input: JSON.stringify({ session_id: session, tool_name: toolName, tool_input: toolInput, cwd: dir, agent_id: 'a5f0c1', agent_type: 'aidrian:explorer' }),
      cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    });
    assert.equal(ran.status, 0, ran.stderr);
    return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  };
  assert.equal((await calls('Read', { file_path: path.join(dir, 'src/app.js') })).length, 1, 'the project lookup alone');
  assert.equal((await calls('Grep', { pattern: 'x', path: dir })).length, 1);
});

test('a session that starts with a state folder its repository holds records no origin, so the folder stays writable from elsewhere', { skip: process.platform === 'win32' }, async (t) => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-refused-origin-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo');
  const sub = path.join(repo, 'sub');
  mkdirSync(path.join(sub, '.aidrian'), { recursive: true });
  mkdirSync(path.join(repo, 'sessions', 'notes'), { recursive: true });
  writeFileSync(path.join(sub, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: '.' } }));
  writeFileSync(path.join(repo, 'sessions/notes/a.md'), 'x\n');
  gitIn(repo, 'init', '-q', '-b', 'main');
  gitIn(repo, 'add', '.');
  gitIn(repo, 'commit', '-q', '-m', 'start');
  const { dir: elsewhere } = project(t, { version: 1 });
  const session = 'refused-origin-1';
  const ran = spawnSync(process.execPath, [SESSION_START], { input: JSON.stringify({ session_id: session, cwd: sub, hook_event_name: 'SessionStart' }), cwd: sub, encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(readOrigins(session), [], 'the writer would refuse the repository root as a state folder');
  const result = await subagentWrite(elsewhere, session, { file_path: path.join(repo, 'sessions/notes/a.md'), content: 'y\n' });
  assert.equal(result.status, 0, result.stderr);
});

test('the session-folder guard`s checkout read stops at what is left of the guards` budget', { skip: process.platform === 'win32' }, async (t) => {
  const { dir } = project(t, { version: 1 });
  gitIn(dir, 'init', '-q', '-b', 'main');
  const bin = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-stall-git-')));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const timed = async (pattern) => {
    writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ncase "$*" in ${pattern}) exec sleep 30;; esac\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
    const near = path.join(stateRoot(), 'projects', 'stall-probe', 'notes.txt');
    const started = Date.now();
    const ran = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ session_id: 'stall-1', tool_name: 'Write', tool_input: { file_path: near, content: 'x' }, cwd: dir, agent_id: 'a5f0c1', agent_type: 'aidrian:explorer' }),
      cwd: dir, encoding: 'utf8', timeout: 15_000, env: { ...process.env, AIDRIAN_GUARD_BUDGET_MS: '600', PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    });
    assert.notEqual(ran.status, null, 'the hook ended');
    return Date.now() - started;
  };
  const baseline = await timed('no-such-call');
  const over = await timed('*"worktree list"*') - baseline;
  // git's own 2 s limit would show as well over a second; the guards' 0.6 s budget as less.
  assert.ok(over < 1200, `the stalled checkout read cost ${over} ms over the ${baseline} ms baseline`);
});

// A glob is read both folded as text and with its folder where the system lands (glob-links.mjs globStarts): a `..`
// after a link climbs from the link's target, which the folded text does not show.
test('a subagent\'s glob whose folder climbs out of a link to a config file is refused, and one that stays clear runs', async (t) => {
  const { dir } = project(t);
  mkdirSync(path.join(dir, 'a'));
  mkdirSync(path.join(dir, 'sub'));
  symlinkSync(path.join(dir, 'a'), path.join(dir, 'sub', 'lnk'));
  const run = (command) => inHook({ input: JSON.stringify(subagent(dir, 'Bash', { command })), cwd: dir, encoding: 'utf8' });
  // An innocently named link in the folder the system lands in, which only that folder's walk finds.
  symlinkSync(path.join(dir, '.aidrian', 'config.json'), path.join(dir, 'notes-alias'));
  const climbed = await run('printf x | tee sub/lnk/../notes-al*');
  assert.equal(climbed.status, 2, climbed.stderr);
  assert.match(climbed.stderr, /config\.json/u);
  assert.equal((await run('printf x | tee sub/lnk/../other*')).status, 0, 'a glob that reaches no guarded file');
});
