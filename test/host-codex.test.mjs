// What Codex needs from its adapter for the tracker write guard (docs/hooks.md#where-the-tracker-guard-is-verified): its app
// connectors' tool names, and the warnings of `aidrian check` while the guard cannot hold there. No live Codex runs here.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import codex from '../plugins/aidrian/lib/hosts/codex.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'plugins/aidrian/bin/aidrian');
const SHORT = { enabled: true, provider: 'linear', workspace: { expect: 'https://linear.app/acme' }, team: { key: 'NOTES', values: ['Notes'] } };

function folder(t) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-hosts-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function check(t, tracker, codexConfig) {
  const dir = folder(t);
  execFileSync('git', ['init', '-q', dir]);
  for (const entry of ['.aidrian', 'docs', '.gitignore']) cpSync(path.join(ROOT, 'examples/consumer', entry), path.join(dir, entry), { recursive: true });
  const config = JSON.parse(readFileSync(path.join(dir, '.aidrian/config.json'), 'utf8'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ ...config, tracker }));
  const home = folder(t);
  if (codexConfig !== undefined) writeFileSync(path.join(home, 'config.toml'), codexConfig);
  return spawnSync(CLI, ['check', '--project', dir], { encoding: 'utf8', env: { ...process.env, CODEX_HOME: home } });
}

const INSTALLED = '[plugins."aidrian@aidrian-harness"]\nenabled = true\n';
const trust = (key) => `[hooks.state."aidrian@aidrian-harness:hooks/hooks.json:${key}"]\ntrusted_hash = "sha256:x"\n`;
const TRUSTED = `${INSTALLED}${trust('pre_tool_use:5:0')}${trust('post_tool_use:3:0')}`;
const WRITTEN_OUT = {
  enabled: true,
  workspace: { expect: 'https://linear.app/acme', field: 'url' },
  readTools: ['mcp__plugin_linear_linear__get_workspace'],
  writeTools: ['mcp__plugin_linear_linear__save_*'],
  team: { key: 'NOTES', values: ['Notes'], createFields: ['team'], keyFields: ['id'] },
};

