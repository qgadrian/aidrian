import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { after } from 'node:test';

import { gateDenial } from '../plugins/aidrian/lib/agent-gates.mjs';
import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { configWriteDenial, WRITE_TARGETS } from '../plugins/aidrian/lib/config-guard.mjs';
import { findProject } from '../plugins/aidrian/lib/project.mjs';
import { isolate } from '../plugins/aidrian/lib/review/env.mjs';

// The hooks this file runs record their blocks in the state folder; keep those rows out of the real one.
process.env.XDG_STATE_HOME = mkdtempSync(path.join(tmpdir(), 'aidrian-state-'));
after(() => rmSync(process.env.XDG_STATE_HOME, { recursive: true, force: true }));

const HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-agent-gates.mjs');
const GATED = { version: 1, agents: { explorer: { deny: ['WebFetch'] } } };
// The host stops a hook at 5 seconds and runs the call with no guard; these calls must answer well before.
const HOST_TIMEOUT = 5000;
const WELL_INSIDE = 4000;

// A project with `config` and the local file, in a folder named `webapp` as a checkout often is.
function project(t, config = GATED) {
  const parent = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-budget-')));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const dir = path.join(parent, 'webapp');
  mkdirSync(path.join(dir, '.aidrian/knowledge'), { recursive: true });
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify(config));
  writeFileSync(path.join(dir, '.aidrian.local.json'), '{}');
  return dir;
}

const subagent = (cwd, tool, command) => ({ tool_name: tool, tool_input: { command }, agent_type: 'aidrian:explorer', agent_id: 'a5f0c1', cwd });
const main = ({ agent_id: _id, agent_type: _type, ...input }) => input;

function run(input, env = process.env) {
  const started = performance.now();
  const result = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), cwd: input.cwd, encoding: 'utf8', env, timeout: HOST_TIMEOUT });
  return { ...result, took: performance.now() - started };
}

function inTime(result, label) {
  assert.equal(result.signal, null, `${label}: stopped after ${Math.round(result.took)} ms`);
  assert.ok(result.took < WELL_INSIDE, `${label}: took ${Math.round(result.took)} ms`);
}

test('a chain of 1900 links in 20 words answers well inside the host timeout, for Bash and PowerShell', (t) => {
  const dir = project(t);
  symlinkSync('.', path.join(dir, 'l'));
  const words = Array.from({ length: 20 }, (_, i) => path.join(...Array(1900).fill('l'), `w${i}`));
  for (const [tool, command] of [['Bash', `rm ${words.join(' ')}`], ['PowerShell', `Remove-Item ${words.join(' ')}`]]) {
    inTime(run(subagent(dir, tool, command)), tool);
  }
});

test('globs in 255 letter cases of a folder of 3000 links answer well inside the host timeout', (t) => {
  const dir = project(t, { version: 1 });
  mkdirSync(path.join(dir, 'links'));
  for (let i = 0; i < 3000; i += 1) symlinkSync(`/nonexistent/${i}`, path.join(dir, 'links', `l${i}`));
  const cased = (i) => Array.from('links', (c, j) => ((i >> j) & 1 ? c.toUpperCase() : c)).join('');
  const globs = Array.from({ length: 255 }, (_, i) => `${cased(i % 32)}${'/.'.repeat(Math.floor(i / 32))}/x*`);
  inTime(run(subagent(dir, 'PowerShell', `Remove-Item ${globs.join(' ')}`)), 'PowerShell');
});

test('60 Bash(prefix) patterns read a 120 KB command once, so the gates answer in time', (t) => {
  const dir = project(t, { version: 1, agents: { main: { deny: Array.from({ length: 60 }, (_, i) => `Bash(tool${i} sub${i})`) } } });
  const command = Array.from({ length: 20000 }, () => 'true').join('; ');
  assert.ok(command.length > 119000);
  inTime(run(main(subagent(dir, 'Bash', command))), 'main session');
  // In process: 60 patterns cost about what one does, as the command is read once per call.
  const found = findProject(dir);
  const { config } = loadConfig(found);
  const timed = (count, suffix) => {
    const input = main(subagent(dir, 'Bash', `${command}; echo ${suffix}`));
    const started = performance.now();
    gateDenial(input, { ...config, agents: { main: { deny: config.agents.main.deny.slice(0, count) } } }, found.paths);
    return performance.now() - started;
  };
  timed(1, 'warm');
  const [one, sixty] = [timed(1, 'one'), timed(60, 'sixty')];
  assert.ok(sixty < one * 10, `60 patterns took ${Math.round(sixty)} ms, one took ${Math.round(one)} ms`);
});

