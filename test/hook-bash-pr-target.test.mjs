import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// The pull request rules judge a call by the repository it targets, through the real hook process.

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

function hook(command, cwd = OWN, env = {}) {
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd, transcript_path: path.join(ROOT, 'none.jsonl'), session_id: 's' });
  const { status, stderr } = spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8', env: { ...ENV, ...env } });
  return { status, stderr };
}

const refuses = (command, pattern, cwd) => {
  const { status, stderr } = hook(command, cwd);
  assert.equal(status, 2, `refused: ${command}`);
  assert.match(stderr, pattern, command);
};
const passes = (command, cwd) => {
  const { status, stderr } = hook(command, cwd);
  assert.deepEqual([status, stderr], [0, ''], command);
};

const noSummary = /^Blocked: the body has no `## Summary` section/;
const noWhy = /^Blocked: the body has no `## Why` section/;

test("the session's own repository keeps its rules", () => {
  refuses(`gh pr edit 1 --body-file ${WHY}`, noSummary);
  passes(`gh pr edit 1 --body-file ${SUMMARY}`);
});

test('a -R or a pull request URL that names the session\'s repository keeps its rules, in any spelling', () => {
  for (const repo of ['acme/own', 'ACME/Own', 'github.com/acme/own', 'https://github.com/acme/own']) {
    refuses(`gh pr edit 1 -R ${repo} --body-file ${WHY}`, noSummary);
  }
  refuses(`gh -R acme/own pr edit 1 --body-file ${WHY}`, noSummary);
  refuses(`gh pr edit 1 --repo=acme/own --body-file ${WHY}`, noSummary);
  refuses(`gh pr edit https://github.com/acme/own/pull/1 --body-file ${WHY}`, noSummary);
  refuses(`GH_REPO=acme/own gh pr edit 1 --body-file ${WHY}`, noSummary);
});

test('a -R naming another remote of the checkout is the same project: a fork\'s parent keeps the rules', () => {
  refuses(`gh pr edit 1 -R parent/own --body-file ${WHY}`, noSummary);
});

test('a target the rule cannot read keeps the rules of the folder the call runs in', () => {
  refuses(`gh pr edit 1 -R "$REPO" --body-file ${WHY}`, noSummary);
  refuses(`gh pr edit 1 -R notarepo --body-file ${WHY}`, noSummary);
  refuses(`GH_REPO="$REPO" gh pr edit 1 --body-file ${WHY}`, noSummary);
  refuses(`gh pr edit 1 -R other/repo --body-file ${WHY}`, /^Blocked: the body has no `## Summary` section/, NO_REMOTE);
});

test("another project's rules apply where the call runs: env -C and a leading cd", () => {
  passes(`env -C ${OTHER} gh pr edit 1 --body-file f`);
  passes(`env -C ${OTHER} gh pr edit 1 --body-file ${WHY}`);
  refuses(`env -C ${OTHER} gh pr edit 1 --body-file ${SUMMARY}`, noWhy);
  passes(`cd ${OTHER} && gh pr create --draft --title 'other: x' --body-file ${WHY}`);
  refuses(`cd ${OTHER} && gh pr create --draft --title 'other: x' --body-file ${SUMMARY}`, noWhy);
  refuses(`env -C ${OTHER} gh pr edit 1 --title 'feat: x'`, /does not match config\.json `github\.pullRequest\.title`/);
  passes(`env -C ${OTHER} gh pr edit 1 --title 'other: x'`);
  refuses(`env -C ${OTHER} gh pr edit 1 --body-file ${FOOTER}`, /carries the "Generated with \[Claude Code\]" footer/);
});

test('a later cd joined to gh by && alone still names the project gh answers to', () => {
  const body = path.join(OTHER, 'b.md');
  passes(`cat > ${body} <<'EOF'\n## Why\nThe reason.\nEOF\ncd ${OTHER} && gh pr edit 1 --body-file ${body}`);
  passes(`true; cd ${OTHER} && gh pr edit 1 --body-file ${WHY}`);
  refuses(`true; cd ${OTHER} && gh pr edit 1 --body-file ${SUMMARY}`, noWhy);
  passes(`(cd ${OTHER} && gh pr edit 1 --body-file ${WHY})`);
  passes(`cd ${path.dirname(OTHER)} && cd other && gh pr edit 1 --body-file ${WHY}`);
  passes(`true; cd ${OTHER} && git status && env -C . gh pr edit 1 --body-file ${WHY}`);
  passes(`true; cd ${OTHER} && url=$(gh pr edit 1 --body-file ${WHY})`);
  passes(`true; cd ${OTHER} && sh -c 'gh pr edit 1 --body-file ${WHY}'`);
});

