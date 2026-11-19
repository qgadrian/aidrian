// What a project run's issue session asks of the forge (lib/issue-forge-guard.mjs) and writes by hand in the shared
// state folders (lib/unattended-write.mjs), held by its unattended mark: it pushes only `git push origin
// HEAD:refs/heads/<its branch>` from its own clone, runs no release, workflow, or raw API write outside its pull request
// and issues, writes no workflow file, no handoff brief, and no quorum ledger, and in the plans, tmp, and dispatch folders
// only what is named for its own issue or branch. An attended session, a run's driver, and a session a pending mark
// holds are not held by it. The in-process calls ask the guard as the agent gate hook does; the hook runs spawn the
// real hook with the test's own state folders. No test reaches the network or reads the user's own home.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { issueForgeDenial } from '../plugins/aidrian/lib/issue-forge-guard.mjs';
import { appendToRun, runsFolder } from '../plugins/aidrian/lib/project-run.mjs';
import { ownAttemptFolder, ownIssue } from '../plugins/aidrian/lib/project-run-guard.mjs';
import { issueHeld, markUnattended, readUnattendedMark } from '../plugins/aidrian/lib/unattended-mark.mjs';
import { unattendedPlaces, unattendedWriteDenial } from '../plugins/aidrian/lib/unattended-write.mjs';
import { DRIVER, runFixture } from './project-start-fixture.mjs';

const HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-agent-gates.mjs');
const CLI = path.resolve(import.meta.dirname, '../plugins/aidrian/bin/aidrian');
const SESSION = 'feed00aa-0000-4000-8000-0000000000ab';
const BRANCH = 'feat/eng-1-export';
const EXACT = `git push origin HEAD:refs/heads/${BRANCH}`;
const NAMES = { names: { human: 'Adrian' } };

