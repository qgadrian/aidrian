import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { bannedPatterns } from '../scripts/banned-terms.mjs';
import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { DEFAULTS } from '../plugins/aidrian/lib/config-defaults.mjs';
import { findProject } from '../plugins/aidrian/lib/project.mjs';
import { check as prBody } from '../plugins/aidrian/lib/rules/github/pr-body.mjs';
import { check, OVERRIDE } from '../plugins/aidrian/lib/rules/github/public-text.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PATTERNS = ['\\bplaceholder words?\\b', 'second (form|shape)'];
const WITH_PATTERNS = { version: 1, github: { requiredSections: [], publicText: { patterns: PATTERNS } } };
const BAD = 'text with a Placeholder Word in it';
const GOOD = 'text the patterns never name';
// The processes see no git variable or override of the running session, and a state folder of their own.
const clean = (t) => {
  const state = mkdtempSync(path.join(tmpdir(), 'aidrian-publictext-state-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  return { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_') && !name.startsWith('AIDRIAN_'))), XDG_STATE_HOME: state };
};

// A project folder with `config`, a body file per entry of `files`, and `remote` as its origin when set.
function project(t, config = WITH_PATTERNS, files = {}, remote = null) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-publictext-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify(config));
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
  if (remote) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
    execFileSync('git', ['init', '-q'], { cwd: dir, env });
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir, env });
  }
  const run = (command, env = {}) => check(command, { cwd: dir, env });
  run.dir = dir;
  return run;
}

const heredoc = (form, body) => `${form} --body "$(cat <<'EOF'\n${body}\nEOF\n)"`;

test('the rule is off by default, and off for an empty list', (t) => {
  assert.deepEqual(DEFAULTS.github.publicText.patterns, []);
  for (const config of [{ version: 1 }, { version: 1, github: { publicText: { patterns: [] } } }]) {
    const run = project(t, config);
    assert.equal(run(`gh issue create --title '${BAD}' --body '${BAD}'`), null);
    assert.equal(run('gh issue comment 3 --body "$UNREAD"'), null, 'an unread body asks nothing either');
    assert.equal(run('gh issue create'), null);
  }
});

test('every command form is read, in every way gh takes a body', (t) => {
  const run = project(t, WITH_PATTERNS, { 'bad.md': BAD, 'good.md': GOOD });
  const forms = ['gh issue create --title x', 'gh issue new --title x', 'gh issue edit 3', 'gh issue comment 3', 'gh pr create --title x', 'gh pr new --title x', 'gh pr edit 3', 'gh pr comment 3', 'gh -R acme/notes issue comment 3'];
  for (const form of forms) {
    for (const bad of [`${form} --body '${BAD}'`, `${form} --body='${BAD}'`, `${form} -b '${BAD}'`, heredoc(form, BAD), `${form} --body-file bad.md`, `${form} -F bad.md`,
      `${form} --body-file - <<'EOF'\n${BAD}\nEOF`, `cat > made.md <<'EOF' && ${form} --body-file made.md\n${BAD}\nEOF`]) {
      assert.match(run(bad) ?? '', /^Blocked: the body matches/, bad);
    }
    for (const good of [`${form} --body '${GOOD}'`, heredoc(form, GOOD), `${form} -F good.md`, `${form} --body-file - <<'EOF'\n${GOOD}\nEOF`]) {
      assert.equal(run(good), null, good);
    }
  }
  assert.match(run(`cd ${run.dir} && gh pr comment 3 -F bad.md`), /^Blocked: the body matches/, 'read in the folder gh runs in');
  assert.match(run(`x=$(gh issue comment 3 -b '${BAD}')`), /^Blocked: the body matches/, 'a substitution runs');
  assert.match(run(`gh issue comment 3 -b 'a SECOND shape'`), /pattern `second \(form\|shape\)`/, 'any pattern, in any case');
});

test('a title is checked when given', (t) => {
  const run = project(t);
  for (const command of [`gh issue create --title '${BAD}' --body x`, `gh issue edit 3 -t '${BAD}'`, `gh pr create -t '${BAD}' -b x`, `gh pr edit 3 --title='${BAD}'`]) {
    assert.match(run(command) ?? '', /^Blocked: the title matches/, command);
  }
  assert.equal(run('gh pr edit 3 --title x'), null);
  assert.equal(run('gh issue edit 3 --add-label x'), null, 'an edit with neither posts no text');
  assert.match(run('gh pr edit 3 --title "$T"'), /^Blocked: the title is one this rule cannot read/);
});

