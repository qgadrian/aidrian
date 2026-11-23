// The status line fallback script docs/claude-mod.md shows, run as written: it picks the install the mod picks.
import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const doc = readFileSync(new URL('../docs/claude-mod.md', import.meta.url), 'utf8');
const script = /\n```js\n([\s\S]*?)\n```\n/u.exec(doc)[1];

function run(entries, cwd, base) {
  const config = path.join(base, 'config');
  writeFileSync(path.join(config, 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'aidrian@aidrian-harness': entries } }));
  const file = path.join(base, 'statusline.mjs');
  writeFileSync(file, script);
  const ran = spawnSync(process.execPath, [file], { input: JSON.stringify({ workspace: { current_dir: cwd } }), encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: config } });
  return ran.stdout.trim();
}

test('the documented status line script runs the newest install that holds the folder, through links, in any order', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'statusline-doc-'));
  const install = (version) => {
    const folder = path.join(base, 'config/plugins/cache/aidrian-harness/aidrian', version);
    mkdirSync(path.join(folder, 'lib'), { recursive: true });
    writeFileSync(path.join(folder, 'lib/cli.mjs'), `process.stdout.write('cli ${version}');`);
    return folder;
  };
  const [older, newer] = [install('1.2'), install('1.2.3')];
  const project = path.join(base, 'project');
  mkdirSync(project);
  const link = path.join(base, 'link');
  symlinkSync(project, link);
  const local = { scope: 'local', projectPath: project, installPath: older, version: '1.2' };
  const user = { scope: 'user', installPath: newer, version: '1.2.3' };
  assert.equal(run([local, user], project, base), 'cli 1.2.3', 'a stale local entry never outranks a newer user one');
  assert.equal(run([user, local], project, base), 'cli 1.2.3', 'whatever the file order');
  const fresh = { ...local, installPath: newer, version: '1.2.3' };
  assert.equal(run([fresh, { ...user, installPath: older, version: '1.2' }], link, base), 'cli 1.2.3', 'a folder reached through a link still holds');
  assert.equal(run([{ ...fresh, scope: 'other' }, { ...user, installPath: older, version: '1.2' }], project, base), 'cli 1.2', 'an unknown scope holds nothing');
});
