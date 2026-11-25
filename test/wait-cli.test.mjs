// `aidrian wait` (lib/wait-cli.mjs) and Claude Code's background shell output it reads (lib/hosts/claude-code-tasks.mjs),
// the words a subagent is told of a long command (lib/wait-advice.mjs), and the shared sources that must name no host's
// limit. The host's temp folder is the test's own, and every wait runs on the test's clock, so none starts a process.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { processUid } from '../plugins/aidrian/lib/fs.mjs';
import claudeCode from '../plugins/aidrian/lib/hosts/claude-code.mjs';
import { findTask, readTask, TAIL } from '../plugins/aidrian/lib/hosts/claude-code-tasks.mjs';
import codex from '../plugins/aidrian/lib/hosts/codex.mjs';
import { WAIT_STEP } from '../plugins/aidrian/lib/project-stops.mjs';
import { longCommandLine, movedWords, waitWords } from '../plugins/aidrian/lib/wait-advice.mjs';
import { waitForTask } from '../plugins/aidrian/lib/wait-cli.mjs';
import { cliCall } from './cli-call.mjs';

const PLUGIN = path.resolve(import.meta.dirname, '../plugins/aidrian');
const SESSION = 'ffde8641-467b-48bb-a7c8-a0de8d632029';
const OTHER = '106de2fb-cf4b-4aaa-941e-0d12dec567eb';
const uid = processUid();

// A host temp folder of the test's own, with `put` to write a task's output file, and the environment that names it.
function hostTemp(t) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-wait-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, `claude-${uid}`);
  const tasks = (session = SESSION, project = '-work-app') => path.join(root, project, session, 'tasks');
  const put = (id, text, session, project) => {
    const file = path.join(tasks(session, project), `${id}.output`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
    return file;
  };
  put('bother', 'other\n', OTHER);
  return { base, root, tasks, put, env: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_CODE_TMPDIR: base } };
}

// A clock only a pause moves, and `at` run as it passes a second: { now, pause, waited }.
function clock(at = {}) {
  let time = 0;
  return {
    now: () => time,
    pause: async (ms) => {
      time += ms;
      at[time / 1000]?.();
    },
    waited: () => time / 1000,
  };
}

const wait = (args, { env, host = claudeCode, time = clock() }) => waitForTask(args, { env, host, now: time.now, pause: time.pause });

test('a task that ends during the wait returns at once, with its exit code and the end of its output', async (t) => {
  const { env, put } = hostTemp(t);
  const file = put('b0l303d88', 'pushing\n');
  const time = clock({ 4: () => appendFileSync(file, 'done\n\n[exited with code 7]\n') });
  assert.deepEqual(await wait(['b0l303d88'], { env, time }), {
    status: 0, out: ['ended b0l303d88', 'exit code: 7', 'last lines of its output (at most 40):', '| pushing', '| done'], err: [],
  });
  assert.equal(time.waited(), 4, 'no second longer than the task took');
});

test('a task still running at the cap exits 3 there, and --max-wait lowers the cap', async (t) => {
  const { env, put } = hostTemp(t);
  put('brun', 'line 1\n');
  const time = clock();
  const read = await wait(['brun'], { env, time });
  assert.deepEqual([read.status, read.out[0], time.waited()], [3, 'running brun: run the command again to keep waiting, unless the host says the task ended', 150]);
  assert.deepEqual(read.out.slice(1), ['last lines of its output (at most 40):', '| line 1'], 'no exit code is claimed');
  const short = clock();
  assert.equal((await wait(['brun', '--max-wait', '5'], { env, time: short })).status, 3);
  assert.equal(short.waited(), 5);
  const none = clock();
  assert.deepEqual([(await wait(['brun', '--max-wait', '0'], { env, time: none })).status, none.waited()], [3, 0]);
  for (const bad of ['151', '1.5', '-1', 'x', '']) {
    const refused = await wait(['brun', `--max-wait=${bad}`], { env });
    assert.deepEqual([refused.status, refused.err], [1, ['aidrian wait: --max-wait takes whole seconds from 0 to 150']], bad);
  }
});

test('the wait is as long as asked for when the wall clock is set forward or back during it', async (t) => {
  const { env, put } = hostTemp(t);
  put('brun', 'x\n');
  const time = clock();
  let wall = 0;
  let step;
  t.mock.method(performance, 'now', time.now);
  t.mock.method(Date, 'now', () => (wall += step));
  for (step of [3_600_000, -3_600_000]) {
    const before = time.waited();
    const pause = (ms) => {
      assert.ok(time.waited() - before < 10, 'the wait never ends');
      return time.pause(ms);
    };
    const { status } = await waitForTask(['brun', '--max-wait', '5'], { env, host: claudeCode, pause });
    assert.deepEqual([status, time.waited() - before], [3, 5], String(step));
  }
});

