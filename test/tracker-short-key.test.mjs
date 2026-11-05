// The short `tracker` key (docs/config.md#tracker): `provider` fills in what a person does not know, a list or field the
// file sets overrides it, and a key written out in full, as adopted projects have it, loads as it always did.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import codex from '../plugins/aidrian/lib/hosts/codex.mjs';
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
  const noProvider = { enabled: true, writeTools: ['mcp__x__save_*'], team: { key: 'A', values: ['A'], createFields: ['team'], keyFields: ['id'] }, servers: ['acme'] };
  assert.match(load(t, noProvider).errors.join('\n'), /"tracker\.servers" needs "tracker\.provider"/u);
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

const WS = { expect: 'https://linear.app/acme', field: 'url' };
const written = (readTools, writeTools) => ({ enabled: true, workspace: WS, readTools, writeTools });

test('a read and a write on one Codex connector pair in any mix of its forms', (t) => {
  for (const [reads, writes] of [
    [['mcp__codex_apps__linear__get_workspace'], ['mcp__codex_apps_linear__save_*']],
    [['mcp__codex_apps_linear__get_workspace'], ['mcp__codex_apps__linear__save_*']],
    [['mcp__codex_apps__linear__get_workspace'], ['mcp__codex_apps__linear__save_*']],
    [['mcp__codex_apps__linear__get_workspace'], ['mcp__codex_apps_linear__save_issue']],
  ]) {
    const { errors, config } = load(t, written(reads, writes));
    assert.deepEqual(errors, [], JSON.stringify([reads, writes]));
    assert.equal(config.tracker.workspace.expect, WS.expect);
  }
});

test('a write on one connector with a read on another is an error, as the guard would refuse it', (t) => {
  const { errors } = load(t, written(['mcp__codex_apps__linear__get_workspace'], ['mcp__codex_apps__github__save_*']));
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /"mcp__codex_apps__github__save_\*": no tool in "tracker\.readTools" is on its server/u);
});

test('a pattern as wide as the raw prefix over a read is an error, and with the read in the other form the guard still holds', (t) => {
  const wide = ['mcp__codex_apps__*'];
  const same = load(t, written(['mcp__codex_apps__linear__get_workspace'], wide));
  assert.match(same.errors.join('\n'), /covers it/u, 'in one form the read goes, as on main');
  assert.equal(same.config.tracker.workspace, null);

  const other = load(t, written(['mcp__codex_apps_linear__get_workspace'], wide));
  assert.match(other.errors.join('\n'), /covers it/u);
  assert.equal(other.config.tracker.enabled, true);
  assert.equal(other.config.tracker.workspace.expect, WS.expect);
  const settings = { tracker: other.config.tracker, names: { human: 'the Human' } };
  for (const raw of ['mcp__codex_apps__github__save_file', 'mcp__codex_apps__linear__save_issue']) {
    assert.ok(judgeTrackerWrite(settings, codex.toolName(raw), {}, null, { rawTool: raw }), raw);
  }
  assert.match(load(t, written(['mcp__linear__get_workspace'], wide)).errors.join('\n'), /is on its server/u, 'with no read under it, none can clear it');
});

test('a write pattern no host can send is reported, and one that reaches a raw name is not', (t) => {
  const read = ['mcp__codex_apps_linear__get_workspace'];
  for (const pattern of ['mcp__codex_apps__linear_save_*', 'mcp__codex_apps__jira_save_*', 'mcp__codex_apps__linear_save_issue']) {
    const { errors, config } = load(t, written(read, [pattern]));
    assert.match(errors.join('\n'), /no host sends a name this matches/u, pattern);
    assert.deepEqual(config.tracker.writeTools, [pattern], 'it stays, as a report');
  }
  for (const pattern of ['mcp__codex_apps__linear_*', 'mcp__codex_apps__linear__save_*', 'mcp__codex_apps_linear__save_*', 'mcp__codex_apps__linear__save_issue', 'mcp__linear__save_*', 'mcp__*', 'mcp__codex_apps__*', 'mcp__codex_apps_*']) {
    assert.doesNotMatch(load(t, written(read, [pattern])).errors.join('\n'), /no host sends/u, pattern);
  }
});

test('a read a write pattern covers in another form is reported, and stays, so the guard stays on', (t) => {
  const { errors, config } = load(t, written(['mcp__codex_apps__linear__get_workspace'], ['mcp__codex_apps_linear__get_*']));
  assert.match(errors.join('\n'), /a read tool cannot also match "tracker\.writeTools", and "mcp__codex_apps_linear__get_\*" covers it/u);
  assert.equal(config.tracker.enabled, true);
  assert.equal(config.tracker.workspace.expect, WS.expect);
  const raw = load(t, written(['mcp__codex_apps_linear__get_workspace'], ['mcp__codex_apps__linear__get_*']));
  assert.match(raw.errors.join('\n'), /covers it/u);
});

test('the flat form only a model sees is reported as matching nothing, with the name to use', (t) => {
  const { errors } = load(t, written(['mcp__codex_apps__linear_get_workspace'], ['mcp__codex_apps__linear__save_*']));
  assert.match(errors.join('\n'), /"mcp__codex_apps__linear_get_workspace": no host sends this name, .* name it as "mcp__codex_apps_linear__get_workspace"/u);
});