// The forms an issue session never runs, each refused.
const REFUSED = [
  'git push origin v9.9.9', 'git push --tags', 'git push origin --tags', `git push --follow-tags origin HEAD:refs/heads/${BRANCH}`,
  'git push --mirror origin', 'git push --all origin', `git push origin --delete ${BRANCH}`, `git push -d origin ${BRANCH}`,
  `git push origin :refs/heads/${BRANCH}`, 'git push origin HEAD:refs/heads/main', 'git push origin HEAD:refs/heads/release/1.0',
  'git push origin HEAD', 'git push', `git push origin HEAD:refs/heads/${BRANCH} HEAD:refs/tags/v9.9.9`,
  `git push https://github.com/acme/widgets.git HEAD:refs/heads/${BRANCH}`, `git push upstream HEAD:refs/heads/${BRANCH}`,
  'git push --force origin HEAD:refs/heads/main', 'git push origin +HEAD:refs/heads/main', `git push --force-with-lease=main origin HEAD:refs/heads/${BRANCH}`,
  `git push --repo=https://example.com/x.git origin HEAD:refs/heads/${BRANCH}`, `git push -o ci.skip origin HEAD:refs/heads/${BRANCH}`,
  `git push --no-verify origin HEAD:refs/heads/${BRANCH}`, `git -c remote.origin.pushurl=https://example.com/x.git push origin HEAD:refs/heads/${BRANCH}`,
  `GIT_CONFIG_PARAMETERS="'remote.origin.url=https://example.com/x.git'" git push origin HEAD:refs/heads/${BRANCH}`,
  `HOME=/tmp/elsewhere git push origin HEAD:refs/heads/${BRANCH}`, `cd /tmp && ${EXACT}`, 'git send-pack https://example.com/x.git refs/tags/v1',
  'git -c alias.p="push --tags" p', 'G=push; git $G --tags', `git push origin "$REF"`, 'bash -c "git push --tags"', 'eval "git push --tags"',
  'gh release create v9.9.9', 'gh -R acme/widgets release upload v1 x.tgz', 'gh workflow run deploy.yml', 'gh workflow enable deploy.yml',
  'gh run rerun 123', 'gh secret set TOKEN --body x', 'gh variable set X --body y', 'gh repo edit --default-branch dev', 'gh "$SUB" create v1',
  'gh api -X POST repos/acme/widgets/git/refs -f ref=refs/tags/v9.9.9 -f sha=abc', 'gh api repos/acme/widgets/git/refs -f ref=refs/heads/main -f sha=abc',
  'gh api --method PATCH repos/acme/widgets/git/refs/heads/main -F force=true', 'gh api -XPOST repos/acme/widgets/git/tags -f tag=v1',
  'gh api -X POST repos/acme/widgets/releases -f tag_name=v1', 'gh api -X POST repos/acme/widgets/dispatches -f event_type=deploy',
  'gh api -X POST /repos/acme/widgets/actions/workflows/deploy.yml/dispatches -f ref=main', 'gh api -X PUT repos/acme/widgets/actions/secrets/TOKEN --input secret.json',
  'gh api -X POST repos/acme/widgets/actions/variables -f name=X -f value=Y', 'gh api -X PUT repos/acme/widgets/pulls/3/merge',
  'gh api -X PUT repos/acme/widgets/contents/README.md -f message=x -f content=eA== -f branch=main', 'gh api -X POST repos/acme/widgets/statuses/abc -f state=success',
  'gh api -X "$M" repos/acme/widgets/git/refs', 'gh api -X POST "$ROUTE" -f ref=x',
  'gh api graphql -f query=\'mutation { createRef(input: {repositoryId: "x", name: "refs/tags/v1", oid: "y"}) { ref { name } } }\'',
  'gh api graphql -f query=\'mutation { a: resolveReviewThread(input: {threadId: "x"}) { thread { id } } b: mergePullRequest(input: {pullRequestId: "y"}) { clientMutationId } }\'',
  'gh api graphql -F query=@mutation.graphql', 'gh api graphql -f query="$Q"', 'gh api graphql --input body.json',
  'git subtree push --prefix=lib origin main', 'git frobnicate', 'git lfs push origin main', 'git lfs install', 'git lfs "$SUB"',
  'git submodule foreach "git push --tags"', 'git rebase -x "git push origin HEAD:refs/heads/main" origin/main', 'git bisect run sh -c "gh release create v1"',
  'ls | xargs git push origin', 'echo v1 | xargs -I{} git push origin {}', 'xargs -n1 /usr/bin/gh release delete < tags.txt', 'echo x | xargs $CMD push --tags',
  'find . -name x -exec git push --tags \\;', 'find . -execdir sh -c "git push origin HEAD:refs/heads/main" \\;', 'find . -ok gh release create v1 \\;',
  'xcrun git push --tags', 'gh repo create acme/copy --public --source . --push', 'gh repo fork acme/widgets --clone', 'gh gist create notes.md',
];
// The calls an issue session makes, each passing this guard.
const PASSED = [
  EXACT, `git push -u origin HEAD:refs/heads/${BRANCH}`, `git push origin +HEAD:refs/heads/${BRANCH}`, `git push --force-with-lease=${BRANCH} origin HEAD:refs/heads/${BRANCH}`,
  `git push -q origin -- HEAD:refs/heads/${BRANCH}`, 'git status', 'git log --oneline -3', 'git -C . diff', 'gh release list', 'gh release view v1', 'gh workflow list',
  'gh run view 123', `gh pr create --head ${BRANCH} --title x --body y`, 'gh api repos/acme/widgets/releases', 'gh api repos/acme/widgets/git/refs/tags',
  'gh api -X POST repos/acme/widgets/pulls/3/comments/4/replies -f body=ok', 'gh api -X DELETE repos/acme/widgets/issues/comments/5',
  'gh api repos/{owner}/{repo}/issues/3/comments -f body="$BODY"', 'gh api -X GET repos/acme/widgets/actions/runs -f branch=main',
  'gh api graphql -f query=\'mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }\' -F id="$ID"',
  'gh api graphql -f query=\'query { repository(owner: "acme", name: "widgets") { pullRequest(number: 3) { reviewThreads(first: 50) { nodes { id } } } } }\'',
  'npm test', 'echo "push the tags later"', 'git lfs ls-files', 'git lfs pull', 'git submodule update --init', 'git rebase origin/main',
  'git interpret-trailers --parse msg.txt', 'find . -name "*.js" -exec grep -l TODO {} +', 'ls | xargs grep -l TODO', 'find . -name "*.orig" -delete',
  'gh repo view acme/widgets', 'gh gist list',
];

