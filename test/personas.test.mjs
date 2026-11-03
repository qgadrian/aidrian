import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { tagWarnings } from '../plugins/aidrian/lib/knowledge.mjs';
import { parsePersona, personaProblems, personaWarnings } from '../plugins/aidrian/lib/personas.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'plugins/aidrian/bin/aidrian');

const PERSONA = `# Line cook

## Who

A line cook. Uses a phone every day, not a computer.

## Goals

- See the next ticket without asking.

## Tasks

### Mark a dish ready

The cook taps the dish on the ticket.

Success: the dish shows as ready on the waiter's screen within five seconds.

### Read a ticket

- **Success:** every dish and its notes fit on one screen.

## Cares about

- Speed.

## Does not care about

- Reports.

## Context

Phone, Spanish, the whole shift.
`;

// A git project with one bucket whose docs map name -> text, every doc tagged `personas`.
function project(t, docs) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-personas-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  mkdirSync(path.join(dir, '.aidrian/knowledge'), { recursive: true });
  mkdirSync(path.join(dir, 'personas'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1 }));
  const index = {};
  for (const [name, text] of Object.entries(docs)) {
    writeFileSync(path.join(dir, 'personas', name), text);
    index[name] = { summary: `The ${name} doc.`, tags: ['personas'] };
  }
  if (!Object.keys(index).length) {
    writeFileSync(path.join(dir, 'personas/README.md'), '# Personas\n');
    index['README.md'] = { summary: 'No personas yet.' };
  }
  writeFileSync(path.join(dir, '.aidrian/knowledge/product.json'), JSON.stringify({ dir: 'personas', description: 'Who uses the product.', docs: index }));
  return dir;
}

const lint = (dir) => spawnSync(CLI, ['lint', 'personas', '--project', dir], { encoding: 'utf8' });

test('a persona doc is read by its sections and its tasks, each with or without a Success: line', () => {
  const { sections, tasks } = parsePersona(PERSONA);
  assert.deepEqual(Object.keys(sections), ['Who', 'Goals', 'Tasks', 'Cares about', 'Does not care about', 'Context']);
  assert.deepEqual(tasks, [
    { title: 'Mark a dish ready', success: true, outcome: "the dish shows as ready on the waiter's screen within five seconds." },
    { title: 'Read a ticket', success: true, outcome: 'every dish and its notes fit on one screen.' },
  ]);
  assert.deepEqual(personaProblems(PERSONA), []);
  assert.deepEqual(personaWarnings(PERSONA), [], 'an apostrophe is no quote');
  const none = parsePersona(PERSONA.replace('Success: the dish', 'Then the dish')).tasks[0];
  assert.deepEqual([none.success, none.outcome], [false, null]);
});