test('a flat read beside a working one keeps the guard on for every host', (t) => {
  const { errors, config } = load(t, written(['mcp__linear__get_workspace', 'mcp__codex_apps__linear_get_workspace'], ['mcp__linear__save_*', 'mcp__codex_apps__linear__save_*']));
  assert.match(errors.join('\n'), /no host sends this name/u);
  assert.equal(config.tracker.enabled, true);
  assert.equal(config.tracker.readTools.length, 2);
  const settings = { tracker: config.tracker, names: { human: 'the Human' } };
  assert.match(judgeTrackerWrite(settings, 'mcp__linear__save_issue', {}, null).reason, /Call mcp__linear__get_workspace, then write again/u, 'a Claude Code write is still refused');
  assert.equal(judgeTrackerWrite(settings, 'mcp__linear__save_issue', {}, { value: WS.expect, tool: 'mcp__linear__get_workspace' }), null);
  assert.ok(judgeTrackerWrite(settings, 'mcp__codex_apps_linear__save_issue', {}, null, { rawTool: 'mcp__codex_apps__linear__save_issue' }));
});

test('no name to use is offered when the flat form does not say where the connector ends', (t) => {
  const { errors } = load(t, written(['mcp__codex_apps__google_drive_get_workspace'], ['mcp__codex_apps__google_drive__save_*']));
  const line = errors.find((each) => each.includes('no host sends this name'));
  assert.ok(line, errors.join('\n'));
  assert.doesNotMatch(line, /name it as/u);
});

test('servers codex_apps offers no name for the read it generates, and the guard stays on', (t) => {
  const { errors, config } = load(t, { enabled: true, provider: 'linear', workspace: { expect: WS.expect }, servers: ['codex_apps'] });
  const line = errors.find((each) => each.includes('"mcp__codex_apps__get_workspace"'));
  assert.ok(line, errors.join('\n'));
  assert.doesNotMatch(line, /name it as/u);
  assert.doesNotMatch(errors.join('\n'), /"tracker\.readTools" replaces/u, 'the file set none');
  assert.match(errors.join('\n'), /"tracker\.servers" gives writes with no read the guard can count/u);
  assert.equal(config.tracker.enabled, true);
  assert.ok(config.tracker.readTools.includes('mcp__plugin_linear_linear__get_workspace'));
  const settings = { tracker: config.tracker, names: { human: 'the Human' } };
  assert.ok(judgeTrackerWrite(settings, 'mcp__plugin_linear_linear__save_issue', {}, null), 'a Claude Code write is still refused');
});

test('a workspaceInput that is no text is an error, and the key keeps its read and its guard', (t) => {
  for (const workspaceInput of [1, '', '  ', null]) {
    const { errors, config } = load(t, { enabled: true, provider: 'linear', workspace: { expect: WS.expect }, workspaceInput });
    assert.match(errors.join('\n'), /"tracker\.workspaceInput" must be a non-empty string/u, JSON.stringify(workspaceInput));
    assert.equal(config.tracker.enabled, true);
    assert.equal(config.tracker.workspace.field, 'url');
    assert.ok(config.tracker.readTools.length > 0);
    assert.equal(config.tracker.workspaceInput, undefined);
    const settings = { tracker: config.tracker, names: { human: 'the Human' } };
    assert.match(judgeTrackerWrite(settings, 'mcp__linear__save_issue', {}, null).reason, /has not read the connected workspace/u);
  }
});

test('a value the file sets for what the adapter fills stays as written', (t) => {
  const { config, errors } = load(t, { ...SHORT, idHint: 'use the issue key, never a UUID', readVerbs: ['triage*'] });
  assert.deepEqual(errors, []);
  assert.equal(config.tracker.idHint, 'use the issue key, never a UUID');
  assert.deepEqual(config.tracker.readVerbs, ['triage*']);
});

test('a provider key may name its reads in a host\'s raw form', (t) => {
  const servers = ['mcp__linear__', 'mcp__linear-server__', 'mcp__linear_server__', 'mcp__plugin_linear_linear__', 'mcp__claude_ai_Linear__', 'mcp__codex_apps__linear__'];
  const { errors } = load(t, { ...SHORT, readTools: servers.map((server) => `${server}get_workspace`) });
  assert.deepEqual(errors, []);
});

test('the keys an adapter can fill are checked when written by hand', (t) => {
  const whole = { enabled: true, workspace: { expect: 'x', field: 'cloudId' }, writeTools: ['mcp__x__save_*'], workspaceInput: 'cloudId', readVerbs: ['get*'], idHint: 'use its key' };
  const { config, errors } = load(t, whole);
  assert.deepEqual(errors, []);
  assert.equal(config.tracker.enabled, true);
  assert.equal(config.tracker.workspaceInput, 'cloudId');
  assert.deepEqual(config.tracker.readVerbs, ['get*']);
  assert.equal(config.tracker.idHint, 'use its key');
  assert.match(load(t, { ...whole, workspaceInput: 1 }).errors.join('\n'), /"tracker\.workspaceInput" must be a non-empty string/u);
  assert.match(load(t, { ...whole, readVerbs: 'get*' }).errors.join('\n'), /"tracker\.readVerbs" must be a list/u);
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
