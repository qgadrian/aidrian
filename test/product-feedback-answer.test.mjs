import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { recordDecision } from '../plugins/aidrian/lib/audits.mjs';
import { check } from '../plugins/aidrian/lib/rules/product-feedback-answer.mjs';

process.env.XDG_STATE_HOME = mkdtempSync(path.join(tmpdir(), 'aidrian-state-'));
after(() => rmSync(process.env.XDG_STATE_HOME, { recursive: true, force: true }));

const HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-bash.mjs');
const REPORT = 'floor-manager-2026-11-03.md';
const RECORDED_AT = '2026-11-03T10:00:00.000Z';
const TITLE = 'Who may cancel a booking';
const QUESTION = `Pull request #7, item PF1: what happens with "${TITLE}"?`;

// A project with no feedback record in its state folder: the feature is not in use.
function plain(t) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-answer-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: 'state' } }));
  return dir;
}

// A project whose state folder holds pull request 7's record: one persona item and one product-manager item, both open.
function guarded(t) {
  const dir = plain(t);
  const folder = path.join(dir, 'state/product-feedback/acme/notes/pr-7');
  mkdirSync(folder, { recursive: true });
  const audits = path.join(dir, 'state/audits');
  mkdirSync(audits, { recursive: true });
  const record = {
    version: 1, pr: 7, repo: 'acme/notes', head: 'a'.repeat(40), report: REPORT, comment_id: null, recorded_at: RECORDED_AT,
    items: [
      { id: 'PF1', source: 'persona', audit_key: `${REPORT}#F1`, title: TITLE, kind: 'choice', owner: 'product-manager', head: 'a'.repeat(40), rechecked: null },
      { id: 'PF2', source: 'product-manager', title: 'A gap in the rules', kind: 'choice', owner: 'product-manager', head: 'a'.repeat(40), rechecked: null, answer: null },
    ],
  };
  const file = path.join(folder, 'record.json');
  writeFileSync(file, JSON.stringify(record));
  const transcript = path.join(dir, 'session.jsonl');
  writeFileSync(transcript, '');
  const answer = (question, picked, at = '2026-11-03T11:00:00.000Z') => appendFileSync(transcript, `${JSON.stringify({ type: 'user', timestamp: at, toolUseResult: { answers: { [question]: picked } } })}\n`);
  const main = { transcript_path: transcript };
  return { dir, audits, file, record, transcript, answer, run: (command, input = main, cwd = dir) => check(command, { cwd, input }) };
}
const ANSWER = 'aidrian pr product-feedback answer 7 PF1 drop --by human --reason gone';
const RECORD = `aidrian audits record ${REPORT} F1 drop --by human --reason gone`;
const TAIL = 'pr product-feedback answer 7 PF1 drop --by human';

test('a project whose state folder holds no product-feedback folder sees nothing of the rule, a subagent included', (t) => {
  const dir = plain(t);
  const commands = [
    ANSWER, RECORD,
    'aidrian "$@"', 'aidrian pr "$A" 5', 'aidrian $CMD --json', 'aidrian pr product-feedback $S',
    `aidrian audits record ${REPORT} "$K" drop --by human`,
    `xargs aidrian ${TAIL}`, `npx aidrian ${TAIL}`, `echo 'aidrian ${TAIL}' | bash`, `echo '${RECORD}' | sh`, `sh -c '${RECORD}'`,
    `C='aidrian ${TAIL}'; eval "$C"`, `python3 -c "x('aidrian ${TAIL}')"`,
  ];
  for (const command of commands) {
    assert.equal(check(command, { cwd: dir, input: {} }), null, `main session: ${command}`);
    assert.equal(check(command, { cwd: dir, input: { agent_id: 'a1' } }), null, `subagent: ${command}`);
  }
  // The folder turns it on, with nothing yet recorded in it.
  mkdirSync(path.join(dir, 'state/product-feedback'), { recursive: true });
  assert.ok(check(RECORD, { cwd: dir, input: { agent_id: 'a1' } }));
  assert.ok(check('aidrian "$@"', { cwd: dir, input: {} }));
  assert.ok(check(`xargs aidrian ${TAIL}`, { cwd: dir, input: {} }));
});

// A project's state folder under the state root holding `product-feedback/`: this machine keeps product feedback.
function feedbackOnMachine(t) {
  const folder = path.join(process.env.XDG_STATE_HOME, 'aidrian/projects/other-0123abcd/product-feedback');
  mkdirSync(folder, { recursive: true });
  t.after(() => rmSync(path.join(process.env.XDG_STATE_HOME, 'aidrian'), { recursive: true, force: true }));
}
const UNKNOWN_PROJECT = /cannot read which project it runs in, or which words it holds/u;

