// A stop that needs the Human asks in the session. Text that sends the Human to a shell must also name the question that
// makes the shell unnecessary, or be listed here as a break-glass override no normal run reaches.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '../plugins/aidrian');
const BREAK_GLASS = new Set([
  'lib/review-gate.mjs',
  'lib/review/in-force.mjs',
  'lib/review/visual.mjs',
  'lib/rules/attribution.mjs',
  'lib/rules/git-amend.mjs',
  'lib/rules/github/pr-body.mjs',
  'lib/rules/main-checkout/checkout.mjs',
  'lib/rules/process-kill.mjs',
]);

test('no plugin text sends the Human to a terminal without an in-session route', () => {
  const files = ['lib', 'skills', 'scripts'].flatMap((dir) => readdirSync(path.join(ROOT, dir), { recursive: true }).map((file) => path.join(dir, String(file))));
  const offenders = files.filter((file) => /\.(mjs|md)$/u.test(file) && !BREAK_GLASS.has(file)).filter((file) => {
    const text = readFileSync(path.join(ROOT, file), 'utf8');
    return /own shell|another terminal|in a terminal/u.test(text) && !text.includes('AskUserQuestion');
  });
  assert.deepEqual(offenders, [], 'ask with AskUserQuestion and let the rule read the answer, or list a true break-glass override here');
});