test('the deny names the pattern, never the text, and says what to do', (t) => {
  const run = project(t);
  const reason = run(`gh issue comment 3 --body 'leading ${BAD} trailing'`);
  assert.match(reason, /`\\bplaceholder words\?\\b`/u);
  assert.match(reason, /Rewrite it as the rule or limit/);
  assert.match(reason, /keep the detail in the state folder/);
  assert.match(reason, /GitHub keeps the old text in its edit history, so an edit does not remove what was already posted/);
  assert.match(reason, new RegExp(`set ${OVERRIDE}=1 in your own shell`));
  for (const echoed of ['leading', 'trailing', 'Placeholder Word']) assert.doesNotMatch(reason, new RegExp(echoed), echoed);
});

test('the override lets a matching and an unread text run', (t) => {
  const run = project(t);
  assert.equal(OVERRIDE, 'AIDRIAN_ALLOW_PUBLIC_TEXT');
  assert.equal(run(`gh issue comment 3 --body '${BAD}'`, { [OVERRIDE]: '1' }), null);
  assert.equal(run('gh issue comment 3 --body "$UNREAD"', { [OVERRIDE]: '1' }), null);
  assert.match(run(`gh issue comment 3 --body '${BAD}'`, { [OVERRIDE]: '0' }), /^Blocked/);
});

test('a call that names another repository answers to no rule here', (t) => {
  const run = project(t, WITH_PATTERNS, {}, 'https://github.com/acme/notes.git');
  for (const command of [
    `gh issue comment 3 -R other/repo --body '${BAD}'`,
    `gh -R other/repo pr create --title '${BAD}' --body '${BAD}'`,
    `gh issue comment https://github.com/other/repo/issues/3 --body '${BAD}'`,
    `gh issue edit https://github.com/other/repo/issues/3 --body '${BAD}'`,
    `gh pr comment https://github.com/other/repo/pull/3 --body '${BAD}'`,
    `GH_REPO=other/repo gh issue comment 3 --body '${BAD}'`,
  ]) assert.equal(run(command), null, command);
  for (const command of [`gh issue comment 3 -R acme/notes --body '${BAD}'`, `gh issue comment https://github.com/acme/notes/issues/3 --body '${BAD}'`, `gh issue comment 3 --body '${BAD}'`]) {
    assert.match(run(command) ?? '', /^Blocked: the body matches/, command);
  }
});

