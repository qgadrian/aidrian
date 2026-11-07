import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { check } from '../plugins/aidrian/lib/rules/product-feedback-post.mjs';

process.env.XDG_STATE_HOME = mkdtempSync(path.join(tmpdir(), 'aidrian-state-'));
after(() => rmSync(process.env.XDG_STATE_HOME, { recursive: true, force: true }));

const HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-bash.mjs');
const WRITTEN = new Date('2026-11-03T10:30:00.000Z');
const BEFORE = '2026-11-03T10:00:00.000Z';
const LATER = '2026-11-03T11:00:00.000Z';
const QUESTION = 'Pull request #7 comes from outside the team. Post this product feedback comment on #7?';

// A project, its state folder in it, with pull request 7's record when `limited` is given (undefined writes none, and
// 'missing' writes a record with no such field), the comment drafted in tmp at WRITTEN, and an empty transcript.
function project(t, { limited } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-post-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: 'state' } }));
  const folder = path.join(dir, 'state/product-feedback/acme/notes/pr-7');
  if (limited !== undefined) {
    mkdirSync(folder, { recursive: true });
    const record = { version: 1, pr: 7, repo: 'acme/notes', head: 'a'.repeat(40), ...(limited === 'missing' ? {} : { limited }), report: null, read_by: 'product-manager', comment_id: null, recorded_at: BEFORE, items: [] };
    writeFileSync(path.join(folder, 'record.json'), JSON.stringify(record));
  }
  const body = path.join(dir, 'state/tmp/product-feedback-7.md');
  mkdirSync(path.dirname(body), { recursive: true });
  writeFileSync(body, 'It is feedback, not an approval or a block.\n');
  utimesSync(body, WRITTEN, WRITTEN);
  const transcript = path.join(dir, 'session.jsonl');
  writeFileSync(transcript, '');
  const answer = (question, picked, at = LATER) => appendFileSync(transcript, `${JSON.stringify({ type: 'user', timestamp: at, toolUseResult: { answers: { [question]: picked } } })}\n`);
  const main = { transcript_path: transcript };
  const post = `aidrian pr product-feedback post 7 --body-file ${body}`;
  return { dir, body, transcript, answer, main, post, run: (command, input = main) => check(command, { cwd: dir, input, env: {} }) };
}

test('a limited record with no answer holds post, in the plain, runner, and shell-fed forms, and the deny names the Human\'s own shell', (t) => {
  const p = project(t, { limited: true });
  const forms = [
    p.post,
    `aidrian pr product-feedback post https://github.com/acme/notes/pull/7 --body-file=${p.body}`,
    `node /opt/plugin/plugins/aidrian/lib/cli.mjs pr product-feedback post 7 --body-file ${p.body}`,
    `cd ${p.dir} && aidrian pr product-feedback post 7 --body-file state/tmp/product-feedback-7.md`,
    `sh -c '${p.post}'`,
    `bash <<'EOF'\n${p.post}\nEOF`,
    `echo '${p.post}' | sh`,
    `echo 7 | xargs -I{} aidrian pr product-feedback post {} --body-file ${p.body}`,
    `npx aidrian pr product-feedback post 7 --body-file ${p.body}`,
  ];
  for (const command of forms) {
    const reason = p.run(command);
    assert.ok(reason, `held: ${command}`);
    assert.match(reason, /the Human runs the `post` command in their own shell/u, command);
  }
  assert.match(p.run(p.post), /no AskUserQuestion answer/u);
});

