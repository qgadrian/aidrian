// The auto-merge gate's self-protection: every plugin file that the gate, the command that runs it, the review that
// writes its record, or a hook loads at run time is on GUARDED_PATHS, so auto-merge never lands a change to the
// machinery that decides it. The test walks the files from those entry points instead of keeping a list, so a new import
// or a new hook can never fall outside the guard. The walk fails closed: a load it cannot follow fails the test unless
// EXCEPTIONS names it, with the reason it is safe.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { pathsProblem } from '../plugins/aidrian/lib/pr-auto-merge.mjs';
import { MEMBER_ASSOCIATIONS, summaryComment, SUMMARY_MARKER } from '../plugins/aidrian/lib/review/state.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const PLUGIN = 'plugins/aidrian';
const HOOKS = `${PLUGIN}/hooks/hooks.json`;

// The script each hook runs. A command of any other shape fails, so a new kind of hook cannot hide from the walk.
function hookScripts(hooks = JSON.parse(readFileSync(path.join(ROOT, HOOKS), 'utf8'))) {
  const commands = [];
  const visit = (value) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') for (const [key, inner] of Object.entries(value)) (key === 'command' ? commands.push(inner) : visit(inner));
  };
  visit(hooks);
  return commands.map((command) => {
    const match = /^node "\$CLAUDE_PLUGIN_ROOT\/(scripts\/[\w-]+\.mjs)"(?: --[\w-]+)*$/u.exec(command);
    assert.ok(match, `hooks.json runs ${command}, which the walk does not know how to follow`);
    return `${PLUGIN}/${match[1]}`;
  });
}

// The module each command in bin/ runs, so a new command joins the walk on its own. A script of any other shape fails.
function binEntries(scripts = Object.fromEntries(readdirSync(path.join(ROOT, PLUGIN, 'bin')).map((name) => [name, readFileSync(path.join(ROOT, PLUGIN, 'bin', name), 'utf8')]))) {
  return Object.entries(scripts).map(([name, text]) => {
    const match = /^exec node "\$\(dirname -- "\$self"\)\/\.\.\/(lib\/[\w/-]+\.mjs)" "\$@"$/mu.exec(text);
    assert.ok(match, `bin/${name} runs something the walk does not know how to follow`);
    return `${PLUGIN}/${match[1]}`;
  });
}

const ENTRIES = [...binEntries(), `${PLUGIN}/lib/pr.mjs`, `${PLUGIN}/lib/pr-auto-merge.mjs`, `${PLUGIN}/lib/review/run.mjs`, HOOKS, ...hookScripts()];