test('a body the rule cannot read is refused, with the two steps that pass', (t) => {
  const run = project(t);
  for (const command of ['gh issue comment 3 --body "$UNREAD"', 'gh pr edit 3 --body "$(date)"', 'gh issue create --title x --body-file gone.md', 'gh pr comment 3 --body-file -', 'gh issue create --title x --body-file "$FILE"']) {
    assert.match(run(command) ?? '', /^Blocked: the body is one this rule cannot read/, command);
  }
  const comment = run('gh pr comment 3 --body "$UNREAD"');
  assert.match(comment, /1\. write the body to `.*comment-body-<branch>\.md`/);
  assert.match(comment, /2\. run `gh pr comment 3 --body-file /);
  assert.doesNotMatch(comment, /pr-write/, 'that skill writes a pull request body, not a comment');
  assert.match(run('gh issue create --title x --body "$UNREAD"'), /`.*issue-body-<branch>\.md`/);
  assert.match(run('gh pr edit 3 --body "$UNREAD"'), /`.*pr-body-<branch>\.md`.*the pr-write skill/su);
});

test('with no body flag, text from elsewhere is refused, and only a call that posts none passes', (t) => {
  const run = project(t);
  for (const command of ['gh issue create --title x', 'gh issue comment 3', 'gh issue comment 3 --editor', 'gh pr comment 3', 'gh pr create --fill', 'gh pr create --title x --template t.md']) {
    assert.match(run(command) ?? '', /has no --body or --body-file/, command);
  }
  for (const command of ['gh issue create --web', 'gh pr comment 3 --web', 'gh pr create --help', 'gh pr create --title x --body y --dry-run', 'gh issue comment 3 --delete-last', 'gh pr edit 3 --add-label x', 'gh issue view 3', 'gh pr view 3', 'gh issue list']) {
    assert.equal(run(command), null, command);
  }
});

test('an invalid pattern is reported by aidrian check, and never thrown in the hook', (t) => {
  const run = project(t, { version: 1, github: { requiredSections: [], publicText: { patterns: ['(unclosed'] } } });
  const read = loadConfig(findProject(run.dir));
  assert.match(read.errors.join('\n'), /"github\.publicText\.patterns" must be a list of valid regular expressions as strings/);
  assert.deepEqual(read.config.github.publicText.patterns, []);
  assert.equal(run(`gh issue comment 3 --body '${BAD}'`), null);
  for (const patterns of ['\\bword\\b', [''], [1]]) {
    assert.match(loadConfig(findProject(project(t, { version: 1, github: { publicText: { patterns } } }).dir)).errors.join('\n'), /publicText\.patterns/, JSON.stringify(patterns));
  }

  const checked = spawnSync(path.join(ROOT, 'plugins/aidrian/bin/aidrian'), ['check'], { cwd: run.dir, encoding: 'utf8', env: clean(t) });
  assert.notEqual(checked.status, 0);
  assert.match(checked.stderr, /"github\.publicText\.patterns" must be/);
});

test('the Bash hook runs the rule and records it as public-text', (t) => {
  const run = project(t);
  const env = clean(t);
  const hook = spawnSync(process.execPath, [path.join(ROOT, 'plugins/aidrian/scripts/hook-bash.mjs')], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: `gh issue comment 3 --body '${BAD}'` }, cwd: run.dir, session_id: 'public-text-test' }),
    encoding: 'utf8',
    env,
  });
  assert.equal(hook.status, 2);
  assert.match(hook.stderr, /^Blocked: the body matches the config\.json `github\.publicText\.patterns` pattern/);
  const state = spawnSync(path.join(ROOT, 'plugins/aidrian/bin/aidrian'), ['state'], { cwd: run.dir, encoding: 'utf8', env }).stdout.trim();
  const rows = readFileSync(path.join(state, 'dispatch-log.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const row = rows.find((each) => each.event === 'hook_deny');
  assert.equal(row.rule, 'public-text');
  assert.doesNotMatch(JSON.stringify(row), /Placeholder Word/, 'the row never holds the text');
});

// The private words file, with placeholder words only. `NO_PATTERNS` leaves the file as the only source.
const NO_PATTERNS = { version: 1, github: { requiredSections: [] } };
const PRIVATE_PATTERN = 'privateplaceholder-\\d+';
const PRIVATE_FILE = `# a comment\n\n${PRIVATE_PATTERN}\n`;
const PRIVATE_TEXT = 'leading PrivatePlaceholder-7 trailing';
const FILE = '.banned-terms.local';
const assertNothingPrivate = (text) => {
  for (const leak of [/privateplaceholder/iu, /leading/u, /trailing/u, /\\d/u]) assert.doesNotMatch(text, leak);
};

test('the private words file alone turns the rule on, and says which of body or title matched', (t) => {
  const run = project(t, NO_PATTERNS, { [FILE]: PRIVATE_FILE });
  const body = run(`gh issue comment 3 --body '${PRIVATE_TEXT}'`);
  assert.match(body, /^Blocked: a private word from `\.banned-terms\.local` matched in the body\. The first hit is on line 1 of the body: reword it/);
  assertNothingPrivate(body);
  const title = run(`gh pr create --title '${PRIVATE_TEXT}' --body fine`);
  assert.match(title, /^Blocked: a private word from `\.banned-terms\.local` matched in the title\. The first hit is on line 1 of the title: reword it/);
  assertNothingPrivate(title);
  assert.equal(run(`gh issue comment 3 --body '${GOOD}'`), null);
  assert.match(run('gh issue comment 3 --body "$UNREAD"'), /^Blocked: the body is one this rule cannot read/, 'an active rule refuses what it cannot read');
  assert.equal(run(`gh issue comment 3 --body '${PRIVATE_TEXT}'`, { [OVERRIDE]: '1' }), null);
});

test('a file with no usable pattern leaves the rule off, with no refusal', (t) => {
  for (const text of ['', '# only a comment\n\n', '(unclosed\n']) {
    const run = project(t, NO_PATTERNS, { [FILE]: text });
    assert.equal(run('gh issue comment 3 --body "$UNREAD"'), null, JSON.stringify(text));
    assert.equal(run('gh issue create --title x'), null, JSON.stringify(text));
  }
});

test('a bad line drops only itself: other lines and the config patterns still hold', (t) => {
  const run = project(t, WITH_PATTERNS, { [FILE]: `(unclosed\n${PRIVATE_PATTERN}\n[also bad\n` });
  assert.match(run(`gh issue comment 3 --body '${PRIVATE_TEXT}'`), /^Blocked: a private word/);
  assert.match(run(`gh issue comment 3 --body '${BAD}'`), /^Blocked: the body matches the config\.json/);
  assert.equal(run(`gh issue comment 3 --body '${GOOD}'`), null);
});

test("this repository's git hooks still stop on a bad line, so a word cannot slip out unnoticed", (t) => {
  const run = project(t, NO_PATTERNS, { [FILE]: '(unclosed\n' });
  assert.throws(() => bannedPatterns(run.dir), SyntaxError);
});

test('private words hold on a call naming another repository; config patterns and unread text follow the target', (t) => {
  const run = project(t, WITH_PATTERNS, { [FILE]: PRIVATE_FILE }, 'https://github.com/acme/notes.git');
  for (const command of [`gh issue comment 3 -R other/repo --body '${PRIVATE_TEXT}'`, `gh issue comment https://github.com/other/repo/issues/3 --body '${PRIVATE_TEXT}'`,
    `GH_REPO=other/repo gh pr create --title '${PRIVATE_TEXT}' --body x`, `gh issue comment 3 -R acme/notes --body '${PRIVATE_TEXT}'`]) {
    assert.match(run(command) ?? '', /^Blocked: a private word/, command);
  }
  assert.equal(run(`gh issue comment 3 -R other/repo --body '${BAD}'`), null, 'a config pattern follows the target');
  assert.equal(run('gh issue comment 3 -R other/repo --body "$UNREAD"'), null, 'so does unread text');
  assert.equal(run('gh issue create -R other/repo --title x'), null);
});

test("a linked worktree reads the main checkout's file, and its own beside it", (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-publictext-wt-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = clean(t);
  const main = path.join(dir, 'main');
  const tree = path.join(dir, 'tree');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: main, env, stdio: 'ignore' });
  execFileSync('git', ['init', '-q', main], { env });
  mkdirSync(path.join(main, '.aidrian'));
  writeFileSync(path.join(main, '.aidrian/config.json'), JSON.stringify(NO_PATTERNS));
  git('add', '.aidrian/config.json');
  git('commit', '-q', '-m', 'init');
  git('worktree', 'add', '-q', tree);
  const run = (command, cwd = tree) => check(command, { cwd, env: {} });
  assert.equal(run(`gh issue comment 3 --body '${PRIVATE_TEXT}'`), null, 'no file anywhere');
  writeFileSync(path.join(main, FILE), PRIVATE_FILE);
  assert.match(run(`gh issue comment 3 --body '${PRIVATE_TEXT}'`), /^Blocked: a private word/, "the main checkout's file");
  writeFileSync(path.join(tree, FILE), 'otherplaceholder\n');
  assert.match(run("gh issue comment 3 --body 'an OtherPlaceholder here'"), /^Blocked: a private word/, 'its own copy');
  assert.match(run(`gh issue comment 3 --body '${PRIVATE_TEXT}'`), /^Blocked: a private word/, 'and still the main checkout\'s');
  assert.equal(run("gh issue comment 3 --body 'an OtherPlaceholder here'", main), null, 'the main checkout does not read a worktree\'s copy');
});

test('the Bash hook records a hit from the file with neither the word nor its pattern', (t) => {
  const run = project(t, NO_PATTERNS, { [FILE]: PRIVATE_FILE });
  const env = clean(t);
  const hook = spawnSync(process.execPath, [path.join(ROOT, 'plugins/aidrian/scripts/hook-bash.mjs')], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: `gh issue comment 3 --body '${PRIVATE_TEXT}'` }, cwd: run.dir, session_id: 'public-text-private' }),
    encoding: 'utf8',
    env,
  });
  assert.equal(hook.status, 2);
  assertNothingPrivate(hook.stderr);
  const state = spawnSync(path.join(ROOT, 'plugins/aidrian/bin/aidrian'), ['state'], { cwd: run.dir, encoding: 'utf8', env }).stdout.trim();
  const log = readFileSync(path.join(state, 'dispatch-log.jsonl'), 'utf8');
  assertNothingPrivate(log);
  const row = log.trim().split('\n').map((line) => JSON.parse(line)).find((each) => each.event === 'hook_deny');
  assert.equal(row.rule, 'public-text');
  assert.match(row.reason, /private word from `\.banned-terms\.local` matched in the body/);
});

