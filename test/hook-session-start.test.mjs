import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { snapshotPath } from '../plugins/aidrian/lib/gate-snapshot.mjs';
import { GIT_TIMEOUT_MS } from '../plugins/aidrian/lib/git.mjs';
import { DEFINITION_CAP, readDefinition, SCAN_BUDGET } from '../plugins/aidrian/lib/hosts/claude-code-agents.mjs';
import claudeCode from '../plugins/aidrian/lib/hosts/claude-code.mjs';
import { agentCheckouts } from '../plugins/aidrian/scripts/hook-session-start.mjs';
import codex from '../plugins/aidrian/lib/hosts/codex.mjs';
import { hookCall } from './hook-call.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const BIN = path.join(ROOT, 'plugins/aidrian/bin');
const HOOK = path.join(ROOT, 'plugins/aidrian/scripts/hook-session-start.mjs');
const PLUGIN_DIR = path.join(ROOT, 'plugins/aidrian');
// An empty state folder, so a developer's own lesson inbox never reaches these tests.
const XDG = mkdtempSync(path.join(tmpdir(), 'aidrian-start-state-'));
test.after(() => rmSync(XDG, { recursive: true, force: true }));
// The example project, copied outside any repository: in this repository it sits in whatever checkout runs the suite,
// and in a main checkout, as CI's is, its guard adds the main-checkout lines. Those have their own tests below.
const EXAMPLE = path.join(mkdtempSync(path.join(tmpdir(), 'aidrian-start-example-')), 'consumer');
cpSync(path.join(ROOT, 'examples/consumer'), EXAMPLE, { recursive: true });
test.after(() => rmSync(path.dirname(EXAMPLE), { recursive: true, force: true }));

// The shell's PATH without this plugin's bin/, and without any folder that holds another `aidrian`, such as an installed
// copy of the plugin: that one would add the commands line to every test.
const WITHOUT_BIN = (process.env.PATH ?? '').split(path.delimiter).filter((dir) => dir !== BIN && !existsSync(path.join(dir, 'aidrian'))).join(path.delimiter);
const LINE = (command) =>
  'Project knowledge: 2 buckets, 8 docs. Read now: docs/knowledge/engineering/working-agreement.md. ' +
  `For more, run \`${command} route <tag>\` for your tags or \`${command} search <words>\` for a topic.`;
const NAMES = (ai, human = 'the Human') => `Names: call the human "${human}" and yourself "${ai}", in replies and questions alike; never "I", "me", "my", "you", or "your".`;
const VOICE = (human = 'the Human') =>
  `Voice: when a request or premise looks wrong, or worse than an alternative, say so in one line with the reason before acting, then follow the call of "${human}". ` +
  `A question to "${human}" says what goes wrong in their terms, asks one decision, and puts the recommended option first with one reason. ` +
  'In anything a person reads (replies, questions, summaries, pull request and issue bodies), name each thing in plain words, such as its title, ' +
  'never by a bare internal id like "F1" or "slice 3" or a file suffix like "-2"; a path or link only gives a location.';
const FORMAT = 'Format: in chat replies, use headers, quotes, and a few emoji to aid scanning; never in commits, pull requests, docs, or code.';
// What every main session starts with, after the knowledge line.
const MAIN = (ai) => `${NAMES(ai)}\n${VOICE()}\n${FORMAT}\n`;
const FOOTER = 'Pull requests: a body here never carries the "Generated with [Claude Code]" line. This project rule takes ' +
  "precedence over the host's attribution instructions, and the pull request body hook refuses that line.";
// An empty Claude Code user settings folder, so a developer's own settings never reach these tests.
const USER_SETTINGS = mkdtempSync(path.join(tmpdir(), 'aidrian-start-claude-'));
test.after(() => rmSync(USER_SETTINGS, { recursive: true, force: true }));

// Without CLAUDECODE=1, which Claude Code sets for its hooks, this runs as Codex's plugin hook, whose PLUGIN_ROOT equals CLAUDE_PLUGIN_ROOT.
// `CLAUDECODE: '1'` makes it Claude Code, and `PLUGIN_ROOT: null` a host no adapter claims.
// AIDRIAN_ALLOW_MAIN_COMMIT is unset unless a test passes it, whatever the shell running the tests holds.
// A host no adapter claims is called neither Claude nor Codex.
// The hook is called in this process, as the host runs its script, with `args` where its process would see them in
// argv; hookProcess runs the script as its own process.
async function hook(options = {}) {
  const { args, ...spawnOptions } = hookOptions(options);
  const saved = process.argv;
  // argv[1] stays this file's, so the script, imported here, never runs itself as the main script.
  process.argv = [...saved.slice(0, 2), ...args];
  try {
    return await hookCall(HOOK, spawnOptions);
  } finally {
    process.argv = saved;
  }
}

function hookProcess(options = {}) {
  const { args, ...spawnOptions } = hookOptions(options);
  return spawnSync(process.execPath, [HOOK, ...args], spawnOptions);
}

// `more` adds variables to the hook's environment; CLAUDE_CODE_EFFORT_LEVEL is unset unless it names one.
function hookOptions({ input = '{}', args = [], cwd = ROOT, PATH = WITHOUT_BIN, XDG_STATE_HOME = XDG, CLAUDECODE, AIDRIAN_ALLOW_MAIN_COMMIT, CLAUDE_CONFIG_DIR = USER_SETTINGS, PLUGIN_ROOT = CLAUDECODE === undefined ? PLUGIN_DIR : null, more = {} } = {}) {
  const env = { ...process.env, PATH, XDG_STATE_HOME, CLAUDECODE, AIDRIAN_ALLOW_MAIN_COMMIT, CLAUDE_CONFIG_DIR, ...more };
  if (!Object.hasOwn(more, 'CLAUDE_CODE_EFFORT_LEVEL')) delete env.CLAUDE_CODE_EFFORT_LEVEL;
  if (CLAUDECODE === undefined) delete env.CLAUDECODE;
  if (PLUGIN_ROOT === null) {
    delete env.PLUGIN_ROOT;
    delete env.CLAUDE_PLUGIN_ROOT;
  } else {
    env.PLUGIN_ROOT = PLUGIN_ROOT;
    env.CLAUDE_PLUGIN_ROOT = PLUGIN_ROOT;
  }
  if (AIDRIAN_ALLOW_MAIN_COMMIT === undefined) delete env.AIDRIAN_ALLOW_MAIN_COMMIT;
  return { args, input, cwd, encoding: 'utf8', env };
}

