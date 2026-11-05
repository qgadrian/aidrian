import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { commandConfig, committedConfig, committedDecisions, committedQuorumProduct, CONFIG_ERROR, DEFAULTS, loadConfig, malformedGates, resolveAutoMerge } from '../plugins/aidrian/lib/config.mjs';
import { linksOutside } from '../plugins/aidrian/lib/fs.mjs';
import { loadVocab } from '../plugins/aidrian/lib/decisions.mjs';
import { committedConfigFile, findProject } from '../plugins/aidrian/lib/project.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXAMPLE = path.join(ROOT, 'examples/consumer');
// The link follows the repository the plugin's manifest names.
const REPOSITORY = JSON.parse(readFileSync(path.join(ROOT, 'plugins/aidrian/plugin.json'), 'utf8')).repository;
const MIGRATING = `see ${REPOSITORY}/blob/main/docs/project-folder.md#migrating`;

test('the example consumer config is valid, turns its rules on, and gets every other default', () => {
  const { config, errors, current } = loadConfig(findProject(EXAMPLE));
  assert.deepEqual([errors, current], [[], true]);
  const pullRequest = {
    ...DEFAULTS.github.pullRequest,
    sections: ['Summary', 'Risk', 'Tests run', 'Deferred to issues'],
    issueKey: 'NOTES-\\d+',
    deferrals: { section: 'Deferred to issues', field: 'defer_reason', reasons: ['needs_owner_decision', 'user_chose'], neverValid: ['out of scope'] },
  };
  assert.deepEqual(config, {
    ...DEFAULTS,
    git: { ...DEFAULTS.git, mainCheckout: { ...DEFAULTS.git.mainCheckout, guard: true } },
    github: { ...DEFAULTS.github, pullRequest, reviewGate: { enabled: true, checklist: 'docs/knowledge/engineering/testing.md' } },
    terms: { file: '.aidrian/terms.json' },
  });
  assert.equal(DEFAULTS.git.mainCheckout.guard, false, 'a project opts in; a fresh one is never blocked');
});

test('file values win; a group keeps the defaults for the keys the file leaves out', (t) => {
  const github = { maxReviewRounds: 3, requiredChecks: ['e2e'], conditionalChecks: ['db tests'] };
  const { config, errors } = loadConfig(project(t, { version: 1, git: { defaultBranch: 'trunk' }, github }));
  assert.deepEqual(errors, []);
  assert.equal(config.git.defaultBranch, 'trunk');
  assert.deepEqual(config.github, { ...DEFAULTS.github, ...github });
  assert.deepEqual(config.git.worktrees, DEFAULTS.git.worktrees);
});

