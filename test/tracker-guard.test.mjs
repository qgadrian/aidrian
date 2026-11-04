import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { nameMatches } from '../plugins/aidrian/lib/agent-gates.mjs';
import { judgeTrackerWrite, readTrackerValue } from '../plugins/aidrian/lib/tracker-guard.mjs';

const PLUGIN = path.resolve(import.meta.dirname, '../plugins/aidrian');
const MODULE = path.join(PLUGIN, 'lib/tracker-guard.mjs');
const PRE = path.join(PLUGIN, 'scripts/hook-tracker-pre.mjs');
const POST = path.join(PLUGIN, 'scripts/hook-tracker-post.mjs');
const END = path.join(PLUGIN, 'scripts/hook-session-end.mjs');
const CLI = path.join(PLUGIN, 'bin/aidrian');

const EXPECT = 'https://tracker.example/acme';
const READ = 'mcp__x__get_workspace';
const WRITE = 'mcp__x__save_issue';
const UUID = '2f6c1e0a-9b3d-4c7e-8a15-6d0f4b2c9e11';

const tracker = {
  enabled: true,
  workspace: { expect: EXPECT, field: 'url' },
  readTools: [READ],
  writeTools: ['mcp__x__save_*', 'mcp__x__delete_issue'],
  team: { key: 'NOTES', values: ['Notes'], createFields: ['team'], keyFields: ['id', 'issueId'] },
  project: { values: ['Notes launch'], field: 'project' },
};
const config = (overrides = {}) => ({ tracker: { ...tracker, ...overrides }, names: { human: 'the Human', ai: null } });
const record = (value = EXPECT) => ({ value, unreadable: false, tool: READ, at: '2026-11-04T10:00:00.000Z' });
const unreadable = { value: null, unreadable: true, tool: READ, at: '2026-11-04T10:00:00.000Z' };
const denial = (input = {}, seen = record(), { settings = config(), tool = WRITE, options } = {}) =>
  judgeTrackerWrite(settings, tool, input, seen, options);
const judge = (...call) => denial(...call)?.reason ?? null;

const OK = { url: EXPECT };
const text = (body) => ({ type: 'text', text: body });

test('the reader takes the value from an object', () => {
  assert.equal(readTrackerValue(OK, 'url'), EXPECT);
});

test('the reader takes the value from a JSON string', () => {
  assert.equal(readTrackerValue(JSON.stringify(OK), 'url'), EXPECT);
});

test('the reader takes the value from a content-block array', () => {
  assert.equal(readTrackerValue([text(JSON.stringify(OK))], 'url'), EXPECT);
  assert.equal(readTrackerValue(JSON.stringify([text(JSON.stringify(OK))]), 'url'), EXPECT);
});

test('the reader takes the value from the shape observed on Codex', () => {
  assert.equal(readTrackerValue({ content: [text(JSON.stringify(OK))] }, 'url'), EXPECT);
  assert.equal(readTrackerValue(JSON.stringify({ content: [text(JSON.stringify(OK))] }), 'url'), EXPECT);
});

test('the reader parses the first text block holding JSON, past blocks that hold none', () => {
  const blocks = [{ type: 'image', data: 'x' }, 'stray', text('Connected workspace:'), text(JSON.stringify(OK))];
  assert.equal(readTrackerValue(blocks, 'url'), EXPECT);
  assert.equal(readTrackerValue([{ url: EXPECT }, text(JSON.stringify(OK))], 'url'), EXPECT);
});

test('a block that is not a text block is never read, even when it carries JSON', () => {
  const other = '{"url":"https://other.example"}';
  assert.equal(readTrackerValue([{ type: 'resource', text: other }, text(JSON.stringify(OK))], 'url'), EXPECT);
  assert.equal(readTrackerValue({ content: [{ text: other }, text(JSON.stringify(OK))] }, 'url'), EXPECT);
});

test('the reader stops at the first block holding JSON, even when it lacks the field', () => {
  assert.equal(readTrackerValue([text('{"name":"acme"}'), text(JSON.stringify(OK))], 'url'), null);
  assert.equal(readTrackerValue([text('3'), text(JSON.stringify(OK))], 'url'), null);
});

test('an object that has the field keeps it, even beside content blocks', () => {
  assert.equal(readTrackerValue({ url: EXPECT, content: [text('{"url":"https://other.example"}')] }, 'url'), EXPECT);
});

test('a response with no value reads as null', () => {
  const empty = [
    undefined, null, 7, true, '', 'not json', '"just text"', '{"url":', [], {}, { content: [] }, { content: 'text' }, [text('no json here')],
    { url: '' }, { url: '   ' }, { url: 12 }, { url: null }, { url: { href: EXPECT } }, { name: 'acme' }, [{ url: EXPECT }], { content: [{ type: 'text' }] },
  ];
  for (const response of empty) assert.equal(readTrackerValue(response, 'url'), null, JSON.stringify(response));
});

test('the reader follows the field it is given, not a fixed name', () => {
  assert.equal(readTrackerValue({ url: EXPECT, slug: 'acme' }, 'slug'), 'acme');
  assert.equal(readTrackerValue({ url: EXPECT }, 'slug'), null);
});