test("a cd gh may run without leaves the session's rules", () => {
  for (const line of [`cd ${OTHER}; gh`, `cd ${OTHER} || gh`, `(cd ${OTHER}); gh`, `(cd ${OTHER}) && gh`, `(cd ${OTHER} && true) && gh`, `cd ${OTHER} | cat; gh`, `true; cd ${OTHER} && true; gh`, `true; cd ${OTHER} && true || gh`, `cd "$WT" && gh`, 'cd - && gh', `true; cd "$WT" && gh`]) {
    refuses(`${line} pr edit 1 --body-file ${WHY}`, noSummary);
  }
  refuses(`true; cd ${OWN} && gh pr edit 1 --body-file ${WHY}`, noSummary);
});

test("a cd that may not move the shell gh runs in leaves the session's rules", () => {
  const footer = /carries the "Generated with \[Claude Code\]" footer/;
  const judged = [
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
  ].filter((before) => !footer.test(hook(`${before} gh pr edit 1 --body-file ${FOOTER}`).stderr));
  assert.deepEqual(judged.map((before) => before.replaceAll(ROOT, '')), [], 'each of these must keep the session\'s rules');
  const attribution = /^Blocked: the pull request body lacks its attribution/;
  refuses(`true || cd ${PLAIN} && gh pr create --title 'feat: x' --body-file ${SUMMARY}`, attribution);
  refuses(`true | cd ${PLAIN} && gh pr create --title 'feat: x' --body-file ${SUMMARY}`, attribution);
});

test('a cd holds only when every link to gh is && in the same shell: a folder that exists can still refuse entry', () => {
  // The hook never tries the cd, so any folder shows it: gh would stay in the session's checkout if this cd failed.
  const footer = /carries the "Generated with \[Claude Code\]" footer/;
  const judged = [
    `cd ${PLAIN} && true;`,
    `cd ${PLAIN} && true\n`,
    `cd ${PLAIN} && true ||`,
    `cd ${PLAIN} && true | cat &&`,
    `cd ${PLAIN} && (true) &&`,
    `cd ${PLAIN} && ! true &&`,
    `true; cd ${PLAIN} && true;`,
  ].filter((before) => !footer.test(hook(`${before} gh pr edit 1 --body-file ${FOOTER}`).stderr));
  assert.deepEqual(judged.map((before) => before.replaceAll(ROOT, '')), [], 'each of these must keep the session\'s rules');
  refuses(`cd ${OTHER} && true; gh pr edit 1 --body-file ${WHY}`, noSummary);
  refuses(`cd ${OTHER} && true | cat; gh pr edit 1 --body-file ${WHY}`, noSummary);
});

test('gh on a new line after a heredoc write answers to the session; joined on its first line, or by env -C or -R, it does not', () => {
  const body = path.join(OTHER, 'c.md');
  const write = `cat > ${body} <<'EOF'`;
  refuses(`cd ${OTHER} && ${write}\n## Why\nThe reason.\nEOF\ngh pr edit 1 --body-file ${body}`, noSummary);
  passes(`cd ${OTHER} && ${write} && gh pr edit 1 --body-file ${body}\n## Why\nThe reason.\nEOF`);
  refuses(`cd ${OTHER} && ${write} && gh pr edit 1 --body-file ${body}\n## Summary\nThe change.\nEOF`, noWhy);
  passes(`${write}\n## Why\nThe reason.\nEOF\nenv -C ${OTHER} gh pr edit 1 --body-file ${body}`);
  passes(`cd ${OTHER} && ${write}\n## Why\nThe reason.\nEOF\ngh pr edit 1 -R acme/other --body-file ${body}`);
});

test('a parenthesis in a quoted or escaped word ends no subshell', () => {
  for (const word of [`'ready (ok)'`, `"ready (ok)"`, 'ready\\)']) {
    passes(`true; cd ${OTHER} && printf '%s' ${word} extra && gh pr edit 1 --body-file ${WHY}`);
    refuses(`true; cd ${OTHER} && printf '%s' ${word} extra && gh pr edit 1 --body-file ${SUMMARY}`, noWhy);
  }
});

