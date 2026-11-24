import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { hookCall } from './hook-call.mjs';

// The pull request rules judge a call by the repository it targets, through the hook, called in this process as the
// host runs its script; the first test runs the real script once.

const HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-bash.mjs');
const ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-pr-target-')));
after(() => rmSync(ROOT, { recursive: true, force: true }));

// Git and the hook see only this environment: no override, and no git variable of the running checkout.
const ENV = {
  PATH: process.env.PATH,
  HOME: ROOT,
  XDG_STATE_HOME: path.join(ROOT, 'state'),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

// A git repository in its own folder, with `remotes` by name and a `.aidrian/config.json` when `config` is given.
function repository(name, remotes, config) {
  const dir = path.join(ROOT, name);
  mkdirSync(dir);
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: dir, env: ENV }).status, 0, args.join(' '));
  git('init', '-q');
  for (const [remote, url] of Object.entries(remotes)) git('remote', 'add', remote, url);
  if (config) {
    mkdirSync(path.join(dir, '.aidrian'));
    writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, ...config }));
  }
  return dir;
}

const OWN = repository('own', { origin: 'git@github.com:acme/own.git', upstream: 'https://github.com/parent/own.git' }, {
  github: { requiredSections: ['Summary'], pullRequest: { title: '^feat: ', sharedTempBodyFile: false } },
  attribution: { pullRequest: ['tool'] },
});
const OTHER = repository('other', { origin: 'https://github.com/acme/other.git' }, { github: { requiredSections: ['Why'], pullRequest: { title: '^other: ', sharedTempBodyFile: false } } });
const PLAIN = repository('plain', { origin: 'https://github.com/acme/plain.git' });
const NO_REMOTE = repository('no-remote', {}, { github: { requiredSections: ['Summary'], pullRequest: { sharedTempBodyFile: false } } });
const TEMP_RULE = repository('temp-rule', { origin: 'https://github.com/acme/temp-rule.git' }, { github: { pullRequest: { sharedTempBodyFile: true } } });

const WHY = path.join(ROOT, 'why.md');
const SUMMARY = path.join(ROOT, 'summary.md');
const FOOTER = path.join(ROOT, 'footer.md');
writeFileSync(WHY, '## Why\nThe reason.\n');
writeFileSync(SUMMARY, '## Summary\nThe change.\n');
writeFileSync(path.join(OTHER, 'f'), '## Why\nThe reason.\n');
writeFileSync(FOOTER, '## Why\nThe reason.\n\nGenerated with [Claude Code](https://claude.com/claude-code)\n');

const hookInput = (command, cwd) => JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd, transcript_path: path.join(ROOT, 'none.jsonl'), session_id: 's' });

async function hook(command, cwd = OWN, env = {}) {
  const { status, stderr } = await hookCall(HOOK, { input: hookInput(command, cwd), env: { ...ENV, ...env } });
  return { status, stderr };
}

// The hook as its own process, as the host runs it.
function hookProcess(command, cwd = OWN) {
  const { status, stderr } = spawnSync(process.execPath, [HOOK], { input: hookInput(command, cwd), encoding: 'utf8', env: ENV });
  return { status, stderr };
}

const refuses = async (command, pattern, cwd) => {
  const { status, stderr } = await hook(command, cwd);
  assert.equal(status, 2, `refused: ${command}`);
  assert.match(stderr, pattern, command);
};
const passes = async (command, cwd) => {
  const { status, stderr } = await hook(command, cwd);
  assert.deepEqual([status, stderr], [0, ''], command);
};

const noSummary = /^Blocked: the body has no `## Summary` section/;
const noWhy = /^Blocked: the body has no `## Why` section/;
// The refusal of a post whose folder names no project the hook can read (pr-body unreadDestination).
const unreadable = /^Blocked: (?:gh runs in a folder this hook cannot read|the `cd` into \S+ is joined to gh by a `;` or a newline)[^\n]*, and the rules of the repository it posts to cannot be read\./;

// Each of `befores` whose gh call, with a body PLAIN's empty rules would let through, the hook did not refuse as one
// whose folder it cannot read.
async function unrefused(befores) {
  const missed = [];
  for (const before of befores) if (!unreadable.test((await hook(`${before} gh pr edit 1 --body-file ${FOOTER}`)).stderr)) missed.push(before);
  return missed;
}