// Bare words the merge guard and other rules would read as commands stay inside strings: these run only through check().
const OTHER = 'https://github.com/other/repo';

test('a target counts as another repository only as a URL of its kind, with scheme and host', (t) => {
  const run = project(t, WITH_PATTERNS, {}, 'https://github.com/acme/notes.git');
  for (const command of [
    `gh pr edit ${OTHER}/pull/3 --body '${BAD}'`,
    `gh pr close ${OTHER}/pull/3 --comment '${BAD}'`,
    `gh pr reopen ${OTHER}/pull/3 --comment '${BAD}'`,
    `gh pr merge ${OTHER}/pull/3 --body '${BAD}'`,
    `gh pr comment ${OTHER}/pull/3 --body '${BAD}'`,
    `gh pr comment ${OTHER}/issues/3 --body '${BAD}'`,
    `gh issue edit ${OTHER}/issues/3 --body '${BAD}'`,
    `gh issue close ${OTHER}/issues/3 --comment '${BAD}'`,
  ]) assert.equal(run(command), null, command);
  for (const command of [
    `gh pr edit ${OTHER}/issues/3 --body '${BAD}'`,
    `gh pr merge ${OTHER}/issues/3 --body '${BAD}'`,
    `gh pr close ${OTHER}/issues/3 --comment '${BAD}'`,
    `gh pr edit other/repo/pull/3 --body '${BAD}'`,
    `gh pr edit github.com/other/repo/pull/3 --body '${BAD}'`,
    `gh pr comment team/pull/3 --body '${BAD}'`,
    `gh pr comment team/issues/3 --body '${BAD}'`,
  ]) assert.match(run(command) ?? '', /^Blocked: the \w+ matches/, command);
});

