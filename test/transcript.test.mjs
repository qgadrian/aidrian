import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readFileSync } from 'node:fs';

import { awaitReview } from '../plugins/aidrian/lib/pr-await-review.mjs';
import { EXIT } from '../plugins/aidrian/lib/review/run.mjs';
import {
  aggregateUsage, estimateCostUsd, filesRead, partOf, priceFor, REVIEW_OUTPUT_STATUSES, sessionActions, subagentTranscripts, sumTokens, launchedTaskIds,
} from '../plugins/aidrian/lib/transcript.mjs';

// One transcript line: an assistant message with usage, as Claude Code writes it.
const usageLine = (id, model, usage, { ts = '2026-10-29T10:00:00Z', content = [] } = {}) =>
  JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, model, usage, content } });

test('usage counts once per request: the lines of one message id repeat its usage, and the last one wins', () => {
  const text = [
    usageLine('m1', 'claude-opus-5-5', { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 100 }),
    usageLine('m1', 'claude-opus-5-5', { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 100 }, { ts: '2026-10-29T10:05:00Z' }),
    usageLine('m2', 'claude-sonnet-5-5', { input_tokens: 5, output_tokens: 2, cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 4 } }),
    usageLine('m3', '<synthetic>', { input_tokens: 999 }),
    'not json',
    '',
  ].join('\n');
  const { perModel, firstTs, lastTs } = aggregateUsage(text);
  assert.deepEqual(perModel['claude-opus-5-5'], { calls: 1, input: 10, output: 7, cacheRead: 100, cacheWrite5m: 0, cacheWrite1h: 0 });
  assert.deepEqual(perModel['claude-sonnet-5-5'], { calls: 1, input: 5, output: 2, cacheRead: 0, cacheWrite5m: 3, cacheWrite1h: 4 });
  assert.equal(perModel['<synthetic>'], undefined);
  assert.deepEqual([firstTs, lastTs], ['2026-10-29T10:00:00Z', '2026-10-29T10:05:00Z']);
  assert.deepEqual(sumTokens(perModel), { input: 15, output: 9, cache_read: 100, cache_write: 7, cache_write_5m: 3, cache_write_1h: 4 });
});

test('effort is the last request`s stamped level; tool calls count once per tool id, per request', () => {
  const tool = (id) => ({ type: 'tool_use', id, name: 'Read', input: {} });
  const line = (id, effort, content) => JSON.stringify({ type: 'assistant', effort, message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 1 }, content } });
  const text = [
    line('m1', 'high', [tool('t1')]),
    line('m1', 'high', [tool('t2')]),
    line('m1', 'high', [tool('t2')]),
    line('m2', 'medium', [{ type: 'text', text: 'SECRET' }]),
    line('m3', 'medium', [tool('t3')]),
  ].join('\n');
  const acc = aggregateUsage(text);
  assert.deepEqual([acc.effort, [...acc.efforts]], ['medium', ['high', 'medium']]);
  assert.deepEqual(partOf(acc), { perModel: acc.perModel, requests: 3, tool_requests: 2, tool_calls: 3 });
  assert.deepEqual(partOf(acc, (key) => key === 'm1'), { perModel: { 'claude-opus-5-5': { calls: 1, input: 1, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } }, requests: 1, tool_requests: 1, tool_calls: 2 });
  assert.equal(aggregateUsage(line('m4', undefined, []), acc).effort, null, 'a last request with no level: null, not an older level');
  assert.doesNotMatch(JSON.stringify(partOf(acc)), /SECRET/);
});

test('a request found in two transcripts folded into one result counts once', () => {
  const line = usageLine('shared', 'claude-opus-5-5', { input_tokens: 1, output_tokens: 1 });
  const once = aggregateUsage(line);
  assert.equal(aggregateUsage(line, once).perModel['claude-opus-5-5'].calls, 1);
});

