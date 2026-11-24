// projectRun.fullAuto: the team's standing consent for custody of a driver session the host continued under a new id.
// `aidrian project resume RUN --custody` (lib/project-run-gate.mjs resumeRun) and its hook rule
// (lib/project-run-guard.mjs), and the preflight's list of what still waits on a person (lib/project-full-auto.mjs).
// test/transcript-guard.test.mjs holds the guard that keeps a forged continuation row out. Every run comes from
// test/project-start-fixture.mjs: no real session, forge, or home.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { countRecordedDecisions, recordDecision } from '../plugins/aidrian/lib/project-decision-store.mjs';
import { fullAutoLines } from '../plugins/aidrian/lib/project-full-auto.mjs';
import { teamPolicy } from '../plugins/aidrian/lib/project-run-gate.mjs';
import { appendToRun } from '../plugins/aidrian/lib/project-run.mjs';
import { projectRunActive, resumeWords } from '../plugins/aidrian/lib/project-run-guard.mjs';
import { runWriter } from '../plugins/aidrian/lib/project-report.mjs';
import { drivesRun } from '../plugins/aidrian/lib/run-driver.mjs';
import { projectId } from '../plugins/aidrian/lib/project.mjs';
import { markUnattended, readDriverMark, readUnattendedMark } from '../plugins/aidrian/lib/unattended-mark.mjs';
import { hookCall } from './hook-call.mjs';
import { DRIVER, OTHER, runFixture } from './project-start-fixture.mjs';

const AGENT_HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-agent-gates.mjs');
// The session the host continued the driver as.
const NEXT = 'abcd1234-0000-4000-8000-00000000c0a1';
const REPOSITORY = { host: 'github.com', owner: 'acme', name: 'widgets' };
const ON = { allow: true, unverifiedHosts: true, fullAuto: true };
const OFF = { allow: true, unverifiedHosts: true };

// A run whose driver the host continued as NEXT, under `projectRun` committed and served by the forge alike.
function continued(t, { projectRun = ON, ...options } = {}) {
  const fx = runFixture(t, { projectRun, ...options });
  const transcript = path.join(fx.env.CLAUDE_CONFIG_DIR, 'projects', fx.dir.replace(/[^A-Za-z0-9]/gu, '-'), `${DRIVER}.jsonl`);
  const moved = new Date(Date.parse(fx.run().init.at) + 1000).toISOString();
  appendFileSync(transcript, `${JSON.stringify({ type: 'continued-in', timestamp: moved, sessionId: DRIVER, continuedInSessionId: NEXT })}\n`);
  const halt = () => appendToRun(fx.state, 'launch', () => ({ rows: [{ event: 'halt', cause: 'a test halt', at: new Date().toISOString() }] }));
  // The background route started the session, so no Human attends it by its provenance.
  const unattended = (session = NEXT, tags = null) => markUnattended(session, { root: fx.dir, cwd: fx.dir, env: fx.env, ...(tags ? { tags } : {}) });
  const custodyRows = () => fx.rows().filter((row) => row.event === 'driver');
  const halted = () => fx.cmd(['next', 'launch']).out[0]?.startsWith('halted ');
  const hook = (session, command, more = {}) => hookCall(AGENT_HOOK, {
    input: JSON.stringify({ session_id: session, tool_name: 'Bash', tool_input: { command }, cwd: fx.dir, ...more }),
    cwd: fx.dir, env: { ...fx.as(session), HOME: fx.home }, encoding: 'utf8',
  });
  return { ...fx, halt, unattended, custodyRows, halted, hook };
}

test('projectRun.fullAuto is a switch, false by default, and true in the team policy only when both reads set it', (t) => {
  const plain = runFixture(t, { init: false });
  assert.equal(loadConfig(plain.project).config.projectRun.fullAuto, false);
  const bad = runFixture(t, { init: false, projectRun: { ...OFF, fullAuto: 'yes' } });
  assert.match(loadConfig(bad.project).errors.join('\n'), /"projectRun\.fullAuto" must be true or false/u);
  assert.equal(loadConfig(bad.project).config.projectRun.fullAuto, false);
  const policyOf = (local, forge) => {
    const fx = runFixture(t, { init: false, projectRun: { ...OFF, fullAuto: local }, forgeConfig: { version: 1, projectRun: { ...OFF, fullAuto: forge } } });
    return teamPolicy(fx.project, REPOSITORY, fx.forge).fullAuto;
  };
  assert.deepEqual([policyOf(true, true), policyOf(true, false), policyOf(false, true), policyOf(false, false)], [true, false, false, false]);
});