test("the session's own repository keeps its rules", async () => {
  const refused = hookProcess(`gh pr edit 1 --body-file ${WHY}`);
  assert.equal(refused.status, 2, 'the real script refuses');
  assert.match(refused.stderr, noSummary);
  assert.deepEqual(Object.values(hookProcess(`gh pr edit 1 --body-file ${SUMMARY}`)), [0, ''], 'the real script lets it run');
  await await refuses(`gh pr edit 1 --body-file ${WHY}`, noSummary);
  await await passes(`gh pr edit 1 --body-file ${SUMMARY}`);
});

test('a -R or a pull request URL that names the session\'s repository keeps its rules, in any spelling', async () => {
  for (const repo of ['acme/own', 'ACME/Own', 'github.com/acme/own', 'https://github.com/acme/own']) {
    await refuses(`gh pr edit 1 -R ${repo} --body-file ${WHY}`, noSummary);
  }
  await refuses(`gh -R acme/own pr edit 1 --body-file ${WHY}`, noSummary);
  await refuses(`gh pr edit 1 --repo=acme/own --body-file ${WHY}`, noSummary);
  await refuses(`gh pr edit https://github.com/acme/own/pull/1 --body-file ${WHY}`, noSummary);
  await refuses(`GH_REPO=acme/own gh pr edit 1 --body-file ${WHY}`, noSummary);
});

test('a -R naming another remote of the checkout is the same project: a fork\'s parent keeps the rules', async () => {
  await refuses(`gh pr edit 1 -R parent/own --body-file ${WHY}`, noSummary);
});

test('a target the rule cannot read keeps the rules of the folder the call runs in', async () => {
  await refuses(`gh pr edit 1 -R "$REPO" --body-file ${WHY}`, noSummary);
  await refuses(`gh pr edit 1 -R notarepo --body-file ${WHY}`, noSummary);
  await refuses(`GH_REPO="$REPO" gh pr edit 1 --body-file ${WHY}`, noSummary);
  await refuses(`gh pr edit 1 -R other/repo --body-file ${WHY}`, /^Blocked: the body has no `## Summary` section/, NO_REMOTE);
});

test("another project's rules apply where the call runs: env -C and a leading cd", async () => {
  await passes(`env -C ${OTHER} gh pr edit 1 --body-file f`);
  await passes(`env -C ${OTHER} gh pr edit 1 --body-file ${WHY}`);
  await refuses(`env -C ${OTHER} gh pr edit 1 --body-file ${SUMMARY}`, noWhy);
  await passes(`cd ${OTHER} && gh pr create --draft --title 'other: x' --body-file ${WHY}`);
  await refuses(`cd ${OTHER} && gh pr create --draft --title 'other: x' --body-file ${SUMMARY}`, noWhy);
  await refuses(`env -C ${OTHER} gh pr edit 1 --title 'feat: x'`, /does not match config\.json `github\.pullRequest\.title`/);
  await passes(`env -C ${OTHER} gh pr edit 1 --title 'other: x'`);
  await refuses(`env -C ${OTHER} gh pr edit 1 --body-file ${FOOTER}`, /carries the "Generated with \[Claude Code\]" footer/);
});

test('a post from a folder a variable holds is refused, even with a body the session\'s rules pass, and names the form that is read', async () => {
  // A variable's value at run time is not read: an assignment may sit in a branch that never ran, or be unset since.
  // The session's project, which a SUMMARY body satisfies, never stands in for the rules of the repository gh posts to.
  for (const line of [`W=${OTHER}; env -C "$W" gh`, `env -C $W gh`, `cd "$W" && gh`]) {
    for (const body of [WHY, SUMMARY]) {
      const { status, stderr } = await hook(`${line} pr edit 1 --body-file ${body}`);
      assert.equal(status, 2, line);
      assert.match(stderr, unreadable, line);
      assert.ok(stderr.includes(`the rules of ${OWN}, the session's project, never stand in for them`), stderr);
      assert.ok(stderr.includes('as `env -C <the folder, written out> gh …` or `cd <the folder, written out> && gh …`'), stderr);
    }
  }
  // A comment and an issue, which the public text rule reads, and a pull request the attribution rule asks lines of.
  await refuses(`cd "$W" && gh pr comment 1 --body ok`, unreadable);
  await refuses(`cd "$W" && gh issue create --title t --body ok`, unreadable);
  await refuses(`cd "$W" && gh pr create --title 'feat: x' --body-file ${SUMMARY}`, unreadable);
  // A call that posts no text, or a help or web call, has nothing to check.
  await passes('cd "$W" && gh pr edit 1 --add-label x');
  await passes('cd "$W" && gh pr create --web');
  await passes('cd "$W" && gh pr close 1');
});

