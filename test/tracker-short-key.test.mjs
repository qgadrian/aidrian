// The short `tracker` key (docs/config.md#tracker): `provider` fills in what a person does not know, a list or field the
// file sets overrides it, and a key written out in full, as adopted projects have it, loads as it always did.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { judgeTrackerWrite } from '../plugins/aidrian/lib/tracker-guard.mjs';

const SHORT = { enabled: true, provider: 'linear', workspace: { expect: 'https://linear.app/acme' }, team: { key: 'NOTES', values: ['Notes'] } };

function folder(t) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-hosts-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function load(t, tracker) {
  const dir = folder(t);
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, tracker }));
  return loadConfig({ root: dir, paths: { config: '.aidrian/config.json' } });
}

test('the short key loads with the adapter filling in tools and fields, on every known server', (t) => {
  const { config, errors } = load(t, SHORT);
  assert.deepEqual(errors, []);
  const { tracker } = config;
  assert.equal(tracker.enabled, true);
  assert.equal(tracker.provider, 'linear');
  assert.deepEqual(tracker.workspace, { expect: 'https://linear.app/acme', field: 'url' });
  assert.deepEqual(tracker.team, { key: 'NOTES', values: ['Notes'], createFields: ['team', 'addTeams', 'setTeams', 'leadTeam'], keyFields: ['id', 'issueId', 'issue'] });
  assert.equal(tracker.project, null);
  for (const server of ['linear', 'linear-server', 'plugin_linear_linear', 'claude_ai_Linear', 'codex_apps_linear']) {
    assert.ok(tracker.readTools.includes(`mcp__${server}__get_workspace`), server);
    assert.ok(tracker.writeTools.includes(`mcp__${server}__save_*`), server);
    assert.ok(tracker.writeTools.includes(`mcp__${server}__resolve_diff_thread`), server);
  }
  assert.ok(!tracker.writeTools.some((pattern) => pattern.includes('mark_notification')), 'it changes only one inbox');
});

test('the guard judges a short key as it judges a key written out', (t) => {
  const { config } = load(t, SHORT);
  const settings = { tracker: config.tracker, names: { human: 'the Human' } };
  const write = 'mcp__codex_apps_linear__save_issue';
  const record = { value: 'https://linear.app/acme', tool: 'mcp__codex_apps_linear__get_workspace' };
  assert.match(judgeTrackerWrite(settings, write, { team: 'Notes' }, null).reason, /Call mcp__codex_apps_linear__get_workspace, then write again/u);
  assert.equal(judgeTrackerWrite(settings, write, { team: 'Notes' }, record), null);
  assert.match(judgeTrackerWrite(settings, write, { team: 'Other' }, record).reason, /team is "Other"/u);
  assert.match(judgeTrackerWrite(settings, write, { id: 'OTHER-1' }, record).reason, /whose prefix is not tracker\.team\.key/u);
  assert.match(judgeTrackerWrite(settings, write, {}, { ...record, value: 'https://linear.app/other' }).reason, /the connected workspace is/u);
  assert.equal(judgeTrackerWrite(settings, 'mcp__codex_apps_linear__get_issue', {}, null), null, 'a read is not judged');
});

test('a list or a field the file sets overrides the adapter', (t) => {
  const { config, errors } = load(t, {
    ...SHORT,
    workspace: { expect: 'https://linear.app/acme', field: 'organizationUrl' },
    readTools: ['mcp__mine__get_workspace'],
    writeTools: ['mcp__mine__save_*'],
    team: { key: 'NOTES', values: ['Notes'], createFields: ['team'], keyFields: ['id'] },
  });
  assert.deepEqual(errors, []);
  assert.equal(config.tracker.workspace.field, 'organizationUrl');
  assert.deepEqual(config.tracker.readTools, ['mcp__mine__get_workspace']);
  assert.deepEqual(config.tracker.writeTools, ['mcp__mine__save_*']);
  assert.deepEqual(config.tracker.team.createFields, ['team']);
});

test('`servers` adds a connection under a name the adapter does not know', (t) => {
  const { config, errors } = load(t, { ...SHORT, servers: ['acme-linear'] });
  assert.deepEqual(errors, []);
  assert.ok(config.tracker.readTools.includes('mcp__acme-linear__get_workspace'));
  assert.ok(config.tracker.writeTools.includes('mcp__acme-linear__save_*'));
  assert.ok(config.tracker.readTools.includes('mcp__linear__get_workspace'), 'beside the known ones');
});

test('a provider with no workspace brings no read tools, since the two are set together', (t) => {
  const { config, errors } = load(t, { enabled: true, provider: 'linear', team: { key: 'NOTES', values: ['Notes'] } });
  assert.deepEqual(errors, []);
  assert.equal(config.tracker.enabled, true);
  assert.equal(config.tracker.workspace, null);
  assert.deepEqual(config.tracker.readTools, []);
  assert.ok(config.tracker.writeTools.length > 0);
});