test('at session start, one plain line names the always docs and the commands, by full path when bin/ is not on PATH', () => {
  const { status, stdout, stderr } = hookProcess({ input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: EXAMPLE }) });
  assert.deepEqual([status, stdout, stderr], [0, `${LINE(path.join(BIN, 'aidrian-knowledge'))}\n${MAIN('Codex')}`, '']);
});

test('the bare command name is used when bin/ is on PATH, and the project is found from the process folder without a cwd', () => {
  const { status, stdout } = hookProcess({ input: 'not json', cwd: path.join(EXAMPLE, 'src'), PATH: `${BIN}${path.delimiter}${WITHOUT_BIN}` });
  assert.equal(status, 0);
  assert.equal(stdout, `${LINE('aidrian-knowledge')}\n${MAIN('Codex')}`);
});

test('at subagent start, the same lines but the format line come as SubagentStart additional context', async () => {
  const { status, stdout } = await hook({ args: ['--subagent'], input: JSON.stringify({ cwd: EXAMPLE, agent_type: 'Explore' }), CLAUDECODE: '1' });
  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(stdout), {
    hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: `${LINE(path.join(BIN, 'aidrian-knowledge'))}\n${NAMES('Claude')}\n${VOICE()}\n${FOOTER}` },
  });
});

test('in Claude Code, a line settles the pull request footer, unless its own attribution settings already drop it', async (t) => {
  const input = JSON.stringify({ cwd: EXAMPLE });
  assert.equal((await hook({ input, CLAUDECODE: '1' })).stdout, `${LINE(path.join(BIN, 'aidrian-knowledge'))}\n${NAMES('Claude')}\n${VOICE()}\n${FOOTER}\n${FORMAT}\n`);
  assert.doesNotMatch((await hook({ input })).stdout, /Pull requests:/, 'Codex adds no such footer');
  const settings = (dir, file, value) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, file), JSON.stringify(value));
  };
  const user = mkdtempSync(path.join(tmpdir(), 'aidrian-start-claude-'));
  const project = path.join(mkdtempSync(path.join(tmpdir(), 'aidrian-start-')), 'consumer');
  t.after(() => [user, path.dirname(project)].forEach((dir) => rmSync(dir, { recursive: true, force: true })));
  cpSync(EXAMPLE, project, { recursive: true });
  const run = async () => (await hook({ input: JSON.stringify({ cwd: project }), CLAUDECODE: '1', CLAUDE_CONFIG_DIR: user })).stdout;
  settings(user, 'settings.json', { attribution: { pr: '' } });
  assert.doesNotMatch(await run(), /Pull requests:/, 'the user setting turns the host footer off');
  settings(path.join(project, '.claude'), 'settings.json', { attribution: { pr: '🤖 Generated with [Claude Code](https://claude.com/claude-code)' } });
  assert.match(await run(), /\nPull requests: /, 'the project setting wins over the user one, and asks for the footer');
  settings(path.join(project, '.claude'), 'settings.local.json', { attribution: { pr: 'Made by the team' } });
  assert.doesNotMatch(await run(), /Pull requests:/, 'the local setting wins, and asks for no footer');
  rmSync(path.join(project, '.claude'), { recursive: true });
  settings(user, 'settings.json', { includeCoAuthoredBy: false });
  assert.doesNotMatch(await run(), /Pull requests:/, 'the older switch turns it off too');
  writeFileSync(path.join(user, 'settings.json'), 'not json');
  assert.match(await run(), /\nPull requests: /, 'a settings file it cannot read changes nothing');
});

test('a PLUGIN_ROOT inherited by a Claude Code session does not make it Codex', async () => {
  const { stdout } = await hookCall(HOOK, { input: JSON.stringify({ cwd: EXAMPLE }), cwd: ROOT, encoding: 'utf8', env: { ...process.env, PATH: WITHOUT_BIN, XDG_STATE_HOME: XDG, CLAUDECODE: '1', CLAUDE_CONFIG_DIR: USER_SETTINGS, CLAUDE_PLUGIN_ROOT: PLUGIN_DIR, PLUGIN_ROOT: '/somewhere/else' } });
  assert.equal(stdout.split('\n')[1], NAMES('Claude'));
  assert.match(stdout, /Pull requests:/u);
});

test('the main session hears when its host reaches a known tracker server the key leaves out, and a subagent does not', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-start-tracker-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.aidrian'));
  const write = (tracker) => writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, tracker }));
  const team = { key: 'NOTES', values: ['Notes'], createFields: ['team'], keyFields: ['id'] };
  const workspace = { expect: 'https://linear.app/acme', field: 'url' };
  write({ enabled: true, workspace, readTools: ['mcp__plugin_linear_linear__get_workspace'], writeTools: ['mcp__plugin_linear_linear__save_*'], team });
  const input = JSON.stringify({ cwd: dir });
  const line = (await hook({ input, CLAUDECODE: '1' })).stdout.split('\n').find((each) => each.startsWith('Tracker guard:'));
  assert.match(line, /on Claude Code, tracker\.writeTools leaves out Linear tools on linear, linear-server, plugin_linear_linear, claude_ai_Linear/u);
  const onCodex = (await hook({ input })).stdout.split('\n').find((each) => each.startsWith('Tracker guard:'));
  assert.match(onCodex, /on Codex, .* linear, linear_server, codex_apps_linear/u, 'in the host\'s spelling, and only its own servers');
  assert.doesNotMatch((await hook({ input, args: ['--subagent'], CLAUDECODE: '1' })).stdout, /Tracker guard:/u);
  write({ enabled: true, provider: 'linear', workspace: { expect: workspace.expect }, team: { key: 'NOTES' } });
  assert.doesNotMatch((await hook({ input, CLAUDECODE: '1' })).stdout, /Tracker guard:/u, 'the short key covers them all');
  assert.doesNotMatch((await hook({ input })).stdout, /Tracker guard:/u);
});