test('aidrian check warns while Codex has the plugin and no trust on record, and stops once it does', (t) => {
  const untrusted = check(t, SHORT, INSTALLED);
  assert.equal(untrusted.status, 0, untrusted.stderr);
  assert.match(untrusted.stderr, /warning: tracker\.enabled: Codex has no trust on record for this plugin's hooks/u);
  assert.match(untrusted.stderr, /\/hooks/u, 'it says the step');
  const trusted = check(t, SHORT, TRUSTED);
  assert.doesNotMatch(trusted.stderr, /no trust on record/u);
});

test('aidrian check still warns when only an unrelated or one tracker hook is trusted', (t) => {
  for (const partial of [trust('pre_tool_use:6:0'), trust('pre_tool_use:5:0'), trust('post_tool_use:3:0')]) {
    assert.match(check(t, SHORT, INSTALLED + partial).stderr, /no trust on record/u, partial);
  }
});

test('aidrian check says nothing of a Codex that is absent, or a tracker that is off', (t) => {
  assert.doesNotMatch(check(t, SHORT).stderr, /tracker/u);
  assert.doesNotMatch(check(t, SHORT, 'model = "x"\n').stderr, /tracker/u);
  assert.doesNotMatch(check(t, { ...SHORT, enabled: false }, INSTALLED).stderr, /tracker/u);
});

test('aidrian check warns an adopted key that leaves out Codex\'s app route, and keeps it working', (t) => {
  const { status, stderr } = check(t, WRITTEN_OUT, TRUSTED);
  assert.equal(status, 0, stderr);
  assert.match(stderr, /warning: tracker\.writeTools: no pattern covers Linear's server "codex_apps_linear" on Codex/u);
  assert.match(stderr, /set "provider": "linear" and drop both tool lists/u);
  assert.doesNotMatch(check(t, SHORT, TRUSTED).stderr, /tracker\.writeTools/u);
  assert.doesNotMatch(check(t, WRITTEN_OUT).stderr, /tracker/u, 'with no Codex here, nothing');
});

test('a hook trusted and then turned off is off, and a header with no hash is no trust', (t) => {
  const bare = (key, body) => `[hooks.state."aidrian@aidrian-harness:hooks/hooks.json:${key}"]\n${body}`;
  const off = check(t, SHORT, `${INSTALLED}${bare('pre_tool_use:5:0', 'trusted_hash = "sha256:x"\nenabled = false\n')}${trust('post_tool_use:3:0')}`);
  assert.match(off.stderr, /warning: tracker\.enabled: Codex has this plugin or its tracker hooks turned off/u);
  assert.match(off.stderr, /turn them back on/u);
  assert.doesNotMatch(off.stderr, /no trust on record/u);

  const noHash = check(t, SHORT, `${INSTALLED}${bare('pre_tool_use:5:0', 'enabled = true\n')}${bare('post_tool_use:3:0', 'enabled = true\n')}`);
  assert.match(noHash.stderr, /no trust on record/u);

  const pluginOff = check(t, SHORT, '[plugins."aidrian@aidrian-harness"]\nenabled = false\n');
  assert.match(pluginOff.stderr, /turned off/u);

  const emptyHash = check(t, SHORT, `${INSTALLED}${bare('pre_tool_use:5:0', 'trusted_hash = ""\n')}${trust('post_tool_use:3:0')}`);
  assert.match(emptyHash.stderr, /no trust on record/u);

  const later = `${INSTALLED}${bare('pre_tool_use:5:0', '')}[other]\nenabled = false\ntrusted_hash = "sha256:x"\n${trust('post_tool_use:3:0')}`;
  assert.match(check(t, SHORT, later).stderr, /no trust on record/u, 'a value of the next section is not this one');
});

test('hook trust reads only the sections it needs, and never returns the file\'s values', (t) => {
  const home = folder(t);
  const read = codex.capabilities.trackerGuard.hookTrust;
  assert.equal(read({ CODEX_HOME: home }), 'absent', 'no config');
  writeFileSync(path.join(home, 'config.toml'), `token = "a-secret"\n${INSTALLED}`);
  assert.equal(read({ CODEX_HOME: home }), 'untrusted');
  writeFileSync(path.join(home, 'config.toml'), `[hooks.state."/x/.codex/hooks.json:pre_tool_use:0:0"]\n${INSTALLED}`);
  assert.equal(read({ CODEX_HOME: home }), 'untrusted', 'a hook of another source is not this plugin\'s');
  writeFileSync(path.join(home, 'config.toml'), `token = "a-secret"\n${TRUSTED}`);
  assert.equal(read({ CODEX_HOME: home }), 'trusted');
  assert.deepEqual(['absent', 'untrusted', 'off', 'trusted'].includes(read({ CODEX_HOME: home })), true, 'one of four words, never a value');
});

test('Codex: an app connector\'s tool reads as a server of its own, in the hook form and the flat form', () => {
  const { toolName } = codex;
  assert.equal(toolName('mcp__codex_apps__linear__save_issue'), 'mcp__codex_apps_linear__save_issue');
  assert.equal(toolName('mcp__codex_apps__linear_save_issue'), 'mcp__codex_apps_linear__save_issue');
  assert.equal(toolName('mcp__codex_apps__chatgpt_space__edit_page'), 'mcp__codex_apps_chatgpt_space__edit_page');
  assert.equal(toolName('mcp__codex_apps_linear__save_issue'), 'mcp__codex_apps_linear__save_issue', 'idempotent');
  assert.equal(toolName('mcp__linear__save_issue'), 'mcp__linear__save_issue', 'an MCP server stays');
  assert.equal(toolName('Bash'), 'Bash');
  assert.equal(toolName(undefined), undefined);
});

test('Codex: structuredContent answers when the tool sends it, over a text block', () => {
  const objects = codex.toolResponse({ content: [{ type: 'text', text: '{"url":"block"}' }], structuredContent: { url: 'structured' } });
  assert.deepEqual(objects.map((each) => each.url), [undefined, 'structured', 'block']);
  assert.deepEqual(codex.toolResponse('not json'), []);
});