test(`a subagent's Bash call that writes more than ${WRITE_TARGETS} targets is refused in time; the main session's runs`, (t) => {
  const dir = project(t);
  const command = Array.from({ length: 20000 }, (_, i) => `: > a${i}`).join('; ');
  const refused = run(subagent(dir, 'Bash', command));
  inTime(refused, 'subagent');
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, new RegExp(`its command writes 20000 targets, counting each folder a path may be in, and the guards read at most ${WRITE_TARGETS} in one call`, 'u'));
  const few = Array.from({ length: WRITE_TARGETS }, (_, i) => `: > a${i}`).join('; ');
  assert.equal(run(subagent(dir, 'Bash', few)).status, 0, 'as many as the guards read');
  assert.equal(run(main(subagent(dir, 'Bash', command))).status, 0, 'the main session may');
});

test('a guard past its time budget refuses a subagent\'s call and lets the main session\'s run', (t) => {
  const dir = project(t);
  const env = { ...process.env, AIDRIAN_GUARD_BUDGET_MS: '0' };
  for (const tool of ['Bash', 'PowerShell']) {
    const refused = run(subagent(dir, tool, 'echo x > src/app.js'), env);
    assert.equal(refused.status, 2, tool);
    assert.match(refused.stderr, /the guards could not finish reading this command in time, so it may change a file only the main session may change/u, tool);
    assert.equal(run(main(subagent(dir, tool, 'echo x > src/app.js')), env).status, 0, `${tool}: the main session`);
  }
  // The budget may only be lowered: a larger one keeps the hook's own.
  assert.equal(run(subagent(dir, 'Bash', 'echo x > src/app.js'), { ...process.env, AIDRIAN_GUARD_BUDGET_MS: '600000' }).status, 0);
});