test('a dynamic --project is refused only while this machine keeps product feedback; a literal one is read', (t) => {
  const elsewhere = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-elsewhere-')));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  const dynamic = [`aidrian audits record --project "$P" ${REPORT} F9 drop --by human`, `aidrian audits record --project=$P ${REPORT} F9 drop --by human`];
  for (const command of dynamic) {
    for (const input of [{}, { agent_id: 'a1' }]) assert.equal(check(command, { cwd: elsewhere, input }), null, `no product feedback on this machine: ${command}`);
  }
  feedbackOnMachine(t);
  for (const command of dynamic) {
    for (const input of [{}, { agent_id: 'a1' }]) assert.match(check(command, { cwd: elsewhere, input }) ?? '', UNKNOWN_PROJECT, command);
  }
  assert.equal(check(`aidrian audits record --project "$P" ${REPORT} F9 drop`, { cwd: elsewhere, input: {} }), null, 'no human claim');
  assert.equal(check(`aidrian audits --project "$P" list`, { cwd: elsewhere, input: {} }), null);
  const dir = plain(t);
  assert.equal(check(`aidrian audits record --project ${dir} ${REPORT} F9 drop --by human`, { cwd: elsewhere, input: {} }), null, 'a literal one, with the feature off there');
});

test('an unquoted --project $P with no --by sees nothing where no product feedback is kept, and its deny claims no --by human', (t) => {
  const elsewhere = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-elsewhere-')));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  const command = `aidrian audits record ${REPORT} F1 drop --reason gone --project $P`;
  const inputs = [{}, { agent_id: 'a1' }];
  for (const input of inputs) assert.equal(check(command, { cwd: elsewhere, input }), null, `${JSON.stringify(input)}: off`);
  feedbackOnMachine(t);
  for (const input of inputs) {
    const reason = check(command, { cwd: elsewhere, input }) ?? '';
    assert.match(reason, UNKNOWN_PROJECT, `${JSON.stringify(input)}: on`);
    assert.ok(!/with `--by human` records|Return the decision/u.test(reason), `it claims no --by human: ${reason}`);
  }
});

test('a folder the rule cannot follow, or a ~ --project, is refused only while this machine keeps product feedback', (t) => {
  const elsewhere = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-elsewhere-')));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  const unknown = [
    `cd "$D" && ${RECORD}`, `cd ~/x && ${RECORD}`, `cd "$D" && ${ANSWER}`, `cd ~/x && ${ANSWER}`, `(cd "$D"; ${ANSWER})`,
    `env -C "$D" ${ANSWER}`, `pushd "$D" && ${ANSWER}`, `aidrian audits record --project ~/x ${REPORT} F1 drop --by human`,
    `cd "$D" && echo '${RECORD}' | sh`,
  ];
  const textOnly = [`cd "$D" && xargs ${NAMED}`, `cd ~/x && xargs ${NAMED}`];
  for (const command of [...unknown, ...textOnly]) {
    for (const input of [{}, { agent_id: 'a1' }]) assert.equal(check(command, { cwd: elsewhere, input }), null, `no product feedback on this machine: ${command}`);
  }
  // The current project's own folder counts, wherever its state.dir puts it.
  const g = guarded(t);
  assert.match(g.run(`cd "$D" && ${ANSWER}`) ?? '', UNKNOWN_PROJECT, 'the current project keeps product feedback');
  feedbackOnMachine(t);
  for (const command of unknown) {
    for (const input of [{}, { agent_id: 'a1' }]) assert.match(check(command, { cwd: elsewhere, input }) ?? '', UNKNOWN_PROJECT, `${JSON.stringify(input)}: ${command}`);
  }
  for (const command of textOnly) assert.ok(check(command, { cwd: elsewhere, input: {} }), command);
  assert.equal(check('cd "$D" && aidrian audits list', { cwd: elsewhere, input: {} }), null, 'a call that claims nothing');
  assert.equal(check(`cd "$D" && aidrian pr product-feedback answer 7 PF1 fix-now`, { cwd: elsewhere, input: {} }), null, 'a session\'s own answer');
});

test('a subagent is refused, whatever key it names, and its deny sends the decision back', (t) => {
  const g = guarded(t);
  g.answer(QUESTION, 'Drop');
  const subagent = { transcript_path: g.transcript, agent_id: 'a1' };
  assert.match(g.run(ANSWER, subagent) ?? '', /subagent/u);
  assert.match(g.run(RECORD, subagent) ?? '', /subagent/u);
  assert.match(g.run('aidrian audits record other-2026-11-03.md F1 drop --by human --reason x', subagent) ?? '', /subagent/u, 'a key no record holds');
  assert.match(g.run('aidrian pr $S', subagent) ?? '', /subagent/u);
  assert.match(g.run(`xargs aidrian ${TAIL}`, subagent) ?? '', /subagent/u);
  assert.equal(g.run('aidrian pr product-feedback answer 7 PF1 fix-now', { agent_id: 'a1' }), null, 'a session\'s own answer is no word of the Human');
});

