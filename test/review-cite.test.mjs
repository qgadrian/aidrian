import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULTS, versionFloorProblem } from '../plugins/aidrian/lib/config.mjs';
import { checkReview } from '../plugins/aidrian/lib/review/config.mjs';
import { blocksOf, focusBlocks, invariantsOf, MAX_FOCUSED, MAX_SOURCE, sectionOf, sourceOf } from '../plugins/aidrian/lib/review/flows.mjs';
import { questionWarnings } from '../plugins/aidrian/lib/review/lint.mjs';
import { reviewPrompt } from '../plugins/aidrian/lib/review/reviewers.mjs';

// A product doc shaped like a real one: a long section of top-level bullets with nested lines and no `###` headings.
const long = (label, n) => `- ${label}:\n${Array.from({ length: n }, (_, i) => `  - rule ${i} of ${label.toLowerCase()} ${'x'.repeat(60)}`).join('\n')}`;
const DOC = [
  '# Product rules',
  '',
  '## Core Product Invariants',
  '',
  long('Domain separation is strict', 10),
  long('Operator quick actions answer at once', 25),
  long('Settings controllability is non-negotiable', 12),
  '  - **Exception — the Overview cockpit**: it has no off switch.',
  '',
  'A closing paragraph,',
  'over two lines.',
  '',
  '```',
  '- not a list item, inside a fence',
  '```',
  '',
  '## Next section',
  'Other rules.',
].join('\n');
const read = (file) => (file === 'product.md' ? DOC : null);
const section = sectionOf(DOC, 'core-product-invariants');

test('blocksOf splits a section into top-level list items, paragraphs, and fences, nested lines staying with their item', () => {
  const blocks = blocksOf(section.body);
  assert.deepEqual(blocks.map((block) => block.split('\n')[0]), [
    '- Domain separation is strict:',
    '- Operator quick actions answer at once:',
    '- Settings controllability is non-negotiable:',
    'A closing paragraph,',
    '```',
  ]);
  assert.match(blocks[2], /Exception — the Overview cockpit/u, 'a nested exception belongs to its bullet');
  assert.equal(blocks[4], '```\n- not a list item, inside a fence\n```');
});

test('blocksOf takes the least indentation as top level, and a fence closes only on its own delimiter', () => {
  const indented = sectionOf('## Rules\n\n  - First: one\n    - nested\n  - Second: two\n  - Third: three\n', 'rules');
  assert.deepEqual(blocksOf(indented.raw), ['- First: one\n  - nested', '- Second: two', '- Third: three']);
  assert.deepEqual(focusBlocks(indented, ['Second']).blocks, ['- Second: two'], 'each indented sibling is its own block');
  const fenced = ['````md', '```js', 'x()', '```', '', '- not a rule, still the example', '````', '', '- Real rule'].join('\n');
  assert.deepEqual(blocksOf(fenced), [fenced.split('\n\n- Real rule')[0], '- Real rule'], 'the inner ``` does not close the ```` fence');
  assert.deepEqual(blocksOf('~~~\n```\n~~~ not bare\n~~~\n\nAfter.'), ['~~~\n```\n~~~ not bare\n~~~', 'After.']);
  assert.deepEqual(blocksOf('Intro line.\n```\ncode\n```\nRefund cap: never exceeds the charge.'), ['Intro line.', '```\ncode\n```', 'Refund cap: never exceeds the charge.'], 'a fence is its own block, blank lines or not');
  for (const marker of ['-', '1.']) {
    for (const delimiter of ['```', '~~~']) {
      const item = `${marker} ${delimiter}js\n   - not a rule\n   ${delimiter}`;
      assert.deepEqual(blocksOf(`${item}\n${marker} Refund cap: never exceeds the charge.`), [item, `${marker} Refund cap: never exceeds the charge.`], `a fence opened by "${marker} ${delimiter}"`);
    }
  }
  for (const marker of ['-', '1.']) {
    const rules = [`${marker} \`\`\`code\`\`\` examples stay literal.`, `${marker} Refund cap: never exceeds the charge.`];
    assert.deepEqual(blocksOf(rules.join('\n')), rules, 'inline code of three backticks opens no fence');
  }
});

test('focus sends only the blocks it names, in section order, and names the question after them', () => {
  const [one] = invariantsOf({ invariants: [{ id: 'controls', cite: 'product.md#core-product-invariants', focus: 'settings controllability' }] }, read).invariants;
  assert.equal(one.text, 'Does the change keep "Core Product Invariants: settings controllability" as the cited section defines it?');
  assert.match(one.source, /^Core Product Invariants\n\n- Settings controllability is non-negotiable:/u);
  assert.match(one.source, /Overview cockpit/u);
  assert.doesNotMatch(one.source, /Domain separation|cut at/u);
  const two = focusBlocks(section, ['**Settings** controllability', 'Domain separation', 'Nope']);
  assert.deepEqual(two.blocks.map((block) => block.split('\n')[0]), ['- Domain separation is strict:', '- Settings controllability is non-negotiable:']);
  assert.deepEqual(two.missing, ['Nope'], 'markup and case do not matter; a focus that starts no block is reported');
  assert.deepEqual(focusBlocks(section, ['Settings control']).missing, ['Settings control'], 'a focus ends on a whole word');
  const linked = sectionOf('## Rules\n\n- [Refund cap](refunds.md): never exceeds the charge.\n- [No double booking][nd]: one slot, one booking.\n', 'rules');
  assert.deepEqual(focusBlocks(linked, ['Refund cap', 'No double booking']).missing, [], 'a link matches by its label');
  const stale = sourceOf(section, { cite: 'product.md#core-product-invariants', focus: 'Gone rule' }).source;
  assert.match(stale, /^Core Product Invariants\n\n- Domain separation is strict:/u, 'a focus that matches nothing sends the whole section, not the heading alone');
  const partial = sourceOf(section, { cite: 'product.md#core-product-invariants', focus: ['Settings controllability', 'Gone rule'] }).source;
  assert.match(partial, /- Domain separation is strict:/u, 'one unmatched focus of a list also sends the whole section');
});

