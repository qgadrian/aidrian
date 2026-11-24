import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { repoName } from '../plugins/aidrian/lib/remotes.mjs';
import { check, REASON, SUBAGENT_REASON, TEXT_ROUTE, textReason, UNATTENDED_REASON } from '../plugins/aidrian/lib/rules/review-signoff.mjs';

// A deny of the sign-off: REASON, and after it the miss, when the session holds answers to go by.
const denies = (got, why = '') => assert.ok(typeof got === 'string' && got.startsWith(REASON), `${why}: ${got}`);

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
  ]) denies(check(command, { cwd }), command);
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
  ]) denies(check(command, { cwd }), command);
  for (const command of ['bash -c "aidrian pr review 9"', 'eval "echo pr signoff"', 'echo "pr signoff" | grep signoff', "cat <<'EOF'\naidrian pr signoff 9\nEOF"]) {
    assert.equal(check(command, { cwd }), null, command);
  }
});

test('a sign-off in a case arm whose pattern is a glob or a variable, or behind builtin, is denied', (t) => {
  const cwd = project(t);
  for (const command of [
    'case $x in *) aidrian pr signoff 5 --last ;; esac', 'case $x in "$y") aidrian pr signoff 5 --last ;; esac', 'case $x in ?) aidrian pr signoff 5 ;; esac',
    'builtin command aidrian pr signoff 5 --last', 'builtin exec aidrian pr signoff 5 --last', 'builtin eval "aidrian pr signoff 5 --last"',
    'case $x in a ) aidrian pr signoff 5 --last ;; esac', 'f () { aidrian pr signoff 5 --last; }; f',
  ]) denies(check(command, { cwd }), command);
  assert.equal(check('case $x in *) aidrian pr review 5 ;; esac', { cwd }), null, 'another command');
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
  ]) denies(check(command, { cwd }), command);
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
  ]) denies(check(command, { cwd }), command);
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
  ]) denies(check(command, { cwd, input }), why);
});

test('only an Approve answer counts, the latest wins, and a flow-wide answer covers --accept alone', (t) => {
  const cwd = project(t);
  const accept = `aidrian pr signoff 9 --flow ui --accept fit --evidence https://x/y --reason ok --head ${HEAD}`;
  const overrule = `aidrian pr signoff 9 --flow ui --overrule fit --reason ok --head ${HEAD}`;
  const q = 'o/r#9 at abc1234: ui/fit?';
  denies(check(accept, { cwd, input: transcript(t, [{ [q]: 'Keep it open' }]) }));
  denies(check(accept, { cwd, input: transcript(t, [{ [q]: 'Approve' }, { [`${q} again`]: 'Deny' }]) }));
  const wide = transcript(t, [{ 'o/r#9 at abc1234: every point of ui/*?': 'Approve' }]);
  assert.equal(check(accept, { cwd, input: wide }), null);
  denies(check(overrule, { cwd, input: wide }), 'a ruling names its invariant');
  assert.equal(check(`aidrian pr signoff 9 --flow ui --head ${HEAD}`, { cwd, input: transcript(t, [{ 'o/r#9 at abc1234: ui/signoff?': 'Approve' }]) }), null);
  denies(check(accept, { cwd, input: { transcript_path: '/no/such/file' } }), 'no transcript, so the Human`s own shell');
});

test('a stage sign-off runs on an answer naming that stage, and --last still needs the long form', (t) => {
  const cwd = project(t);
  const stage = `aidrian pr signoff 9 --stage independent --head ${HEAD}`;
  const input = transcript(t, [{ 'o/r#9 at abc1234: stage:independent/signoff?': 'Approve' }]);
  assert.equal(check(stage, { cwd, input }), null);
  denies(check(stage.replace('independent', 'local'), { cwd, input }));
  denies(check('aidrian pr signoff 9 --last', { cwd, input }));
});

test('an answer naming another repository`s pull request approves nothing here', (t) => {
  const cwd = project(t);
  const command = `aidrian pr signoff 9 --flow ui --accept fit --evidence https://x/y --reason ok --head ${HEAD}`;
  for (const question of ['fork/r#9 at abc1234: ui/fit?', '#9 at abc1234: ui/fit?', 'xo/r#9 at abc1234: ui/fit?']) {
    denies(check(command, { cwd, input: transcript(t, [{ [question]: 'Approve' }]) }), question);
  }
});

test('an approved command aimed elsewhere, or a checkout with several remotes, gets no in-session route', (t) => {
  const cwd = project(t);
  const command = `aidrian pr signoff 9 --flow ui --accept fit --evidence https://x/y --reason ok --head ${HEAD}`;
  const input = transcript(t, [{ 'o/r#9 at abc1234: ui/fit?': 'Approve' }]);
  assert.equal(check(command, { cwd, input }), null);
  for (const aimed of [`cd /other && ${command}`, `env -C /other ${command}`, `GH_REPO=x/y ${command}`, `${command}; true`]) denies(check(aimed, { cwd, input }), aimed);
  execFileSync('git', ['remote', 'add', 'upstream', 'https://github.com/up/r.git'], { cwd });
  denies(check(command, { cwd, input }), 'the forge default may be the parent');
});

