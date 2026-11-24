// The Human's answer at the round limit that leaves the ship decision to the session: `aidrian pr delegate`, the
// review-delegate rule that holds it to the transcript, and the merge guard that takes it while every open finding is low.
import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import codex from '../plugins/aidrian/lib/hosts/codex.mjs';
import { HOSTS, humanAnswer } from '../plugins/aidrian/lib/hosts/index.mjs';
import { commands } from '../plugins/aidrian/lib/pr.mjs';
import { projectAt } from '../plugins/aidrian/lib/project.mjs';
import { cappedOn, delegates, delegationFor, issueRef, lowOnly, parseDelegate, runDelegate } from '../plugins/aidrian/lib/review/delegation.mjs';
import { DELEGATION_HEADING, emptyState, readLocalState, stateFromComment, writeLocalState } from '../plugins/aidrian/lib/review/state.mjs';
import { check as mergeCheck, checkMcp } from '../plugins/aidrian/lib/rules/github/merge-review.mjs';
import { check as delegateCheck } from '../plugins/aidrian/lib/rules/review-delegate.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const HEAD = 'abcdef1234567890abcdef1234567890abcdef12';
const NEXT = '1234567890abcdef1234567890abcdef12345678';
const URL = 'https://github.com/Acme/Notes/pull/5';
const T0 = '2026-11-03T14:00:00.000Z';
const LATER = '2026-11-03T14:30:00.000Z';
const QUESTION = 'Review of pull request acme/notes#5 at abcdef1 stopped at its round limit, with 2 findings open. Ship, and file them as an issue?';
// The marks Claude Code 2.1.295 to 2.1.328 put on an AskUserQuestion answer the Human gave in the terminal.
const HUMAN = { isSidechain: false, entrypoint: 'cli', permissionDecision: { decision: 'accept', source: 'user_temporary', grantScope: 'once' } };
const OPTIONS = [{ label: 'Merge with the findings filed', description: 'd' }, { label: 'Grant more review rounds', description: 'd' }];
// One AskUserQuestion result entry as the host writes it: the question with its options, the answer, and the marks.
// `over` replaces top-level fields (the marks), and `options` the question's options.
const answerEntry = (question, label, timestamp = LATER, { options = OPTIONS, ...over } = {}) => ({
  type: 'user', timestamp, ...HUMAN, toolUseResult: { questions: [{ question, header: 'PR 5', options, multiSelect: false }], answers: { [question]: label }, annotations: {} }, ...over,
});
const finding = (id, severity, over = {}) => ({ id, title: `title ${id}`, file: 'src/a.js', line: 3, severity, pass: 'agent:code-reviewer', ...over });
const LOW = [finding('R2-1', 'low'), finding('R2-2', 'low')];

// A git repository of its own (never GIT_DIR, never a real repository) with an origin and one commit, holding a project
// whose state folder is beside it, and a transcript file. `config` adds to the config its one commit holds.
function repo(t, config = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-delegate-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'repo');
  mkdirSync(dir);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('remote', 'add', 'origin', 'git@github.com:Acme/Notes.git');
  // The name a recorded answer carries is this checkout's git user, never the developer's.
  git('config', 'user.name', 't');
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: '../state' }, ...config }));
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init');
  const transcript = path.join(dir, 'transcript.jsonl');
  writeFileSync(transcript, '');
  const project = () => projectAt(dir);
  const record = (pr, edit) => {
    const state = emptyState(pr, 'acme/notes');
    edit(state);
    writeLocalState(project(), state);
  };
  const answer = (...pairs) => writeFileSync(transcript, pairs.map((pair) => `${JSON.stringify(answerEntry(...pair))}\n`).join(''));
  const input = { transcript_path: transcript };
  const merge = (command, more = {}) => mergeCheck(command, { cwd: dir, env: {}, input: { ...input, ...more }, viewPr: () => ({ number: 5, headRefOid: HEAD, baseRefName: 'main', url: URL }) });
  const rule = (command, more = {}) => delegateCheck(command, { cwd: dir, input: { ...input, ...more } });
  return { dir, git, transcript, project, record, answer, merge, rule, input };
}

// The cause of a cap on `head` (run.mjs capCause) whose only stops are `findings`, as one stage's open findings.
function capOf(findings, head = HEAD, over = {}) {
  const items = findings.filter((each) => each?.id).map(({ id, severity, security }) => ({ id, severity, ...(security ? { security } : {}), pass: 'agent:code-reviewer', stage: 'local', reviewer: 'agent:code-reviewer' }));
  return { head, reviewed: head, items, counted: items.length, itemized: true, unrun: [], waiting: [], unsigned: [], flows: [], tests_removed: [], checks_failing: 0, bot: false, human: [], ...over };
}

// The review of HEAD stopped at its round limit, with `findings` the last round's itemized open findings.
const stopped = (findings = LOW, { status = 'round_limit', head = HEAD, open = findings.length } = {}) => (state) => {
  state.rounds.push({ head, at: T0, open, findings });
  state.outcome = { status, head, at: T0, cap: capOf(findings, head) };
};
const entry = (over = {}) => ({ head: HEAD, kind: 'round_cap', answer: 'delegate', issue: 'acme/notes#9', url: 'https://github.com/Acme/Notes/issues/9', by: 't', session: null, at: LATER, ...over });

// runDelegate as the CLI runs it, over a fake forge whose pull request is at `head` and whose `issues` map a
// `<repo>#<n>` to the issue the forge reads (a function throws), in the environment `env`.
// The record is posted unless the committed config's `review.record` is "local".
function delegate(t, r, args, { head = HEAD, issues = {}, comments = [], onIssue = null, env = {} } = {}) {
  const log = t.mock.method(console, 'log', () => {});
  const base = r.git('branch', '--show-current');
  const forge = {
    visibility: () => 'PRIVATE',
    pull: () => ({ author_association: 'MEMBER', base: { repo: { fork: false } } }),
    change: (ref, fields) => (fields === 'isCrossRepository' ? { isCrossRepository: false } : { number: Number(ref), headRefOid: head, baseRefName: base, url: URL }),
    issue: (name, n, opts) => {
      onIssue?.(opts);
      const found = issues[`${name}#${n}`];
      return typeof found === 'function' ? found() : found ?? null;
    },
    conversationComments: () => comments,
    postComment: (_repo, _n, body) => (comments.push({ id: comments.length + 1, user: { login: 'someone' }, author_association: 'MEMBER', body }), comments.at(-1)),
    editComment: (_repo, id, body) => (comments.find((comment) => comment.id === id).body = body),
    viewer: () => 'someone',
  };
  const project = r.project();
  return runDelegate(['5', ...args], project, loadConfig(project).config, { forge, repo: 'acme/notes', env })
    .finally(() => log.mock.restore())
    .then((code) => ({ code, out: JSON.parse(log.mock.calls.at(-1).arguments[0]), comments }));
}
// Filed after the review stopped (T0), to the second, as GitHub writes the time.
const FILED = '2026-11-03T14:20:00Z';
const OPEN_ISSUE = { 'acme/notes#9': { number: 9, state: 'open', title: 'Follow-up of the review', body: 'What the review of #5 left open: R2-1 and R2-2.', url: 'https://github.com/Acme/Notes/issues/9', change: false, created: FILED } };

