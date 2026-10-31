import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { check } from '../plugins/aidrian/lib/rules/github/pr-body.mjs';

// A full contract, as a project with a closed list of sections, deferrals to tracked issues, and residuals sets it.
const CONTRACT = {
  title: '^\\[(?:{issueKey}|NOISSUE)\\] (?:{types})(?:\\([a-z0-9./_-]+\\))?!?: \\S.*',
  issueKey: 'ABC-\\d+',
  sections: ['TL;DR', 'Risk', 'What changed', 'Tests run', 'Accepted residuals', 'Deferred to issues'],
  deferrals: {
    section: 'Deferred to issues',
    field: 'defer_reason',
    reasons: ['non_goals_collision', 'confirmed_missing_authority', 'human_only', 'user_chose'],
    neverValid: ['scope expansion', 'needs a separate PR', 'needs <specialist> oversight', 'out of scope', 'advisory'],
  },
  residuals: { section: 'Accepted residuals', fields: ['likelihood', 'impact', 'cost_to_close'] },
  duplicateBody: true,
};
const CONFIG = { version: 1, github: { requiredSections: ['TL;DR'], pullRequest: CONTRACT } };
const BODY = '## TL;DR\nShare links expire.\n\n## Tests run\n- `npm test`: pass\n';

function project(t, config = CONFIG, { open = [] } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-prcontract-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify(config));
  const lookups = [];
  const run = (command, env = {}) => check(command, { cwd: dir, env, listOpenPrs: (repo) => (lookups.push(repo), open) });
  return { run, dir, lookups, write: (name, text) => writeFileSync(path.join(dir, name), text) };
}

const create = (body, title = '[NOISSUE] feat: share links') => `gh pr create --title '${title}' --body "$(cat <<'EOF'\n${body}EOF\n)"`;

test('the contract keys load, and a bad value is an error that keeps the default', (t) => {
  const { dir } = project(t);
  const projectFolder = { root: dir, paths: { config: '.aidrian/config.json' } };
  const { config, errors } = loadConfig(projectFolder);
  assert.deepEqual(errors, []);
  assert.deepEqual(config.github.pullRequest.sections, CONTRACT.sections);
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, github: { pullRequest: { title: '(', deferrals: { section: 'X' } } } }));
  const bad = loadConfig(projectFolder);
  assert.match(bad.errors[0], /"github\.pullRequest\.title" must be a regular expression/);
  assert.match(bad.errors[1], /"github\.pullRequest\.deferrals" must be null, or/);
  assert.equal(bad.config.github.pullRequest.title, null);
});

test('the title must match the pattern, with {types} and {issueKey} filled in, and only when the command sets one', (t) => {
  const { run } = project(t);
  assert.equal(run(create(BODY)), null);
  assert.equal(run(create(BODY, '[ABC-12] fix(share.links): expire')), null);
  assert.match(run(create(BODY, 'feat: share links')), /^Blocked: the title "feat: share links" does not match config\.json `github\.pullRequest\.title`/);
  assert.match(run(create(BODY, '[ABC-1] wip: x')), /\{types\} is build\|chore/);
  assert.match(run(create(BODY, '[NOISSUE] feat: follow up on ABC-9')), /^Blocked: the title names an issue key outside its leading \[\.\.\.\] bracket/);
  assert.equal(run(create(BODY, '[NOISSUE] feat: XABC-9 and ABC-9a are not keys')), null);
  assert.equal(run(`gh pr edit 4 --body '${BODY}'`), null, 'a body-only edit never checks the old title');
  assert.match(run('gh pr edit 4 -t "retitled"'), /does not match/, 'a retitle does');
  assert.equal(run('gh pr edit 4 --title "$TITLE"'), null, 'a title the rule cannot read passes');
});

test('the sections are a closed list, outside code fences', (t) => {
  const { run } = project(t);
  assert.match(run(create(`${BODY}\n## Findings\nx\n`)), /^Blocked: the body adds the section\(s\) `## Findings`, which are not on the closed list/);
  assert.equal(run(create(`${BODY}\n\`\`\`\`md\n## Findings\n\`\`\`\n## Also quoted\n\`\`\`\`\n`)), null, 'a quoted heading, nested fence included');
  assert.equal(run(create(`${BODY}### Detail\n`)), null, 'only `## ` headings');
});

