import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { projectAt } from '../plugins/aidrian/lib/project.mjs';
import { passInput } from '../plugins/aidrian/lib/review/dispatch.mjs';
import { reviewPrompt, runExec } from '../plugins/aidrian/lib/review/reviewers.mjs';
import { reviewStep } from '../plugins/aidrian/lib/review/run.mjs';
import { MAX_RESIDUAL_CHARS, MAX_RESIDUALS, MAX_SETTLED, namedBy, offeredCarried, recordSettled, residualTexts, RULED_HEADING, ruledLines, settledBrief, settledEntries, splitRuled } from '../plugins/aidrian/lib/review/settled.mjs';
import { emptyState, readLocalState, summaryBody, writeLocalState } from '../plugins/aidrian/lib/review/state.mjs';

const body = (items, section = 'Accepted residuals') => `## Summary\n\nWhy.\n\n## ${section}\n\n${items.map((item) => `- ${item}`).join('\n')}\n\n## Tests\n\n- npm test\n`;

test('residualTexts: the body section\'s items as trimmed texts, capped in count and length, each once', () => {
  assert.deepEqual(residualTexts(body(['The retry loop has no cap', '  The retry loop has no cap ', 'Slow on cold start'])), ['The retry loop has no cap', 'Slow on cold start']);
  assert.deepEqual(residualTexts(body(['Mine'], 'Known gaps'), 'Known gaps'), ['Mine'], 'the configured section name');
  assert.deepEqual(residualTexts(body(['Mine'], 'Known gaps'), null), [], 'another section is not the residuals');
  assert.deepEqual(residualTexts('## Summary\n\nNothing.\n'), []);
  assert.deepEqual(residualTexts(undefined), []);
  const many = residualTexts(body(Array.from({ length: MAX_RESIDUALS + 5 }, (_, i) => `residual ${i}`)));
  assert.equal(many.length, MAX_RESIDUALS);
  assert.equal(residualTexts(body(['x'.repeat(MAX_RESIDUAL_CHARS + 50)]))[0].length, MAX_RESIDUAL_CHARS);
});

test('recordSettled: accepted findings of any pass that no longer block, then the last rulings on a prior finding, each once', () => {
  const state = {
    passes: {
      'agent:code-reviewer': { head: 'h1', list: [
        { title: 'Accepted', file: 'a.js', severity: 'low', likelihood: 'routine', affects: 'users', state: 'accepted', disposition: 'drop_unless_cited' },
        { title: 'Labelled accepted', file: 'a.js', severity: 'critical', state: 'accepted', disposition: 'fix_now' },
        { title: 'Open', file: 'a.js', severity: 'low', state: 'open', disposition: 'drop_unless_cited' },
        { title: 'Fixed', file: 'a.js', severity: 'low', state: 'fixed', disposition: 'drop_unless_cited' },
      ] },
      'engine:codex-local': { head: 'h1', list: [{ title: 'Codex open', file: 'a.js', line: 2, severity: 'high' }] },
    },
  };
  const prior = { head: 'h1', ruled: [
    { title: 'Same cause, new words', file: 'b.js', line: 4, severity: 'low', already_ruled: 'Root finding', from: 'prior' },
    { title: 'Residual repeat', file: 'b.js', line: 5, severity: 'low', already_ruled: 'The retry loop has no cap', from: 'residual' },
    { title: 'Accepted again', file: 'a.js', line: 1, severity: 'low', already_ruled: 'Accepted', from: 'prior' },
  ] };
  const settled = recordSettled(state, prior);
  assert.deepEqual(settled.map((each) => [each.title, each.file, each.state]), [['Accepted', 'a.js', 'accepted'], ['Root finding', 'b.js', 'accepted']],
    'a blocking, open, fixed, or unclassified entry settles nothing; a residual ruling is not carried; a duplicate is kept once');
  assert.equal(settled[0].likelihood, 'routine', 'an accepted finding keeps its axes');
  assert.equal(settled[0].settled_by, 'agent:code-reviewer', 'an accepted finding names the pass that accepted it');
  assert.deepEqual(settledEntries({ priorFindings: settled }), [{ title: 'Accepted', file: 'a.js', severity: 'low', settled_by: 'agent:code-reviewer' }, { title: 'Root finding', file: 'b.js', severity: 'low' }]);
  assert.deepEqual(recordSettled({}, null), []);
  const lots = { passes: { p: { list: Array.from({ length: MAX_SETTLED + 10 }, (_, i) => ({ title: `t${i}`, file: 'a.js', severity: 'low', state: 'accepted', disposition: 'drop_unless_cited' })) } } };
  assert.equal(recordSettled(lots, null).length, MAX_SETTLED);
});

// The step context passInput reads, for one pass on one head with no git history to walk.
function context({ state, map, info, residuals = null }) {
  return {
    config: { github: { reviewGate: { enabled: false }, pullRequest: { residuals } } },
    root: '/nowhere', repo: 'o/r', n: 7, head: 'h1', base: 'b1', baseTip: 'b1', changes: [], scope: null, state, plan: { flows: [] },
    resultFor: () => null, sameFiles: () => true, verdictsFor: () => [], visual: null, manifest: null, isVisual: () => false, map, info,
  };
}

