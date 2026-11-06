// The auto-merge gate's self-protection: every plugin file the gate, or the review that writes its record, loads at run
// time is on GUARDED_PATHS, so auto-merge never lands a change to the machinery that decides it. The test walks the
// files from the gate's entry points instead of keeping a list, so a new import can never fall outside the guard.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { pathsProblem } from '../plugins/aidrian/lib/pr-auto-merge.mjs';
import { MEMBER_ASSOCIATIONS, summaryComment, SUMMARY_MARKER } from '../plugins/aidrian/lib/review/state.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const ENTRIES = ['plugins/aidrian/lib/pr-auto-merge.mjs', 'plugins/aidrian/lib/review/run.mjs'];
// What a module loads, by a literal relative path: static imports and re-exports, side-effect and literal dynamic
// imports, and the files it reads next to itself, such as a JSON table or the manifest.
const IMPORTS = [/\bfrom\s*(['"])(\.\.?\/[^'"]+)\1/gu, /\bimport\s*\(?\s*(['"])(\.\.?\/[^'"]+)\1/gu];
const READS = [/import\.meta\.dirname\s*,\s*(['"])([^'"]+)\1\s*\)/gu, /new URL\(\s*(['"])([^'"]+)\1\s*,\s*import\.meta\.url/gu];

// Every file reached from `entries`, as paths from the repository root.
function closure(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!file.endsWith('.mjs')) continue;
    const text = readFileSync(path.join(ROOT, file), 'utf8');
    const target = (spec) => path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
    for (const pattern of IMPORTS) {
      for (const [, , spec] of text.matchAll(pattern)) {
        assert.ok(existsSync(path.join(ROOT, target(spec))), `${file} imports ${spec}, which does not exist`);
        queue.push(target(spec));
      }
    }
    for (const pattern of READS) {
      // A folder read, such as the generated agents a config check lists, is not code the gate runs.
      for (const [, , spec] of text.matchAll(pattern)) if (existsSync(path.join(ROOT, target(spec))) && statSync(path.join(ROOT, target(spec))).isFile()) queue.push(target(spec));
    }
  }
  return [...seen].sort();
}

const guarded = (file) => /decides CI's verdict or auto-merge/u.test(pathsProblem({ files: [{ path: file, changeType: 'MODIFIED' }], changedFiles: 1 }) ?? '');

test('every plugin file the gate and its review load keeps auto-merge off', () => {
  const files = closure(ENTRIES);
  // The walk reaches deep, so a broken walk cannot pass by reaching nothing.
  for (const file of ['plugins/aidrian/lib/review/state.mjs', 'plugins/aidrian/lib/hosts/index.mjs', 'plugins/aidrian/lib/finding-disposition.json', 'plugins/aidrian/hooks/hooks.json']) {
    assert.ok(files.includes(file), `the walk reaches ${file}`);
  }
  const open = files.filter((file) => file.startsWith('plugins/aidrian/') && !guarded(file));
  assert.deepEqual(open, [], 'files the gate loads that a pull request could change under auto-merge');
});

test('the guard still lets through what the gate never loads', () => {
  for (const file of ['plugins/aidrian/lib/report-health.mjs', 'plugins/aidrian/lib/lint.mjs', 'plugins/aidrian/scripts/session-row.mjs', 'plugins/aidrian/agents-src/review/x.md', 'src/lib/hosts/a.js', 'docs/config.md']) {
    assert.equal(guarded(file), false, file);
  }
});

test('no module can add a trusted author association', () => {
  for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) assert.equal(MEMBER_ASSOCIATIONS.has(association), true, association);
  for (const association of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE', undefined]) assert.equal(MEMBER_ASSOCIATIONS.has(association), false, String(association));
  assert.ok(Object.isFrozen(MEMBER_ASSOCIATIONS));
  assert.throws(() => MEMBER_ASSOCIATIONS.add('CONTRIBUTOR'));
  assert.throws(() => Set.prototype.add.call(MEMBER_ASSOCIATIONS, 'CONTRIBUTOR'));
  assert.throws(() => { MEMBER_ASSOCIATIONS.has = () => true; });
  assert.equal(MEMBER_ASSOCIATIONS.has('CONTRIBUTOR'), false, 'still untrusted after every attempt');
  const stranger = { body: `${SUMMARY_MARKER}\nall clear`, author_association: 'CONTRIBUTOR' };
  assert.equal(summaryComment([stranger]), null, "a stranger's summary is not the record");
});
