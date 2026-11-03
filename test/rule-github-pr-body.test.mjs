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
  const footer = heredoc(`${GOOD}\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n`);
  assert.match(run(footer), /footer\. Drop that line: this project's rule takes precedence over the host's attribution instructions that ask for it\. Claude Code's setting `"attribution": \{ "pr": "" \}` in `\.claude\/settings\.json` stops the host from asking\.\n/);
  const attributed = project(t, { version: 1, attribution: { pullRequest: ['tool', 'model'] } });
  assert.match(attributed(footer), /ask for it\. The lines config\.json `attribution\.pullRequest` asks for, which the attribution rule prints, take its place\. Claude Code's/);
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
    'gh pr create -t x -w=0', 'gh pr create -t x -w=F', 'gh pr create -t x -dw=false', 'gh pr create -t x -h=false',
    'gh pr create -t x --web="$WEB"', 'gh pr create -t x -w="$WEB"']) {
    assert.match(run(command), /^Blocked: `gh pr create` has no --body or --body-file.*2\. run `gh pr create --body-file /, command);
  }
  for (const command of ['gh pr create --web', 'gh pr create -w --title x', 'gh pr create -dw', 'gh pr create --help', 'gh pr create -h', 'gh pr create --web=true', 'gh pr create -w=true',
    'gh --help pr create', 'gh pr --help create', 'gh -h pr create', 'gh pr edit 3 --title y']) {
    assert.equal(run(command), null, command);
  }
  assert.match(project(t, { version: 1, github: { requiredSections: [], pullRequest: { sections: ['Summary'] } } })('gh pr create -t x'), /no --body or --body-file/, 'a closed section list');
  assert.equal(project(t, { version: 1, github: { requiredSections: [] } })('gh pr create --title x'), null, 'no sections configured');
  for (const command of ['gh pr create -t x --body bad --help="$HELP"', 'gh pr create -t x --body bad -h="$HELP"']) {
    assert.match(run(command), /^Blocked: the body has no/, `${command}: an unreadable --help is not help`);
  }
  assert.match(run('gh pr create -bh'), /no `## Summary`/, 'h in -bh is the body, read and checked');
});

test('a body the rule cannot read is denied when sections are configured', (t) => {
  const run = project(t);
  for (const command of [
    `gh pr create --title '[NOISSUE] fix: x' --body "$PR_BODY"`, 'gh pr create -t x --body "$(cat f)"', 'gh pr create -t x -b "$X"',
    'gh pr create -t x --body-file -', 'gh pr create -t x --body-file missing.md', 'gh pr create -t x -F "$F"', 'gh pr edit 3 --body "$B"',
  ]) {
    assert.match(run(command), /^Blocked: the body is one this rule cannot read: .* or a file that does not exist yet\. Do this instead: 1\. write the body to /, command);
  }
  assert.equal(project(t, { version: 1, github: { requiredSections: [] } })('gh pr create -t x --body "$B"'), null, 'no sections configured');
});