test('passInput: an exec pass reads the body\'s residuals and the record\'s settled findings; an agent pass reads neither', () => {
  const state = { ...emptyState(7, 'o/r'), passes: {
    'engine:codex-local': { head: 'h1', files: null, list: [{ title: 'Codex open', file: 'a.js', line: 2, severity: 'high' }], ruled: [{ title: 'Again', file: 'b.js', line: 4, severity: 'low', already_ruled: 'Root finding', from: 'prior' }] },
    'agent:code-reviewer': { head: 'h1', files: null, list: [{ title: 'Accepted', file: 'a.js', severity: 'low', state: 'accepted', disposition: 'drop_unless_cited' }] },
  } };
  const map = { 'codex-local': { kind: 'exec' }, 'code-reviewer': { kind: 'agent' } };
  const s = context({ state, map, info: { body: body(['The retry loop has no cap']) } });
  const stage = { name: 'independent', passes: [] };
  const exec = passInput(s, { id: 'engine:codex-local', reviewer: 'codex-local', files: null }, stage);
  assert.deepEqual(exec.acceptedResiduals, ['The retry loop has no cap']);
  assert.deepEqual(exec.priorFindings.map((each) => each.title), ['Codex open', 'Accepted', 'Root finding'], 'its own last findings, then what is settled');
  assert.deepEqual(settledEntries(exec), [
    { title: 'Accepted', file: 'a.js', severity: 'low', settled_by: 'agent:code-reviewer' },
    { title: 'Root finding', file: 'b.js', severity: 'low' },
    { title: 'The retry loop has no cap' },
  ]);
  const custom = passInput(context({ state, map, info: { body: body(['Mine'], 'Known gaps') }, residuals: { section: 'Known gaps' } }), { id: 'engine:codex-local', reviewer: 'codex-local', files: null }, stage);
  assert.deepEqual(custom.acceptedResiduals, ['Mine'], 'github.pullRequest.residuals.section names the section');
  const agent = passInput(s, { id: 'agent:code-reviewer', reviewer: 'code-reviewer', kind: 'agent', files: null }, { name: 'local', passes: [] });
  assert.ok(!('acceptedResiduals' in agent));
  assert.deepEqual(agent.priorFindings.map((each) => each.title), ['Accepted']);
});

test('a ruling on a prior finding holds on the next head, after the finding it named has left the record', () => {
  const map = { 'codex-local': { kind: 'exec' }, 'code-reviewer': { kind: 'agent' } };
  const pass = { id: 'engine:codex-local', reviewer: 'codex-local', files: null };
  const stage = { name: 'independent', passes: [pass] };
  const answer = [{ file: 'a.js', line: 3, title: 'The same cause', body: 'b', severity: 'low', already_ruled: 'Accepted' }];
  const state = { ...emptyState(7, 'o/r'), passes: {
    'agent:code-reviewer': { head: 'h1', files: null, list: [{ title: 'Accepted', file: 'a.js', severity: 'low', state: 'accepted', disposition: 'drop_unless_cited' }] },
  } };
  const first = splitRuled(answer, settledEntries(passInput(context({ state, map, info: { body: '' } }), pass, stage)));
  assert.deepEqual(first.ruled.map((each) => [each.title, each.already_ruled, each.from, each.settled_by]), [['The same cause', 'Accepted', 'prior', 'agent:code-reviewer']]);
  // The next head: the code-reviewer re-ran and no longer lists the finding; codex-local's record holds its ruling.
  state.passes['agent:code-reviewer'] = { head: 'h2', files: null, list: [] };
  state.passes['engine:codex-local'] = { head: 'h1', files: null, list: first.findings, ruled: first.ruled };
  const second = splitRuled(answer, settledEntries(passInput(context({ state, map, info: { body: '' } }), pass, stage)));
  assert.deepEqual(second.findings, [], 'the ruled finding is not re-raised on the next round');
  assert.deepEqual(second.ruled.map((each) => [each.already_ruled, each.settled_by]), [['Accepted', 'agent:code-reviewer']], 'the carried ruling still names the pass that accepted it');
});

// codex-local's answer on h1, with the code-reviewer's record on h1 holding `accepted`; then the next head's settled list.
function nextHead(accepted, h1Answer, h2List) {
  const map = { 'codex-local': { kind: 'exec' }, 'code-reviewer': { kind: 'agent' } };
  const pass = { id: 'engine:codex-local', reviewer: 'codex-local', files: null };
  const stage = { name: 'independent', passes: [pass] };
  const state = { ...emptyState(7, 'o/r'), passes: { 'agent:code-reviewer': { head: 'h1', files: null, list: [accepted] } } };
  const first = splitRuled(h1Answer, settledEntries(passInput(context({ state, map, info: { body: '' } }), pass, stage)));
  state.passes['agent:code-reviewer'] = { head: 'h2', files: null, list: h2List };
  state.passes['engine:codex-local'] = { head: 'h1', files: null, list: first.findings, ruled: first.ruled };
  return { first, settled: settledEntries(passInput(context({ state, map, info: { body: '' } }), pass, stage)) };
}

test('a carried ruling keeps the settled finding\'s severity as its cap, not the repeat\'s', () => {
  const accepted = { title: 'Accepted', file: 'a.js', severity: 'medium', likelihood: 'contrived', affects: 'users', state: 'accepted', disposition: 'accepted_residual' };
  const { first, settled } = nextHead(accepted, [{ file: 'a.js', line: 3, title: 'Low repeat', body: 'b', severity: 'low', already_ruled: 'Accepted' }], []);
  assert.deepEqual(first.ruled.map((each) => [each.severity, each.settled_severity]), [['low', 'medium']]);
  const medium = splitRuled([{ file: 'a.js', line: 4, title: 'Medium repeat', body: 'b', severity: 'medium', already_ruled: 'Accepted' }], settled);
  assert.deepEqual(medium.findings, [], 'a medium repeat is still waived after the original left the record');
  assert.deepEqual(medium.ruled.map((each) => [each.title, each.settled_severity]), [['Medium repeat', 'medium']]);
});