test('a tracker that is off, or a tool outside writeTools, passes', () => {
  assert.equal(judge({}, null, { settings: config({ enabled: false }) }), null);
  assert.equal(judge({}, null, { settings: config({ enabled: 'true' }) }), null);
  assert.equal(judge({}, null, { settings: { names: { human: 'the Human', ai: null } } }), null);
  assert.equal(judge({}, null, { tool: READ }), null);
  assert.equal(judge({}, null, { tool: 'mcp__x__delete_issue_label' }), null);
  assert.equal(judgeTrackerWrite(config(), undefined, {}, null), null);
});

test('writeTools match exactly, or by a trailing *', () => {
  assert.equal(nameMatches('mcp__x__delete_issue', 'mcp__x__delete_issue'), true);
  assert.equal(nameMatches('mcp__x__delete_issue', 'mcp__x__delete_issue_label'), false);
  assert.equal(nameMatches('mcp__x__save_*', 'mcp__x__save_comment'), true);
  assert.equal(nameMatches('mcp__x__save_*', 'mcp__x__get_issue'), false);
  assert.match(judge({}, null, { tool: 'mcp__x__delete_issue' }), /has not read/);
  assert.match(judge({}, null, { tool: 'mcp__x__save_comment' }), /has not read/);
});

test('rule 1: a write with no read refuses and names the read tool; a record passes', () => {
  assert.match(judge({}, null), /mcp__x__get_workspace/);
  assert.match(judgeTrackerWrite(config(), WRITE, {}, undefined).reason, /mcp__x__get_workspace/);
  assert.equal(judge({}, record()), null);
  const several = judge({}, null, { settings: config({ readTools: [READ, 'mcp__x__whoami'] }) });
  assert.match(several, /mcp__x__get_workspace or mcp__x__whoami/);
});

test('rule 1 has a way out for a caller with no session, and the other rules still run', () => {
  const options = { skipMissingRecord: true };
  assert.equal(judge({}, null, { options }), null);
  assert.match(judge({ team: 'Other' }, null, { options }), /"Other"/);
  assert.match(judge({ project: 'Other' }, null, { options }), /"Other"/);
  assert.match(judge({}, unreadable, { options }), /returned no url/);
  assert.match(judge({}, record('https://other.example'), { options }), /tracker\.workspace\.expect/);
});

test('rule 1 and the other workspace rules skip when workspace is unset', () => {
  const settings = config({ workspace: null, readTools: [] });
  assert.equal(judge({}, null, { settings }), null);
  assert.equal(judge({}, unreadable, { settings }), null);
  assert.equal(judge({}, record('https://other.example'), { settings }), null);
  assert.match(judge({ team: 'Other' }, null, { settings }), /"Other"/);
});

test('rule 2: an unreadable record refuses, says what the read lacked, and asks the Human to fix it', () => {
  const reason = judge({}, unreadable);
  assert.match(reason, /the read returned no url/);
  assert.match(reason, /mcp__x__get_workspace/);
  assert.match(reason, /the Human/);
  assert.match(reason, /connection/);
  assert.match(reason, /tracker\.workspace\.field/);
  assert.equal(judge({}, record()), null);
});

test('rule 2 reads a record with no text value as unreadable, and names the human the config names', () => {
  for (const seen of [{}, { value: null }, { value: 3 }, { value: '' }, { value: EXPECT, unreadable: true }]) {
    assert.match(judge({}, { ...seen, tool: READ }), /the read returned no url/, JSON.stringify(seen));
  }
  const settings = { ...config(), names: { human: 'Sam', ai: null } };
  assert.match(judge({}, unreadable, { settings }), /Sam/);
});

test('rule 2 names the read that came back empty, not every configured read', () => {
  const settings = config({ readTools: ['mcp__x__whoami', READ] });
  const reason = judge({}, unreadable, { settings });
  assert.match(reason, /mcp__x__get_workspace/);
  assert.doesNotMatch(reason, /mcp__x__whoami/);
});

test('rule 3: another workspace refuses, naming both values and the key; the same one passes', () => {
  const reason = judge({}, record('https://tracker.example/other'));
  assert.match(reason, /"https:\/\/tracker\.example\/other"/);
  assert.match(reason, /"https:\/\/tracker\.example\/acme"/);
  assert.match(reason, /tracker\.workspace\.expect/);
  assert.equal(judge({}, record(EXPECT)), null);
});

test('the workspace compares as exact text, ignoring one trailing / on either side', () => {
  assert.equal(judge({}, record(`${EXPECT}/`)), null);
  assert.equal(judge({}, record(), { settings: config({ workspace: { expect: `${EXPECT}/`, field: 'url' } }) }), null);
  assert.match(judge({}, record(`${EXPECT}//`)), /tracker\.workspace\.expect/);
  assert.match(judge({}, record(EXPECT.toUpperCase())), /tracker\.workspace\.expect/);
  assert.match(judge({}, record(`${EXPECT} `)), /tracker\.workspace\.expect/);
});

