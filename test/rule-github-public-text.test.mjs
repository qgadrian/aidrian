import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { DEFAULTS } from '../plugins/aidrian/lib/config-defaults.mjs';
import { findProject } from '../plugins/aidrian/lib/project.mjs';
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
