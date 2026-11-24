// The transcript guard (lib/transcript-guard.mjs) through the agent gate hook, in this process: while a project run is
// under way, no session or subagent writes a host transcript, since a project run reads the driver's continuation there.
// Every run comes from test/project-start-fixture.mjs: no real session, forge, or home.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { continuedIn } from '../plugins/aidrian/lib/hosts/claude-code-continuation.mjs';
import { transcriptFolders } from '../plugins/aidrian/lib/hosts/index.mjs';
import { projectRunActive } from '../plugins/aidrian/lib/project-run-guard.mjs';
import { transcriptWriteDenial } from '../plugins/aidrian/lib/transcript-guard.mjs';
import { hookCall } from './hook-call.mjs';
import { DRIVER, ISSUES, OTHER, recordIssue, runFixture } from './project-start-fixture.mjs';

const AGENT_HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-agent-gates.mjs');
const NEXT = 'abcd1234-0000-4000-8000-00000000c0a1';
const SETTINGS = { names: { human: 'the Human' } };
const bash = (command, cwd) => ({ session_id: OTHER, tool_name: 'Bash', tool_input: { command }, cwd });
const hookOf = (fx) => (session, command, more = {}) => hookCall(AGENT_HOOK, {
  input: JSON.stringify({ session_id: session, tool_name: 'Bash', tool_input: { command }, cwd: fx.dir, ...more }),
  cwd: fx.dir, env: { ...fx.as(session), HOME: fx.home }, encoding: 'utf8',
});

test('while a run is under way, no session or subagent writes a host transcript, and a project folder\'s deeper entries stay writable', async (t) => {
  const fx = runFixture(t);
  const hook = hookOf(fx);
  const folder = path.join(fx.env.CLAUDE_CONFIG_DIR, 'projects', fx.dir.replace(/[^A-Za-z0-9]/gu, '-'));
  const forged = `printf '{}\\n' >> ${path.join(folder, `${DRIVER}.jsonl`)}`;
  for (const [session, more] of [[OTHER, {}], [DRIVER, {}], [OTHER, { agent_id: 'a1' }]]) {
    const refused = await hook(session, forged, more);
    assert.equal(refused.status, 2, `${session} ${JSON.stringify(more)}`);
    assert.match(refused.stderr, /may change a host's session transcript/u);
  }
  assert.equal((await hook(OTHER, `printf x > ${path.join(path.dirname(folder), 'forged', 'x.jsonl')}`)).status, 2, 'a new project folder');
  assert.equal((await hook(OTHER, `cd "$CONFIG" && printf x > projects/a/${NEXT}.jsonl`)).status, 2, 'spelled from a folder no path gives');
  assert.equal((await hook(OTHER, `printf x > ${path.dirname(folder)}/*/x.jsonl`)).status, 2, 'a glob that may reach one');
  mkdirSync(path.join(folder, 'memory'), { recursive: true });
  assert.equal((await hook(OTHER, `printf x > ${path.join(folder, 'memory', 'note.md')}`)).status, 0, 'a host memory file');
  assert.equal(fx.cmd(['end', 'launch']).exitCode, 0);
  assert.equal((await hook(OTHER, forged)).status, 0, 'no run under way');
});

test('a run whose issues are all done stays guarded until its ledger records its end, as custody reads it', async (t) => {
  const fx = runFixture(t);
  const hook = hookOf(fx);
  for (const { key } of ISSUES) recordIssue(fx.state, 'launch', { key, state: 'done' });
  assert.equal(projectRunActive(fx.project, fx.config, { home: fx.home }), false, 'the plan is done');
  assert.equal(projectRunActive(fx.project, fx.config, { home: fx.home, untilEnd: true }), true, 'no end row yet');
  const transcript = path.join(fx.env.CLAUDE_CONFIG_DIR, 'projects', fx.dir.replace(/[^A-Za-z0-9]/gu, '-'), `${DRIVER}.jsonl`);
  assert.equal((await hook(OTHER, `printf x >> ${transcript}`)).status, 2);
  assert.equal(fx.cmd(['end', 'launch']).exitCode, 0);
  assert.equal((await hook(OTHER, `printf x >> ${transcript}`)).status, 0);
});

test('the guard holds the folder the custody reader reads, under a host HOME that is not the account home', (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-transcripts-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const account = path.join(root, 'account');
  const host = path.join(root, 'host');
  const env = { HOME: host };
  const folder = path.join(host, '.claude', 'projects', '-work');
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, `${DRIVER}.jsonl`), `${JSON.stringify({ type: 'continued-in', timestamp: new Date().toISOString(), sessionId: DRIVER, continuedInSessionId: NEXT })}\n`);
  assert.equal(continuedIn({ session: DRIVER, cwd: '/work', env })?.id, NEXT, 'the reader takes HOME');
  const folders = transcriptFolders(account, { env });
  assert.ok(folders.includes(path.join(host, '.claude', 'projects')), folders.join(', '));
  assert.ok(folders.includes(path.join(account, '.claude', 'projects')));
  const denied = transcriptWriteDenial(bash(`printf x >> ${path.join(folder, `${DRIVER}.jsonl`)}`, root), SETTINGS, { runSession: () => true, folders });
  assert.match(denied?.match ?? '', /host's session transcript/u);
});

test('a write counts under the transcript folder but in a project\'s memory folder, and a glob by its literal prefix', (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-transcripts-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projects = path.join(root, '.claude', 'projects');
  const own = path.join(projects, '-work');
  const beside = path.join(root, 'beside');
  for (const folder of [path.join(own, 'memory'), beside]) mkdirSync(folder, { recursive: true });
  const ask = (command) => transcriptWriteDenial(bash(command, beside), SETTINGS, { runSession: () => true, folders: [projects] });
  const sibling = [`printf x > ${own}/memory/note.md`, `rm -f ${own}/memory/*.md`, `rm -f ${beside}/build-*.tmp`, 'rm -f ./build-*.tmp', `rm -rf ${beside}`, `mv ${beside} ${beside}-old`];
  for (const command of sibling) assert.equal(ask(command), null, command);
  // A folder above a transcript folder, removed or moved, takes its transcripts along.
  const above = [`rm -rf ${root}`, `mv ${projects} ${beside}/x`, `mv ${path.dirname(projects)} ${beside}/y`];
  for (const command of [...above, `printf x > ${own}/notes.md`, `printf x > ${own}/a/b/c.jsonl`, `rm -rf ${projects}`, `rm -f ${own}/memory-*.md`, `rm -f ${projects}/*/memory/*.md`, `rm -rf ${root}/.cl*`, `rm -f ${root}/**/*.jsonl`]) {
    assert.notEqual(ask(command), null, command);
  }
  assert.equal(transcriptWriteDenial(bash(`rm -f ${own}/*`, beside), SETTINGS, { runSession: () => false, folders: [projects] }), null, 'no run under way');
});