test('resume --custody from the continuation the host names, unattended, under fullAuto: custody and marks move, and the halt stands', (t) => {
  const fx = continued(t);
  fx.halt();
  fx.unattended();
  const taken = fx.cmd(['resume', 'launch', '--custody'], { session: NEXT });
  assert.equal(taken.exitCode, 0, taken.err.join('\n'));
  assert.match(taken.out[0], /^custody: this session now drives the run launch/u);
  assert.match(taken.out.join('\n'), /note: the halt stands: this resume takes custody only/u);
  const [row] = fx.custodyRows();
  assert.deepEqual([row.session, row.from, row.via], [NEXT, DRIVER, 'resume']);
  assert.equal(fx.rows().some((each) => each.event === 'resume'), false, 'no resume row');
  assert.equal(fx.halted(), true, 'the halt stands');
  assert.equal(readDriverMark(NEXT, { env: fx.env, home: fx.home })?.run, 'launch');
  // Once it drives, the session may neither lift the halt nor record a decision the Human made.
  assert.match(fx.cmd(['resume', 'launch'], { session: NEXT }).err[0], /drives the run launch, or did|background handoff route started this session/u);
  assert.match(fx.cmd(['decision', 'ENG-1', '--heading', 'Export format', '--record'], { session: NEXT }).err.join('\n'), /background handoff route started this session/u);
});

test('the custody waiver files an unattended mark beside the driver mark, which holds a session no Human attended before', (t) => {
  const fx = continued(t);
  assert.equal(readUnattendedMark(NEXT, { env: fx.env, home: fx.home }), null);
  const taken = fx.cmd(['resume', 'launch', '--custody'], { session: NEXT });
  assert.equal(taken.exitCode, 0, taken.err.join('\n'));
  const mark = readUnattendedMark(NEXT, { env: fx.env, home: fx.home });
  assert.deepEqual([mark?.root, mark?.issue, mark?.pending], [fx.dir, undefined, undefined], 'a plain mark, which the Human typing into the session lifts');
  assert.match(fx.cmd(['decision', 'ENG-1', '--heading', 'Export format', '--record'], { session: NEXT }).err.join('\n'), /background handoff route started this session/u);
});

test('resume --custody is refused, with no row, off fullAuto unattended, from a session the row does not name, an issue session, and on an ended run', (t) => {
  const off = continued(t, { projectRun: OFF });
  off.unattended();
  assert.match(off.cmd(['resume', 'launch', '--custody'], { session: NEXT }).err[0], /background handoff route started this session/u, 'off: what resume asks');
  assert.deepEqual(off.custodyRows(), []);
  const forgeOff = continued(t, { forgeConfig: { version: 1, projectRun: OFF } });
  forgeOff.unattended();
  assert.equal(forgeOff.cmd(['resume', 'launch', '--custody'], { session: NEXT }).exitCode, 1, 'the forge alone does not set it');
  assert.deepEqual(forgeOff.custodyRows(), []);

  const other = continued(t);
  other.unattended(OTHER);
  assert.equal(other.cmd(['resume', 'launch', '--custody'], { session: OTHER }).exitCode, 1);
  assert.deepEqual(other.custodyRows(), []);
  assert.equal(readDriverMark(OTHER, { env: other.env, home: other.home }), null);

  const issue = continued(t);
  issue.unattended(NEXT, { project: 'launch', issue: 'ENG-1' });
  assert.match(issue.cmd(['resume', 'launch', '--custody'], { session: NEXT }).err[0], /unattended mark names an issue of a project run/u);
  assert.deepEqual(issue.custodyRows(), []);

  const ended = continued(t);
  assert.equal(ended.cmd(['end', 'launch']).exitCode, 0);
  ended.unattended();
  assert.match(ended.cmd(['resume', 'launch', '--custody'], { session: NEXT }).err[0], /the run launch ended/u);
  assert.deepEqual(ended.custodyRows(), []);
});

