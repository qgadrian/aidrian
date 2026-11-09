import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { check, REASON } from '../plugins/aidrian/lib/rules/review-signoff.mjs';

function project(t) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-signoff-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/o/r.git'], { cwd: dir });
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1 }));
  return dir;
}

test('an agent cannot sign off a flow, however it runs aidrian', (t) => {
  const cwd = project(t);
  for (const command of [
    'aidrian pr signoff 9 --flow harness-config --head abc1234',
    '/usr/local/bin/aidrian pr signoff 9 --flow x --head abc1234',
    'node plugins/aidrian/lib/cli.mjs pr signoff 9 --flow x --head abc1234',
    'node "$CLAUDE_PLUGIN_ROOT/bin/aidrian" pr signoff 9',
    'cd x && aidrian pr signoff 9',
    'echo $(aidrian pr signoff 9)',
    'env FOO=1 aidrian pr signoff 9',
    'aidrian pr signoff 9 --last',
    '/usr/local/bin/aidrian pr signoff 9 --last',
    'node plugins/aidrian/lib/cli.mjs pr signoff 9 --last',
    'node "$CLAUDE_PLUGIN_ROOT/bin/aidrian" pr signoff 9 --last',
    'echo $(aidrian pr signoff 9 --last)',
  ]) assert.equal(check(command, { cwd }), REASON, command);
  for (const command of ['aidrian pr review 9', 'aidrian pr attest 9 --check', 'echo "aidrian pr signoff 9"', 'grep signoff docs/review.md', 'node other.mjs pr signoff']) {
    assert.equal(check(command, { cwd }), null, command);
  }
});

test('a sign-off inside a shell wrapper is denied', (t) => {
  const cwd = project(t);
  for (const command of [
    'bash -c "aidrian pr signoff 9"',
    "sh -c 'aidrian pr signoff 9'",
    'zsh -lc "aidrian pr signoff 9"',
    'eval "aidrian pr signoff 9"',
    'eval -- "aidrian pr signoff 9"',
    'bash -c "eval \'aidrian pr signoff 9\'"',
    "bash <<'EOF'\naidrian pr signoff 9\nEOF",
    'bash <<< "aidrian pr signoff 9"',
    'echo "aidrian pr signoff 9" | bash',
    'bash -c "aidrian pr signoff 9 --last"',
    'eval "aidrian pr signoff 9 --last"',
    "bash <<'EOF'\naidrian pr signoff 9 --last\nEOF",
    'echo "aidrian pr signoff 9 --last" | bash',
  ]) assert.equal(check(command, { cwd }), REASON, command);
  for (const command of ['bash -c "aidrian pr review 9"', 'eval "echo pr signoff"', 'echo "pr signoff" | grep signoff', "cat <<'EOF'\naidrian pr signoff 9\nEOF"]) {
    assert.equal(check(command, { cwd }), null, command);
  }
});

test('an agent may dry-run a sign-off with --check, and every other sign-off is still denied', (t) => {
  const cwd = project(t);
  for (const command of [
    'aidrian pr signoff 9 --flow look --head abc1234 --check',
    'aidrian pr signoff 9 --flow look --accept matches-design --evidence https://github.com/o/r/pull/9#issuecomment-1 --reason "approved" --head abc1234 --check',
    'node plugins/aidrian/lib/cli.mjs pr signoff 9 --check --stage independent --head abc1234',
    'bash -c "aidrian pr signoff 9 --flow x --head abc1234 --check"',
    'aidrian pr signoff 9 --last --check',
    'bash -c "aidrian pr signoff 9 --last --check"',
  ]) assert.equal(check(command, { cwd }), null, command);
  for (const command of [
    'aidrian pr signoff 9 --flow look --accept matches-design --evidence https://x --reason "y" --head abc1234',
    'aidrian pr signoff 9 --flow x --head abc1234 --check-in',
    'aidrian pr signoff 9 --flow x --head abc1234 --check && aidrian pr signoff 9 --flow x --head abc1234',
    'echo "aidrian pr signoff 9 --check" | bash',
    'aidrian pr signoff 9 --last --check && aidrian pr signoff 9 --last',
  ]) assert.equal(check(command, { cwd }), REASON, command);
});

test("the rule's message names the short form and still hands the command over", () => {
  assert.match(REASON, /only the Human runs it, `--last` included/u);
  assert.match(REASON, /Stop\b/u);
  assert.match(REASON, /At human_required naming one flow, once `aidrian pr signoff <PR> --last --check` exits 0, hand over the short form `aidrian pr signoff <PR> --last`/u);
  assert.match(REASON, /phone/u);
  assert.match(REASON, /naming the flow and short head that `--check` printed/u);
  assert.match(REASON, /At a disputed flow's overrule, or any other stop, hand over the command the review step printed/u);
  assert.match(REASON, /run it with `--check`, which records nothing/u);
});

test('a --check the shell builds at run time is no dry run, and a subcommand it builds is denied', (t) => {
  const cwd = project(t);
  for (const command of [
    'aidrian pr signoff `printf https://github.com/o/r/pull/9/`--check --last',
    'aidrian pr signoff `printf https://github.com/o/r/pull/9/`--check --flow x --head abc1234',
    'aidrian pr signoff 9 --repo `printf o/r/pull/1/`--check --last',
    'aidrian pr signoff 9 --last `true`--check',
    'aidrian pr signoff 9 --last $(true)--check',
    'set -- pr signoff 9 --last; aidrian "$@"',
    'a=(pr signoff 9 --last); aidrian "${a[@]}"',
    'aidrian() { command aidrian "${@/--check/}"; }; aidrian pr signoff 9 --last --check',
    'aidrian pr "$sub" 9 --last',
  ]) assert.equal(check(command, { cwd }), REASON, command);
  for (const command of ['aidrian pr review $PR', 'aidrian pr signoff 9 --last --check', 'aidrian pr signoff "$PR" --last --check', 'aidrian check']) {
    assert.equal(check(command, { cwd }), null, command);
  }
});

test('outside a project the rule is off', (t) => {
  const bare = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-signoff-bare-')));
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  assert.equal(check('aidrian pr signoff 9', { cwd: bare }), null);
});

// The Human's AskUserQuestion answer, in the host's transcript shape, lets the long form run.
const HEAD = 'abc1234def';
function transcript(t, answers) {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-transcript-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 't.jsonl');
  writeFileSync(file, answers.map((one) => JSON.stringify({ type: 'user', toolUseResult: { answers: one }, timestamp: '2026-11-09T00:00:00Z' })).join('\n'));
  return { transcript_path: file };
}