test('a cd joined by && holds whatever ran before it, and into the shell it starts', () => {
  passes(`true || cd ${PLAIN} && cd ${OTHER} && gh pr edit 1 --body-file ${WHY}`);
  passes(`true & cd ${OTHER} && gh pr edit 1 --body-file ${WHY}`);
  passes(`(cd ${OTHER} && gh pr edit 1 --body-file ${WHY})`);
  passes(`cd ${OTHER} && sh -c 'true; gh pr edit 1 --body-file ${WHY}'`);
});

test('a -R naming the repository of the folder the call runs in takes that project\'s rules', () => {
  passes(`env -C ${OTHER} gh pr edit 1 -R acme/other --body-file ${WHY}`);
  refuses(`env -C ${OTHER} gh pr edit 1 -R acme/other --body-file ${SUMMARY}`, noWhy);
  passes(`cd ${OTHER} && gh pr edit 1 -R acme/other --body-file ${WHY}`);
  refuses(`gh pr edit 1 -R acme/other --body-file ${SUMMARY}`, noWhy, OTHER);
});

test("a repository whose rules the machine cannot find answers to none of this project's", () => {
  passes(`gh pr edit 1 -R other/repo --body-file ${WHY}`);
  passes(`gh pr edit "$N" -R other/repo --body-file ${WHY}`);
  passes(`gh pr edit 1 --repo other/repo --body-file ${FOOTER}`);
  passes(`gh -R other/repo pr edit 1 --title 'free form' --body-file ${WHY}`);
  passes(`gh pr edit https://github.com/other/repo/pull/1 --body-file ${WHY}`);
  passes(`GH_REPO=other/repo gh pr edit 1 --body-file ${WHY}`);
  passes(`gh pr create -R other/repo --title 'free form' --fill`);
  passes(`gh pr create -R other/repo --title 'free form' --head acme:x`);
});

test('a GH_REPO in the session names the target, and a -R or an unset on the command overrides it', () => {
  const inSession = { GH_REPO: 'other/repo' };
  assert.equal(hook(`gh pr edit 1 --body-file ${WHY}`, OWN, inSession).status, 0);
  assert.equal(hook(`gh pr edit 1 -R acme/own --body-file ${WHY}`, OWN, inSession).status, 2);
  assert.equal(hook(`env -u GH_REPO gh pr edit 1 --body-file ${WHY}`, OWN, inSession).status, 2);
  assert.equal(hook(`gh pr edit 1 --body-file ${WHY}`, OWN, { GH_REPO: 'acme/own' }).status, 2);
});

test("a repository elsewhere does not meet this project's shared temp rule", () => {
  refuses(`gh pr edit 1 --body-file ${SUMMARY}`, /is in a shared temp folder/, TEMP_RULE);
  passes(`gh pr edit 1 -R other/repo --body-file ${SUMMARY}`, TEMP_RULE);
});

test('the later of two -R values is the target, and a call without one in the same line keeps its rules', () => {
  refuses(`gh pr edit 1 -R other/repo -R acme/own --body-file ${WHY}`, noSummary);
  passes(`gh pr edit 1 -R acme/own -R other/repo --body-file ${WHY}`);
  refuses(`gh pr edit 1 -R other/repo --body-file ${WHY} && gh pr edit 2 --body-file ${WHY}`, noSummary);
});

test('a folder with no project has no rules', () => {
  passes(`env -C ${PLAIN} gh pr edit 1 --body-file ${WHY}`);
});

test('the attribution rule asks a pull request for lines only under its own repository', () => {
  const attribution = /^Blocked: the pull request body lacks its attribution/;
  refuses(`gh pr create --title 'feat: x' --body-file ${SUMMARY}`, attribution);
  refuses(`gh pr create -R acme/own --title 'feat: x' --body-file ${SUMMARY}`, attribution);
  passes(`gh pr create -R other/repo --title 'free form' --body-file ${SUMMARY}`);
  passes(`GH_REPO=other/repo gh pr create --title 'free form' --body-file ${SUMMARY}`);
  passes(`cd ${OTHER} && gh pr create --draft --title 'other: x' --body-file ${WHY}`);
  passes(`true; cd ${OTHER} && gh pr create --draft --title 'other: x' --body-file ${WHY}`);
});