test('a carried ruling is dropped once any pass holds its source as fixed or open, or blocking', () => {
  const accepted = { title: 'Accepted', file: 'a.js', severity: 'low', state: 'accepted', disposition: 'drop_unless_cited' };
  const answer = [{ file: 'a.js', line: 3, title: 'The same cause', body: 'b', severity: 'low', already_ruled: 'Accepted' }];
  for (const [label, source] of [
    ['fixed', { title: 'Accepted', file: 'a.js', state: 'fixed' }],
    ['reopened', { title: 'Accepted', file: 'a.js', severity: 'low', state: 'open', disposition: 'drop_unless_cited' }],
    ['fix_now', { title: 'Accepted', file: 'a.js', severity: 'critical', state: 'accepted', disposition: 'fix_now' }],
  ]) {
    const { first, settled } = nextHead(accepted, answer, [source]);
    assert.equal(first.ruled.length, 1, `${label}: the ruling was made on h1`);
    const again = splitRuled(answer, settled);
    assert.deepEqual(again.findings.map((each) => each.title), ['The same cause'], `${label}: the repeat is new again`);
    assert.deepEqual(again.ruled, [], `${label}: nothing is waived`);
  }
  const { settled } = nextHead(accepted, answer, [{ title: 'Accepted', file: 'b.js', state: 'open' }]);
  assert.equal(splitRuled(answer, settled).ruled.length, 1, 'the same title in another file leaves the ruling standing');
});

test('a direct acceptance settles nothing while any pass lists that title in that file as fixed, open, or blocking', () => {
  const accepted = { title: 'Accepted', file: 'a.js', severity: 'low', state: 'accepted', disposition: 'drop_unless_cited' };
  const answer = [{ file: 'a.js', line: 3, title: 'The same cause', body: 'b', severity: 'low', already_ruled: 'Accepted' }];
  for (const [label, other] of [
    ['fixed', { title: 'Accepted', file: 'a.js', state: 'fixed' }],
    ['open', { title: 'Accepted', file: 'a.js', severity: 'low', state: 'open', disposition: 'drop_unless_cited' }],
    ['fix_now', { title: 'Accepted', file: 'a.js', severity: 'critical', state: 'accepted', disposition: 'fix_now' }],
  ]) {
    const state = { passes: { 'agent:code-reviewer': { head: 'h1', list: [accepted] }, 'agent:security-reviewer': { head: 'h1', list: [other] } } };
    const settled = settledEntries({ priorFindings: recordSettled(state, null) });
    assert.deepEqual(settled, [], `${label}: the acceptance is not offered`);
    assert.deepEqual(splitRuled(answer, settled).findings.map((each) => each.title), ['The same cause'], `${label}: the repeat is new`);
  }
  const elsewhere = { passes: { 'agent:code-reviewer': { head: 'h1', list: [accepted] }, 'agent:security-reviewer': { head: 'h1', list: [{ title: 'Accepted', file: 'b.js', state: 'open' }] } } };
  assert.equal(splitRuled(answer, settledEntries({ priorFindings: recordSettled(elsewhere, null) })).ruled.length, 1, 'the same title in another file leaves the acceptance standing');
});

test('a carried ruling yields to its source while any pass lists it: re-attested lower, the source\'s severity governs', () => {
  const accepted = { title: 'Accepted', file: 'a.js', severity: 'medium', likelihood: 'contrived', affects: 'users', state: 'accepted', disposition: 'accepted_residual' };
  const lower = { title: 'Accepted', file: 'a.js', severity: 'low', state: 'accepted', disposition: 'drop_unless_cited' };
  const { first, settled } = nextHead(accepted, [{ file: 'a.js', line: 3, title: 'Low repeat', body: 'b', severity: 'low', already_ruled: 'Accepted' }], [lower]);
  assert.equal(first.ruled[0].settled_severity, 'medium', 'the ruling on h1 carries a medium cap');
  assert.deepEqual(settled.filter((each) => each.title === 'Accepted'), [{ title: 'Accepted', file: 'a.js', severity: 'low', settled_by: 'agent:code-reviewer' }], 'only the source, at its severity now');
  const medium = splitRuled([{ file: 'a.js', line: 4, title: 'Medium repeat', body: 'b', severity: 'medium', already_ruled: 'Accepted' }], settled);
  assert.deepEqual(medium.findings.map((each) => each.title), ['Medium repeat'], 'a medium repeat stays new');
  assert.deepEqual(medium.ruled, []);
});

test('offeredCarried: the carried rulings of an input, as ruled entries of a prior finding; nothing else', () => {
  const input = { priorFindings: [
    { title: 'Accepted', file: 'a.js', severity: 'low', state: 'accepted', disposition: 'drop_unless_cited', settled_by: 'agent:code-reviewer' },
    { title: 'Root', file: 'b.js', line: 4, severity: 'medium', state: 'accepted', already_ruled: 'Root', carried: true, settled_by: 'agent:code-reviewer' },
    { title: 'Codex open', file: 'a.js', line: 2, severity: 'high' },
  ] };
  assert.deepEqual(offeredCarried(input), [{ title: 'Root', file: 'b.js', line: 4, severity: 'medium', already_ruled: 'Root', from: 'prior', settled_severity: 'medium', settled_by: 'agent:code-reviewer' }]);
  assert.deepEqual(offeredCarried({}), []);
});

