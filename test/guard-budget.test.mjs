import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { after } from 'node:test';

import { gateDenial } from '../plugins/aidrian/lib/agent-gates.mjs';
import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { configWriteDenial, WRITE_TARGETS } from '../plugins/aidrian/lib/config-guard.mjs';
import { foldCase, globParts } from '../plugins/aidrian/lib/fs.mjs';
import { findProject } from '../plugins/aidrian/lib/project.mjs';
import { isolate } from '../plugins/aidrian/lib/review/env.mjs';
import { dropPending, markDriver, markPending, markUnattended } from '../plugins/aidrian/lib/unattended-mark.mjs';
import { hookCall } from './hook-call.mjs';

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

// In the test's process. "In time" is a call's processor time, which a busy machine does not stretch as it stretches the
// wall clock. The main session's 20,000-target call runs first, on the real clock, so the guards' 2.5 second budget
// bounds it; the rest run with performance.now held still, so that budget cannot run out on a loaded machine and the
// limit is judged by the count alone.
test(`a subagent's Bash call that writes more than ${WRITE_TARGETS} targets is refused in time; the main session's runs in time`, async (t) => {
  const dir = project(t);
  const call = (input) => hookCall(HOOK, { input: JSON.stringify(input), cwd: input.cwd });
  const writes = (count) => Array.from({ length: count }, (_, i) => `: > a${i}`).join('; ');
  const timed = async (input) => {
    const before = process.cpuUsage();
    const result = await call(input);
    const { user, system } = process.cpuUsage(before);
    return { ...result, took: (user + system) / 1000 };
  };
  const ran = await timed(main(subagent(dir, 'Bash', writes(20000))));
  assert.equal(ran.status, 0, `the main session may: ${ran.stderr}`);
  assert.ok(ran.took < WELL_INSIDE, `main session: took ${Math.round(ran.took)} ms of processor time`);
  const held = performance.now();
  t.mock.method(performance, 'now', () => held);
  const refused = await timed(subagent(dir, 'Bash', writes(20000)));
  assert.ok(refused.took < WELL_INSIDE, `subagent: took ${Math.round(refused.took)} ms of processor time`);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, new RegExp(`its command writes 20000 targets, counting each folder a path may be in, and the guards read at most ${WRITE_TARGETS} in one call`, 'u'));
  assert.equal((await call(subagent(dir, 'Bash', writes(WRITE_TARGETS)))).status, 0, 'as many as the guards read');
  // One past the limit: refused for a subagent, run for the main session. With the clock held the guards read every
  // target a main session's call writes, so the 20,000-target call above runs before the clock is held.
  assert.equal((await call(subagent(dir, 'Bash', writes(WRITE_TARGETS + 1)))).status, 2, 'one past the limit');
  assert.equal((await call(main(subagent(dir, 'Bash', writes(WRITE_TARGETS + 1))))).status, 0, 'the main session may');
});

test('a guard past its time budget refuses a subagent\'s call and lets the main session\'s run', (t) => {
  const dir = project(t);
  const env = { ...process.env, AIDRIAN_GUARD_BUDGET_MS: '0' };
  for (const tool of ['Bash', 'PowerShell']) {
    const refused = run(subagent(dir, tool, 'echo x > src/app.js'), env);
    assert.equal(refused.status, 2, tool);
    assert.match(refused.stderr, /the guards could not finish reading this command in time, so it may change a file only the main session may change/u, tool);
    // One ordered recovery, with the Human told only at its end: a retry of the same call, shorter commands, the report.
    assert.match(refused.stderr, /tell the Human only after these steps, in order: a busy machine slows the guards, so 1\) retry this same call by itself, up to three times \(a retry is the same tool, not another one\); 2\) .*shorter commands; 3\) only when those are refused too, stop and report that the command takes the guards longer than they have\.$/mu,
      `${tool}: a busy machine's refusal asks for a retry first`);
    assert.equal(run(main(subagent(dir, tool, 'echo x > src/app.js')), env).status, 0, `${tool}: the main session`);
  }
  // A call that writes nothing, which no guard refuses, runs: a loaded machine never stalls a subagent on its reads.
  const read = run({ ...subagent(dir, 'Read', ''), tool_input: { file_path: path.join(dir, 'src', 'app.js') } }, env);
  assert.equal(read.status, 0, read.stderr);
  // The budget may only be lowered: a larger one keeps the hook's own.
  assert.equal(run(subagent(dir, 'Bash', 'echo x > src/app.js'), { ...process.env, AIDRIAN_GUARD_BUDGET_MS: '600000' }).status, 0);
});