test('an answer for another pull request, or not to post, holds post; Post on this one passes', (t) => {
  const p = project(t, { limited: true });
  p.answer(QUESTION.replaceAll('#7', '#8'), 'Post');
  assert.match(p.run(p.post), /names #7/u, 'an answer about #8');
  p.answer('Pull request #7: is the comment clear?', 'Post');
  assert.match(p.run(p.post), /do not ask about posting/u);
  p.answer(QUESTION, 'Do not post');
  assert.match(p.run(p.post), /the Human picked "Do not post"/u);
  p.answer(QUESTION, 'Post');
  assert.equal(p.run(p.post), null);
  assert.equal(p.run(`node /opt/plugin/plugins/aidrian/lib/cli.mjs pr product-feedback post 7 --body-file ${p.body}`), null, 'the runner form reads the same');
});

test('a subagent is refused a held post, whatever the transcript holds', (t) => {
  const p = project(t, { limited: true });
  p.answer(QUESTION, 'Post');
  const subagent = { ...p.main, agent_id: 'a1' };
  for (const command of [p.post, `sh -c '${p.post}'`, `echo '${p.post}' | sh`, 'aidrian pr product-feedback "$ACTION" 7']) {
    assert.match(p.run(command, subagent) ?? '', /a subagent never gives it/u, command);
  }
});

test('a member\'s pull request posts with no answer, a subagent included, and a project with no feedback sees nothing', (t) => {
  const member = project(t, { limited: false });
  assert.equal(member.run(member.post), null);
  assert.equal(member.run(member.post, { agent_id: 'a1' }), null);
  assert.equal(member.run(`echo '${member.post}' | sh`), null);
  const none = project(t);
  assert.equal(none.run(none.post), null);
  assert.equal(none.run(`echo '${none.post}' | sh`, { agent_id: 'a1' }), null);
  // Another pull request's limited record holds that one alone.
  const other = project(t, { limited: true });
  assert.equal(other.run(other.post.replace('post 7', 'post 9')), null);
});

test('an answer given before the body file was last written holds post', (t) => {
  const p = project(t, { limited: true });
  p.answer(QUESTION, 'Post', BEFORE);
  assert.match(p.run(p.post), /no AskUserQuestion answer came after the comment was last written/u);
  p.answer(QUESTION, 'Post', LATER);
  assert.equal(p.run(p.post), null);
  // The comment rewritten after the Human's answer is not what the Human saw.
  const rewritten = new Date('2026-11-03T12:00:00.000Z');
  utimesSync(p.body, rewritten, rewritten);
  assert.ok(p.run(p.post));
  rmSync(p.body);
  assert.match(p.run(p.post), /no file/u);
});

test('a held post beside any other command is held even with a fresh Post answer, and a plain cd before it passes', (t) => {
  const p = project(t, { limited: true });
  p.answer(QUESTION, 'Post');
  assert.equal(p.run(p.post), null);
  const forms = [
    `sed -i '' 's/feedback/a rewrite/' ${p.body} && ${p.post}`,
    `printf 'a rewrite\\n' > ${p.body} && ${p.post}`,
    `cat > ${p.body} <<'EOF'\na rewrite\nEOF\n${p.post}`,
    `cp /etc/hosts ${p.body} && ${p.post}`,
    `echo more >> ${p.body}; ${p.post}`,
    `echo more | tee ${p.body} >/dev/null; ${p.post}`,
    `touch -t 202611031030 ${p.body} && ${p.post}`,
    `cd ${p.dir} > ${p.body} && ${p.post}`,
    `${p.post} > ${p.body}`,
    `sh -c '${p.post}'`,
  ];
  for (const command of forms) assert.match(p.run(command) ?? '', /Run `post` as its own command/u, command);
  assert.equal(p.run(`cd ${p.dir} && ${p.post}`), null);
  assert.equal(p.run(`cd ${p.dir}/state && aidrian pr product-feedback post 7 --body-file tmp/product-feedback-7.md`), null);
  assert.equal(p.run(`${p.post} 2>&1`), null, 'a redirect to another descriptor writes no file');
});

test('a held post takes only the skill\'s own comment file, <state>/tmp/product-feedback-<number>.md', (t) => {
  const p = project(t, { limited: true });
  const other = path.join(p.dir, 'state/tmp/other.md');
  const elsewhere = path.join(p.dir, 'product-feedback-7.md');
  for (const file of [other, elsewhere]) writeFileSync(file, 'It is feedback, not an approval or a block.\n');
  p.answer(QUESTION, 'Post');
  for (const file of [other, elsewhere, path.join(p.dir, 'state/tmp/product-feedback-8.md')]) {
    assert.match(p.run(`aidrian pr product-feedback post 7 --body-file ${file}`) ?? '', /not the comment the skill drafts for #7/u, file);
  }
  assert.equal(p.run(p.post), null);
  // A link in its place points somewhere the hook did not date.
  rmSync(p.body);
  symlinkSync(other, p.body);
  assert.match(p.run(p.post), /no file/u);
  // A member's pull request holds nothing, whatever file it posts.
  const member = project(t, { limited: false });
  assert.equal(member.run(`aidrian pr product-feedback post 7 --body-file ${path.join(member.dir, 'state/tmp/other.md')}`), null);
});

test('a record that does not say limited false holds post, and so does a post beside a call that can write the record', (t) => {
  const missing = project(t, { limited: 'missing' });
  assert.ok(missing.run(missing.post), 'a record with no limited field');
  const member = project(t, { limited: false });
  const chained = `aidrian pr product-feedback record 7 --none-found --read-by product-manager && ${member.post}`;
  assert.match(member.run(chained), /Run `record` on its own first/u);
  const fresh = project(t);
  assert.ok(fresh.run(chained.replaceAll(member.body, fresh.body)), 'a record written in the same command');
});

test('the Bash hook runs the post rule and blocks with exit 2', (t) => {
  const p = project(t, { limited: true });
  const result = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: p.post }, cwd: p.dir, transcript_path: p.transcript }), encoding: 'utf8', cwd: p.dir });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /product-feedback post/u);
});

test('the post rule loads no knowledge loader, and the forge only through review/state.mjs, so a Bash call pays for no gh', () => {
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
  walk(path.join(lib, 'rules/product-feedback-post.mjs'));
  const reached = [...seen].map((file) => path.relative(lib, file));
  // The forge facade loads only for review/state.mjs, which asks it who belongs to a repository: nothing the rule reads
  // runs gh, and nothing of the rule's own reaches for the forge.
  assert.deepEqual([...forgeImporters], [path.join('review', 'state.mjs')]);
  assert.ok(reached.length > 1, 'the walk follows imports');
  for (const absent of ['knowledge.mjs', 'pr-product-feedback.mjs', 'pr-resolve.mjs']) assert.ok(!reached.includes(absent), `${absent} is reached: ${reached.join(', ')}`);
});
