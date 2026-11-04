import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { nameMatches } from '../plugins/aidrian/lib/agent-gates.mjs';
import { judgeTrackerWrite, readTrackerValue } from '../plugins/aidrian/lib/tracker-guard.mjs';

const MODULE = path.resolve(import.meta.dirname, '../plugins/aidrian/lib/tracker-guard.mjs');

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
  for (const seen of [{}, { value: null }, { value: 3 }, { value: '' }, { value: EXPECT, unreadable: true }, 'broken']) {
    assert.match(judge({}, seen), /the read returned no url/, JSON.stringify(seen));
  }
  assert.match(judge({}, {}), new RegExp(READ), 'a record with no tool falls back to the configured read');
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

test('the module names no tracker', () => {
  assert.doesNotMatch(readFileSync(MODULE, 'utf8'), /linear|jira|github|gitlab|asana|trello|notion|clickup|youtrack/iu);
});