test('cost follows the price map: cache reads and writes at their multipliers, unknown models listed', () => {
  assert.equal(priceFor('claude-opus-5-5').input, 4);
  assert.equal(priceFor('claude-sonnet-4-6').input, 3, 'the family fallback');
  const perModel = {
    'claude-opus-5-5': { calls: 1, input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000 },
    'gpt-x': { calls: 1, input: 5, output: 5, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
  };
  // 4 input + 20 output + 4 * 0.05 cache read + 4 * 1.25 + 4 * 2 cache writes.
  assert.deepEqual(estimateCostUsd(perModel), { total: 37.2, unknownModels: ['gpt-x'], byModel: { 'claude-opus-5-5': 37.2 } });
});

test('sessionActions: the skills a session ran, the drafts it opened, and its review runs, each call counted once', () => {
  const call = (id, name, input) => usageLine(`m-${id}`, 'claude-opus-5-5', {}, { content: [{ type: 'tool_use', id, name, input }] });
  const result = (id, content, isError = false) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
  const typed = (uuid, text) => JSON.stringify({ type: 'user', uuid, message: { role: 'user', content: text } });
  const main = [
    typed('u1', '<command-message>aidrian:autopilot</command-message>\n<command-name>/aidrian:autopilot</command-name>\n<command-args>ABC-1</command-args>'),
    typed('u2', '<command-name>/clear</command-name>'),
    call('s1', 'Skill', { skill: 'aidrian:issue-implement' }),
    result('s1', 'Launching skill: aidrian:issue-implement'),
    // A refused create, a create that is not a draft, and a draft create that opened #12.
    call('b1', 'Bash', { command: 'gh pr create --draft --title t --body-file b.md' }),
    result('b1', 'pr-body: the body has no ## Summary heading.', true),
    call('b2', 'Bash', { command: 'gh pr create --title t --body-file b.md' }),
    result('b2', 'https://github.com/acme/notes/pull/11'),
    call('b3', 'Bash', { command: 'cd /w && gh -R acme/notes pr create -d --base main --title t --body-file b.md' }),
    result('b3', [{ type: 'text', text: 'https://github.com/acme/notes/pull/12' }]),
    // A tool result that quotes a slash command is not one.
    result('x1', '<command-name>/aidrian:pr-review-loop</command-name>'),
  ].join('\n');
  assert.deepEqual(sessionActions([main]), { skills: ['aidrian:autopilot', 'aidrian:issue-implement'], drafts_opened: 1, review_runs: 0 },
    'only the draft create that returned a pull request counts; the host`s own command is no skill');
  // A forked subagent repeats the main conversation's calls, then runs the review loop and its command.
  const subagent = [main, call('s2', 'Skill', { skill: 'aidrian:pr-review-loop' }), result('s2', 'Launching skill: aidrian:pr-review-loop'),
    call('b4', 'Bash', { command: 'aidrian pr review 12 --with-bot' }), result('b4', '{\n  "status": "dispatch",\n  "pr": 12\n}')].join('\n');
  assert.deepEqual(sessionActions([main, subagent]), {
    skills: ['aidrian:autopilot', 'aidrian:issue-implement', 'aidrian:pr-review-loop'], drafts_opened: 1, review_runs: 2,
  });
  assert.deepEqual(sessionActions([]), { skills: [], drafts_opened: 0, review_runs: 0 });
});

test('sessionActions counts a review run or a skill only by its result: a refused call, or one with no result, counts nowhere', () => {
  const call = (id, name, input) => usageLine(`m-${id}`, 'claude-opus-5-5', {}, { content: [{ type: 'tool_use', id, name, input }] });
  const result = (id, content, isError = false) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
  // Every case opens draft #40 first, so an uncounted review leaves it unreviewed.
  const draft = [call('d1', 'Bash', { command: 'gh pr create --draft --title t --body-file b.md' }), result('d1', 'https://github.com/acme/notes/pull/40')];
  const actions = (...lines) => sessionActions([[...draft, ...lines].join('\n')]);
  const review = { command: 'aidrian pr review 40 --with-bot' };
  const loop = { skill: 'aidrian:pr-review-loop' };
  const none = { skills: [], drafts_opened: 1, review_runs: 0 };

  // Refused, so it never ran. Claude Code writes each as an error result with no `Exit code N` line; the texts are its own.
  const refusals = {
    'a hook': 'PreToolUse:Bash hook error: [node "/p/scripts/hook-bash.mjs"]: Blocked: the body carries a footer.',
    'a hook, by its own reason': 'Blocked: `git commit --amend` rewrites the branch tip.',
    'the permissions': 'Permission to use Bash with command aidrian pr review 40 --with-bot has been denied.',
    'the auto mode classifier': 'Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Data Exfiltration].',
    'the user': "The user doesn't want to proceed with this tool use. The tool use was rejected.",
    'the tool': '<tool_use_error>InputValidationError: Bash failed</tool_use_error>',
  };
  for (const [by, text] of Object.entries(refusals)) {
    assert.deepEqual(actions(call('r1', 'Bash', review), result('r1', text, true)), none, `a review refused by ${by}`);
  }
  assert.deepEqual(actions(call('k1', 'Skill', loop), result('k1', refusals['the auto mode classifier'], true)), none,
    'a refused Skill call runs no skill and no review');
  assert.deepEqual(actions(call('k1', 'Skill', { skill: 'aidrian:autopilot' }), result('k1', '<tool_use_error>Unknown skill: autopilot</tool_use_error>', true)),
    none, 'a refused skill is not listed');

  // Ran: the result holds the JSON object the review command prints, whatever the exit and whichever command set it.
  const printed = (status) => JSON.stringify({ status, pr: 40, repo: 'acme/notes', head: 'abc1234' }, null, 2);
  assert.deepEqual(actions(call('r1', 'Bash', review), result('r1', printed('received'))), { ...none, review_runs: 1 }, 'a review that ran');
  assert.deepEqual(actions(call('r1', 'Bash', review), result('r1', `Exit code 4\n${printed('round_limit')}`, true)), { ...none, review_runs: 1 },
    'a review that ran and hit the round cap');
  assert.deepEqual(actions(call('r1', 'Bash', { command: 'aidrian pr review 40; test -f optional.json' }), result('r1', `Exit code 1\n${printed('dispatch')}`, true)),
    { ...none, review_runs: 1 }, 'a review that ran in a line a later command failed');
  assert.deepEqual(actions(call('r1', 'Bash', { command: 'aidrian pr await-review 40' }), result('r1', '{"status":"no_reviewer","pr":null}')),
    { ...none, review_runs: 1 }, 'compact JSON, and a pull request the command did not resolve');

  // Not run: an exit code belongs to the whole line, so without the review's own output nothing shows a review ran.
  for (const [command, text, why] of [
    ['false && aidrian pr review 40', 'Exit code 1', 'a step before it failed'],
    ['cd /missing && aidrian pr review 40', 'Exit code 1\n(eval):cd:1: no such file or directory: /missing', 'a cd before it failed'],
    ['aidrian pr review 40 --x', 'Exit code 1\naidrian pr review: unknown argument: --x', 'the command refused its arguments'],
    ['aidrian pr review 40 | head -1', '{', 'the output was cut before the status'],
    ['aidrian pr review 40', `Exit code 1\n${JSON.stringify({ status: 'merged', pr: 40 })}`, 'a status neither command prints'],
  ]) assert.deepEqual(actions(call('r1', 'Bash', { command }), result('r1', text, true)), none, `no review ran: ${why}`);
  const quoting = `echo '${printed('received')}' > /dev/null; aidrian pr review 40`;
  assert.deepEqual(actions(call('r1', 'Bash', { command: quoting }), result('r1', `Permission to use Bash with command ${quoting} has been denied.`, true)), none,
    'a refusal that quotes a command holding the JSON');
  assert.deepEqual(sessionActions([[...draft, call('r1', 'Bash', { command: `echo '{"status":"received","pr":1}'` }), result('r1', '{"status":"received","pr":1}')].join('\n')]), none,
    'the JSON printed by a line that runs no review command');
  assert.deepEqual(actions(call('k1', 'Skill', loop), result('k1', 'Launching skill: aidrian:pr-review-loop')),
    { skills: ['aidrian:pr-review-loop'], drafts_opened: 1, review_runs: 1 }, 'a review skill that ran');

  // No result at all, as in a session cut off mid-call: nothing shows the call ran, so it counts nowhere, as a draft does not.
  assert.deepEqual(actions(call('r1', 'Bash', review), call('k1', 'Skill', loop)), none, 'calls with no result');
  assert.deepEqual(sessionActions([call('d2', 'Bash', { command: 'gh pr create --draft --fill' })]), { skills: [], drafts_opened: 0, review_runs: 0 },
    'a draft create with no result');
  // A slash command has no tool result: the host ran it before the turn, so it still counts.
  const typed = JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: '<command-name>/aidrian:pr-review-loop</command-name>' } });
  assert.deepEqual(actions(typed), { skills: ['aidrian:pr-review-loop'], drafts_opened: 1, review_runs: 1 }, 'a typed review skill');
});