test('close, reopen, and merge text is read, and each posts none unless given it', (t) => {
  const run = project(t, WITH_PATTERNS, { 'bad.md': BAD });
  for (const command of [
    `gh issue close 3 --comment '${BAD}'`, `gh issue close 3 -c '${BAD}'`, `gh issue reopen 3 --comment='${BAD}'`, `gh pr close 3 -c '${BAD}'`, `gh pr reopen 3 -c '${BAD}'`,
    `gh issue close 3 --comment "$(cat <<'EOF'\n${BAD}\nEOF\n)"`,
  ]) assert.match(run(command) ?? '', /^Blocked: the comment matches/, command);
  for (const command of [`gh pr merge 3 --body '${BAD}'`, `gh pr merge 3 -b '${BAD}'`, 'gh pr merge 3 -F bad.md', `gh pr merge 3 --squash --body "$(cat <<'EOF'\n${BAD}\nEOF\n)"`]) {
    assert.match(run(command) ?? '', /^Blocked: the body matches/, command);
  }
  for (const command of [`gh pr merge 3 --subject '${BAD}'`, `gh pr merge 3 -t '${BAD}'`, `gh pr merge -s 3 -t '${BAD}'`, `gh pr merge 3 -m --subject '${BAD}'`, `gh pr merge 3 -sd --subject='${BAD}'`]) {
    assert.match(run(command) ?? '', /^Blocked: the subject matches/, command);
  }
  for (const command of ['gh issue close 3', 'gh issue reopen 3', 'gh pr close 3 -d', 'gh pr reopen 3', 'gh pr merge 3 --squash', 'gh pr merge 3 -m --auto', 'gh pr merge 3 --match-head-commit abc1234', `gh issue close 3 -r '${BAD}'`, `gh issue close 3 --reason '${BAD}'`]) {
    assert.equal(run(command), null, command);
  }
  const unread = run('gh issue close 3 --comment "$UNREAD"');
  assert.match(unread, /^Blocked: the comment is one this rule cannot read/);
  assert.match(unread, /2\. run `gh issue comment 3 --body-file .*comment-body-/u);
  assert.match(unread, /Then run `gh issue close 3` without --comment/);
  assert.match(run('gh pr merge 3 --body "$UNREAD"'), /`.*merge-body-<branch>\.md`/u);
  assert.match(run('gh pr merge 3 --subject "$UNREAD"'), /^Blocked: the subject is one this rule cannot read/);
});

test('the pull request body rule still reads only pr create and pr edit', (t) => {
  const dir = project(t, { version: 1 }).dir;
  for (const command of ['gh pr merge 3 --body x', 'gh pr close 3 --comment x', 'gh issue close 3 -c x', 'gh pr comment 3 --body x', 'gh issue create --title x --body y']) {
    assert.equal(prBody(command, { cwd: dir, env: {} }), null, command);
  }
  assert.match(prBody('gh pr edit 3 --body x', { cwd: dir, env: {} }), /^Blocked: the body has no/);
});

test('whitespace runs count as one space, so a wrapped phrase matches, in config patterns and private lines', (t) => {
  const run = project(t, { version: 1, github: { requiredSections: [], publicText: { patterns: ['second (form|shape)'] } } }, { [FILE]: 'two private words\n', 'wrapped.md': 'a second\n   shape here\n' });
  assert.match(run('gh issue comment 3 -F wrapped.md'), /^Blocked: the body matches/);
  assert.match(run("gh issue comment 3 --body 'a second\t\tform'"), /^Blocked: the body matches/);
  assert.match(run("gh issue comment 3 --body 'two\n  private\r\n words'"), /^Blocked: a private word/);
  assert.match(run("gh issue create --body x --title 'two   private  words'"), /^Blocked: a private word from `\.banned-terms\.local` matched in the title/);
  assert.equal(run("gh issue comment 3 --body 'two different words'"), null);
});

test('a device or a pipe is no body: the hook refuses it, fed through a real pipe', (t) => {
  const run = project(t);
  const env = clean(t);
  execFileSync('mkfifo', [path.join(run.dir, 'fifo')]);
  const hookThroughPipe = (command) => spawnSync('sh', ['-c', 'printf %s "$HOOK_INPUT" | "$NODE" "$HOOK"'], {
    encoding: 'utf8',
    timeout: 15000,
    env: { ...env, NODE: process.execPath, HOOK: path.join(ROOT, 'plugins/aidrian/scripts/hook-bash.mjs'), HOOK_INPUT: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: run.dir, session_id: 'public-text-pipe' }) },
  });
  for (const command of ['gh issue comment 3 --body-file /dev/stdin', 'gh issue comment 3 --body-file fifo', 'cp fifo made.md && gh issue comment 3 --body-file made.md']) {
    const hook = hookThroughPipe(command);
    assert.equal(hook.status, 2, command);
    assert.match(hook.stderr, /^Blocked: the body is one this rule cannot read/, command);
  }
});

test('the value of a gh issue option is never read as the target', (t) => {
  const run = project(t, WITH_PATTERNS, {}, 'https://github.com/acme/notes.git');
  const options = ['--type', '--parent', '--blocked-by', '--blocking', '--add-blocked-by', '--add-blocking', '--remove-blocked-by', '--remove-blocking', '--add-sub-issue', '--remove-sub-issue'];
  for (const option of options) {
    const command = `gh issue edit ${option} ${OTHER}/issues/9 3 --body`;
    assert.match(run(`${command} '${BAD}'`) ?? '', /^Blocked: the body matches/, 'a URL value is no target');
    assert.match(run(`${command} "$UNREAD"`) ?? '', /2\. run `gh issue edit 3 --body-file /u, 'the advice names the issue');
  }
});