test('AIDRIAN_GUARD_BUDGET_MS above the hook\'s own budget cannot raise it: a call still reading past 2.5 seconds is refused', (t) => {
  const dir = project(t);
  // A preload that holds the hook for 2.7 seconds before its guards start, so they run past the hook's 2.5 second budget.
  const slow = path.join(path.dirname(dir), 'slow.mjs');
  writeFileSync(slow, 'const end = performance.now() + 2700;\nwhile (performance.now() < end);\n');
  const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${pathToFileURL(slow).href}`.trim() };
  for (const raised of ['99999', '2501']) {
    const refused = run(subagent(dir, 'Bash', 'echo x > src/app.js'), { ...env, AIDRIAN_GUARD_BUDGET_MS: raised });
    assert.equal(refused.signal, null, `${raised}: stopped after ${Math.round(refused.took)} ms`);
    assert.equal(refused.status, 2, `${raised}: ${refused.stderr}`);
    assert.match(refused.stderr, /the guards could not finish reading this command in time/u, raised);
  }
});

test('isolate drops AIDRIAN_GUARD_BUDGET_MS, so a reviewer or a test never runs the guards on a lowered budget', () => {
  const env = isolate({ AIDRIAN_GUARD_BUDGET_MS: '0', PATH: '/usr/bin' });
  assert.equal(env.AIDRIAN_GUARD_BUDGET_MS, undefined);
  assert.equal(env.PATH, '/usr/bin', 'the rest stays');
});

test('a subagent\'s read-only PowerShell pipeline runs, and its writes by a glob are judged by three plain characters', (t) => {
  const dir = project(t);
  const open = project(t, { version: 1 });
  mkdirSync(path.join(open, 'src/shots'));
  for (const [cwd, command] of [
    [dir, 'Get-ChildItem *'],
    [dir, 'dir .*'],
    [dir, 'Get-ChildItem -Recurse -Filter *.json'],
    [dir, String.raw`Get-ChildItem ..\*`],
    [dir, "Get-ChildItem | Where-Object Name -like 'h*'"],
    [dir, 'Get-Process w*'],
    [dir, 'Get-Process h*'],
    [dir, 'Get-ChildItem s*'],
    [open, String.raw`Remove-Item src\w*`],
    [path.join(dir, 'src'), String.raw`Remove-Item src\w*`],
    [path.join(dir, 'src'), 'Remove-Item .c*'],
    [path.join(dir, 'src'), 'Remove-Item c*'],
  ]) {
    const result = run(subagent(cwd, 'PowerShell', command));
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
  }
  for (const [cwd, command] of [
    [dir, 'Get-ChildItem * | Remove-Item'],
    [dir, 'gci *; Remove-Item x'],
    [dir, 'gci $(Remove-Item -Recurse .aidrian)'],
    [path.join(dir, 'src'), 'Remove-Item -Recurse .con*'],
    [path.join(dir, 'src'), 'Remove-Item -Recurse han*'],
    [path.join(dir, 'src'), 'Remove-Item -Recurse .aid*'],
    [path.join(dir, 'src'), 'Remove-Item conf*'],
    // Aliases on Windows only: on another system each runs a program of that name, which is judged.
    [dir, 'write .aidrian/config.json'],
    [dir, 'gsv .aidrian/config.json'],
  ]) {
    assert.equal(run(subagent(cwd, 'PowerShell', command)).status, 2, command);
  }
});

test('a glob names the gate snapshot\'s folder only with the folder above it', (t) => {
  const dir = project(t);
  const sessions = path.join(process.env.XDG_STATE_HOME, 'aidrian/sessions');
  const also = [path.join(sessions, 's-1.json'), path.join(sessions, 's-1.gated')];
  const found = findProject(dir);
  const reasonOf = (command) => configWriteDenial(subagent(path.join(dir, 'src'), 'PowerShell', command), found, loadConfig(found).config, { also })?.reason ?? null;
  for (const command of ['Remove-Item -Recurse ses*', 'Remove-Item -Recurse s*']) assert.equal(reasonOf(command), null, command);
  for (const command of [String.raw`Remove-Item -Recurse aidrian\ses*`, String.raw`Remove-Item -Recurse sessions\*`]) {
    assert.match(reasonOf(command) ?? '', /may change \/.*\/aidrian\/sessions\/s-1\.(?:json|gated)/u, command);
  }
});

test('a subagent\'s PowerShell -Name:value word is read for its value', (t) => {
  const open = project(t, { version: 1 });
  const gated = project(t);
  for (const [cwd, command] of [[open, 'Set-Content -Path:.aidrian.local.js* -Value x'], [gated, 'Remove-Item -Recurse -Path:.aidr*'], [gated, 'Remove-Item -Recurse –Path:.aidr*']]) {
    assert.equal(run(subagent(cwd, 'PowerShell', command)).status, 2, command);
  }
});

test('a subagent\'s PowerShell glob with a wildcard before its last part is judged through the links below it', (t) => {
  const dir = project(t);
  mkdirSync(path.join(dir, 'src/a/x'), { recursive: true });
  symlinkSync('../../../.aidrian', path.join(dir, 'src/a/x/l'));
  for (const command of [String.raw`Set-Content -Path src\*\x\l\*.json -Value x`, String.raw`Remove-Item -Recurse src\*\x\*`]) {
    const result = run(subagent(dir, 'PowerShell', command));
    assert.equal(result.status, 2, command);
    assert.match(result.stderr, /may change \.aidrian\/config\.json/u, command);
  }
  mkdirSync(path.join(dir, 'dist/b'), { recursive: true });
  assert.equal(run(subagent(dir, 'PowerShell', String.raw`Remove-Item -Recurse dist\*\*`)).status, 0, 'no link below');
});

test('a PowerShell glob over a tree under the link budget runs, however many guarded files walk it, and a link in it is still refused', (t) => {
  const dir = project(t);
  // 2000 packages of 12 files: 26,000 entries, a quarter of the link budget, read once a call, not once a guarded file.
  for (let i = 0; i < 2000; i += 1) {
    const each = path.join(dir, 'node_modules', `p${i}`);
    mkdirSync(each, { recursive: true });
    for (let j = 0; j < 12; j += 1) writeFileSync(path.join(each, `f${j}.js`), '');
  }
  for (const command of [String.raw`Remove-Item -Recurse node_modules\*\dist`, String.raw`Remove-Item node_modules\*\*.map`]) {
    const result = run(subagent(dir, 'PowerShell', command));
    inTime(result, command);
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
  }
  symlinkSync('../../.aidrian', path.join(dir, 'node_modules/p1999/dist'));
  const refused = run(subagent(dir, 'PowerShell', String.raw`Remove-Item -Recurse node_modules\*\dist`));
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /may change \.aidrian\/config\.json/u);
});