test('a missing or empty section, a task with no Success: line, and Tasks with no task are problems', () => {
  const noContext = PERSONA.replace(/## Context[\s\S]*$/, '');
  assert.deepEqual(personaProblems(noContext), ['no "## Context" section']);
  assert.deepEqual(personaProblems(PERSONA.replace('- Speed.\n', '')), ['"## Cares about" is empty']);
  const noSuccess = PERSONA.replace('Success: the dish', 'Then the dish');
  assert.deepEqual(personaProblems(noSuccess), ['task "Mark a dish ready" has no "Success:" line']);
  const empty = PERSONA.replace('Success: the dish', 'Success:\nthe dish');
  assert.deepEqual(personaProblems(empty), ['task "Mark a dish ready" has no "Success:" line'], 'Success: needs an outcome after it');
  for (const label of ['**Success:**', '- **Success:**', '**Success:**   ', '**Success**:']) {
    const bold = PERSONA.replace('Success: the dish', `${label}\nthe dish`);
    assert.deepEqual(personaProblems(bold), ['task "Mark a dish ready" has no "Success:" line'], `${JSON.stringify(label)} needs an outcome after it`);
  }
  const fenced = PERSONA.replace('Success: the dish', '```\nSuccess: the dish').replace('five seconds.\n', 'five seconds.\n```\n');
  assert.deepEqual(personaProblems(fenced), ['task "Mark a dish ready" has no "Success:" line'], 'a quoted Success: line is not one');
  const noTasks = PERSONA.replace(/### [\s\S]*?(?=## Cares)/, 'Take orders.\n\n');
  assert.deepEqual(personaProblems(noTasks), ['"## Tasks" has no "### <task>"']);
  const emptyTasks = PERSONA.replace(/### [\s\S]*?(?=## Cares)/, '');
  assert.deepEqual(personaProblems(emptyTasks), ['"## Tasks" is empty'], 'an empty Tasks is one problem, not two');
});

const WARN = "write the outcome in the persona's words, not the product's text";

test('a Success: paragraph that quotes the product warns, naming the task and the first quoted span', () => {
  const quoted = PERSONA.replace('the dish shows as ready', 'the dish shows "Ready" and then "Served"');
  assert.deepEqual(personaWarnings(quoted), [`task "Mark a dish ready": Success: quotes "Ready"; ${WARN}`]);
  assert.deepEqual(personaProblems(quoted), [], 'a warning is no problem');

  const wrapped = PERSONA.replace("on the waiter's screen within", "on the waiter's\nscreen under “Ready” within");
  assert.equal(parsePersona(wrapped).tasks[0].outcome, "the dish shows as ready on the waiter's screen under “Ready” within five seconds.");
  assert.deepEqual(personaWarnings(wrapped), [`task "Mark a dish ready": Success: quotes “Ready”; ${WARN}`], 'a wrapped line belongs to the paragraph');

  const item = PERSONA.replace('every dish and its notes', 'every dish and `notes.count`');
  assert.deepEqual(personaWarnings(item), [`task "Read a ticket": Success: quotes \`notes.count\`; ${WARN}`], 'a list item and a backticked span');

  const second = PERSONA.replace('- **Success:** every dish and its notes fit on one screen.', '- Success: every dish fits on one screen.\n- Success: the notes show under "Notes".');
  assert.equal(parsePersona(second).tasks[1].outcome, 'every dish fits on one screen. the notes show under "Notes".');
  assert.deepEqual(personaWarnings(second), [`task "Read a ticket": Success: quotes "Notes"; ${WARN}`], 'a later Success: line counts too');

  const adjacent = PERSONA.replace('- **Success:** every dish and its notes fit on one screen.', 'Success: a.\nSuccess: b.');
  assert.equal(parsePersona(adjacent).tasks[1].outcome, 'a. b.', 'a Success: line ends the Success: paragraph before it');

  const single = PERSONA.replace('the dish shows as ready', "the dish shows 'Ready'");
  assert.deepEqual(personaWarnings(single), [], 'single quotes do not count');
});

test('a quote outside the Success: paragraph does not warn', () => {
  const description = PERSONA.replace('The cook taps the dish', 'The cook taps "Ready" on the dish');
  assert.deepEqual(personaWarnings(description), [], 'the task description is not the outcome');
  const after = PERSONA.replace('within five seconds.\n', 'within five seconds.\n\nThe button says "Ready".\n');
  assert.deepEqual(personaWarnings(after), [], 'a blank line ends the paragraph');
  const list = PERSONA.replace('fit on one screen.\n', 'fit on one screen.\n- The header says "Table 4".\n');
  assert.deepEqual(personaWarnings(list), [], 'the next list item ends the paragraph');
  const fenced = PERSONA.replace('within five seconds.\n', 'within five seconds.\n```\n"Ready"\n```\n');
  assert.equal(parsePersona(fenced).tasks[0].outcome, "the dish shows as ready on the waiter's screen within five seconds.");
  assert.deepEqual(personaWarnings(fenced), [], 'a fence ends the paragraph');
  const heading = PERSONA.replace('fit on one screen.\n', 'fit on one screen.\n#### Notes "x"\n');
  assert.equal(parsePersona(heading).tasks[1].outcome, 'every dish and its notes fit on one screen.');
});

test('two tasks with one title are one problem naming the title', () => {
  const twice = PERSONA.replace('### Read a ticket', '### Mark a dish ready').replace('## Cares about', '### Mark a dish ready\n\nSuccess: the dish is gone from the list.\n\n## Cares about');
  assert.deepEqual(personaProblems(twice), ['3 tasks are titled "Mark a dish ready": --task and the report key on the title']);
});

test('a section beyond the contract is neither a problem nor a warning', () => {
  const extra = `${PERSONA}\n## Open questions\n\n- Do cooks share one phone?\n`;
  assert.ok(Object.hasOwn(parsePersona(extra).sections, 'Open questions'));
  assert.deepEqual([personaProblems(extra), personaWarnings(extra)], [[], []]);
});

test('a CRLF persona doc passes, and a heading inside a code fence is no section', () => {
  assert.deepEqual(personaProblems(PERSONA.replaceAll('\n', '\r\n')), []);
  const fencedContext = PERSONA.replace(/## Context[\s\S]*$/, '').replace('- Reports.\n', '- Reports.\n\n```markdown\n## Context\n\nPhone.\n```\n');
  assert.deepEqual(personaProblems(fencedContext), ['no "## Context" section']);
});

test('aidrian lint personas names the doc and the task, exempts product-access, and passes with no personas', (t) => {
  const broken = PERSONA.replace('Success: the dish', 'Then the dish').replace(/## Who\n\n.*\n\n/, '');
  const dir = project(t, { 'cook.md': PERSONA, 'waiter.md': broken, 'product-access.md': '# Product access\n\nOpen http://localhost:3000.\n' });
  const failed = lint(dir);
  assert.equal(failed.status, 1);
  assert.equal(failed.stderr, 'personas: personas/waiter.md: no "## Who" section\npersonas: personas/waiter.md: task "Mark a dish ready" has no "Success:" line\n');

  const passed = lint(project(t, { 'cook.md': PERSONA, 'product-access.md': '# Product access\n' }));
  assert.deepEqual([passed.status, passed.stdout, passed.stderr], [0, 'personas: 1 personas, 2 tasks, each with a Success: line\n', '']);

  const none = lint(project(t, {}));
  assert.deepEqual([none.status, none.stdout], [0, 'personas: no docs tagged personas\n']);
});

test('aidrian lint personas prints a warning on stderr and still passes, and fails two tasks with one title', (t) => {
  const quoted = PERSONA.replace('the dish shows as ready', 'the dish shows "Ready"');
  const warned = lint(project(t, { 'cook.md': quoted }));
  assert.deepEqual([warned.status, warned.stdout, warned.stderr], [
    0,
    'personas: 1 personas, 2 tasks, each with a Success: line\n',
    `personas: warning: personas/cook.md: task "Mark a dish ready": Success: quotes "Ready"; ${WARN}\n`,
  ]);

  const twice = PERSONA.replace('### Read a ticket', '### Mark a dish ready');
  const failed = lint(project(t, { 'cook.md': twice }));
  assert.deepEqual([failed.status, failed.stderr], [1, 'personas: personas/cook.md: 2 tasks are titled "Mark a dish ready": --task and the report key on the title\n']);
});

test('aidrian lint personas fails a persona id two docs share, two product-access docs, and the id all', (t) => {
  const dir = project(t, { 'cook.md': PERSONA, 'all.md': PERSONA, 'product-access.md': '# Product access\n' });
  mkdirSync(path.join(dir, 'more'));
  for (const name of ['cook.md', 'product-access.md']) writeFileSync(path.join(dir, 'more', name), name === 'cook.md' ? PERSONA : '# Product access\n');
  const docs = { 'cook.md': { summary: 'Another cook.', tags: ['personas'] }, 'product-access.md': { summary: 'Another access doc.', tags: ['personas'] } };
  writeFileSync(path.join(dir, '.aidrian/knowledge/more.json'), JSON.stringify({ dir: 'more', description: 'More people.', docs }));
  const failed = lint(dir);
  assert.equal(failed.status, 1);
  assert.deepEqual(failed.stderr.trim().split('\n').sort(), [
    'personas: persona id "cook" is used by more/cook.md and personas/cook.md',
    'personas: persona id "product-access" is used by more/product-access.md and personas/product-access.md',
    'personas: personas/all.md: the persona id "all" is reserved: persona-audit all runs every persona',
  ]);
});

test('aidrian lint personas names a doc from a local source by its absolute path', (t) => {
  const dir = project(t, {});
  const source = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-personas-source-')));
  t.after(() => rmSync(source, { recursive: true, force: true }));
  mkdirSync(path.join(source, 'knowledge'));
  mkdirSync(path.join(source, 'people'));
  writeFileSync(path.join(source, 'people/waiter.md'), PERSONA.replace(/## Who\n\n.*\n\n/, ''));
  const docs = { 'waiter.md': { summary: 'The waiter.', tags: ['personas'] } };
  writeFileSync(path.join(source, 'knowledge/people.json'), JSON.stringify({ dir: 'people', description: 'People.', docs }));
  writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify({ sources: [source] }));
  const failed = lint(dir);
  assert.equal(failed.stderr, `personas: ${path.join(source, 'people/waiter.md')}: no "## Who" section\n`);
});

test('personas is a tag the plugin knows, so aidrian check does not warn on it', () => {
  const bucket = { docs: [{ path: 'personas/cook.md', tags: ['personas'] }], always: [] };
  assert.deepEqual(tagWarnings([bucket]).warnings, []);
});

test('the persona template the persona-audit skill ships passes the lint, Voice and Evidence included', () => {
  const template = readFileSync(path.join(ROOT, 'plugins/aidrian/skills/persona-audit/references/persona-template.md'), 'utf8');
  assert.deepEqual(personaProblems(template), []);
  assert.deepEqual(personaWarnings(template), []);
  const { sections, tasks } = parsePersona(template);
  assert.ok(Object.hasOwn(sections, 'Voice') && Object.hasOwn(sections, 'Evidence'));
  assert.ok(tasks.length >= 2 && tasks.every((task) => task.success));
});