test('only the host\'s own last line says a task ended, and what it says of the exit code is printed', async (t) => {
  const { env, put } = hostTemp(t);
  const read = (text) => readTask(put('btask', text));
  assert.deepEqual(read('out\n\n[exited with code 0]\n'), { ended: true, killed: false, exitCode: 0, output: 'out\n' });
  assert.deepEqual(read('no line end\n[exited with code 130]\n'), { ended: true, killed: false, exitCode: 130, output: 'no line end' });
  assert.deepEqual(read('\n[killed]\n'), { ended: true, killed: true, exitCode: null, output: '' });
  // The last two: a process that printed more as it was killed, and a number no exit code has.
  for (const running of ['', 'x\n[exited with code 0]\nmore\n', 'echo [exited with code 0]\n', '[killed]\n', 'x\n[exited with code 0]', 'x\n[exited with code]\n', 'x\n[killed]\nshutting down\n', `x\n[exited with code ${'9'.repeat(400)}]\n`]) {
    assert.equal(read(running).ended, false, JSON.stringify(running));
  }
  const exit = async (text) => {
    put('btask', text);
    return (await wait(['btask', '--max-wait', '0'], { env })).out;
  };
  assert.deepEqual(await exit('\n[killed]\n'), ['ended btask', 'exit code: none, it was killed', 'no output yet']);
  assert.deepEqual(await exit('a\n\n[exited with code unknown]\n'), ['ended btask', 'exit code: unknown', 'last lines of its output (at most 40):', '| a']);
});

test('a task\'s output is told apart from the command\'s own lines, and holds no hidden character but a tab', async (t) => {
  const { env, put } = hostTemp(t);
  put('bfake', 'a\tb\r\n\u001b[2Jc\u0007\u202ed\u200be\u2028f\nended bfake\nexit code: 0\n\u001b\n');
  const { status, out } = await wait(['bfake', '--max-wait', '0'], { env });
  assert.equal(status, 3);
  assert.deepEqual(out.slice(2), ['| a\tb', '| [2Jcdef', '| ended bfake', '| exit code: 0']);
  assert.deepEqual(out.slice(0, 2).filter((line) => line.startsWith('| ')), [], 'the command\'s own lines do not start so');
});

test('a large log is read at its end alone, and at most 40 lines of it are printed', async (t) => {
  const { env, put } = hostTemp(t);
  const lines = Array.from({ length: 50_000 }, (_, i) => `line ${i}`);
  const file = put('blarge', `${lines.join('\n')}\n\n[exited with code 0]\n`);
  assert.ok(readTask(file).output.length < TAIL);
  const { status, out } = await wait(['blarge'], { env });
  assert.deepEqual([status, out.slice(3)], [0, lines.slice(-40).map((line) => `| ${line}`)]);
  // One line longer than what is read still shows its end.
  put('blong', `${'x'.repeat(TAIL * 2)}\n[exited with code 1]\n`);
  assert.equal((await wait(['blong'], { env })).out[1], 'exit code: 1');
});

test('an id that names a path is refused before any file is read, and one with no output in this session is not found', async (t) => {
  const { env, put } = hostTemp(t);
  put('bmine', 'x\n');
  const unread = { ...claudeCode, capabilities: { ...claudeCode.capabilities, taskOutput: { find: () => assert.fail('looked up'), read: () => assert.fail('read') } } };
  for (const id of ['../bmine', 'tasks/bmine', '..', 'b mine', 'bmine\n', 'bmine.output', '']) {
    const refused = await wait([id], { env, host: unread });
    assert.deepEqual([refused.status, refused.out, refused.err], [2, [], ['aidrian wait: a task id holds only letters, digits, _, and -']], JSON.stringify(id));
  }
  // Each leads to a file that is there, were the id taken.
  for (const id of [`../../${OTHER}/tasks/bother`, '../tasks/bmine', './bmine']) assert.equal(findTask({ id, env }), null, id);
  for (const id of ['bnone', 'bother']) {
    assert.deepEqual(await wait([id], { env }), { status: 2, out: [], err: [`aidrian wait: no output of a background task ${id} in this session; repeating the command cannot help: wait with another completion check you have, or report the wait as blocked`] }, id);
  }
  for (const session of [undefined, '', '..', `${SESSION}/tasks/../../${OTHER}`]) {
    assert.equal(findTask({ id: 'bother', env: { ...env, CLAUDE_CODE_SESSION_ID: session } }), null, String(session));
  }
  assert.equal((await wait([], { env })).status, 1);
});

