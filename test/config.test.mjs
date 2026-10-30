import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { commandConfig, CONFIG_ERROR, DEFAULTS, loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { linksOutside } from '../plugins/aidrian/lib/fs.mjs';
import { findProject } from '../plugins/aidrian/lib/project.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXAMPLE = path.join(ROOT, 'examples/consumer');
// The link follows the repository the plugin's manifest names.
const REPOSITORY = JSON.parse(readFileSync(path.join(ROOT, 'plugins/aidrian/plugin.json'), 'utf8')).repository;
const MIGRATING = `see ${REPOSITORY}/blob/main/docs/project-folder.md#migrating`;

test('the example consumer config is valid, turns the main-checkout guard on, and gets every other default', () => {
  const { config, errors, current } = loadConfig(findProject(EXAMPLE));
  assert.deepEqual([errors, current], [[], true]);
  assert.deepEqual(config, { ...DEFAULTS, mainCheckout: { ...DEFAULTS.mainCheckout, guard: true } });
  assert.equal(DEFAULTS.mainCheckout.guard, false, 'a project opts in; a fresh one is never blocked');
});

test('file values win; a group keeps the defaults for the keys the file leaves out', (t) => {
  const github = { maxReviewRounds: 3, requiredChecks: ['e2e'], conditionalChecks: ['db tests'] };
  const { config, errors } = loadConfig(project(t, { version: 1, defaultBranch: 'trunk', github }));
  assert.deepEqual(errors, []);
  assert.equal(config.defaultBranch, 'trunk');
  assert.deepEqual(config.github, { ...DEFAULTS.github, ...github });
  assert.deepEqual(config.worktrees, DEFAULTS.worktrees);
});

test('lessons: signals on, and the nudge escalates past 20 open or 14 days unless a project sets other limits', (t) => {
  assert.deepEqual(DEFAULTS.lessons, { auto: true, maxOpen: 20, maxAgeDays: 14 });
  const { config, errors } = loadConfig(project(t, { version: 1, lessons: { maxOpen: 0 } }));
  assert.deepEqual([errors, config.lessons], [[], { auto: true, maxOpen: 0, maxAgeDays: 14 }]);
});

test('github.reviewer: null or "none" turns the review bot off, as null; an empty name is an error', (t) => {
  assert.equal(DEFAULTS.github.reviewer, 'chatgpt-codex-connector[bot]');
  for (const reviewer of [null, 'none']) {
    const { config, errors } = loadConfig(project(t, { version: 1, github: { reviewer, maxReviewRounds: 2 } }));
    assert.deepEqual([errors, config.github.reviewer, config.github.maxReviewRounds], [[], null, 2], String(reviewer));
    assert.ok(Object.isFrozen(config.github));
  }
  assert.deepEqual(loadConfig(project(t, { version: 1, github: { reviewer: '' } })).errors, [
    '.aidrian/config.json: "github.reviewer" must be a non-empty string or null',
  ]);
});

test('the loaded config is frozen all the way down', (t) => {
  const { config } = loadConfig(project(t, { version: 1, mainCheckout: { allowWrites: ['notes/**'] } }));
  assert.throws(() => { config.defaultBranch = 'x'; }, TypeError);
  assert.throws(() => { config.github.reviewer = 'x'; }, TypeError);
  assert.throws(() => config.mainCheckout.allowWrites.push('x'), TypeError);
  assert.throws(() => config.commits.types.push('x'), TypeError);
});

// Each case expects exactly one error, and the default in place of the bad value.
const errorCases = [
  ['unknown top-level key', { version: 1, extra: 1 }, /: unknown key "extra"$/],
  ['the old "pr" group, now "github"', { version: 1, pr: { reviewer: 'x' } }, /: "pr" is now "github": rename the key$/],
  ['the old "docs.alwaysBudgetBytes", now in "knowledge.budgets"', { version: 1, docs: { alwaysBudgetBytes: 1 } }, /: "docs\.alwaysBudgetBytes" is now "knowledge\.budgets\.alwaysBytes": rename the key$/],
  ['unknown key in a group', { version: 1, github: { reviewers: 'x' } }, /: unknown key "github\.reviewers"$/],
  ['zero for a knowledge budget', { version: 1, knowledge: { budgets: { taggedDocBytes: 0 } } }, /"knowledge\.budgets\.taggedDocBytes" must be a whole number above 0$/],
  ['inherited property name as a key', JSON.parse('{"version": 1, "__proto__": {}}'), /: unknown key "__proto__"$/],
  ['string instead of a list', { version: 1, commits: { types: 'feat' } }, /"commits\.types" must be a list of non-empty strings$/],
  ['check names that are not a list', { version: 1, github: { conditionalChecks: 'db tests' } }, /"github\.conditionalChecks" must be a list of non-empty strings$/],
  ['group that is not an object', { version: 1, github: [] }, /"github" must be an object$/],
  ['negative number', { version: 1, docs: { wrapLimit: -1 } }, /"docs\.wrapLimit" must be a whole number, 0 or more$/],
  ['zero where a positive number is needed', { version: 1, github: { maxReviewRounds: 0 } }, /"github\.maxReviewRounds" must be a whole number above 0$/],
  ['string for a boolean', { version: 1, mainCheckout: { guard: 'no' } }, /"mainCheckout\.guard" must be true or false$/],
  ['empty string', { version: 1, defaultBranch: ' ' }, /"defaultBranch" must be a non-empty string$/],
  ['handoff mode outside its list', { version: 1, session: { handoff: 'always' } }, /"session\.handoff" must be "off", "ask", or "auto"$/],
  ['lesson signals switch that is not a boolean', { version: 1, lessons: { auto: 'off' } }, /"lessons\.auto" must be true or false$/],
  ['a negative lesson age limit', { version: 1, lessons: { maxAgeDays: -1 } }, /"lessons\.maxAgeDays" must be a whole number, 0 or more$/],
  ['models that is not an object', { version: 1, models: [] }, /"models" must be an object$/],
  ['models for a host other than claude and codex', { version: 1, models: { gemini: {} } }, /: unknown key "models\.gemini"$/],
  ['models agents that is not an object', { version: 1, models: { codex: { agents: [] } } }, /"models\.codex\.agents" must be an object$/],
  [
    'models for skills, which no host can apply',
    { version: 1, models: { claude: { skills: { 'pr-write': { model: 'opus' } } } } },
    /"models\.claude\.skills" is not supported: neither host lets a project set a plugin skill's model or effort$/,
  ],
  [
    'models for an agent the plugin does not ship',
    { version: 1, models: { codex: { agents: { 'no-such-agent': { effort: 'high' } } } } },
    /: unknown agent "models\.codex\.agents\.no-such-agent"; the plugin's agents are agent-issue-writer, .*, planning-agent\b/,
  ],
  [
    'a Claude model the Agent tool cannot take',
    { version: 1, models: { claude: { agents: { explorer: { model: 'claude-opus-5-5' } } } } },
    /"models\.claude\.agents\.explorer\.model" must be "sonnet", "opus", "haiku", or "fable"$/,
  ],
  [
    'a Claude effort outside its levels',
    { version: 1, models: { claude: { agents: { explorer: { effort: 'ultra' } } } } },
    /"models\.claude\.agents\.explorer\.effort" must be "low", "medium", "high", "xhigh", or "max"$/,
  ],
  [
    'a Codex effort Codex does not name',
    { version: 1, models: { codex: { agents: { explorer: { effort: 'hihg' } } } } },
    /"models\.codex\.agents\.explorer\.effort" must be "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", or "persistent"$/,
  ],
  [
    'an empty Codex model',
    { version: 1, models: { codex: { agents: { explorer: { model: ' ' } } } } },
    /"models\.codex\.agents\.explorer\.model" must be a non-empty string$/,
  ],
  [
    'an agent entry that is not an object',
    { version: 1, models: { claude: { agents: { explorer: 'opus' } } } },
    /"models\.claude\.agents\.explorer" must be an object with "model", "effort", or both$/,
  ],
  [
    'an unknown key in an agent entry',
    { version: 1, models: { claude: { agents: { explorer: { model: 'opus', temperature: 1 } } } } },
    /: unknown key "models\.claude\.agents\.explorer\.temperature"$/,
  ],
  ['names that is not an object', { version: 1, names: 'the agent' }, /"names" must be an object$/],
  ['an empty human name', { version: 1, names: { human: ' ' } }, /"names\.human" must be a non-empty string$/],
  ['an AI name that is not text', { version: 1, names: { ai: 3 } }, /"names\.ai" must be a non-empty string or null$/],
  ['an unknown key in names', { version: 1, names: { user: 'x' } }, /: unknown key "names\.user"$/],
  ['a telemetry switch that is not true or false', { version: 1, telemetry: { enabled: 'no' } }, /"telemetry\.enabled" must be true or false$/],
  ['zero for telemetry.maxMb', { version: 1, telemetry: { maxMb: 0 } }, /"telemetry\.maxMb" must be a whole number above 0$/],
  ['the old "telemetry.doc_reads", now "telemetry.docReads"', { version: 1, telemetry: { doc_reads: false } }, /: "telemetry\.doc_reads" is now "telemetry\.docReads": rename the key$/],
  ['the old "telemetry.hook_denies", now "telemetry.hookDenies"', { version: 1, telemetry: { hook_denies: false } }, /: "telemetry\.hook_denies" is now "telemetry\.hookDenies": rename the key$/],
  ['the old "telemetry.max_mb", now "telemetry.maxMb"', { version: 1, telemetry: { max_mb: 5 } }, /: "telemetry\.max_mb" is now "telemetry\.maxMb": rename the key$/],
  ['telemetry.health that is not an object', { version: 1, telemetry: { health: 5 } }, /"telemetry\.health" must be an object$/],
  ['a health percent above 100', { version: 1, telemetry: { health: { redispatchPercent: 120 } } }, /"telemetry\.health\.redispatchPercent" must be a whole number from 1 to 100$/],
  ['a health percent of 0', { version: 1, telemetry: { health: { topDocPercent: 0 } } }, /"telemetry\.health\.topDocPercent" must be a whole number from 1 to 100$/],
  ['a minimum sample of 0', { version: 1, telemetry: { health: { minSample: 0 } } }, /"telemetry\.health\.minSample" must be a whole number above 0$/],
  ['an unknown health threshold', { version: 1, telemetry: { health: { maxCost: 3 } } }, /: unknown key "telemetry\.health\.maxCost"$/],
  ['agents that is not an object', { version: 1, agents: ['explorer'] }, /"agents" must be an object$/],
  ['an agent name with a space', { version: 1, agents: { 'code reviewer': { deny: ['Bash'] } } }, /"agents\.code reviewer": an agent name is/],
  ['agent gates that are not an object', { version: 1, agents: { explorer: ['Bash'] } }, /"agents\.explorer" must be an object with "deny", "allow", or both$/],
  ['an unknown key in agent gates', { version: 1, agents: { explorer: { block: ['Bash'] } } }, /: unknown key "agents\.explorer\.block"$/],
  ['a deny that is not a list', { version: 1, agents: { explorer: { deny: 'Bash' } } }, /"agents\.explorer\.deny" must be a list of tool patterns$/],
  ['a "*" inside a pattern', { version: 1, agents: { '*': { deny: ['mcp__*__send'] } } }, /"agents\.\*\.deny" has "mcp__\*__send": a "\*" can only end a pattern/],
  ['a glob in a Bash prefix', { version: 1, agents: { main: { deny: ['Bash(git push *)'] } } }, /has "Bash\(git push \*\)": Bash\(\.\.\.\) takes a command prefix without "\*"/],
  ['an operator in a Bash prefix', { version: 1, agents: { main: { allow: ['Bash(npm test && rm)'] } } }, /Bash\(\.\.\.\) takes plain words/],
  ['an empty Bash prefix', { version: 1, agents: { main: { deny: ['Bash( )'] } } }, /Bash\(\) needs a command prefix/],
  ['a path pattern', { version: 1, agents: { main: { deny: ['Read(./secrets/**)'] } } }, /a pattern is a tool name such as Read/],
];

for (const [name, value, expected] of errorCases) {
  test(`check fails: ${name}`, (t) => {
    const { config, errors, current } = loadConfig(project(t, value));
    assert.equal(errors.length, 1, errors.join('\n'));
    assert.match(errors[0], /^\.aidrian\/config\.json: /);
    assert.match(errors[0], expected);
    assert.equal(current, true);
    for (const key of ['defaultBranch', 'github', 'docs', 'commits', 'mainCheckout']) assert.deepEqual(config[key], DEFAULTS[key], key);
  });
}

// A missing, older, or newer version is one error that points at the migration notes, and nothing else is read.
const versionCases = [
  ['missing', { defaultBranch: 'trunk' }, 'missing'],
  ['older', { version: 0, extra: 1 }, '0'],
  ['newer', { version: 2, extra: 1 }, '2'],
  ['not a number', { version: '1' }, '"1"'],
];

for (const [name, value, shown] of versionCases) {
  test(`check fails: version ${name}`, (t) => {
    const { config, errors, current } = loadConfig(project(t, value));
    assert.deepEqual(errors, [`.aidrian/config.json: project folder version ${shown}; this plugin reads version 1; ${MIGRATING}`]);
    assert.equal(current, false);
    assert.deepEqual(config, DEFAULTS);
  });
}

test('models: .aidrian.local.json wins over config.json one field at a time, and a bad value keeps the one below it', (t) => {
  assert.deepEqual(DEFAULTS.models, { claude: { agents: {} }, codex: { agents: {} } });
  const team = project(t, {
    version: 1,
    models: {
      claude: { agents: { 'planning-agent': { model: 'opus', effort: 'high' }, explorer: { model: 'haiku' } } },
      codex: { agents: { 'planning-agent': { model: 'gpt-5.5', effort: 'medium' } } },
    },
  });
  assert.deepEqual(loadConfig(team).errors, []);
  writeFileSync(
    path.join(team.root, '.aidrian.local.json'),
    JSON.stringify({ models: { claude: { agents: { 'planning-agent': { effort: 'max', model: 'gpt-5.5' }, integrator: { effort: 'low' } } } } }),
  );
  const { config, errors } = loadConfig(findProject(team.root));
  assert.deepEqual(errors, ['.aidrian.local.json: "models.claude.agents.planning-agent.model" must be "sonnet", "opus", "haiku", or "fable"']);
  assert.deepEqual(config.models, {
    claude: { agents: { 'planning-agent': { model: 'opus', effort: 'max' }, explorer: { model: 'haiku' }, integrator: { effort: 'low' } } },
    codex: { agents: { 'planning-agent': { model: 'gpt-5.5', effort: 'medium' } } },
  });
  assert.throws(() => { config.models.claude.agents.explorer.model = 'opus'; }, TypeError);
});

test('names: "the Human" and the host\'s name by default; .aidrian.local.json wins over config.json one name at a time', (t) => {
  assert.deepEqual(DEFAULTS.names, { human: 'the Human', ai: null });
  const team = project(t, { version: 1, names: { human: 'the team lead', ai: 'the agent' } });
  assert.deepEqual(loadConfig(team), { config: { ...DEFAULTS, names: { human: 'the team lead', ai: 'the agent' } }, errors: [], current: true });
  const local = path.join(team.root, '.aidrian.local.json');
  writeFileSync(local, JSON.stringify({ names: { human: 'the product owner', ai: ' ' } }));
  const { config, errors } = loadConfig(findProject(team.root));
  assert.deepEqual(errors, ['.aidrian.local.json: "names.ai" must be a non-empty string or null']);
  assert.deepEqual(config.names, { human: 'the product owner', ai: 'the agent' });
  writeFileSync(local, JSON.stringify({ names: ['the product owner'] }));
  assert.deepEqual(loadConfig(findProject(team.root)).errors, ['.aidrian.local.json: "names" must be an object']);
  writeFileSync(local, JSON.stringify({ names: { ai: null } }));
  assert.deepEqual(loadConfig(findProject(team.root)).config.names, { human: 'the team lead', ai: null });
});

test('telemetry: on, with doc reads, hook denies, and 20 MB by default; .aidrian.local.json wins one key at a time', (t) => {
  const { health } = DEFAULTS.telemetry;
  assert.deepEqual(DEFAULTS.telemetry, { enabled: true, docReads: true, hookDenies: true, maxMb: 20, health });
  const team = project(t, { version: 1, telemetry: { docReads: false, maxMb: 5 } });
  assert.deepEqual(loadConfig(team).config.telemetry, { enabled: true, docReads: false, hookDenies: true, maxMb: 5, health });
  const local = path.join(team.root, '.aidrian.local.json');
  writeFileSync(local, JSON.stringify({ telemetry: { enabled: false, maxMb: 0 } }));
  const { config, errors } = loadConfig(findProject(team.root));
  assert.deepEqual(errors, ['.aidrian.local.json: "telemetry.maxMb" must be a whole number above 0']);
  assert.deepEqual(config.telemetry, { enabled: false, docReads: false, hookDenies: true, maxMb: 5, health });
  writeFileSync(local, JSON.stringify({ telemetry: true }));
  assert.deepEqual(loadConfig(findProject(team.root)).errors, ['.aidrian.local.json: "telemetry" must be an object']);
  writeFileSync(local, JSON.stringify({ telemetry: { doc_reads: true } }));
  assert.deepEqual(loadConfig(findProject(team.root)).errors, ['.aidrian.local.json: "telemetry.doc_reads" is now "telemetry.docReads": rename the key']);
});

test('telemetry.health: report health thresholds by default; config.json and .aidrian.local.json each set any of them', (t) => {
  assert.deepEqual(DEFAULTS.telemetry.health, {
    minSample: 5, redispatchPercent: 20, sentBackPercent: 10, topDocPercent: 50, reviewRounds: 3, lateFindingPercent: 50, denyHotSpot: 5, costRisePercent: 50,
  });
  const team = project(t, { version: 1, telemetry: { health: { minSample: 10, costRisePercent: 150 } } });
  assert.deepEqual(loadConfig(team).config.telemetry.health, { ...DEFAULTS.telemetry.health, minSample: 10, costRisePercent: 150 });
  writeFileSync(path.join(team.root, '.aidrian.local.json'), JSON.stringify({ telemetry: { health: { minSample: 3 } } }));
  const { config, errors } = loadConfig(findProject(team.root));
  assert.deepEqual(errors, []);
  assert.deepEqual(config.telemetry.health, { ...DEFAULTS.telemetry.health, minSample: 3, costRisePercent: 150 });
});

test('agents: no gates by default; .aidrian.local.json wins over config.json one list at a time, and a bad pattern is left out', (t) => {
  assert.deepEqual(DEFAULTS.agents, {});
  const agents = { '*': { deny: ['mcp__slack__*'] }, main: { deny: ['Bash(git push)'] }, explorer: { allow: ['Read', 'Grep'], deny: ['Bash'] } };
  const team = project(t, { version: 1, agents });
  assert.deepEqual(loadConfig(team), { config: { ...DEFAULTS, agents }, errors: [], current: true });
  writeFileSync(
    path.join(team.root, '.aidrian.local.json'),
    JSON.stringify({ agents: { explorer: { allow: ['Read', 'Glo*b', 'Bash(git log)'] }, 'aidrian:architect': { deny: ['Edit'] } } }),
  );
  const { config, errors } = loadConfig(findProject(team.root));
  assert.deepEqual(errors, ['.aidrian.local.json: "agents.explorer.allow" has "Glo*b": a "*" can only end a pattern, as in mcp__github__*']);
  assert.deepEqual(config.agents, {
    ...agents,
    explorer: { allow: ['Read', 'Bash(git log)'], deny: ['Bash'] },
    'aidrian:architect': { deny: ['Edit'] },
  });
  assert.throws(() => { config.agents.explorer.deny.push('Read'); }, TypeError);
});

test('worktrees.dir defaults to .worktrees, bootstrap to null, and disposable to package and build folders; a value replaces each', (t) => {
  const disposable = ['node_modules', 'dist', 'build', '.next', '.cache', 'coverage', '.turbo'];
  assert.deepEqual(DEFAULTS.worktrees, { dir: '.worktrees', bootstrap: null, disposable });
  assert.deepEqual(loadConfig(project(t, { version: 1, worktrees: { bootstrap: null } })).errors, []);
  const { config } = loadConfig(project(t, { version: 1, worktrees: { dir: '../wt', bootstrap: 'npm ci', disposable: [] } }));
  assert.deepEqual(config.worktrees, { dir: '../wt', bootstrap: 'npm ci', disposable: [] });
  assert.deepEqual(loadConfig(project(t, { version: 1, worktrees: { dir: null } })).errors, [
    '.aidrian/config.json: "worktrees.dir" must be a non-empty string',
  ]);
  for (const bad of [['packages/web/dist'], ['..'], 'node_modules', [' ']]) {
    const loaded = loadConfig(project(t, { version: 1, worktrees: { disposable: bad } }));
    assert.deepEqual(loaded.errors, ['.aidrian/config.json: "worktrees.disposable" must be a list of folder names with no "/", such as "node_modules"'], JSON.stringify(bad));
    assert.deepEqual(loaded.config.worktrees.disposable, disposable);
  }
});

test('a missing, malformed, or outside-linking file is one error, and the config is all defaults', (t) => {
  const missing = project(t, {});
  rmSync(path.join(missing.root, '.aidrian/config.json'));
  const broken = project(t, {});
  writeFileSync(path.join(broken.root, '.aidrian/config.json'), '{');
  const linked = project(t, {});
  rmSync(path.join(linked.root, '.aidrian/config.json'));
  symlinkSync(path.join(ROOT, 'package.json'), path.join(linked.root, '.aidrian/config.json'));
  const cases = [[missing, /: not found$/], [broken, /: invalid JSON/], [linked, /: links outside the project$/]];
  for (const [each, expected] of cases) {
    const { config, errors, current } = loadConfig(each);
    assert.equal(errors.length, 1, errors.join('\n'));
    assert.match(errors[0], expected);
    assert.equal(current, false);
    assert.deepEqual(config, DEFAULTS);
  }
});

test('commandConfig throws every config error with the exit code it is given; no config.json yet is the defaults', (t) => {
  const renamed = project(t, { version: 1, pr: { requiredChecks: ['e2e'] } });
  assert.throws(() => commandConfig(renamed), { code: CONFIG_ERROR, exitCode: 1, message: '.aidrian/config.json: "pr" is now "github": rename the key' });
  assert.throws(() => commandConfig(renamed, { exitCode: 3 }), { exitCode: 3 });
  const other = project(t, { version: 2 });
  assert.throws(() => commandConfig(other), { code: CONFIG_ERROR, message: /project folder version 2; this plugin reads version 1/ });
  const missing = project(t, {});
  rmSync(path.join(missing.root, '.aidrian/config.json'));
  assert.equal(commandConfig(missing), DEFAULTS);
  assert.deepEqual(commandConfig(project(t, { version: 1, github: { requiredChecks: ['e2e'] } })).github.requiredChecks, ['e2e']);
});

test('linksOutside judges a path that does not exist yet where a write would create it', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'real'));
  symlinkSync(path.join(dir, 'real'), path.join(dir, 'in'));
  symlinkSync(ROOT, path.join(dir, 'out'));
  symlinkSync(path.join(ROOT, 'no-such-folder'), path.join(dir, 'broken'));
  const cases = [
    ['new/file', '', false],
    ['in/new/file', '', false],
    ['in/new/file', 'real', false],
    ['out', '', true],
    ['out/new/file', '', true],
    ['real/other', 'in/new', true],
    ['broken', '', true],
    ['broken/new/file', '', true],
  ];
  for (const [rel, within, outside] of cases) assert.equal(linksOutside(dir, rel, within), outside, `${rel} within "${within}"`);
});

function project(t, config) {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify(config));
  return findProject(dir);
}