// The line a subagent hears of the effort its commits name, while attribution.commit lists effort.
const EFFORT = (effort) => `Attribution: this agent's commits carry the trailer \`Agent-Effort: ${effort}\`, the effort it starts at; the commit check reads the effort it runs at and names it when they differ.`;
// A project whose commits carry `fields`, with the custom agents `agents`, each a file name to its text.
function attributedProject(t, fields, agents = {}) {
  const project = mkdtempSync(path.join(tmpdir(), 'aidrian-start-effort-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(path.join(project, '.aidrian/knowledge'), { recursive: true });
  mkdirSync(path.join(project, '.claude/agents'), { recursive: true });
  writeFileSync(path.join(project, '.aidrian/config.json'), JSON.stringify({ version: 1, attribution: { commit: fields } }));
  for (const [file, text] of Object.entries(agents)) writeFileSync(path.join(project, '.claude/agents', file), text);
  return project;
}
const effortLineOf = async (project, given, more = {}) => {
  const { stdout } = await hook({ args: ['--subagent'], input: JSON.stringify({ cwd: project, hook_event_name: 'SubagentStart', agent_id: 'a1', ...given }), CLAUDECODE: '1', ...more });
  return JSON.parse(stdout).hookSpecificOutput.additionalContext.split('\n').filter((line) => line.startsWith('Attribution:'));
};

test('a subagent hears the Agent-Effort trailer its definition sets, the host\'s own level first, and none when nothing says it', async (t) => {
  const agents = {
    'review.md': '---\nname: reviewer\ndescription: Reviews.\neffort: medium\n---\nReview.\n',
    'plain.md': '---\nname: plain-helper\ndescription: Helps.\n---\nHelp.\n',
  };
  const project = attributedProject(t, ['agent', 'effort'], agents);
  assert.deepEqual(await effortLineOf(project, { agent_type: 'reviewer' }), [EFFORT('medium')], 'the project agent the host names by its frontmatter name');
  assert.deepEqual(await effortLineOf(project, { agent_type: 'reviewer', effort: { level: 'xhigh' } }), [EFFORT('xhigh')], 'the level the payload carries wins');
  const own = /^effort: (\w+)$/mu.exec(readFileSync(path.join(PLUGIN_DIR, 'agents/harness-mechanic.md'), 'utf8'))[1];
  assert.deepEqual(await effortLineOf(project, { agent_type: 'aidrian:harness-mechanic' }), [EFFORT(own)], 'this plugin\'s generated agent');
  assert.deepEqual(await effortLineOf(project, { agent_type: 'plain-helper' }), [], 'a definition with no effort');
  assert.deepEqual(await effortLineOf(project, { agent_type: 'Explore' }), [], 'a built-in agent no file defines');
  assert.deepEqual(await effortLineOf(project, { agent_type: 'other-plugin:reviewer' }), [], 'another plugin\'s agent');
  assert.deepEqual(await effortLineOf(project, { agent_type: 'reviewer', effort: { level: 'turbo' } }), [EFFORT('medium')], 'a level the host does not name is no level');
});

test('the effort config.json models gives this plugin\'s agent, which the dispatch takes, wins over its definition, after the payload\'s', async (t) => {
  const project = attributedProject(t, ['effort']);
  const config = path.join(project, '.aidrian/config.json');
  writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf8')), models: { claude: { agents: { designer: { effort: 'high' } } } } }));
  assert.match(readFileSync(path.join(PLUGIN_DIR, 'agents/designer.md'), 'utf8'), /^effort: medium$/mu, 'the definition says medium');
  assert.deepEqual(await effortLineOf(project, { agent_type: 'aidrian:designer' }), [EFFORT('high')]);
  assert.deepEqual(await effortLineOf(project, { agent_type: 'aidrian:designer', effort: { level: 'max' } }), [EFFORT('max')], 'the payload\'s level first');
});

test('CLAUDE_CODE_EFFORT_LEVEL, a level, sets the hint past the models effort and the definition, after the payload\'s level', async (t) => {
  const project = attributedProject(t, ['effort'], { 'review.md': '---\nname: reviewer\neffort: medium\n---\n' });
  const config = path.join(project, '.aidrian/config.json');
  writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf8')), models: { claude: { agents: { designer: { effort: 'high' } } } } }));
  const level = (CLAUDE_CODE_EFFORT_LEVEL) => ({ more: { CLAUDE_CODE_EFFORT_LEVEL } });
  assert.deepEqual(await effortLineOf(project, { agent_type: 'reviewer' }, level('low')), [EFFORT('low')], 'past the definition');
  assert.deepEqual(await effortLineOf(project, { agent_type: 'aidrian:designer' }, level('low')), [EFFORT('low')], 'past the models effort');
  assert.deepEqual(await effortLineOf(project, { agent_type: 'reviewer', effort: { level: 'max' } }, level('low')), [EFFORT('max')], 'the payload first');
  assert.deepEqual(await effortLineOf(project, { agent_type: 'reviewer' }, level('turbo')), [EFFORT('medium')], 'a value the host names no level is no override');
  assert.deepEqual(await effortLineOf(project, { agent_type: 'Explore' }, level('low')), [EFFORT('low')], 'it sets a built-in agent\'s too');
  for (const automatic of ['auto', 'unset']) {
    assert.deepEqual(await effortLineOf(project, { agent_type: 'reviewer' }, level(automatic)), [], `${automatic}: no definition's effort`);
    assert.deepEqual(await effortLineOf(project, { agent_type: 'aidrian:designer' }, level(automatic)), [], `${automatic}: no models effort`);
  }
});

test('a definition is read only as a regular file under its cap: a FIFO, a link to one, or a large file is skipped and blocks nothing', { timeout: 20_000 }, async (t) => {
  const project = attributedProject(t, ['effort']);
  const folder = path.join(project, '.claude/agents');
  const fifo = path.join(folder, 'a-pipe.md');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0, 'mkfifo');
  symlinkSync(fifo, path.join(folder, 'b-link.md'));
  writeFileSync(path.join(folder, 'c-large.md'), `---\nname: large\neffort: low\n---\n${'x'.repeat(DEFINITION_CAP)}\n`);
  writeFileSync(path.join(folder, 'd-review.md'), '---\nname: reviewer\neffort: medium\n---\n');
  symlinkSync(path.join(folder, 'd-review.md'), path.join(folder, 'e-linked.md'));
  assert.deepEqual(await effortLineOf(project, { agent_type: 'reviewer' }), [EFFORT('medium')], 'the scan goes past the FIFO and its link to a regular file');
  assert.deepEqual(await effortLineOf(project, { agent_type: 'large' }), [], 'a file past the cap');
});

test('a scan past its budget of folder entries, files, or bytes names no definition, and ends quickly', async (t) => {
  const match = '---\nname: reviewer\neffort: medium\n---\n';
  const fill = (folder, count, text = '---\nname: other\n---\n', extension = '.md') => {
    for (let n = 0; n < count; n += 1) writeFileSync(path.join(folder, `a${String(n).padStart(4, '0')}${extension}`), text);
  };
  const entries = attributedProject(t, ['effort'], { 'z-review.md': match });
  fill(path.join(entries, '.claude/agents'), SCAN_BUDGET.entries, 'not markdown', '.txt');
  const started = Date.now();
  assert.deepEqual(await effortLineOf(entries, { agent_type: 'reviewer' }), [], 'past the entries, whatever they hold');
  assert.ok(Date.now() - started < 5000, 'quickly');
  const within = attributedProject(t, ['effort'], { 'z-review.md': match });
  fill(path.join(within, '.claude/agents'), SCAN_BUDGET.entries - 1, 'not markdown', '.txt');
  assert.deepEqual(await effortLineOf(within, { agent_type: 'reviewer' }), [EFFORT('medium')], 'at the entry budget');
  const files = attributedProject(t, ['effort'], { 'z-review.md': match });
  fill(path.join(files, '.claude/agents'), SCAN_BUDGET.files);
  assert.deepEqual(await effortLineOf(files, { agent_type: 'reviewer' }), [], 'the match sorts past the file budget');
  const bytes = attributedProject(t, ['effort'], { 'z-review.md': match });
  fill(path.join(bytes, '.claude/agents'), Math.ceil(SCAN_BUDGET.bytes / (DEFINITION_CAP - 64)), `---\nname: other\n---\n${'x'.repeat(DEFINITION_CAP - 64)}`);
  assert.deepEqual(await effortLineOf(bytes, { agent_type: 'reviewer' }), [], 'the files before it spend the byte budget');
});

test('a definition read is held to what is left of the byte budget, and counts the bytes it read', (t) => {
  const folder = mkdtempSync(path.join(tmpdir(), 'aidrian-start-read-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'review.md');
  const text = `---\nname: reviewer\neffort: medium\n---\n${'é'.repeat(400)}\n`;
  writeFileSync(file, text);
  const size = Buffer.byteLength(text, 'utf8');
  assert.deepEqual(readDefinition(file, size - 1), { over: true }, 'less than its size left: nothing read');
  assert.deepEqual(readDefinition(file, size), { text, bytes: size }, 'the bytes readSync returned, not the text\'s length');
  assert.notEqual(text.length, size);
  assert.equal(readDefinition(folder, size), null, 'no regular file');
  writeFileSync(path.join(folder, 'large.md'), 'x'.repeat(DEFINITION_CAP + 1));
  assert.equal(readDefinition(path.join(folder, 'large.md'), SCAN_BUDGET.bytes), null, 'past the file cap, whatever the allowance');
});

test('an attempt clone, whose project names the driver\'s main checkout, reads no agent of that checkout', async (t) => {
  const main = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-start-driver-')));
  t.after(() => rmSync(main, { recursive: true, force: true }));
  const git = (cwd, ...args) => assert.equal(spawnSync('git', args, { cwd, encoding: 'utf8' }).status, 0, args.join(' '));
  writeFileSync(path.join(main, 'README.md'), '# x\n');
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'add', '.');
  git(main, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'x');
  mkdirSync(path.join(main, '.claude/agents'), { recursive: true });
  writeFileSync(path.join(main, '.claude/agents/review.md'), '---\nname: reviewer\neffort: medium\n---\n');
  const clone = `${main}-clone`;
  t.after(() => rmSync(clone, { recursive: true, force: true }));
  git(path.dirname(main), 'clone', '-q', main, clone);
  // The clone's project names the driver's checkout as its main one, as lib/project.mjs does for an attempt clone.
  const checkouts = agentCheckouts({ checkouts: [clone, main] });
  assert.deepEqual(checkouts, [clone]);
  assert.equal(claudeCode.subagentEffort({ input: { agent_type: 'reviewer' }, checkouts, env: {} }), null);
  assert.equal(claudeCode.subagentEffort({ input: { agent_type: 'reviewer' }, checkouts: [clone, main], env: {} }), 'medium', 'the fallback this guards');
});

test('a project below the checkout root of a linked worktree reads that project folder\'s agents in the main checkout', async (t) => {
  const main = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-start-nested-')));
  t.after(() => rmSync(main, { recursive: true, force: true }));
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: main, encoding: 'utf8' }).status, 0, args.join(' '));
  const web = path.join(main, 'packages/web');
  mkdirSync(path.join(web, '.aidrian/knowledge'), { recursive: true });
  writeFileSync(path.join(web, '.aidrian/config.json'), JSON.stringify({ version: 1, attribution: { commit: ['effort'] } }));
  writeFileSync(path.join(main, '.gitignore'), '.claude/\n');
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'config');
  mkdirSync(path.join(web, '.claude/agents'), { recursive: true });
  writeFileSync(path.join(web, '.claude/agents/review.md'), '---\nname: reviewer\neffort: medium\n---\n');
  const linked = `${main}-linked`;
  t.after(() => rmSync(linked, { recursive: true, force: true }));
  git('worktree', 'add', '-q', linked, '-b', 'side');
  const project = path.join(linked, 'packages/web');
  assert.deepEqual(agentCheckouts({ checkouts: [project, web] }), [project, web]);
  assert.deepEqual(await effortLineOf(project, { agent_type: 'reviewer' }), [EFFORT('medium')]);
});