test('git groups the git keys, and the old top-level keys are unknown', (t) => {
  assert.deepEqual(Object.keys(DEFAULTS.git), ['defaultBranch', 'worktrees', 'mainCheckout', 'commits']);
  const nested = loadConfig(project(t, { version: 1, git: { defaultBranch: 'trunk', worktrees: { dir: '../wt' }, mainCheckout: { guard: true }, commits: { types: ['feat'] } } }));
  assert.deepEqual(nested.errors, []);
  assert.deepEqual(nested.config.git, {
    defaultBranch: 'trunk',
    worktrees: { ...DEFAULTS.git.worktrees, dir: '../wt' },
    mainCheckout: { guard: true, allowWrites: [] },
    commits: { types: ['feat'] },
  });
  for (const key of Object.keys(DEFAULTS.git)) {
    const loaded = loadConfig(project(t, { version: 1, [key]: {} }));
    assert.deepEqual(loaded.errors, [`.aidrian/config.json: unknown key "${key}"`], key);
    assert.equal(Object.hasOwn(loaded.config, key), false, key);
  }
  assert.deepEqual(loadConfig(project(t, { version: 1, git: { defaultBranch: ' ', remote: 'origin' } })).errors, [
    '.aidrian/config.json: unknown key "git.remote"',
    '.aidrian/config.json: "git.defaultBranch" must be a non-empty string',
  ]);
  assert.deepEqual(loadConfig(project(t, { version: 1, git: 'main' })).errors, ['.aidrian/config.json: "git" must be an object']);
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

test('github.markReady: "auto" by default, so the review loop marks a signed-off green draft ready; "ask" opts out', (t) => {
  assert.equal(DEFAULTS.github.markReady, 'auto');
  const { config, errors } = loadConfig(project(t, { version: 1, github: { markReady: 'ask' } }));
  assert.deepEqual([errors, config.github.markReady], [[], 'ask']);
  assert.match(loadConfig(project(t, { version: 1, github: { markReady: true } })).errors[0], /"github\.markReady" must be "ask" or "auto"$/);
});

test('github.reviewLoop: "auto" by default, so the review loop starts after pr-write; "ask" offers it; any other value is an error', (t) => {
  assert.equal(DEFAULTS.github.reviewLoop, 'auto');
  const { config, errors } = loadConfig(project(t, { version: 1, github: { reviewLoop: 'ask' } }));
  assert.deepEqual([errors, config.github.reviewLoop, config.github.markReady], [[], 'ask', 'auto']);
  for (const reviewLoop of ['off', true, null]) {
    const loaded = loadConfig(project(t, { version: 1, github: { reviewLoop } }));
    assert.deepEqual(loaded.errors, ['.aidrian/config.json: "github.reviewLoop" must be "ask" or "auto"'], String(reviewLoop));
    assert.equal(loaded.config.github.reviewLoop, 'auto', 'a bad value keeps the default');
  }
});

test('github.autoMerge: the team ceiling is off by default, with no strategy and no cleanup', () => {
  assert.deepEqual(DEFAULTS.github.autoMerge, { allow: false, default: 'off', strategy: null, deleteBranch: false, deleteWorktree: false });
  assert.deepEqual(resolveAutoMerge(DEFAULTS.github, 'off'), { effective: false, reason: 'team' });
});

test('github.autoMerge: strategy is null, "squash", "merge", or "rebase"; a team sets any key of the group', (t) => {
  for (const strategy of [null, 'squash', 'merge', 'rebase']) {
    const { config, errors } = loadConfig(project(t, { version: 1, github: { autoMerge: { allow: true, strategy } } }));
    assert.deepEqual([errors, config.github.autoMerge], [[], { allow: true, default: 'off', strategy, deleteBranch: false, deleteWorktree: false }]);
  }
  const bad = loadConfig(project(t, { version: 1, github: { autoMerge: { strategy: 'fast-forward', deleteBranch: 'yes', when: 'green' } } }));
  assert.deepEqual(bad.errors, [
    '.aidrian/config.json: unknown key "github.autoMerge.when"',
    '.aidrian/config.json: "github.autoMerge.strategy" must be null, "squash", "merge", or "rebase"',
    '.aidrian/config.json: "github.autoMerge.deleteBranch" must be true or false',
  ]);
  assert.deepEqual(bad.config.github.autoMerge, DEFAULTS.github.autoMerge);
});

test('github.autoMerge: on only when the team allows it and the machine opts in; loadConfig decides nothing', (t) => {
  const allowed = { ...DEFAULTS.github, autoMerge: { ...DEFAULTS.github.autoMerge, allow: true } };
  assert.deepEqual(resolveAutoMerge(DEFAULTS.github, 'off'), { effective: false, reason: 'team' }, 'default');
  assert.deepEqual(resolveAutoMerge(allowed, 'off'), { effective: false, reason: 'local' }, 'team allow alone');
  assert.deepEqual(resolveAutoMerge(DEFAULTS.github, 'on'), { effective: false, reason: 'team' }, 'local on alone');
  assert.deepEqual(resolveAutoMerge(allowed, 'on'), { effective: true, reason: null }, 'both on');
  const byDefault = { ...DEFAULTS.github, autoMerge: { ...DEFAULTS.github.autoMerge, allow: true, default: 'on' } };
  assert.deepEqual(resolveAutoMerge(allowed, 'unset'), { effective: false, reason: 'local' }, 'unset under default off');
  assert.deepEqual(resolveAutoMerge(byDefault, 'unset'), { effective: true, reason: null }, 'unset under default on');
  assert.deepEqual(resolveAutoMerge(byDefault, 'off'), { effective: false, reason: 'local' }, 'a machine opts out of default on');
  assert.deepEqual(resolveAutoMerge({ autoMerge: { allow: false, default: 'on' } }, 'unset'), { effective: false, reason: 'team' }, 'default on never passes allow');
  const team = project(t, { version: 1, github: { autoMerge: { allow: true } } });
  writeFileSync(path.join(team.root, '.aidrian.local.json'), JSON.stringify({ github: { autoMerge: 'on' } }));
  const { config, errors } = loadConfig(findProject(team.root));
  assert.deepEqual(errors, []);
  assert.deepEqual(config.github.autoMerge, { ...DEFAULTS.github.autoMerge, allow: true }, 'no effective field: a caller resolves it');
  assert.equal(Object.hasOwn(config, 'autoMerge'), false);
});

test('github.autoMerge: aidrian check warns, and still passes, when the machine opts in and the team does not allow it', (t) => {
  const team = project(t, { version: 1 });
  // A temporary repository of its own, so git can say the local file is untracked: never GIT_DIR.
  spawnSync('git', ['init', '-q'], { cwd: team.root });
  writeFileSync(path.join(team.root, '.gitignore'), '.aidrian.local.json\n.worktrees/\n');
  const local = path.join(team.root, '.aidrian.local.json');
  const check = () => spawnSync(path.join(ROOT, 'plugins/aidrian/bin/aidrian'), ['check'], { cwd: team.root, encoding: 'utf8' });
  const WARNING = 'warning: auto-merge is on locally but the team does not allow it';
  writeFileSync(local, JSON.stringify({ github: { autoMerge: 'on' } }));
  const warned = check();
  assert.equal(warned.status, 0, warned.stderr);
  assert.match(warned.stderr, new RegExp(`^${WARNING}$`, 'mu'));
  assert.match(warned.stdout, /^ok: /u);
  assert.doesNotThrow(() => commandConfig(findProject(team.root)), 'the warning is no config error');
  writeFileSync(local, JSON.stringify({ github: { autoMerge: 'off' } }));
  assert.doesNotMatch(check().stderr, /auto-merge/u, 'off locally: nothing to say');
  writeFileSync(path.join(team.root, '.aidrian/config.json'), JSON.stringify({ version: 1, github: { autoMerge: { allow: true } } }));
  writeFileSync(local, JSON.stringify({ github: { autoMerge: 'on' } }));
  assert.doesNotMatch(check().stderr, /auto-merge/u, 'allowed by the team: nothing to say');
});

test('docs/config.md shows the github defaults as DEFAULTS holds them', () => {
  // A changed default raises no `aidrian check` line, so the doc is where a project reads it.
  const doc = readFileSync(path.join(ROOT, 'docs/config.md'), 'utf8');
  const example = JSON.parse(doc.match(/## Keys[\s\S]*?```json\n([\s\S]*?)```/)[1]);
  assert.deepEqual(example.github, DEFAULTS.github);
});

test('audits.triage: issues wait for the Human by default, with the audit, persona, and severity labels; "auto" opts in', (t) => {
  assert.deepEqual(DEFAULTS.audits.triage, { issueCreation: 'confirm', labels: ['persona-audit', 'persona:{persona}', 'severity:{severity}'] });
  const load = (triage) => loadConfig(project(t, { version: 1, audits: { triage } }));
  let { config, errors } = load({ issueCreation: 'auto' });
  assert.deepEqual([errors, config.audits.triage], [[], { ...DEFAULTS.audits.triage, issueCreation: 'auto' }]);
  ({ config, errors } = load({ labels: ['ux-audit', 'who:{persona}'] }));
  assert.deepEqual([errors, config.audits.triage], [[], { issueCreation: 'confirm', labels: ['ux-audit', 'who:{persona}'] }]);
  const bad = (triage) => load(triage).errors.join('\n');
  assert.match(bad({ issueCreation: 'yes' }), /"audits\.triage\.issueCreation" must be "confirm" or "auto"$/);
  for (const labels of [['persona-audit', '{owner}'], ['persona:{persona}'], ['persona-audit', 'cut{'], [], 'persona-audit']) {
    assert.match(bad({ labels }), /"audits\.triage\.labels" must be a list of labels, each plain or holding \{persona\} or \{severity\}, with at least one plain label$/, JSON.stringify(labels));
  }
  assert.equal(load({ issueCreation: 'yes' }).config.audits.triage.issueCreation, 'confirm', 'a bad value keeps the default');
});

test('git.mainCheckout has no commits key: the guard alone turns the commit guard on, and a leftover commits is unknown', (t) => {
  assert.deepEqual(Object.keys(DEFAULTS.git.mainCheckout), ['guard', 'allowWrites']);
  const { config, errors } = loadConfig(project(t, { version: 1, git: { mainCheckout: { guard: true, commits: 'warn' } } }));
  assert.deepEqual(errors, ['.aidrian/config.json: unknown key "git.mainCheckout.commits"']);
  assert.deepEqual(config.git.mainCheckout, { guard: true, allowWrites: [] });
});

test('github.titleIssuePrefix: off by default, so pull request titles are plain Conventional Commits', (t) => {
  assert.equal(DEFAULTS.github.titleIssuePrefix, false);
  const { config, errors } = loadConfig(project(t, { version: 1, github: { titleIssuePrefix: true } }));
  assert.deepEqual([errors, config.github.titleIssuePrefix], [[], true]);
  assert.match(loadConfig(project(t, { version: 1, github: { titleIssuePrefix: 'yes' } })).errors[0], /"github\.titleIssuePrefix" must be true or false$/);
});

test('the handoff settings load as a group, and a project sets any of them', (t) => {
  const { config, errors } = loadConfig(project(t, { version: 1, session: { handoff: { mode: 'auto', costRatio: 1.5, maxTokens: 300000 } } }));
  assert.deepEqual([errors, config.session], [[], { handoff: { mode: 'auto', costRatio: 1.5, maxTokens: 300000 } }]);
  const some = loadConfig(project(t, { version: 1, session: { handoff: { mode: 'off' } } }));
  assert.deepEqual([some.errors, some.config.session.handoff], [[], { ...DEFAULTS.session.handoff, mode: 'off' }]);
});

test('a string session.handoff, the old shape, keeps its mode and is reported', (t) => {
  for (const mode of ['off', 'ask', 'auto']) {
    const { config, errors } = loadConfig(project(t, { version: 1, session: { handoff: mode } }));
    assert.deepEqual(config.session.handoff, { ...DEFAULTS.session.handoff, mode });
    assert.deepEqual(errors, ['.aidrian/config.json: "session.handoff" is now "session.handoff.mode": move it']);
  }
});

test('the old session limit keys carry no value into the handoff settings', (t) => {
  const { config, errors } = loadConfig(project(t, { version: 1, session: { maxTokens: 90000, maxCalls: 10, maxHours: 1 } }));
  assert.equal(errors.length, 3, errors.join('\n'));
  assert.deepEqual(config.session, DEFAULTS.session);
});

test('the committed config reads a string session.handoff as its mode too', (t) => {
  const dir = project(t, { version: 1, session: { handoff: 'off' } }).root;
  // HOME is the fixture, so no global git config, such as commit signing, applies; GIT_DIR stays unset.
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir } });
  git('init', '-q');
  git('add', '.aidrian/config.json');
  assert.equal(git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'config').status, 0);
  assert.deepEqual(committedConfig(findProject(dir), 'HEAD').session.handoff, { ...DEFAULTS.session.handoff, mode: 'off' });
});