test('a provider with neither a workspace, team, nor project still says what it needs', (t) => {
  const { config, errors } = load(t, { enabled: true, provider: 'linear' });
  assert.match(errors.join('\n'), /"tracker\.enabled" needs one of "tracker\.workspace", "tracker\.team", or "tracker\.project"/u);
  assert.equal(config.tracker.enabled, false);
});

test('a provider no adapter has is one error, and leaves the key off', (t) => {
  const { config, errors } = load(t, { ...SHORT, provider: 'jira' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /"tracker\.provider" must be "linear"/u);
  assert.equal(config.tracker.enabled, false);
});

test('`servers` is a list of server names, and needs a provider', (t) => {
  for (const servers of ['acme', [''], ['a__b'], ['mcp__a'].map((name) => `${name}*`), [1]]) {
    const { errors, config } = load(t, { ...SHORT, servers });
    assert.match(errors.join('\n'), /"tracker\.servers" must be a list of server names/u, JSON.stringify(servers));
    assert.equal(config.tracker.enabled, false);
  }
  const written = { enabled: true, writeTools: ['mcp__x__save_*'], team: { key: 'A', values: ['A'], createFields: ['team'], keyFields: ['id'] }, servers: ['acme'] };
  assert.match(load(t, written).errors.join('\n'), /"tracker\.servers" needs "tracker\.provider"/u);
});

test('`servers` beside a file\'s writeTools is an error that names the server, since it would go unwatched', (t) => {
  const { errors, config } = load(t, { ...SHORT, servers: ['acme-linear', 'other'], writeTools: ['mcp__linear__save_*'], readTools: ['mcp__linear__get_workspace'] });
  assert.equal(errors.length, 2);
  assert.match(errors[0], /"tracker\.servers" has "acme-linear", but "tracker\.writeTools" replaces the list it adds to/u);
  assert.match(errors[1], /"other"/u);
  assert.deepEqual(config.tracker.writeTools, ['mcp__linear__save_*'], 'the guard keeps what is written');
});

test('read tools alone under a provider give one clear error, not one per pattern', (t) => {
  const { errors } = load(t, { ...SHORT, readTools: ['mcp__plugin_linear_linear__get_workspace'] });
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /"tracker\.readTools" replaces the adapter's and leaves no read on mcp__linear__/u);
  assert.match(errors[0], /drop "tracker\.readTools"/u);
});

test('a null list under a provider is the same error as without one, and fills nothing in', (t) => {
  for (const key of ['writeTools', 'readTools']) {
    const { errors } = load(t, { ...SHORT, [key]: null });
    assert.ok(errors.some((each) => each.includes(`"tracker.${key}" must be a list`)), `${key}: ${errors.join('\n')}`);
  }
});

test('the keys an adapter can fill are checked when written by hand', (t) => {
  const written = { enabled: true, workspace: { expect: 'x', field: 'cloudId' }, writeTools: ['mcp__x__save_*'], workspaceInput: 'cloudId', readVerbs: ['get*'], idHint: 'use its key' };
  const { config, errors } = load(t, written);
  assert.deepEqual(errors, []);
  assert.equal(config.tracker.enabled, true);
  assert.equal(config.tracker.workspaceInput, 'cloudId');
  assert.deepEqual(config.tracker.readVerbs, ['get*']);
  assert.equal(config.tracker.idHint, 'use its key');
  assert.match(load(t, { ...written, workspaceInput: 1 }).errors.join('\n'), /"tracker\.workspaceInput" must be a non-empty string/u);
  assert.match(load(t, { ...written, readVerbs: 'get*' }).errors.join('\n'), /"tracker\.readVerbs" must be a list/u);
});

test('a team written by its key alone holds that key as its one value, under a provider', (t) => {
  const { config, errors } = load(t, { enabled: true, provider: 'linear', team: { key: 'X' } });
  assert.deepEqual(errors, []);
  assert.deepEqual(config.tracker.team.values, ['X']);
});

test('a key written out in full loads exactly as before, with no provider in it', (t) => {
  const tracker = {
    enabled: true,
    workspace: { expect: 'https://linear.app/acme', field: 'url' },
    readTools: ['mcp__plugin_linear_linear__get_workspace'],
    writeTools: ['mcp__plugin_linear_linear__save_*'],
    team: { key: 'NOTES', values: ['Notes'], createFields: ['team'], keyFields: ['id'] },
    project: null,
  };
  const { config, errors } = load(t, tracker);
  assert.deepEqual(errors, []);
  assert.deepEqual(config.tracker, tracker);
});