test('a linked worktree with no agents folder reads the main checkout\'s, as Claude Code does', async (t) => {
  const main = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-start-main-')));
  t.after(() => rmSync(main, { recursive: true, force: true }));
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: main, encoding: 'utf8' }).status, 0, args.join(' '));
  mkdirSync(path.join(main, '.aidrian/knowledge'), { recursive: true });
  writeFileSync(path.join(main, '.aidrian/config.json'), JSON.stringify({ version: 1, attribution: { commit: ['effort'] } }));
  writeFileSync(path.join(main, '.gitignore'), '.claude/\n');
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'config');
  mkdirSync(path.join(main, '.claude/agents'), { recursive: true });
  writeFileSync(path.join(main, '.claude/agents/review.md'), '---\nname: reviewer\neffort: medium\n---\n');
  const linked = path.join(main, '..', `${path.basename(main)}-linked`);
  t.after(() => rmSync(linked, { recursive: true, force: true }));
  git('worktree', 'add', '-q', linked, '-b', 'side');
  assert.equal(existsSync(path.join(linked, '.claude/agents')), false);
  assert.deepEqual(agentCheckouts({ checkouts: [linked, main] }), [linked, main]);
  assert.deepEqual(await effortLineOf(linked, { agent_type: 'reviewer' }), [EFFORT('medium')], 'the main checkout\'s agents');
  // A worktree with an agents folder of its own reads only its own.
  mkdirSync(path.join(linked, '.claude/agents'), { recursive: true });
  writeFileSync(path.join(linked, '.claude/agents/review.md'), '---\nname: reviewer\neffort: high\n---\n');
  assert.deepEqual(await effortLineOf(linked, { agent_type: 'reviewer' }), [EFFORT('high')]);
});