test('the statuses a review run is read by are every status aidrian pr review and aidrian pr await-review print, status then pr', async () => {
  const lib = new URL('../plugins/aidrian/lib/', import.meta.url);
  const literals = (text) => [...text.matchAll(/'([a-z_]+)'/gu)].map((match) => match[1]);
  const statuses = (source, builder) => [
    ...[...source.matchAll(/\{ status: '([a-z_]+)', pr:/gu)].map((match) => match[1]),
    ...[...source.matchAll(new RegExp(`\\b${builder}\\(([^,)]*)`, 'gu'))].flatMap((match) => literals(match[1])),
  ];
  const run = readFileSync(new URL('review/run.mjs', lib), 'utf8');
  const wait = readFileSync(new URL('pr-await-review.mjs', lib), 'utf8');
  // Every object either command prints puts `status` first and `pr` next, which is what the reader matches.
  assert.match(run, /const result = \{ status, pr: n,/u, 'aidrian pr review builds its result status, then pr');
  assert.match(wait, /return \{\n\s+status,\n\s+pr: Number\(n\),/u, 'aidrian pr await-review builds its result status, then pr');
  const exitCodes = [...wait.matchAll(/if \(status === '([a-z_]+)'\) return \d+;/gu)].map((match) => match[1]);
  const printed = new Set([...Object.keys(EXIT), ...statuses(run, 'finish'), ...statuses(wait, 'result'), ...exitCodes]);
  assert.deepEqual([...REVIEW_OUTPUT_STATUSES].sort(), [...printed].sort());

  // The real output of one of them reads as a run.
  const output = JSON.stringify(await awaitReview({ pr: '40', reviewer: null }, { git: {} }), null, 2);
  const line = (entry) => JSON.stringify(entry);
  const transcript = [
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'w1', name: 'Bash', input: { command: 'aidrian pr await-review 40' } }] } }),
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'w1', content: output }] } }),
  ].join('\n');
  assert.equal(sessionActions([transcript]).review_runs, 1);
});

