// The markers that start a post the engine makes, as each writer builds them, against the one reader that refuses them
// as outside evidence (lib/review-gate.mjs engineMarked): a writer that changes its marker fails here, not in a sign-off.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { feedbackMarker } from '../plugins/aidrian/lib/pr-product-feedback.mjs';
import { engineMarked } from '../plugins/aidrian/lib/review-gate.mjs';
import { attributionLine, markerLine } from '../plugins/aidrian/lib/review/inline.mjs';
import { SUMMARY_MARKER } from '../plugins/aidrian/lib/review/state.mjs';

test('every engine post, as its writer starts it, reads as the engine`s: the product feedback, a finding, and the summary', () => {
  assert.ok(engineMarked(`${feedbackMarker({ number: 7, repo: 'o/r' })}\nThe persona walk found nothing.`), 'the product feedback comment');
  assert.ok(engineMarked(`${markerLine('R1-1')}\n${attributionLine('R1-1')}\ntext`), 'a finding`s post');
  assert.ok(engineMarked(`${SUMMARY_MARKER}\n## Review`), 'the review summary');
  assert.ok(!engineMarked('The persona walk found nothing.'), 'a person`s comment');
});