// A run `launch` whose issue ENG-1 runs in a confined attempt clone, and SESSION marked as that issue's session.
function issueFixture(t, options = {}) {
  const fx = runFixture(t, options);
  const attempt = path.join(runsFolder(fx.state), 'launch', 'attempts', 'ENG-1.1');
  const work = path.join(attempt, 'work');
  for (const part of ['drop', 'cache']) mkdirSync(path.join(attempt, part), { recursive: true });
  execFileSync('git', ['clone', '-q', '--separate-git-dir', path.join(attempt, 'git'), fx.dir, work], { stdio: 'pipe' });
  // The temporary folder the session may write, apart from the test's own, which holds every folder of the fixture.
  const temp = path.join(fx.root, 'scratch');
  mkdirSync(temp);
  const at = new Date().toISOString();
  appendToRun(fx.state, 'launch', () => ({ rows: [
    { event: 'start', key: 'ENG-1', attempt: 1, session: DRIVER, name: 'launch · ENG-1 · 1', cwd: work, branch: BRANCH, drop: path.join(attempt, 'drop'), at, outcome: 'started', id: 'pid-1-0000000000000000', child: SESSION },
    { event: 'issue', key: 'ENG-1', state: 'running', at },
  ] }));
  assert.ok(markUnattended(SESSION, { root: fx.dir, cwd: work, env: fx.env, tags: { project: 'launch', issue: 'ENG-1' } }));
  const mark = readUnattendedMark(SESSION, { env: fx.env, home: fx.home });
  // The guard as the agent gate hook asks it, in process, for SESSION's call in `cwd`.
  const ask = (input, { held = mark, cwd = work } = {}) => unattendedWriteDenial({ session_id: SESSION, cwd, ...input }, fx.config, {
    mark: held,
    env: fx.env,
    places: () => unattendedPlaces({ cwd, mark: held, project: fx.project, config: fx.config, env: fx.env, home: fx.home, temp: [temp], own: () => ownAttemptFolder(fx.project, fx.config, held, { home: fx.home }) }),
  });
  // The real hook, as the host runs it, for `session`'s call.
  const hook = (input, { session = SESSION, cwd = work } = {}) => spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: session, cwd, ...input }), encoding: 'utf8', env: { ...fx.env, CLAUDECODE: '1', AIDRIAN_TELEMETRY: '0', TMPDIR: temp },
  });
  return { ...fx, attempt, work, mark, ask, hook };
}

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const write = (file) => ({ tool_name: 'Write', tool_input: { file_path: file, content: 'x' } });