test('ruledLines: the waived count and titles per pass, one line each, opening no HTML comment', () => {
  const state = { passes: {
    'engine:codex-local': { head: 'abcdef1234', ruled: [{ title: 'Retry <!-- x', file: 'a.js', line: 1, severity: 'low', already_ruled: 'The retry loop has no cap', from: 'residual' }] },
    'agent:code-reviewer': { head: 'abcdef1234', list: [] },
  } };
  assert.deepEqual(ruledLines(state), ['', RULED_HEADING, '- engine:codex-local on `abcdef1`: 1 waived as already ruled, never counted open: `Retry &lt;!-- x` (`a.js`, repeats `The retry loop has no cap`, settled by an accepted residual)']);
  const byPass = { passes: { p: { head: 'h', ruled: [
    { title: 'Ping @team', file: '@scope/a.js', line: 1, severity: 'low', already_ruled: 'Ask @org/owners', from: 'prior', settled_by: 'agent:code-reviewer' },
    { title: 'Old record', file: 'a.js', line: 2, severity: 'low', already_ruled: 'R', from: 'prior' },
  ] } } };
  const line = ruledLines(byPass)[2];
  assert.equal(line, '- p on `h`: 2 waived as already ruled, never counted open: `Ping @\u200dteam` (`@\u200dscope/a.js`, repeats `Ask @\u200dorg/owners`, settled by `agent:code-reviewer`); `Old record` (`a.js`, repeats `R`, settled by a prior finding)');
  assert.doesNotMatch(line, /@[A-Za-z]/u, 'no title, file, or name mentions anyone');
  assert.deepEqual(ruledLines({ passes: {} }), []);
  const many = { passes: { p: { head: 'h', ruled: Array.from({ length: 12 }, (_, i) => ({ title: `t${i}`, file: 'a.js', already_ruled: 'R' })) } } };
  assert.match(ruledLines(many)[2], /^- p on `h`: 12 waived as already ruled, never counted open: .*`t9` \(`a\.js`, repeats `R`, settled by a prior finding\); and 2 more$/u);
  assert.ok(summaryBody({ ...emptyState(7, 'o/r'), ...state }, null, 'fix_required').includes(RULED_HEADING), 'the summary comment shows them');
});