test('--fill with no title is refused as unread text', (t) => {
  const run = project(t);
  for (const command of ['gh pr create --fill --body x', 'gh pr create -f -b x', 'gh pr create --fill-first --body x']) {
    assert.match(run(command) ?? '', /^Blocked: `--fill` with no --title takes the title from the commit messages/, command);
  }
  assert.equal(run('gh pr create --fill --title x --body y'), null);
  assert.equal(run('gh pr create --fill --web'), null, 'a person posts from the browser');
});

test('attachments: alone they are refused as no body, and with a body their alt text is the stated limit', (t) => {
  const run = project(t);
  assert.match(run("gh pr comment 3 --attach './x.png#alt'"), /has no --body or --body-file/);
  assert.equal(run(`gh pr comment 3 --body '${GOOD}' --attach './x.png#${BAD}'`), null);
});

test('the private deny keeps its first sentence, names the line of the first hit, and says not to open the file', (t) => {
  const run = project(t, NO_PATTERNS, { [FILE]: PRIVATE_FILE });
  const reason = run(`gh issue comment 3 --body 'first line\nsecond line\n\n${PRIVATE_TEXT}'`);
  assert.match(reason, /^Blocked: a private word from `\.banned-terms\.local` matched in the body\. The first hit is on line 4 of the body: reword it/);
  assert.match(reason, /do not open `\.banned-terms\.local`/);
  assertNothingPrivate(reason);
  assert.match(run(`gh issue close 3 --comment '${PRIVATE_TEXT}'`), /matched in the comment\. The first hit is on line 1 of the comment/);
  assert.match(run(`gh pr merge 3 --subject '${PRIVATE_TEXT}'`), /matched in the subject\./);
});

