// The ready hold: no draft is marked ready while its product feedback is owed (lib/rules/github/ready-hold.mjs). Every
// gh here is test/fixtures/ready-hold/gh.mjs, in-process through gh's exec seam under the real forge adapter, or as a
// program on PATH: nothing reaches GitHub, and no real pull request is marked ready. Each repository is a temporary one,
// with no GIT_DIR.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runGh } from '../plugins/aidrian/lib/forges/github-cli.mjs';
import { createGithubForge } from '../plugins/aidrian/lib/forges/github.mjs';
import { runProductFeedback } from '../plugins/aidrian/lib/pr-product-feedback.mjs';
import { findProject, projectAt } from '../plugins/aidrian/lib/project.mjs';
import { emptyState, writeLocalState } from '../plugins/aidrian/lib/review/state.mjs';
import { check, checkMcp, DEADLINE_MS, FED_REASON, HOOK_BUDGET_MS, MANY_REASON, OVERRIDE } from '../plugins/aidrian/lib/rules/github/ready-hold.mjs';
import { answer, URL7 } from './fixtures/ready-hold/gh.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const FAKE_GH = path.join(ROOT, 'test/fixtures/ready-hold/gh.mjs');
const RECORDED = JSON.parse(readFileSync(path.join(ROOT, 'test/fixtures/hosts/codex/github.json'), 'utf8'));
const HEAD = 'a'.repeat(40);
const LATER = 'b'.repeat(40);
const ON = { auto: true, files: ['src/ui/**'] };
const configText = (feedback, extra = {}) => JSON.stringify({ version: 1, state: { dir: '../state' }, ...(feedback ? { review: { productFeedback: feedback } } : {}), ...extra });
const commitAll = (git, message, ...flags) => git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', ...flags, '-m', message);

// A temporary repository whose default branch commits `feedback`, with its state folder beside it. `refs` is how git names
// that branch on origin: 'main', origin/main with origin/HEAD naming it; 'master', a master branch with origin/master and
// no origin/HEAD; or 'none'. `extra` adds to the committed config.
function repo(t, { feedback = ON, local = null, refs = 'main', extra = {} } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-ready-hold-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'repo');
  mkdirSync(dir);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', refs === 'master' ? 'master' : 'main');
  git('remote', 'add', 'origin', 'git@github.com:acme/notes.git');
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), configText(feedback, extra));
  writeFileSync(path.join(dir, '.gitignore'), '.aidrian.local.json\nbin/\nspec.json\n');
  git('add', '.');
  commitAll(git, 'config');
  if (refs === 'main') {
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  }
  if (refs === 'master') git('update-ref', 'refs/remotes/origin/master', 'HEAD');
  if (local !== null) writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify({ review: { productFeedback: { auto: local } } }));
  mkdirSync(path.join(dir, '../state/tmp'), { recursive: true });
  return dir;
}