test('rule 4: a create value outside team.values refuses, naming both values and the key; a listed one passes', () => {
  const reason = judge({ team: 'Other' });
  assert.match(reason, /"Other"/);
  assert.match(reason, /"Notes"/);
  assert.match(reason, /tracker\.team\.values/);
  assert.match(reason, /\bteam\b/);
  assert.equal(judge({ team: 'Notes' }), null);
});

test('rule 4 passes the team key in a create field, in any case; a listed value stays exact text', () => {
  assert.equal(judge({ team: 'NOTES' }), null);
  assert.equal(judge({ team: 'notes' }), null);
  assert.match(judge({ team: 'Other' }), /"Other"/);
  const settings = config({ team: { ...tracker.team, key: 'NTS' } });
  assert.equal(judge({ team: 'nts' }, record(), { settings }), null);
  assert.equal(judge({ team: 'Notes' }, record(), { settings }), null);
  assert.match(judge({ team: 'notes' }, record(), { settings }), /"notes"/);
});

test('a refused create value is told the team key would pass too', () => {
  assert.match(judge({ team: 'Other' }), /team key "NOTES"/);
  assert.doesNotMatch(judge({ project: 'Other' }), /team key/);
});

test('the team key does not stand in for a project value', () => {
  assert.match(judge({ project: 'NOTES' }), /"NOTES"/);
  assert.match(judge({ project: ['NOTES'] }), /tracker\.project\.values/);
});

test('an array in a create field is judged entry by entry, and the first that fails is named', () => {
  assert.equal(judge({ team: ['Notes'] }), null);
  assert.equal(judge({ team: ['Notes', 'notes', UUID] }), null);
  assert.equal(judge({ project: ['Notes launch', UUID] }), null);
  const mixed = judge({ team: ['Notes', 'Other', 'Another'] });
  assert.match(mixed, /team has "Other"/);
  assert.doesNotMatch(mixed, /Another/);
  assert.match(judge({ project: ['Notes launch', 'Other launch'] }), /project has "Other launch"/);
  assert.match(judge({ team: [7] }), /team has 7/);
  assert.match(judge({ team: [''] }), /team has ""/);
  assert.match(judge({ team: [null] }), /team has null/);
  assert.match(judge({ team: [['Notes']] }), /team has \["Notes"\]/);
});

test('an empty array names no value to check, as an absent field does', () => {
  assert.equal(judge({ team: [] }), null);
  assert.equal(judge({ project: [] }), null);
});