// #251: the checkout had remotes origin, origin-https, and a third of one repository, and a fourth of another.
function severalRemotes(t) {
  const cwd = project(t);
  for (const [name, url] of [['origin-https', 'https://github.com/o/r'], ['team', 'git@github.com:o/r.git'], ['other', 'https://github.com/qg/voila.git']]) {
    execFileSync('git', ['remote', 'add', name, url], { cwd });
  }
  return cwd;
}

test('in a checkout with several remotes, an answer counts on the sign-off whose --repo it names', (t) => {
  const cwd = severalRemotes(t);
  const accept = `aidrian pr signoff 9 --flow ui --accept fit --evidence https://x/y --reason ok --head ${HEAD}`;
  const input = transcript(t, [{ 'Accept the fit check on o/r#9 at abc1234? (ui/fit)': 'Approve (Recommended)' }]);
  assert.equal(check(`${accept} --repo o/r`, { cwd, input }), null, 'the repository the answer names, one of the remotes');
  assert.equal(check(`aidrian pr signoff 9 --repo O/R --flow ui --accept fit --evidence https://x/y --reason ok --head ${HEAD}`, { cwd, input }), null, 'anywhere among the flags, in any letter case');
  denies(check(accept, { cwd, input }), 'no --repo: the forge default may be either repository');
  denies(check(`${accept} --repo qg/voila`, { cwd, input }), 'the other remote`s repository, which the answer does not name');
  const other = transcript(t, [{ 'Accept the fit check on qg/voila#9 at abc1234? (ui/fit)': 'Approve' }]);
  denies(check(`${accept} --repo o/r`, { cwd, input: other }), 'an answer naming the other repository approves nothing on this one');
  for (const [why, command] of [
    ['a repository no remote names', `${accept} --repo x/y`],
    ['a repeated --repo', `${accept} --repo o/r --repo o/r`],
    ['a --repo the shell builds', `${accept} --repo "$R"`],
    ['a --repo with a host', `${accept} --repo github.com/o/r`],
    ['a --repo as a URL', `${accept} --repo https://github.com/o/r`],
    ['a --repo with .git', `${accept} --repo o/r.git`],
    ['a --repo with no value', `${accept} --repo`],
    ['a chain', `${accept} --repo o/r; true`],
    ['a cd', `cd /other && ${accept} --repo o/r`],
    ['env -C', `env -C /other ${accept} --repo o/r`],
    ['an environment prefix', `GH_REPO=qg/voila ${accept} --repo o/r`],
    ['the short form', 'aidrian pr signoff 9 --last --repo o/r'],
  ]) denies(check(command, { cwd, input }), why);
  const xy = transcript(t, [{ 'Accept the fit check on x/y#9 at abc1234? (ui/fit)': 'Approve' }]);
  denies(check(`${accept} --repo x/y`, { cwd, input: xy }), 'an answer naming a repository no remote names approves nothing');
});

test('in a checkout with several remotes, the overrule, the flow, and the stage sign-off take --repo alike', (t) => {
  const cwd = severalRemotes(t);
  const overrule = `aidrian pr signoff 9 --flow ui --overrule fit --reason ok --head ${HEAD} --repo o/r`;
  assert.equal(check(overrule, { cwd, input: transcript(t, [{ 'o/r#9 at abc1234: ui/fit?': 'Approve' }]) }), null);
  assert.equal(check(`aidrian pr signoff 9 --flow ui --head ${HEAD} --repo o/r`, { cwd, input: transcript(t, [{ 'o/r#9 at abc1234: ui/signoff?': 'Approve' }]) }), null);
  const stage = transcript(t, [{ 'o/r#9 at abc1234: stage:independent/signoff?': 'Approve' }]);
  assert.equal(check(`aidrian pr signoff 9 --stage independent --head ${HEAD} --repo o/r`, { cwd, input: stage }), null);
  denies(check(`aidrian pr signoff 9 --stage independent --head ${HEAD}`, { cwd, input: stage }));
  denies(check(`aidrian pr signoff 9 --stage independent --head ${HEAD} --repo o/r`, { cwd, input: transcript(t, [{ 'o/r#9 at abc1234: stage:independent/signoff?': 'Deny' }]) }), 'only an Approve answer counts');
});