test('off fullAuto, resume --custody asks what resume asks and takes custody only; a plain resume from the host-named session never lifts a halt', (t) => {
  const off = continued(t, { projectRun: OFF });
  off.halt();
  const taken = off.cmd(['resume', 'launch', '--custody'], { session: NEXT });
  assert.equal(taken.exitCode, 0, taken.err.join('\n'));
  assert.equal(off.custodyRows().length, 1);
  assert.equal(off.halted(), true);
  assert.equal(readUnattendedMark(NEXT, { env: off.env, home: off.home }), null, 'no waiver, no mark');

  for (const projectRun of [ON, OFF]) {
    const fx = continued(t, { projectRun });
    fx.halt();
    const plain = fx.cmd(['resume', 'launch'], { session: NEXT });
    assert.equal(plain.exitCode, 0, plain.err.join('\n'));
    assert.deepEqual(plain.out.slice(0, 2), ['custody: this session now drives the run launch; its last driver ended', 'note: the halt stands: this resume takes custody only, and another session a person attends, or the Human\'s own shell, lifts it with `aidrian project resume launch`']);
    assert.equal(fx.halted(), true, 'the host-named session moves custody, and the halt stands');
    // Another attended session lifts it as before, and takes no custody.
    assert.deepEqual(fx.cmd(['resume', 'launch'], { session: OTHER }).out, ['resumed launch']);
    assert.equal(fx.halted(), false);
  }
});

test('a resume rechecks under the ledger lock: a continuation the host records meanwhile lifts no halt', (t) => {
  const fx = runFixture(t, { projectRun: ON });
  appendToRun(fx.state, 'launch', () => ({ rows: [{ event: 'halt', cause: 'a test halt', at: new Date().toISOString() }] }));
  const transcript = path.join(fx.env.CLAUDE_CONFIG_DIR, 'projects', fx.dir.replace(/[^A-Za-z0-9]/gu, '-'), `${DRIVER}.jsonl`);
  const moved = new Date(Date.parse(fx.run().init.at) + 1000).toISOString();
  // The host records OTHER as the driver's continuation after the resume read it, while it waits for the lock.
  const listing = (command, args, options) => {
    if (args[0] === 'agents') appendFileSync(transcript, `${JSON.stringify({ type: 'continued-in', timestamp: moved, sessionId: DRIVER, continuedInSessionId: OTHER })}\n`);
    return fx.claude.run(command, args, options);
  };
  const raced = fx.cmd(['resume', 'launch'], { session: OTHER, spawn: listing });
  assert.equal(raced.exitCode, 1);
  assert.match(raced.err[0], /the host's record of the run's driver changed while this command read it/u);
  assert.equal(fx.rows().some((row) => row.event === 'resume' || row.event === 'driver'), false, 'no halt lifted, no custody moved');
});

test('a custody move whose ledger row is never written leaves the session held as a driver until the run ends, with no custody', async (t) => {
  const fx = continued(t);
  const ledger = path.join(fx.state, 'runs', 'launch', 'ledger.jsonl');
  chmodSync(ledger, 0o400);
  try {
    assert.throws(() => fx.cmd(['resume', 'launch', '--custody'], { session: NEXT }));
  } finally {
    chmodSync(ledger, 0o600);
  }
  assert.deepEqual(fx.custodyRows(), []);
  assert.equal(readUnattendedMark(NEXT, { env: fx.env, home: fx.home })?.root, fx.dir, 'held as no Human attends it');
  assert.match(fx.cmd(['decision', 'ENG-1', '--heading', 'Export format', '--record'], { session: NEXT }).err.join('\n'), /background handoff route started this session/u);
  assert.match(fx.cmd(['wait', 'launch', '--max-wait', '0'], { session: NEXT }).err[0], /this session is not the driver of the run launch/u, 'its driver mark grants nothing');
  // The residual: held as a driver of the run until it ends, which only restricts.
  assert.equal(drivesRun(NEXT, { env: fx.env, home: fx.home }), true, 'the driver hold stands');
  assert.equal(runWriter({ session: NEXT, env: fx.env, home: fx.home })?.role, 'held');
  // The real driver ends the run: the driver hold goes, and the transcript guard reads the ledger, not NEXT's mark.
  assert.equal(fx.cmd(['end', 'launch']).exitCode, 0);
  assert.equal(drivesRun(NEXT, { env: fx.env, home: fx.home }), false);
  assert.equal(projectRunActive(fx.project, fx.config, { home: fx.home }), true, 'the mark still counts for the main checkout guard');
  assert.equal(projectRunActive(fx.project, fx.config, { home: fx.home, untilEnd: true }), false, 'the ledgers alone');
  const transcript = path.join(fx.env.CLAUDE_CONFIG_DIR, 'projects', fx.dir.replace(/[^A-Za-z0-9]/gu, '-'), `${DRIVER}.jsonl`);
  assert.equal((await fx.hook(OTHER, `printf x >> ${transcript}`)).status, 0, 'transcript writes pass after the end');
});