test('ruledLines: reviewer text renders as code, never as a link, an image, an autolink, or emphasis', () => {
  const state = { passes: { p: { head: 'h', ruled: [{
    title: 'See [the fix](https://evil.example/x) and *this*', file: '![pixel](https://evil.example/p.png)', line: 1, severity: 'low',
    already_ruled: 'Read https://evil.example/y `now`', from: 'prior', settled_by: '<https://evil.example/z>',
  }] } } };
  const line = ruledLines(state)[2];
  assert.equal(line, "- p on `h`: 1 waived as already ruled, never counted open: `See [the fix](https://evil.example/x) and *this*` (`![pixel](https://evil.example/p.png)`, repeats `Read https://evil.example/y 'now'`, settled by `<https://evil.example/z>`)");
  // Outside the code spans, nothing reviewer-supplied is left.
  assert.doesNotMatch(line.replace(/`[^`]*`/gu, ''), /evil|\[|\]|\*|<|>/u);
});

// A repository whose feat branch changes one file, reviewed by codex-local at depth single, with GitHub faked in memory.
function repo(t, firstBody, github = {}) {
  let prBody = firstBody;
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-settled-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  write('.aidrian/config.json', JSON.stringify({ version: 1, github, review: { rules: [{ when: { lines: { over: 0 } }, depth: 'single' }] } }));
  write('src/a.js', '0\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('switch', '-q', '-c', 'feat');
  write('src/a.js', '1\n2\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'change');
  const comments = [];
  const forge = {
    change: () => ({ number: 7, headRefOid: git('rev-parse', 'HEAD'), baseRefName: 'main', body: prBody }),
    repo: () => 'o/r',
    conversationComments: () => comments,
    postComment: (_repo, _n, text) => comments.push({ id: comments.length + 1, body: text, author_association: 'MEMBER' }),
    editComment: (_repo, id, text) => (comments.find((comment) => comment.id === id).body = text),
  };
  const project = projectAt(dir);
  const step = (exec) => reviewStep({ pr: '7' }, { project, config: loadConfig(project).config, forge, exec, codex: () => ({ ok: true }) });
  // A new head on feat: the file changes again.
  const push = (text) => {
    write('src/a.js', text);
    git('add', '-A');
    git('commit', '-q', '-m', text.trim());
  };
  return { dir, project, comments, step, push, setBody: (text) => (prBody = text) };
}

test('the review step: codex-local reads the body\'s residuals, its waived repeat stays on the record as ruled, out of open, and shows in the summary comment', async (t) => {
  const r = repo(t, body(['The retry loop has no cap']));
  const script = path.join(r.dir, '..', `${path.basename(r.dir)}-reviewer.mjs`);
  t.after(() => rmSync(script, { force: true }));
  const printed = [
    { file: 'src/a.js', line: 1, title: 'Retry loop unbounded', body: 'b', severity: 'low', already_ruled: 'The retry loop has no cap' },
    { file: 'src/a.js', line: 2, title: 'Retry loop unbounded, worse', body: 'b', severity: 'medium', already_ruled: 'The retry loop has no cap' },
  ];
  writeFileSync(script, `process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({findings:${JSON.stringify(printed)},verdicts:[],contracts:[],cross_notes:[]})))`);
  const inputs = [];
  // The real runExec, with codex-local's Codex run swapped for the script.
  const exec = (reviewer, input, opts) => {
    inputs.push(input);
    return runExec({ ...reviewer, builtIn: undefined, command: [process.execPath, script], timeoutSec: 10 }, input, opts);
  };
  const result = await r.step(exec);
  assert.equal(result.status, 'fix_required', 'the medium repeat of a residual stays a new, blocking finding');
  assert.deepEqual(inputs[0].acceptedResiduals, ['The retry loop has no cap']);
  const record = readLocalState(r.project, 7).passes['engine:codex-local'];
  assert.deepEqual([record.findings, record.open], [2, 1], 'the waived repeat counts among the findings, never as open');
  assert.deepEqual(record.list.map((each) => each.title), ['Retry loop unbounded, worse']);
  assert.deepEqual(record.ruled, [{ title: 'Retry loop unbounded', file: 'src/a.js', line: 1, severity: 'low', already_ruled: 'The retry loop has no cap', from: 'residual' }]);
  assert.ok(record.dropped.some((note) => /Retry loop unbounded, worse" names an accepted residual, which settles only a low finding/u.test(note)));
  const summary = r.comments.at(-1).body;
  assert.ok(summary.includes(RULED_HEADING) && summary.includes('1 waived as already ruled') && summary.includes('`Retry loop unbounded` (`src/a.js`'), 'the summary comment names the waived count and title');
});

test('the review step: a carried ruling outlives a head where codex-local does not repeat it', async (t) => {
  const r = repo(t, body([]), { maxReviewRounds: 5 });
  const script = path.join(r.dir, '..', `${path.basename(r.dir)}-reviewer.mjs`);
  const answers = `${script}.json`;
  t.after(() => rmSync(script, { force: true }));
  t.after(() => rmSync(answers, { force: true }));
  writeFileSync(script, `import fs from 'node:fs';process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({findings:JSON.parse(fs.readFileSync(${JSON.stringify(answers)},'utf8')),verdicts:[],contracts:[],cross_notes:[]})))`);
  const exec = (reviewer, input, opts) => runExec({ ...reviewer, builtIn: undefined, command: [process.execPath, script], timeoutSec: 10 }, input, opts);
  const repeat = [{ file: 'src/a.js', line: 1, title: 'Same cause, new words', body: 'b', severity: 'low', already_ruled: 'Accepted' }];
  const edit = (change) => {
    const state = readLocalState(r.project, 7);
    change(state);
    writeLocalState(r.project, state);
  };
  // h1: a code-reviewer pass accepted the finding; codex-local repeats it.
  const seeded = emptyState(7, 'o/r');
  seeded.passes['agent:code-reviewer'] = { head: 'h0', reviewer: 'code-reviewer', files: null, findings: 1, open: 0, list: [{ title: 'Accepted', file: 'src/a.js', severity: 'low', state: 'accepted', disposition: 'drop_unless_cited' }] };
  writeLocalState(r.project, seeded);
  writeFileSync(answers, JSON.stringify(repeat));
  await r.step(exec);
  assert.equal(readLocalState(r.project, 7).passes['engine:codex-local'].ruled.length, 1, 'h1: the repeat is waived');
  // h2: the source leaves the record, and codex-local does not repeat it.
  edit((state) => delete state.passes['agent:code-reviewer']);
  r.push('1\n2\n3\n');
  writeFileSync(answers, '[]');
  await r.step(exec);
  const h2 = readLocalState(r.project, 7).passes['engine:codex-local'];
  assert.ok(!('ruled' in h2), 'h2: nothing repeated');
  assert.deepEqual(h2.carried, [{ title: 'Accepted', file: 'src/a.js', line: 1, severity: 'low', already_ruled: 'Accepted', from: 'prior', settled_severity: 'low', settled_by: 'agent:code-reviewer' }], 'h2: the offered ruling stays on the record');
  // h3: codex-local repeats it again, and it is still waived.
  r.push('1\n2\n3\n4\n');
  writeFileSync(answers, JSON.stringify(repeat));
  const result = await r.step(exec);
  const h3 = readLocalState(r.project, 7).passes['engine:codex-local'];
  assert.deepEqual([h3.findings, h3.open], [1, 0], 'h3: the repeat is not re-raised');
  assert.deepEqual(h3.ruled.map((each) => [each.already_ruled, each.settled_by]), [['Accepted', 'agent:code-reviewer']]);
  assert.notEqual(result.status, 'fix_required');
});

const RAISED = 'The retry loop has no cap';
// A residual line as the pull request body template writes it: `<defect>: <why>; the code comment that marks it`.
const RESIDUAL = `${RAISED}: every caller already times out first; the comment at src/a.js marks it`;
const codexFinding = (over) => ({ file: 'a.js', line: 2, title: RAISED, body: 'b', severity: 'medium', ...over });
const repeatOf = (over) => ({ file: 'a.js', line: 3, title: 'Retry loop unbounded', body: 'b', severity: 'medium', already_ruled: RAISED, ...over });
// The settled list of the next head, with codex-local's record holding `list` and the code-reviewer's holding `others`.
const settledOn = ({ list = [codexFinding()], carried, others = [], residuals = [RESIDUAL] } = {}) => {
  const state = { passes: {
    'engine:codex-local': { head: 'h1', list, ...(carried ? { carried } : {}) },
    'agent:code-reviewer': { head: 'h1', list: others },
  } };
  return settledEntries({ priorFindings: recordSettled(state, state.passes['engine:codex-local'], residuals), acceptedResiduals: residuals });
};

test('namedBy: a residual names a finding only by its exact title, alone or before a colon, the longest title winning', () => {
  const title = (each) => ({ title: each });
  assert.deepEqual(namedBy(RESIDUAL, [title(RAISED)]), [title(RAISED)], 'the line the body template writes');
  assert.deepEqual(namedBy(RAISED, [title(RAISED)]), [title(RAISED)], 'the title alone');
  for (const near of [
    `${RAISED.toLowerCase()}: why`, `**${RAISED}**: why`, `\`${RAISED}\`: why`, `${RAISED}. Why`, `${RAISED} - why`, `${RAISED} really: why`, `Why: ${RAISED}`, `${RAISED}, and another: why`,
  ]) assert.deepEqual(namedBy(near, [title(RAISED)]), [], `a near copy names nothing: ${near}`);
  assert.deepEqual(namedBy('A: b: why', [title('A'), title('A: b')]), [title('A: b')], 'a title that opens another does not name its finding');
  const twoFiles = [{ title: RAISED, file: 'a.js' }, { title: RAISED, file: 'b.js' }];
  assert.deepEqual(namedBy(RESIDUAL, twoFiles), twoFiles, 'one title in two files: both named, each settling its own file');
  assert.deepEqual(namedBy(`${RAISED}; Other title: why`, [title(RAISED), title('Other title')]), [], 'one line opening with two titles names neither: the body takes one line each');
});