test('with no answer in the transcript, --by human is refused, and the deny names the question to ask', (t) => {
  const g = guarded(t);
  const denied = g.run(ANSWER);
  assert.match(denied ?? '', /#7, PF1, and "Who may cancel a booking"/u);
  assert.match(denied ?? '', /drop alone/u);
  assert.match(denied ?? '', /own\s+shell/u);
  assert.ok(g.run(ANSWER, {}), 'no transcript, as on Codex: the Human runs it in their own shell');
  assert.ok(!/opt[- ]?out|productFeedback|\bauto\b/iu.test(denied), 'the deny never names the opt-out as a route');
});

test('each spelling of a call is read: refused with no answer in the transcript, and passed after one', (t) => {
  for (const command of [
    ANSWER,
    'aidrian pr product-feedback answer 7 PF1 drop --by=human --reason gone',
    `/usr/local/bin/aidrian ${TAIL}`,
    `node plugins/aidrian/lib/cli.mjs ${TAIL}`,
    `node -r x plugins/aidrian/lib/cli.mjs ${TAIL}`,
    `node --disable-warning X plugins/aidrian/lib/cli.mjs ${TAIL}`,
    `bun --input-type plugins/aidrian/lib/cli.mjs ${TAIL}`,
    'aidrian pr product-feedback answer "#7" PF1 drop --by human',
    'aidrian pr product-feedback answer https://github.com/acme/notes/pull/7 PF1 drop --by human',
    'aidrian pr product-feedback answer 7 PF1 drop --by human --reason "$R"',
    'aidrian pr product-feedback answer 7 PF1 drop --by human --reason="$R"',
    "aidrian pr product-feedback answer 7 PF1 drop --by human --reason 'fix [the] list, {a,b}'",
    `"$AIDRIAN" ${TAIL}`,
    `$B ${TAIL}`,
    `$(command -v aidrian) ${TAIL}`,
    `\`command -v aidrian\` ${TAIL}`,
    `sh -c 'aidrian ${TAIL}'`,
    `echo $(aidrian ${TAIL})`,
    `eval "aidrian ${TAIL}"`,
    `bash <<'EOF'\naidrian ${TAIL}\nEOF`,
    `git status && aidrian ${TAIL}`,
  ]) {
    const g = guarded(t);
    assert.match(g.run(command) ?? '', /no such answer/u, `with no answer: ${command}`);
    g.answer(QUESTION, 'Drop');
    assert.equal(g.run(command), null, `after the Human's answer: ${command}`);
  }
});

const NAMED = 'aidrian pr product-feedback answer 7 PF2 drop --by human';

test('what the rule cannot read as one call is refused, whatever the transcript holds', (t) => {
  const g = guarded(t);
  const refused = [
    'aidrian pr product-feedback answer 7 PF1 drop --by "$WHO"',
    'aidrian pr product-feedback answer 7 PF1 drop --by=$WHO',
    'aidrian pr product-feedback answer 7 PF1 drop $FLAGS',
    'aidrian pr product-feedback answer "$PR" PF1 drop --by human',
    'aidrian pr product-feedback answer 7 "$ITEM" drop --by human',
    'aidrian pr product-feedback answer 7 PF1 "$D" --by human',
    'aidrian pr product-feedback answer 7 PF1 --by',
    'aidrian pr product-feedback answer 7 PF1 defer --reason $R',
    'aidrian pr product-feedback answer 7 PF1 defer --reason=$R',
    'aidrian pr product-feedback answer 7 PF1 defer --reason "$@"',
    'aidrian pr product-feedback answer 7 PF1 defer --reason="${A[@]}"',
    'aidrian pr product-feedback answer 7 PF1 defer --reason "${A[*]}"',
    'aidrian pr product-feedback answer 7 PF1 defer --reason *',
    'aidrian pr product-feedback answer 7 PF1 drop {--by,human}',
    'aidrian pr product-feedback answer 7 PF1 defer --reason {x,--by,human}',
    'aidrian pr product-feedback answer 7 PF1 defer --by=hu{,man}',
    'aidrian pr product-feedback answer 7 PF1 defer --by {human,x}',
    'aidrian pr product-feedback answer 7 PF1 defer {1..3}',
    'aidrian pr product-feedback answer 7 PF1 defer [--]by',
    'aidrian $S',
    'aidrian pr $S',
    'aidrian pr product-feedback $S',
    'aidrian "$@"',
    '"$AIDRIAN" $S',
    `"$(command -v aidrian)" ${TAIL}`,
  ];
  for (const command of refused) assert.ok(g.run(command), `with no answer: ${command}`);
  g.answer(QUESTION, 'Drop');
  for (const command of refused) assert.ok(g.run(command), `after the Human's answer: ${command}`);
});

test('a command the rule did not judge is refused when its words name a call, unless it only handles text', (t) => {
  const g = guarded(t);
  for (const command of [
    `xargs ${NAMED}`,
    `echo 7 | xargs aidrian pr product-feedback answer PF2 drop --by human`,
    `find . -name x -exec ${NAMED} \\;`,
    `npx ${NAMED}`,
    `pnpm exec ${NAMED}`,
    `python3 -c "import os; os.system('${NAMED}')"`,
    `python3 <<'EOF'\nimport os; os.system('${NAMED}')\nEOF`,
    `C='${NAMED}'; eval "$C"`,
    `C='${NAMED}'; bash -c "$C"`,
    `B='${NAMED}'; $B`,
    `X='${NAMED}'; eval "$X"`,
    `echo '${NAMED}' | bash`,
    `echo '${NAMED}' | xargs sh -c`,
    `cat <<'EOF' | bash\n${NAMED}\nEOF`,
    `printf '%s' '${NAMED}' | tee f | sh`,
    `git -c core.editor='${NAMED}' commit`,
    `GIT_EDITOR='${NAMED}' git commit`,
    `git -c alias.x='!${NAMED}' x`,
    `git grep -O'${NAMED}'`,
    `rg --pre '${NAMED}' x`,
    `rg --pre='${NAMED}' x`,
    `grep -h '${NAMED}' notes | xargs aidrian`,
    `aidrian audits list; printf '%s\\n' --by human | xargs aidrian pr product-feedback answer 7 PF2 drop`,
    `aidrian pr product-feedback status 7; printf '%s\\n' --by human | parallel aidrian pr product-feedback answer 7 PF2 drop`,
    `aidrian pr product-feedback answer 7 PF1 fix-now; xargs ${NAMED}`,
    `echo '${NAMED}' > x.sh; sh x.sh`,
    `echo 'x' | python3 - '${NAMED}'`,
    `echo 'same' ; echo '${NAMED}' | python3`,
    `echo '${NAMED}'; echo '${NAMED}' | python3`,
    `gh api repos/x -f body='${NAMED}'`,
    `gh alias set x '${NAMED}'`,
    `sh -c "npx ${NAMED}"`,
  ]) {
    assert.ok(g.run(command), command);
  }
});

test('a command that only handles text may name a call: its words are data', (t) => {
  const g = guarded(t);
  for (const command of [
    'git commit -m "fix(audits): record the Human\'s pick"',
    `git commit -m "docs: say ${NAMED}"`,
    `git commit -F - <<EOF\nHow to run ${NAMED}\nEOF`,
    `git log --grep '${NAMED}'`,
    `git grep '${NAMED}'`,
    `git show HEAD:docs/x.md`,
    `git notes add -m '${NAMED}'`,
    `git tag -m '${NAMED}' v1`,
    `grep -n '${NAMED}' docs/hooks.md`,
    `egrep '${NAMED}' docs/hooks.md`,
    `fgrep '${NAMED}' docs/hooks.md`,
    `rg '${NAMED}' docs`,
    `rg --pre-glob '*.md' '${NAMED}' docs`,
    `ag '${NAMED}'`,
    `ack '${NAMED}'`,
    `cat > f <<EOF\n${NAMED}\nEOF`,
    `cat <<'EOF' > f\n${NAMED}\nEOF`,
    `tee f <<'EOF'\n${NAMED}\nEOF`,
    `gh pr comment 7 --body '${NAMED}'`,
    `gh issue create --title x --body '${NAMED}'`,
    `echo '${NAMED}'`,
    `printf '%s\\n' '${NAMED}'`,
    `echo '${NAMED}' | grep human | head -1`,
    `grep '${NAMED}' docs/hooks.md | wc -l`,
    `head -1 f; tail -1 f; sort f; uniq f; cut -c1 f; tr a b <f; diff a b; wc '${NAMED}'`,
    'echo "the human said so"',
    'echo "aidrian audits list" | sh',
    'git status',
    '$EDITOR notes.md',
    '"$PYTHON" script.py',
    '$CMD $ARGS',
    'aidrian audits list --json',
    'aidrian pr review 7',
    'aidrian pr checks 7 --json',
    "aidrian pr product-feedback answer 7 PF1 fix-now --reason 'a human saw it'",
    `aidrian audits verdict ${REPORT} F1 silent --by product-manager --reason 'human record'`,
    `python3 script.py '${NAMED.replace('--by ', '')}'`,
    `npx thing 'product-feedback answer'`,
  ]) {
    assert.equal(g.run(command), null, command);
  }
});

test('a session\'s answer, with no --by human, is not the rule\'s to hold', (t) => {
  const g = guarded(t);
  for (const command of ['aidrian pr product-feedback answer 7 PF1 fix-now', 'aidrian pr product-feedback answer 7 PF1 defer --reason later --by product-manager', 'aidrian pr product-feedback answer 7 PF1 defer --reason "$R"', 'aidrian pr product-feedback status 7', 'aidrian pr product-feedback record 7']) {
    assert.equal(g.run(command), null, command);
  }
});

const CHAINED = /also runs `aidrian pr product-feedback record` or an aidrian call the rule cannot read.*Run `record` on its own first/u;
const NEXT_REPORT = 'floor-manager-2026-11-04.md';
const RECORD_FIRST = `aidrian pr product-feedback record 7 --report ${NEXT_REPORT} --items items.json`;

test('record chained with a human word in one command is refused: the hook runs before record writes, on a first record or a later one', (t) => {
  // The reviewer's two probes: a fix-now path (`decided --by human`) and a choice item (`drop --by human`), each on a finding the
  // record does not list yet, since this record call is what adopts it.
  const words = [
    `aidrian audits record ${NEXT_REPORT} F1 decided --by human --reason 'Fix it'`,
    `aidrian audits record ${NEXT_REPORT} F1 drop --by human --reason 'not needed'`,
    `aidrian audits record ${NEXT_REPORT} F1 drop --by=human --reason gone`,
    `aidrian audits record ${NEXT_REPORT} "$K" drop --by human --reason gone`,
    `aidrian audits record ${NEXT_REPORT} F1 drop --by "$WHO" --reason gone`,
    'aidrian pr product-feedback answer 7 PF3 drop --by human --reason gone',
  ];
  const first = plain(t);
  const later = guarded(t);
  for (const word of words) {
    for (const command of [`${RECORD_FIRST} && ${word}`, `${RECORD_FIRST}; ${word}`, `${word} && ${RECORD_FIRST}`, `${RECORD_FIRST} && sh -c "${word.replaceAll('"', '\\"')}"`]) {
      assert.match(check(command, { cwd: first, input: {} }) ?? '', CHAINED, `a first-ever record, no product-feedback folder: ${command}`);
      assert.match(later.run(command) ?? '', CHAINED, `an existing record: ${command}`);
      assert.match(later.run(command, { agent_id: 'a1' }) ?? '', /subagent/u, `a subagent: ${command}`);
    }
  }
  // An aidrian call whose subcommand the rule cannot read may be that record call.
  for (const writer of ['aidrian pr product-feedback "$S" 7', 'aidrian "$@"', 'aidrian $CMD 7']) {
    assert.match(check(`${writer} && ${words[0]}`, { cwd: first, input: {} }) ?? '', CHAINED, writer);
  }
  // Text fed to a shell, beside a record call, that names audits record with --by.
  assert.match(check(`${RECORD_FIRST} && echo '${words[1]}' | sh`, { cwd: first, input: {} }) ?? '', CHAINED);
});

test('record alone, or chained with calls that claim no human, still runs', (t) => {
  const first = plain(t);
  const later = guarded(t);
  const commands = [
    RECORD_FIRST,
    `${RECORD_FIRST} && aidrian audits record ${NEXT_REPORT} F1 drop --reason x`,
    `${RECORD_FIRST} && aidrian audits record ${NEXT_REPORT} F1 drop --by product-manager --reason x`,
    `${RECORD_FIRST} && aidrian pr product-feedback status 7 --json`,
    `${RECORD_FIRST} && aidrian pr product-feedback answer 7 PF3 fix-now`,
    `${RECORD_FIRST} && echo 'aidrian audits record ${NEXT_REPORT} F1 drop --by human' > note.txt`,
    // No record call and no unreadable aidrian call: the chained rule adds nothing.
    `aidrian audits verdict ${REPORT} F1 conforms --by product-manager --reason x && aidrian audits record other-2026-11-03.md F1 drop --by human --reason x`,
    'aidrian "$@"',
  ];
  for (const command of commands) {
    assert.equal(check(command, { cwd: first, input: {} }), null, `a first-ever record: ${command}`);
  }
  for (const command of commands.slice(0, -1)) assert.equal(later.run(command), null, `an existing record: ${command}`);
});

test('text fed to a shell that names a call is refused, audits record while a record lists a key, and it passes with nothing to hold', (t) => {
  const g = guarded(t);
  const subagent = { transcript_path: g.transcript, agent_id: 'a1' };
  for (const command of [`echo '${RECORD}' | sh`, `sh -c '${RECORD}'`, `echo '${ANSWER}' | bash`, "echo 'aidrian pr product-feedback answer 7 PF1 fix-now' | bash"]) {
    assert.ok(g.run(command), `an open item: ${command}`);
    assert.match(g.run(command, subagent) ?? '', /subagent/u, `a subagent: ${command}`);
  }
  g.answer(QUESTION, 'Drop');
  assert.equal(g.run(`sh -c '${RECORD}'`), null, 'read as a call, so the answer counts');
  assert.ok(g.run(`echo '${RECORD}' | sh`), 'unread, so no answer counts');
  // A record with nothing a key could name: only a product-manager item.
  const none = guarded(t);
  writeFileSync(none.file, JSON.stringify({ ...none.record, items: [none.record.items[1]] }));
  for (const command of [`echo '${RECORD}' | sh`, `sh -c '${RECORD}'`, RECORD, `xargs ${RECORD}`, `aidrian audits record ${REPORT} "$K" drop --by human`]) {
    assert.equal(none.run(command), null, `nothing to hold: ${command}`);
  }
  assert.ok(none.run(`echo '${ANSWER}' | bash`), 'the answer call is held all the same');
  // And with a subagent, which is refused whatever is listed once a shell or a call is read.
  assert.match(none.run(`echo '${RECORD}' | sh`, subagent) ?? '', /subagent/u);
});

test('the question must name the item alone: its id once, its title in double quotes, and the pull request as itself', (t) => {
  const missing = [
    [QUESTION.replace('#7', '#71'), 'another pull request'],
    [QUESTION.replace('#7', 'acme/other#7'), 'another repository\'s pull request'],
    [QUESTION.replace('#7', 'In acme/other#7'), 'another repository\'s, in words'],
    [QUESTION.replace('#7', 'x/#7'), 'a # after a slash'],
    [QUESTION.replace(TITLE, 'Another title entirely'), 'another item'],
    [QUESTION.replace(`"${TITLE}"`, TITLE), 'the title with no quotes'],
    [QUESTION.replace(`"${TITLE}"`, `"${TITLE} and more"`), 'a longer title'],
    [QUESTION.replace('item PF1', 'an item'), 'no id'],
    [QUESTION.replace('item PF1', 'item PF2'), 'another id'],
    [QUESTION.replace('item PF1', 'items PF1 and PF2'), 'two ids'],
    [QUESTION.replace('item PF1', 'item PF1x'), 'an id with no boundary'],
    [`${QUESTION} And of "A gap in the rules"?`, 'another item\'s title too'],
  ];
  for (const [question, what] of missing) {
    const g = guarded(t);
    g.answer(question, 'Drop');
    assert.ok(g.run(ANSWER), what);
  }
  const g = guarded(t);
  g.answer(QUESTION, 'Drop');
  assert.equal(g.run(ANSWER), null);
});

test('a title of any length is asked about by its id and its quotes', (t) => {
  for (const title of ['cancel', 'a']) {
    const g = guarded(t);
    writeFileSync(g.file, JSON.stringify({ ...g.record, items: [{ ...g.record.items[0], title }, g.record.items[1]] }));
    g.answer(`Should we cancel a booking on #7, as in PF1?`, 'Drop');
    assert.ok(g.run(ANSWER), `no quotes around ${title}`);
    g.answer(`On #7, what of "${title}"?`, 'Drop');
    assert.ok(g.run(ANSWER), `no id for ${title}`);
    g.answer(`On #7, PF1: what of "${title}"?`, 'Drop');
    assert.equal(g.run(ANSWER), null, title);
  }
});

test('the option must be the decision alone, and given after the record', (t) => {
  for (const [picked, passes] of [['Drop', true], ['drop', true], [' Drop.', true], ['Drop nothing, keep it open', false], ['Do not drop', false], ['Drop it', false], ['Fix now', false]]) {
    const g = guarded(t);
    g.answer(QUESTION, picked);
    assert.equal(g.run(ANSWER) === null, passes, picked);
  }
  const g = guarded(t);
  g.answer(QUESTION, 'Fix now');
  assert.match(g.run(ANSWER) ?? '', /"Fix now"/u, 'the deny names what the Human picked');
  assert.equal(g.run('aidrian pr product-feedback answer 7 PF1 fix-now --by human'), null, 'fix-now also reads as "Fix now"');
  const old = guarded(t);
  old.answer(QUESTION, 'Drop', '2026-11-02T09:00:00.000Z');
  assert.match(old.run(ANSWER) ?? '', /after it was recorded/u, 'an answer older than the record');
});

test('a deny carries no line break or hidden character, from a title or the option the Human picked', (t) => {
  const g = guarded(t);
  g.answer(QUESTION, 'Line one\nLine‮ two');
  const denied = g.run(ANSWER);
  assert.ok(denied);
  assert.ok(!/[\n‮]/u.test(denied), JSON.stringify(denied));
  assert.match(denied, /"Line one Line two"/u);
});

test('a bare number that two repositories\' records hold is refused; a URL names one', (t) => {
  const g = guarded(t);
  const other = path.join(g.dir, 'state/product-feedback/acme/other/pr-7');
  mkdirSync(other, { recursive: true });
  writeFileSync(path.join(other, 'record.json'), JSON.stringify({ ...g.record, repo: 'acme/other' }));
  g.answer(QUESTION, 'Drop');
  assert.match(g.run(ANSWER) ?? '', /more than one repository.*URL/u);
  assert.equal(g.run('aidrian pr product-feedback answer https://github.com/acme/notes/pull/7 PF1 drop --by human'), null);
  assert.ok(g.run('aidrian pr product-feedback answer https://github.com/acme/third/pull/7 PF1 drop --by human'), 'a repository no record holds');
});

test('aidrian audits record --by human is held on a key a record lists, before and after its answer, and on no other', (t) => {
  const g = guarded(t);
  assert.ok(g.run(RECORD), 'a bare id of the report');
  assert.ok(g.run(`aidrian audits record ${REPORT} '${REPORT}#F1' drop --by human --reason gone`), 'the full key');
  assert.ok(g.run(`aidrian audits record ${REPORT} F9,F1 drop --by human --reason gone`), 'one key of several');
  assert.ok(g.run(`aidrian audits --by human record ${REPORT} F1 drop --reason gone`), 'the flag may come first');
  assert.ok(g.run(`aidrian audits record ${REPORT} "$K" drop --by human --reason gone`), 'a key it cannot read');
  assert.ok(g.run(`aidrian audits record ${REPORT} F1 drop --by "$WHO" --reason gone`), 'a --by it cannot read');
  assert.equal(g.run(`aidrian audits record ${REPORT} F2 drop --by human --reason gone`), null, 'a finding no record lists');
  assert.equal(g.run(`aidrian audits record other-2026-11-03.md F1 drop --by human --reason gone`), null, 'another report');
  assert.equal(g.run(`aidrian audits record ${REPORT} F1 drop --reason gone`), null, 'no --by human');
  assert.equal(g.run(`aidrian audits verdict ${REPORT} F1 silent --by product-manager --reason x`), null);
  g.answer(QUESTION, 'Drop');
  assert.equal(g.run(RECORD), null, 'the Human answered');
  assert.ok(g.run(`aidrian audits record ${REPORT} F1 issue --issue A-1 --by human`), 'but not that decision');
  assert.ok(g.run(`aidrian audits record ${REPORT} F1 drop --by "$WHO" --reason gone`), 'a dynamic --by, even with the answer');
  assert.equal(g.run(`aidrian audits record ${REPORT} F2 drop --by "$WHO" --reason gone`), null, 'a dynamic --by on a key no record lists');
});

test('a listed key spelled with a brace the shell expands is a key the rule cannot read; with no item listed it passes', (t) => {
  const g = guarded(t);
  const braced = [
    `aidrian audits record ${REPORT} F{1..1} drop --by human --reason gone`,
    `aidrian audits record ${REPORT} F{1,} drop --by human --reason gone`,
    `aidrian audits record floor-manager-2026-11-0{3..3}.md F1 drop --by human --reason gone`,
    `aidrian audits record ${REPORT} ${REPORT}#F{1..1} drop --by human --reason gone`,
  ];
  for (const command of braced) assert.match(g.run(command) ?? '', /cannot read its keys/u, command);
  g.answer(QUESTION, 'Drop');
  for (const command of braced) assert.match(g.run(command) ?? '', /cannot read its keys/u, `after the Human's answer: ${command}`);
  const dir = plain(t);
  mkdirSync(path.join(dir, 'state/product-feedback'), { recursive: true });
  for (const command of braced) assert.equal(check(command, { cwd: dir, input: {} }), null, `nothing listed: ${command}`);
});

test('a word holding an unquoted brace or glob is unreadable wherever quotes sit around it; a quoted one is read literally', (t) => {
  const g = guarded(t);
  const keys = [`F{1..1}' '`, `F{1..1}" "`, `' 'F{1..1}`, `'${REPORT}#'F{1..1}' '`, `F{1,}`, `F[1]`, `'F'[1]`, `F\\1{,}`];
  const records = keys.map((each) => `aidrian audits record ${REPORT} ${each} drop --by human --reason gone`);
  for (const command of records) assert.match(g.run(command) ?? '', /cannot read its keys/u, command);
  const answers = [
    `aidrian pr product-feedback answer 7 PF{1,} drop --by human`, `aidrian pr product-feedback answer 7 'PF'{1..1}' ' drop --by human`,
    `aidrian pr product-feedback answer {7,} PF1 drop --by human`, `aidrian pr product-feedback answer 7 PF1 drop --by 'h'{u,}man`,
    `aidrian pr product-feedback answer 7 PF1 drop --by=h[u]man`, `aidrian pr product-feedback answer 7 PF1 drop --b{y,} human`,
    `aidrian pr product-feedback {answer,} 7 PF1 drop`, `aidrian pr product-feedback answer 7 PF1 fix-now --reason x{,--by} human`,
    `aidrian audits record ${REPORT} F1 drop --b'y'{,} human --reason gone`,
  ];
  for (const command of answers) assert.ok(g.run(command), command);
  // Quoted, a brace or a bracket is a character: the key it names is no listed one, and a reason is prose.
  for (const command of [
    `aidrian audits record ${REPORT} 'F{1..1}' drop --by human --reason gone`, `aidrian audits record ${REPORT} "F{1,}" drop --by human`,
    `aidrian audits record ${REPORT} F\\[1\\] drop --by human`, `aidrian pr product-feedback answer 7 PF1 fix-now --reason 'fix [the] list, {a,b}'`,
  ]) assert.equal(g.run(command), null, command);
  // With no item listed, a key it cannot read holds nothing.
  const dir = plain(t);
  mkdirSync(path.join(dir, 'state/product-feedback'), { recursive: true });
  for (const command of records) assert.equal(check(command, { cwd: dir, input: {} }), null, `nothing listed: ${command}`);
});

test('a folder that is no existing directory, a cd of two operands, or a CDPATH is unknown, and refused only while this machine keeps product feedback', (t) => {
  const g = guarded(t);
  const elsewhere = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-elsewhere-')));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  const base = path.basename(g.dir);
  const globbed = `${base.slice(0, -1)}[${base.at(-1)}]`;
  const unknown = [
    [`cd ../${globbed} && ${ANSWER}`], [`cd ../'${base.slice(0, -1)}'? && ${ANSWER}`], [`cd ../nowhere-at-all && ${ANSWER}`],
    [`CDPATH=.. cd ${base} && ${ANSWER}`], [`export CDPATH=..; cd ${base} && ${ANSWER}`], [`cd ../${base} && CDPATH=.. ${ANSWER}`],
    [`cd ${path.basename(elsewhere)} ${base} && ${ANSWER}`], [`pushd ${path.basename(elsewhere)} ${base} && ${ANSWER}`],
    [`${ANSWER} --project ../${globbed}`], [`${ANSWER} --project=../${globbed}`], [`aidrian audits record --project ../${globbed} ${REPORT} F1 drop --by human`],
    [`${ANSWER} --project ../nowhere-at-all`], [`cd ${base} && ${ANSWER}`, { CDPATH: '..' }],
  ];
  const inputs = [{}, { agent_id: 'a1' }];
  for (const [command, env = {}] of unknown) {
    for (const input of inputs) assert.equal(check(command, { cwd: elsewhere, input, env }), null, `no product feedback on this machine: ${command}`);
  }
  // A cd the rule can read reaches the guarded project in either state.
  assert.ok(check(`cd ../${base} && ${ANSWER}`, { cwd: elsewhere, input: {}, env: {} }), 'a plain relative cd');
  feedbackOnMachine(t);
  for (const [command, env = {}] of unknown) {
    for (const input of inputs) assert.match(check(command, { cwd: elsewhere, input, env }) ?? '', UNKNOWN_PROJECT, `${JSON.stringify(input)}: ${command}`);
  }
  assert.match(check(`cd ../${base} && ${ANSWER}`, { cwd: elsewhere, input: {}, env: {} }) ?? '', /#7, PF1/u, 'a plain relative cd is read, not unknown');
  assert.equal(check(`cd .. && ${ANSWER}`, { cwd: elsewhere, input: {}, env: {} }), null, 'an existing folder outside any project');
  assert.equal(check(ANSWER, { cwd: elsewhere, input: {}, env: { CDPATH: '..' } }), null, 'a call in cwd, under a CDPATH');
});

test('a listed key stays held after its final answer, so a later word needs asking too', (t) => {
  const g = guarded(t);
  recordDecision(g.audits, [{ report: REPORT, id: 'F1' }], { decision: 'drop', by: 'human', reason: 'done', date: '2026-11-03' });
  assert.match(g.run(RECORD) ?? '', /#7, PF1/u);
  assert.ok(g.run(`aidrian audits record ${REPORT} "$K" drop --by human`), 'a key it cannot read may be that one');
  g.answer(QUESTION, 'Drop');
  assert.equal(g.run(RECORD), null);
});

test('a finding of a report no record lists is not held: a word there counts for nothing until a record adopts it', (t) => {
  const g = guarded(t);
  writeFileSync(path.join(g.audits, 'other-2026-11-03.json'), JSON.stringify({ version: 1, report: 'other-2026-11-03.md', pr: 'acme/notes#7', findings: [{ id: 'F1', title: 'A finding nobody adopted' }] }));
  assert.equal(g.run('aidrian audits record other-2026-11-03.md F1 drop --by human --reason gone'), null);
});

test('the rule reads the --project a call names and the folder a cd moves to', (t) => {
  const g = guarded(t);
  const elsewhere = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-elsewhere-')));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  const main = { transcript_path: g.transcript };
  assert.equal(g.run(RECORD, main, elsewhere), null, 'no project here, so the rule is off');
  assert.ok(g.run(`aidrian audits record --project ${g.dir} ${REPORT} F1 drop --by human`, main, elsewhere), '--project names it');
  assert.ok(g.run(`cd ${g.dir} && ${RECORD}`, main, elsewhere), 'a cd moves to it');
  assert.ok(g.run(`cd ${g.dir} && ${ANSWER}`, main, elsewhere));
  assert.ok(g.run(`cd ${g.dir} && xargs ${NAMED}`, main, elsewhere), 'the text check reads the folder of the command too');
  assert.equal(g.run(`xargs ${NAMED}`, main, elsewhere), null, 'and with no cd, no project');
  g.answer(QUESTION, 'Drop');
  assert.equal(g.run(`cd ${g.dir} && ${RECORD}`, main, elsewhere), null);
});

test('the rule is on only inside a project, and a broken record never stops a command it cannot read', (t) => {
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-out-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  assert.equal(check(ANSWER, { cwd: outside, input: {} }), null);
  assert.equal(check('aidrian $S', { cwd: outside, input: {} }), null);
  const g = guarded(t);
  writeFileSync(g.file, '{ broken');
  assert.equal(g.run(RECORD), null, 'no record it can read holds the key');
  assert.ok(g.run(ANSWER), '--by human still needs the Human, whatever the record says');
  writeFileSync(g.file, JSON.stringify({ ...g.record, items: [{ ...g.record.items[0], title: 'A forged\ntitle' }] }));
  assert.ok(!/forged/iu.test(g.run(ANSWER) ?? 'forged'), 'a forged title is a record it cannot read');
});

test('the Bash hook runs the rule and blocks with exit 2', (t) => {
  const g = guarded(t);
  const result = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: ANSWER }, cwd: g.dir, transcript_path: g.transcript }), encoding: 'utf8', cwd: g.dir });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /product-feedback answer/u);
});