test('a resume rechecks the session under the ledger lock: a mark filed meanwhile refuses it', (t) => {
  const fx = runFixture(t, { projectRun: ON });
  appendToRun(fx.state, 'launch', () => ({ rows: [{ event: 'halt', cause: 'a test halt', at: new Date().toISOString() }] }));
  // The background route files the session's mark while the resume reads the host's listing, after its first check.
  const listing = (command, args, options) => {
    if (args[0] === 'agents') markUnattended(OTHER, { root: fx.dir, cwd: fx.dir, env: fx.env });
    return fx.claude.run(command, args, options);
  };
  const raced = fx.cmd(['resume', 'launch'], { session: OTHER, spawn: listing });
  assert.equal(raced.exitCode, 1);
  assert.match(raced.err[0], /background handoff route started this session/u);
  assert.equal(fx.rows().some((row) => row.event === 'resume'), false, 'no halt lifted');
});

test('the command reads resume\'s words as the hook does: an option twice, a value on --custody, and --custody after -- are refused', (t) => {
  const fx = continued(t);
  for (const words of [['launch', '--custody', '--custody'], ['launch', '--custody=false'], ['launch', '--', '--custody'], ['launch', '--force']]) {
    assert.equal(resumeWords(words), null, words.join(' '));
    assert.match(fx.cmd(['resume', ...words], { session: NEXT }).err.join('\n'), /project resume takes one run id, and --custody and --project DIR at most once each/u);
  }
  assert.deepEqual(resumeWords(['launch', '--custody']), { run: 'launch', custody: true, project: null });
  assert.deepEqual(fx.custodyRows(), []);
});

test('the hook lets the exact resume --custody through from the host-named continuation under fullAuto, and holds every other form to the attended rules', async (t) => {
  const fx = continued(t);
  fx.unattended();
  const status = async (session, command) => (await fx.hook(session, command)).status;
  assert.equal(await status(NEXT, 'aidrian project resume launch --custody'), 0);
  for (const command of ['aidrian project resume launch', 'aidrian project resume launch -- --custody', 'aidrian project resume launch --custody=false', 'aidrian project resume launch --custody --custody']) {
    const refused = await fx.hook(NEXT, command);
    assert.equal(refused.status, 2, command);
    assert.match(refused.stderr, /background handoff route started this session/u, command);
  }
  fx.unattended(OTHER);
  assert.equal(await status(OTHER, 'aidrian project resume launch --custody'), 2, 'a session the row does not name');
  assert.equal(await status(NEXT, 'aidrian project resume launch --custody'), 0, 'the hook writes nothing');

  const off = continued(t, { projectRun: OFF });
  off.unattended();
  assert.equal((await off.hook(NEXT, 'aidrian project resume launch --custody')).status, 2, 'off fullAuto');
  const issue = continued(t);
  issue.unattended(NEXT, { project: 'launch', issue: 'ENG-1' });
  assert.equal((await issue.hook(NEXT, 'aidrian project resume launch --custody')).status, 2, 'an issue session');
});