test('the unreadable body deny names the literal body path pr-write writes, for the branch gh runs on', (t) => {
  const run = project(t);
  const reason = run('gh pr create -t x -F "$(aidrian state)/tmp/pr-body.md"', { XDG_STATE_HOME: '/state' });
  assert.match(reason, /^Blocked: the body is one this rule cannot read/);
  assert.match(reason, /Do this instead: 1\. write the body to `\/state\/aidrian\/projects\/aidrian-prbody-[a-z0-9-]+\/tmp\/pr-body-<branch>\.md` \(`<branch>` is the branch name/);
  assert.match(reason, /2\. run `gh pr create --body-file \/state\/aidrian\/projects\/aidrian-prbody-[a-z0-9-]+\/tmp\/pr-body-<branch>\.md`, the path written out/);
  assert.match(reason, /Never pass the path through `\$\(…\)` or a variable/);
  assert.match(reason, /another command on this line edits, such as `sed -i` or a script, counts as not there yet: run gh as its own command after it/);
  assert.match(run('gh pr create -t x -H fix/a --body "$(cat f)"', { XDG_STATE_HOME: '/state' }), /\/tmp\/pr-body-fix-a\.md`/);
  assert.match(run('gh pr edit 12 --body "$B"', { XDG_STATE_HOME: '/state' }), /2\. run `gh pr edit 12 --body-file /, 'an edit keeps the pull request it names');
});

test('a body file the same command writes first, from a heredoc or a copy, is read as that command writes it', (t) => {
  const run = project(t, { version: 1 }, { 'draft.md': GOOD });
  const write = (file, body, delimiter = "'EOF'") => `cat > ${file} <<${delimiter}\n${body}EOF\n`;
  const create = (file) => `gh pr create --draft --title x --body-file ${file}`;
  // The shape the samples hold: mkdir, the heredoc write, then gh, in one command.
  assert.equal(run(`mkdir -p out && ${write('out/b.md', GOOD)}${create('out/b.md')}`), null, 'the file does not exist yet, and its heredoc is read');
  assert.match(run(`${write('b.md', '## Summary\nx\n')}${create('b.md')}`), /^Blocked: the body has no `## Tests run` section/, 'and checked');
  assert.match(run(`${write('b.md', `${GOOD}\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n`)}${create('b.md')}`), /footer/);
  assert.equal(run(`cat <<'EOF' > b.md\n${GOOD}EOF\n${create('b.md')}`), null, 'the redirect after the heredoc');
  assert.equal(run(`tee b.md >/dev/null <<'EOF'\n${GOOD}EOF\n${create('b.md')}`), null, 'tee');
  assert.equal(run(`${write('b.md', GOOD.replaceAll('`', ''), 'EOF')}${create('b.md')}`), null, 'a bare delimiter over a body bash leaves alone');
  assert.equal(run(`cp draft.md b.md && ${create('b.md')}`), null, 'a copy of a file the rule reads');
  assert.equal(run(`${write('a.md', GOOD)}cp -f a.md b.md; ${create('b.md')}`), null, 'a copy of a file the line wrote');
  assert.equal(run(`${write('b.md', GOOD)}gh pr edit 3 --body-file b.md`), null, 'an edit too');
  for (const [command, why] of [
    [`${write('b.md', 'has `$(date)`\n', 'EOF')}${create('b.md')}`, 'a bare delimiter over a body bash expands'],
    [`${write('b.md', GOOD)}sed -i '' 's/x/y/' b.md; ${create('b.md')}`, 'another command edits the file after'],
    [`${write('b.md', GOOD)}cat >> b.md <<'EOF'\nmore\nEOF\n${create('b.md')}`, 'an append'],
    [`${write('b.md', GOOD)}${create('other.md')}`, 'gh reads another file'],
    [`${create('b.md')} && ${write('b.md', GOOD)}`, 'the write comes after gh'],
    [`cp missing.md b.md && ${create('b.md')}`, 'a copy of a file the rule cannot read'],
    [`cd .. || true; ${write('b.md', GOOD)}${create('b.md')}`, 'a folder the rule cannot know'],
    [`sed -i '' 's/^## Testing$/## Tests run/' draft.md; ${create('draft.md')}`, 'a file on disk another command edits first'],
    [`python3 fix.py draft.md && ${create('draft.md')}`, 'a script that names it'],
    [`gh pr view 3 --json body -q .body > draft.md && ${create('draft.md')}`, 'a redirect from a reader still writes'],
  ]) {
    assert.match(run(command), /^Blocked: the body is one this rule cannot read/, why);
  }
  assert.equal(run(`${write('b.md', GOOD)}grep -c Summary b.md && wc -l b.md; ${create('b.md')}`), null, 'a reader leaves the file as written');
  assert.equal(run(`cat draft.md; ${create('draft.md')}`), null, 'and leaves a file on disk as it is');
});

test('a heredoc that another input or a later command can replace is never trusted', (t) => {
  const run = project(t, { version: 1 }, { 'bad.md': 'no sections\n' });
  const create = (file) => `gh pr create --draft --title x --body-file ${file}`;
  const write = (file, after = '') => `cat > ${file} <<'EOF'${after}\n${GOOD}EOF\n`;
  for (const [command, why] of [
    [`gh pr create -t x -F - <<'EOF' < bad.md\n${GOOD}EOF`, 'a < file after the heredoc gives gh its input'],
    [`gh pr create -t x -F - < bad.md <<'EOF'\n${GOOD}EOF`, 'and before it'],
    [`gh pr create -t x -F - <<'EOF' <<< bad\n${GOOD}EOF`, 'a here-string beside it'],
    [`${write('b.md', ' < bad.md')}${create('b.md')}`, 'cat writes the file, not the heredoc'],
    [`${write('b.md')}gh pr view 3 --json body -q .body > b.md; ${create('b.md')}`, 'a gh call rewrites the file'],
    [`${write('b.md')}gh pr create -t y -F b.md > b.md; gh pr edit 3 -F b.md`, 'a checked gh call writes its output over it'],
    [`${write('b.md')}python3 - <<'PY'\nopen('b.md', 'w').write('x')\nPY\n${create('b.md')}`, 'a script fed on stdin'],
    [`${write('b.md')}npm run fmt; ${create('b.md')}`, 'any program that is not a known reader'],
    [`${write('b.md')}git checkout -- .; ${create('b.md')}`, 'a git subcommand that writes work files'],
    [`${write('b.md')}echo x > "$OUT"; ${create('b.md')}`, 'a redirect to a file the rule cannot name'],
  ]) {
    assert.match(run(command) ?? '', /^Blocked: the body is one this rule cannot read/, why);
  }
  assert.equal(run(`${write('b.md')}git -C . push -q origin HEAD 2>&1 | tail -2; ${create('b.md')}`), null, 'git push and a reader leave it');
  const out = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-prbody-out-')));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const file = path.join(out, 'b.md');
  const anywhere = project(t, { version: 1, github: { pullRequest: { sharedTempBodyFile: false } } });
  // A real deny's shape: after a cd that is not leading, the folder is unknown, and `2>&1` must not poison the write.
  assert.equal(anywhere(`${write(file)}cd ${out} && gh auth status 2>&1 | head -3 && git push -q 2>&1 | tail -3 && ${create(file)}`), null,
    'a 2>&1 duplicates a descriptor and writes no file');
  assert.match(anywhere(`${write(file)}cd ${out} && gh auth status 2> err.txt; ${create(file)}`) ?? '', /cannot read/, 'a relative redirect in an unknown folder still does');
});

test('a redirection that names a descriptor is read as bash runs it, failing closed on any but stdin or stdout', (t) => {
  const run = project(t, { version: 1 }, { 'bad.md': 'no sections\n' });
  const create = (file) => `gh pr create --draft --title x --body-file ${file}`;
  for (const [command, why] of [
    [`gh pr create -t x -F - 3<<'EOF'\n${GOOD}EOF`, 'gh reads stdin, the heredoc feeds fd 3'],
    [`gh pr create -t x -F - {fd}<<'EOF'\n${GOOD}EOF`, 'a named descriptor'],
    [`gh pr create -t x -F - <<'EOF' 3<<'END'\n${GOOD}EOF\nx\nEND`, 'two heredocs'],
    [`gh pr create -t x -F - 0<&3 <<'EOF'\n${GOOD}EOF`, 'stdin moved from another descriptor'],
    [`cat 2> b.md <<'EOF'\n${GOOD}EOF\n${create('b.md')}`, 'cat writes stderr to the file, which stays empty'],
    [`cat 3> b.md <<'EOF'\n${GOOD}EOF\n${create('b.md')}`, 'a higher descriptor'],
    [`cat > b.md 3<<'EOF'\n${GOOD}EOF\n${create('b.md')}`, 'cat reads no heredoc on stdin'],
    [`cat 1>> b.md <<'EOF'\n${GOOD}EOF\n${create('b.md')}`, 'an append with fd 1'],
    [`cat &>> b.md <<'EOF'\n${GOOD}EOF\n${create('b.md')}`, 'an append of both streams'],
    [`cat > b.md 1>&2 <<'EOF'\n${GOOD}EOF\n${create('b.md')}`, 'stdout moved off the file after it'],
    [`cat > b.md >&2 <<'EOF'\n${GOOD}EOF\n${create('b.md')}`, 'and by >&2'],
    [`cat > b.md 2> b.md <<'EOF'\n${GOOD}EOF\n${create('b.md')}`, 'a second write to it'],
    [`tee b.md 4<<'EOF'\n${GOOD}EOF\n${create('b.md')}`, 'tee reads no heredoc on stdin'],
    [`tee b.md > b.md <<'EOF'\n${GOOD}EOF\n${create('b.md')}`, 'tee with its own output on the same file'],
    [`cat <<'EOF' |& tee b.md\n${GOOD}EOF\n${create('b.md')}`, 'tee fed through a pipe'],
  ]) {
    assert.match(run(command) ?? '', /^Blocked: the body is one this rule cannot read/, why);
  }
  for (const [command, why] of [
    [`gh pr create -t x -F - 0<<'EOF'\n${GOOD}EOF`, 'fd 0 is stdin'],
    [`cat 1> b.md <<'EOF'\n${GOOD}EOF\n${create('b.md')}`, 'fd 1 is stdout'],
    [`cat >| b.md 0<<'EOF'\n${GOOD}EOF\n${create('b.md')}`, '>| past noclobber'],
    [`cat &> b.md <<'EOF'\n${GOOD}EOF\n${create('b.md')}`, '&> writes stdout and an empty stderr'],
    [`cat >& b.md <<'EOF'\n${GOOD}EOF\n${create('b.md')}`, '>& file is &>'],
    [`tee b.md 2>/dev/null 0<<'EOF'\n${GOOD}EOF\n${create('b.md')}`, 'tee with stderr elsewhere'],
    [`cat 2>&1 > b.md <<'EOF'\n${GOOD}EOF\n${create('b.md')}`, 'stderr duplicated onto the old stdout, stdout to the file'],
    [`cat > b.md 2>&1 <<'EOF'\n${GOOD}EOF\n${create('b.md')}`, 'both streams to the file, stderr empty'],
  ]) {
    assert.equal(run(command), null, why);
  }
});

// bash truncates a redirect's target before gh reads it, whichever descriptor the redirect names.
test('a gh call that redirects any output onto its own body file has a body this rule cannot read', (t) => {
  const run = project(t, { version: 1 }, { 'good.md': GOOD });
  for (const redirect of ['> good.md', '>> good.md', '2>good.md', '{fd}>good.md']) {
    assert.match(run(`gh pr create -t x -F good.md ${redirect}`) ?? '', /^Blocked: the body is one this rule cannot read/, redirect);
  }
  assert.equal(run('gh pr create -t x -F good.md > out.log 2>&1'), null, 'a redirect onto another file');
  assert.equal(run('gh pr create -t x -F good.md 2>/dev/null'), null);
});

// bash passes a quoted '2' or '{fd}' before a redirect as the body, then redirects standard output.
test('a quoted word right before a redirect is the body, and the rule checks it', (t) => {
  const run = project(t);
  for (const command of [
    "gh pr edit 57 --body '2'> /dev/null",
    'gh pr edit 57 --body "2"> /dev/null',
    'gh pr edit 57 --body \\2> /dev/null',
    "gh pr edit 57 --body '{fd}'> /dev/null",
    'gh pr edit 57 --body "{fd}"> /dev/null',
    'gh pr edit 57 --body \\{fd\\}> /dev/null',
  ]) {
    assert.match(run(command) ?? '', /^Blocked: the body has no `## Summary`/u, command);
  }
  assert.equal(run('gh pr edit 57 --title x 2>/dev/null'), null, 'an unquoted 2> keeps its descriptor: a title-only edit');
  assert.equal(run('gh pr edit 57 --title x 2>&1'), null);
});

test('a variable a nested shell or substitution assigns is dropped, and a nested command resolves none', (t) => {
  const run = project(t, { version: 1 }, { 'bad.md': 'no sections\n', 'good.md': GOOD });
  assert.equal(run('F=good.md; gh pr create -t x -F "$F"'), null);
  for (const [command, why] of [
    [`F=bad.md; sh -c 'F=good.md'; gh pr create -t x -F "$F"`, 'sh -c sets its own F'],
    ['F=bad.md; x=$(F=good.md; echo); gh pr create -t x -F "$F"', 'a substitution sets its own F'],
    [`F=good.md; bash -c 'export F=bad.md'; gh pr create -t x -F "$F"`, 'an export inside a nested shell'],
    [`F=good.md; sh -c 'gh pr create -t x -F "$F"'`, 'the nested shell does not see the outer F'],
  ]) {
    assert.match(run(command) ?? '', /^Blocked: the body is one this rule cannot read/, why);
  }
});

test('a variable the line sets to a literal path names the body file', (t) => {
  const run = project(t, { version: 1 }, { 'draft.md': GOOD });
  const create = (file) => `gh pr create --draft --title x --body-file ${file}`;
  const write = (file) => `cat > ${file} <<'EOF'\n${GOOD}EOF\n`;
  assert.equal(run(`F=out.md; ${write('$F')}${create('"$F"')}`), null, 'set, written, and read through $F');
  assert.equal(run(`mkdir -p out && S=out; ${write('$S/b.md')}${create('${S}/b.md')}`), null, 'a folder variable with a literal tail');
  assert.equal(run(`export F=draft.md && ${create('$F')}`), null, 'export, and a file on disk');
  assert.equal(run(`D=out; F=$D/b.md; mkdir -p $D; ${write('$F')}${create('$F')}`), null, 'one variable built from another');
  assert.match(run(`F=out.md; sed -i '' s/a/b/ $F; ${create('$F')}`), /cannot read/, 'an edit through the variable');
  assert.match(run(`F=$(aidrian state)/b.md; ${write('$F')}${create('$F')}`), /cannot read/, 'a value this rule cannot know');
  assert.match(run(`${write('out.md')}${create('$F')}`), /cannot read/, 'a variable the line never sets');
  assert.match(run(`F=out.md; ${write('$F')}${create('$F$G')}`), /cannot read/, 'a word with more than one variable');
});

test('--body-file - reads the heredoc fed to gh itself', (t) => {
  const run = project(t);
  assert.equal(run(`gh pr create --draft --title x --body-file - <<'EOF'\n${GOOD}EOF`), null);
  assert.equal(run(`gh pr edit 3 -F - <<'EOF'\n${GOOD}EOF`), null, '-F');
  assert.match(run(`gh pr create -t x --body-file - <<'EOF'\n## Summary\nEOF`), /^Blocked: the body has no `## Tests run` section/);
  assert.match(run(`gh pr create -t x --body-file - <<'EOF'\n${GOOD}\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\nEOF`), /footer/);
  assert.match(run('gh pr create -t x --body-file - <<EOF\n$BODY\nEOF'), /cannot read/, 'a body bash expands');
  assert.match(run('cat b.md | gh pr create -t x --body-file -'), /cannot read/, 'a pipe');
});

test('outside a project folder nothing is checked', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-prbody-none-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(check('gh pr create --fill', { cwd: dir, env: {} }), null);
});

test('a cd earlier on the line moves where the body file and the project are read', (t) => {
  const run = project(t, { version: 1 }, { 'short.md': '## Summary\nx\n' });
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-prbody-wt-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1 }));
  writeFileSync(path.join(dir, 'short.md'), GOOD);
  assert.match(run('gh pr create --title x --body-file short.md'), /^Blocked: the body has no `## Tests run` section/);
  assert.equal(run(`cd ${dir} && gh pr create --title x --body-file short.md`), null, "the worktree's file, not the session's");
  writeFileSync(path.join(dir, 'short.md'), '## Summary\nx\n');
  assert.match(run(`cd ${dir} && gh pr create --title x --body-file short.md`), /^Blocked: the body has no `## Tests run` section/);
  assert.match(run(`cd "${dir}" && gh pr create --title x --body-file short.md`), /^Blocked: the body has no `## Tests run` section/, 'a quoted cd');
  for (const line of [`(cd ${dir}); gh`, `cd ${dir} | cat; gh`, `cd ${dir} || gh`, `cd ${dir}; gh`, `cd /tmp && cd ${dir} && gh`]) {
    assert.match(run(`${line} pr create --title x --body-file short.md`), /cannot read/, `${line}: the folder gh runs in is unknown`);
  }
  for (const moved of ['cd "$WT"', 'cd', 'cd -', 'cd ~/x', 'popd']) {
    assert.match(run(`${moved} && gh pr create --title x --body-file short.md`), /cannot read/, `${moved}: an unknown folder`);
  }
});