test('AIDRIAN_GUARD_BUDGET_MS above the hook\'s own budget cannot raise it: a call still reading past 2.5 seconds is refused', (t) => {
  const dir = project(t);
  // A preload that holds the hook for 2.7 seconds before its guards start, so they run past the hook's 2.5 second budget.
  const slow = path.join(path.dirname(dir), 'slow.mjs');
  writeFileSync(slow, 'const end = performance.now() + 2700;\nwhile (performance.now() < end);\n');
  const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${pathToFileURL(slow).href}`.trim() };
  for (const raised of ['99999', '4000']) {
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

test('a PowerShell glob reaches a link below it through any letter case of its folder, alone or after another spelling', (t) => {
  const dir = project(t);
  const upper = path.join(path.dirname(dir), 'WEBAPP');
  if (!existsSync(upper)) {
    t.skip('this disk keeps letter cases apart, so WEBAPP is another folder');
    return;
  }
  mkdirSync(path.join(dir, 'node_modules/p1'), { recursive: true });
  symlinkSync('../../.aidrian', path.join(dir, 'node_modules/p1/dist'));
  // Each spelling resolves its own links: the second glob is not judged by the target the first one's spelling gave.
  const commands = [`Remove-Item -Recurse ${upper}/node_modules/*/dist ${dir}/node_modules/*/dist`];
  // One spelling alone: its link's target keeps that spelling's case, and is compared as the disk compares names.
  if (foldCase('A') === 'a') commands.push(`Remove-Item -Recurse ${upper}/node_modules/*/dist`, `Remove-Item -Recurse ${upper}/node_modules/p1/*`);
  for (const command of commands) {
    const result = run(subagent(dir, 'PowerShell', command));
    assert.equal(result.status, 2, `${command.replaceAll(path.dirname(dir), '<parent>')}: ${result.stderr}`);
    assert.match(result.stderr, /may change \.aidrian\/config\.json/u);
  }
});

test('the links in a PowerShell glob\'s first folder count once a call, however many guarded files are tested', (t) => {
  const dir = project(t);
  // 15,000 links that the glob does not match: read once, they fit the link budget; counted again for each guarded file
  // and each of its spellings, they would not.
  mkdirSync(path.join(dir, 'links'));
  for (let i = 0; i < 15000; i += 1) symlinkSync(`/nonexistent/${i}`, path.join(dir, 'links', `l${i}`));
  const result = run(subagent(dir, 'PowerShell', String.raw`Remove-Item links\x*`));
  inTime(result, 'PowerShell');
  assert.equal(result.status, 0, result.stderr);
});

test('a glob over a folder of many long names answers in time, and a write the guards refuse by its name is refused before any walk', (t) => {
  const dir = project(t);
  // 20,000 links with 240-character names, each a near miss for the glob: one test of a name against it takes
  // thousands of steps, so one pass over the folder outlasts the guards' budget, and several the host's timeout.
  const big = path.join(path.dirname(dir), 'big');
  mkdirSync(big);
  for (let i = 0; i < 20000; i += 1) symlinkSync(`/nonexistent/${i}`, path.join(big, `${String(i).padStart(5, '0')}${'a'.repeat(234)}b`));
  const glob = `${big}/*${'a'.repeat(120)}c*b`;
  for (const [tool, command] of [['Bash', `printf x | tee ${glob}`], ['PowerShell', `Remove-Item ${glob}`]]) {
    inTime(run(subagent(dir, tool, command)), tool);
  }
  for (const [command, reason] of [
    [`printf '{"github":{"autoMerge":"on"}}' > .aidrian.local.json; rm -f ${glob}`, /it sets github\.autoMerge in \.aidrian\.local\.json/u],
    [`printf '{}' > .aidrian/config.json; rm -f ${glob}`, /it changes \.aidrian\/config\.json/u],
  ]) {
    const refused = run(subagent(dir, 'Bash', command));
    inTime(refused, command.slice(0, 40));
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(refused.stderr, reason);
  }
});

test('globParts rejects at once a name that fails at its end or is shorter than the part, whatever the part\'s length', () => {
  const names = Array.from({ length: 20000 }, (_, i) => `${String(i).padStart(5, '0')}${'a'.repeat(235)}`);
  for (const part of [`*${'a'.repeat(120)}b`, `*${'a*'.repeat(5000)}`]) {
    const { pattern } = globParts(part, [], 'i');
    const started = performance.now();
    assert.equal(names.some((name) => pattern.test(name)), false, part.slice(0, 20));
    assert.ok(performance.now() - started < 500, `${part.slice(0, 20)}: took ${Math.round(performance.now() - started)} ms`);
  }
});

test('a session no Human attends is held as a subagent past the time budget and the guards\' limits, in its window too', (t) => {
  const dir = project(t);
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-budget-outside-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const marked = 'feed0006-0000-4000-8000-000000000006';
  const fresh = 'cafe0007-0000-4000-8000-000000000007';
  assert.ok(markUnattended(marked, { root: dir }));
  const pending = markPending('beef0008-0000-4000-8000-000000000008', { cwd: dir, root: dir });
  assert.ok(pending);
  t.after(() => dropPending(pending));
  const as = (session, input) => ({ ...main(input), session_id: session });
  const late = { ...process.env, AIDRIAN_GUARD_BUDGET_MS: '0' };
  const unattended = /only a main session a Human attends may change, and the background handoff route started this one, with no Human/u;
  for (const session of [marked, fresh]) {
    for (const tool of ['Bash', 'PowerShell']) {
      const refused = run(as(session, subagent(dir, tool, 'echo x > src/app.js')), late);
      assert.equal(refused.status, 2, `${session} ${tool}: past the budget`);
      assert.match(refused.stderr, /the guards could not finish reading this command in time/u);
      assert.match(refused.stderr, unattended);
    }
    const many = run(as(session, subagent(dir, 'Bash', Array.from({ length: 20000 }, (_, i) => `: > a${i}`).join('; '))));
    inTime(many, session);
    assert.equal(many.status, 2, `${session}: more write targets than the guards read`);
    assert.match(many.stderr, unattended);
    const words = run(as(session, subagent(dir, 'PowerShell', `Remove-Item ${Array.from({ length: 600 }, (_, i) => `w${i}`).join(' ')}`)));
    assert.equal(words.status, 2, `${session}: more words than the guards read`);
    assert.match(words.stderr, unattended);
  }
  // A project run's issue session is held the same, and its refusal says what it is, not that the handoff route started it.
  const issue = 'feed000b-0000-4000-8000-00000000000b';
  assert.ok(markUnattended(issue, { root: dir, cwd: dir, tags: { project: 'launch', issue: 'ENG-1' } }));
  for (const [what, ran] of [['past the budget', run(as(issue, subagent(dir, 'Bash', 'echo x > src/app.js')), late)], ['more words', run(as(issue, subagent(dir, 'PowerShell', `Remove-Item ${Array.from({ length: 600 }, (_, i) => `w${i}`).join(' ')}`)))]]) {
    assert.equal(ran.status, 2, `issue session ${what}`);
    assert.match(ran.stderr, /only a session a Human attends may change, and this session works an issue of a project run, which no Human attends/u, what);
    assert.doesNotMatch(ran.stderr, /background handoff route/u, what);
  }
  // Outside any project, a marked session past the budget is refused too.
  assert.equal(run(as(marked, subagent(outside, 'Bash', 'aidrian handoff continue b.md')), late).status, 2, 'outside a project');
  // Once the gate removed its pending mark, an attended main session keeps its calls past the budget.
  assert.ok(dropPending(pending));
  assert.equal(run(as('plain-session', subagent(dir, 'Bash', 'echo x > src/app.js')), late).status, 0, 'an attended session');
  assert.equal(run(as('plain-session', subagent(outside, 'Bash', 'aidrian handoff continue b.md')), late).status, 0, 'an attended session outside a project');
});

// Outside any project the guards hold the same sessions: a marked session whose mark names no project, and a run's
// driver whose run's main checkout is no project, are refused a command longer than the guards read and, past the
// budget, a write; a call that writes nothing runs for each, as it does for any session.
test('outside any project, a held session is refused a command longer than the guards read and a write past the budget', (t) => {
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-budget-outside-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const marked = 'feed0009-0000-4000-8000-000000000009';
  const driver = 'feed000a-0000-4000-8000-00000000000a';
  assert.ok(markUnattended(marked, { root: outside }));
  assert.ok(markDriver(driver, { run: 'launch', root: outside, state: path.join(outside, 'state') }));
  const as = (session, input) => ({ ...main(input), session_id: session });
  const late = { ...process.env, AIDRIAN_GUARD_BUDGET_MS: '0' };
  const words = `Remove-Item ${Array.from({ length: 600 }, (_, i) => `w${i}`).join(' ')}`;
  const long = run(as(marked, subagent(outside, 'PowerShell', words)));
  assert.equal(long.status, 2, long.stderr);
  assert.match(long.stderr, /the guards read at most 512 in a shell command they cannot parse, so it may change a file only a main session a Human attends may change, and the background handoff route started this one/u);
  assert.equal(run(as('plain-session', subagent(outside, 'PowerShell', words))).status, 0, 'an attended session');
  for (const [tool, input] of [['Bash', { command: 'echo x > a.txt' }], ['Write', { file_path: path.join(outside, 'a.txt'), content: 'x' }]]) {
    const refused = run({ ...as(driver, { cwd: outside }), tool_name: tool, tool_input: input }, late);
    assert.equal(refused.status, 2, `${tool}: ${refused.stderr}`);
    assert.match(refused.stderr, /the guards could not finish reading this command in time, so it may change a file only a main session a Human attends may change, and this session has driven a project run/u, tool);
    assert.equal(run({ ...as('plain-session', { cwd: outside }), tool_name: tool, tool_input: input }, late).status, 0, `${tool}: an attended session`);
  }
  // A call that writes nothing runs past the budget, for the driver, a marked session, and a subagent alike.
  for (const input of [as(driver, { cwd: outside }), as(marked, { cwd: outside }), subagent(outside, 'Read', '')]) {
    const read = run({ ...input, session_id: input.session_id ?? 'plain-session', tool_name: 'Read', tool_input: { file_path: path.join(outside, 'a.txt') } }, late);
    assert.equal(read.status, 0, `${input.session_id ?? 'subagent'}: ${read.stderr}`);
  }
});