test('preflight lists what fullAuto changes and every thing that still waits on a person, and nothing with it off', (t) => {
  const fx = runFixture(t, { init: false, projectRun: ON });
  const out = fx.cmd(['preflight']).out;
  const notes = out.filter((line) => /^note (?:full-auto|human):/u.test(line));
  assert.match(notes[0], /^note full-auto: projectRun\.fullAuto lets the session the host continued the driver as take the run's custody .*takes no decision, merges nothing more, signs nothing off, and lifts no halt$/u);
  assert.deepEqual(notes.slice(1).map((line) => line.replace(/^note human: /u, '').split(' ').slice(0, 3).join(' ')), [
    'a pull request', 'the sign-off flows', 'a floor-class decision', 'a halt, such', 'a run whose',
    'decisions.mode is "ask"', 'decisions.unattended.safeDefaults is "outside-escalated"', 'github.autoMerge.includeGuardedPaths is off,',
  ]);
  assert.match(notes.join('\n'), /signoff "human"\): none;/u);
  assert.match(notes.join('\n'), /projectRun\.recordedDecisions is off, so no recorded answer is read/u);
  const off = runFixture(t, { init: false, projectRun: OFF });
  assert.ok(!off.cmd(['preflight']).out.some((line) => /^note (?:full-auto|human):/u.test(line)));
  const forgeOff = runFixture(t, { init: false, projectRun: ON, forgeConfig: { version: 1, projectRun: OFF } });
  assert.ok(!forgeOff.cmd(['preflight']).out.some((line) => /^note (?:full-auto|human):/u.test(line)), 'the forge alone');
});

test('the full-auto lines name the human sign-off flows and drop each setting that no longer parks more than it must', () => {
  const base = { config: {
    review: { flows: { payments: { files: ['src/pay/**'], signoff: 'human' }, docs: { files: ['docs/**'] }, auth: { files: ['src/auth/**'], signoff: 'human' } } },
    decisions: { mode: 'decide-reversible', maxMode: 'decide-reversible', unattended: { safeDefaults: 'all' } },
  } };
  const lines = fullAutoLines({ base, policy: { fullAuto: true, includeGuardedPaths: true }, projectKey: 'p', count: () => ({ count: 0 }) });
  assert.equal(lines.length, 6);
  assert.match(lines[2], /^note human: the sign-off flows the default branch gives the Human \(signoff "human"\): auth, payments;/u);
  assert.match(lines[3], /takes a safe default that can be undone under decisions\.unattended\.safeDefaults "all"/u);
  assert.deepEqual(fullAutoLines({ base, policy: { fullAuto: false }, projectKey: 'p' }), []);
  assert.deepEqual(fullAutoLines({ base, policy: { problem: 'no forge' }, projectKey: 'p' }), []);
});

test('the floor-class line reads the decision switch and counts this machine\'s grants, printing no grant and writing nothing', (t) => {
  const fx = runFixture(t, { init: false });
  const projectKey = projectId(fx.project);
  const line = (policy) => fullAutoLines({ base: { config: {} }, policy: { fullAuto: true, ...policy }, projectKey, env: fx.env }).find((each) => each.includes('floor-class'));
  assert.match(line({ recordedDecisions: false }), /projectRun\.recordedDecisions is off/u);
  assert.match(line({ recordedDecisions: true }), /no grant is pinned on this machine: record one with `aidrian project decision ISSUE --heading TEXT --record` from a session the Human attends; grants are this machine's, so a run driven from another machine sees none/u);
  for (const key of ['ENG-1', 'ENG-2']) recordDecision({ projectKey, key, heading: `Heading of ${key}`, sha256: 'a'.repeat(64), env: fx.env });
  const store = path.join(fx.env.XDG_STATE_HOME, 'aidrian', 'recorded-decisions', projectKey);
  const before = readdirSync(store).sort();
  const two = line({ recordedDecisions: true });
  assert.match(two, /: 2 grants pinned on this machine; grants are this machine's/u);
  assert.doesNotMatch(two, /Heading of|stands:/u, 'a count only');
  assert.deepEqual(readdirSync(store).sort(), before, 'it writes nothing');
  assert.deepEqual(countRecordedDecisions({ projectKey, env: fx.env }), { count: 2 });
  assert.deepEqual(countRecordedDecisions({ projectKey: 'none-here', env: fx.env }), { count: 0 });
});