test('a frontmatter value drops a plain scalar\'s ` #` comment and keeps a quoted one whole', async (t) => {
  const project = attributedProject(t, ['effort'], {
    'a.md': '---\nname: reviewer # the team\'s\neffort: medium # default\n---\n',
    'b.md': '---\nname: "quoted" # named\neffort: \'high\' # quoted\n---\n',
    'c.md': '---\nname: kept\neffort: "low # not a comment"\n---\n',
    'd.md': '---\nname: hashed\neffort: low#tag\n---\n',
  });
  assert.deepEqual(await effortLineOf(project, { agent_type: 'reviewer' }), [EFFORT('medium')]);
  assert.deepEqual(await effortLineOf(project, { agent_type: 'quoted' }), [EFFORT('high')]);
  assert.deepEqual(await effortLineOf(project, { agent_type: 'kept' }), [], 'a quoted # is the value\'s own');
  assert.deepEqual(await effortLineOf(project, { agent_type: 'hashed' }), [], 'a # with no blank before it is no comment');
});

test('a subagent hears no Agent-Effort line while attribution leaves effort out, or on Codex, whose adapter knows none', async (t) => {
  const agents = { 'review.md': '---\nname: reviewer\neffort: medium\n---\n' };
  assert.deepEqual(await effortLineOf(attributedProject(t, ['agent', 'model'], agents), { agent_type: 'reviewer' }), [], 'effort not listed');
  assert.deepEqual(await effortLineOf(attributedProject(t, [], agents), { agent_type: 'reviewer' }), [], 'attribution off');
  assert.deepEqual(await effortLineOf(attributedProject(t, ['effort'], agents), { agent_type: 'reviewer', effort: { level: 'high' } }, { CLAUDECODE: undefined }), [], 'Codex');
  assert.equal(codex.subagentEffort({ input: { agent_type: 'reviewer', effort: { level: 'high' } }, root: '/' }), null);
});

test('a host no adapter claims is called the AI, neither Claude nor Codex', async () => {
  const { stdout } = await hook({ input: JSON.stringify({ cwd: EXAMPLE }), PLUGIN_ROOT: null });
  assert.equal(stdout.split('\n')[1], NAMES('the AI'));
  assert.doesNotMatch(stdout, /Pull requests:/u, 'the footer line is Claude Code\'s to need');
});

