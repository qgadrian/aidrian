// The reflog reader of the session ledger (lib/git-push.mjs pushedRefs): which remote-tracking refs a push updated, as
// git recorded it, read from a git common dir built here.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { PUSH_WINDOW_MS, pushedRefs } from '../plugins/aidrian/lib/git-push.mjs';

const ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-git-push-')));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const NOW = Date.now();

// One reflog line as git writes it, at `at` in ms, with `message`.
const entry = (at, message = 'update by push') => `${'0'.repeat(40)} ${'1'.repeat(40)} T <t@t.test> ${Math.floor(at / 1000)} +0000\t${message}\n`;

// Writes the reflog of the remote-tracking ref `ref` (a path under refs/remotes/) in `common` with `text`.
function log(common, ref, text) {
  const file = path.join(common, 'logs/refs/remotes', ref);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

test('a ref counts only when its log`s last line is a push within the window', () => {
  const common = path.join(ROOT, 'window');
  log(common, 'origin/feat/new', `${entry(NOW - 5 * PUSH_WINDOW_MS, 'fetch: fast-forward')}${entry(NOW)}`);
  log(common, 'origin/old', entry(NOW - 2 * PUSH_WINDOW_MS));
  log(common, 'origin/fetched', entry(NOW, 'fetch: fast-forward'));
  log(common, 'origin/pushed-then-fetched', `${entry(NOW)}${entry(NOW, 'fetch: fast-forward')}`);
  const stale = log(common, 'origin/untouched', entry(NOW));
  utimesSync(stale, new Date(NOW - 2 * PUSH_WINDOW_MS), new Date(NOW - 2 * PUSH_WINDOW_MS));
  assert.deepEqual(pushedRefs(common, NOW), ['origin/feat/new']);
});

test('a symlinked log is never read', { skip: process.platform === 'win32' }, () => {
  const common = path.join(ROOT, 'symlink');
  const real = path.join(ROOT, 'elsewhere.log');
  writeFileSync(real, entry(NOW));
  mkdirSync(path.join(common, 'logs/refs/remotes/origin'), { recursive: true });
  symlinkSync(real, path.join(common, 'logs/refs/remotes/origin/linked'));
  mkdirSync(path.join(ROOT, 'elsewhere-dir/feat'), { recursive: true });
  writeFileSync(path.join(ROOT, 'elsewhere-dir/feat/x'), entry(NOW));
  symlinkSync(path.join(ROOT, 'elsewhere-dir'), path.join(common, 'logs/refs/remotes/upstream'));
  assert.deepEqual(pushedRefs(common, NOW), []);
});

test('a common dir with no logs, as a reftable repository has, gives none', () => {
  assert.deepEqual(pushedRefs(path.join(ROOT, 'no-such-dir'), NOW), []);
});