test('sessionActions reads the commands a Bash call runs, not the text that names one', () => {
  const call = (id, command) => usageLine(`m-${id}`, 'claude-opus-5-5', {}, { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] });
  const opened = (id, n) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `https://github.com/acme/notes/pull/${n}\n{\n  "status": "received",\n  "pr": ${n}\n}` }] } });
  const actions = (command) => {
    const { drafts_opened, review_runs } = sessionActions([[call('c1', command), opened('c1', 30)].join('\n')]);
    return { drafts_opened, review_runs };
  };
  assert.deepEqual(actions('gh pr create \\\n  --title x \\\n  --draft'), { drafts_opened: 1, review_runs: 0 }, 'a create continued over lines');
  assert.deepEqual(actions('url=$(gh pr new -fd --base main)'), { drafts_opened: 1, review_runs: 0 }, 'a draft create in a substitution');
  assert.deepEqual(actions('gh pr create --title "use --draft later" --body-file b.md'), { drafts_opened: 0, review_runs: 0 }, 'a title naming the flag');
  assert.deepEqual(actions('gh pr create --title -d --body-file b.md'), { drafts_opened: 0, review_runs: 0 }, 'a title whose value is -d');
  assert.deepEqual(actions('gh pr create --draft=false --title t'), { drafts_opened: 0, review_runs: 0 }, 'a draft flag turned off');
  assert.deepEqual(actions('echo "next: gh pr create --draft --fill"'), { drafts_opened: 0, review_runs: 0 }, 'an echo of a draft create');
  assert.deepEqual(actions('echo "aidrian pr review 12"'), { drafts_opened: 0, review_runs: 0 }, 'an echo of the review command');
  assert.deepEqual(actions("cat > notes.md <<'EOF'\nNext: aidrian pr review 12 --with-bot\nEOF"), { drafts_opened: 0, review_runs: 0 }, 'a heredoc body');
  assert.deepEqual(actions("grep -rn 'aidrian pr await-review' plugins"), { drafts_opened: 0, review_runs: 0 }, 'a quoted grep pattern');
  assert.deepEqual(actions('cd /w && aidrian pr review 12 --with-bot'), { drafts_opened: 0, review_runs: 1 }, 'a review run after cd');
  assert.deepEqual(actions('/opt/plugin/bin/aidrian pr await-review 12'), { drafts_opened: 0, review_runs: 1 }, 'aidrian by its path');
  assert.deepEqual(actions('node /opt/plugin/lib/cli.mjs pr review 12'), { drafts_opened: 0, review_runs: 1 }, 'the cli run by node');
  assert.deepEqual(actions('aidrian pr status 12'), { drafts_opened: 0, review_runs: 0 }, 'another pr subcommand');
});