test('quorum.product: automatic start is off, approval comes first, and three runs is the cap, by default', (t) => {
  const { autoStart, approval, maxAutoRuns } = DEFAULTS.quorum.product;
  assert.deepEqual([autoStart, approval, maxAutoRuns], [false, 'first', 3]);
  const product = { autoStart: true, approval: 'review-later', maxAutoRuns: 10 };
  const { config, errors } = loadConfig(project(t, { version: 1, quorum: { product } }));
  assert.deepEqual(errors, []);
  assert.deepEqual(config.quorum.product, { ...DEFAULTS.quorum.product, ...product });
  assert.deepEqual(loadConfig(project(t, { version: 1, quorum: { product: { maxAutoRuns: 1 } } })).errors, []);
});

test('quorum.product: a value outside its range is an error, and keeps the default', (t) => {
  for (const [key, value, message] of [
    ['autoStart', 'yes', /"quorum\.product\.autoStart" must be true or false$/u],
    ['approval', 'later', /"quorum\.product\.approval" must be "first" or "review-later"$/u],
    ['approval', 'always', /"quorum\.product\.approval" must be "first" or "review-later"$/u],
    ['maxAutoRuns', 0, /"quorum\.product\.maxAutoRuns" must be a whole number from 1 to 10$/u],
    ['maxAutoRuns', 11, /"quorum\.product\.maxAutoRuns" must be a whole number from 1 to 10$/u],
    ['maxAutoRuns', 2.5, /"quorum\.product\.maxAutoRuns" must be a whole number from 1 to 10$/u],
  ]) {
    const { config, errors } = loadConfig(project(t, { version: 1, quorum: { product: { [key]: value } } }));
    assert.match(errors.join('\n'), message, `${key}: ${value}`);
    assert.equal(config.quorum.product[key], DEFAULTS.quorum.product[key], `${key}: ${value}`);
  }
});

test('docs/config.md shows the quorum defaults as DEFAULTS holds them', () => {
  const doc = readFileSync(path.join(ROOT, 'docs/config.md'), 'utf8');
  const example = JSON.parse(doc.match(/## Keys[\s\S]*?```json\n([\s\S]*?)```/)[1]);
  assert.deepEqual(example.quorum, DEFAULTS.quorum);
});

test('committedQuorumProduct reads the commit\'s block, and is off for a commit no one can read as the team meant it', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.aidrian'));
  const git = (...args) => {
    const out = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout.trim();
  };
  git('init', '-q');
  const at = (config) => {
    writeFileSync(path.join(dir, '.aidrian/config.json'), typeof config === 'string' ? config : JSON.stringify(config));
    git('add', '.');
    git('commit', '-q', '--allow-empty', '-m', 'config');
    const known = findProject(dir);
    return committedQuorumProduct(known, 'HEAD', committedConfigFile(known, 'HEAD'));
  };
  const on = { autoStart: true, approval: 'review-later', maxAutoRuns: 2 };
  assert.deepEqual(at({ version: 1, quorum: { product: on } }), { ...DEFAULTS.quorum.product, ...on });
  const off = DEFAULTS.quorum.product;
  assert.deepEqual(at({ version: 1 }), off, 'a config with no block takes the defaults');
  assert.deepEqual(at('{ not json'), off, 'text that does not parse');
  assert.deepEqual(at({ version: 99, quorum: { product: on } }), off, 'another version');
  assert.deepEqual(at({ version: 1, quorum: { product: { ...on, approval: 'later' } } }), off, 'an error beside autoStart true');
  assert.deepEqual(at({ version: 1, quorum: { product: { ...on, extra: 1 } } }), off, 'an unknown key');
  assert.deepEqual(at({ version: 1, quorum: { product: 'on' } }), off, 'a block that is no object');
  assert.deepEqual(at({ version: 1, quorum: 'on' }), off, 'a group that is no object');
  assert.deepEqual(at({ version: 1, quorum: { product: on, plan: { maxDispatches: 1 } } }), { ...DEFAULTS.quorum.product, ...on }, 'an error elsewhere in quorum leaves this block readable');
  assert.deepEqual(committedQuorumProduct(findProject(dir), 'HEAD', null), off, 'no config file named');
});

test('the committed decisions of a project below the repository root are its own file\'s, not the ask-only block', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const below = path.join(dir, 'apps/web');
  mkdirSync(path.join(below, '.aidrian'), { recursive: true });
  writeFileSync(path.join(below, '.aidrian/config.json'), JSON.stringify({ version: 1, decisions: { maxMode: 'decide-reversible', escalate: ['copy'] } }));
  const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('add', '.');
  assert.equal(git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'config').status, 0);
  const at = findProject(below);
  const decisions = committedDecisions(at, 'HEAD', committedConfigFile(at, 'HEAD'));
  assert.equal(decisions.maxMode, 'decide-reversible');
  assert.deepEqual(decisions.escalate, ['copy']);
});

