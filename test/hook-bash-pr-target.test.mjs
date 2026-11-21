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

// Each of `befores` whose gh call the footer rule, which only the session's own repository keeps, did not judge.
async function unjudged(befores, footer) {
  const missed = [];
  for (const before of befores) if (!footer.test((await hook(`${before} gh pr edit 1 --body-file ${FOOTER}`)).stderr)) missed.push(before);
  return missed;
}

const noSummary = /^Blocked: the body has no `## Summary` section/;
const noWhy = /^Blocked: the body has no `## Why` section/;

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

test("a cd gh may run without leaves the session's rules", async () => {
  for (const line of [`cd ${OTHER}; gh`, `cd ${OTHER} || gh`, `(cd ${OTHER}); gh`, `(cd ${OTHER}) && gh`, `(cd ${OTHER} && true) && gh`, `cd ${OTHER} | cat; gh`, `true; cd ${OTHER} && true; gh`, `true; cd ${OTHER} && true || gh`, `cd "$WT" && gh`, 'cd - && gh', `true; cd "$WT" && gh`]) {
    await refuses(`${line} pr edit 1 --body-file ${WHY}`, noSummary);
  }
  await refuses(`true; cd ${OWN} && gh pr edit 1 --body-file ${WHY}`, noSummary);
});

test("a cd that may not move the shell gh runs in leaves the session's rules", async () => {
  const footer = /carries the "Generated with \[Claude Code\]" footer/;
  const judged = await unjudged([
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
  ], footer);
  assert.deepEqual(judged.map((before) => before.replaceAll(ROOT, '')), [], 'each of these must keep the session\'s rules');
  const attribution = /^Blocked: the pull request body lacks its attribution/;
  await refuses(`true || cd ${PLAIN} && gh pr create --title 'feat: x' --body-file ${SUMMARY}`, attribution);
  await refuses(`true | cd ${PLAIN} && gh pr create --title 'feat: x' --body-file ${SUMMARY}`, attribution);
});

test('a cd holds only when every link to gh is && in the same shell: a folder that exists can still refuse entry', async () => {
  // The hook never tries the cd, so any folder shows it: gh would stay in the session's checkout if this cd failed.
  const footer = /carries the "Generated with \[Claude Code\]" footer/;
  const judged = await unjudged([
    `cd ${PLAIN} && true;`,
    `cd ${PLAIN} && true\n`,
    `cd ${PLAIN} && true ||`,
    `cd ${PLAIN} && true | cat &&`,
    `cd ${PLAIN} && (true) &&`,
    `cd ${PLAIN} && ! true &&`,
    `true; cd ${PLAIN} && true;`,
  ], footer);
  assert.deepEqual(judged.map((before) => before.replaceAll(ROOT, '')), [], 'each of these must keep the session\'s rules');
  await refuses(`cd ${OTHER} && true; gh pr edit 1 --body-file ${WHY}`, noSummary);
  await refuses(`cd ${OTHER} && true | cat; gh pr edit 1 --body-file ${WHY}`, noSummary);
});

test('gh on a new line after a heredoc write answers to the session; joined on its first line, or by env -C or -R, it does not', async () => {
  const body = path.join(OTHER, 'c.md');
  const write = `cat > ${body} <<'EOF'`;
  await refuses(`cd ${OTHER} && ${write}\n## Why\nThe reason.\nEOF\ngh pr edit 1 --body-file ${body}`, noSummary);
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