test('launchedTaskIds takes the ids the host results give the calls that launched or resumed a task, and no mention of one', () => {
  const call = (id, toolId, name, input) => usageLine(id, 'claude-opus-5-5', {}, { content: [{ type: 'tool_use', id: toolId, name, input }] });
  const result = (toolId, content) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content }] } });
  const lines = [
    call('m-parent', 't0', 'Bash', { command: 'git push', run_in_background: true }),
    result('t0', 'Command running in background with ID: bparent01. Output is being written to: /tmp/tasks/bparent01.output'),
    call('m1', 't1', 'Bash', { command: 'npm test', run_in_background: true }),
    result('t1', [{ type: 'text', text: 'Command running in background with ID: bown0001. Output is being written to: /tmp/tasks/bown0001.output' }]),
    call('m2', 't2', 'Bash', { command: 'git push -u origin x', timeout: 120000 }),
    result('t2', 'Command did not complete within its 120s timeout and was moved to the background (ID: bmoved01). Output is being written to: /tmp/tasks/bmoved01.output.'),
    call('m3', 't3', 'Agent', { description: 'Review', prompt: 'Review it.', run_in_background: true }),
    result('t3', [{ type: 'text', text: 'Async agent launched successfully.\nagentId: aown00001 (internal ID)\nThe agent is working in the background.' }]),
    call('m4', 't4', 'SendMessage', { to: 'aold00001', message: 'Again, please.' }),
    result('t4', [{ type: 'text', text: '{"success":true,"message":"Resuming agent aold000","resumedAgentId":"aold00001"}' }]),
    // Reading, waiting on, or stopping another agent's task names its id, and launches nothing.
    call('m5', 't5', 'Bash', { command: 'tail /tmp/tasks/bother001.output; grep -r "background with ID" ~/.claude/projects' }),
    result('t5', 'pushing...\n"content":"Command running in background with ID: bquoted1. Output"'),
    call('m6', 't6', 'TaskStop', { task_id: 'bother002' }),
    result('t6', 'Successfully stopped task: bother002'),
    call('m7', 't7', 'SendMessage', { to: 'aother001', message: 'Status?' }),
    result('t7', [{ type: 'text', text: '{"success":true,"message":"Message sent to aother001\'s inbox"}' }]),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Command running in background with ID: bloose01.' } }),
  ].join('\n');
  assert.deepEqual([...launchedTaskIds(lines, (key) => key !== 'm-parent')].sort(), ['aold00001', 'aown00001', 'bmoved01', 'bown0001']);
  assert.ok(launchedTaskIds(lines).has('bparent01'), 'without `keep`, every call counts');
});

test('filesRead lists each Read file_path once; subagentTranscripts finds a session`s subagent files', (t) => {
  const read = (file) => usageLine(file, 'claude-opus-5-5', {}, { content: [{ type: 'tool_use', name: 'Read', input: { file_path: file } }] });
  const other = usageLine('x', 'claude-opus-5-5', {}, { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'cat /a.md' } }] });
  assert.deepEqual(filesRead([read('/r/a.md'), other, read('/r/b.md'), read('/r/a.md')].join('\n')), ['/r/a.md', '/r/b.md']);
  assert.deepEqual(filesRead([read('/r/a.md'), read('/r/b.md')].join('\n'), (key) => key !== '/r/a.md'), ['/r/b.md'], 'only the requests `keep` takes');

  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-transcript-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 's-1/subagents'), { recursive: true });
  writeFileSync(path.join(dir, 's-1/subagents/agent-a.jsonl'), '');
  writeFileSync(path.join(dir, 's-1/subagents/agent-a.meta.json'), '{}');
  assert.deepEqual(subagentTranscripts(path.join(dir, 's-1.jsonl'), 's-1'), [path.join(dir, 's-1/subagents/agent-a.jsonl')]);
  assert.deepEqual(subagentTranscripts(path.join(dir, 's-1.jsonl'), '../s-1'), [], 'a session id never builds a path outside');
  assert.deepEqual(subagentTranscripts(path.join(dir, 'none.jsonl'), 'none'), []);
});

test('Opus 4 and 4.1 cost $15/$75, Opus 4.5 and later $5/$25, and the Claude 3 models have their own rows', () => {
  const rates = (model) => [priceFor(model)?.input, priceFor(model)?.output];
  assert.deepEqual(rates('claude-opus-4-20250514'), [15, 75]);
  assert.deepEqual(rates('claude-opus-4-1-20250805'), [15, 75]);
  assert.deepEqual(rates('claude-opus-4-5-20251101'), [5, 25]);
  assert.deepEqual(rates('claude-opus-4-6'), [5, 25]);
  assert.deepEqual(rates('claude-3-5-haiku-20241022'), [0.8, 4]);
  assert.deepEqual(rates('claude-3-haiku-20240307'), [0.25, 1.25]);
  assert.deepEqual(rates('claude-3-opus-20240229'), [15, 75]);
});
