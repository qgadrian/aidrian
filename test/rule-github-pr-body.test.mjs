import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { check, OVERRIDE } from '../plugins/aidrian/lib/rules/github/pr-body.mjs';

const GOOD = '## Summary\nShare links expire.\n\n## Tests run\n- `npm test`: pass\n';

// A project folder with `config`, and a body file per entry of `files`.
function project(t, config = { version: 1 }, files = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-prbody-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify(config));
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
  return (command, env = {}) => check(command, { cwd: dir, env });
}

const heredoc = (body) => `gh pr create --draft --title "[NOISSUE] feat: x" --body "$(cat <<'EOF'\n${body}EOF\n)"`;

test('a body with every required section passes, in each way gh takes one', (t) => {
  const run = project(t, { version: 1 }, { 'body.md': GOOD });
  assert.equal(run(heredoc(GOOD)), null);
  assert.equal(run(heredoc(GOOD.replace('Share links expire.', 'It says "done" (finally).'))), null, 'quotes and parentheses in the heredoc');
  assert.equal(run(`gh pr create --title x --body '${GOOD}'`), null);
  assert.equal(run('gh pr create -t x -F body.md'), null);
  assert.equal(run(`gh -R acme/notes pr edit 3 --body='${GOOD}'`), null);
  assert.equal(run('gh pr create --title x --body-file=body.md'), null);
});

test('a short option reads as gh reads it: its value attached, or after a cluster of switches', (t) => {
  const run = project(t, { version: 1 }, { 'body.md': GOOD, 'short.md': '## Summary\nonly this\n' });
  for (const command of ['gh pr create -Fshort.md', 'gh pr create -F=short.md', 'gh pr create -dF short.md', `gh pr create -b'## Summary'`]) {
    assert.match(run(command), /^Blocked: the body has no `## Tests run` section/, command);
  }
  const attached = `gh pr create -t x -b"$(cat <<'EOF'\n## Summary\nEOF\n)"`;
  assert.match(run(attached), /^Blocked: the body has no `## Tests run` section/, 'a heredoc attached to -b');
  assert.match(run(attached.replace('-b"', '-db "')), /^Blocked: the body has no `## Tests run` section/, 'and after a cluster');
  assert.match(run('gh pr create -df'), /^Blocked: `--fill`/, '-f in a cluster');
  assert.equal(run('gh pr create -dFbody.md'), null);
  assert.equal(run('gh pr create -tF -F body.md'), null, 'the F of -tF is the title');
});

test('a missing required section is denied, naming it and the config key', (t) => {
  const run = project(t, { version: 1 }, { 'short.md': '## Summary\nonly this\n' });
  const reason = run('gh pr create --title x --body-file short.md');
  assert.match(reason, /^Blocked: the body has no `## Tests run` section\. config\.json `github\.requiredSections` lists the sections every body has: Summary, Tests run\./);
  assert.match(reason, new RegExp(`set ${OVERRIDE}=1 in your own shell`));
  assert.match(run(heredoc('### Summary\n## Tests\n')), /no `## Summary`, `## Tests run` section/, 'only a `## ` heading with the exact name counts');
  assert.equal(run(heredoc('## summary\n##  Tests run  \n')), null, 'case and spacing do not matter');
});

test('the sections come from config.json, and an empty list checks none', (t) => {
  assert.match(project(t, { version: 1, github: { requiredSections: ['Why', 'Risk'] } })(heredoc(GOOD)), /no `## Why`, `## Risk` section/);
  assert.equal(project(t, { version: 1, github: { requiredSections: [] } })(heredoc('anything\n')), null);
});

test('the Claude Code footer and --fill are denied', (t) => {
  const run = project(t);
  assert.match(run(heredoc(`${GOOD}\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n`)), /^Blocked: the body carries the "Generated with \[Claude Code\]" footer/);
  for (const fill of ['--fill', '--fill-first', '--fill-verbose', '-f']) {
    assert.match(run(`gh pr create --draft ${fill}`), /^Blocked: `--fill` writes the body from the commit messages/, fill);
  }
  assert.match(run('git push -u origin HEAD && gh pr create --fill'), /--fill/, 'in a compound command');
});

test('a gh call inside a substitution that runs is judged as at the top level', (t) => {
  const run = project(t, { version: 1 }, { 'short.md': '## Summary\nonly this\n', 'body.md': GOOD });
  assert.match(run('url=$(gh pr create --title x --body-file short.md)'), /^Blocked: the body has no `## Tests run` section/);
  assert.match(run('echo "`gh pr create --fill`"'), /--fill/);
  assert.equal(run('url=$(gh pr create --title x --body-file body.md)'), null);
  assert.equal(run(`url=$(${heredoc(GOOD)})`), null, 'the heredoc body is read from the substitution`s own line');
  assert.equal(run("echo '$(gh pr create --fill)'"), null);
});

test('what the rule cannot read, gh pr edit without a body, other commands, and quoted text pass', (t) => {
  const run = project(t);
  for (const command of [
    'gh pr create --title x --body "$BODY"',
    'gh pr create --title x --body-file -',
    'gh pr create --title x --body-file missing.md',
    'gh pr edit 3 --add-label ready',
    'gh pr edit 3 --title "new title"',
    'gh pr view 3 --json body',
    'gh issue create --body "no sections"',
    'echo "gh pr create --fill"',
    "git commit -m 'gh pr create --fill'",
  ]) {
    assert.equal(run(command), null, command);
  }
  assert.equal(run('gh pr create --fill', { [OVERRIDE]: '1' }), null, 'the override');
});

test('a non-web gh pr create with no body flag is denied when sections are configured', (t) => {
  const run = project(t);
  for (const command of ['gh pr create --title x', 'gh pr create -t x -d', 'gh pr create --title x --editor', 'gh pr create -T bug.md', 'url=$(gh pr create --title x)',
    'gh pr create --title x --web=false', 'gh pr create --title x --help=false', 'gh pr create --web --web=false', 'gh pr create -t x -- --web', 'gh pr create -tw',
    'gh pr create -t x -w=0', 'gh pr create -t x -w=F', 'gh pr create -t x -dw=false', 'gh pr create -t x -h=false']) {
    assert.match(run(command), /^Blocked: `gh pr create` has no --body or --body-file.*pass --body-file/, command);
  }
  for (const command of ['gh pr create --web', 'gh pr create -w --title x', 'gh pr create -dw', 'gh pr create --help', 'gh pr create -h', 'gh pr create --web=true', 'gh pr create -w=true',
    'gh --help pr create', 'gh pr --help create', 'gh -h pr create', 'gh pr edit 3 --title y']) {
    assert.equal(run(command), null, command);
  }
  assert.match(project(t, { version: 1, github: { requiredSections: [], pullRequest: { sections: ['Summary'] } } })('gh pr create -t x'), /no --body or --body-file/, 'a closed section list');
  assert.equal(project(t, { version: 1, github: { requiredSections: [] } })('gh pr create --title x'), null, 'no sections configured');
  assert.match(run('gh pr create -bh'), /no `## Summary`/, 'h in -bh is the body, read and checked');
});

test('outside a project folder nothing is checked', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-prbody-none-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(check('gh pr create --fill', { cwd: dir, env: {} }), null);
});