test('decisions.classes and decisions.unattended: the team sets them, the local file cannot, and an escalate entry may name a project class', (t) => {
  assert.deepEqual([DEFAULTS.decisions.classes, DEFAULTS.decisions.unattended], [{}, { safeDefaults: 'outside-escalated' }]);
  const classes = { 'pricing-page': 'the words of the pricing page' };
  const team = project(t, { version: 1, decisions: { classes, escalate: ['pricing-page', 'copy'], unattended: { safeDefaults: 'all' } } });
  const read = loadConfig(team);
  assert.deepEqual(read.errors, []);
  assert.deepEqual([read.config.decisions.classes, read.config.decisions.escalate, read.config.decisions.unattended], [classes, ['pricing-page', 'copy'], { safeDefaults: 'all' }]);
  writeFileSync(path.join(team.root, '.aidrian.local.json'), JSON.stringify({ decisions: { classes: { mine: 'x' }, unattended: { safeDefaults: 'outside-escalated' } } }));
  const local = loadConfig(findProject(team.root));
  assert.deepEqual(local.errors, [
    '.aidrian.local.json: "decisions.classes" is the team\'s: set it in config.json',
    '.aidrian.local.json: "decisions.unattended" is the team\'s: set it in config.json',
  ]);
  assert.deepEqual([local.config.decisions.classes, local.config.decisions.unattended], [classes, { safeDefaults: 'all' }]);

  const bad = project(t, { version: 1, decisions: { classes: { pricing: 'x', copy: 'y' }, escalate: ['pricing'] } });
  assert.deepEqual(loadConfig(bad).errors.map((error) => error.split(' must ')[0]), ['.aidrian/config.json: "decisions.classes"', '.aidrian/config.json: "decisions.escalate"'], 'a bad block adds no class');
});

test('a base commit with a block no one can read keeps its classes and safe defaults from nobody: nothing added, and every ask parks', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-config-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, decisions: { classes: { copy: 'redefined' }, unattended: { safeDefaults: 'all' } } }));
  const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('add', '.');
  assert.equal(git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'config').status, 0);
  const at = findProject(dir);
  const block = committedDecisions(at, 'HEAD', committedConfigFile(at, 'HEAD'));
  assert.deepEqual([block.maxMode, block.classes, block.unattended], ['ask', {}, { safeDefaults: null }]);
  assert.deepEqual(committedDecisions(at, 'HEAD', null).unattended, { safeDefaults: null });
});

test('the loaded config is frozen all the way down', (t) => {
  const { config } = loadConfig(project(t, { version: 1, git: { mainCheckout: { allowWrites: ['notes/**'] } } }));
  assert.throws(() => { config.git.defaultBranch = 'x'; }, TypeError);
  assert.throws(() => { config.github.reviewer = 'x'; }, TypeError);
  assert.throws(() => config.git.mainCheckout.allowWrites.push('x'), TypeError);
  assert.throws(() => config.git.commits.types.push('x'), TypeError);
});

const ESCALATE_DOCS = /"decisions\.escalateDocs" must be a list of paths from the project root, each a file, a "file#section", or a folder such as "docs\/legal\/" for everything in it; no glob characters, absolute path, or "\.\."$/;