const gitIn = (dir) => (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

// The hold's forge seam over gh's exec seam: the real forge adapter and gh runner, with only gh's process replaced, so the
// hold's calls reach `exec` as the gh commands they run.
const forgeOver = (exec) => (cwd, options) => createGithubForge({ ...options, cwd, run: (args, given) => runGh(args, { ...given, exec }) });
// A forge over the fake gh's `answer`, for the product feedback commands.
const answering = (gh) => createGithubForge({ run: (args) => gh(args) });

// The exec seam over the fake gh: each call's arguments and the time it was given. `spec` may change between calls.
// Every call is stopped with SIGKILL at its time: a gh that ignores the default signal would outlive the hook.
function seam(spec) {
  const calls = [];
  const exec = (file, args, options) => {
    assert.equal(file, 'gh');
    assert.equal(options.killSignal, 'SIGKILL');
    calls.push({ args, timeout: options.timeout });
    return answer(args, { head: HEAD, config: configText(ON), ...spec });
  };
  return { calls, exec };
}

// The product feedback commands, run on pull request 7 at `head`.
function feedback(dir, head, ...argv) {
  const gh = (args) => answer(args, { head, config: configText(ON) });
  const saved = console.log;
  console.log = () => {};
  try {
    return runProductFeedback(argv, findProject(dir), { forge: answering(gh), remotes: () => ['github.com/acme/notes'] });
  } finally {
    console.log = saved;
  }
}

// A record with one product-manager defect, PF1, found at HEAD.
function recordDefect(dir) {
  const items = path.join(dir, '../state/tmp/items.json');
  writeFileSync(items, JSON.stringify([{ source: 'product-manager', title: 'The absence list loses its filter on reload', kind: 'defect' }]));
  assert.equal(feedback(dir, HEAD, 'record', URL7, '--items', items), 0);
}

const owedNow = (dir, spec = { head: HEAD }, more = {}) => {
  const { calls, exec } = seam(spec);
  return { calls, reason: (command) => check(command, { cwd: dir, env: {}, forge: forgeOver(exec), ...more }) };
};

test('with nothing recorded, every way of marking ready is held, and the deny names the skill and status', (t) => {
  const dir = repo(t);
  const { reason } = owedNow(dir);
  const graphql = (endpoint, id) => `gh api ${endpoint} -f query='mutation { markPullRequestReadyForReview(input: { pullRequestId: "${id}" }) { clientMutationId } }'`;
  const forms = [
    'gh pr ready 7',
    'gh pr ready "#7"',
    'gh pr ready +7',
    'gh pr ready 07',
    `gh pr ready ${URL7}`,
    'gh pr ready feature/absences',
    'gh pr ready',
    'gh pr ready 7 -R acme/notes',
    'gh pr ready 7 --repo=acme/notes',
    'gh pr ready -R github.com/acme/notes 7',
    'GH_REPO=acme/notes gh pr ready 7',
    'echo "$(gh pr ready 7)"',
    "sh -c 'gh pr ready 7'",
    'bash <<EOF\ngh pr ready 7\nEOF',
    'rtk gh pr ready 7',
    `cd ${dir} && gh pr ready 7`,
    graphql('graphql', 'PR_kwDOabc123'),
    "gh api graphql -F id=PR_kwDOabc123 -f query='mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }'",
    // Every spelling gh reads: the scheme, www., any case, a URL's tail, a URL over -R, and -R as a URL, git@, or www.
    'gh pr ready http://github.com/acme/notes/pull/7',
    'gh pr ready https://www.github.com/acme/notes/pull/7',
    'gh pr ready https://GitHub.com/ACME/notes/pull/7',
    `gh pr ready ${URL7}/`,
    `gh pr ready ${URL7}/files`,
    `gh pr ready ${URL7} -R someone/else`,
    'gh pr ready 7 -R https://github.com/acme/notes/',
    'gh pr ready 7 -R git@github.com:acme/notes.git',
    'gh pr ready 7 -R www.github.com/acme/notes',
    'gh pr ready 7 -R ACME/Notes',
    'GH_REPO=https://github.com/acme/notes/ gh pr ready 7',
    // A repository the shell fills in counts as this one, as the merge guard reads it.
    'gh pr ready 7 -R "$REPO"',
    'gh pr ready 7 -R {acme/notes,}',
    // --undo held unless its last value is true to gh.
    'gh pr ready 7 --undo=false',
    'gh pr ready 7 --undo=0',
    'gh pr ready --undo --undo=false 7',
    // The graphql endpoint in any spelling, and a legacy node id.
    graphql('/graphql', 'PR_kwDOabc123'),
    graphql('https://api.github.com/graphql', 'PR_kwDOabc123'),
    graphql('graphql', 'MDExOlB1bGxSZXF1ZXN0MQ=='),
    "gh api graphql -F id=MDExOlB1bGxSZXF1ZXN0MQ== -f query='mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }'",
    // A folder the rule cannot read is the session's: gh resolves the branch there.
    'cd "$PWD" && gh pr ready',
    'cd "$PWD" && gh pr ready feature/absences',
  ];
  for (const command of forms) {
    const denied = reason(command);
    assert.match(denied ?? '', /^Blocked: this marks pull request #7 ready, and its product feedback is still owed/u, command);
    assert.match(denied, /`pr-product-feedback` skill/u, command);
    assert.match(denied, /aidrian pr product-feedback status 7/u, command);
    assert.doesNotMatch(denied, new RegExp(`${OVERRIDE}|opt|auto`, 'u'), 'the deny names neither the override nor the opt-out');
  }
  const { reason: inEnv } = owedNow(dir);
  assert.match(check('gh pr ready 7', { cwd: dir, env: { GH_REPO: 'acme/notes' }, forge: forgeOver(seam({ head: HEAD }).exec) }) ?? '', /#7 ready/u);
  for (const command of ['gh pr ready 7 --undo', 'gh pr ready 7 --undo=true', 'gh pr ready 7 --undo=1', 'gh pr ready 7 --undo=false --undo']) assert.equal(inEnv(command), null, command);
});

test('what the hold cannot read runs with no gh call; only text fed to a shell that names a ready is refused, where git says on', (t) => {
  const on = repo(t);
  const off = repo(t, { feedback: null });
  const runs = [
    'gh pr ready "$PR"',
    'gh pr ready {7,}',
    'gh pr ready [7]',
    'gh pr {ready,} 7',
    'gh pr r?ady 7',
    '{gh,} pr ready 7',
    '"$GH" pr ready 7',
    'for n in 7 8; do gh pr ready $n; done',
    'gh api graphql -f id="$ID" -f query=\'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }\'',
    'gh api graphql -F query=@ready.graphql -F id=PR_kwDOabc123',
    'gh pr create --draft --title x --body "$(cat <<\'EOF\'\nOnce green, run gh pr ready 7.\nEOF\n)"',
    'git commit -m "docs: run gh pr ready after status"',
  ];
  for (const command of runs) {
    const held = owedNow(on);
    assert.equal(held.reason(command), null, command);
    assert.equal(held.calls.length, 0, `${command}: no network for what it cannot read`);
  }
  // An id that names no pull request marks none the hold can check.
  const ghost = owedNow(on);
  assert.equal(ghost.reason('gh api graphql -f query=\'mutation { markPullRequestReadyForReview(input: { pullRequestId: "PR_kwDOnotapull" }) { clientMutationId } }\''), null);
  assert.equal(ghost.calls.length, 1);
  const fed = [
    "echo 'gh pr ready 7' | bash",
    'echo \'gh pr "ready" 7\' | bash',
    'echo \'gh pr re""ady 7\' | bash',
    'bash -c "$(printf \'gh pr re%sdy 7\' a)"',
  ];
  for (const command of fed) {
    const held = owedNow(on);
    assert.equal(held.reason(command), FED_REASON, command);
    assert.equal(held.calls.length, 0, `${command}: no network to refuse what it cannot read`);
    const free = owedNow(off);
    assert.equal(free.reason(command), null, command);
    assert.equal(free.calls.length, 0, command);
  }
});

test('a heredoc piped into a shell that names a ready is refused as shell-fed; one that names none, or feeds a file, runs', (t) => {
  const on = repo(t);
  const off = repo(t, { feedback: null });
  for (const command of [
    "cat <<'EOF' | bash\ngh pr ready 7\nEOF",
    "cat <<'EOF' | tee x | bash\ngh pr ready 7\nEOF",
    "cat - <<'EOF' | sh\nfor n in 7; do gh pr ready $n; done\nEOF",
  ]) {
    const held = owedNow(on);
    assert.equal(held.reason(command), FED_REASON, command);
    assert.equal(held.calls.length, 0, `${command}: no network to refuse what it cannot read`);
    const free = owedNow(off);
    assert.equal(free.reason(command), null, `${command}: a project without the key`);
  }
  for (const command of ["cat <<'EOF' | bash\nnpm test\nEOF", "cat > notes.md <<'EOF'\ngh pr ready 7\nEOF"]) {
    const held = owedNow(on);
    assert.equal(held.reason(command), null, command);
    assert.equal(held.calls.length, 0, command);
  }
});

test('a command that marks more than one pull request ready is refused where product feedback may run, with no gh call', (t) => {
  const on = repo(t);
  const off = repo(t, { feedback: null });
  const many = [
    'gh pr ready 8; gh pr ready 7',
    'gh pr ready 8 || gh pr ready 8; gh pr ready 7',
    'gh pr ready 7 && gh pr ready "$PR"',
    "gh api graphql -f query='mutation { a: markPullRequestReadyForReview(input: { pullRequestId: \"PR_kwDOabc123\" }) { clientMutationId } b: markPullRequestReadyForReview(input: { pullRequestId: \"PR_kwDOother1\" }) { clientMutationId } }'",
  ];
  for (const command of many) {
    const held = owedNow(on);
    assert.equal(held.reason(command), MANY_REASON, command);
    assert.match(MANY_REASON, /one `gh pr ready <n>` per command/u);
    assert.equal(held.calls.length, 0, command);
    const free = owedNow(off);
    assert.equal(free.reason(command), null, command);
    assert.equal(free.calls.length, 0, command);
  }
});

test('a project without the key, or a machine that opted out, pays no gh call; a command that names no ready starts nothing', (t) => {
  const masterDefault = { feedback: null, refs: 'master', extra: { git: { defaultBranch: 'master' } } };
  const cases = [{ feedback: null }, { feedback: { auto: false, files: ['src/**'] } }, { local: false },
    // A master default branch with no origin/HEAD: origin/<git.defaultBranch> answers, and a read git cannot make lets it run.
    masterDefault, { feedback: null, refs: 'master' }, { feedback: null, refs: 'none' }];
  for (const options of cases) {
    const dir = repo(t, options);
    for (const command of ['gh pr ready 7', 'gh pr ready "$PR"', "echo 'gh pr ready 7' | sh"]) {
      const { calls, reason } = owedNow(dir);
      assert.equal(reason(command), null, `${JSON.stringify(options)}: ${command}`);
      assert.equal(calls.length, 0, `${JSON.stringify(options)}: ${command}`);
    }
  }
  // origin/<git.defaultBranch> is read: on there, with HEAD's config dropping the key, holds.
  const master = repo(t, { refs: 'master', extra: { git: { defaultBranch: 'master' } } });
  writeFileSync(path.join(master, '.aidrian/config.json'), configText(null, { git: { defaultBranch: 'master' } }));
  commitAll(gitIn(master), 'drop the key on the branch', '-a');
  assert.match(owedNow(master).reason('gh pr ready 7') ?? '', /still owed/u, 'on at origin/master');
  // A local opt-in on a team that has not turned it on asks GitHub, and holds.
  const optedIn = repo(t, { feedback: null, local: true });
  assert.match(owedNow(optedIn).reason('gh pr ready 7') ?? '', /still owed/u);
  const dir = repo(t);
  const { calls, reason } = owedNow(dir);
  for (const command of ['git status', 'gh pr view 7', 'gh pr merge 7 --squash', 'echo ready', 'grep -r "gh pr ready" docs']) assert.equal(reason(command), null, command);
  assert.equal(calls.length, 0);
});

test('the hold lets the command run when clear, when a read fails, for another repository, and with the override', (t) => {
  const dir = repo(t);
  assert.equal(feedback(dir, HEAD, 'record', URL7, '--none-found', '--read-by', 'product-manager'), 0);
  assert.equal(owedNow(dir).reason('gh pr ready 7'), null, 'clear: nothing open');
  assert.equal(owedNow(dir).reason("gh api graphql -f query='mutation { markPullRequestReadyForReview(input: { pullRequestId: \"PR_kwDOabc123\" }) { clientMutationId } }'"), null, 'clear through graphql');

  const fresh = repo(t);
  const failing = () => {
    throw Object.assign(new Error('gh failed'), { stderr: 'gh: HTTP 502\n', status: 1 });
  };
  assert.equal(check('gh pr ready 7', { cwd: fresh, env: {}, forge: forgeOver(failing) }), null, 'gh failing lets it run');
  assert.equal(owedNow(fresh).reason('gh pr ready 7 -R someone/else'), null, 'a repository no remote holds');
  assert.equal(owedNow(fresh).reason(`gh pr ready https://github.com/someone/else/pull/7`), null);
  const { calls, exec } = seam({ head: HEAD });
  assert.equal(check('gh pr ready 7', { cwd: fresh, env: { [OVERRIDE]: '1' }, forge: forgeOver(exec) }), null, 'the override in the hook environment');
  assert.equal(calls.length, 0);
  assert.match(check(`${OVERRIDE}=1 gh pr ready 7`, { cwd: fresh, env: {}, forge: forgeOver(exec) }) ?? '', /still owed/u, 'an inline setter lifts nothing');
  assert.match(check(`export ${OVERRIDE}=1; gh pr ready 7`, { cwd: fresh, env: {}, forge: forgeOver(exec) }) ?? '', /still owed/u);
});

test('every gh call shares one deadline, and a gh that stalls past it lets the command run', (t) => {
  assert.ok(DEADLINE_MS < 4000 && HOOK_BUDGET_MS < 5000, 'inside the hook\'s 5 s');
  const dir = repo(t);
  let clock = 1_000_000;
  const given = [];
  // Each call takes 1.5 s of the clock, and a call given less time than that stalls past it, as execFileSync's timeout stops it.
  const exec = (_, args, options) => {
    given.push(options.timeout);
    if (options.timeout < 1500) {
      clock += options.timeout;
      throw Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT' });
    }
    clock += 1500;
    return answer(args, { head: HEAD, config: configText(ON) });
  };
  assert.equal(check('gh pr ready 7', { cwd: dir, env: {}, forge: forgeOver(exec), now: () => clock }), null);
  assert.ok(given.length >= 2, `${given}`);
  assert.equal(given[0], DEADLINE_MS);
  for (let i = 1; i < given.length; i += 1) assert.equal(given[i], DEADLINE_MS - 1500 * i, 'each call gets what is left');
  assert.ok(clock - 1_000_000 <= DEADLINE_MS, 'nothing runs past the deadline');
  // A hook that started 3.9 s ago leaves the rule 0.1 s, whatever DEADLINE_MS says.
  const late = [];
  const lateExec = (...call) => {
    const options = call[2];
    late.push(options.timeout);
    throw Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT' });
  };
  assert.equal(check('gh pr ready 7', { cwd: dir, env: {}, forge: forgeOver(lateExec), now: () => 5_000, startedAt: 1_100 }), null);
  assert.deepEqual(late, [HOOK_BUDGET_MS - 3_900]);
  // performance.timeOrigin, the hook's `startedAt`, has a fraction; execFileSync takes whole milliseconds only.
  const whole = [];
  const strict = (_, args, options) => {
    whole.push(options.timeout);
    if (!Number.isInteger(options.timeout)) throw new RangeError('The value of "timeout" is out of range. It must be an unsigned integer.');
    return answer(args, { head: HEAD, config: configText(ON) });
  };
  assert.match(check('gh pr ready 7', { cwd: dir, env: {}, forge: forgeOver(strict), now: () => 5_000, startedAt: 2_000.6 }) ?? '', /still owed/u);
  assert.ok(whole.length && whole.every(Number.isInteger), `${whole}`);
});

test('a defect answered fix-now, fixed, and re-checked confirmed reaches ready; reopened leaves the draft', (t) => {
  const dir = repo(t);
  recordDefect(dir);
  assert.match(owedNow(dir).reason('gh pr ready 7') ?? '', /The absence list loses its filter on reload.*answer 7 PF1 fix-now/u);
  assert.equal(feedback(dir, HEAD, 'answer', URL7, 'PF1', 'fix-now'), 0);
  // The fix moves the head; until a re-check records it, the hold names the re-check.
  assert.match(owedNow(dir, { head: LATER }).reason('gh pr ready 7') ?? '', /recheck 7 PF1 confirmed\|reopened/u);
  assert.equal(feedback(dir, LATER, 'recheck', URL7, 'PF1', 'reopened'), 0);
  assert.match(owedNow(dir, { head: LATER }).reason('gh pr ready 7') ?? '', /still owed/u, 'reopened stays owed');
  assert.equal(feedback(dir, LATER, 'recheck', URL7, 'PF1', 'confirmed'), 0);
  assert.equal(owedNow(dir, { head: LATER }).reason('gh pr ready 7'), null, 'confirmed at a later head clears');
});

test('an open product choice holds the draft, and the deny says the choice is the Human\'s', (t) => {
  const dir = repo(t);
  const items = path.join(dir, '../state/tmp/items.json');
  writeFileSync(items, JSON.stringify([{ source: 'product-manager', title: 'Whether a cancelled absence frees its shift', kind: 'choice' }]));
  assert.equal(feedback(dir, HEAD, 'record', URL7, '--items', items), 0);
  const denied = owedNow(dir).reason('gh pr ready 7') ?? '';
  assert.match(denied, /A product choice is the Human's/u);
  assert.match(denied, /leave the draft/u);
});

test('the MCP form holds draft false through the server\'s two tools, and passes draft true or no draft', (t) => {
  const dir = repo(t);
  const { exec } = seam({ head: HEAD });
  const given = { owner: 'acme', repo: 'notes', pullNumber: 7 };
  assert.match(checkMcp({ ...given, draft: false }, { cwd: dir, env: {}, forge: forgeOver(exec) }) ?? '', /#7 ready/u);
  assert.equal(checkMcp({ ...given, draft: true }, { cwd: dir, env: {}, forge: forgeOver(exec) }), null);
  assert.equal(checkMcp({ ...given, title: 'x' }, { cwd: dir, env: {}, forge: forgeOver(exec) }), null, 'an edit with no draft');
  assert.equal(checkMcp({ ...given, draft: false }, { cwd: dir, env: { [OVERRIDE]: '1' }, forge: forgeOver(exec) }), null);
  assert.equal(checkMcp({ ...given, pullNumber: 'seven', draft: false }, { cwd: dir, env: {}, forge: forgeOver(exec) }), null, 'a number it cannot read runs');
  assert.equal(checkMcp({ ...given, owner: 'someone', draft: false }, { cwd: dir, env: {}, forge: forgeOver(exec) }), null, 'another repository');
  // The repository as the call spells it, read by gh: any case is this repository.
  assert.match(checkMcp({ owner: 'ACME', repo: 'Notes', pullNumber: 7, draft: false }, { cwd: dir, env: {}, forge: forgeOver(exec) }) ?? '', /#7 ready/u);
});

test('a call that names its repository is judged in the session\'s project as well, whatever folder it runs in', (t) => {
  const session = repo(t);
  // Another project, with product feedback off and no remote: a cd there does not steer the hold away.
  const other = repo(t, { feedback: null, refs: 'none' });
  gitIn(other)('remote', 'remove', 'origin');
  for (const command of [`cd ${other} && gh pr ready ${URL7}`, `cd ${other} && gh pr ready 7 -R acme/notes`, `cd ${other} && GH_REPO=acme/notes gh pr ready 7`,
    `cd ${other} && gh api graphql -f query='mutation { markPullRequestReadyForReview(input: { pullRequestId: "PR_kwDOabc123" }) { clientMutationId } }'`]) {
    assert.match(owedNow(session).reason(command) ?? '', /#7 ready/u, command);
  }
  // A call that names no repository is the folder's: gh reads that folder's branch.
  assert.equal(owedNow(session).reason(`cd ${other} && gh pr ready 7`), null);
});

test('the committed config is found where each ref puts it, and only off at every ref, with no feedback kept, lets it run unasked', (t) => {
  // A branch that moves the project folder does not move the default branch's config, even onto a folder it holds.
  const moved = repo(t);
  const git = gitIn(moved);
  mkdirSync(path.join(moved, 'cfg2'));
  writeFileSync(path.join(moved, 'cfg2/config.json'), configText(null));
  git('add', '.');
  commitAll(git, 'a second folder, with no key');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  writeFileSync(path.join(moved, '.aidrian.json'), JSON.stringify({ dir: 'cfg2' }));
  git('add', '.');
  commitAll(git, 'move the project folder');
  assert.match(owedNow(moved).reason('gh pr ready 7') ?? '', /still owed/u, 'origin/HEAD keeps .aidrian/config.json');
  // A default branch with no config yet: GitHub decides.
  const adopting = repo(t, { feedback: null, refs: 'none' });
  const bare = gitIn(adopting);
  bare('checkout', '-q', '--orphan', 'empty');
  bare('rm', '-rq', '--cached', '.');
  commitAll(bare, 'nothing', '--allow-empty');
  bare('update-ref', 'refs/remotes/origin/main', 'HEAD');
  bare('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  bare('checkout', '-q', '-f', 'main');
  const asked = owedNow(adopting);
  assert.match(asked.reason('gh pr ready 7') ?? '', /still owed/u, 'a config missing at the ref is a maybe');
  // origin/HEAD moved to a commit with no key, and HEAD with none, naming another default branch: origin/main still says on.
  const rewritten = repo(t);
  const tamper = gitIn(rewritten);
  writeFileSync(path.join(rewritten, '.aidrian/config.json'), configText(null, { git: { defaultBranch: 'elsewhere' } }));
  commitAll(tamper, 'drop the key', '-a');
  tamper('update-ref', '--no-deref', 'refs/remotes/origin/HEAD', 'HEAD');
  assert.match(owedNow(rewritten).reason('gh pr ready 7') ?? '', /still owed/u, 'origin/HEAD alone does not say off');
  // Every ref off, and HEAD on: held.
  const headOn = repo(t, { feedback: null });
  writeFileSync(path.join(headOn, '.aidrian/config.json'), configText(ON));
  commitAll(gitIn(headOn), 'turn it on in the branch', '-a');
  assert.match(owedNow(headOn).reason('gh pr ready 7') ?? '', /still owed/u, 'HEAD raises');
  // Every ref off, and the state folder keeps product feedback: GitHub decides.
  const kept = repo(t, { feedback: null });
  mkdirSync(path.join(kept, '../state/product-feedback'));
  const keptCalls = owedNow(kept);
  assert.match(keptCalls.reason('gh pr ready 7') ?? '', /still owed/u, 'a state folder that keeps product feedback raises');
});

test('status of a project without the feature, or a machine that opted out, makes no gh call', (t) => {
  const run = (dir) => {
    const calls = [];
    const out = [];
    const saved = console.log;
    console.log = (line) => out.push(line);
    try {
      const code = runProductFeedback(['status', '7', '--json'], findProject(dir), { forge: answering((args) => calls.push(args) && answer(args, { head: HEAD, config: configText(ON) })), remotes: () => ['github.com/acme/notes'] });
      return { code, calls, json: JSON.parse(out.join('\n')) };
    } finally {
      console.log = saved;
    }
  };
  for (const [options, reason] of [[{ feedback: null }, 'off'], [{ feedback: { auto: false, files: ['src/**'] } }, 'off'], [{ local: false }, 'opted_out'],
    [{ feedback: null, refs: 'master', extra: { git: { defaultBranch: 'master' } } }, 'off'],
    [{ feedback: null, local: false }, 'off']]) {
    const result = run(repo(t, options));
    assert.deepEqual([result.code, result.json.state, result.json.reason, result.json.pr], [0, 'clear', reason, 7], JSON.stringify(options));
    assert.equal(result.calls.length, 0, JSON.stringify(options));
    if (options.local === false) {
      assert.equal(result.json.why, 'this machine opted out', 'a local opt-out names the machine, not the refs');
    } else if (reason === 'off') {
      const said = 'off from git says what git read, not what the team chose';
      assert.match(result.json.why, /^git's origin refs say product feedback is off/u, said);
    }
  }
  // Without the default branch on origin, only GitHub can say off; with the key on, GitHub decides.
  assert.ok(run(repo(t, { feedback: null, refs: 'none' })).calls.length > 0);
  assert.equal(run(repo(t)).json.reason, 'not_run');
});

test('the pull request is viewed once, and origin/HEAD names the default branch with no call', (t) => {
  const dir = repo(t);
  for (const command of ['gh pr ready 7', 'gh pr ready feature/absences', `gh pr ready ${URL7}`, 'gh pr ready 7 -R acme/notes', `gh pr ready ${URL7} -R someone/else`]) {
    const { calls, reason } = owedNow(dir);
    assert.match(reason(command) ?? '', /still owed/u, command);
    const routes = calls.map(({ args }) => args.join(' '));
    assert.equal(routes.filter((route) => route.startsWith('pr view')).length, 1, `${command}: ${routes.join(' | ')}`);
    assert.ok(!routes.includes('api --hostname github.com repos/acme/notes'), `${command}: ${routes.join(' | ')}`);
    assert.equal(calls.length, 3, `${command}: ${routes.join(' | ')}`);
    // gh takes a URL's repository over -R, and so does the view.
    if (command.includes('someone/else')) assert.ok(!routes.some((route) => route.includes('someone/else')), routes.join(' | '));
  }
});

// The hooks as programs, with the fake gh first on PATH.
function hookRun(dir, script, payload, spec, env = {}) {
  const bin = path.join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_GH}" "$@"\n`, { mode: 0o755 });
  writeFileSync(path.join(dir, 'spec.json'), JSON.stringify({ config: configText(ON), ...spec }));
  const started = Date.now();
  const result = spawnSync(process.execPath, [path.join(ROOT, 'plugins/aidrian/scripts', script)], {
    input: JSON.stringify({ session_id: 's', hook_event_name: 'PreToolUse', ...payload, cwd: dir }),
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, READY_GH_SPEC: path.join(dir, 'spec.json'), AIDRIAN_TELEMETRY: '0', ...env },
  });
  return { ...result, ms: Date.now() - started };
}

test('the Bash hook holds gh pr ready while owed, and a stalled gh lets it run inside the hook\'s time', (t) => {
  const dir = repo(t);
  const bash = (command, spec, env) => hookRun(dir, 'hook-bash.mjs', { tool_name: 'Bash', tool_input: { command } }, spec, env);
  const held = bash('gh pr ready 7', { head: HEAD });
  assert.equal(held.status, 2, held.stderr);
  assert.match(held.stderr, /product feedback is still owed/u);
  assert.equal(bash('gh pr ready 7', { head: HEAD }, { [OVERRIDE]: '1' }).status, 0, 'the override in the session environment');
  const stalled = bash('gh pr ready 7', { head: HEAD, sleepMs: 20_000 });
  assert.equal(stalled.status, 0, stalled.stderr);
  assert.ok(stalled.ms < 5000, `the hook took ${stalled.ms} ms`);
});

test('a command that marks ready and merges leaves the merge guard its time: a stalled gh still refuses the merge inside 5 s', (t) => {
  const dir = repo(t);
  // A review record the merge guard reads, so it needs the head from gh.
  const state = emptyState(7, 'acme/notes');
  state.rounds.push({ head: HEAD });
  state.outcome = { status: 'received', head: HEAD, at: '2026-11-03T14:00:00.000Z' };
  writeLocalState(projectAt(dir), state);
  const both = hookRun(dir, 'hook-bash.mjs', { tool_name: 'Bash', tool_input: { command: 'gh pr ready 7 && gh pr merge 7 --squash' } }, { head: HEAD, sleepMs: 20_000 });
  assert.equal(both.status, 2, both.stderr);
  assert.match(both.stderr, /merge guard could not read its head commit/u);
  assert.ok(both.ms < 5000, `the hook took ${both.ms} ms`);
});

test('the GitHub MCP hook holds the server\'s tools and Codex\'s connector tool that marks ready', (t) => {
  const dir = repo(t);
  const mcp = (tool_name, tool_input) => hookRun(dir, 'hook-mcp-github.mjs', { tool_name, tool_input }, { head: HEAD });
  const given = { owner: 'acme', repo: 'notes', pullNumber: 7 };
  for (const name of ['mcp__github__update_pull_request', 'mcp__github__update_pull_request_draft_state']) {
    const held = mcp(name, { ...given, draft: false });
    assert.equal(held.status, 2, `${name}: ${held.stderr}`);
    assert.match(held.stderr, /#7 ready/u);
    assert.equal(mcp(name, { ...given, draft: true }).status, 0, name);
  }
  for (const call of [RECORDED.ready, { ...RECORDED.ready, tool_name: 'mcp__codex_apps__github_mark_pull_request_ready_for_review' }]) {
    const held = hookRun(dir, 'hook-mcp-github.mjs', { ...RECORDED.pre, tool_name: call.tool_name, tool_input: { ...call.tool_input, repository_full_name: 'acme/notes', pr_number: 7 } },
      { head: HEAD }, RECORDED.env);
    assert.equal(held.status, 2, `${call.tool_name}: ${held.stderr}`);
    assert.match(held.stderr, /#7 ready/u);
  }
});