test('rule 4: a key with another prefix refuses, naming both values and the key; the team key passes in any case', () => {
  for (const field of ['id', 'issueId']) {
    const reason = judge({ [field]: 'OTHER-12' });
    assert.match(reason, /"OTHER-12"/);
    assert.match(reason, /"NOTES"/);
    assert.match(reason, /tracker\.team\.key/);
    assert.ok(reason.includes(field));
  }
  assert.match(judge({ id: 'OTHER-12' }), /the item's UUID when it is not an issue/);
  assert.equal(judge({ id: UUID }), null, 'the route the reason offers passes this check');
  assert.equal(judge({ id: 'NOTES-12' }), null);
  assert.equal(judge({ id: 'notes-12' }), null);
  assert.equal(judge({ id: 'NoTeS-12' }), null);
});

test('a key field value not of the form <KEY>-<n> skips the team check only', () => {
  for (const id of [UUID, 'abc123', 'OTHER-', '-12', 'OTHER-12a', 'OTHER-12-3', 'two words-1', 12, ['OTHER-12']]) {
    assert.equal(judge({ id }), null, JSON.stringify(id));
  }
});

test('a UUID in a key field skips the team check and still runs the workspace and project checks', () => {
  assert.equal(judge({ id: UUID }), null);
  assert.match(judge({ id: UUID }, null), /mcp__x__get_workspace/);
  assert.match(judge({ id: UUID }, unreadable), /returned no url/);
  assert.match(judge({ id: UUID }, record('https://other.example')), /tracker\.workspace\.expect/);
  assert.match(judge({ id: UUID, project: 'Other' }), /tracker\.project\.values/);
  assert.match(judge({ id: UUID, team: 'Other' }), /tracker\.team\.values/);
});

test('a UUID in a create field skips that check, in either case', () => {
  assert.equal(judge({ team: UUID }), null);
  assert.equal(judge({ team: UUID.toUpperCase() }), null);
  assert.match(judge({ team: `${UUID}x` }), /tracker\.team\.values/);
});

test('rule 5: a project outside project.values refuses, naming both values; a listed one passes', () => {
  const reason = judge({ project: 'Other launch' });
  assert.match(reason, /"Other launch"/);
  assert.match(reason, /"Notes launch"/);
  assert.match(reason, /tracker\.project\.values/);
  assert.equal(judge({ project: 'Notes launch' }), null);
});

test('a UUID in the project field skips the check; a project identifier or slug must be listed', () => {
  assert.equal(judge({ project: UUID }), null);
  assert.match(judge({ project: 'P-NOTES-12' }), /"P-NOTES-12"/);
  assert.match(judge({ project: 'notes-launch' }), /"notes-launch"/);
  assert.equal(judge({ project: 'notes-launch' }, record(), { settings: config({ project: { values: ['Notes launch', 'notes-launch'], field: 'project' } }) }), null);
});

test('a field absent from the input, or null, has nothing to check; any other value that is not listed refuses', () => {
  assert.equal(judge({}), null);
  assert.equal(judge({ team: null, id: null, project: null }), null);
  assert.equal(judge(null), null);
  assert.equal(judge('not an object'), null);
  assert.match(judge({ team: 7 }), /tracker\.team\.values/);
  assert.match(judge({ team: '' }), /tracker\.team\.values/);
  assert.match(judge({ project: '' }), /tracker\.project\.values/);
});

test('the team and project checks skip when their group is unset', () => {
  assert.equal(judge({ team: 'Other', id: 'OTHER-1' }, record(), { settings: config({ team: null }) }), null);
  assert.equal(judge({ project: 'Other' }, record(), { settings: config({ project: null }) }), null);
});

test('the rules run in order: the first that a call breaks gives the reason', () => {
  const input = { team: 'Other', id: 'OTHER-1', project: 'Other launch' };
  assert.match(judge(input, null), /mcp__x__get_workspace/);
  assert.doesNotMatch(judge(input, null), /tracker\.team/);
  assert.match(judge(input, unreadable), /returned no url/);
  assert.match(judge(input, record('https://other.example')), /tracker\.workspace\.expect/);
  assert.match(judge(input), /tracker\.team\.values/);
  assert.match(judge({ id: 'OTHER-1', project: 'Other launch' }), /tracker\.team\.key/);
  assert.match(judge({ project: 'Other launch' }), /tracker\.project\.values/);
});

test('the fields and values come from the config, so another tracker\'s names work the same', () => {
  const settings = config({
    workspace: { expect: 'acme-org', field: 'organization' },
    readTools: ['mcp__y__me'],
    writeTools: ['mcp__y__update'],
    team: { key: 'ENG', values: ['Engineering'], createFields: ['squad'], keyFields: ['ticket'] },
    project: { values: ['Roadmap'], field: 'board' },
  });
  const seen = { ...record('acme-org'), tool: 'mcp__y__me' };
  const on = (input, read = seen) => judgeTrackerWrite(settings, 'mcp__y__update', input, read)?.reason ?? null;
  assert.equal(on({ squad: 'Engineering', ticket: 'ENG-1', board: 'Roadmap' }), null);
  assert.match(on({}, null), /mcp__y__me/);
  assert.match(on({}, { ...unreadable, tool: 'mcp__y__me' }), /returned no organization/);
  assert.match(on({ squad: 'Sales' }), /squad/);
  assert.match(on({ ticket: 'OPS-1' }), /ticket/);
  assert.match(on({ board: 'Other' }), /board/);
  assert.equal(on({ team: 'Other', id: 'OTHER-1', project: 'Other' }), null);
});

test('a refusal is { match, reason }: match is the cause alone, and fits a deny row with its values', () => {
  const REPORT_ROW_CHARS = 120;
  const causes = [
    [denial({}, null), /^this session has not read the connected workspace$/],
    [denial({}, unreadable), /^the read returned no url \(mcp__x__get_workspace\)$/],
    [denial({}, record('https://other.example')), /^the connected workspace is "https:\/\/other\.example", and tracker\.workspace\.expect is "https:\/\/tracker\.example\/acme"$/],
    [denial({ team: 'Other' }), /^team is "Other", and tracker\.team\.values allows "Notes"$/],
    [denial({ id: 'OTHER-1' }), /^id is "OTHER-1", whose prefix is not tracker\.team\.key "NOTES"$/],
    [denial({ project: 'Other' }), /^project is "Other", and tracker\.project\.values allows "Notes launch"$/],
  ];
  for (const [refusal, cause] of causes) {
    assert.deepEqual(Object.keys(refusal), ['match', 'reason']);
    assert.match(refusal.match, cause);
    assert.ok(refusal.match.length <= REPORT_ROW_CHARS, refusal.match);
    assert.ok(refusal.reason.startsWith(`aidrian: this tracker write is refused because ${refusal.match}. `), refusal.reason);
    assert.match(refusal.reason, /\.$/u);
  }
});

test('the workspace mismatch reason asks the Human whether the key is wrong, and tells the agent not to edit it', () => {
  const reason = judge({}, record('https://tracker.example/other'));
  assert.match(reason, /Ask the Human whether tracker\.workspace\.expect is wrong/);
  assert.match(reason, /do not edit the key/);
  assert.doesNotMatch(reason, /change the key/);
  const settings = { ...config(), names: { human: 'Sam', ai: null } };
  assert.match(judge({}, record('https://tracker.example/other'), { settings }), /Ask Sam whether/);
});

test('the team, issue key, and project refusals tell the agent not to edit the key', () => {
  for (const input of [{ team: 'Other' }, { team: ['Other'] }, { id: 'OTHER-1' }, { project: 'Other' }, { project: ['Other'] }]) {
    assert.match(judge(input), /, and do not edit the key\.$/, JSON.stringify(input));
  }
});

// Two servers connected to the workspaces they report: each has a read tool and a write tool.
const twoServers = config({ readTools: ['mcp__a__read', 'mcp__b__read'], writeTools: ['mcp__a__write', 'mcp__b__write'] });
const readOn = (tool, value = EXPECT) => ({ value, unreadable: false, tool, at: '2026-11-04T10:00:00.000Z' });
const NO_READ = /has not read the connected workspace/;

test('a record counts only when its tool is on the write\'s server, and the refusal names that server\'s read', () => {
  const onB = judge({}, readOn('mcp__a__read'), { settings: twoServers, tool: 'mcp__b__write' });
  assert.match(onB, NO_READ);
  assert.match(onB, /Call mcp__b__read, then write again/);
  assert.doesNotMatch(onB, /mcp__a__read/);
  const onA = judge({}, readOn('mcp__b__read'), { settings: twoServers, tool: 'mcp__a__write' });
  assert.match(onA, /Call mcp__a__read, then write again/);
  assert.doesNotMatch(onA, /mcp__b__read/);
  assert.equal(judge({}, readOn('mcp__a__read'), { settings: twoServers, tool: 'mcp__a__write' }), null);
  const none = judge({}, null, { settings: twoServers, tool: 'mcp__b__write' });
  assert.match(none, /Call mcp__b__read, then write again/);
  assert.doesNotMatch(none, /mcp__a__read/);
});

test('a record from another server names no value of that server: a wrong workspace there gives the no-read refusal', () => {
  const reason = judge({}, readOn('mcp__a__read', 'https://other.example'), { settings: twoServers, tool: 'mcp__b__write' });
  assert.match(reason, NO_READ);
  assert.doesNotMatch(reason, /other\.example/);
});

test('with no read tool listed on the write\'s server, the refusal asks the Human for one, since no read can clear it', () => {
  const settings = config({ readTools: ['mcp__a__read'], writeTools: ['mcp__b__write'] });
  for (const seen of [null, readOn('mcp__a__read')]) {
    const reason = judge({}, seen, { settings, tool: 'mcp__b__write' });
    assert.match(reason, NO_READ);
    assert.match(reason, /Ask the Human to add a read tool on this server to tracker\.readTools, and do not edit the key/);
    assert.doesNotMatch(reason, /mcp__a__read/);
  }
});

test('a record with no tool, or that is no record, belongs to no server and gives the no-read refusal', () => {
  for (const seen of [{}, { value: EXPECT }, { value: EXPECT, tool: 7 }, { value: EXPECT, tool: 'Bash' }, 'broken']) {
    assert.match(judge({}, seen), NO_READ, JSON.stringify(seen));
  }
});

test('a server ends at the first double underscore, so single underscores stay in its name and double ones stay in the tool', () => {
  const held = (read, write) => judge({}, readOn(read), { settings: config({ readTools: [read], writeTools: [write] }), tool: write });
  assert.equal(held('mcp__plugin_a_b__read', 'mcp__plugin_a_b__write'), null);
  assert.equal(held('mcp__a__read', 'mcp__a__write_issue'), null);
  assert.equal(held('mcp__a__get__workspace', 'mcp__a__write'), null, 'a double underscore in the tool name stays in the tool');
  assert.match(held('mcp__plugin_a__read', 'mcp__plugin_a_b__write'), NO_READ, 'one server\'s name starting another\'s is another server');
  assert.match(held('mcp__plugin_a_b__read', 'mcp__plugin_a__write'), NO_READ);
  assert.match(held('mcp__my__read', 'mcp__my_server__write'), NO_READ);
  assert.equal(held('mcp__a__read', 'mcp__a__b__write'), null, 'the limit: a server named a__b reads as server a');
});

test('a write tool with no server gets its own next step, even with a read tool that has no server either', () => {
  for (const readTools of [[READ], ['mcp__solo_read']]) {
    const settings = config({ readTools, writeTools: ['mcp__solo'] });
    for (const seen of [null, record(), readOn('mcp__solo_read')]) {
      const reason = judge({}, seen, { settings, tool: 'mcp__solo' });
      assert.match(reason, /tracker\.writeTools names this tool with no server, so no read can clear it/);
      assert.match(reason, /Ask the Human to correct that entry, and do not edit the key\.$/);
      assert.doesNotMatch(reason, /Call |add a read tool/);
    }
  }
});

test('skipMissingRecord also covers a record from another server, which no read could replace', () => {
  const options = { skipMissingRecord: true };
  const seen = readOn('mcp__a__read', 'https://other.example');
  assert.equal(judge({}, seen, { settings: twoServers, tool: 'mcp__b__write', options }), null);
  assert.match(judge({ team: 'Other' }, seen, { settings: twoServers, tool: 'mcp__b__write', options }), /tracker\.team\.values/);
  assert.match(judge({}, seen, { settings: twoServers, tool: 'mcp__a__write', options }), /tracker\.workspace\.expect/);
});

test('the module and its hooks name no tracker', () => {
  for (const file of [MODULE, PRE, POST]) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /linear|jira|github|gitlab|asana|trello|notion|clickup|youtrack/iu, file);
  }
});