test('a long config pattern is cut in the deny', (t) => {
  const long = `placeholder${'x?'.repeat(60)}`;
  const reason = project(t, { version: 1, github: { requiredSections: [], publicText: { patterns: [long] } } })("gh issue comment 3 --body 'a placeholder here'");
  const shown = /pattern `([^`]*)`/u.exec(reason)[1];
  assert.equal(shown.length, 80);
  assert.ok(shown.endsWith('…'));
});

test('a heredoc of another command never stands in for an unread body', (t) => {
  const run = project(t);
  const otherSubstitution = `python3 -c "$(cat <<'EOF'\nprint(1)\nEOF\n)" && gh issue comment 3 --body "$UNREAD"`;
  assert.match(run(otherSubstitution), /^Blocked: the body is one this rule cannot read/);
  const otherGh = `gh pr review 3 --comment -b "$(cat <<'EOF'\nfine\nEOF\n)" && gh issue close 3 --comment "$UNREAD"`;
  assert.match(run(otherGh), /^Blocked: the comment is one this rule cannot read/);
  assert.match(run(`python3 -c "$(cat <<'EOF'\nprint(1)\nEOF\n)" && gh issue comment 3 --body "$(cat <<'EOF'\n${BAD}\nEOF\n)"`), /^Blocked: the body matches/, 'its own heredoc is read');
  assert.equal(run(`gh issue comment 3 --body "$(cat <<'EOF'\n${GOOD}\nEOF\n)" && gh pr comment 4 --body "$(cat <<'EOF'\n${GOOD}\nEOF\n)"`), null, 'each call its own');
});

test('a target URL names the repository before -R does', (t) => {
  const run = project(t, WITH_PATTERNS, {}, 'https://github.com/acme/notes.git');
  assert.equal(run(`gh pr edit https://github.com/other/repo/pull/3 -R acme/notes --body '${BAD}'`), null);
  assert.match(run(`gh issue comment https://github.com/acme/notes/issues/3 -R other/repo --body '${BAD}'`) ?? '', /^Blocked: the body matches/);
});

// A pattern that takes far longer than the budget on this text: a nested repeat with no match at the end.
const SLOW = '(a+)+$';
const SLOW_TEXT = `${'a'.repeat(40)}!`;