test('a directory change after gh leaves the folder gh ran in known', (t) => {
  const run = project(t, { version: 1 }, { 'body.md': GOOD });
  assert.equal(run('gh pr create --title x --body-file body.md && cd ..'), null);
  assert.match(run('cd .. || true; gh pr create --title x --body-file body.md'), /cannot read/);
});

test('a substitution or an inline shell runs gh in the folder of its command', (t) => {
  const run = project(t, { version: 1 }, { 'body.md': GOOD });
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-prbody-sub-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1 }));
  writeFileSync(path.join(dir, 'body.md'), '## Summary\nx\n');
  assert.equal(run('url=$(gh pr create --title x --body-file body.md)'), null);
  assert.match(run(`cd ${dir} && url=$(gh pr create --title x --body-file body.md)`), /^Blocked: the body has no `## Tests run` section/);
  assert.match(run(`cd ${dir} && bash -c 'gh pr create --title x --body-file body.md'`), /^Blocked: the body has no `## Tests run` section/);
});

test('two identical inline shells in different folders are each checked', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-prbody-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1 }));
  for (const [name, text] of [['good', GOOD], ['bad', 'no sections\n']]) {
    mkdirSync(path.join(dir, name));
    writeFileSync(path.join(dir, name, 'body.md'), text);
  }
  const run = (command) => check(command, { cwd: dir, env: {}, listOpenPrs: () => [] });
  const inline = (folder) => `env -C ${folder} sh -c 'gh pr create -t x -F body.md'`;
  assert.equal(run(inline('good')), null);
  assert.match(run(`${inline('good')} && ${inline('bad')}`) ?? '', /Blocked/);
});