// The hooks run as processes, in a git repository of their own with `settings` as its config.json: as given when it is a
// string, such as text that does not parse. With null, the folder is no project.
let sessions = 0;
function project(t, settings = { version: 1, tracker }) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-tracker-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, 'repo');
  spawnSync('git', ['init', '-q', '-b', 'main', dir]);
  if (settings !== null) {
    mkdirSync(path.join(dir, '.aidrian'));
    writeFileSync(path.join(dir, '.aidrian/config.json'), typeof settings === 'string' ? settings : JSON.stringify(settings));
  }
  const temp = path.join(base, 'tmp');
  mkdirSync(temp);
  const state = path.join(base, 'state');
  const env = { ...process.env, XDG_STATE_HOME: state, TMPDIR: temp };
  const session = `session-${sessions += 1}`;
  const run = (script, input) => spawnSync(process.execPath, [script], { input: JSON.stringify({ cwd: dir, session_id: session, ...input }), encoding: 'utf8', env });
  return {
    base,
    dir,
    temp,
    state,
    session,
    log: () => {
      try {
        const folder = spawnSync(CLI, ['state'], { cwd: dir, env, encoding: 'utf8' }).stdout.trim();
        return readFileSync(path.join(folder, 'dispatch-log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
    file: (id = session) => path.join(state, 'aidrian/sessions', `${id}.tracker.json`),
    read: (response = OK, input = {}) => run(POST, { tool_name: READ, tool_response: response, ...input }),
    write: (input = {}, extra = {}) => run(PRE, { tool_name: WRITE, tool_input: input, ...extra }),
    end: (extra = {}) => run(END, extra),
    run,
    stateFiles: () => (existsSync(state) ? readdirSync(state, { recursive: true }) : []),
    report: (args) => spawnSync(CLI, ['report', ...args], { cwd: dir, env, encoding: 'utf8' }),
  };
}

const assertRuns = ({ status, stderr }, label) => assert.deepEqual([status, stderr], [0, ''], label);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a write is refused before a read, allowed after a matching one, and refused again after a later mismatched read', (t) => {
  const { read, write } = project(t);
  const before = write();
  assert.equal(before.status, 2);
  assert.match(before.stderr, /has not read the connected workspace/);
  assert.match(before.stderr, /mcp__x__get_workspace/);

  assertRuns(read());
  assertRuns(write());

  assertRuns(read({ url: 'https://tracker.example/other' }));
  const after = write();
  assert.equal(after.status, 2);
  assert.match(after.stderr, /"https:\/\/tracker\.example\/other"/);
  assert.match(after.stderr, /Ask the Human whether tracker\.workspace\.expect is wrong/);

  assertRuns(read());
  assertRuns(write());
});

test('the post hook records { value, unreadable, tool, at }, and the latest read replaces an earlier one', (t) => {
  const { file, read } = project(t);
  assertRuns(read());
  const first = JSON.parse(readFileSync(file(), 'utf8'));
  assert.deepEqual(Object.keys(first), ['value', 'unreadable', 'tool', 'at']);
  assert.deepEqual([first.value, first.unreadable, first.tool], [EXPECT, false, READ]);
  assert.equal(new Date(first.at).toISOString(), first.at);

  assertRuns(read('not json'));
  const second = JSON.parse(readFileSync(file(), 'utf8'));
  assert.deepEqual([second.value, second.unreadable, second.tool], [null, true, READ]);
});

test('a read with no value refuses a write and asks the Human, until a later read has one', (t) => {
  const { read, write } = project(t);
  assertRuns(read({ name: 'acme' }));
  const refused = write();
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /the read returned no url \(mcp__x__get_workspace\)/);
  assertRuns(read({ content: [text(JSON.stringify(OK))] }));
  assertRuns(write());
});