test('residualTexts: a residual whose why runs onto continuation lines still names the finding by its opening words', () => {
  const [text] = residualTexts(`## Accepted residuals\n\n- ${RAISED}: every caller\n  already times out first\n\n## Tests\n`);
  assert.equal(text, `${RAISED}: every caller already times out first`);
  const settled = settledOn({ residuals: [text] });
  assert.deepEqual(splitRuled([repeatOf()], settled).findings, []);
});

test('an anchored residual settles a repeat up to the raised finding\'s severity, by the title or by the residual\'s text', () => {
  const settled = settledOn();
  assert.deepEqual(settled, [
    { title: RAISED, file: 'a.js', severity: 'medium', residual: RESIDUAL },
    { title: RESIDUAL, file: 'a.js', severity: 'medium', residual: RESIDUAL, raised: RAISED },
  ], 'codex-local\'s own state-less entry is the anchor, under both names');
  const ruled = { title: 'Retry loop unbounded', file: 'a.js', line: 3, severity: 'medium', already_ruled: RAISED, from: 'residual', settled_severity: 'medium', residual: RESIDUAL };
  assert.deepEqual(splitRuled([repeatOf()], settled), { findings: [], ruled: [ruled], notes: [] });
  assert.deepEqual(splitRuled([repeatOf({ already_ruled: RESIDUAL })], settled), { findings: [], ruled: [ruled], notes: [] }, 'either name records the raised title');
  assert.deepEqual(settledOn({ residuals: [RAISED] }), [{ title: RAISED, file: 'a.js', severity: 'medium', residual: RAISED }], 'a bare title is one entry');
});

test('a residual naming no raised finding waives nothing above low', () => {
  const unnamed = 'A defect only the body mentions: why';
  for (const [label, record] of [
    ['nothing raised', { list: [] }],
    ['another finding raised', { list: [codexFinding({ title: 'Something else' })] }],
    ['no file', { list: [{ title: 'A defect only the body mentions', severity: 'medium' }] }],
  ]) {
    const settled = settledOn({ ...record, residuals: [unnamed] });
    assert.deepEqual(settled, [{ title: unnamed }], `${label}: the bare residual`);
    const medium = splitRuled([repeatOf({ already_ruled: unnamed })], settled);
    assert.deepEqual(medium.ruled, [], `${label}: a medium repeat stays new`);
    assert.match(medium.notes[0], /names an accepted residual, which settles only a low finding/u);
    assert.equal(splitRuled([repeatOf({ already_ruled: 'A defect only the body mentions' })], settled).ruled.length, 0, `${label}: its bare title names nothing`);
    assert.equal(splitRuled([repeatOf({ already_ruled: unnamed, severity: 'low' })], settled).ruled.length, 1, `${label}: a low repeat is still waived`);
  }
});

test('a low ruling on an unanchored residual never becomes an anchor on a later head', () => {
  const unnamed = 'A defect only the body mentions: why';
  const low = { title: 'A defect only the body mentions', file: 'a.js', line: 1, severity: 'low', already_ruled: unnamed, from: 'residual' };
  const state = { passes: { 'engine:codex-local': { head: 'h2', list: [], ruled: [low], carried: [{ ...low, settled_severity: 'low' }] } } };
  const settled = settledEntries({ priorFindings: recordSettled(state, state.passes['engine:codex-local'], [unnamed]), acceptedResiduals: [unnamed] });
  assert.deepEqual(settled, [{ title: unnamed }], 'only a kept anchor with its `residual` counts as raised');
});

test('an anchored residual never settles a repeat in another file, one more severe than the raised finding, or one above medium', () => {
  const settled = settledOn();
  for (const [label, repeat, note] of [
    ['another file, by title', repeatOf({ file: 'b.js' }), /in another file/u],
    ['another file, by title, low', repeatOf({ file: 'b.js', severity: 'low' }), /in another file/u],
    ['another file, by the residual\'s text, low', repeatOf({ file: 'b.js', severity: 'low', already_ruled: RESIDUAL }), /in another file/u],
    ['more severe', repeatOf({ severity: 'high' }), /less severe than it/u],
  ]) {
    const split = splitRuled([repeat], settled);
    assert.deepEqual(split.ruled, [], `${label}: nothing is waived`);
    assert.match(split.notes[0], note, label);
  }
  const low = settledOn({ list: [codexFinding({ severity: 'low' })] });
  assert.deepEqual(splitRuled([repeatOf()], low).ruled, [], 'a medium repeat of a raised low finding is new');
  assert.equal(splitRuled([repeatOf({ severity: 'low' })], low).ruled.length, 1);
  for (const severity of ['high', 'critical']) {
    const raisedHigh = settledOn({ list: [codexFinding({ severity })] });
    assert.deepEqual(splitRuled([repeatOf({ severity })], raisedHigh).ruled, [], `${severity}: a repeat that severe is weighed again, the raised finding as severe as it`);
    assert.match(splitRuled([repeatOf({ severity })], raisedHigh).notes[0], /of medium severity at most/u);
    assert.equal(splitRuled([repeatOf()], raisedHigh).ruled.length, 1, `${severity}: a medium repeat under it is waived`);
  }
});