test('every deferral names a reason from the list, not a never-valid one, and an issue', (t) => {
  const { run } = project(t);
  const deferred = (item) => create(`${BODY}\n## Deferred to issues\n\nTwo findings were deferred:\n\n${item}\n`);
  assert.equal(run(deferred('- Migration — `defer_reason: human_only` — ABC-1234: needs a credential\n  - the key is the Stripe one')), null);
  assert.equal(run(deferred('- defer_reason: user_chose (asked twice) — ABC-1')), null);
  assert.match(run(deferred('- Migration — ABC-1')), /is not a valid deferral: it carries no `defer_reason:` value\./);
  assert.match(run(deferred('- `defer_reason: scope expansion` — ABC-1')), /its reason "scope expansion" is a never-valid reason \("scope expansion"\)/);
  assert.match(run(deferred('- defer_reason: needs backend-developer oversight — ABC-1')), /never-valid reason \("needs <specialist> oversight"\)/);
  assert.match(run(deferred('- defer_reason: HUMAN_ONLY — ABC-1')), /its reason "HUMAN_ONLY" is not one of non_goals_collision/);
  assert.match(run(deferred('- defer_reason: pending_review, ABC-9: add advisory banner')), /its reason "pending_review" is not one of/, 'the issue title is not the reason');
  assert.match(run(deferred('- defer_reason: human_only')), /it names no issue to defer the work to/);
  assert.equal(run(deferred('- defer_reason: human_only — ABC-2\n  - the gate rejects `defer_reason: scope expansion`')), null, 'a sub-bullet is prose about the field');
});

test('every residual states each field and names no issue', (t) => {
  const { run } = project(t);
  const residual = (item) => create(`${BODY}\n## Accepted residuals\n${item}\n`);
  assert.equal(run(residual('- Stale cache — likelihood: low, impact: minor, cost_to_close: a new table')), null);
  assert.match(run(residual('- Stale cache — likelihood: low')), /is not a valid residual: it is missing `impact:`, `cost_to_close:`/);
  assert.match(run(residual('- Stale cache — likelihood: low, impact: minor, cost_to_close: x, ABC-3')), /it names an issue/);
});

test('a body file in a shared temp folder is refused, readable or not; one in the project passes', (t) => {
  const { run, write } = project(t);
  write('body.md', BODY);
  assert.match(run('gh pr create -t "[NOISSUE] feat: x" --body-file /tmp/pr-body.md'), /^Blocked: the body file `\/tmp\/pr-body\.md` is in a shared temp folder/);
  assert.match(run('gh pr edit 3 -F "$TMPDIR/body.md"'), /shared temp folder/);
  assert.match(run('gh pr edit 3 -F /x/body.md', { TMPDIR: '/x/' }), /shared temp folder/);
  assert.equal(run('gh pr create -t "[NOISSUE] feat: x" -F body.md'), null, 'the project may itself sit in a temp folder');
  const off = project(t, { version: 1, github: { requiredSections: [], pullRequest: { sharedTempBodyFile: false } } });
  assert.equal(off.run('gh pr edit 3 -F /tmp/pr-body.md'), null);
});

test('a body identical to another open pull request is refused; the edited one itself and other repos are told apart', (t) => {
  const { run, lookups } = project(t, CONFIG, { open: [{ number: 7, body: `${BODY}\n` }, { number: 8, body: 'other' }] });
  assert.match(run(create(BODY)), /^Blocked: the body is identical to open pull request #7's/);
  assert.equal(run(`gh pr edit 7 --body '${BODY}'`), null, 'republishing its own body');
  assert.match(run(`gh pr edit https://github.com/a/b/pull/8 --body '${BODY}'`), /#7's/);
  assert.equal(lookups.at(-1), 'a/b', 'the URL names the repository to look in');
  assert.equal(run(`gh pr edit my-branch --body '${BODY}'`), null, 'a branch selector cannot be told from itself');
  run(`gh pr create -R acme/notes -t "[NOISSUE] feat: x" -b '${BODY}'`);
  assert.equal(lookups.at(-1), 'acme/notes');
  assert.equal(run(`gh pr create -R "$REPO" -t "[NOISSUE] feat: x" -b '${BODY}'`), null, 'a repo the rule cannot read');
  const failing = check(create(BODY), { cwd: project(t).dir, env: {}, listOpenPrs: () => { throw new Error('offline'); } });
  assert.equal(failing, null, 'a failed lookup fails open');
});

test('without github.pullRequest the rule checks only the required sections, as before', (t) => {
  const { run, lookups } = project(t, { version: 1 });
  assert.equal(run(create('## Summary\n## Tests run\n## Anything\n- defer_reason: nope\n', 'whatever')), null);
  assert.deepEqual(lookups, [], 'no gh lookup');
});