test('only a tool in readTools leaves a record, and it never replaces one', (t) => {
  const { file, read, run, write } = project(t);
  assertRuns(run(POST, { tool_name: 'mcp__x__get_issue', tool_response: { url: 'https://other.example' } }));
  assertRuns(run(POST, { tool_name: WRITE, tool_response: { url: 'https://other.example' } }));
  assert.equal(existsSync(file()), false);
  assertRuns(read());
  assertRuns(run(POST, { tool_name: 'mcp__x__get_issue', tool_response: { url: 'https://other.example' } }));
  assertRuns(write());
});

test('one record serves one server: a read on a clears a write on a and not on b, and a read on b takes its place', (t) => {
  const settings = { version: 1, tracker: { ...tracker, readTools: ['mcp__a__read', 'mcp__b__read'], writeTools: ['mcp__a__write', 'mcp__b__write'] } };
  const { read, write } = project(t, settings);
  const on = (server) => write({}, { tool_name: `mcp__${server}__write` });
  const readOnServer = (server, response = OK) => read(response, { tool_name: `mcp__${server}__read` });

  assertRuns(readOnServer('a'));
  assertRuns(on('a'));
  const refusedOnB = on('b');
  assert.equal(refusedOnB.status, 2);
  assert.match(refusedOnB.stderr, /Call mcp__b__read, then write again/);

  assertRuns(readOnServer('b'));
  assertRuns(on('b'));
  const refusedOnA = on('a');
  assert.equal(refusedOnA.status, 2);
  assert.match(refusedOnA.stderr, /Call mcp__a__read, then write again/);

  assertRuns(readOnServer('a'));
  assertRuns(on('a'));
  assertRuns(readOnServer('b', { url: 'https://other.example' }));
  assert.match(on('b').stderr, /"https:\/\/other\.example"/);
  assert.match(on('a').stderr, /Call mcp__a__read/, 'the mismatched read on b replaced the good read on a');
});

