// The status line fallback script docs/claude-mod.md shows, run as written: it picks the install the mod picks.
import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const doc = readFileSync(new URL('../docs/claude-mod.md', import.meta.url), 'utf8');
const script = /\n```js\n([\s\S]*?)\n```\n/u.exec(doc)[1];

function setup() {
  const base = mkdtempSync(path.join(tmpdir(), 'statusline-doc-'));
  const config = path.join(base, 'config');
  const cache = path.join(config, 'plugins/cache/aidrian-harness/aidrian');
  // An install whose cli prints its name, so a test tells which one ran; a cache-only release has no record.
  const install = (name) => {
    mkdirSync(path.join(cache, name, 'lib'), { recursive: true });
    writeFileSync(path.join(cache, name, 'lib/cli.mjs'), `process.stdout.write('cli ${name}');`);
    return path.join(cache, name);
  };
  const file = path.join(base, 'statusline.mjs');
  writeFileSync(file, script);
  const run = (records, cwd) => {
    writeFileSync(path.join(config, 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'aidrian@aidrian-harness': records } }));
    const input = JSON.stringify({ workspace: { current_dir: cwd } });
    return spawnSync(process.execPath, [file], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: config } }).stdout.trim();
  };
  const project = path.join(base, 'project');
  mkdirSync(path.join(project, 'app'), { recursive: true });
  return { base, install, run, project };
}

test('the documented script runs the newest install of the folder`s records, in any order, through links', () => {
  const { base, install, run, project } = setup();
  const [older, newer] = [install('1.2'), install('1.2.3')];
  install('9.0.0');
  const local = { scope: 'local', projectPath: project, installPath: older, version: '1.2' };
  const user = { scope: 'user', installPath: newer, version: '1.2.3' };
  assert.equal(run([local, user], project), 'cli 1.2.3', 'a stale local entry never outranks a newer user one');
  assert.equal(run([user, local], project), 'cli 1.2.3', 'whatever the file order');
  assert.equal(run([null, local], project), 'cli 1.2', 'a malformed record is skipped, and a cache-only release never runs');
  const link = path.join(base, 'link');
  symlinkSync(project, link);
  const fresh = { ...local, installPath: newer, version: '1.2.3' };
  assert.equal(run([fresh, { ...user, installPath: older, version: '1.2' }], link), 'cli 1.2.3', 'a folder reached through a link still holds');
  assert.equal(run([{ ...fresh, scope: 'other' }, { ...user, installPath: older, version: '1.2' }], project), 'cli 1.2', 'an unknown scope holds nothing');
  assert.equal(run([{ ...fresh, version: 'unknown', installPath: older }, user], project), 'cli 1.2.3', 'a version that is not numbers ranks last');
  assert.equal(run([{ ...user, installPath: older, version: '1.2' }, user], project), 'cli 1.2', 'only the first user record counts');
});

test('the documented script breaks a tie as the mod does, and refuses a cli it cannot run', () => {
  const { install, run, project } = setup();
  const [one, two] = [install('one'), install('two')];
  const same = (scope, projectPath, installPath) => ({ scope, projectPath, installPath, version: '1.2.3' });
  const nested = path.join(project, 'app');
  for (const [records, expected, why] of [
    [[same('user', undefined, one), same('local', project, two)], 'cli two', 'local over user'],
    [[same('project', project, one), same('local', project, two)], 'cli two', 'local over project'],
    [[same('local', project, one), same('local', nested, two)], 'cli two', 'the deeper folder'],
    [[same('user', undefined, one), same('local', '/', two)], 'cli two', 'a root folder holds every folder'],
  ]) {
    assert.equal(run(records, nested), expected, why);
    assert.equal(run([...records].reverse(), nested), expected, `${why}, in either order`);
  }
  const fallback = same('local', project, one);
  const asFolder = install('folder');
  rmSync(path.join(asFolder, 'lib/cli.mjs'));
  mkdirSync(path.join(asFolder, 'lib/cli.mjs'));
  assert.equal(run([{ ...fallback, installPath: asFolder, version: '2.0.0' }, fallback], project), '', 'a folder at lib/cli.mjs is no cli: a blank line, no older install');
  // A relative path that would resolve, from the session's folder, to a cli printing a marker: the script refuses it.
  mkdirSync(path.join(project, 'relative/lib'), { recursive: true });
  writeFileSync(path.join(project, 'relative/lib/cli.mjs'), "process.stdout.write('ran the relative cli');");
  assert.equal(run([{ ...fallback, installPath: 'relative', version: '2.0.0' }, fallback], project), '', 'a relative install path is refused');
  assert.equal(run([{ ...fallback, installPath: path.join(project, 'relative'), version: '2.0.0' }, fallback], project), '', 'an install outside the plugin cache is refused');
  const linked = path.join(path.dirname(one), 'linked');
  symlinkSync(path.join(project, 'relative'), linked);
  assert.equal(run([{ ...fallback, installPath: linked, version: '2.0.0' }, fallback], project), '', 'and so is a link in the cache that leads out of it');
});