// Each case expects exactly one error, and the default in place of the bad value.
const errorCases = [
  ['unknown top-level key', { version: 1, extra: 1 }, /: unknown key "extra"$/],
  ['the old "pr" group, now "github"', { version: 1, pr: { reviewer: 'x' } }, /: "pr" is now "github": rename the key$/],
  ['the old "docs.alwaysBudgetBytes", now in "knowledge.budgets"', { version: 1, docs: { alwaysBudgetBytes: 1 } }, /: "docs\.alwaysBudgetBytes" is now "knowledge\.budgets\.alwaysBytes": rename the key$/],
  ['unknown key in a group', { version: 1, github: { reviewers: 'x' } }, /: unknown key "github\.reviewers"$/],
  ['zero for a knowledge budget', { version: 1, knowledge: { budgets: { taggedDocBytes: 0 } } }, /"knowledge\.budgets\.taggedDocBytes" must be a whole number above 0$/],
  ['inherited property name as a key', JSON.parse('{"version": 1, "__proto__": {}}'), /: unknown key "__proto__"$/],
  ['string instead of a list', { version: 1, git: { commits: { types: 'feat' } } }, /"git\.commits\.types" must be a non-empty list of non-empty strings$/],
  ['check names that are not a list', { version: 1, github: { conditionalChecks: 'db tests' } }, /"github\.conditionalChecks" must be a list of non-empty strings$/],
  ['group that is not an object', { version: 1, github: [] }, /"github" must be an object$/],
  ['negative number', { version: 1, docs: { wrapLimit: -1 } }, /"docs\.wrapLimit" must be a whole number, 0 or more$/],
  ['zero where a positive number is needed', { version: 1, github: { maxReviewRounds: 0 } }, /"github\.maxReviewRounds" must be a whole number above 0$/],
  ['extra rounds mode outside its list', { version: 1, github: { extraRounds: 'always' } }, /"github\.extraRounds" must be "off", "ask", or "auto"$/],
  ['a negative extra rounds ceiling', { version: 1, github: { maxExtraRounds: -1 } }, /"github\.maxExtraRounds" must be a whole number, 0 or more$/],
  ['a fractional extra rounds ceiling', { version: 1, github: { maxExtraRounds: 1.5 } }, /"github\.maxExtraRounds" must be a whole number, 0 or more$/],
  ['string for a boolean', { version: 1, git: { mainCheckout: { guard: 'no' } } }, /"git\.mainCheckout\.guard" must be true or false$/],
  ['empty string', { version: 1, git: { defaultBranch: ' ' } }, /"git\.defaultBranch" must be a non-empty string$/],
  ['handoff mode outside its list', { version: 1, session: { handoff: { mode: 'always' } } }, /"session\.handoff\.mode" must be "off", "ask", or "auto"$/],
  ['a string handoff that is no mode', { version: 1, session: { handoff: 'always' } }, /"session\.handoff" must be an object$/],
  ['the old string handoff, now "session.handoff.mode"', { version: 1, session: { handoff: 'ask' } }, /: "session\.handoff" is now "session\.handoff\.mode": move it$/],
  ['the old "session.maxTokens", now in "session.handoff"', { version: 1, session: { maxTokens: 150000 } }, /: "session\.maxTokens" is now "session\.handoff\.maxTokens": rename the key$/],
  ['the old "session.maxCalls", gone', { version: 1, session: { maxCalls: 250 } }, /: "session\.maxCalls" is gone: the session-length reminder weighs cost, not calls; delete the key$/],
  ['the old "session.maxHours", gone', { version: 1, session: { maxHours: 4 } }, /: "session\.maxHours" is gone: the session-length reminder weighs cost, not hours; delete the key$/],
  ['a cost ratio a hair above 1', { version: 1, session: { handoff: { costRatio: 1.0000000000000002 } } }, /"session\.handoff\.costRatio" must be a number of 1\.1 or more$/],
  ['a cost ratio of 1', { version: 1, session: { handoff: { costRatio: 1 } } }, /"session\.handoff\.costRatio" must be a number of 1\.1 or more$/],
  ['a cost ratio below 1', { version: 1, session: { handoff: { costRatio: 0.5 } } }, /"session\.handoff\.costRatio" must be a number of 1\.1 or more$/],
  ['a cost ratio as a string', { version: 1, session: { handoff: { costRatio: '2' } } }, /"session\.handoff\.costRatio" must be a number of 1\.1 or more$/],
  ['a fractional token ceiling', { version: 1, session: { handoff: { maxTokens: 1.5 } } }, /"session\.handoff\.maxTokens" must be a whole number, 0 or more$/],
  ['review record outside its list', { version: 1, review: { record: 'pr' } }, /"review\.record" must be "comment" or "local"$/],
  ['review engine that is not a name', { version: 1, review: { engine: 'two words' } }, /"review\.engine" must be "auto", "codex-local", "pr-bot", "self", or a reviewer of review\.reviewers$/],
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
  ['an override percent above 100', { version: 1, telemetry: { health: { decisionOverridePercent: 120 } } }, /"telemetry\.health\.decisionOverridePercent" must be a whole number from 1 to 100$/],
  ['a decision sample of 0', { version: 1, telemetry: { health: { decisionMinSample: 0 } } }, /"telemetry\.health\.decisionMinSample" must be a whole number above 0$/],
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
  ['an empty list of commit types', { version: 1, git: { commits: { types: [] } } }, /"git\.commits\.types" must be a non-empty list of non-empty strings$/],
  ['quorum that is not an object', { version: 1, quorum: 'codex' }, /"quorum" must be an object$/],
  ['an unknown quorum key', { version: 1, quorum: { plan: { c: { agent: 'architect' } } } }, /: unknown key "quorum\.plan\.c"$/],
  ['a decide position cap, which nothing reads', { version: 1, quorum: { decide: { maxPositions: 3 } } }, /: unknown key "quorum\.decide\.maxPositions"$/],
  // Plan adversary A has no Codex path: its briefs read the ledger, and `quorum codex --mode rebut` answers only B.
  ['a provider on plan adversary A', { version: 1, quorum: { plan: { a: { provider: 'codex' } } } }, /: unknown key "quorum\.plan\.a\.provider"$/],
  ['a provider other than agent or codex', { version: 1, quorum: { plan: { b: { provider: 'Codex' } } } }, /"quorum\.plan\.b\.provider" must be "agent" or "codex"$/],
  ['a decide provider other than agent or codex', { version: 1, quorum: { decide: { odd: { provider: 'claude' } } } }, /"quorum\.decide\.odd\.provider" must be "agent" or "codex"$/],
  ['no objections per adversary', { version: 1, quorum: { plan: { maxObjections: 0 } } }, /"quorum\.plan\.maxObjections" must be a whole number from 1 to 5$/],
  ['more objections than the ledger holds', { version: 1, quorum: { plan: { maxObjections: 6 } } }, /"quorum\.plan\.maxObjections" must be a whole number from 1 to 5$/],
  ['a fractional objection cap', { version: 1, quorum: { plan: { maxObjections: 2.5 } } }, /"quorum\.plan\.maxObjections" must be a whole number from 1 to 5$/],
  ['a dispatch cap with no room for the reserved pass', { version: 1, quorum: { plan: { maxDispatches: 4 } } }, /"quorum\.plan\.maxDispatches" must be a whole number, 5 or more$/],
  ['a fractional dispatch cap', { version: 1, quorum: { plan: { maxDispatches: 6.5 } } }, /"quorum\.plan\.maxDispatches" must be a whole number, 5 or more$/],
  ['a judge agent name with a space', { version: 1, quorum: { judge: { agent: 'the architect' } } }, /"quorum\.judge\.agent" must be an agent name such as code-reviewer$/],
  ['an agent name that is not text', { version: 1, quorum: { decide: { even: { agent: 3 } } } }, /"quorum\.decide\.even\.agent" must be an agent name such as code-reviewer$/],
  ['"*", which names every agent, as a quorum agent', { version: 1, quorum: { plan: { a: { agent: '*' } } } }, /"quorum\.plan\.a\.agent" must be an agent name such as code-reviewer$/],
  ['"main", the main session\'s gate selector, as a quorum agent', { version: 1, quorum: { judge: { agent: 'main' } } }, /"quorum\.judge\.agent" must be an agent name such as code-reviewer$/],
  ['a swap switch that is not a boolean', { version: 1, quorum: { decide: { swap: 'yes' } } }, /"quorum\.decide\.swap" must be true or false$/],
  ['decisions that is not an object', { version: 1, decisions: 'ask' }, /"decisions" must be an object$/],
  ['an unknown decisions key', { version: 1, decisions: { authority: 'ask' } }, /: unknown key "decisions\.authority"$/],
  ['a decisions mode outside its list', { version: 1, decisions: { mode: 'decide' } }, /"decisions\.mode" must be "ask" or "decide-reversible"$/],
  ['"inherit" as the mode, which has nothing to inherit', { version: 1, decisions: { mode: 'inherit' } }, /"decisions\.mode" must be "ask" or "decide-reversible"$/],
  ['a decisions ceiling outside its list', { version: 1, decisions: { maxMode: 'always' } }, /"decisions\.maxMode" must be "ask" or "decide-reversible"$/],
  ['an unknown domain', { version: 1, decisions: { domains: { finance: 'ask' } } }, /: unknown key "decisions\.domains\.finance"$/],
  ['a domain mode outside its list', { version: 1, decisions: { domains: { ux: 'decide' } } }, /"decisions\.domains\.ux" must be "ask", "decide-reversible", or "inherit"$/],
  ['a project class that redefines a built-in', { version: 1, decisions: { classes: { copy: 'our own copy' } } }, /"decisions\.classes" must be an object of new class names/],
  ['a project class that takes a floor class', { version: 1, decisions: { classes: { money: 'not money here' } } }, /"decisions\.classes" must be an object of new class names/],
  ['a project class that removes a floor class', { version: 1, decisions: { classes: { security: null } } }, /"decisions\.classes" must be an object of new class names/],
  ['a project class with a space', { version: 1, decisions: { classes: { 'pricing page': 'x' } } }, /"decisions\.classes" must be an object of new class names/],
  ['a project class too long for a marker', { version: 1, decisions: { classes: { [`a${'b'.repeat(23)}`]: 'x' } } }, /"decisions\.classes" must be an object of new class names, each lowercase letters, digits, and "-", at most 23 characters/],
  ['a project class on two lines', { version: 1, decisions: { classes: { pricing: 'one\ntwo' } } }, /"decisions\.classes" must be an object of new class names/],
  ['a project class with no definition', { version: 1, decisions: { classes: { pricing: '' } } }, /"decisions\.classes" must be an object of new class names/],
  ['classes that are a list', { version: 1, decisions: { classes: ['pricing'] } }, /"decisions\.classes" must be an object of new class names/],
  ['an unknown unattended mode', { version: 1, decisions: { unattended: { safeDefaults: 'every' } } }, /"decisions\.unattended\.safeDefaults" must be "outside-escalated" or "all"$/],
  ['an unknown unattended key', { version: 1, decisions: { unattended: { other: 1 } } }, /unknown key "decisions\.unattended\.other"$/],
  ['an escalate class not in decisions.json', { version: 1, decisions: { escalate: ['pricing'] } }, /"decisions\.escalate" must be a list of decision classes/],
  ['escalate docs that are not a list', { version: 1, decisions: { escalateDocs: 'docs/a.md' } }, ESCALATE_DOCS],
  ['a glob in escalate docs', { version: 1, decisions: { escalateDocs: ['docs/**/*.md'] } }, ESCALATE_DOCS],
  ['a question mark in escalate docs', { version: 1, decisions: { escalateDocs: ['docs/a?.md'] } }, ESCALATE_DOCS],
  ['a character class in escalate docs', { version: 1, decisions: { escalateDocs: ['docs/[ab].md'] } }, ESCALATE_DOCS],
  ['braces in escalate docs', { version: 1, decisions: { escalateDocs: ['docs/{a,b}.md'] } }, ESCALATE_DOCS],
  ['an absolute escalate doc', { version: 1, decisions: { escalateDocs: ['/etc/hosts'] } }, ESCALATE_DOCS],
  ['a home path in escalate docs', { version: 1, decisions: { escalateDocs: ['~/notes.md'] } }, ESCALATE_DOCS],
  ['a parent path in escalate docs', { version: 1, decisions: { escalateDocs: ['../other.md'] } }, ESCALATE_DOCS],
  ['a parent path inside an escalate doc', { version: 1, decisions: { escalateDocs: ['docs/../../other.md'] } }, ESCALATE_DOCS],
  ['the project root as an escalate doc', { version: 1, decisions: { escalateDocs: ['./'] } }, ESCALATE_DOCS],
  ['a section with no file in escalate docs', { version: 1, decisions: { escalateDocs: ['#refunds'] } }, ESCALATE_DOCS],
  ['a section on a folder in escalate docs', { version: 1, decisions: { escalateDocs: ['docs/#refunds'] } }, ESCALATE_DOCS],
  ['a second look with no severity', { version: 1, decisions: { secondLook: { agent: 'critic' } } }, /"decisions\.secondLook" must be null, or \{ "agent": an agent name, "minSeverity": "critical", "high", "medium", or "low" \}$/],
  ['a second look severity outside the disposition words', { version: 1, decisions: { secondLook: { agent: 'critic', minSeverity: 'blocker' } } }, /"decisions\.secondLook" must be null, or/],
  ['a second look that names no one agent', { version: 1, decisions: { secondLook: { agent: '*', minSeverity: 'high' } } }, /"decisions\.secondLook" must be null, or/],
  ['a record queue outside its list', { version: 1, decisions: { record: { queue: 'issue' } } }, /"decisions\.record\.queue" must be "pr-body" or "report"$/],
  ['a remind mode outside its list', { version: 1, decisions: { unreviewed: { remind: 'always' } } }, /"decisions\.unreviewed\.remind" must be "session-start" or "off"$/],
  ['a pause with one limit', { version: 1, decisions: { unreviewed: { pauseDomainAt: { pending: 5 } } } }, /"decisions\.unreviewed\.pauseDomainAt" must be null, or \{ "pending", "oldestDays" \}, each a whole number above 0$/],
  ['a pause at zero', { version: 1, decisions: { unreviewed: { pauseDomainAt: { pending: 0, oldestDays: 7 } } } }, /"decisions\.unreviewed\.pauseDomainAt" must be null, or/],
];

