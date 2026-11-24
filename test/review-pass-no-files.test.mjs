// A plan command's pass with no `files` key covers any reviewed file, as a pass whose files are null does (#607): once
// it has a result from an earlier head, a step on a new head reads it without a crash, and runs it again when the
// change touches a reviewed file.
import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { readLocalState } from '../plugins/aidrian/lib/review/state.mjs';
import { clean, repo } from './review-run-fixture.mjs';

test('a plan command pass with no file list, with an earlier head\'s result, is reviewed again on a change', async (t) => {
  const planner = "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log(JSON.stringify({depth:'single',stages:[{name:'independent',passes:[{id:'extra:lint',reviewer:'lint',kind:'exec'}]}]})))";
  const reviewer = { kind: 'exec', command: ['node', 'scripts/lint.mjs'], stage: 'independent' };
  const r = repo(t, {
    baseConfig: { version: 1, review: { planCommand: 'node scripts/plan.mjs', reviewers: { lint: reviewer } } },
    baseFiles: { 'scripts/plan.mjs': planner, 'scripts/lint.mjs': '\n' },
    change: (write) => write('src/app.js', 'export const app = 2;\n'),
  });
  const ran = [];
  const exec = async (reviewer) => (reviewer.command?.includes('scripts/lint.mjs') && ran.push('lint'), clean());
  const first = await r.step({ exec });
  assert.deepEqual([first.status, ran], ['received', ['lint']]);
  assert.equal(readLocalState(r.project, 7).passes['extra:lint'].head, first.head);
  r.write('src/app.js', 'export const app = 3;\n');
  const pushed = r.commit('a fix');
  const second = await r.step({ exec });
  assert.deepEqual([second.status, second.head, ran], ['received', pushed, ['lint', 'lint']], 'the change touches a reviewed file: the pass runs again');
});
