// The status line fallback script docs/claude-mod.md shows, run as written: it runs the newest cached release's cli.
import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const doc = readFileSync(new URL('../docs/claude-mod.md', import.meta.url), 'utf8');
const script = /\n```js\n([\s\S]*?)\n```\n/u.exec(doc)[1];

test('the documented status line script runs the newest cached release that has a cli, never a stale one', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'statusline-doc-'));
  const config = path.join(base, 'config');
  const release = (name, { isCli = true } = {}) => {
    const lib = path.join(config, 'plugins/cache/aidrian-harness/aidrian', name, 'lib');
    if (isCli) {
      mkdirSync(lib, { recursive: true });
      writeFileSync(path.join(lib, 'cli.mjs'), `process.stdout.write('cli ${name}');`);
    } else {
      mkdirSync(path.join(lib, 'cli.mjs'), { recursive: true });
    }
  };
  const file = path.join(base, 'statusline.mjs');
  writeFileSync(file, script);
  const run = () => spawnSync(process.execPath, [file], {
    input: JSON.stringify({ workspace: { current_dir: base } }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: config },
  }).stdout.trim();

  release('0.7.0');
  release('0.9.0');
  release('0.10.0');
  assert.equal(run(), 'cli 0.10.0', 'versions compare as numbers');
  release('0.11.0', { isCli: false });
  release('0.12.0-beta');
  assert.equal(run(), 'cli 0.10.0', 'a release with no cli file, and a folder that is no release, are passed over');
});