for (const [name, value, expected] of errorCases) {
  test(`check fails: ${name}`, (t) => {
    const { config, errors, current } = loadConfig(project(t, value));
    assert.equal(errors.length, 1, errors.join('\n'));
    assert.match(errors[0], /^\.aidrian\/config\.json: /);
    assert.match(errors[0], expected);
    assert.equal(current, true);
    for (const key of ['git', 'github', 'docs', 'quorum', 'decisions']) assert.deepEqual(config[key], DEFAULTS[key], key);
  });
}

test('quorum: the defaults are today\'s roles and caps; plan adversary A holds only an agent, and decide has no position cap', () => {
  assert.deepEqual(DEFAULTS.quorum, {
    judge: { agent: 'architect' },
    plan: {
      a: { agent: 'code-reviewer' },
      b: { provider: 'codex', agent: 'product-manager' },
      maxObjections: 5,
      maxDispatches: 8,
    },
    decide: {
      odd: { provider: 'agent', agent: 'code-reviewer' },
      even: { provider: 'codex', agent: 'code-reviewer' },
      swap: true,
    },
    product: {
      owner: { agent: 'product-manager' },
      witness: { agent: 'ux-researcher' },
      ux: { agent: 'ux-specialist' },
      engineer: { agent: 'architect' },
      maxLoops: 2,
      autoStart: false,
      approval: 'first',
      maxAutoRuns: 3,
    },
  });
});

test('quorum: a project that sets only plan.b.provider keeps every other default', (t) => {
  const { config, errors } = loadConfig(project(t, { version: 1, quorum: { plan: { b: { provider: 'agent' } } } }));
  assert.deepEqual(errors, []);
  assert.deepEqual(config.quorum, {
    ...DEFAULTS.quorum,
    plan: { ...DEFAULTS.quorum.plan, b: { provider: 'agent', agent: 'product-manager' } },
  });
});

test('quorum: the edges of each range and a project agent name are accepted', (t) => {
  const quorum = {
    judge: { agent: 'acme:staff-architect' },
    plan: { a: { agent: 'security-reviewer' }, maxObjections: 1, maxDispatches: 5 },
    decide: { odd: { provider: 'codex' }, even: { provider: 'agent', agent: 'product-manager' }, swap: false },
  };
  const { config, errors } = loadConfig(project(t, { version: 1, quorum }));
  assert.deepEqual(errors, []);
  assert.deepEqual(config.quorum, {
    judge: { agent: 'acme:staff-architect' },
    plan: { ...DEFAULTS.quorum.plan, a: { agent: 'security-reviewer' }, maxObjections: 1, maxDispatches: 5 },
    decide: { odd: { provider: 'codex', agent: 'code-reviewer' }, even: { provider: 'agent', agent: 'product-manager' }, swap: false },
    product: DEFAULTS.quorum.product,
  });
  assert.deepEqual(loadConfig(project(t, { version: 1, quorum: { plan: { maxObjections: 5, maxDispatches: 40 } } })).errors, []);
});