test('in a checkout with one remote, a --repo must name it', (t) => {
  const cwd = project(t);
  const accept = `aidrian pr signoff 9 --flow ui --accept fit --evidence https://x/y --reason ok --head ${HEAD}`;
  assert.equal(check(`${accept} --repo o/r`, { cwd, input: transcript(t, [{ 'o/r#9 at abc1234: ui/fit?': 'Approve' }]) }), null);
  denies(check(`${accept} --repo fork/r`, { cwd, input: transcript(t, [{ 'fork/r#9 at abc1234: ui/fit?': 'Approve' }]) }), 'a repository that is no remote');
});

test('the deny names the --repo route for several remotes, a plain command from the checkout, and the notification', () => {
  assert.doesNotMatch(REASON, /has no such route/u, 'several remotes have a route now');
  assert.match(REASON, /In a checkout whose remotes name more than one repository, end the command with `--repo <owner>\/<name>`, the repository the question names/u);
  assert.match(REASON, /one plain command run from the checkout of that pull request, with no shell variables, `cd`, `env -C`, or chain/u);
  assert.match(REASON, /Before asking, when the host offers a tool that sends the Human a push notification, send one saying a decision waits\./u);
});

test('a --repo of `.` or `..` segments names no repository, even beside a remote at such a path', (t) => {
  // #251 security review: `../x` once matched a remote at `/tmp/a/../x`, which reads as the same two segments.
  const cwd = project(t);
  execFileSync('git', ['remote', 'remove', 'origin'], { cwd });
  execFileSync('git', ['remote', 'add', 'origin', '/tmp/a/../x'], { cwd });
  const command = `aidrian pr signoff 9 --flow ui --head ${HEAD} --repo ../x`;
  denies(check(command, { cwd, input: transcript(t, [{ '../x#9 at abc1234: ui/signoff?': 'Approve' }]) }));
  for (const repo of ['./x', 'o/..', 'o/.']) {
    denies(check(`aidrian pr signoff 9 --flow ui --head ${HEAD} --repo ${repo}`, { cwd, input: transcript(t, [{ [`${repo}#9 at abc1234: ui/signoff?`]: 'Approve' }]) }), repo);
  }
  assert.deepEqual(['../x', '/tmp/a/../x', 'o/.', './x'].map(repoName), [null, null, null, null]);
});

// Sessions retried a denied sign-off three times in a minute: the deny named no miss. It names the one thing wrong now.
test('a deny after the Human answered names the nearest miss', (t) => {
  const cwd = project(t);
  const accept = `aidrian pr signoff 9 --flow ui --accept fit --evidence https://x/y --reason ok --head ${HEAD}`;
  const miss = (command, answers) => {
    const got = check(command, { cwd, input: transcript(t, answers) }) ?? '';
    assert.ok(got.startsWith(`${REASON} This call: `), got);
    return got.slice(REASON.length);
  };
  const good = [{ 'o/r#9 at abc1234: ui/fit?': 'Approve' }];
  assert.match(miss(accept.replace('https://x/y', '"$U"'), good), /`\$U` is a word the shell builds at run time/u);
  assert.match(miss(accept, [{ 'o/r#9 at abc1234: ui / fit?': 'Approve' }]), /names `ui\/fit`, written as one word with no space around the `\/`/u);
  assert.match(miss(accept, [{ 'o/r#9: ui/fit?': 'Approve' }]), /names the head `abc1234`/u);
  assert.match(miss(accept, [{ 'o/r#8 at abc1234: ui/fit?': 'Approve' }]), /no question answered names `o\/r#9`/u);
  assert.match(miss(accept, [{ 'o/r#9 at abc1234: ui/fit?': 'Not yet' }]), /the Human picked "Not yet"/u);
  execFileSync('git', ['remote', 'add', 'upstream', 'https://github.com/up/r.git'], { cwd });
  assert.match(miss(accept, good), /remotes name more than one repository: end the command with `--repo <owner>\/<name>`/u);
});

// A subagent has no answer route: it is told to hand the question to its dispatcher, rather than retry.
test('a subagent`s sign-off is refused with the needs_input route, every shape alike', (t) => {
  const cwd = project(t);
  for (const command of ['aidrian pr signoff 9 --flow ui --head abc1234', 'aidrian pr signoff 9 --last', 'aidrian "$@"', 'xargs aidrian pr signoff 9 --last']) {
    assert.equal(check(command, { cwd, input: { agent_id: 'a1' } }), SUBAGENT_REASON, command);
  }
  assert.match(SUBAGENT_REASON, /return `status: needs_input` to your dispatcher, with `next_owner: the Human`, the sign-off question/u);
});