test('a file outside the host\'s temp folder, behind a link, or that is no regular file is never read', (t) => {
  const { base, root, tasks, put, env } = hostTemp(t);
  const secret = path.join(base, 'secret');
  writeFileSync(secret, 'secret\n');
  put('bmine', 'x\n');
  symlinkSync(secret, path.join(tasks(), 'blink.output'));
  symlinkSync(path.join(tasks(OTHER), 'bother.output'), path.join(tasks(), 'binner.output'));
  mkdirSync(path.join(tasks(), 'bdir.output'));
  mkdirSync(path.join(base, 'outside', SESSION, 'tasks'), { recursive: true });
  writeFileSync(path.join(base, 'outside', SESSION, 'tasks/bout.output'), 'out\n');
  symlinkSync(path.join(base, 'outside'), path.join(root, '-linked'));
  for (const id of ['blink', 'binner', 'bdir', 'bout']) assert.equal(findTask({ id, env }), null, id);
  const file = findTask({ id: 'bmine', env });
  assert.equal(file, path.join(tasks(), 'bmine.output'));
  // Swapped for a link once it was found.
  renameSync(file, `${file}.old`);
  symlinkSync(secret, file);
  assert.equal(readTask(file), null);
  // Then a regular file again, whose folder is swapped for a link: opening it without following a link would read it.
  rmSync(file);
  renameSync(`${file}.old`, file);
  renameSync(tasks(), path.join(base, 'moved'));
  symlinkSync(path.join(base, 'moved'), tasks());
  assert.equal(readTask(file), null);
  rmSync(tasks());
  renameSync(path.join(base, 'moved'), tasks());
  assert.equal(readTask(file).output, 'x\n');
  assert.equal(readTask(file, uid + 1), null, 'a file of another user');
  // The same id in two project folders names neither.
  put('btwo', 'x\n');
  put('btwo', 'x\n', SESSION, '-work-other');
  assert.equal(findTask({ id: 'btwo', env }), null);
  // A folder above the host's own may be a link, as /tmp is on macOS, and the host's own may not.
  const under = (name) => ({ ...env, CLAUDE_CODE_TMPDIR: path.join(base, name) });
  symlinkSync(base, path.join(base, 'above'));
  assert.equal(findTask({ id: 'bmine', env: under('above') }), file);
  mkdirSync(path.join(base, 'planted'));
  symlinkSync(root, path.join(base, 'planted', `claude-${uid}`));
  for (const name of ['planted', `planted/claude-${uid}`]) assert.equal(findTask({ id: 'bmine', env: under(name) }), null, name);
  // A temp folder of another user's is not this one's, nor is any on a system with no user ids.
  renameSync(root, path.join(base, `claude-${uid + 1}`));
  assert.equal(findTask({ id: 'bmine', env, uid: uid + 1 }), null);
  renameSync(path.join(base, `claude-${uid + 1}`), path.join(base, 'claude-null'));
  assert.equal(findTask({ id: 'bmine', env, uid: null }), null);
});

test('a task whose output goes away mid-wait is said so, and a temp folder the shell already names whole is read', async (t) => {
  const { root, put, env } = hostTemp(t);
  const file = put('bgone', 'x\n');
  const gone = await wait(['bgone'], { env, time: clock({ 2: () => rmSync(file) }) });
  assert.deepEqual([gone.status, gone.err], [2, ['aidrian wait: the output of background task bgone can no longer be read; repeating the command cannot help: wait with another completion check you have, or report the wait as blocked']]);
  put('bsand', 'x\n\n[exited with code 0]\n');
  assert.equal((await wait(['bsand'], { env: { ...env, CLAUDE_CODE_TMPDIR: root } })).status, 0);
});