test('decisions: every decision goes to the Human by default, and docs/config.md shows the defaults as DEFAULTS holds them', () => {
  assert.deepEqual(DEFAULTS.decisions, {
    mode: 'ask',
    maxMode: 'ask',
    domains: { product: 'inherit', ux: 'inherit', architecture: 'inherit', backlog: 'inherit' },
    classes: {},
    escalate: [],
    escalateDocs: [],
    unattended: { safeDefaults: 'outside-escalated' },
    secondLook: { agent: 'critic', minSeverity: 'high' },
    record: { queue: 'pr-body' },
    unreviewed: { remind: 'session-start', pauseDomainAt: { pending: 10, oldestDays: 7 } },
  });
  const doc = readFileSync(path.join(ROOT, 'docs/config.md'), 'utf8');
  const example = JSON.parse(doc.match(/## Keys[\s\S]*?```json\n([\s\S]*?)```/)[1]);
  assert.deepEqual(example.decisions, DEFAULTS.decisions);
  assert.deepEqual(example.telemetry.health, DEFAULTS.telemetry.health);
});

test('decisions: a project sets any subset, and null turns the second look and the pause off', (t) => {
  const decisions = { mode: 'decide-reversible', domains: { ux: 'ask' }, escalate: ['copy'], secondLook: null, unreviewed: { pauseDomainAt: null } };
  const { config, errors } = loadConfig(project(t, { version: 1, decisions }));
  assert.deepEqual(errors, []);
  assert.deepEqual(config.decisions, {
    ...DEFAULTS.decisions,
    mode: 'decide-reversible',
    domains: { ...DEFAULTS.decisions.domains, ux: 'ask' },
    escalate: ['copy'],
    secondLook: null,
    unreviewed: { remind: 'session-start', pauseDomainAt: null },
  });
});

test('decisions: the local file sets mode and domains up to the team ceiling, and an out-of-range value keeps the one below it', (t) => {
  const team = project(t, { version: 1, decisions: { maxMode: 'ask', domains: { product: 'ask' } } });
  const local = path.join(team.root, '.aidrian.local.json');
  writeFileSync(local, JSON.stringify({ decisions: { mode: 'decide-reversible', domains: { ux: 'decide-reversible', backlog: 'inherit' } } }));
  const capped = loadConfig(findProject(team.root));
  assert.deepEqual(capped.errors, [], 'a value above the ceiling is held to it, not refused');
  assert.equal(capped.config.decisions.mode, 'ask');
  assert.deepEqual(capped.config.decisions.domains, { product: 'ask', ux: 'ask', architecture: 'inherit', backlog: 'inherit' });

  const unset = project(t, { version: 1 });
  writeFileSync(path.join(unset.root, '.aidrian.local.json'), JSON.stringify({ decisions: { mode: 'decide-reversible', domains: { ux: 'decide-reversible' } } }));
  const defaultCeiling = loadConfig(findProject(unset.root));
  assert.deepEqual(defaultCeiling.errors, []);
  assert.equal(defaultCeiling.config.decisions.mode, 'ask', 'a team that set no ceiling has not opted in');
  assert.equal(defaultCeiling.config.decisions.domains.ux, 'ask');

  const raised = project(t, { version: 1, decisions: { maxMode: 'decide-reversible' } });
  writeFileSync(path.join(raised.root, '.aidrian.local.json'), JSON.stringify({ decisions: { mode: 'decide-reversible', domains: { ux: 'ask' } } }));
  const within = loadConfig(findProject(raised.root)).config.decisions;
  assert.equal(within.mode, 'decide-reversible', 'the team ceiling allows it');
  assert.equal(within.domains.ux, 'ask');

  writeFileSync(local, JSON.stringify({ decisions: { mode: 'always' } }));
  const bad = loadConfig(findProject(team.root));
  assert.deepEqual(bad.errors, ['.aidrian.local.json: "decisions.mode" must be "ask" or "decide-reversible"']);
  assert.equal(bad.config.decisions.mode, 'ask');
  writeFileSync(local, JSON.stringify({ decisions: true }));
  assert.deepEqual(loadConfig(findProject(team.root)).errors, ['.aidrian.local.json: "decisions" must be an object']);
});

test('decisions: the local file caps only the keys it sets, so a team value above maxMode stays as written', (t) => {
  const team = project(t, { version: 1, decisions: { maxMode: 'ask', mode: 'decide-reversible', domains: { ux: 'decide-reversible' } } });
  const read = (local) => {
    writeFileSync(path.join(team.root, '.aidrian.local.json'), JSON.stringify({ decisions: local }));
    return loadConfig(findProject(team.root));
  };
  const other = read({ unreviewed: { remind: 'off' } }).config.decisions;
  assert.equal(other.mode, 'decide-reversible', 'the local file does not set mode');
  assert.equal(other.domains.ux, 'decide-reversible', 'the local file does not set domains.ux');
  const some = read({ mode: 'decide-reversible', domains: { product: 'decide-reversible' } }).config.decisions;
  assert.equal(some.mode, 'ask', 'the local file sets mode');
  assert.equal(some.domains.product, 'ask', 'the local file sets domains.product');
  assert.equal(some.domains.ux, 'decide-reversible', 'the local file does not set domains.ux');
  const bad = read({ mode: 'always', domains: { ux: 'always' } });
  assert.equal(bad.errors.length, 2);
  assert.equal(bad.config.decisions.mode, 'decide-reversible', 'a refused local value sets nothing');
  assert.equal(bad.config.decisions.domains.ux, 'decide-reversible', 'a refused local value sets nothing');
});

test('decisions: the local file names no team key, and unknown local keys are errors, each keeping the team value', (t) => {
  const team = project(t, { version: 1, decisions: { maxMode: 'ask', escalate: ['copy'] } });
  writeFileSync(path.join(team.root, '.aidrian.local.json'), JSON.stringify({
    decisions: { maxMode: 'decide-reversible', escalate: [], escalateDocs: [], secondLook: null, record: { queue: 'report' }, other: 1 },
  }));
  const { config, errors } = loadConfig(findProject(team.root));
  assert.deepEqual(errors, [
    '.aidrian.local.json: "decisions.maxMode" is the team\'s: set it in config.json',
    '.aidrian.local.json: "decisions.escalate" is the team\'s: set it in config.json',
    '.aidrian.local.json: "decisions.escalateDocs" is the team\'s: set it in config.json',
    '.aidrian.local.json: "decisions.secondLook" is the team\'s: set it in config.json',
    '.aidrian.local.json: "decisions.record" is the team\'s: set it in config.json',
    '.aidrian.local.json: unknown key "decisions.other"',
  ]);
  assert.equal(config.decisions.maxMode, 'ask');
  assert.deepEqual(config.decisions.escalate, ['copy']);
  assert.deepEqual(config.decisions.secondLook, DEFAULTS.decisions.secondLook);
  assert.deepEqual(config.decisions.record, DEFAULTS.decisions.record);

  writeFileSync(path.join(team.root, '.aidrian.local.json'), '{"decisions": {"__proto__": {"mode": "decide-reversible"}}}');
  const inherited = loadConfig(findProject(team.root));
  assert.deepEqual(inherited.errors, ['.aidrian.local.json: unknown key "decisions.__proto__"']);
  assert.equal(inherited.config.decisions.mode, 'ask');
});

test('decisions: remind is free in the local file; a pause applies only where it is lower than the team value', (t) => {
  const team = project(t, { version: 1, decisions: { unreviewed: { pauseDomainAt: { pending: 10, oldestDays: 7 } } } });
  const local = path.join(team.root, '.aidrian.local.json');
  const unreviewed = (value) => {
    writeFileSync(local, JSON.stringify({ decisions: { unreviewed: value } }));
    const { config, errors } = loadConfig(findProject(team.root));
    assert.deepEqual(errors, []);
    return config.decisions.unreviewed;
  };
  assert.equal(unreviewed({ remind: 'off' }).remind, 'off');
  assert.deepEqual(unreviewed({ pauseDomainAt: { pending: 3, oldestDays: 2 } }).pauseDomainAt, { pending: 3, oldestDays: 2 });
  assert.deepEqual(unreviewed({ pauseDomainAt: { pending: 50, oldestDays: 90 } }).pauseDomainAt, { pending: 10, oldestDays: 7 }, 'above the team value: ignored');
  assert.deepEqual(unreviewed({ pauseDomainAt: { pending: 3, oldestDays: 90 } }).pauseDomainAt, { pending: 3, oldestDays: 7 }, 'one limit at a time');
  assert.deepEqual(unreviewed({ pauseDomainAt: null }).pauseDomainAt, { pending: 10, oldestDays: 7 }, 'null is no pause, so it raises the limit: ignored');

  const off = project(t, { version: 1, decisions: { unreviewed: { pauseDomainAt: null } } });
  writeFileSync(path.join(off.root, '.aidrian.local.json'), JSON.stringify({ decisions: { unreviewed: { pauseDomainAt: { pending: 5, oldestDays: 5 } } } }));
  assert.deepEqual(loadConfig(findProject(off.root)).config.decisions.unreviewed.pauseDomainAt, { pending: 5, oldestDays: 5 }, 'any limit is lower than none');
});

test('docs/config.md names the floor classes and the four questions as decisions.json holds them', () => {
  const { classes, reversibility } = loadVocab();
  const section = readFileSync(path.join(ROOT, 'docs/config.md'), 'utf8').match(/^## Decisions\n([\s\S]*?)^## /mu)[1];
  const named = (start) => [...section.split('\n').find((line) => line.includes(start)).matchAll(/`([^`]+)`/gu)].map((match) => match[1]);
  assert.deepEqual(named('A floor class'), classes.filter((each) => each.floor).map((each) => each.class));
  assert.deepEqual(named('The four answers'), Object.keys(reversibility));
});

test('decisions: escalateDocs takes files, sections, and folders from the project root', (t) => {
  const escalateDocs = ['docs/pricing.md', './docs/legal/', 'docs/terms.md#refunds', 'README.md'];
  const { config, errors } = loadConfig(project(t, { version: 1, decisions: { escalateDocs } }));
  assert.deepEqual(errors, []);
  assert.deepEqual(config.decisions.escalateDocs, escalateDocs);
});

// Errors that drop a deny list or a whole agents entry are gate errors, whatever their text; a bad allow pattern is not.
test('gateErrors lists the errors that drop a gate, and malformedGates reads only them', (t) => {
  const gateLoss = [
    { explorer: { Deny: ['Bash'] } },
    { 'Explorer!': { deny: ['Bash'] } },
    { explorer: { deny: 'Bash' } },
    { explorer: ['Bash'] },
    { explorer: { deny: ['Read(x)'] } },
  ];
  for (const agents of gateLoss) {
    const { errors, gateErrors } = loadConfig(project(t, { version: 1, agents }));
    assert.equal(gateErrors.length, 1, JSON.stringify(agents));
    assert.equal(`${gateErrors[0].file}: ${gateErrors[0].problem}`, errors[0]);
    assert.deepEqual(malformedGates(gateErrors), gateErrors[0]);
  }
  const { errors, gateErrors } = loadConfig(project(t, { version: 1, agents: { explorer: { allow: ['Read(x)'] } } }));
  assert.equal(errors.length, 1);
  assert.deepEqual(gateErrors, []);
  assert.equal(malformedGates(gateErrors), null);
});

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
  assert.deepEqual(loadConfig(team), { config: { ...DEFAULTS, names: { human: 'the team lead', ai: 'the agent' } }, errors: [], gateErrors: [], current: true });
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
    minSample: 5, redispatchPercent: 20, sentBackPercent: 10, topDocPercent: 50, reviewRounds: 3, lateFindingPercent: 50, denyHotSpot: 5, costRisePercent: 50, decisionOverridePercent: 20, decisionMinSample: 5,
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
  assert.deepEqual(loadConfig(team), { config: { ...DEFAULTS, agents }, errors: [], gateErrors: [], current: true });
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
  assert.deepEqual(DEFAULTS.git.worktrees, { dir: '.worktrees', bootstrap: null, disposable });
  assert.deepEqual(loadConfig(project(t, { version: 1, git: { worktrees: { bootstrap: null } } })).errors, []);
  const { config } = loadConfig(project(t, { version: 1, git: { worktrees: { dir: '../wt', bootstrap: 'npm ci', disposable: [] } } }));
  assert.deepEqual(config.git.worktrees, { dir: '../wt', bootstrap: 'npm ci', disposable: [] });
  assert.deepEqual(loadConfig(project(t, { version: 1, git: { worktrees: { dir: null } } })).errors, [
    '.aidrian/config.json: "git.worktrees.dir" must be a non-empty string',
  ]);
  for (const bad of [['packages/web/dist'], ['..'], 'node_modules', [' ']]) {
    const loaded = loadConfig(project(t, { version: 1, git: { worktrees: { disposable: bad } } }));
    assert.deepEqual(loaded.errors, ['.aidrian/config.json: "git.worktrees.disposable" must be a list of folder names with no "/", such as "node_modules"'], JSON.stringify(bad));
    assert.deepEqual(loaded.config.git.worktrees.disposable, disposable);
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
