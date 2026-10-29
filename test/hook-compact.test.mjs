import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

const HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-compact.mjs');

function hook(input) {
  const { status, stdout, stderr } = spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8' });
  assert.deepEqual([status, stderr], [0, '']);
  return stdout;
}

test('a bare or automatic compaction gets the checklist; whitespace counts as no instructions', () => {
  const checklist = hook(JSON.stringify({ hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: null }));
  assert.match(checklist, /^Preserve everything needed to continue the current task/);
  for (const custom of ['', '   ']) {
    assert.equal(hook(JSON.stringify({ hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: custom })), checklist);
  }
});

test('typed instructions silence the hook, and unreadable stdin still gets the checklist', () => {
  assert.equal(hook(JSON.stringify({ custom_instructions: 'keep only the PR list' })), '');
  const checklist = hook('{}');
  assert.equal(hook('not json'), checklist);
  assert.equal(hook(''), checklist);
});

test('the checklist keeps the sections a task needs to go on, and names nothing project-specific', () => {
  const checklist = hook('{}');
  for (const anchor of ['"done" criteria', 'worktree path', 'output path of any agent', 'verdicts word for word', 'Dead ends', 'lesson skill', 'Output preferences', 'Discard:', 'stale system reminders']) {
    assert.ok(checklist.includes(anchor), `checklist lost: ${anchor}`);
  }
  assert.doesNotMatch(checklist, /dispatch contract|ledger|rtk/i);
});