test('a session whose record cannot be saved skips the no-read rule and keeps the others, under any uid', (t) => {
  const { read, state, write } = project(t);
  writeFileSync(state, 'a plain file, so no folder can be made under it');
  assertRuns(read());
  assertRuns(write());
  const refused = write({ team: 'Other' });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /tracker\.team\.values/);
  assert.match(write({ project: 'Other' }).stderr, /tracker\.project\.values/);
  assert.match(write({ id: 'OTHER-1' }).stderr, /tracker\.team\.key/);
});

test('a record folder that exists but is read-only skips the no-read rule and keeps the others', { skip: process.getuid?.() === 0 }, (t) => {
  const { file, write } = project(t);
  const folder = path.dirname(file());
  mkdirSync(folder, { recursive: true });
  chmodSync(folder, 0o555);
  try {
    assertRuns(write());
    const refused = write({ team: 'Other' });
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /tracker\.team\.values/);
  } finally {
    chmodSync(folder, 0o755);
  }
});

test('check reports a write no read can clear, and the guard stays on and refuses it at run time', (t) => {
  const settings = { version: 1, tracker: { ...tracker, readTools: ['mcp__a__read'], writeTools: ['mcp__b__write'] } };
  const { dir, write } = project(t, settings);
  const refused = write({}, { tool_name: 'mcp__b__write' });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /Ask the Human to add a read tool on this server to tracker\.readTools/);
  const checked = spawnSync(CLI, ['check'], { cwd: dir, encoding: 'utf8' });
  assert.equal(checked.status, 1);
  assert.match(checked.stderr, /"tracker\.writeTools" has "mcp__b__write": no tool in "tracker\.readTools" is on its server/);
});

test('a missing record folder that can be made keeps the no-read rule, and the pre hook does not make it', (t) => {
  const { state, stateFiles, write } = project(t);
  assert.equal(existsSync(state), false);
  assert.match(write().stderr, /has not read the connected workspace/);
  assert.deepEqual(stateFiles().filter((entry) => entry.includes('sessions')), []);
  mkdirSync(state, { recursive: true });
  assert.match(write().stderr, /has not read the connected workspace/);
});

test('a record that already exists is judged, though its folder cannot be written', (t) => {
  const { file, read, write } = project(t);
  assertRuns(read({ url: 'https://other.example' }));
  const folder = path.dirname(file());
  chmodSync(folder, 0o555);
  try {
    assert.match(write().stderr, /"https:\/\/other\.example"/);
  } finally {
    chmodSync(folder, 0o755);
  }
});

test('the pre hook judges only writeTools, and the team and project rules from the tool input', (t) => {
  const { read, run, write } = project(t);
  assertRuns(run(PRE, { tool_name: 'mcp__x__get_issue', tool_input: { team: 'Other' } }));
  assertRuns(read());
  assert.match(write({ team: 'Other' }).stderr, /tracker\.team\.values/);
  assert.match(write({ id: 'OTHER-1' }).stderr, /tracker\.team\.key/);
  assert.match(write({ project: 'Other' }).stderr, /tracker\.project\.values/);
  assertRuns(write({ team: 'Notes', id: 'NOTES-1', project: 'Notes launch' }));
});

test('with no session id, nothing is recorded, rule 1 is skipped, and the other rules still run', (t) => {
  const { read, stateFiles, write } = project(t);
  for (const session_id of [undefined, '', 42, '../escape', 'a/b']) {
    assertRuns(read(OK, { session_id }), `post: ${session_id}`);
    assertRuns(write({}, { session_id }), `pre: ${session_id}`);
  }
  assert.deepEqual(stateFiles(), []);
  const refused = write({ team: 'Other' }, { session_id: undefined });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /tracker\.team\.values/);
});

test('a record that is not one reads as no read, so a new read recovers', (t) => {
  const { file, read, write } = project(t);
  assertRuns(read());
  for (const broken of ['not json', '[]', 'null', '3']) {
    writeFileSync(file(), broken);
    const refused = write();
    assert.equal(refused.status, 2, broken);
    assert.match(refused.stderr, /has not read the connected workspace/, broken);
  }
  assertRuns(read());
  assertRuns(write());
});