// The shapes the product-feedback rule already denies for its own command, read by its readCall and textDenial.
test('a sign-off whose program or line the shell builds at run time is denied, and the dry run and plain text still run', (t) => {
  const cwd = project(t);
  for (const command of [
    'x=aidrian; $x pr signoff 9 --last',
    '"$(command -v aidrian)" pr signoff 9 --last',
    'xargs aidrian pr signoff 9 --last',
    'npx aidrian pr signoff 9 --last',
    'C="aidrian pr signoff 9 --last"; eval "$C"',
    "alias s='aidrian pr signoff'; s 9 --last",
    '$TOOL pr "$SUB" 9 --last',
    'aidrian pr {signoff,review} 9',
    'x=aidrian; $x pr signoff 9 --flow ui --head abc1234',
    'npx aidrian pr signoff 9 --flow ui --head abc1234',
    'npx aidrian pr signoff 9 --last --check',
  ]) assert.equal(check(command, { cwd }), REASON, command);
  // Code an interpreter runs is refused alike, and its refusal also names the file tool for text that only quotes it.
  for (const command of [
    `python3 -c "os.system('aidrian pr signoff 9 --last')"`,
    `python3 -c "os.system('aidrian pr signoff 9 --last'); print('--check')"`,
  ]) assert.equal(check(command, { cwd }), textReason(REASON), command);
  // Outside a project, a subagent and a session no Human attends are refused the text shapes too.
  const bare = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-signoff-bare-')));
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  assert.equal(check('xargs aidrian pr signoff 9 --last', { cwd: bare, input: { session_id: 's1' }, unattendedMark: () => ({ root: null }), drives: () => false }) !== null, true);
  assert.equal(check('xargs aidrian pr signoff 9 --last', { cwd: bare, input: {}, unattendedMark: () => null, drives: () => false }), null, 'an attended session outside a project');
  for (const command of [
    'aidrian pr signoff 9 --last --check',
    'aidrian pr review $PR',
    'echo "aidrian pr signoff 9 --last"',
    'git commit -m "docs: aidrian pr signoff 9 --last is the Human\'s"',
    'grep -rn "aidrian pr signoff" docs',
    'node other.mjs pr signoff',
    'x=aidrian; $x pr review 9',
    'aidrian pr product-feedback "$ACTION" 9',
  ]) assert.equal(check(command, { cwd }), null, command);
});

// A background session rewriting its handoff brief with a Python heredoc, whose text quoted the sign-off command for the
// Human, was refused with a reason that said only "stop and report", and then split the words to get past the rule.
// A sign-off named only in text the rule cannot read as commands now opens with the route for text that only quotes
// the command, the file tool, which this rule does not read, and only then gives the sign-off's own refusal, for text
// meant to record one; a sign-off the rule reads as a command keeps its reason alone.
test('a sign-off named only in a script`s text names the file tool for text that quotes it; a read sign-off does not', (t) => {
  const cwd = project(t);
  const brief = path.join(cwd, 'brief.md');
  const quoted = 'run `aidrian pr signoff 6144 --flow ui-visual --accept fit-at-widths`';
  const heredoc = `python3 -I - ${brief} > ${brief}.tmp <<'EOF'\nimport sys\nt=open(sys.argv[1]).read()\nt=t.replace("x", "${quoted}")\nsys.stdout.write(t)\nEOF`;
  const unattended = { input: { session_id: 's1' }, unattendedMark: () => ({ root: cwd }), drives: () => false };
  const subagent = { input: { agent_id: 'a1' }, unattendedMark: () => null, drives: () => false };
  assert.equal(check(heredoc, { cwd, ...unattended }), textReason(UNATTENDED_REASON));
  assert.equal(check(heredoc, { cwd, ...subagent }), textReason(SUBAGENT_REASON));
  assert.equal(check(heredoc, { cwd, input: {}, unattendedMark: () => null, drives: () => false }), textReason(REASON), 'an attended session');
  // Text piped into a shell is a command the shell runs: its refusal stays the sign-off's alone.
  assert.equal(check('echo "aidrian pr signoff 9 --last" | bash', { cwd, ...unattended }), UNATTENDED_REASON, 'a shell fed text');
  // One instruction comes first, for text that only quotes the command; the stop is only for text meant to record one.
  const reason = textReason(UNATTENDED_REASON);
  assert.ok(reason.startsWith(TEXT_ROUTE), reason);
  assert.match(TEXT_ROUTE, /^Blocked: this call names `aidrian pr signoff` only in text this rule cannot read as commands, an interpreter's code or input.*When that text only quotes the command, as a brief or a body for the Human does, it records no sign-off: write the file with the file tool instead, which this rule does not read, and go on/u);
  assert.ok(reason.indexOf('Stop and report') > reason.indexOf('When the text is meant to record a sign-off, it is refused: `aidrian pr signoff` is the Human'), reason);
  // A sign-off the rule reads as a command keeps its own reason, with no text route.
  for (const command of ['aidrian pr signoff 9 --flow ui --head abc1234', `bash <<'EOF'\naidrian pr signoff 9 --last\nEOF`]) {
    assert.equal(check(command, { cwd, ...unattended }), UNATTENDED_REASON, command);
  }
});
