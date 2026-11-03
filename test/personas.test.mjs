import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { tagWarnings } from '../plugins/aidrian/lib/knowledge.mjs';
import { parsePersona, personaProblems } from '../plugins/aidrian/lib/personas.mjs';

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
  assert.deepEqual(tasks, [{ title: 'Mark a dish ready', success: true }, { title: 'Read a ticket', success: true }]);
  assert.deepEqual(personaProblems(PERSONA), []);
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
  const { sections, tasks } = parsePersona(template);
  assert.ok(Object.hasOwn(sections, 'Voice') && Object.hasOwn(sections, 'Evidence'));
  assert.ok(tasks.length >= 2 && tasks.every((task) => task.success));
});