// Answers that set a condition, lean to an option, or say more than that the session decides.
const CONDITIONAL = [
  'up to you if CI is green', 'your call, fix the typo first', 'you decide once the tests pass', 'whatever you think, only after the bot answers',
  'you decide, as long as the issue is filed', 'up to you, I would rather grant more rounds', 'your call, though I lean towards more rounds',
  'your call. Grant more review rounds', 'you decide if the tests pass', 'you decide after one more round', 'stop. up to you',
  'Grant more review rounds, your call how many', '"Up to you"', '“your call”',
];

test('delegates: the whole answer is one of the fixed phrases; a hedge, a condition, a question, or an option never is', () => {
  for (const text of ['whatever you recommend best', 'whatever your recommend best', 'Whatever you think is best', 'you decide', 'up to you', 'your call', 'go with your recommendation',
    'I trust your judgment', 'decide for me', 'do what you think is best', 'Your call’s fine', 'Up to you.', '  your call!  ', 'ok, you decide', 'it\'s your call', 'as you see fit']) {
    assert.equal(delegates(text), true, text);
  }
  for (const text of ['Merge with the findings filed', 'Grant more review rounds', 'Merge anyway', 'what do you recommend?', 'what do you recommend', 'don\'t merge, whatever you think',
    'don’t merge, whatever you think', 'your call, but fix the typo first', 'ok', 'ship it', '', '   ', `you decide ${'x'.repeat(10)}`, null, 5, ...CONDITIONAL]) {
    assert.equal(delegates(text), false, String(text));
  }
});

test('lowOnly: only a last round on the head that lists every open finding, each low and none marked security', () => {
  const state = (rounds) => ({ ...emptyState(5, 'acme/notes'), rounds, outcome: { status: 'round_limit', head: HEAD, at: T0, cap: capOf(rounds.at(-1)?.findings ?? []) } });
  const round = (findings, over = {}) => ({ head: HEAD, at: T0, open: findings.length, findings, ...over });
  assert.deepEqual(lowOnly(state([round(LOW)]), HEAD), { ok: true, count: 2, ids: ['R2-1', 'R2-2'] });
  assert.deepEqual(lowOnly(state([round([finding('R2-1', 'medium')]), round(LOW)]), HEAD.slice(0, 7)), { ok: true, count: 2, ids: ['R2-1', 'R2-2'] }, 'the last round, by a short head');
  for (const [name, rounds, why] of [
    ['no round', [], /last round is not for head abcdef1/u],
    ['another head', [round(LOW, { head: NEXT })], /last round is not for head abcdef1/u],
    ['no count', [round(LOW, { open: undefined })], /does not list every open finding of head abcdef1/u],
    ['counts only', [round(LOW, { findings: null })], /does not list every open finding/u],
    ['a list cut short', [round(LOW, { open: 51 })], /does not list every open finding/u],
    ['nothing open', [round([], { open: 0 })], /does not list every open finding/u],
    ['a medium', [round([...LOW, finding('R2-3', 'medium')])], /^finding R2-3 is medium$/u],
    ['a high with no id', [round([finding(undefined, 'high')])], /^a finding with no id is high$/u],
    ['an unknown severity', [round([finding('R2-3', 'urgent')])], /^finding R2-3 has no severity on record$/u],
    ['a low marked security', [round([finding('R2-3', 'low', { security: true })])], /^finding R2-3 is marked security$/u],
    ['a violated flow invariant', [round([...LOW, { title: 'flow booking: invariant no-double violated', file: null, line: null, severity: null }])], /^a finding with no id has no severity on record$/u],
  ]) {
    const result = lowOnly(state(rounds), HEAD);
    assert.equal(result.ok, false, name);
    assert.match(result.why, why, name);
    assert.doesNotMatch(result.why, /title/u, `${name}: never a title`);
  }
});

test('delegationFor and cappedOn: the last entry for the head, at or after the outcome; a capped outcome on the head, nothing owed', () => {
  const state = { ...emptyState(5, 'acme/notes'), outcome: { status: 'round_limit', head: HEAD, at: T0 } };
  assert.equal(delegationFor(state, HEAD), null, 'none recorded');
  state.delegations = [entry({ at: '2026-11-03T13:00:00.000Z' })];
  assert.equal(delegationFor(state, HEAD), null, 'older than the outcome');
  state.delegations = [entry({ head: NEXT })];
  assert.equal(delegationFor(state, HEAD), null, 'another head');
  state.delegations = [entry({ kind: 'other' }), entry({ answer: 'other' })];
  assert.equal(delegationFor(state, HEAD), null, 'another kind or answer');
  state.delegations = [entry(), entry({ issue: 'acme/notes#10', at: '2026-11-03T15:00:00.000Z' })];
  assert.equal(delegationFor(state, HEAD.slice(0, 7)).issue, 'acme/notes#10', 'the last one');
  assert.equal(delegationFor({ ...state, outcome: { ...state.outcome, at: 'never' } }, HEAD), null, 'an outcome time it cannot read');
  assert.equal(cappedOn(state, HEAD), true);
  assert.equal(cappedOn({ ...state, outcome: { ...state.outcome, status: 'extension_check' } }, HEAD), true);
  for (const status of ['extension_ask', 'received', 'running', 'fix_required']) assert.equal(cappedOn({ ...state, outcome: { ...state.outcome, status } }, HEAD), false, status);
  assert.equal(cappedOn(state, NEXT), false, 'another head');
  assert.equal(cappedOn({ ...state, pending: [{ kind: 'request', head: HEAD, at: T0, by: 'the Human' }] }, HEAD), false, 'a review owed');
});