test("a post after a cd into another project joined by ; is refused, naming that folder; one that names the session's repository keeps its rules", async () => {
  const { stderr } = await hook(`cd ${OTHER} && true; gh pr edit 1 --body-file ${WHY}`);
  assert.match(stderr, unreadable);
  assert.ok(stderr.includes(`the \`cd\` into ${OTHER} is joined to gh`), stderr);
  assert.ok(stderr.includes(`as \`env -C ${OTHER} gh …\``), stderr);
  // A -R that names the session's repository says where it posts: its rules, with the note on why they are the session's.
  const named = await hook(`cd ${OTHER} && true; gh pr edit 1 -R acme/own --body-file ${WHY}`);
  assert.match(named.stderr, noSummary);
  assert.ok(named.stderr.includes(`These are the rules of ${OWN}, the session's project`), named.stderr);
  assert.ok(named.stderr.includes(`run \`env -C ${OTHER} gh …\``), named.stderr);
  assert.ok(named.stderr.indexOf('These are the rules') < named.stderr.indexOf('To override'), 'the note sits before the override line');
  // No cd, or a cd into the session's own project, which gh answers to whether it works or not: its rules, no note.
  assert.ok(!(await hook(`gh pr edit 1 --body-file ${WHY}`)).stderr.includes('These are the rules'));
  await refuses(`cd ${OWN} && true; gh pr edit 1 --body-file ${WHY}`, noSummary);
  await passes(`cd ${OWN} && true; gh pr edit 1 --title 'feat: x' --body-file ${SUMMARY}`);
});

test('a later cd joined to gh by && alone still names the project gh answers to', async () => {
  const body = path.join(OTHER, 'b.md');
  await passes(`cat > ${body} <<'EOF'\n## Why\nThe reason.\nEOF\ncd ${OTHER} && gh pr edit 1 --body-file ${body}`);
  await passes(`true; cd ${OTHER} && gh pr edit 1 --body-file ${WHY}`);
  await refuses(`true; cd ${OTHER} && gh pr edit 1 --body-file ${SUMMARY}`, noWhy);
  await passes(`(cd ${OTHER} && gh pr edit 1 --body-file ${WHY})`);
  await passes(`cd ${path.dirname(OTHER)} && cd other && gh pr edit 1 --body-file ${WHY}`);
  await passes(`true; cd ${OTHER} && git status && env -C . gh pr edit 1 --body-file ${WHY}`);
  await passes(`true; cd ${OTHER} && url=$(gh pr edit 1 --body-file ${WHY})`);
  await passes(`true; cd ${OTHER} && sh -c 'gh pr edit 1 --body-file ${WHY}'`);
});

test('a post after a cd gh may run without is refused, as its folder is not known', async () => {
  for (const line of [`cd ${OTHER}; gh`, `cd ${OTHER} || gh`, `(cd ${OTHER}); gh`, `(cd ${OTHER}) && gh`, `(cd ${OTHER} && true) && gh`, `cd ${OTHER} | cat; gh`, `true; cd ${OTHER} && true; gh`, `true; cd ${OTHER} && true || gh`, `cd "$WT" && gh`, 'cd - && gh', `true; cd "$WT" && gh`]) {
    await refuses(`${line} pr edit 1 --body-file ${WHY}`, unreadable);
  }
  await refuses(`true; cd ${OWN} && gh pr edit 1 --body-file ${WHY}`, noSummary);
});