test('a fix or a blocking listing ends the anchor, on the raised list and on the kept one; the state-less entry never does', () => {
  const kept = [{ title: RAISED, file: 'a.js', line: 2, severity: 'medium', already_ruled: RAISED, from: 'residual', settled_severity: 'medium', residual: RESIDUAL }];
  for (const [label, other] of [
    ['fixed', { title: RAISED, file: 'a.js', state: 'fixed' }],
    ['open and blocking', { title: RAISED, file: 'a.js', severity: 'medium', state: 'open', disposition: 'accepted_residual' }],
    ['open with no disposition', { title: RAISED, file: 'a.js', severity: 'medium', state: 'open' }],
    ['accepted but fix_now', { title: RAISED, file: 'a.js', severity: 'critical', state: 'accepted', disposition: 'fix_now' }],
  ]) {
    for (const [phase, record] of [['raised', { list: [codexFinding()] }], ['kept', { list: [], carried: kept }]]) {
      const settled = settledOn({ ...record, others: [other] });
      assert.deepEqual(settled, [{ title: RESIDUAL }], `${label}, ${phase}: only the bare residual is left`);
      const split = splitRuled([repeatOf()], settled);
      assert.deepEqual(split.findings.map((each) => each.title), ['Retry loop unbounded'], `${label}, ${phase}: the repeat is new`);
      assert.deepEqual(split.ruled, []);
    }
  }
  const elsewhere = settledOn({ others: [{ title: RAISED, file: 'b.js', state: 'fixed' }] });
  assert.equal(splitRuled([repeatOf()], elsewhere).ruled.length, 1, 'the same title in another file leaves it standing');
  const asIs = settledOn({ list: [], carried: kept, others: [{ title: RAISED, file: 'a.js', severity: 'low', state: 'open', disposition: 'acceptable_as_is' }] });
  assert.deepEqual(asIs.map((each) => each.severity), ['low', 'low'], 'a listing that does not block governs at its own severity, over the kept anchor');
  assert.equal(splitRuled([repeatOf()], settledOn({ list: [], carried: kept })).ruled.length, 1, 'with no listing, the kept anchor holds');
});