test('an issue session pushes only its own branch to origin, and asks the forge for no release, workflow, or write outside its pull request', (t) => {
  const fx = issueFixture(t);
  assert.deepEqual(ownIssue(fx.project, fx.config, fx.mark, { home: fx.home }), { key: 'ENG-1', branch: BRANCH });
  for (const command of REFUSED) {
    const denial = fx.ask(bash(command));
    assert.match(denial?.reason ?? '', /a project run's issue session never does that: only the Human does/u, command);
  }
  for (const command of PASSED) assert.equal(fx.ask(bash(command)), null, command);
  // The reason names the one push it makes.
  assert.match(fx.ask(bash('git push origin HEAD:refs/heads/main')).reason, /the one push it makes is `git push origin HEAD:refs\/heads\/feat\/eng-1-export`/u);
  // An issue whose start the ledger does not name as running pushes nothing: its branch cannot be told.
  appendToRun(fx.state, 'launch', () => ({ rows: [{ event: 'issue', key: 'ENG-1', state: 'parked', at: new Date().toISOString() }] }));
  assert.match(fx.ask(bash(EXACT))?.reason ?? '', /no running start of its issue names the branch it may push/u);
});

test('an attended session, a run\'s driver, a pending hold, and an unattended session no issue names are not held by the issue session\'s forge rule', (t) => {
  const fx = issueFixture(t);
  const ask = (mark, command) => issueForgeDenial({ session_id: SESSION, cwd: fx.work, ...bash(command) }, NAMES, { mark, cwd: fx.work, issue: () => null, roots: () => [] });
  for (const command of ['git push --tags', 'gh release create v1', 'gh api -X POST repos/acme/widgets/git/refs -f ref=refs/tags/v1']) {
    for (const mark of [null, { root: fx.dir, cwd: fx.dir }, { root: fx.dir, cwd: fx.dir, pending: true }]) assert.equal(ask(mark, command), null, `${JSON.stringify(mark)} ${command}`);
    // A mark that cannot be read may be an issue session's, as may one whose tags have a wrong shape.
    for (const mark of [{ root: null }, { root: fx.dir, issue: null, project: null }]) assert.ok(ask(mark, command), `${JSON.stringify(mark)} ${command}`);
  }
  assert.deepEqual([issueHeld(null), issueHeld({ root: '/r' }), issueHeld({ root: null, pending: true }), issueHeld({ root: '/r', issue: 'ENG-1' })], [false, false, false, true]);
  // Through the hook: the driver, and an attended session, push tags and run releases as before.
  for (const session of [DRIVER, 'feed00aa-0000-4000-8000-0000000000ac']) {
    for (const command of ['git push --tags', 'gh release create v1']) {
      const ran = fx.hook(bash(command), { session, cwd: fx.dir });
      assert.equal(ran.status, 0, `${session} ${command}: ${ran.stderr}`);
    }
  }
});

test('the agent gate hook, run as the host runs it, refuses an issue session each push it never makes and lets its exact push run', (t) => {
  const fx = issueFixture(t);
  for (const command of ['git push origin v9.9.9', 'git push --tags', 'git push origin HEAD:refs/heads/main', 'git push origin HEAD:refs/heads/release/1.0',
    `git push https://github.com/acme/widgets.git HEAD:refs/heads/${BRANCH}`, 'gh release create v9.9.9', 'gh workflow run deploy.yml',
    'gh api -X POST repos/acme/widgets/git/refs -f ref=refs/tags/v9.9.9 -f sha=abc']) {
    const ran = fx.hook(bash(command));
    assert.equal(ran.status, 2, `${command}: ${ran.stderr}`);
    assert.match(ran.stderr, /a project run's issue session never does that/u, command);
  }
  for (const command of [EXACT, `git push -u origin HEAD:refs/heads/${BRANCH}`]) {
    const ran = fx.hook(bash(command));
    assert.equal(ran.status, 0, `${command}: ${ran.stderr}`);
  }
});

test('an issue session\'s exact push is refused when its commits change a workflow file, however it got there, and not for a merge of the default branch', (t) => {
  const fx = issueFixture(t);
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8', stdio: 'pipe' });
  const push = () => fx.ask(bash(EXACT))?.reason ?? null;
  writeFileSync(path.join(fx.work, 'notes.md'), 'a change\n');
  git(fx.work, 'add', '--', 'notes.md');
  git(fx.work, 'commit', '-q', '-m', 'feat: a normal change');
  assert.equal(push(), null, 'a normal change');
  // The default branch changes a workflow, and the session merges it in: none of that branch's own change counts.
  mkdirSync(path.join(fx.dir, '.github', 'workflows'), { recursive: true });
  writeFileSync(path.join(fx.dir, '.github', 'workflows', 'ci.yml'), 'on: push\n');
  git(fx.dir, 'add', '--', '.github/workflows/ci.yml');
  git(fx.dir, 'commit', '-q', '-m', 'ci: a workflow on the default branch');
  git(fx.work, 'fetch', '-q', 'origin');
  git(fx.work, 'merge', '-q', '--no-edit', 'origin/main');
  assert.equal(push(), null, 'a merge of the default branch');
  // A patch applied to the index, past the file-write guard, puts a workflow file in the next commit.
  const patch = path.join(fx.root, 'scratch', 'leak.patch');
  writeFileSync(patch, ['diff --git a/.github/workflows/leak.yml b/.github/workflows/leak.yml', 'new file mode 100644', '--- /dev/null', '+++ b/.github/workflows/leak.yml', '@@ -0,0 +1 @@', '+on: push', ''].join('\n'));
  git(fx.work, 'apply', '--cached', patch);
  git(fx.work, 'commit', '-q', '-m', 'chore: tidy');
  assert.match(push(), /it pushes commits that change \.github\/workflows\/leak\.yml, a workflow file the forge runs with the repository's secrets on that push/u);
  const hooked = fx.hook(bash(EXACT));
  assert.equal(hooked.status, 2, hooked.stderr);
  assert.match(hooked.stderr, /\.github\/workflows\/leak\.yml/u);
  // A change to the actions a workflow calls counts the same; taking the leak back out lets the push run.
  git(fx.work, 'rm', '-q', '--', '.github/workflows/leak.yml');
  mkdirSync(path.join(fx.work, 'src', '.github', 'actions'), { recursive: true });
  writeFileSync(path.join(fx.work, 'src', '.github', 'actions', 'note.md'), 'not the root folder\n');
  git(fx.work, 'add', '--', 'src');
  git(fx.work, 'commit', '-q', '-m', 'chore: undo');
  assert.equal(push(), null, 'the leak taken out, and a folder of that name below the root');
  const ran = fx.hook(bash(EXACT));
  assert.equal(ran.status, 0, ran.stderr);
  git(fx.work, 'update-ref', '-d', 'refs/remotes/origin/HEAD');
  git(fx.work, 'update-ref', '-d', 'refs/remotes/origin/main');
  assert.match(push(), /git names no merge base with origin's default branch/u, 'no base to compare with');
});

test('an issue session writes no workflow file, no handoff brief or snapshot, no quorum ledger, and only its own issue\'s plans, scratch files, and handoffs', (t) => {
  const fx = issueFixture(t);
  const refused = [
    [path.join(fx.work, '.github', 'workflows', 'leak.yml'), /the forge's workflow files, which the forge runs with the repository's secrets/u],
    [path.join(fx.work, '.github', 'actions', 'setup', 'action.yml'), /the forge's workflow files/u],
    [path.join(fx.state, 'handoffs', '2026-11-19-project-launch.md'), /outside the places/u],
    [path.join(fx.state, 'handoffs', '.prior', '2026-11-19-project-launch.md'), /outside the places/u],
    [path.join(fx.state, 'quorum', 'product', 'x-1234567.json'), /outside the places/u],
    [path.join(fx.state, 'plans', 'eng-2-implementation.md'), /not named for this session's issue ENG-1/u],
    [path.join(fx.state, 'plans', 'eng-12-implementation.md'), /not named for this session's issue ENG-1/u],
    [path.join(fx.state, 'plans', 'billing-plan.md'), /an issue session writes only plans\/eng-1-\.\.\. there/u],
    [path.join(fx.state, 'tmp', 'eng-2', 'log.txt'), /not named for this session's issue/u],
    [path.join(fx.state, 'dispatch', 'feat-eng-2-import-S1-explorer.json'), /a handoff file named for its own branch, feat-eng-1-export-<slice>-<agent>\.json/u],
  ];
  for (const [file, why] of refused) {
    assert.match(fx.ask(write(file))?.reason ?? '', why, file);
    assert.match(fx.ask(bash(`echo x > '${file}'`))?.reason ?? '', why, `shell ${file}`);
  }
  for (const file of [path.join(fx.work, 'src', 'x.js'), path.join(fx.work, '.github', 'ISSUE_TEMPLATE', 'bug.md'), path.join(fx.state, 'plans', 'eng-1-implementation.md'),
    path.join(fx.state, 'plans', 'ENG-1-implementation.md'), path.join(fx.state, 'tmp', 'eng-1', 'log.txt'), path.join(fx.state, 'tmp', 'eng-1.snapshot.json'),
    path.join(fx.state, 'dispatch', 'feat-eng-1-export-S1-explorer.json'), path.join(fx.state, 'reviews', 'pr-3.json.tmp')]) {
    assert.equal(fx.ask(write(file)), null, file);
  }
  // A session no issue names, as an attended session's background continuation, writes those state folders as before.
  const plain = { ...fx.mark, project: undefined, issue: undefined };
  delete plain.project;
  delete plain.issue;
  for (const file of [path.join(fx.state, 'handoffs', '2026-11-19-widgets.md'), path.join(fx.state, 'quorum', 'x.json'), path.join(fx.state, 'plans', 'billing-plan.md')]) {
    assert.equal(fx.ask(write(file), { held: plain, cwd: fx.dir }), null, file);
  }
  // Through the hook, as the host runs it.
  const brief = fx.hook(write(path.join(fx.state, 'handoffs', '2026-11-19-project-launch.md')));
  assert.equal(brief.status, 2, brief.stderr);
  const workflow = fx.hook(write(path.join(fx.work, '.github', 'workflows', 'leak.yml')));
  assert.equal(workflow.status, 2, workflow.stderr);
  const plan = fx.hook(write(path.join(fx.state, 'plans', 'eng-1-implementation.md')));
  assert.equal(plan.status, 0, plan.stderr);
});

test('with no running start to name its issue, an issue session writes none of the shared plans, tmp, or dispatch files', (t) => {
  const fx = issueFixture(t);
  appendToRun(fx.state, 'launch', () => ({ rows: [{ event: 'issue', key: 'ENG-1', state: 'parked', at: new Date().toISOString() }] }));
  for (const name of ['plans/eng-1-implementation.md', 'tmp/eng-1/x', 'dispatch/feat-eng-1-export-S1-explorer.json']) {
    assert.ok(fx.ask(write(path.join(fx.state, ...name.split('/')))), name);
  }
});

test('an issue session routes a hard product call to the Human with no quorum, which an attended session would run', (t) => {
  const fx = issueFixture(t, { config: { decisions: { maxMode: 'decide-reversible', mode: 'decide-reversible' }, quorum: { product: { autoStart: true, approval: 'first', maxAutoRuns: 3 } } } });
  const route = (session) => {
    const ran = spawnSync(CLI, ['quorum', 'route', '--domain', 'ux', '--class', 'copy', '--reversible', 'no,no,no,no', '--hard', 'no,yes,no,no,no'], { cwd: fx.dir, encoding: 'utf8', env: fx.as(session) });
    assert.equal(ran.status, 0, ran.stderr);
    return JSON.parse(ran.stdout);
  };
  assert.equal(route(DRIVER).route, 'quorum', 'an attended session, the driver');
  const parked = route(SESSION);
  assert.deepEqual([parked.route, parked.wait], ['human', true]);
  assert.match(parked.reason, /works one issue of a project run, which runs no quorum: it parks the call with the issue, for the Human/u);
});