test('parseDelegate and issueRef: the pull request, a required issue in three spellings, and every bad argument', async (t) => {
  assert.deepEqual(parseDelegate(['5', '--issue', '9']), { pr: 5, issue: { repo: null, number: 9 }, head: null, repo: null });
  assert.deepEqual(parseDelegate(['#5', '--issue', '#9', '--head', HEAD, '--repo', 'Acme/Notes']), { pr: 5, issue: { repo: null, number: 9 }, head: HEAD, repo: 'acme/notes' });
  assert.deepEqual(issueRef('Other/Repo#12'), { repo: 'other/repo', number: 12 });
  assert.deepEqual(issueRef('https://github.com/Other/Repo/issues/12'), { repo: 'other/repo', number: 12, host: 'github.com' });
  for (const bad of ['', 'nine', '0', 'o/r#', 'https://github.com/o/r/pull/12', 'http://github.com/o/r/issues/12', '12345678901', 'o/r#1 x']) {
    assert.throws(() => issueRef(bad), /--issue must be an issue number, <owner>\/<name>#<n>, or an issue URL/u, bad);
  }
  assert.throws(() => parseDelegate(['5']), /--issue is required/u);
  assert.throws(() => parseDelegate(['--issue', '9']), /delegate needs a pull request number/u);
  assert.throws(() => parseDelegate(['5', '--issue', '9', '--head', 'main']), /--head must be a commit SHA/u);
  assert.throws(() => parseDelegate(['5', '--issue', '9', '--force']), /unknown argument: --force/u);
  assert.throws(() => parseDelegate(['5', '--issue']), /--issue needs a value/u);
  const error = t.mock.method(console, 'error', () => {});
  assert.equal(await commands.pr.run(['delegate', '5']), 1);
  assert.match(error.mock.calls.at(-1).arguments[0], /^aidrian pr delegate: --issue is required/u);
  assert.match(commands.pr.usage, /delegate PR --issue N\|OWNER\/NAME#N\|URL \[--head SHA\] \[--repo OWNER\/NAME\]/u);
});

test('the rule lets the command run on the Human`s delegating answer to the guard`s question, and denies every other', (t) => {
  const r = repo(t);
  r.record(5, stopped());
  const call = `aidrian pr delegate 5 --issue 9 --head ${HEAD}`;
  r.answer([QUESTION, 'whatever you recommend best']);
  assert.equal(r.rule(call), null);
  assert.equal(r.rule(`node ${ROOT}/plugins/aidrian/lib/cli.mjs pr delegate 5 --issue 9`), null, 'as node running the cli');
  const denied = (why, name) => {
    const reason = r.rule(call) ?? '';
    assert.match(reason, /^Blocked: `aidrian pr delegate` records that the Human left the ship decision at the round limit to the session/u, name);
    assert.match(reason, /Or the Human runs the command in their own shell \(`!` in the prompt\)\.$/u, name);
    assert.match(reason, why, name);
    return reason;
  };
  writeFileSync(r.transcript, '');
  denied(/the transcript holds no AskUserQuestion answer/u, 'no answer');
  r.answer([QUESTION, 'whatever you recommend best', '2026-11-03T13:00:00.000Z']);
  denied(/no AskUserQuestion answer came at or after the review stopped/u, 'older than the outcome');
  const unasked = /no answer since is to the merge guard's round-limit question "Review of pull request acme\/notes#5 at abcdef1 stopped at its round limit, with 2 findings open\. Ship, and file them as an issue\?", with its two options/u;
  r.answer([QUESTION.replace('#5', '#55'), 'you decide']);
  denied(unasked, 'another pull request');
  r.answer([QUESTION.replace('abcdef1', '1234567'), 'you decide']);
  denied(unasked, 'another head');
  r.answer([QUESTION.replace('2 findings', '3 findings'), 'you decide']);
  denied(unasked, 'another count of findings');
  r.answer(['Which name should the new helper in #5 at abcdef1 take: parseRef or readRef?', 'your call']);
  denied(unasked, 'an unrelated question naming the pull request and the head');
  r.answer([QUESTION, 'Up to you', LATER, { options: [...OPTIONS, { label: 'Up to you', description: 'd' }] }]);
  denied(unasked, 'the question with an option the session added');
  r.answer([QUESTION, 'your call', LATER, { options: [OPTIONS[0]] }]);
  denied(unasked, 'the question with one option');
  r.answer([QUESTION, 'Merge with the findings filed']);
  denied(/the Human picked that option, and the merge guard takes it by itself: merge, with nothing to record/u, 'the ship option');
  r.answer([QUESTION, 'Merge anyway']);
  denied(/the merge guard takes it by itself/u, 'merge anyway');
  r.answer([QUESTION, 'Grant more review rounds']);
  denied(/the Human granted rounds: do not merge/u, 'the grant option');
  r.answer([QUESTION, 'Grant more review rounds, your call how many']);
  denied(/the Human granted rounds: do not merge/u, 'a grant that leaves the count to the session');
  r.answer([QUESTION, 'whatever you recommend best', LATER], [QUESTION, 'ship it', '2026-11-03T14:40:00.000Z']);
  const later = denied(/is not one this rule reads as leaving the decision to the session/u, 'a later answer that does not delegate');
  assert.doesNotMatch(later, /ship it/u, 'the deny never quotes the Human');
  for (const text of CONDITIONAL.filter((each) => !/^grant/iu.test(each))) {
    r.answer([QUESTION, text]);
    const reason = denied(/is not one this rule reads as leaving the decision to the session.*ask the Human what the answer means, in plain words, never the merge guard's question again/u, text);
    assert.doesNotMatch(reason, /ask the merge guard's question again/u, `${text}: never the question again for an answer the Human gave`);
  }
  // A later question to the Human that names the pull request and the head is not the guard's: the delegation stands.
  r.answer([QUESTION, 'up to you'], ['Merge #5 at abcdef1 now, or after lunch?', 'after lunch', '2026-11-03T14:40:00.000Z']);
  assert.equal(r.rule(call), null, 'an unrelated later answer');
  // The host's marks of the Human's own answer in the terminal: each one missing refuses.
  for (const [name, over] of [['a subagent`s', { isSidechain: true }], ['no sidechain mark', { isSidechain: undefined }], ['an SDK app`s', { entrypoint: 'sdk-ts' }],
    ['the desktop app`s', { entrypoint: 'claude-desktop' }], ['no permission decision', { permissionDecision: undefined }], ['a hook`s', { permissionDecision: { decision: 'accept', source: 'hook' } }]]) {
    r.answer([QUESTION, 'up to you', LATER, over]);
    denied(/the answer does not carry the host's marks of the Human's own answer in the terminal/u, name);
  }
  // The record: not capped on this machine.
  r.answer([QUESTION, 'whatever you recommend best']);
  for (const [name, edit] of [['received', (state) => (state.outcome = { status: 'received', head: HEAD, at: T0 })], ['owed', (state) => (stopped()(state), state.pending.push({ kind: 'request', head: HEAD, at: T0, by: 'the Human' }))]]) {
    r.record(5, edit);
    denied(/this machine's review record of #5 holds no review stopped at its round limit/u, name);
  }
  const none = r.rule('aidrian pr delegate 6 --issue 9') ?? '';
  assert.match(none, /record of #6 holds no review stopped/u, 'no record at all');
  assert.equal(none.split('runs the command in their own shell').length, 2, 'the deny says it once');
});

test('the rule refuses a subagent, whose answer the Human never gave', (t) => {
  const r = repo(t);
  r.record(5, stopped());
  r.answer([QUESTION, 'up to you']);
  assert.equal(r.rule('aidrian pr delegate 5 --issue 9'), null, 'the main session');
  assert.match(r.rule('aidrian pr delegate 5 --issue 9', { agent_id: 'a1b2' }) ?? '', /a subagent never records it: the Human answered the main session, and the main session runs it/u);
  assert.equal(r.rule('aidrian pr waive 5 --verdict refuse --reason x', { agent_id: 'a1b2' }), null, 'another command');
});

test('the rule refuses the command carried by a program that runs its words as a command', (t) => {
  const r = repo(t);
  r.record(5, stopped());
  writeFileSync(r.transcript, '');
  for (const command of [
    'echo 5 | xargs aidrian pr delegate --issue 9', 'find . -maxdepth 0 -exec aidrian pr delegate 5 --issue 9 \\;', 'watch -n 1 aidrian pr delegate 5 --issue 9',
    'script -q /dev/null aidrian pr delegate 5 --issue 9', 'npx aidrian pr delegate 5 --issue 9', 'bunx aidrian pr delegate 5 --issue 9', 'npm exec aidrian -- pr delegate 5 --issue 9',
    'node -e "require(\'child_process\').execSync(\'aidrian pr delegate 5 --issue 9\')"', '"$A" pr delegate 5 --issue 9', 'A=aidrian; $A pr delegate 5 --issue 9',
    '"$(which aidrian)" pr delegate 5 --issue 9', '$(which aidrian) pr delegate 5 --issue 9', '"`which aidrian`" pr delegate 5 --issue 9',
    'npm --yes exec aidrian -- pr delegate 5 --issue 9', 'npm --prefix . exec aidrian -- pr delegate 5 --issue 9', 'arch -arm64 aidrian pr delegate 5 --issue 9',
    'python3 -c "import os; os.system(\'aidrian pr delegate 5 --issue 9\')"', 'python -Bc "import os; os.system(\'aidrian pr delegate 5 --issue 9\')"',
    'perl -e "system(\'aidrian pr delegate 5 --issue 9\')"', 'ruby -e "system(\'aidrian pr delegate 5 --issue 9\')"',
    'deno eval "new Deno.Command(\'aidrian\', { args: \'pr delegate 5 --issue 9\'.split(\' \') }).outputSync()"',
    'echo delegate | xargs -I{} aidrian pr {} 5 --issue 9', 'echo delegate | xargs -I S aidrian pr S 5 --issue 9', 'echo delegate | xargs -i aidrian pr {} 5 --issue 9',
    'echo delegate | xargs --replace=SUB aidrian pr SUB 5 --issue 9', 'echo pr delegate 5 --issue 9 | xargs aidrian', 'echo delegate 5 --issue 9 | xargs aidrian pr',
    'echo pr | xargs -I P aidrian P delegate 5 --issue 9', 'find . -name delegate -exec aidrian pr {} 5 --issue 9 \\;',
    'node -pe "require(\'child_process\').execSync(\'aidrian pr delegate 5 --issue 9\')+\'\'"', 'node --eval="x(\'aidrian pr delegate 5 --issue 9\')"',
    'perl5.34 -e "system(\'aidrian pr delegate 5 --issue 9\')"', 'ruby3.3 -we "system(\'aidrian pr delegate 5 --issue 9\')"',
    'python3.12 -Ic "import os; os.system(\'aidrian pr delegate 5 --issue 9\')"',
    'npm -w a -w b exec aidrian -- pr delegate 5 --issue 9', 'npm --loglevel silent --yes exec aidrian -- pr delegate 5 --issue 9',
    'pnpm --filter x --silent exec aidrian pr delegate 5 --issue 9', 'yarn --cwd . --silent dlx aidrian pr delegate 5 --issue 9',
    'deno -q eval "x(\'aidrian pr delegate 5 --issue 9\')"',
  ]) {
    assert.match(r.rule(command) ?? '', /it runs through a program that runs its words as a command/u, command);
  }
  for (const command of ['case $x in *) aidrian pr delegate 5 --issue 9 ;; esac', 'builtin command aidrian pr delegate 5 --issue 9']) {
    assert.equal(r.rule(command), r.rule('aidrian pr delegate 5 --issue 9'), `${command}: judged as the call itself`);
  }
  assert.equal(r.rule('grep -r "pr delegate" docs'), null, 'a program that only searches the words');
  assert.equal(r.rule('npx prettier --check .'), null, 'a carrier that names no delegation');
  for (const command of ['echo 5 | xargs aidrian pr status', 'npx aidrian --version', 'find . -name aidrian', 'python3 -c "print(1)"', 'npm --yes install', 'arch -arm64 node -v']) {
    assert.equal(r.rule(command), null, `${command}: a carrier that runs no delegation`);
  }
});

test('the rule reads every call of a chain, in a shell string, and refuses one it cannot read', (t) => {
  const r = repo(t);
  r.record(5, stopped());
  r.answer([QUESTION, 'up to you']);
  assert.match(r.rule('echo "aidrian pr delegate 5 --issue 9" | bash') ?? '', /shell fed text the rule cannot read as commands/u);
  assert.equal(r.rule('sh -c "aidrian pr delegate 5 --issue 9"'), null, 'a shell string the walk reads is judged as run directly');
  assert.match(r.rule('aidrian pr delegate "$PR" --issue 9') ?? '', /its pull request must be a plain number/u);
  assert.match(r.rule('aidrian pr "$ACTION" 5 --issue 9') ?? '', /its subcommand is built by the shell at run time/u);
  const both = r.rule('aidrian pr delegate 5 --issue 9 && aidrian pr delegate 6 --issue 9') ?? '';
  assert.equal(both.split('\n').length, 1, 'only the call for #6 is denied');
  assert.match(both, /#6/u);
  assert.equal(r.rule('aidrian pr waive 5 --verdict refuse --reason x'), null, 'another command is not this rule`s');
  // Through the Bash hook, as the host runs it: blocked, exit 2.
  writeFileSync(r.transcript, '');
  const hook = spawnSync(process.execPath, [path.join(ROOT, 'plugins/aidrian/scripts/hook-bash.mjs')], {
    input: JSON.stringify({ tool_name: 'Bash', cwd: r.dir, transcript_path: r.transcript, tool_input: { command: 'aidrian pr delegate 5 --issue 9' } }),
    encoding: 'utf8',
    env: { ...process.env, AIDRIAN_TELEMETRY: '0' },
  });
  assert.equal(hook.status, 2, hook.stderr);
  assert.match(hook.stderr, /records that the Human left the ship decision/u);
});

test('aidrian pr delegate records the answer with the follow-up issue, and posts it when the record is not local', async (t) => {
  const r = repo(t, { review: { record: 'local' } });
  r.record(5, stopped());
  const { code, out, comments } = await delegate(t, r, ['--issue', '9', '--head', HEAD.slice(0, 7)], { issues: OPEN_ISSUE });
  assert.equal(code, 0);
  assert.deepEqual(out.delegation, { head: HEAD, kind: 'round_cap', answer: 'delegate', issue: 'acme/notes#9', url: 'https://github.com/Acme/Notes/issues/9' });
  assert.match(out.next, new RegExp(`gh pr merge 5 --repo acme/notes --match-head-commit ${HEAD}`, 'u'));
  const [saved] = readLocalState(r.project(), 5).delegations;
  assert.deepEqual({ ...saved, at: null }, { head: HEAD, kind: 'round_cap', answer: 'delegate', issue: 'acme/notes#9', url: 'https://github.com/Acme/Notes/issues/9', by: 't', session: null, at: null });
  assert.equal(comments.length, 0, 'a local record posts nothing');
  // The issue names the pull request by its URL, by <owner>/<name>#<PR>, or by #<PR>; it is in the pull request's own
  // repository however the reference spells it, and filed at or after the outcome, to the second.
  for (const [ref, issue] of [
    ['Acme/Notes#9', { body: `From ${URL}: R2-1, R2-2.` }],
    ['https://github.com/acme/notes/issues/9', { title: 'Acme/Notes#5 follow-up', body: '- R2-1\n- R2-2' }],
    ['9', { body: 'See #5 (R2-1, R2-2)' }],
    ['9', { body: 'See #5 for R2-1 and R2-2', created: '2026-11-03T14:00:00Z' }],
  ]) {
    const again = repo(t);
    again.record(5, stopped());
    const issues = { 'acme/notes#9': { number: 9, state: 'open', title: '', body: '', url: 'https://github.com/x/y/issues/9', change: false, created: FILED, ...issue } };
    assert.equal((await delegate(t, again, ['--issue', ref], { issues })).code, 0, ref);
  }
  const posted = repo(t);
  posted.record(5, stopped());
  const sent = await delegate(t, posted, ['--issue', '9'], { issues: OPEN_ISSUE });
  assert.equal(sent.comments.length, 1, 'posted the summary comment');
  assert.equal(stateFromComment(sent.comments[0].body, 5).delegations[0].issue, 'acme/notes#9');
  assert.ok(sent.comments[0].body.includes(`${DELEGATION_HEADING}\n- \`abcdef1\`: the Human left the ship decision to the session; findings filed as acme/notes#9 (https://github.com/Acme/Notes/issues/9) (an audit entry, not proof)`), sent.comments[0].body);
});

test('aidrian pr delegate refuses a follow-up issue it cannot hold to, a moved head, an owed review, and a record that changed; each writes nothing', async (t) => {
  const issue = (over) => ({ 'acme/notes#9': { ...OPEN_ISSUE['acme/notes#9'], ...over } });
  const cases = [
    ['a missing issue', {}, {}, /issue acme\/notes#9 does not exist/u],
    ['a closed issue', {}, { issues: issue({ state: 'closed' }) }, /issue acme\/notes#9 is closed: the follow-up issue stays open/u],
    ['a pull request given as the issue', {}, { issues: issue({ change: true }) }, /acme\/notes#9 is a pull request, not an issue/u],
    ['an issue that names no pull request', {}, { issues: issue({ body: 'about #55 and https://github.com/Acme/Notes/pull/55: R2-1, R2-2' }) }, /issue acme\/notes#9 does not name pull request acme\/notes#5: add it/u],
    ['an issue that names another repository`s #5', {}, { issues: issue({ body: 'about other/repo#5: R2-1, R2-2' }) }, /issue acme\/notes#9 does not name pull request acme\/notes#5: add it/u],
    ['an issue that names a path`s #5', {}, { issues: issue({ body: 'see docs/notes.md#5: R2-1, R2-2' }) }, /issue acme\/notes#9 does not name pull request acme\/notes#5/u],
    ['an issue that lists no finding', {}, { issues: issue({ body: 'What the review of #5 left open.' }) }, /issue acme\/notes#9 does not list findings R2-1, R2-2: list each open finding's id/u],
    ['an issue that lists one finding of two', {}, { issues: issue({ body: 'See #5: R2-10 and R2-2.' }) }, /issue acme\/notes#9 does not list finding R2-1: list each/u],
    ['an open finding with no id', { edit: stopped([finding('R2-1', 'low'), finding(undefined, 'low')]) }, { issues: OPEN_ISSUE }, /an open finding of the record has no id, so the follow-up issue cannot list it/u],
    ['an issue in another repository', { args: ['--issue', 'other/repo#9'] }, { issues: { 'other/repo#9': { ...OPEN_ISSUE['acme/notes#9'], body: `From ${URL}` } } }, /issue other\/repo#9 is not in the pull request's repository, acme\/notes: file the follow-up issue there/u],
    ['an issue URL on another forge host', { args: ['--issue', 'https://ghe.example.com/acme/notes/issues/9'] }, { issues: OPEN_ISSUE }, /issue acme\/notes#9 is on ghe\.example\.com, not on the pull request's host, github\.com: file the follow-up issue there/u],
    ['an issue filed before the review stopped', {}, { issues: issue({ created: '2026-11-03T13:59:59Z' }) }, /issue acme\/notes#9 was filed before the review stopped at 2026-11-03T14:00:00\.000Z: file a new follow-up issue for what this review left open/u],
    ['an issue whose filing time the forge does not give', {}, { issues: issue({ created: null }) }, /cannot read when issue acme\/notes#9 was filed/u],
    ['an issue the forge cannot read', {}, { issues: { 'acme/notes#9': () => { throw new Error('HTTP 502'); } } }, /could not read issue acme\/notes#9/u],
    ['a --head that is not the current head', { args: ['--issue', '9', '--head', NEXT] }, { issues: OPEN_ISSUE }, /the pull request's head is abcdef1, not 1234567: the answer binds to the current head/u],
    ['a head pushed after the review', {}, { head: NEXT, issues: OPEN_ISSUE }, /the last review step covered abcdef1, not head 1234567: an answer is recorded only for a review stopped at its round limit/u],
    ['an owed review', { edit: (state) => (stopped()(state), state.pending.push({ kind: 'request', head: HEAD, at: T0, by: 'the Human' })) }, { issues: OPEN_ISSUE }, /1 review entry is still owed on #5/u],
    ['a medium finding', { edit: stopped([...LOW, finding('R2-3', 'medium')]) }, { issues: OPEN_ISSUE }, /only while every open finding is low: finding R2-3 is medium\. Ask the Human the merge guard's question again/u],
  ];
  for (const [name, { args = ['--issue', '9'], edit = stopped() }, options, pattern] of cases) {
    const r = repo(t);
    r.record(5, edit);
    await assert.rejects(delegate(t, r, args, options), pattern, name);
    assert.equal(readLocalState(r.project(), 5).delegations, undefined, `${name}: nothing written`);
  }
  // A request recorded while the issue is read: the write would lose it, so nothing is written.
  const r = repo(t);
  r.record(5, stopped());
  const onIssue = () => {
    const state = readLocalState(r.project(), 5);
    state.pending.push({ id: 'late', kind: 'request', head: HEAD, at: T0, by: 'the Human' });
    writeLocalState(r.project(), state);
  };
  await assert.rejects(delegate(t, r, ['--issue', '9'], { issues: OPEN_ISSUE, onIssue }), /the review record of #5 changed while the answer was recorded: run again/u);
  assert.equal(readLocalState(r.project(), 5).delegations, undefined);
});

test('AC1: the Human leaves it to the session with only low findings open and an issue filed, and the merge runs with no second question', async (t) => {
  const r = repo(t);
  r.record(5, stopped());
  const merge = `gh pr merge 5 --match-head-commit ${HEAD}`;
  const deny = r.merge(merge) ?? '';
  assert.ok(deny.includes(`run \`aidrian pr delegate 5 --issue <issue> --head ${HEAD}\` as its own command, then merge with \`gh pr merge 5 --match-head-commit ${HEAD}\``), deny);
  // The grant's own route follows the grant's sentence; the delegation's route comes after it, so neither reads as the other's next step.
  const grant = 'When the Human picks "Grant more review rounds", do not merge. Run `aidrian pr extend 5 --human approve`';
  assert.ok(deny.includes(grant), deny);
  assert.ok(deny.indexOf(grant) < deny.indexOf('When the Human instead answers in their own words'), 'the delegation route after the grant`s');
  assert.ok(deny.indexOf(`then merge with \`gh pr merge 5 --match-head-commit ${HEAD}\``) > deny.indexOf('aidrian pr extend 5'), 'no extend step after the delegation`s merge');
  const question = /the question "([^"]+)"/u.exec(deny)[1];
  assert.equal(question, QUESTION);
  r.answer([question, 'whatever you recommend best']);
  const command = `aidrian pr delegate 5 --issue 9 --head ${HEAD}`;
  assert.equal(r.rule(command), null, 'the rule lets the command run');
  assert.equal((await delegate(t, r, ['--issue', '9', '--head', HEAD], { issues: OPEN_ISSUE })).code, 0);
  writeFileSync(r.transcript, '');
  assert.equal(r.merge(merge), null, 'the merge runs, the transcript emptied');
  assert.equal(checkMcp({ owner: 'acme', repo: 'notes', pullNumber: 5, sha: HEAD }, { cwd: r.dir, input: r.input, viewPr: () => null }), null, 'and through the merge tool with its sha');
  assert.match(r.merge('gh pr merge 5') ?? '', /The Human's recorded answer covers this head, but only for a merge that names it/u, 'a merge that names no head is refused');
});

test('AC2: with a medium finding open, a delegating answer does not unblock the merge, even with an entry written straight into the record', async (t) => {
  const r = repo(t);
  r.record(5, stopped([...LOW, finding('R2-3', 'medium')], { open: 3 }));
  const merge = `gh pr merge 5 --match-head-commit ${HEAD}`;
  const before = r.merge(merge) ?? '';
  assert.doesNotMatch(before, /aidrian pr delegate/u, 'no delegation route');
  const question = /the question "([^"]+)"/u.exec(before)[1];
  r.answer([question, 'whatever you recommend best']);
  assert.equal(r.rule(`aidrian pr delegate 5 --issue 9 --head ${HEAD}`), null, 'the rule reads only the answer; the command checks the findings');
  await assert.rejects(delegate(t, r, ['--issue', '9', '--head', HEAD], { issues: OPEN_ISSUE }), /only while every open finding is low: finding R2-3 is medium/u);
  assert.equal(readLocalState(r.project(), 5).delegations, undefined, 'nothing written');
  const state = readLocalState(r.project(), 5);
  state.delegations = [entry()];
  writeLocalState(r.project(), state);
  assert.equal(r.merge(merge), before, 'the deny is the capped one, word for word, with no delegation route');
  assert.ok(checkMcp({ owner: 'acme', repo: 'notes', pullNumber: 5, sha: HEAD }, { cwd: r.dir, input: r.input, viewPr: () => null }), 'and the merge tool is refused too');
});

test('the guard takes a recorded answer only in the session that recorded it, where both sessions are known', (t) => {
  const r = repo(t);
  r.record(5, (state) => (stopped()(state), (state.delegations = [entry({ session: 'main-1' })])));
  const merge = `gh pr merge 5 --match-head-commit ${HEAD}`;
  assert.equal(r.merge(merge, { session_id: 'main-1' }), null, 'the same session');
  assert.equal(r.merge(merge), null, 'a merge whose session the hook does not give');
  assert.match(r.merge(merge, { session_id: 'other-2' }) ?? '', /stopped at its round limit/u, 'another session');
  assert.ok(checkMcp({ owner: 'acme', repo: 'notes', pullNumber: 5, sha: HEAD }, { cwd: r.dir, input: { ...r.input, session_id: 'other-2' }, viewPr: () => null }), 'and through the merge tool');
  r.record(5, (state) => (stopped()(state), (state.delegations = [entry({ session: null })])));
  assert.equal(r.merge(merge, { session_id: 'other-2' }), null, 'an entry whose session the command did not know');
  r.record(5, (state) => (stopped()(state), (state.delegations = [entry({ session: 'main-1' }), entry({ session: 'other-2', at: '2026-11-03T14:40:00.000Z' })])));
  assert.equal(r.merge(merge, { session_id: 'main-1' }), null, 'a later entry of another session leaves this session`s own');
});

test('aidrian pr delegate records the session it runs in, and the guard takes the entry only there', async (t) => {
  const r = repo(t);
  r.record(5, stopped());
  assert.equal((await delegate(t, r, ['--issue', '9'], { issues: OPEN_ISSUE, env: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'main-1' } })).code, 0);
  assert.equal(readLocalState(r.project(), 5).delegations.at(-1).session, 'main-1', 'the session the host names');
  const merge = `gh pr merge 5 --match-head-commit ${HEAD}`;
  assert.equal(r.merge(merge, { session_id: 'main-1' }), null, 'the session that recorded it');
  assert.match(r.merge(merge, { session_id: 'other-2' }) ?? '', /stopped at its round limit/u, 'another session');
});

test('aidrian pr delegate refuses when this machine`s record, which the rule read the question from, is on another head or count than the posted copy', async (t) => {
  const { summaryBody } = await import('../plugins/aidrian/lib/review/state.mjs');
  const T1 = '2026-11-03T14:10:00.000Z';
  const posted = (rounds, outcome) => ({ ...emptyState(5, 'acme/notes'), revision: 50, rounds, outcome,
    planNote: { passes: { 'agent:code-reviewer': { stage: 'local', reviewer: 'agent:code-reviewer', security: false } } } });
  for (const [name, head, copy] of [
    ['a newer head', NEXT, posted([{ head: HEAD, at: T0, open: 2, findings: LOW }, { head: NEXT, at: T1, open: 1, findings: [finding('R3-1', 'low')] }], { status: 'round_limit', head: NEXT, at: T1 })],
    ['another open count', HEAD, posted([{ head: HEAD, at: T0, open: 1, findings: [finding('R2-1', 'low')] }], { status: 'round_limit', head: HEAD, at: T1 })],
  ]) {
    const r = repo(t);
    r.record(5, stopped());
    r.answer([QUESTION, 'your call']);
    assert.equal(r.rule('aidrian pr delegate 5 --issue 9'), null, `${name}: the rule read this machine's question`);
    const comments = [{ id: 1, user: { login: 'someone' }, author_association: 'MEMBER', body: summaryBody(copy, null, 'x') }];
    const issues = { 'acme/notes#9': { ...OPEN_ISSUE['acme/notes#9'], body: 'See #5: R2-1, R2-2, R3-1' } };
    await assert.rejects(delegate(t, r, ['--issue', '9'], { head, comments, issues }), /this machine's review record of #5 is not stopped at its round limit on head/u, name);
    assert.equal(readLocalState(r.project(), 5).delegations, undefined, `${name}: nothing written`);
  }
});

test('whether an answer is the Human`s own is the host adapter`s to say; a host whose adapter has none never gives one', () => {
  const entry = { type: 'user', ...HUMAN };
  assert.equal(humanAnswer(entry), true, 'Claude Code`s marks');
  assert.equal(humanAnswer(entry, [codex]), false, 'Codex names none');
  assert.equal(codex.humanAnswer, undefined);
  assert.ok(HOSTS.some((host) => typeof host.humanAnswer === 'function'));
  for (const over of [{ isMeta: true }, { isCompactSummary: true }, { isSidechain: undefined }, { entrypoint: 'claude-desktop' }, { permissionDecision: { source: 'hook' } }]) {
    assert.equal(humanAnswer({ ...entry, ...over }), false, JSON.stringify(over));
  }
  for (const each of [null, undefined, 'x', 5]) assert.equal(humanAnswer(each), false, String(each));
});

test('the deny names --repo in the delegation route when the remotes name several repositories', (t) => {
  const r = repo(t);
  r.git('remote', 'add', 'upstream', 'git@github.com:Other/Notes.git');
  r.record(5, stopped());
  const named = r.merge(`gh pr merge 5 -R Acme/Notes --match-head-commit ${HEAD}`) ?? '';
  assert.ok(named.includes(`run \`aidrian pr delegate 5 --issue <issue> --head ${HEAD} --repo acme/notes\` as its own command`), named);
  const one = repo(t);
  one.record(5, stopped());
  assert.ok((one.merge(`gh pr merge 5 --match-head-commit ${HEAD}`) ?? '').includes(`--head ${HEAD}\` as its own command`), 'one remote: no --repo');
  const picked = one.merge(`gh pr merge 5 -R Acme/Notes --match-head-commit ${HEAD}`) ?? '';
  assert.ok(picked.includes(`then merge with \`gh pr merge 5 --repo acme/notes --match-head-commit ${HEAD}\``), `one remote, a merge that names its repository keeps it: ${picked}`);
  assert.ok(named.includes(`then merge with \`gh pr merge 5 --repo acme/notes --match-head-commit ${HEAD}\``), `the merge it suggests keeps the repository: ${named}`);
  const state = readLocalState(r.project(), 5, 'acme/notes');
  state.delegations = [entry()];
  writeLocalState(r.project(), state, { repo: 'acme/notes' });
  const unnamed = r.merge('gh pr merge 5 -R Acme/Notes') ?? '';
  assert.ok(unnamed.includes(`merge with \`gh pr merge 5 --repo acme/notes --match-head-commit ${HEAD}\``), `the head route keeps the repository: ${unnamed}`);
});

test('a "Grant more review rounds" answer after the recorded delegation outranks it at merge time', (t) => {
  const r = repo(t);
  r.record(5, stopped());
  const merge = `gh pr merge 5 --match-head-commit ${HEAD}`;
  const state = readLocalState(r.project(), 5);
  state.delegations = [entry()];
  writeLocalState(r.project(), state);
  r.answer([QUESTION, 'whatever you recommend best']);
  assert.equal(r.merge(merge), null, 'the recorded answer stands');
  r.answer([QUESTION, 'whatever you recommend best'], [QUESTION, 'Grant more review rounds', '2026-11-03T15:00:00.000Z']);
  assert.match(r.merge(merge) ?? '', /The Human granted more review rounds after the recorded answer, so it no longer stands: do not merge/u);
  r.answer([QUESTION, 'Grant more review rounds', T0]);
  assert.equal(r.merge(merge), null, 'a grant before the entry does not outrank it');
});

test('lowOnly reads the highest severity and any security mark of findings two passes both reported', async () => {
  const { dedupe } = await import('../plugins/aidrian/lib/review/split.mjs');
  const state = (findings) => ({ ...emptyState(5, 'acme/notes'), rounds: [{ head: HEAD, at: T0, open: findings.length, findings }], outcome: { status: 'round_limit', head: HEAD, at: T0, cap: capOf(findings) } });
  const twin = (severity, over = {}) => ({ id: 'R2-1', title: 'Missing null check', file: 'a.js', line: 3, severity, ...over });
  for (const [name, second] of [['a Major twin', twin('Major')], ['a twin marked security', twin('low', { security: true })], ['a twin with no known severity', twin('urgent')]]) {
    for (const lists of [[['slice:a', [twin('low')]], ['cross', [second]]], [['slice:a', [second]], ['cross', [twin('low')]]]]) {
      const merged = dedupe(lists);
      assert.equal(merged.length, 1, name);
      assert.equal(lowOnly(state(merged), HEAD).ok, false, name);
    }
  }
});

test('lowOnly reads every stage of the cap: a low finding in the judged stage never hides a high, security, or other stop in another', () => {
  const capped = (cap) => ({ ...emptyState(5, 'acme/notes'), rounds: [{ head: HEAD, at: T0, open: LOW.length, findings: LOW }], outcome: { status: 'round_limit', head: HEAD, at: T0, cap } });
  assert.deepEqual(lowOnly(capped(capOf(LOW)), HEAD), { ok: true, count: 2, ids: ['R2-1', 'R2-2'] });
  // A slice and the cross-cutting pass report one low finding under two ids: the round keeps one, the other as an alias.
  // Another stage's low finding, or a second pass's id for one, is not in the question the Human answered: refused.
  const twins = capped(capOf(LOW, HEAD, { items: [...capOf(LOW).items, { id: 'R2-7', severity: 'low', pass: 'cross', stage: 'local', reviewer: 'cross' }], counted: 3 }));
  assert.deepEqual(lowOnly(twins, HEAD), { ok: false, why: 'finding R2-7 is open but not in the round\'s list' });
  const other = (severity, over = {}) => ({ id: 'R2-9', severity, pass: 'engine:codex-local', stage: 'independent', reviewer: 'engine:codex-local', ...over });
  const items = capOf(LOW).items;
  for (const [name, cap, why] of [
    ['a high in the stage that ran first', capOf(LOW, HEAD, { items: [...items, other('high')], counted: 3 }), /^finding R2-9 is high$/u],
    ['a low marked security in another stage', capOf(LOW, HEAD, { items: [...items, other('low', { security: true })], counted: 3 }), /^finding R2-9 is marked security$/u],
    ['no cause kept, as a posted copy', null, /does not hold what stopped the review/u],
    ['a cause for another head', capOf(LOW, NEXT), /does not hold what stopped the review/u],
    ['a cause only counted', capOf(LOW, HEAD, { itemized: false }), /does not hold what stopped the review/u],
    ['a pass that never ran', capOf(LOW, HEAD, { unrun: ['engine:codex-local'] }), /stopped on a pass that never reviewed it too/u],
    ['a remote reviewer still waited on', capOf(LOW, HEAD, { waiting: ['engine:pr-bot'] }), /stopped on a remote reviewer that has not answered too/u],
    ['a cause from before remote passes were kept', capOf(LOW, HEAD, { waiting: undefined }), /does not say whether a remote reviewer still owes head abcdef1/u],
    ['a flow invariant', capOf(LOW, HEAD, { flows: ['booking'] }), /stopped on a flow invariant not held too/u],
    ['a failing check', capOf(LOW, HEAD, { checks_failing: 1 }), /stopped on a failing check too/u],
    ['the bot\'s own limit', capOf(LOW, HEAD, { bot: true }), /review bot's own round limit/u],
  ]) {
    const result = lowOnly(capped(cap), HEAD);
    assert.equal(result.ok, false, name);
    assert.match(result.why, why, name);
  }
});

test('aidrian pr delegate reads the follow-up issue on the pull request`s host, for every spelling of it', async (t) => {
  for (const issue of ['9', 'acme/notes#9', 'https://github.com/Acme/Notes/issues/9']) {
    const r = repo(t);
    r.record(5, stopped());
    const hosts = [];
    assert.equal((await delegate(t, r, ['--issue', issue], { issues: OPEN_ISSUE, onIssue: (opts) => hosts.push(opts?.host ?? null) })).code, 0, issue);
    assert.deepEqual(hosts, ['github.com'], issue);
  }
});