test('the names line calls the AI by its host unless config.json or .aidrian.local.json names it, the local file winning', async (t) => {
  const input = JSON.stringify({ cwd: EXAMPLE });
  assert.equal((await hook({ input, CLAUDECODE: '1' })).stdout.split('\n')[1], NAMES('Claude'));
  assert.equal((await hook({ input })).stdout.split('\n')[1], NAMES('Codex'));

  const project = mkdtempSync(path.join(tmpdir(), 'aidrian-start-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(path.join(project, '.aidrian/knowledge'), { recursive: true });
  writeFileSync(path.join(project, '.aidrian/config.json'), JSON.stringify({ version: 1, names: { human: 'the team lead', ai: 'the agent' } }));
  writeFileSync(path.join(project, '.aidrian.local.json'), JSON.stringify({ names: { human: 'the "product" owner' } }));
  const lines = (await hook({ input: JSON.stringify({ cwd: project }), CLAUDECODE: '1' })).stdout.split('\n');
  assert.equal(lines[1], 'Names: call the human "the \\"product\\" owner" and yourself "the agent", in replies and questions alike; never "I", "me", "my", "you", or "your".');
  assert.equal(lines[2], VOICE('the \\"product\\" owner'));
});

test('outside a project, and for any stdin, the hook prints nothing and exits 0', async (t) => {
  const outside = mkdtempSync(path.join(tmpdir(), 'aidrian-start-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  for (const input of ['', 'not json', '[]', JSON.stringify({ cwd: outside }), JSON.stringify({ cwd: 42 })]) {
    for (const args of [[], ['--subagent']]) {
      const { status, stdout, stderr } = await hook({ input, args, cwd: outside });
      assert.deepEqual([status, stdout, stderr], [0, '', ''], `${input} ${args}`);
    }
  }
});

test('a project with a broken folder still gets the line, plus how many problems it has and the check to run', async (t) => {
  const project = mkdtempSync(path.join(tmpdir(), 'aidrian-start-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(path.join(project, '.aidrian/knowledge'), { recursive: true });
  writeFileSync(path.join(project, '.aidrian/config.json'), JSON.stringify({ version: 1, extra: 1 }));
  writeFileSync(path.join(project, '.aidrian/knowledge/kb.json'), JSON.stringify({ dir: 'missing' }));
  const { status, stdout } = await hook({ input: JSON.stringify({ cwd: project }) });
  assert.equal(status, 0);
  assert.match(stdout, /^Project knowledge: 0 buckets, 0 docs\. For more, run .* for a topic\. The project folder has 2 problems; run `\S+\/aidrian check`\.\n/);
  assert.equal(stdout.split('\n').slice(1).join('\n'), MAIN('Codex'));
});

test('the main session also hears about open lessons, escalated with the command to list them once a P1 is open; a subagent does not', async (t) => {
  const xdg = mkdtempSync(path.join(tmpdir(), 'aidrian-start-state-'));
  t.after(() => rmSync(xdg, { recursive: true, force: true }));
  const env = { ...process.env, XDG_STATE_HOME: xdg, PATH: WITHOUT_BIN };
  const add = (note) => spawnSync(path.join(BIN, 'aidrian'), ['lesson', 'add'], { cwd: EXAMPLE, input: note, encoding: 'utf8', env });
  assert.equal(add('the first lesson').status, 0);
  assert.equal(add('the second lesson').status, 0);

  const input = JSON.stringify({ cwd: EXAMPLE });
  const [knowledge, names, voice, format, lessons, rest] = (await hook({ input, XDG_STATE_HOME: xdg })).stdout.split('\n');
  assert.equal(knowledge, LINE(path.join(BIN, 'aidrian-knowledge')));
  assert.equal(names, NAMES('Codex'));
  assert.equal(voice, VOICE());
  assert.equal(format, FORMAT);
  assert.equal(lessons, 'Lesson inbox: 2 open (P2 2), the oldest from today. The lesson-triage skill drains it in a session opened for it.');
  assert.equal(rest, '');
  assert.doesNotMatch((await hook({ input, args: ['--subagent'], XDG_STATE_HOME: xdg })).stdout, /Lesson inbox/);

  const urgent = spawnSync(path.join(BIN, 'aidrian'), ['lesson', 'add', '--tier', 'P1'], { cwd: EXAMPLE, input: 'lost a commit', encoding: 'utf8', env });
  assert.equal(urgent.status, 0);
  const escalated = (await hook({ input, XDG_STATE_HOME: xdg })).stdout.split('\n')[4];
  assert.match(escalated, /^Lesson inbox needs triage: 1 P1 open\. Tell the Human once, then go on with the task: .* `\S+\/bin\/aidrian lesson list` shows the order\.$/);
});

// A project with `docs` indexed, each a file of docs/, and optional config.
function decisionsProject(t, docs, config = {}) {
  const project = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-start-')));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(path.join(project, '.aidrian/knowledge'), { recursive: true });
  mkdirSync(path.join(project, 'docs'));
  writeFileSync(path.join(project, '.aidrian/config.json'), JSON.stringify({ version: 1, ...config }));
  const entries = Object.fromEntries(Object.keys(docs).map((name) => [name, { summary: `${name} rules`, tags: [] }]));
  writeFileSync(path.join(project, '.aidrian/knowledge/10-docs.json'), JSON.stringify({ dir: 'docs', description: 'The rules.', docs: entries }));
  for (const [name, text] of Object.entries(docs)) writeFileSync(path.join(project, 'docs', name), text);
  return project;
}
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const unreviewed = (id, status, date) => `Rule.\n<!-- aidrian:decision id=${id} status=${status} class=copy domain=ux date=${date} pr=41 -->\n<!-- aidrian:decision-new id=${id} text="Rule." -->\n`;
const REMINDER = /^Decisions to review: .*$/mu;

test('the main session hears how many decisions wait for the Human and how old the oldest is; a subagent does not', async (t) => {
  const project = decisionsProject(t, {
    'a.md': `${unreviewed('one', 'unconfirmed', daysAgo(1))}\n${unreviewed('kept', 'confirmed', daysAgo(90))}\n`,
    'b.md': unreviewed('two', 'unconfirmed', daysAgo(3)),
  });
  const input = JSON.stringify({ cwd: project });
  const { status, stdout } = await hook({ input });
  assert.equal(status, 0);
  assert.match(stdout, /^Decisions to review: 2 \(oldest 3 days\)\. Tell the Human once, then go on with the task: the decision-review skill goes through them, and only a person starts it\.$/mu);
  assert.doesNotMatch((await hook({ input, args: ['--subagent'] })).stdout, /Decisions to review/u);
  const one = decisionsProject(t, { 'a.md': unreviewed('one', 'unconfirmed', daysAgo(1)) });
  assert.match((await hook({ input: JSON.stringify({ cwd: one }) })).stdout, /^Decisions to review: 1 \(oldest 1 day\)\./mu);
});

test('no reminder with nothing to review or with remind off, and a doc it cannot read costs only that doc', async (t) => {
  const settled = decisionsProject(t, { 'a.md': unreviewed('kept', 'confirmed', daysAgo(9)) });
  assert.doesNotMatch((await hook({ input: JSON.stringify({ cwd: settled }) })).stdout, REMINDER, 'N is 0');
  const none = decisionsProject(t, { 'a.md': '# Nothing here\n' });
  assert.doesNotMatch((await hook({ input: JSON.stringify({ cwd: none }) })).stdout, REMINDER, 'no markers');
  const own = decisionsProject(t, { 'a.md': unreviewed('one', 'unconfirmed', daysAgo(1)).replace('class=copy', 'class=pricing-page') }, { decisions: { classes: { 'pricing-page': 'the pricing page' } } });
  assert.match((await hook({ input: JSON.stringify({ cwd: own }) })).stdout, /^Decisions to review: 1 /mu, 'a marker of a project class counts');
  const removed = decisionsProject(t, { 'a.md': unreviewed('one', 'unconfirmed', daysAgo(1)).replace('class=copy', 'class=pricing-page') });
  assert.match((await hook({ input: JSON.stringify({ cwd: removed }) })).stdout, /^Decisions to review: 1 /mu, 'a marker whose class was removed still counts, as it does toward the pause');
  const off = decisionsProject(t, { 'a.md': unreviewed('one', 'unconfirmed', daysAgo(1)) }, { decisions: { unreviewed: { remind: 'off', pauseDomainAt: null } } });
  assert.doesNotMatch((await hook({ input: JSON.stringify({ cwd: off }) })).stdout, REMINDER, 'remind off');

  const folder = decisionsProject(t, { 'a.md': unreviewed('one', 'unconfirmed', daysAgo(2)), 'b.md': 'gone\n' });
  rmSync(path.join(folder, 'docs/b.md'));
  mkdirSync(path.join(folder, 'docs/b.md'));
  const { status, stdout } = await hook({ input: JSON.stringify({ cwd: folder }) });
  assert.equal(status, 0);
  assert.match(stdout, /^Decisions to review: 1 \(oldest 2 days\)\./mu, 'the doc that reads still counts');
  const broken = decisionsProject(t, { 'a.md': '<!-- aidrian:decision id=a status=nope -->\n' });
  const quiet = await hook({ input: JSON.stringify({ cwd: broken }) });
  assert.equal(quiet.status, 0);
  assert.doesNotMatch(quiet.stdout, REMINDER, 'a malformed marker counts for nothing');
});

test('the main session hears about untriaged persona audits only while some are; a subagent never, and bad state prints nothing', async (t) => {
  const project = path.join(mkdtempSync(path.join(tmpdir(), 'aidrian-start-')), 'consumer');
  t.after(() => rmSync(path.dirname(project), { recursive: true, force: true }));
  cpSync(EXAMPLE, project, { recursive: true });
  const configFile = path.join(project, '.aidrian/config.json');
  const state = path.join(path.dirname(project), 'state');
  writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), state: { dir: state } }));
  const audits = path.join(state, 'audits');
  const input = JSON.stringify({ cwd: project });
  const run = (args = []) => hook({ input, args });
  const LINE_RE = /^Audit inbox:/mu;

  assert.doesNotMatch((await run()).stdout, LINE_RE, 'no audits folder');
  mkdirSync(audits, { recursive: true });
  assert.doesNotMatch((await run()).stdout, LINE_RE, 'an empty audits folder');

  const fixtures = path.join(ROOT, 'test/fixtures/persona-audit');
  for (const name of ['front-desk-2026-05-02.md', 'front-desk-2026-05-02-2.md']) cpSync(path.join(fixtures, name), path.join(audits, name));
  const { status, stdout } = await run();
  assert.equal(status, 0);
  assert.equal(stdout.split('\n')[4], 'Audit inbox: 18 untriaged findings in 1 report. The persona-audit-triage skill triages them.', 'after the format line');
  assert.doesNotMatch((await run(['--subagent'])).stdout, /Audit inbox/);

  writeFileSync(path.join(audits, 'triage.json'), '{ cut short');
  const broken = await run();
  assert.equal(broken.status, 0);
  assert.equal(broken.stdout, `${LINE(path.join(BIN, 'aidrian-knowledge'))}\n${MAIN('Codex')}`, 'an unreadable triage record costs the line, nothing else');

  // Every item decided: the line goes away.
  const sidecar = {
    version: 1, report: 'front-desk-2026-05-02-2.md', personas: ['front-desk'], date: '2026-05-02', supersedes: 'front-desk-2026-05-02.md',
    carried_forward: [], not_rechecked: [], not_reached: [], doc_gaps: [],
    findings: [{ id: 'F1', title: 't', severity: 'polish', label: 'opinion', evidence_level: 'walked', personas: ['front-desk'], tasks: ['t'], owner: 'ux-specialist', owner_description: 'words', evidence: [], needs_trace: false }],
  };
  writeFileSync(path.join(audits, 'front-desk-2026-05-02-2.json'), JSON.stringify(sidecar));
  writeFileSync(path.join(audits, 'triage.json'), JSON.stringify({ version: 1, reports: {} }));
  assert.match((await run()).stdout, /^Audit inbox: 1 untriaged finding in 1 report\./mu);
  writeFileSync(path.join(audits, 'triage.json'), JSON.stringify({ version: 1, reports: { 'front-desk-2026-05-02-2.md': { F1: { decision: 'defer', date: '2026-05-03' } } } }));
  assert.doesNotMatch((await run()).stdout, LINE_RE, 'fully triaged');
});

test('when another copy of the plugin\'s aidrian comes first on PATH, one line names this copy\'s by its path', async (t) => {
  const other = mkdtempSync(path.join(tmpdir(), 'aidrian-start-other-'));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  writeFileSync(path.join(other, 'aidrian'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const input = JSON.stringify({ cwd: EXAMPLE });
  const line = `Commands: the aidrian on PATH, in ${other}, is another copy of this plugin; run this session's as ${path.join(BIN, 'aidrian')}.`;
  const first = await hook({ input, PATH: `${other}${path.delimiter}${BIN}${path.delimiter}${WITHOUT_BIN}` });
  assert.equal(first.status, 0);
  assert.deepEqual(first.stdout.split('\n').slice(3, 5), [line, FORMAT], 'after the voice line, in the main session');
  const subagent = JSON.parse((await hook({ input, args: ['--subagent'], PATH: `${other}${path.delimiter}${WITHOUT_BIN}` })).stdout);
  assert.match(subagent.hookSpecificOutput.additionalContext, new RegExp(`\n${line.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'u'), 'and in a subagent');
  assert.doesNotMatch((await hook({ input, PATH: `${BIN}${path.delimiter}${other}${path.delimiter}${WITHOUT_BIN}` })).stdout, /^Commands:/mu, 'this copy first: nothing');
  assert.doesNotMatch((await hook({ input })).stdout, /^Commands:/mu, 'no aidrian on PATH: nothing');
});

test('the gate snapshot is saved before the knowledge loads, so a knowledge folder that throws still leaves the gates held', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-start-'));
  const knowledge = path.join(dir, '.aidrian/knowledge');
  t.after(() => {
    chmodSync(knowledge, 0o755);
    rmSync(dir, { recursive: true, force: true });
  });
  mkdirSync(knowledge, { recursive: true });
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, agents: { explorer: { deny: ['WebFetch'] } } }));
  chmodSync(knowledge, 0o000);
  const session = 'start-snapshot-1';
  await hook({ input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: dir, session_id: session }) });
  assert.ok(existsSync(snapshotPath(session, { env: { XDG_STATE_HOME: XDG } })));
});

// The main-checkout warnings, against a temporary repository with a bare origin, each made with `git init` under
// mkdtemp and driven with `git -C`; no test sets GIT_DIR or GIT_WORK_TREE.
const AHEAD = 'Local main has 1 commit not on origin/main; only worktrees commit here. Inspect: git log origin/main..main';
const OFF = 'The main checkout is on side, not main; only worktrees change branch. Switch back: git switch main';
const DETACHED = "The main checkout's HEAD is detached, not on main. Switch back: git switch main";
const CHANGED = 'The main checkout has changed tracked files; task work belongs in a worktree. Inspect: git status';
const REAL_GIT = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();

function gitRepo(t, config = { version: 1, git: { mainCheckout: { guard: true } } }) {
  const temp = () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-start-git-')));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  };
  const dir = temp();
  const origin = temp();
  const git = (...args) => {
    const result = spawnSync('git', ['-C', dir, '-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  };
  assert.equal(spawnSync('git', ['-C', origin, 'init', '-q', '--bare', '-b', 'main']).status, 0);
  git('init', '-q', '-b', 'main');
  mkdirSync(path.join(dir, '.aidrian/knowledge'), { recursive: true });
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify(config));
  writeFileSync(path.join(dir, 'README.md'), '# test\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', 'origin', 'main');
  return { dir, git };
}

// A git that hangs for any call whose arguments hold `word`, and runs the real git otherwise; `word` '' hangs on all.
function hangingGit(t, word) {
  const bin = mkdtempSync(path.join(tmpdir(), 'aidrian-start-bin-'));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const match = word ? `*" ${word} "*` : '*';
  writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ncase " $* " in ${match}) exec sleep 30;; esac\nexec "${REAL_GIT}" "$@"\n`, { mode: 0o755 });
  return `${bin}${path.delimiter}${WITHOUT_BIN}`;
}

const after = (stdout) => stdout.split('\n').slice(4, -1);

test('the main session hears about unpushed commits on main, after the lessons line; even with origin, nothing', async (t) => {
  const { dir, git } = gitRepo(t);
  const input = JSON.stringify({ cwd: dir });
  assert.deepEqual(after((await hook({ input })).stdout), [], 'even with origin/main');
  git('commit', '-q', '--allow-empty', '-m', 'stray');
  assert.deepEqual(after((await hook({ input })).stdout), [AHEAD]);

  const xdg = mkdtempSync(path.join(tmpdir(), 'aidrian-start-state-'));
  t.after(() => rmSync(xdg, { recursive: true, force: true }));
  const env = { ...process.env, XDG_STATE_HOME: xdg, PATH: WITHOUT_BIN };
  assert.equal(spawnSync(path.join(BIN, 'aidrian'), ['lesson', 'add'], { cwd: dir, input: 'a lesson', encoding: 'utf8', env }).status, 0);
  const [lessons, ahead] = after((await hook({ input, XDG_STATE_HOME: xdg })).stdout);
  assert.match(lessons, /^Lesson inbox: 1 open/);
  assert.equal(ahead, AHEAD);
});

test('the main checkout off main, detached, or with changed tracked files gets its line; untracked files alone do not', async (t) => {
  const { dir, git } = gitRepo(t);
  const input = JSON.stringify({ cwd: dir });
  writeFileSync(path.join(dir, 'notes.md'), 'scratch\n');
  assert.deepEqual(after((await hook({ input })).stdout), [], 'clean on main, with an untracked file');
  git('switch', '-q', '-c', 'side');
  assert.deepEqual(after((await hook({ input })).stdout), [OFF]);
  git('switch', '-q', '--detach', 'main');
  assert.deepEqual(after((await hook({ input })).stdout), [DETACHED]);
  git('switch', '-q', 'main');
  writeFileSync(path.join(dir, 'README.md'), '# changed\n');
  assert.deepEqual(after((await hook({ input })).stdout), [CHANGED]);
});

test('no main-checkout line in a subagent, with the guard off, or without an origin/main ref', async (t) => {
  const { dir, git } = gitRepo(t);
  git('commit', '-q', '--allow-empty', '-m', 'stray');
  git('switch', '-q', '-c', 'side');
  const input = JSON.stringify({ cwd: dir });
  const { additionalContext } = JSON.parse((await hook({ input, args: ['--subagent'] })).stdout).hookSpecificOutput;
  assert.equal(additionalContext.split('\n').length, 3);
  assert.doesNotMatch(additionalContext, /main checkout|Local main/);

  const off = gitRepo(t, { version: 1, git: { mainCheckout: { guard: false } } });
  off.git('commit', '-q', '--allow-empty', '-m', 'stray');
  off.git('switch', '-q', '-c', 'side');
  assert.deepEqual(after((await hook({ input: JSON.stringify({ cwd: off.dir }) })).stdout), []);

  git('remote', 'remove', 'origin');
  assert.deepEqual(after((await hook({ input })).stdout), [OFF], 'no origin/main drops only the unpushed line');
});

const INHERITED =
  'AIDRIAN_ALLOW_MAIN_COMMIT is set in this session, so the commit guard lets every commit through. ' +
  'Tell the Human: restart the session without it, and use it per command in their own terminal.';

test('a main session that inherits AIDRIAN_ALLOW_MAIN_COMMIT=1 hears so while the guard is on, before the main-checkout lines', async (t) => {
  const { dir, git } = gitRepo(t);
  git('commit', '-q', '--allow-empty', '-m', 'stray');
  const input = JSON.stringify({ cwd: dir });
  assert.deepEqual(after((await hook({ input, AIDRIAN_ALLOW_MAIN_COMMIT: '1' })).stdout), [INHERITED, AHEAD]);
  assert.deepEqual(after((await hook({ input })).stdout), [AHEAD], 'unset: no line');
  assert.deepEqual(after((await hook({ input, AIDRIAN_ALLOW_MAIN_COMMIT: '0' })).stdout), [AHEAD], 'only 1 lets commits through');
  const { additionalContext } = JSON.parse((await hook({ input, args: ['--subagent'], AIDRIAN_ALLOW_MAIN_COMMIT: '1' })).stdout).hookSpecificOutput;
  assert.doesNotMatch(additionalContext, /AIDRIAN_ALLOW_MAIN_COMMIT/, 'the main session only');

  const off = gitRepo(t, { version: 1, git: { mainCheckout: { guard: false } } });
  assert.deepEqual(after((await hook({ input: JSON.stringify({ cwd: off.dir }), AIDRIAN_ALLOW_MAIN_COMMIT: '1' })).stdout), [], 'guard off: nothing to let through');
});

test('a git that hangs costs the main-checkout lines it stops and nothing else: the hook exits 0 inside its time', (t) => {
  const { dir, git } = gitRepo(t);
  git('commit', '-q', '--allow-empty', '-m', 'stray');
  git('switch', '-q', '-c', 'side');
  writeFileSync(path.join(dir, 'README.md'), '# changed\n');
  const input = JSON.stringify({ cwd: dir });
  for (const [word, lines] of [['status', [AHEAD, OFF]], ['rev-list', []], ['', []]]) {
    const started = Date.now();
    const { status, stdout, stderr } = hookProcess({ input, PATH: hangingGit(t, word) });
    assert.deepEqual([status, stderr], [0, ''], word);
    assert.match(stdout, /^Project knowledge: /, word);
    assert.deepEqual(after(stdout), lines, word || 'every git call');
    assert.ok(Date.now() - started < GIT_TIMEOUT_MS + 1500, `${word}: ${Date.now() - started} ms`);
  }
});

test('in handoff mode auto the main session hears it never asks whether to hand off; in ask and off, and in a subagent, nothing', async (t) => {
  const AUTO = 'Handoff: config.json session.handoff.mode is "auto", so this session never asks "the Human" whether to hand off or ' +
    'keep going. It judges that by itself and, when a handoff is worth it, runs the session-handoff skill; otherwise it keeps working.';
  const start = async (handoff, args = []) => {
    const project = decisionsProject(t, { 'a.md': 'Rule.\n' }, handoff ? { session: { handoff } } : {});
    const result = await hook({ input: JSON.stringify({ cwd: project }), args });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const auto = (await start({ mode: 'auto' })).split('\n');
  assert.equal(auto[auto.indexOf(FORMAT) + 1], AUTO, 'right after the format line');
  assert.ok((await start({ mode: 'auto', continue: 'clear' })).includes(AUTO), 'whatever the route');
  for (const handoff of [{ mode: 'ask' }, { mode: 'off' }, null]) assert.doesNotMatch(await start(handoff), /^Handoff:/mu, JSON.stringify(handoff));
  assert.doesNotMatch(await start({ mode: 'auto' }, ['--subagent']), /Handoff:/u, 'a subagent hands nothing off');
});
