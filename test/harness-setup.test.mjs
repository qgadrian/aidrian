// The harness-setup skill hands harness-librarian the text it writes into a project from
// references/setup-files.md. These cases hold that text to the files it copies: the example project's team install,
// the plugin manifest's repository, and the AGENTS.md lines of docs/adopting.md.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { pluginRepository } from '../plugins/aidrian/lib/config.mjs';
import { closes, expandTabs, fenceOf, headingOf, indentOf } from '../plugins/aidrian/lib/markdown-sections.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PLUGIN = path.join(ROOT, 'plugins/aidrian');
const SETUP = 'plugins/aidrian/skills/harness-setup/references/setup-files.md';
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const json = (rel) => JSON.parse(read(rel));

// The fenced blocks of a Markdown file, each as { section, lang, body }: `section` is the `## ` heading above it.
// The fence delimiters are the ones lib/markdown-sections.mjs reads, so a fence that opens after a list marker
// ("- ```sh") or sits indented inside a list item counts too; each body line loses the indentation of its fence.
function blocks(rel) {
  const out = [];
  let section = null;
  let open = null;
  const finish = () => {
    out.push({ section: open.section, lang: open.lang, body: open.lines.join('\n') });
    open = null;
  };
  for (const raw of read(rel).split(/\r?\n/u)) {
    const line = expandTabs(raw);
    // A fence opened after a list marker ends where its item ends, as fencedIn reads it.
    if (open?.item != null && line.trim() && indentOf(line) < open.item) finish();
    if (open) {
      if (closes(fenceOf(line), open)) finish();
      else open.lines.push(line.slice(Math.min(open.indent, indentOf(line))));
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) section = heading;
    const fence = fenceOf(line);
    if (fence) {
      const lang = /(?:`{3,}|~{3,})\s*([^\s`]*)/u.exec(line)[1];
      open = { ...fence, section, lang, indent: fence.item ?? indentOf(line), lines: [] };
    }
  }
  assert.equal(open, null, `${rel}: a fence never closes`);
  return out;
}

// The blocks of one language in one section of the setup file.
const setup = (section, lang) => blocks(SETUP).filter((block) => block.section === section && block.lang === lang);

// The `<owner>/<repo>` the manifest's repository names, such as `https://github.com/<owner>/<repo>`.
function slug() {
  const repository = pluginRepository();
  assert.ok(repository, 'plugins/aidrian/plugin.json names no repository');
  return new URL(repository).pathname.replace(/^\/|\.git$/gu, '');
}

// Runs a block of the setup file under sh, with `<plugin root>` filled in as the dispatch brief fills it.
function runSh(body) {
  assert.match(body, /<plugin root>/u, 'the block reads the plugin root from its placeholder');
  return spawnSync('sh', ['-c', body.replaceAll('<plugin root>', PLUGIN)], { cwd: tmpdir(), encoding: 'utf8' });
}

test('the team install block, with the manifest slug, is the example project settings file', () => {
  const [settings, ...extra] = setup('Claude Code team install', 'json');
  assert.equal(extra.length, 0, 'one settings block');
  assert.match(settings.body, /<owner>\/<repo>/u, 'the block holds the slug as a placeholder, never the slug');
  assert.deepEqual(JSON.parse(settings.body.replace('<owner>/<repo>', slug())), json('examples/consumer/.claude/settings.json'));
});