// What a module loads by a literal relative path: static imports and re-exports, side-effect and literal dynamic
// imports, and the files it reads or spawns next to itself, such as a JSON table, the manifest, or a worker script.
const IMPORTS = [/\bfrom\s*(['"])(\.\.?\/[^'"]+)\1/gu, /\bimport\s*\(?\s*(['"])(\.\.?\/[^'"]+)\1/gu];
const READS = [/import\.meta\.dirname\s*,\s*(['"])([^'"]+)\1\s*\)/gu, /new URL\(\s*(['"])([^'"]+)\1\s*,\s*import\.meta\.url/gu];
// What can load code or a file the patterns above may not follow. Each match outside a followed load needs an exception.
const LOADERS = /\bimport\s*\(|import\.meta\.(?:dirname|filename|url|resolve)|createRequire|process\.argv\[1\]|\b(?:spawn|spawnSync|execFile|execFileSync|fork)\(\s*process\.execPath/gu;

// The loads the walk cannot follow, reviewed one by one. Each entry excuses exactly one LOADERS match, `loader`, on a
// line that `line` matches, so a second load on an excused line fails. An entry nothing uses fails, so the list never
// keeps a stale reason.
const EXCEPTIONS = [
  { file: 'lib/cli.mjs', loader: 'import(', line: /^const \{ commands \} = await import\(COMMANDS\[command\]\);$/u, reason: 'command dispatch: the gate runs as `aidrian pr`, and lib/pr.mjs is an entry of the walk' },
  { file: 'lib/cli.mjs', loader: 'import(', line: /^const \{ usage: args, about \} = \(await import\(file\)\)\.commands\[name\];$/u, reason: 'help text: reads each command module only for its usage line' },
  { file: 'lib/config.mjs', loader: 'import.meta.dirname', line: /^const root = path\.resolve\(import\.meta\.dirname, '\.\.'\);$/u, reason: 'the plugin folder, named in a version message' },
  { file: 'lib/config.mjs', loader: 'import.meta.dirname', line: /^agentNames \?\?= readdirSync\(path\.join\(import\.meta\.dirname, '\.\.\/agents'\)\)$/u, reason: 'lists the generated agents folder, which GUARDED_PATHS covers whole' },
  { file: 'lib/transcript.mjs', loader: 'import.meta.dirname', line: /^pluginSkills \?\?= new Set\(readdirSync\(path\.join\(import\.meta\.dirname, '\.\.', 'skills'\)\)\);$/u, reason: 'lists the skill folder names; skills/ is guarded whole' },
  { file: 'scripts/hook-session-start.mjs', loader: 'import.meta.dirname', line: /^const BIN = path\.resolve\(import\.meta\.dirname, '\.\.\/bin'\);$/u, reason: 'the bin folder it puts on PATH, which GUARDED_PATHS covers whole' },
  { file: 'scripts/hook-session-end.mjs', loader: 'spawn(process.execPath', line: /^const worker = spawn\(process\.execPath, \[WORKER\], /u, reason: 'spawns WORKER, which the walk follows from its path.join(import.meta.dirname, ...)' },
  { file: 'lib/review/visual.mjs', loader: 'spawn(process.execPath', line: /^const run = spawn\(process\.execPath, \[ADAPTERS\[visual\.platform\]\], \{$/u, reason: 'spawns an ADAPTERS script, which the walk follows from its new URL(..., import.meta.url)' },
  { file: 'lib/review/visual-web.mjs', loader: 'createRequire', line: /^import \{ createRequire \} from 'node:module';$/u, reason: 'imports createRequire, used on the next exception' },
  { file: 'lib/review/visual-web.mjs', loader: 'createRequire', line: /^const require = createRequire\(path\.join\(cwd, 'package\.json'\)\);$/u, reason: "loads the browser driver from the reviewed project's own node_modules, not from the plugin" },
  // The main-script check names three loaders on one line, and loads nothing: one entry for each.
  ...['process.argv[1]', 'process.argv[1]', 'import.meta.url'].map((loader) => ({
    file: 'lib/review/visual-web.mjs',
    loader,
    line: /^const isMain = process\.argv\[1\] && path\.resolve\(process\.argv\[1\]\) === fileURLToPath\(import\.meta\.url\);$/u,
    reason: 'checks whether it runs as the main script; loads nothing',
  })),
];

const lineAt = (text, index) => text.slice(text.lastIndexOf('\n', index) + 1, text.indexOf('\n', index) === -1 ? undefined : text.indexOf('\n', index));
const isFileAt = (file) => existsSync(path.join(ROOT, file)) && statSync(path.join(ROOT, file)).isFile();

// Every file reached from `entries`, as paths from the repository root, and the exceptions the walk used.
// `read` gives a module's source; a test passes its own to check the walk on code that does not exist.
function closure(entries, read = (file) => readFileSync(path.join(ROOT, file), 'utf8')) {
  const seen = new Set();
  const used = new Set();
  const queue = [...entries];
  const excuse = (file, line, loader) => {
    const local = file.slice(PLUGIN.length + 1);
    const found = EXCEPTIONS.find((each) => !used.has(each) && each.file === local && each.loader === loader && each.line.test(line.trim()));
    assert.ok(found, `${file} loads something the walk cannot follow: ${loader} in \`${line.trim()}\`. Follow it, or add a reviewed exception`);
    used.add(found);
  };
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!file.endsWith('.mjs')) continue;
    const text = read(file);
    const followed = [];
    for (const pattern of [...IMPORTS, ...READS]) {
      for (const match of text.matchAll(pattern)) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[2]));
        if (isFileAt(target)) {
          followed.push([match.index, match.index + match[0].length]);
          queue.push(target);
        } else if (IMPORTS.includes(pattern)) {
          assert.fail(`${file} imports ${match[2]}, which does not exist`);
        }
        // A literal read of a folder is left unfollowed, so its import.meta needs an exception below.
      }
    }
    for (const match of text.matchAll(LOADERS)) {
      if (!followed.some(([start, end]) => match.index >= start && match.index < end)) excuse(file, lineAt(text, match.index), match[0]);
    }
  }
  return { files: [...seen].sort(), used };
}

const guarded = (file) => /decides CI's verdict or auto-merge/u.test(pathsProblem({ files: [{ path: file, changeType: 'MODIFIED' }], changedFiles: 1 }) ?? '');

test('every plugin file the gate, its command, its review, and the hooks load keeps auto-merge off', () => {
  const { files, used } = closure(ENTRIES);
  // The walk reaches deep, so a broken walk cannot pass by reaching nothing.
  for (const file of ['lib/cli.mjs', 'lib/knowledge-cli.mjs', 'lib/review/state.mjs', 'lib/hosts/index.mjs', 'lib/finding-disposition.json', 'lib/usage.mjs', 'lib/hook-io.mjs', 'lib/transcript.mjs', 'scripts/hook-bash.mjs', 'scripts/session-row.mjs']) {
    assert.ok(files.includes(`${PLUGIN}/${file}`), `the walk reaches ${file}`);
  }
  const open = files.filter((file) => file.startsWith(`${PLUGIN}/`) && !guarded(file));
  assert.deepEqual(open, [], 'files the gate loads that a pull request could change under auto-merge: add each to GUARDED_LIB or GUARDED_PLUGIN in plugins/aidrian/lib/project.mjs');
  assert.deepEqual(EXCEPTIONS.filter((each) => !used.has(each)).map(({ file, line }) => `${file} ${line}`), [], 'exceptions nothing needs any more');
});

test('the walk fails closed on a load it cannot follow, and on a hook it cannot read', () => {
  const module = (source) => () => closure([`${PLUGIN}/lib/new-module.mjs`], (file) => (file.endsWith('new-module.mjs') ? source : readFileSync(path.join(ROOT, file), 'utf8')));
  for (const source of [
    'const mod = await import(`./${name}.mjs`);',
    "const table = readFileSync(path.join(import.meta.dirname, 'tables', name));",
    "const require = createRequire(import.meta.url);",
    "spawn(process.execPath, [script]);",
    "const target = import.meta.resolve('./other.mjs');",
    "if (process.argv[1] === self) await run();",
    "import { x } from './missing-module.mjs';",
  ]) {
    assert.throws(module(source), /cannot follow|does not exist/u, source);
  }
  // An excused line passes alone, and fails with a second load on it.
  const cli = (source) => () => closure([`${PLUGIN}/lib/cli.mjs`], () => source);
  assert.doesNotThrow(cli('const { commands } = await import(COMMANDS[command]);'));
  assert.throws(cli('const { commands } = await import(COMMANDS[command]); await import(other);'), /cannot follow/u);
  assert.throws(() => binEntries({ 'aidrian-new': '#!/bin/sh\nexec "$(dirname -- "$0")/../lib/new.mjs"\n' }), /does not know how to follow/u);
  assert.doesNotThrow(module("import { isObject } from './fs.mjs';\nconst t = path.join(import.meta.dirname, 'decisions.json');"));
  assert.throws(() => hookScripts({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'sh "$CLAUDE_PLUGIN_ROOT/scripts/stop.sh"' }] }] } }), /does not know how to follow/u);
});

test('the guard still lets through what the gate never loads', () => {
  for (const file of [`${PLUGIN}/lib/report-health.mjs`, `${PLUGIN}/lib/lint.mjs`, `${PLUGIN}/lib/quorum.mjs`, 'docs/adopting.md', 'src/lib/hosts/a.js', 'docs/config.md']) {
    assert.equal(guarded(file), false, file);
  }
});

test('the reviewers, the hooks, and the manifests are guarded', () => {
  for (const file of [`${PLUGIN}/agents/security-engineer.md`, `${PLUGIN}/codex/agents/aidrian-security-engineer.toml`, `${PLUGIN}/agents-src/review/security-engineer.md`, `${PLUGIN}/providers/claude.json`, `${PLUGIN}/agent-addons/explorer.codex.md`, `${PLUGIN}/scripts/session-row.mjs`, '.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json', `${PLUGIN}/plugin.json`, `${PLUGIN}/.claude-plugin/plugin.json`, `${PLUGIN}/codex/install-agents.mjs`, `${PLUGIN}/skills/pr-merge-when-green/references/project-setup.md`, `${PLUGIN}/skills/pr-merge-when-green/references/after-merge.md`, `${PLUGIN}/skills/knowledge/references/handoff.md`]) {
    assert.ok(guarded(file), file);
  }
});

test('no module can add a trusted author association', () => {
  for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) assert.equal(MEMBER_ASSOCIATIONS.has(association), true, association);
  for (const association of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE', undefined]) assert.equal(MEMBER_ASSOCIATIONS.has(association), false, String(association));
  assert.ok(Object.isFrozen(MEMBER_ASSOCIATIONS));
  assert.throws(() => MEMBER_ASSOCIATIONS.add('CONTRIBUTOR'));
  assert.throws(() => Set.prototype.add.call(MEMBER_ASSOCIATIONS, 'CONTRIBUTOR'));
  assert.throws(() => { MEMBER_ASSOCIATIONS.has = () => true; });
  assert.equal(MEMBER_ASSOCIATIONS.has('CONTRIBUTOR'), false, 'still untrusted after every attempt');
  const includes = Array.prototype.includes;
  try {
    Array.prototype.includes = () => true;
    assert.equal(MEMBER_ASSOCIATIONS.has('NONE'), false, 'a patched Array.prototype.includes trusts no one new');
  } finally {
    Array.prototype.includes = includes;
  }
  const stranger = { body: `${SUMMARY_MARKER}\nall clear`, author_association: 'CONTRIBUTOR' };
  assert.equal(summaryComment([stranger]), null, "a stranger's summary is not the record");
});