test('a long section is cut between blocks, and the note names every block the reviewer did not see', () => {
  const { source, length } = sourceOf(section, { cite: 'product.md#core-product-invariants' });
  assert.ok(length > MAX_SOURCE);
  assert.ok(source.length < MAX_SOURCE + 400);
  assert.match(source, /- Operator quick actions answer at once:[\s\S]*rule 24 of operator/u, 'the last block kept is whole');
  assert.match(source, /\n\[cut at 4000 characters; not shown: "Settings controllability is non-negotiable:", "A closing paragraph,", "```"; read product\.md#core-product-invariants\]$/u);
});

test('one block past the limit is cut inside it; a focused block gets twice the room', () => {
  const huge = { heading: 'Huge', body: long('One rule', 100) };
  const { source } = sourceOf(huge, { cite: 'doc.md#huge' });
  assert.match(source, /^Huge\n\n- One rule:/u);
  assert.match(source, /\n\[cut at 4000 characters; the rest of the block is not shown; read doc\.md#huge\]$/u);
  const focused = { heading: 'Big', body: long('One rule', 60) };
  assert.ok(focused.body.length > MAX_SOURCE && focused.body.length < MAX_FOCUSED);
  assert.doesNotMatch(sourceOf(focused, { cite: 'doc.md#big', focus: 'One rule' }).source, /cut at/u);
  assert.match(sourceOf(focused, { cite: 'doc.md#big' }).source, /cut at 4000 characters/u);
});

test('config accepts focus only with a cite to a heading', () => {
  const flow = (invariant) => ({ flows: { f: { files: ['src/**'], invariants: [{ id: 'a', ...invariant }] } } });
  const errors = (value) => {
    const found = [];
    checkReview(value, 'config.json', found);
    return found;
  };
  assert.deepEqual(errors(flow({ cite: 'd.md#h', focus: 'x' })), []);
  assert.deepEqual(errors(flow({ cite: 'd.md#h', focus: ['x', 'y'] })), []);
  for (const bad of [{ text: 'q?', focus: 'x' }, { text: 'q?', cite: 'd.md', focus: 'x' }, { cite: 'd.md#h', focus: [] }, { cite: 'd.md#h', focus: 3 }]) {
    assert.equal(errors(flow(bad)).length, 1, JSON.stringify(bad));
  }
});

test('lint warns about a question whose yes is the breach, and a long text that restates its cite', () => {
  assert.deepEqual(questionWarnings({ text: 'Does every booking surface still work end to end?' }), []);
  assert.deepEqual(questionWarnings({ text: 'Does the change keep the gate without bypassing it?' }), []);
  assert.deepEqual(questionWarnings({ text: 'A change never removes a gate.' }), [], 'a statement has no yes to invert');
  assert.deepEqual(questionWarnings({ text: 'Does the change remove a settings control?' }), ['text asks with "remove", so yes would be the breach: ask whether the change still keeps the rule']);
  const text = `Does the change still keep ${'every rule '.repeat(20)}?`;
  assert.deepEqual(questionWarnings({ text, cite: 'd.md#h' }), [`text is ${text.length} characters, past 200: leave the rule to d.md#h and ask only the question`]);
  assert.deepEqual(questionWarnings({ text }), [], 'with no cite, the text is the rule');
});

test('the reviewer prompt fixes what a verdict means, and a delta pass judges its flows from the merge base', () => {
  const input = { base: 'b1', head: 'h1', flows: [{ id: 'f', invariants: [] }] };
  assert.match(reviewPrompt(input), /holds means the change keeps the rule/u);
  assert.doesNotMatch(reviewPrompt(input), /git diff m0 h1/u);
  assert.match(reviewPrompt({ ...input, flowBase: 'm0' }), /Find bugs in b1\.\.h1, but judge every flow invariant on the whole change, `git diff m0 h1`/u);
  assert.doesNotMatch(reviewPrompt({ ...input, flows: [] }), /holds means/u);
});

test('a plugin older than the version the project requires is named, with the copy that runs', () => {
  const config = (floor) => ({ ...DEFAULTS, requires: { aidrian: floor } });
  assert.equal(versionFloorProblem(DEFAULTS, '0.1.0'), null);
  assert.equal(versionFloorProblem(config('0.16.0'), '0.16.0'), null);
  assert.equal(versionFloorProblem(config('0.16.0'), '1.0.0'), null);
  assert.equal(versionFloorProblem(config('0.16.0'), '0.16.10'), null);
  assert.match(versionFloorProblem(config('0.16.0'), '0.15.9'), /^this project requires aidrian 0\.16\.0 or later, and this session runs 0\.15\.9 from \S+plugins\/aidrian: update the plugin/u);
  assert.match(versionFloorProblem(config('0.10.0'), '0.9.12'), /requires aidrian 0\.10\.0/u, 'parts compare as numbers');
});