test('a host with no way to read a task is refused, and the command runs through aidrian', async (t) => {
  const { env, put } = hostTemp(t);
  const refused = await wait(['bmine'], { env: {}, host: codex });
  assert.deepEqual([refused.status, refused.out], [2, []]);
  assert.deepEqual(refused.err, ['aidrian wait: Codex gives a command no way to read a background task; repeating the command cannot help: wait with another completion check you have, or report the wait as blocked']);
  put('bdone', 'ok\n\n[exited with code 0]\n');
  // Codex is detected first, so its variables must not reach the call.
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('CODEX_') && !name.startsWith('PLUGIN_')));
  const run = async (...args) => Object.values(await cliCall(['wait', ...args], { env: { ...clean, ...env } }));
  assert.deepEqual(await run('bdone'), [0, 'ended bdone\nexit code: 0\nlast lines of its output (at most 40):\n| ok\n', '']);
  put('brun', '');
  assert.deepEqual(await run('brun', '--max-wait', '0'), [3, 'running brun: run the command again to keep waiting, unless the host says the task ended\nno output yet\n', '']);
  assert.deepEqual(await run('bnone'), [2, '', 'aidrian wait: no output of a background task bnone in this session; repeating the command cannot help: wait with another completion check you have, or report the wait as blocked\n']);
});

test('what a subagent is told of a long command takes every number from its host\'s adapter', () => {
  const host = { name: 'Fake Host', capabilities: { foregroundLimit: 90, waitCall: { seconds: 60, toolTimeout: 75 } } };
  assert.equal(longCommandLine(host), 'Long commands: Fake Host may move a command still running after 90 seconds to the background, whatever timeout the call asks for; ' +
    'expect it for a long push or CI wait. Then wait for it in calls of at most 60 seconds each, with a tool timeout of 75 seconds, until it ends.');
  assert.match(longCommandLine(claudeCode), /after 180 seconds .*aidrian`? wait <task id>`.* at most 150 seconds each, with a tool timeout of 170 seconds, until its first line starts with `ended`, or the host says the task ended\. Exit 3 means the task still runs: wait again\. Exit 2 means no output was found, and repeating the command cannot help: wait with another completion check you have, or report the wait as blocked\.$/u);
  assert.deepEqual([longCommandLine(codex), longCommandLine({ capabilities: {} })], [null, null]);
  const shell = { id: 'b1', type: 'shell' };
  const agent = { id: 'a1', type: 'subagent' };
  assert.match(waitWords(claudeCode, [shell, { id: 'b2', type: 'shell' }]), /^run `\S*aidrian wait b1`, `\S*aidrian wait b2`, in calls of at most 150 seconds each, with a tool timeout of 170 seconds, and repeat each while it exits 3, until its first line starts with `ended`, or the host says the task ended; on exit 2 no output was found, and repeating the command cannot help: wait with another completion check you have, or report the wait as blocked\. $/u);
  assert.match(waitWords(claudeCode, [shell, agent]), /aidrian wait b1`.*; poll any other task with a foreground command/u);
  assert.match(waitWords(codex, [shell]), /^poll it with a foreground command whose loop ends on its own before the command's timeout/u);
  assert.match(movedWords(claudeCode), /Claude Code may move one still running after 180 seconds whatever its timeout$/u);
  assert.doesNotMatch(movedWords(codex), /\d/u);
  const { foregroundLimit, waitCall } = claudeCode.capabilities;
  assert.equal(WAIT_STEP, waitCall.seconds, 'the project run\'s wait reads the same number');
  // A skill cannot read the adapter, so the project run's loop holds the numbers a second time.
  const loop = readFileSync(path.join(PLUGIN, 'skills/project-autopilot/references/loop.md'), 'utf8').replace(/\s+/gu, ' ');
  assert.ok(loop.includes(`still running at ${foregroundLimit} s to the background. So \`wait\` runs with \`--max-wait ${waitCall.seconds}\` and a tool timeout of ${waitCall.toolTimeout} s (${waitCall.toolTimeout}000 ms)`));
  assert.deepEqual([...new Set(loop.match(/--max-wait \d{2,}/gu))], [`--max-wait ${waitCall.seconds}`]);
});

test('no agent source or skill names a host\'s limit in seconds, or promises a long foreground command', () => {
  const files = ['agents-src', 'skills'].flatMap((folder) => readdirSync(path.join(PLUGIN, folder), { recursive: true }).map((file) => path.join(folder, file))).filter((file) => file.endsWith('.md'));
  assert.ok(files.length > 50);
  const bad = files.filter((file) => /\b180\W{0,3}second|foreground( command)? with a timeout/iu.test(readFileSync(path.join(PLUGIN, file), 'utf8').replace(/\s+/gu, ' ')));
  assert.deepEqual(bad, []);
});
