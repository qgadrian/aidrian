import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { GH_EXEC_OPTIONS, GH_MAX_BUFFER_BYTES, ghJson, runGh } from '../plugins/aidrian/lib/gh.mjs';

test('runGh: gh reads carry a stdout ceiling far above the 1 MB default', () => {
  // Regression guard. `repos/{repo}/commits/{sha}` embeds every changed file's
  // patch and measured 1,211,087 B for a large pull request's head commit, so the 1 MB default
  // for a synchronous child process killed `--request` before it could post.
  assert.ok(GH_MAX_BUFFER_BYTES > 4 * 1024 * 1024, 'ceiling must clear a real PR payload by a wide margin');
  assert.equal(GH_EXEC_OPTIONS.maxBuffer, GH_MAX_BUFFER_BYTES);
  assert.equal(GH_EXEC_OPTIONS.encoding, 'utf8');
  const seen = [];
  const fakeExec = (file, args, options) => {
    seen.push({ file, args, options });
    return '{"ok":true}';
  };
  assert.equal(runGh(['api', 'repos/o/r/pulls/1'], { exec: fakeExec }), '{"ok":true}');
  assert.equal(seen[0].file, 'gh');
  assert.deepEqual(seen[0].args, ['api', 'repos/o/r/pulls/1']);
  assert.equal(seen[0].options.maxBuffer, GH_MAX_BUFFER_BYTES);
});

test('runGh: an overflow above the ceiling names the command and the limit; other failures pass through unchanged', () => {
  const throwing = (code, message) => () => {
    throw Object.assign(new Error(message), { code });
  };
  assert.throws(
    () => runGh(['api', 'repos/o/r/commits/abc'], { exec: throwing('ENOBUFS', 'spawnSync gh ENOBUFS') }),
    (err) => {
      assert.match(err.message, /repos\/o\/r\/commits\/abc/, 'names the overflowing command');
      assert.match(err.message, /64 MB stdout ceiling/, 'names the limit that was hit');
      assert.match(err.message, /GH_MAX_BUFFER_BYTES/, 'names the knob to turn');
      return true;
    },
  );
  assert.throws(() => runGh(['api', 'x'], { exec: throwing(1, 'gh: authentication required') }), /authentication required/);
});

test('runGh runs gh in the folder it is given, and ghJson parses what it prints', () => {
  const seen = [];
  const exec = (file, args, options) => {
    seen.push(options.cwd);
    return '{"nameWithOwner":"acme/notes"}';
  };
  assert.deepEqual(ghJson(['repo', 'view', '--json', 'nameWithOwner'], { cwd: '/repo', exec }), { nameWithOwner: 'acme/notes' });
  runGh(['repo', 'view'], { exec });
  assert.deepEqual(seen, ['/repo', undefined]);
});

test('runGh: a real 2 MB stdout survives the ceiling that the 1 MB default rejected', () => {
  // The live-PR proof does not survive the merge that fixes the PR, so the crash
  // is reproduced against a real child process instead. 2 MB is the size class
  // the head-commit read hit on a large pull request (1,211,087 B), where the endpoint embeds
  // every changed file's patch.
  const payloadBytes = 2 * 1024 * 1024;
  const writeStdout = ['-e', `process.stdout.write('x'.repeat(${payloadBytes}))`];
  // Pre-fix shape: the options this script used to pass, on the same call shape.
  assert.throws(
    () => execFileSync('node', writeStdout, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    (err) => err.code === 'ENOBUFS',
    'the pre-fix options must still reproduce the crash, or this test proves nothing',
  );
  // Post-fix shape: runGh's options forwarded to a real child process.
  const viaNode = (_file, args, options) => execFileSync('node', args, options);
  assert.equal(runGh(writeStdout, { exec: viaNode }).length, payloadBytes);
  // A genuine overflow above the new ceiling still reaches the caller as actionable text.
  const viaNodeCapped = (_file, args, options) => execFileSync('node', args, { ...options, maxBuffer: 1024 });
  assert.throws(() => runGh(writeStdout, { exec: viaNodeCapped }), /stdout ceiling[\s\S]*GH_MAX_BUFFER_BYTES/);
});

test('every gh call in the plugin goes through lib/gh.mjs, so none inherits the 1 MB default', () => {
  const plugin = path.resolve(import.meta.dirname, '../plugins/aidrian');
  const files = (dir) => readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    return statSync(file).isDirectory() ? files(file) : file.endsWith('.mjs') ? [file] : [];
  });
  const direct = files(plugin).filter((file) => !file.endsWith(`${path.sep}lib${path.sep}gh.mjs`) && /\b(?:execFileSync|execFile|spawnSync|spawn)\(\s*'gh'/u.test(readFileSync(file, 'utf8')));
  assert.deepEqual(direct.map((file) => path.relative(plugin, file)), []);
});