test('a pattern that runs out of time is dropped, and the others still run within the budget', (t) => {
  const run = project(t, { version: 1, github: { requiredSections: [], publicText: { patterns: [SLOW, 'placeholder'] } } }, { [FILE]: `${SLOW}\n${PRIVATE_PATTERN}\n` });
  const timed = (command) => {
    const start = performance.now();
    const reason = run(command);
    return [reason, performance.now() - start];
  };
  const [clean, cleanMs] = timed(`gh issue comment 3 --body '${SLOW_TEXT}'`);
  assert.equal(clean, null);
  assert.ok(cleanMs < 1500, `took ${cleanMs} ms`);
  assert.match(timed(`gh issue comment 3 --body '${SLOW_TEXT} PrivatePlaceholder-1'`)[0], /^Blocked: a private word/);
  assert.match(timed(`gh issue comment 3 --body '${SLOW_TEXT} placeholder'`)[0], /^Blocked: the body matches the config\.json `github\.publicText\.patterns` pattern `placeholder`/);
});

// What a project folder keeps out of git, the private file included.
const IGNORED = `.aidrian.local.json\n.worktrees/\n${FILE}\n`;

// A main checkout whose guard is on, with a tracked file a later rule refuses to let a command write.
function guardedProject(t, files) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-publictext-guard-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = clean(t);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, env, stdio: 'ignore' });
  git('init', '-q');
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, git: { mainCheckout: { guard: true } }, github: { requiredSections: [], publicText: { patterns: [SLOW] } } }));
  writeFileSync(path.join(dir, '.gitignore'), `${IGNORED}\n`);
  writeFileSync(path.join(dir, 'app.js'), 'x\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  files(dir);
  return { dir, env };
}

const hookRun = (dir, env, command) => {
  const start = performance.now();
  const result = spawnSync(process.execPath, [path.join(ROOT, 'plugins/aidrian/scripts/hook-bash.mjs')], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: dir, session_id: 'public-text-later' }), encoding: 'utf8', env, timeout: 15000,
  });
  return { ...result, ms: performance.now() - start };
};

test('with a pipe for the private file and a slow pattern, the last rule still refuses, inside the hook time', (t) => {
  const { dir, env } = guardedProject(t, (root) => execFileSync('mkfifo', [path.join(root, FILE)]));
  const hook = hookRun(dir, env, `gh issue comment 3 --body '${SLOW_TEXT}' && echo y > app.js`);
  assert.equal(hook.status, 2, hook.stderr);
  assert.match(hook.stderr, /^Blocked: this command writes 'app\.js', a tracked file in the main checkout/);
  assert.ok(hook.ms < 5000, `took ${hook.ms} ms`);
});

test('a link to a regular private file is read', (t) => {
  const { dir, env } = guardedProject(t, (root) => {
    writeFileSync(path.join(root, 'words.txt'), `${PRIVATE_PATTERN}\n`);
    symlinkSync(path.join(root, 'words.txt'), path.join(root, FILE));
  });
  assert.match(hookRun(dir, env, `gh issue comment 3 --body '${PRIVATE_TEXT}'`).stderr, /^Blocked: a private word/);
});

test('aidrian check reports a private file git would track, and bad lines by number, never their text', (t) => {
  const aidrian = (dir, env) => spawnSync(path.join(ROOT, 'plugins/aidrian/bin/aidrian'), ['check'], { cwd: dir, encoding: 'utf8', env });
  const { dir, env } = guardedProject(t, (root) => writeFileSync(path.join(root, FILE), `# note\n${PRIVATE_PATTERN}\n(unclosed privateplaceholder\n\n[bad\n`));
  const bad = aidrian(dir, env);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /\.banned-terms\.local: lines 3, 5 do not compile, so the rules skip them/);
  assertNothingPrivate(bad.stderr + bad.stdout);
  writeFileSync(path.join(dir, FILE), `${PRIVATE_PATTERN}\n`);
  assert.equal(aidrian(dir, env).status, 0, aidrian(dir, env).stderr);
  writeFileSync(path.join(dir, '.gitignore'), IGNORED.replace(`${FILE}\n`, ''));
  const unignored = aidrian(dir, env);
  assert.notEqual(unignored.status, 0);
  assert.match(unignored.stderr, /\.banned-terms\.local is tracked or not git-ignored, so its words could be published: add the line "\.banned-terms\.local" to \.gitignore/);
  assertNothingPrivate(unignored.stderr + unignored.stdout);
});