test('with the tracker off, a broken config, or no project, both hooks let the call run and write no file', (t) => {
  const off = [
    ['the key unset', { version: 1 }],
    ['enabled false', { version: 1, tracker: { ...tracker, enabled: false } }],
    ['enabled the wrong type', { version: 1, tracker: { ...tracker, enabled: 'true' } }],
    ['no write tool survives', { version: 1, tracker: { ...tracker, writeTools: ['Bash(git push)'] } }],
    ['no group survives', { version: 1, tracker: { enabled: true, writeTools: tracker.writeTools, team: { key: 'NOTES' } } }],
    ['the key the wrong type', { version: 1, tracker: 'on' }],
    ['config.json that does not parse', '{ "version": 1, "tracker": '],
    ['config.json of another version', { version: 99, tracker }],
    ['no project', null],
  ];
  for (const [label, settings] of off) {
    const { read, stateFiles, write } = project(t, settings);
    assertRuns(write({ team: 'Other' }), `pre: ${label}`);
    assertRuns(read(), `post: ${label}`);
    assertRuns(write({ team: 'Other' }), `pre after a read: ${label}`);
    assert.deepEqual(stateFiles(), [], label);
  }
});

test('input a hook cannot read lets the call run and writes no file', (t) => {
  const { run, stateFiles } = project(t);
  for (const input of [{ tool_name: undefined }, { tool_name: 42 }, { cwd: 42, tool_name: 42 }, { tool_name: ['mcp__x__get_workspace'] }]) {
    assertRuns(run(PRE, input), `pre: ${JSON.stringify(input)}`);
    assertRuns(run(POST, input), `post: ${JSON.stringify(input)}`);
  }
  assert.deepEqual(stateFiles(), []);
});

test('a refusal appears as a tracker-guard row in the report, naming the cause and never the rest of the input', (t) => {
  const { report, write } = project(t, { version: 1, tracker, telemetry: { enabled: true, hookDenies: true } });
  assert.equal(write({ title: 'SECRET title' }).status, 2);
  const { status, stdout } = report(['--json']);
  assert.equal(status, 0);
  const denies = JSON.parse(stdout).hook_denies;
  assert.equal(denies.count, 1);
  assert.deepEqual(denies.by_rule.map((rule) => rule.rule), ['tracker-guard']);
  assert.doesNotMatch(stdout, /SECRET/);
  assert.match(stdout, /this session has not read the connected workspace/);
  assert.match(report([]).stdout, /tracker-guard/);
});

test('a refusal\'s row holds the whole cause with both values, and no lead from the reason the agent reads', (t) => {
  const { log, read, report, write } = project(t, { version: 1, tracker, telemetry: { enabled: true, hookDenies: true } });
  assertRuns(read({ url: 'https://other.example' }));
  assert.match(write().stderr, /^aidrian: this tracker write is refused because /);
  const cause = `the connected workspace is "https://other.example", and tracker.workspace.expect is "${EXPECT}"`;
  assert.deepEqual(log().filter((row) => row.event === 'hook_deny').map((row) => [row.rule, row.reason]), [['tracker-guard', cause]]);
  const [{ reasons }] = JSON.parse(report(['--json']).stdout).hook_denies.by_rule;
  assert.deepEqual(reasons, [[cause, 1]]);
});

test('session end deletes the record, of this session only, tracker on or off', (t) => {
  const { end, file, read, run } = project(t);
  assertRuns(read());
  assertRuns(read(OK, { session_id: 'another-session' }));
  assert.equal(existsSync(file()), true);
  assertRuns(end());
  assert.equal(existsSync(file()), false);
  assert.equal(existsSync(file('another-session')), true);
  assertRuns(end(), 'a record already gone is no error');
  assertRuns(run(END, { session_id: '../another-session' }), 'an id that cannot name a file deletes nothing');
  assert.equal(existsSync(file('another-session')), true);

  const outside = project(t, null);
  mkdirSync(path.dirname(outside.file()), { recursive: true });
  writeFileSync(outside.file(), '{}');
  assertRuns(outside.end());
  assert.equal(existsSync(outside.file()), false, 'the session may end outside the project it read in');
});

test('a record session end cannot delete skips nothing: the session-length marker goes and the session row lands', async (t) => {
  const { base, end, file, log, session, temp } = project(t, { version: 1, tracker, telemetry: { enabled: true } });
  // A folder at the record's path with a file in it: rmSync refuses that under any uid.
  mkdirSync(file(), { recursive: true });
  writeFileSync(path.join(file(), 'held'), '');
  const marker = path.join(temp, `aidrian-session-length-${session}`);
  writeFileSync(marker, '{}\n');
  const transcript = path.join(base, 'transcript.jsonl');
  writeFileSync(transcript, JSON.stringify({ type: 'assistant', timestamp: '2026-11-04T10:00:00Z', message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 5 }, content: [] } }));

  assertRuns(end({ transcript_path: transcript }));

  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(file()), true);
  for (const deadline = Date.now() + 15_000; !log().some((row) => row.event === 'session'); await sleep(25)) {
    if (Date.now() > deadline) assert.fail('the session row never landed');
  }
});