test('the sh blocks print the manifest slug and the Codex install page, and exit 0', () => {
  const [slugBlock, ...extraSlug] = setup('Claude Code team install', 'sh');
  const [codexBlock, ...extraCodex] = setup('Codex', 'sh');
  assert.equal(extraSlug.length + extraCodex.length, 0, 'one sh block per section');

  const printed = runSh(slugBlock.body);
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(printed.stdout, `${slug()}\n`);

  const codex = runSh(codexBlock.body);
  assert.equal(codex.status, 0, codex.stderr);
  assert.equal(codex.stdout, `${pluginRepository()}#codex\n`);
  // The printed page lands on the README's Codex install section, which GitHub anchors as #codex.
  assert.match(read('README.md'), /^#{1,6} Codex$/mu, 'README.md has a Codex heading for the #codex anchor');
});

test('the AGENTS.md lines are the adopting page step 2 lines, and CLAUDE.md holds @AGENTS.md', () => {
  const [agents, claude, ...extra] = setup('AGENTS.md and CLAUDE.md', 'md');
  assert.equal(extra.length, 0, 'two md blocks: AGENTS.md, then CLAUDE.md');
  const adopting = blocks('docs/adopting.md').filter((block) => block.section === '2. Point the main session at the buckets' && block.lang === 'md');
  assert.equal(adopting.length, 1, 'docs/adopting.md step 2 holds one md block');
  assert.equal(agents.body, adopting[0].body);
  assert.equal(claude.body, '@AGENTS.md');
});

test('only the Human runs the skill, and its report prints the labels the onboarding eval reads', () => {
  const skill = read('plugins/aidrian/skills/harness-setup/SKILL.md');
  const [, head] = skill.match(/^---\n([\s\S]*?)\n---\n/u);
  // The skill writes a project's setup: the Human starts it by name, never the model from a request in other words.
  assert.match(head, /^disable-model-invocation: true$/mu);
  assert.doesNotMatch(head, /^user-invocable:/mu);
  // A slash command never calls the Skill tool, so no eval case grades on it.
  for (const name of ['harness-setup-onboard', 'harness-setup-rerun']) {
    const prompt = read(`plugins/aidrian/evals/${name}/prompt.md`).split(/^---\n/mu)[2];
    assert.match(prompt.trimStart(), /^\/aidrian:harness-setup\b/u, `${name} starts with the slash command`);
    const graders = path.join(PLUGIN, 'evals', name, 'graders');
    for (const file of readdirSync(graders)) {
      assert.doesNotMatch(readFileSync(path.join(graders, file), 'utf8'), /^tool: Skill$/mu, `${name}/graders/${file}`);
    }
  }
  const report = skill.slice(skill.indexOf('## 5. Report onboarding'), skill.indexOf('## 6.'));
  assert.match(report, /never bold, rename, or merge it/u);
  for (const label of ['Docs written:', 'Docs skipped:']) assert.ok(report.toLowerCase().includes(`the line \`${label.toLowerCase()}\``), label);
  const graders = read('plugins/aidrian/evals/harness-setup-onboard/graders/written.md');
  assert.match(graders, /pattern: 'Docs written:'/u);
});

test('the report relays the check and lint lines this session ran, and every onboarding shapes the index', () => {
  const skill = read('plugins/aidrian/skills/harness-setup/SKILL.md');
  const section = (from, to) => skill.slice(skill.indexOf(from), skill.indexOf(to));
  // The librarian's brief returns only pending_commit, so the lines the report prints come from this session's own run.
  assert.match(section('## 4.', '## 5.'), /After the last dispatch, run `aidrian check` and `aidrian lint` here, read-only/u);
  assert.match(section('## 5.', '## 6.'), /Every line the step 4 `aidrian check` and `aidrian lint` printed, unchanged/u);
  const lint = read('plugins/aidrian/evals/harness-setup-onboard/graders/lint.md');
  assert.match(lint, /paths: no personal paths/u, 'the onboard grader reads the lint paths line too');
  // A bare index from a quick start still gets its summaries, tags, and always doc, and Q1 still reaches a doc.
  const dispatches = read('plugins/aidrian/skills/harness-setup/references/dispatches.md');
  assert.doesNotMatch(section('## 3.', '## 4.'), /\bR2\b/u);
  assert.doesNotMatch(dispatches, /Only when R2 was missing/u);
  assert.match(dispatches, /An index that exists gets the same pass for each doc whose summary is still the\s+drafted one/u);
  // aidrian-knowledge init drafts a summary from the first heading and first sentence, or the file name.
  assert.match(dispatches, /drafted one \(its first heading and first sentence, or its file name\)/u);
});