test('a cd that may not move the shell gh runs in leaves its folder unknown, and the post is refused', async () => {
  const judged = await unrefused([
    `true || cd ${PLAIN} &&`, // skipped: `true` already succeeded
    `true | cd ${PLAIN} &&`, // in a pipeline's own process
    `true |& cd ${PLAIN} &&`,
    `cd ${OTHER} || cd ${PLAIN} &&`, // the second is skipped when the first works
    `true || cd ${PLAIN} && true &&`,
    `! cd ${PLAIN} &&`, // gh runs only when the cd failed
    `(cd ${PLAIN}) > /dev/null &&`, // a subshell, with a redirect after it
    `(cd ${PLAIN} && true) 2>&1 &&`,
    `cd ${PLAIN} && true & true;`, // the list before `&` runs in the background
    `cd ${PLAIN} && true &`,
    `true; cd ${PLAIN} & true &&`,
    `env cd ${PLAIN} &&`, // a wrapper runs the cd in its own process
    `nohup cd ${PLAIN} &&`,
    `cd ${path.join(ROOT, 'missing')} && true;`, // a cd that fails leaves gh where it was
    `cd ${path.join(ROOT, 'missing')} && true ||`,
  ]);
  assert.deepEqual(judged.map((before) => before.replaceAll(ROOT, '')), [], 'each of these must be refused as a folder the hook cannot read');
  await refuses(`true || cd ${PLAIN} && gh pr create --title 'feat: x' --body-file ${SUMMARY}`, unreadable);
  await refuses(`true | cd ${PLAIN} && gh pr create --title 'feat: x' --body-file ${SUMMARY}`, unreadable);
});

test('a cd holds only when every link to gh is && in the same shell: a folder that exists can still refuse entry', async () => {
  // The hook never tries the cd, so any folder shows it: gh would stay in the session's checkout if this cd failed.
  const judged = await unrefused([
    `cd ${PLAIN} && true;`,
    `cd ${PLAIN} && true\n`,
    `cd ${PLAIN} && true ||`,
    `cd ${PLAIN} && true | cat &&`,
    `cd ${PLAIN} && (true) &&`,
    `cd ${PLAIN} && ! true &&`,
    `true; cd ${PLAIN} && true;`,
  ]);
  assert.deepEqual(judged.map((before) => before.replaceAll(ROOT, '')), [], 'each of these must be refused as a folder the hook cannot read');
  await refuses(`cd ${OTHER} && true; gh pr edit 1 --body-file ${WHY}`, unreadable);
  await refuses(`cd ${OTHER} && true | cat; gh pr edit 1 --body-file ${WHY}`, unreadable);
});

test('gh on a new line after a heredoc write is refused as a folder the hook cannot read; joined on its first line, or by env -C or -R, it is judged', async () => {
  const body = path.join(OTHER, 'c.md');
  const write = `cat > ${body} <<'EOF'`;
  await refuses(`cd ${OTHER} && ${write}\n## Why\nThe reason.\nEOF\ngh pr edit 1 --body-file ${body}`, unreadable);
  await passes(`cd ${OTHER} && ${write} && gh pr edit 1 --body-file ${body}\n## Why\nThe reason.\nEOF`);
  await refuses(`cd ${OTHER} && ${write} && gh pr edit 1 --body-file ${body}\n## Summary\nThe change.\nEOF`, noWhy);
  await passes(`${write}\n## Why\nThe reason.\nEOF\nenv -C ${OTHER} gh pr edit 1 --body-file ${body}`);
  await passes(`cd ${OTHER} && ${write}\n## Why\nThe reason.\nEOF\ngh pr edit 1 -R acme/other --body-file ${body}`);
});

test('a parenthesis in a quoted or escaped word ends no subshell', async () => {
  for (const word of [`'ready (ok)'`, `"ready (ok)"`, 'ready\\)']) {
    await passes(`true; cd ${OTHER} && printf '%s' ${word} extra && gh pr edit 1 --body-file ${WHY}`);
    await refuses(`true; cd ${OTHER} && printf '%s' ${word} extra && gh pr edit 1 --body-file ${SUMMARY}`, noWhy);
  }
});

