// projectRun.fullAuto: the team's standing consent for custody of a driver session the host continued under a new id.
// The custody rules run in this process on a ledger and marks the test builds, with no git: resumeWords,
// custodyWaiverProblem, resumerProblem, and resumerEligibility (lib/project-run-guard.mjs, lib/project-run-gate.mjs),
// and the preflight's list of what still waits on a person (lib/project-full-auto.mjs). One run of
// test/project-start-fixture.mjs checks the wiring: the hook's rule waives only the exact words, and
// `aidrian project resume RUN --custody` moves custody with the halt standing, writes no row when refused, and rechecks
// under the lock.
// test/transcript-guard.test.mjs holds the guard that keeps a forged continuation row out. No real session or home.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DEFAULTS } from '../plugins/aidrian/lib/config-defaults.mjs';
import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { countRecordedDecisions, recordDecision } from '../plugins/aidrian/lib/project-decision-store.mjs';
import { fullAutoLines } from '../plugins/aidrian/lib/project-full-auto.mjs';
import { resumerEligibility, teamPolicy } from '../plugins/aidrian/lib/project-run-gate.mjs';
import { replaceEnv } from '../plugins/aidrian/lib/hook-io.mjs';
import { appendToRun, haltOf } from '../plugins/aidrian/lib/project-run.mjs';
import { custody, custodyWaiverProblem, projectCommandDenial, resumerProblem, resumeWords } from '../plugins/aidrian/lib/project-run-guard.mjs';
import { drivesRun } from '../plugins/aidrian/lib/run-driver.mjs';
import { markDriver, markUnattended, readDriverMark, readUnattendedMark } from '../plugins/aidrian/lib/unattended-mark.mjs';
import { DRIVER, OTHER, runFixture } from './project-start-fixture.mjs';

// The session the host continued the driver as.
const NEXT = 'abcd1234-0000-4000-8000-00000000c0a1';
const THIRD = 'abcd1234-0000-4000-8000-00000000c0a3';
const REPOSITORY = { host: 'github.com', owner: 'acme', name: 'widgets' };
const ON = { allow: true, unverifiedHosts: true, fullAuto: true };
const OFF = { allow: true, unverifiedHosts: true };
const iso = (ms) => new Date(ms).toISOString();
const continuedRow = (to, ms, from = DRIVER) => `${JSON.stringify({ type: 'continued-in', timestamp: iso(ms), sessionId: from, continuedInSessionId: to })}\n`;
// A store the custody reader opens nothing in: no start record of the driver names a successor.
const NO_STORE = Object.freeze({ refused: 'no continuation store in this test' });

// A run's ledger, as readRun gives it, its driver DRIVER since `at`, in a main checkout of its own, with the host's
// config and state folders of a temporary root: `continueAs(id)` records the host continuing DRIVER as `id`; `mark`
// files an unattended mark; `drove(from, to)` appends a driver row moving custody.
function ledger(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-full-auto-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = path.join(root, 'project');
  const home = path.join(root, 'home');
  const claudeConfig = path.join(root, 'claude-config');
  for (const each of [main, home]) mkdirSync(each, { recursive: true });
  const env = { ...process.env, CLAUDECODE: '1', CLAUDE_CONFIG_DIR: claudeConfig, XDG_STATE_HOME: path.join(home, '.local/state'), HOME: home };
  const at = Date.now() - 60_000;
  const found = { init: { run: 'launch', session: DRIVER, at: iso(at), main }, rows: [] };
  const transcript = path.join(claudeConfig, 'projects', main.replace(/[^A-Za-z0-9]/gu, '-'), `${DRIVER}.jsonl`);
  mkdirSync(path.dirname(transcript), { recursive: true });
  let clock = at;
  const continueAs = (to) => appendFileSync(transcript, continuedRow(to, (clock += 1000)));
  const mark = (session, tags = null) => markUnattended(session, { root: main, cwd: main, env, ...(tags ? { tags } : {}) });
  const drove = (from, to) => found.rows.push({ event: 'driver', session: to, from, sha256: createHash('sha256').update(`${from}${to}`).digest('hex'), via: 'resume', at: iso((clock += 1000)) });
  const waiver = (session) => custodyWaiverProblem({ found, store: NO_STORE, session, env, home });
  return { root, main, home, env, found, continueAs, mark, drove, waiver };
}