test('the rule loads no knowledge loader, and the forge only through review/state.mjs, so a Bash call pays for no gh', () => {
  const lib = path.resolve(import.meta.dirname, '../plugins/aidrian/lib');
  const seen = new Set();
  const forgeImporters = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const [, target] of readFileSync(file, 'utf8').matchAll(/^(?:import|export)[^'"\n]*from '(\.[^']+)'/gmu)) {
      const next = path.resolve(path.dirname(file), target);
      if (path.relative(lib, next).startsWith(`forges${path.sep}`) && !path.relative(lib, file).startsWith(`forges${path.sep}`)) forgeImporters.add(path.relative(lib, file));
      walk(next);
    }
  };
  walk(path.join(lib, 'rules/product-feedback-answer.mjs'));
  const reached = [...seen].map((file) => path.relative(lib, file));
  // The forge facade loads only for review/state.mjs, which asks it who belongs to a repository: nothing the rule reads
  // runs gh, and nothing of the rule's own reaches for the forge.
  assert.deepEqual([...forgeImporters], [path.join('review', 'state.mjs')]);
  assert.ok(reached.length > 1, 'the walk follows imports');
  for (const absent of ['knowledge.mjs', 'pr-product-feedback.mjs', 'pr-auto-merge.mjs', 'pr-resolve.mjs']) assert.ok(!reached.includes(absent), `${absent} is reached: ${reached.join(', ')}`);
});

test('two items with the same title are told apart by the id alone', (t) => {
  const g = guarded(t);
  writeFileSync(g.file, JSON.stringify({ ...g.record, items: [g.record.items[0], { ...g.record.items[1], title: TITLE }] }));
  g.answer(QUESTION, 'Drop');
  assert.equal(g.run(ANSWER), null, 'the shared title is not another item\'s');
});