test('a cd joined by && holds whatever ran before it, and into the shell it starts', async () => {
  await passes(`true || cd ${PLAIN} && cd ${OTHER} && gh pr edit 1 --body-file ${WHY}`);
  await passes(`true & cd ${OTHER} && gh pr edit 1 --body-file ${WHY}`);
  await passes(`(cd ${OTHER} && gh pr edit 1 --body-file ${WHY})`);
  await passes(`cd ${OTHER} && sh -c 'true; gh pr edit 1 --body-file ${WHY}'`);
});

test('a -R naming the repository of the folder the call runs in takes that project\'s rules', async () => {
  await passes(`env -C ${OTHER} gh pr edit 1 -R acme/other --body-file ${WHY}`);
  await refuses(`env -C ${OTHER} gh pr edit 1 -R acme/other --body-file ${SUMMARY}`, noWhy);
  await passes(`cd ${OTHER} && gh pr edit 1 -R acme/other --body-file ${WHY}`);
  await refuses(`gh pr edit 1 -R acme/other --body-file ${SUMMARY}`, noWhy, OTHER);
});

test("a repository whose rules the machine cannot find answers to none of this project's", async () => {
  await passes(`gh pr edit 1 -R other/repo --body-file ${WHY}`);
  await passes(`gh pr edit "$N" -R other/repo --body-file ${WHY}`);
  await passes(`gh pr edit 1 --repo other/repo --body-file ${FOOTER}`);
  await passes(`gh -R other/repo pr edit 1 --title 'free form' --body-file ${WHY}`);
  await passes(`gh pr edit https://github.com/other/repo/pull/1 --body-file ${WHY}`);
  await passes(`GH_REPO=other/repo gh pr edit 1 --body-file ${WHY}`);
  await passes(`gh pr create -R other/repo --title 'free form' --fill`);
  await passes(`gh pr create -R other/repo --title 'free form' --head acme:x`);
});

test('a GH_REPO in the session names the target, and a -R or an unset on the command overrides it', async () => {
  const inSession = { GH_REPO: 'other/repo' };
  assert.equal((await hook(`gh pr edit 1 --body-file ${WHY}`, OWN, inSession)).status, 0);
  assert.equal((await hook(`gh pr edit 1 -R acme/own --body-file ${WHY}`, OWN, inSession)).status, 2);
  assert.equal((await hook(`env -u GH_REPO gh pr edit 1 --body-file ${WHY}`, OWN, inSession)).status, 2);
  assert.equal((await hook(`gh pr edit 1 --body-file ${WHY}`, OWN, { GH_REPO: 'acme/own' })).status, 2);
});

test("a repository elsewhere does not meet this project's shared temp rule", async () => {
  await refuses(`gh pr edit 1 --body-file ${SUMMARY}`, /is in a shared temp folder/, TEMP_RULE);
  await passes(`gh pr edit 1 -R other/repo --body-file ${SUMMARY}`, TEMP_RULE);
});

test('the later of two -R values is the target, and a call without one in the same line keeps its rules', async () => {
  await refuses(`gh pr edit 1 -R other/repo -R acme/own --body-file ${WHY}`, noSummary);
  await passes(`gh pr edit 1 -R acme/own -R other/repo --body-file ${WHY}`);
  await refuses(`gh pr edit 1 -R other/repo --body-file ${WHY} && gh pr edit 2 --body-file ${WHY}`, noSummary);
});

test('a folder with no project has no rules', async () => {
  await passes(`env -C ${PLAIN} gh pr edit 1 --body-file ${WHY}`);
});

test('the attribution rule asks a pull request for lines only under its own repository', async () => {
  const attribution = /^Blocked: the pull request body lacks its attribution/;
  await refuses(`gh pr create --title 'feat: x' --body-file ${SUMMARY}`, attribution);
  await refuses(`gh pr create -R acme/own --title 'feat: x' --body-file ${SUMMARY}`, attribution);
  await passes(`gh pr create -R other/repo --title 'free form' --body-file ${SUMMARY}`);
  await passes(`GH_REPO=other/repo gh pr create --title 'free form' --body-file ${SUMMARY}`);
  await passes(`cd ${OTHER} && gh pr create --draft --title 'other: x' --body-file ${WHY}`);
  await passes(`true; cd ${OTHER} && gh pr create --draft --title 'other: x' --body-file ${WHY}`);
});