test('resume\'s words are read alike by the command and the hook: one run, --custody and --project at most once each', () => {
  assert.deepEqual(resumeWords(['launch', '--custody']), { run: 'launch', custody: true, project: null });
  assert.deepEqual(resumeWords(['launch']), { run: 'launch', custody: false, project: null });
  assert.deepEqual(resumeWords(['launch', '--project', '/x', '--custody']), { run: 'launch', custody: true, project: '/x' });
  for (const words of [['launch', '--custody', '--custody'], ['launch', '--custody=false'], ['launch', '--', '--custody'], ['launch', '--force'], [], ['a', 'b']]) {
    assert.equal(resumeWords(words), null, words.join(' '));
  }
});

test('the waiver passes the session the host continued the driver as, and refuses every other, with the reason', (t) => {
  const run = ledger(t);
  assert.match(run.waiver(NEXT), /the host recorded no continuation of the run launch's driver as this session/u, 'no record yet');
  run.continueAs(NEXT);
  assert.equal(run.waiver(NEXT), null, 'unattended by no mark, the host-named continuation');
  run.mark(NEXT);
  assert.equal(run.waiver(NEXT), null, 'a plain mark, the background route\'s');
  assert.match(run.waiver(OTHER), /no continuation of the run launch's driver as this session/u, 'a session the row does not name');
  assert.match(run.waiver(DRIVER), /no continuation of the run launch's driver as this session/u, 'the driver itself');
  run.mark(NEXT, { project: 'launch', issue: 'ENG-1' });
  assert.match(run.waiver(NEXT), /unattended mark names an issue of a project run/u, 'an issue\'s session');
  run.mark(NEXT);
  // Ended by its driver: no custody moves.
  run.found.rows.push({ event: 'end', session: DRIVER, at: iso(Date.now()) });
  assert.match(run.waiver(NEXT), /the run launch ended/u);
});

test('the waiver refuses a host-named session that drove the run before, as resumerProblem does', (t) => {
  const run = ledger(t);
  run.drove(DRIVER, NEXT);
  run.drove(NEXT, DRIVER);
  run.continueAs(NEXT);
  assert.match(run.waiver(NEXT), /drives the run launch, or did/u);
  assert.match(resumerProblem({ found: run.found, store: NO_STORE, session: NEXT, env: run.env }), /drives the run launch, or did/u);
});

test('resumerProblem lets the host-named continuation resume to take custody, and custody names the --custody way to it', (t) => {
  const run = ledger(t);
  run.continueAs(NEXT);
  assert.equal(resumerProblem({ found: run.found, store: NO_STORE, session: NEXT, env: run.env }), null);
  assert.match(resumerProblem({ found: run.found, store: NO_STORE, session: DRIVER, env: run.env }), /drives the run launch, or did/u);
  const held = custody({ found: run.found, store: NO_STORE, session: NEXT, env: run.env });
  assert.match(held.problem, /which the host continued as abcd1234-0000-4000-8000-00000000c0a1: custody moves only through `aidrian project resume launch`/u);
  assert.match(held.problem, /where the team set projectRun\.fullAuto, `aidrian project resume launch --custody` from abcd1234-0000-4000-8000-00000000c0a1 itself/u);
});

test('resumerEligibility asks the waiver under fullAuto and the attended check and resumerProblem otherwise, as the lock asks it again', (t) => {
  const run = ledger(t);
  run.continueAs(NEXT);
  run.mark(NEXT);
  const project = { root: run.main, checkouts: [run.main] };
  const ask = (session, waived) => resumerEligibility({ found: run.found, session, waived, project, config: DEFAULTS, opened: { state: run.root, store: NO_STORE }, env: run.env, home: run.home });
  assert.equal(ask(NEXT, true), null, 'waived: the host-named session, held by a plain mark');
  assert.match(ask(NEXT, false), /a halt is lifted by a person, and the background handoff route started this session/u, 'off fullAuto: what resume asks');
  assert.match(ask(OTHER, true), /no continuation of the run launch's driver as this session/u);
  // A mark that lands between the command's first read and the lock refuses the plain resume there.
  run.mark(OTHER);
  assert.match(ask(OTHER, false), /background handoff route started this session/u);
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
  assert.deepEqual(fullAutoLines({ base, policy: { fullAuto: false }, projectKey: 'p' }), [], 'off fullAuto');
  assert.deepEqual(fullAutoLines({ base, policy: { problem: 'no forge' }, projectKey: 'p' }), [], 'a policy that cannot be read');
  const parking = fullAutoLines({ base: { config: {} }, policy: { fullAuto: true }, projectKey: 'p', count: () => ({ count: 0 }) });
  assert.deepEqual(parking.slice(1).map((line) => line.replace(/^note human: /u, '').split(' ').slice(0, 2).join(' ')), [
    'a pull', 'the sign-off', 'a floor-class', 'a halt,', 'a run', 'decisions.mode is', 'decisions.unattended.safeDefaults is', 'github.autoMerge.includeGuardedPaths is',
  ]);
  assert.match(parking.join('\n'), /signoff "human"\): none;/u);
});

test('the floor-class line reads the decision switch and counts this machine\'s grants, printing no grant and writing nothing', (t) => {
  const run = ledger(t);
  const projectKey = 'widgets-project';
  const line = (policy) => fullAutoLines({ base: { config: {} }, policy: { fullAuto: true, ...policy }, projectKey, env: run.env }).find((each) => each.includes('floor-class'));
  assert.match(line({ recordedDecisions: false }), /projectRun\.recordedDecisions is off/u);
  assert.match(line({ recordedDecisions: true }), /no grant is pinned on this machine: record one with `aidrian project decision ISSUE --heading TEXT --record` from a session the Human attends; grants are this machine's, so a run driven from another machine sees none/u);
  for (const key of ['ENG-1', 'ENG-2']) recordDecision({ projectKey, key, heading: `Heading of ${key}`, sha256: 'a'.repeat(64), env: run.env });
  const store = path.join(run.env.XDG_STATE_HOME, 'aidrian', 'recorded-decisions', projectKey);
  const before = readdirSync(store).sort();
  const two = line({ recordedDecisions: true });
  assert.match(two, /: 2 grants pinned on this machine; grants are this machine's/u);
  assert.doesNotMatch(two, /Heading of|stands:/u, 'a count only');
  assert.deepEqual(readdirSync(store).sort(), before, 'it writes nothing');
  assert.deepEqual(countRecordedDecisions({ projectKey, env: run.env }), { count: 2 });
  assert.deepEqual(countRecordedDecisions({ projectKey: 'none-here', env: run.env }), { count: 0 });
});

// A run whose driver the host continued as NEXT, under `projectRun` committed and served by the forge alike.
function continued(t, { projectRun = ON, ...options } = {}) {
  const fx = runFixture(t, { projectRun, ...options });
  const transcript = (session) => path.join(fx.env.CLAUDE_CONFIG_DIR, 'projects', fx.dir.replace(/[^A-Za-z0-9]/gu, '-'), `${session}.jsonl`);
  appendFileSync(transcript(DRIVER), continuedRow(NEXT, Date.parse(fx.run().init.at) + 1000));
  const halt = () => appendToRun(fx.state, 'launch', () => ({ rows: [{ event: 'halt', cause: 'a test halt', at: iso(Date.now()) }] }));
  // The background route started the session, so no Human attends it by its provenance.
  const unattended = (session = NEXT) => markUnattended(session, { root: fx.dir, cwd: fx.dir, env: fx.env });
  const marks = path.join(fx.env.XDG_STATE_HOME, 'aidrian', 'unattended');
  const custodyRows = () => fx.rows().filter((row) => row.event === 'driver');
  const halted = () => haltOf(fx.run()) !== null;
  // The agent gate hook's rule for an `aidrian project` call, in this process under the session's environment.
  const rule = (session, command) => {
    const saved = { ...process.env };
    replaceEnv({ ...fx.as(session), HOME: fx.home });
    try {
      return projectCommandDenial({ session_id: session, tool_name: 'Bash', tool_input: { command }, cwd: fx.dir }, fx.config, { home: fx.home });
    } finally {
      replaceEnv(saved);
    }
  };
  return { ...fx, transcript, halt, unattended, marks, custodyRows, halted, rule };
}

test('resume --custody under fullAuto, on one run: the hook waives only its words, refusals write no row, custody moves with the halt standing', (t) => {
  // One run for every step, in order, keeps the test's git calls under its budget.
  const fx = continued(t);
  fx.unattended();
  // The hook's rule waives the attended check for the exact words alone, from the session the host names.
  // Its other refusals, a session the row does not name and every other spelling of the words, are the waiver's and
  // resumeWords', which the unit tests above hold.
  assert.equal(fx.rule(NEXT, 'aidrian project resume launch --custody'), null);
  assert.match(fx.rule(NEXT, 'aidrian project resume launch')?.reason ?? '', /background handoff route started this session/u, 'a plain resume');
  // The team's switch: true only while the forge's copy, with the local ref's, sets it.
  assert.equal(teamPolicy(fx.project, REPOSITORY, fx.forge).fullAuto, true);
  fx.serveConfig({ version: 1, projectRun: OFF });
  assert.equal(teamPolicy(fx.project, REPOSITORY, fx.forge).fullAuto, false, 'the forge alone does not set it');
  fx.serveConfig(fx.committed);
  // The command reads resume's words as the hook does.
  assert.match(fx.cmd(['resume', 'launch', '--custody', '--custody'], { session: NEXT }).err.join('\n'), /project resume takes one run id, and --custody and --project DIR at most once each/u);
  // A session that holds the driver mark of another run files nothing.
  assert.ok(markDriver(NEXT, { run: 'other-run', root: fx.dir, state: fx.state, env: fx.env }));
  assert.match(fx.cmd(['resume', 'launch', '--custody'], { session: NEXT }).err[0], /this session holds the driver mark of the run other-run/u);
  assert.equal(readDriverMark(NEXT, { env: fx.env, home: fx.home })?.run, 'other-run', 'its mark stays');
  rmSync(path.join(fx.marks, `driver.${NEXT}.json`));
  assert.deepEqual(fx.custodyRows(), [], 'no refusal wrote a row');
  // A move whose row is never written leaves the session held as a driver of the run, with no custody.
  fx.halt();
  const ledgerFile = path.join(fx.state, 'runs', 'launch', 'ledger.jsonl');
  chmodSync(ledgerFile, 0o400);
  try {
    assert.throws(() => fx.cmd(['resume', 'launch', '--custody'], { session: NEXT }));
  } finally {
    chmodSync(ledgerFile, 0o600);
  }
  assert.deepEqual(fx.custodyRows(), []);
  assert.equal(drivesRun(NEXT, { env: fx.env, home: fx.home }), true, 'the driver hold stands');
  assert.equal(readUnattendedMark(NEXT, { env: fx.env, home: fx.home })?.root, fx.dir, 'held as no Human attends it');
  // With the ledger writable, custody moves, the halt stands, and the session is held as no Human attends it.
  const taken = fx.cmd(['resume', 'launch', '--custody'], { session: NEXT });
  assert.equal(taken.exitCode, 0, taken.err.join('\n'));
  assert.deepEqual(taken.out, ['custody: this session now drives the run launch; its last driver ended', 'note: the halt stands: this resume takes custody only, and another session a person attends, or the Human\'s own shell, lifts it with `aidrian project resume launch`']);
  const [row] = fx.custodyRows();
  assert.deepEqual([row.session, row.from, row.via], [NEXT, DRIVER, 'resume']);
  assert.equal(fx.rows().some((each) => each.event === 'resume'), false, 'no resume row');
  assert.equal(fx.halted(), true, 'the halt stands');
  assert.equal(readDriverMark(NEXT, { env: fx.env, home: fx.home })?.run, 'launch');
  assert.match(fx.cmd(['decision', 'ENG-1', '--heading', 'Export format', '--record'], { session: NEXT }).err.join('\n'), /background handoff route started this session/u);
  // Under the lock, a resume reads again: a mark, or a continuation the host records, while it reads the host's listing.
  const during = (act) => (command, args, options) => {
    if (args[0] === 'agents') act();
    return fx.claude.run(command, args, options);
  };
  const marked = fx.cmd(['resume', 'launch'], { session: OTHER, spawn: during(() => markUnattended(OTHER, { root: fx.dir, cwd: fx.dir, env: fx.env })) });
  assert.match(marked.err[0], /background handoff route started this session/u);
  const moved = fx.cmd(['resume', 'launch'], { session: THIRD, spawn: during(() => appendFileSync(fx.transcript(NEXT), continuedRow(THIRD, Date.now() + 1000, NEXT))) });
  assert.match(moved.err[0], /the host.s record of the run.s driver changed while this command read it/u);
  assert.equal(fx.halted(), true, 'no halt lifted');
  assert.equal(fx.custodyRows().length, 1, 'no custody moved');
  // The preflight prints what fullAuto changes and what still waits on a person.
  const notes = fx.cmd(['preflight', 'launch']).out.filter((line) => /^note (?:full-auto|human):/u.test(line));
  assert.match(notes[0], /^note full-auto: projectRun\.fullAuto lets the session the host continued the driver as take the run's custody .*takes no decision, merges nothing more, signs nothing off, and lifts no halt$/u);
  assert.equal(notes.length, 9, notes.join('\n'));
  // The host continued NEXT as THIRD: with fullAuto off on the local ref, the hook's rule waives nothing for it.
  fx.unattended(THIRD);
  assert.equal(fx.rule(THIRD, 'aidrian project resume launch --custody'), null);
  writeFileSync(path.join(fx.dir, '.aidrian/config.json'), JSON.stringify({ ...fx.committed, projectRun: OFF }));
  fx.git('commit', '-q', '-am', 'fullAuto off');
  fx.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  assert.notEqual(fx.rule(THIRD, 'aidrian project resume launch --custody'), null, 'off fullAuto');
  assert.equal(teamPolicy(fx.project, REPOSITORY, fx.forge).fullAuto, false, 'the local ref alone does not set it');
  // A plain resume from the host-named session, attended, moves custody, files no unattended mark, and lifts no halt.
  rmSync(path.join(fx.marks, `${THIRD}.json`));
  const plain = fx.cmd(['resume', 'launch'], { session: THIRD });
  assert.equal(plain.exitCode, 0, plain.err.join('\n'));
  assert.match(plain.out.join('\n'), /note: the halt stands/u);
  assert.equal(readUnattendedMark(THIRD, { env: fx.env, home: fx.home }), null, 'no waiver, no mark');
  // A working copy that sets a non-boolean is refused, and the default stands.
  writeFileSync(path.join(fx.dir, '.aidrian/config.json'), JSON.stringify({ ...fx.committed, projectRun: { ...OFF, fullAuto: 'yes' } }));
  const bad = loadConfig(fx.project);
  assert.match(bad.errors.join('\n'), /"projectRun\.fullAuto" must be true or false/u);
  assert.equal(bad.config.projectRun.fullAuto, false);
});