test('the Human`s answer naming the pull request, head, and invariant lets exactly that sign-off run', (t) => {
  const cwd = project(t);
  const accept = `aidrian pr signoff 9 --flow ui --accept fit --evidence https://x/y --reason ok --head ${HEAD}`;
  const input = transcript(t, [{ 'Accept the fit check on o/r#9 at abc1234? (ui/fit)': 'Approve (Recommended)' }]);
  assert.equal(check(accept, { cwd, input }), null);
  for (const [why, command] of [
    ['another invariant', accept.replace('--accept fit', '--accept fit-more')],
    ['another flow', accept.replace('--flow ui', '--flow pay')],
    ['another pull request', accept.replace('signoff 9', 'signoff 91')],
    ['another head', accept.replace(HEAD, 'fff1234def')],
    ['a shell variable', accept.replace('--reason ok', '--reason "$R"')],
    ['a repeated flag', `${accept} --accept other`],
    ['another repository', `${accept} --repo other/repo`],
    ['the short form', 'aidrian pr signoff 9 --last'],
    ['a stage', `aidrian pr signoff 9 --stage local --head ${HEAD}`],
  ]) assert.equal(check(command, { cwd, input }), REASON, why);
});

test('only an Approve answer counts, the latest wins, and a flow-wide answer covers --accept alone', (t) => {
  const cwd = project(t);
  const accept = `aidrian pr signoff 9 --flow ui --accept fit --evidence https://x/y --reason ok --head ${HEAD}`;
  const overrule = `aidrian pr signoff 9 --flow ui --overrule fit --reason ok --head ${HEAD}`;
  const q = 'o/r#9 at abc1234: ui/fit?';
  assert.equal(check(accept, { cwd, input: transcript(t, [{ [q]: 'Keep it open' }]) }), REASON);
  assert.equal(check(accept, { cwd, input: transcript(t, [{ [q]: 'Approve' }, { [`${q} again`]: 'Deny' }]) }), REASON);
  const wide = transcript(t, [{ 'o/r#9 at abc1234: every point of ui/*?': 'Approve' }]);
  assert.equal(check(accept, { cwd, input: wide }), null);
  assert.equal(check(overrule, { cwd, input: wide }), REASON, 'a ruling names its invariant');
  assert.equal(check(`aidrian pr signoff 9 --flow ui --head ${HEAD}`, { cwd, input: transcript(t, [{ 'o/r#9 at abc1234: ui/signoff?': 'Approve' }]) }), null);
  assert.equal(check(accept, { cwd, input: { transcript_path: '/no/such/file' } }), REASON, 'no transcript, so the Human`s own shell');
});

test('a stage sign-off runs on an answer naming that stage, and --last still needs the long form', (t) => {
  const cwd = project(t);
  const stage = `aidrian pr signoff 9 --stage independent --head ${HEAD}`;
  const input = transcript(t, [{ 'o/r#9 at abc1234: stage:independent/signoff?': 'Approve' }]);
  assert.equal(check(stage, { cwd, input }), null);
  assert.equal(check(stage.replace('independent', 'local'), { cwd, input }), REASON);
  assert.equal(check('aidrian pr signoff 9 --last', { cwd, input }), REASON);
});

test('an answer naming another repository`s pull request approves nothing here', (t) => {
  const cwd = project(t);
  const command = `aidrian pr signoff 9 --flow ui --accept fit --evidence https://x/y --reason ok --head ${HEAD}`;
  for (const question of ['fork/r#9 at abc1234: ui/fit?', '#9 at abc1234: ui/fit?', 'xo/r#9 at abc1234: ui/fit?']) {
    assert.equal(check(command, { cwd, input: transcript(t, [{ [question]: 'Approve' }]) }), REASON, question);
  }
});

test('an approved command aimed elsewhere, or a checkout with several remotes, gets no in-session route', (t) => {
  const cwd = project(t);
  const command = `aidrian pr signoff 9 --flow ui --accept fit --evidence https://x/y --reason ok --head ${HEAD}`;
  const input = transcript(t, [{ 'o/r#9 at abc1234: ui/fit?': 'Approve' }]);
  assert.equal(check(command, { cwd, input }), null);
  for (const aimed of [`cd /other && ${command}`, `env -C /other ${command}`, `GH_REPO=x/y ${command}`, `${command}; true`]) assert.equal(check(aimed, { cwd, input }), REASON, aimed);
  execFileSync('git', ['remote', 'add', 'upstream', 'https://github.com/up/r.git'], { cwd });
  assert.equal(check(command, { cwd, input }), REASON, 'the forge default may be the parent');
});