test('the summary names the residual that settled a waiver, and the prompt states the rule with its texts only in the JSON input', () => {
  const state = { passes: { 'engine:codex-local': { head: 'abcdef1234', ruled: [
    { title: 'Retry loop unbounded', file: 'a.js', line: 3, severity: 'medium', already_ruled: RAISED, from: 'residual', settled_severity: 'medium', residual: RESIDUAL },
    { title: 'Bare', file: 'a.js', line: 4, severity: 'low', already_ruled: 'Bare text', from: 'residual' },
  ] } } };
  const line = ruledLines(state)[2];
  assert.ok(line.includes(`repeats \`${RAISED}\`, settled by the accepted residual \`${RESIDUAL.slice(0, 80)}\``), line);
  assert.ok(line.includes('repeats `Bare text`, settled by an accepted residual'), 'a residual naming nothing keeps its line');
  const mention = ruledLines({ passes: { p: { head: 'h', ruled: [{ title: 't', file: 'a.js', already_ruled: 'x', from: 'residual', residual: 'See [it](https://evil.example) @team' }] } } })[2];
  assert.ok(mention.includes('`See [it](https://evil.example) @‍team`'), 'the residual renders as code, mentioning nobody');

  const input = { base: 'b1', head: 'h1', flows: [], files: ['a.js'], priorFindings: recordSettled({ passes: { p: { list: [codexFinding()] } } }, null, [RESIDUAL]), acceptedResiduals: [RESIDUAL] };
  const [brief, json] = reviewPrompt(input).split('Input (JSON):');
  assert.match(brief, /A `priorFindings` entry with a `residual` field is a finding a reviewer raised on this pull request, named by that residual: the prior finding's rule applies to it and to that residual's text, in the entry's `file` only, and that residual settles nothing else\./u);
  assert.match(brief, /Any other residual names no raised finding, and keeps the residual's rule\./u);
  assert.ok(!brief.includes(RAISED) && !brief.includes(RESIDUAL), 'no finding or residual text in the instructions');
  assert.ok(json.includes(RESIDUAL) && json.includes(RAISED));
  assert.equal(settledBrief(settledEntries(input)), brief.split('\n').find((each) => each.startsWith('Settled findings:')));
});

test('passInput: an exec pass reads the anchored entry only while the body names the raised finding; an agent pass never does', () => {
  const state = { ...emptyState(7, 'o/r'), passes: { 'engine:codex-local': { head: 'h1', files: null, list: [codexFinding()] } } };
  const map = { 'codex-local': { kind: 'exec' }, 'code-reviewer': { kind: 'agent' } };
  const pass = { id: 'engine:codex-local', reviewer: 'codex-local', files: null };
  const stage = { name: 'independent', passes: [pass] };
  const anchoredOf = (input) => input.priorFindings.filter((each) => each.residual);
  assert.deepEqual(anchoredOf(passInput(context({ state, map, info: { body: body([RESIDUAL]) } }), pass, stage)).map((each) => [each.title, each.file, each.severity, each.residual]), [[RAISED, 'a.js', 'medium', RESIDUAL]]);
  assert.deepEqual(anchoredOf(passInput(context({ state, map, info: { body: body(['Another residual: why']) } }), pass, stage)), []);
  assert.deepEqual(anchoredOf(passInput(context({ state, map, info: { body: body([RESIDUAL]) } }), { id: 'agent:code-reviewer', reviewer: 'code-reviewer', kind: 'agent', files: null }, { name: 'local', passes: [] })), []);
});

// A review step of `r` with codex-local swapped for a script that prints the findings `answer` writes, its inputs kept.
function scripted(t, r) {
  const script = path.join(r.dir, '..', `${path.basename(r.dir)}-reviewer.mjs`);
  const answers = `${script}.json`;
  t.after(() => rmSync(script, { force: true }));
  t.after(() => rmSync(answers, { force: true }));
  writeFileSync(script, `import fs from 'node:fs';process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({findings:JSON.parse(fs.readFileSync(${JSON.stringify(answers)},'utf8')),verdicts:[],contracts:[],cross_notes:[]})))`);
  const inputs = [];
  const exec = (reviewer, input, opts) => {
    inputs.push(input);
    return runExec({ ...reviewer, builtIn: undefined, command: [process.execPath, script], timeoutSec: 10 }, input, opts);
  };
  const run = async (findings, text) => {
    if (text) r.push(text);
    writeFileSync(answers, JSON.stringify(findings));
    const result = await r.step(exec);
    return { result, record: readLocalState(r.project, 7).passes['engine:codex-local'] };
  };
  return { run, inputs };
}

const FILE_REPEAT = { file: 'src/a.js', line: 1, title: 'Retry loop unbounded', body: 'b', severity: 'medium', already_ruled: RAISED };
const FILE_RAISED = { file: 'src/a.js', line: 2, title: RAISED, body: 'b', severity: 'medium', already_ruled: '' };

test('the review step: a medium codex-local finding the body lists as an accepted residual stays waived on heads 2, 3, and 4, across one with no repeat', async (t) => {
  const r = repo(t, body([]), { maxReviewRounds: 6 });
  const { run, inputs } = scripted(t, r);
  const h1 = await run([FILE_RAISED]);
  assert.equal(h1.result.status, 'fix_required', 'head 1: the finding blocks');
  assert.deepEqual(h1.record.list.map((each) => [each.title, each.state]), [[RAISED, undefined]], 'head 1: it sits on the record with no state');
  assert.ok(!('carried' in h1.record), 'head 1: no residual yet, so no anchor');

  r.setBody(body([RESIDUAL]));
  const h2 = await run([FILE_REPEAT], '1\n2\n3\n');
  assert.notEqual(h2.result.status, 'fix_required', 'head 2: the repeat does not block');
  assert.deepEqual([h2.record.findings, h2.record.open, h2.record.list], [1, 0, []], 'head 2: the repeat is not open, and leaves the list');
  assert.deepEqual(h2.record.ruled, [{ title: 'Retry loop unbounded', file: 'src/a.js', line: 1, severity: 'medium', already_ruled: RAISED, from: 'residual', settled_severity: 'medium', residual: RESIDUAL }]);
  const summary = r.comments.at(-1).body;
  assert.ok(summary.includes(`settled by the accepted residual \`${RESIDUAL.slice(0, 80)}\``), 'head 2: the summary comment names the residual');

  const h3 = await run([], '1\n2\n3\n4\n');
  assert.ok(!('ruled' in h3.record), 'head 3: Codex does not repeat it');
  assert.deepEqual(h3.record.carried.map((each) => [each.already_ruled, each.from, each.settled_severity, each.residual]), [[RAISED, 'residual', 'medium', RESIDUAL]], 'head 3: the anchor stays on the record');
  assert.notEqual(h3.result.status, 'fix_required');

  const h4 = await run([{ ...FILE_REPEAT, already_ruled: RESIDUAL }], '1\n2\n3\n4\n5\n');
  assert.notEqual(h4.result.status, 'fix_required', 'head 4: the repeat is still waived, named by the residual\'s text this time');
  assert.deepEqual([h4.record.open, h4.record.ruled.map((each) => [each.already_ruled, each.residual])], [0, [[RAISED, RESIDUAL]]]);
  assert.ok(inputs.at(-1).priorFindings.some((each) => each.title === RAISED && each.residual === RESIDUAL), 'head 4: the input still offers it, with nothing on any list');
});

test('the review step: removing the residual from the body ends the waiver on the next head', async (t) => {
  const r = repo(t, body([]), { maxReviewRounds: 6 });
  const { run } = scripted(t, r);
  await run([FILE_RAISED]);
  r.setBody(body([RESIDUAL]));
  assert.equal((await run([FILE_REPEAT], '1\n2\n3\n')).record.open, 0, 'waived while the body lists it');
  r.setBody(body([]));
  const h3 = await run([FILE_REPEAT], '1\n2\n3\n4\n');
  assert.equal(h3.result.status, 'fix_required', 'the repeat blocks again');
  assert.deepEqual([h3.record.open, h3.record.list.map((each) => each.title)], [1, ['Retry loop unbounded']], 'it comes back as new');
  assert.ok(!('carried' in h3.record), 'the anchor leaves the record');
  assert.match(h3.record.dropped.join('\n'), /names no settled finding/u);
});

test('the review step: an agent pass listing the finding as fixed ends the waiver on the next head', async (t) => {
  const r = repo(t, body([]), { maxReviewRounds: 6 });
  const { run } = scripted(t, r);
  await run([FILE_RAISED]);
  r.setBody(body([RESIDUAL]));
  assert.equal((await run([FILE_REPEAT], '1\n2\n3\n')).record.open, 0);
  const state = readLocalState(r.project, 7);
  state.passes['agent:code-reviewer'] = { head: 'h2', reviewer: 'code-reviewer', files: null, findings: 1, open: 0, list: [{ title: RAISED, file: 'src/a.js', state: 'fixed' }] };
  writeLocalState(r.project, state);
  const h3 = await run([FILE_REPEAT], '1\n2\n3\n4\n');
  assert.equal(h3.result.status, 'fix_required');
  assert.deepEqual([h3.record.open, h3.record.list.map((each) => each.title)], [1, ['Retry loop unbounded']], 'the repeat comes back as new');
});
