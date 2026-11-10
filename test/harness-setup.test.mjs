// The harness-setup skill hands harness-librarian the text it writes into a project from
// references/setup-files.md. These cases hold that text to the files it copies: the example project's team install,
// the plugin manifest's repository, and the AGENTS.md lines of docs/adopting.md.
import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig, pluginRepository, pluginVersion } from '../plugins/aidrian/lib/config.mjs';
import { nameMatches } from '../plugins/aidrian/lib/agent-gates.mjs';
import { closes, expandTabs, fenceOf, headingOf, indentOf } from '../plugins/aidrian/lib/markdown-sections.mjs';
import { findProject } from '../plugins/aidrian/lib/project.mjs';
import { judgeTrackerWrite, serverPrefix } from '../plugins/aidrian/lib/tracker-guard.mjs';

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

const DISPATCHES = 'plugins/aidrian/skills/harness-setup/references/dispatches.md';
const TRACKER_SECTION = 'The tracker key: Linear only';
// The server names a Linear connection is known to show, on either host.
const LINEAR_SERVERS = ['mcp__plugin_linear_linear__', 'mcp__linear__', 'mcp__linear-server__', 'mcp__linear_server__', 'mcp__claude_ai_Linear__', 'mcp__codex_apps_linear__'];

// The `tracker` value and optional `project` group of the librarian's brief, with the Human's answers filled in.
function briefTracker({ expect, key, name, project }) {
  const [main, group, ...extra] = blocks(DISPATCHES).filter((block) => block.section === TRACKER_SECTION && block.lang === 'json');
  assert.equal(extra.length, 0, 'two json blocks: the key, then its optional project group');
  const fill = (body) => JSON.parse(body.replaceAll('<workspace URL>', expect).replaceAll('<team key>', key).replaceAll('<team name>', name).replaceAll('<project name>', project ?? ''));
  const { tracker } = fill(main.body);
  return project ? { ...tracker, ...fill(group.body) } : tracker;
}

test('the tracker question asks Linear for three answers, and sends the key to config.json and conventions to the doc', () => {
  const row = read('plugins/aidrian/skills/harness-setup/SKILL.md').split('\n').find((line) => line.startsWith('| Q1 Tracker'));
  assert.ok(row, 'SKILL.md has the Q1 row');
  assert.doesNotMatch(row, /Never a config key/u);
  for (const answer of ['workspace URL', 'team key', 'team name']) assert.ok(row.includes(answer), answer);
  assert.match(row, /config\.json `tracker`/u);
  assert.match(row, /Conventions: a doc tagged `issue_tracker`/u);
  // Without this, a Linear project whose doc came first would never be asked for the key.
  assert.match(row, /Linear: config\.json has `tracker`/u);

  const dispatches = read(DISPATCHES);
  assert.match(dispatches, /GitHub Issues writes no key/u);
  assert.match(dispatches, /Q1 Linear to config\.json `tracker` and `requires\.aidrian`/u, 'the step 3 brief allows both config keys');
  // The librarian reads only the files its brief names, so the section with the key has to be one of them.
  assert.match(dispatches, /with Q1 Linear, the absolute path of this file/u);
});

test('what setup writes for Linear passes validation, with and without a project', (t) => {
  const answers = { expect: 'https://linear.app/example', key: 'ABC', name: 'Example team' };
  for (const tracker of [briefTracker(answers), briefTracker({ ...answers, project: 'Launch' })]) {
    const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-setup-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(path.join(dir, '.aidrian'));
    writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, tracker }));
    const { config, errors } = loadConfig({ root: dir, paths: { config: '.aidrian/config.json' } });
    assert.deepEqual(errors, []);
    assert.equal(config.tracker.enabled, true);
    assert.equal(config.tracker.workspace.expect, answers.expect);
    assert.equal(config.tracker.workspace.field, 'url');
    assert.equal(config.tracker.team.key, answers.key);
    assert.deepEqual(config.tracker.team.values, [answers.name]);
    assert.deepEqual(config.tracker.project?.values, tracker.project?.values);
  }
  assert.deepEqual(briefTracker({ ...answers, project: 'Launch' }).project, { values: ['Launch'] });
});

test('setup writes only what a person knows, and the adapter gives every known Linear server the same tools', (t) => {
  const answers = { expect: 'https://linear.app/example', key: 'ABC', name: 'Example team' };
  const brief = briefTracker(answers);
  assert.deepEqual(Object.keys(brief).sort(), ['enabled', 'provider', 'team', 'workspace']);
  assert.deepEqual(brief, { enabled: true, provider: 'linear', workspace: { expect: answers.expect }, team: { key: answers.key, values: [answers.name] } });

  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-setup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, tracker: brief }));
  const { readTools, writeTools } = loadConfig({ root: dir, paths: { config: '.aidrian/config.json' } }).config.tracker;
  assert.deepEqual([...readTools].sort(), LINEAR_SERVERS.map((server) => `${server}get_workspace`).sort());
  const patterns = (server) => writeTools.filter((pattern) => pattern.startsWith(server)).map((pattern) => pattern.slice(server.length));
  const [first, ...others] = LINEAR_SERVERS.map(patterns);
  assert.ok(first.length > 0);
  for (const other of others) assert.deepEqual(other, first);
  assert.equal(writeTools.length, first.length * LINEAR_SERVERS.length, 'no pattern outside the known servers');

  const config = read('docs/config.md').replace(/\s+/gu, ' ');
  for (const server of LINEAR_SERVERS) assert.ok(config.includes(`\`${server}\``), server);
  assert.match(config, /A connection under another server name goes in `servers`/u);
  assert.match(read(DISPATCHES).replace(/\s+/gu, ' '), /A connection under a server name the plugin does not know goes in/u);
});

test('the example project sets the key setup writes', () => {
  const { tracker } = json('examples/consumer/.aidrian/config.json');
  assert.ok(tracker, 'the example config sets tracker');
  assert.deepEqual(tracker, briefTracker({ expect: tracker.workspace.expect, key: tracker.team.key, name: tracker.team.values[0] }));
  assert.deepEqual(loadConfig(findProject(path.join(ROOT, 'examples/consumer'))).errors, []);
});

test('the key setup writes holds Linear writes to the team, and leaves relations free to cross teams', () => {
  const { config } = loadConfig(findProject(path.join(ROOT, 'examples/consumer')));
  const { key, values: [name] } = config.tracker.team;
  const other = 'Other team';
  const refused = {
    save_issue: [{ team: other }, { id: 'OTHER-1' }],
    save_project: [{ addTeams: [other] }, { setTeams: [name, other] }, { leadTeam: other }],
    save_document: [{ team: other }, { issue: 'OTHER-1' }],
    save_comment: [{ issueId: 'OTHER-1' }],
    create_attachment: [{ issue: 'OTHER-1' }],
    create_attachment_from_upload: [{ issue: 'OTHER-1' }],
    prepare_attachment_upload: [{ issue: 'OTHER-1' }],
    share_issue: [{ issue: 'OTHER-1' }],
    unshare_issue: [{ issue: 'OTHER-1' }],
    retire_issue_label: [{ id: 'OTHER-1' }],
    restore_project_label: [{ id: 'OTHER-1' }],
  };
  const allowed = {
    save_issue: [{ team: name }, { team: key }, { id: `${key}-1`, blocks: ['OTHER-1'], blockedBy: ['OTHER-2'], relatedTo: ['OTHER-3'], parentId: 'OTHER-4', duplicateOf: 'OTHER-5' }],
    // A removal takes a write out of a team, so it is not judged as one that puts a write in.
    save_project: [{ addTeams: [name] }, { setTeams: [name] }, { leadTeam: name }, { removeTeams: [other] }],
    save_document: [{ issue: `${key}-1` }],
    save_comment: [{ issueId: `${key}-1` }],
    create_attachment: [{ issue: `${key}-1` }],
    prepare_attachment_upload: [{ issue: `${key}-1` }],
    // It names no issue, so it answers only to the workspace read.
    prepare_file_upload: [{ filename: 'a.png', contentType: 'image/png', size: 1 }],
    share_issue: [{ issue: `${key}-1` }],
    retire_project_label: [{ id: '11111111-2222-4333-8444-555555555555' }],
    // A diff tool names no team and no issue in a field the guard reads, so it answers only to the workspace read.
    update_diff: [{ urlOrId: 'OTHER-1' }],
    merge_diff: [{ urlOrId: 'OTHER-1' }],
    submit_diff_review: [{ urlOrId: 'OTHER-1', decision: 'approved' }],
    resolve_diff_thread: [{ threadId: 'OTHER-1' }],
  };
  for (const reader of config.tracker.readTools) {
    const server = serverPrefix(reader);
    const record = { value: config.tracker.workspace.expect, tool: reader };
    const judge = (tool, input) => judgeTrackerWrite(config, `${server}${tool}`, input, record);
    for (const [tool, inputs] of Object.entries(refused)) for (const input of inputs) assert.ok(judge(tool, input), `${server}${tool} ${JSON.stringify(input)} is refused`);
    for (const [tool, inputs] of Object.entries(allowed)) for (const input of inputs) assert.equal(judge(tool, input), null, `${server}${tool} ${JSON.stringify(input)} passes`);
  }
});

test('the write patterns cover the writes beyond save, create, and delete, and no read tool of the connector', () => {
  const { config } = loadConfig(findProject(path.join(ROOT, 'examples/consumer')));
  const { readTools, writeTools } = config.tracker;
  // A prepare tool counts as a write: its definition makes it the step before file bytes reach the connected workspace.
  const writes = [
    'share_issue', 'unshare_issue', 'update_diff', 'merge_diff', 'submit_diff_review', 'resolve_diff_thread', 'retire_issue_label', 'restore_issue_label', 'retire_project_label', 'restore_project_label',
    'prepare_attachment_upload', 'prepare_file_upload',
  ];
  // Deliberately unguarded: it only changes one person's inbox state, never the workspace's data.
  const unguarded = ['mark_notification'];
  // Every tool the Linear connector lists that only reads, so a prefix can never start refusing a lookup.
  const reads = [
    'get_agent_skill', 'get_attachment', 'get_diff', 'get_diff_threads', 'get_document', 'get_issue', 'get_issue_status', 'get_milestone', 'get_notifications', 'get_project', 'get_release',
    'get_release_note', 'get_status_updates', 'get_team', 'get_template', 'get_triage_responsibility', 'get_user', 'get_workspace', 'list_agent_skills', 'list_comments', 'list_custom_views',
    'list_cycles', 'list_diffs', 'list_documents', 'list_issue_labels', 'list_issue_statuses', 'list_issues', 'list_milestones', 'list_project_labels', 'list_projects', 'list_release_notes',
    'list_release_pipelines', 'list_releases', 'list_teams', 'list_templates', 'list_users', 'search_documentation', 'whoami', 'extract_images',
  ];
  for (const reader of readTools) {
    const server = serverPrefix(reader);
    for (const tool of writes) {
      // With no read on record, the workspace rule refuses before any field is looked at.
      const refusal = judgeTrackerWrite(config, `${server}${tool}`, tool === 'share_issue' ? { issue: 'OTHER-1' } : {}, null);
      assert.match(refusal?.match ?? '', /has not read the connected workspace/u, `${server}${tool}`);
    }
    for (const tool of reads) assert.ok(!writeTools.some((pattern) => nameMatches(pattern, `${server}${tool}`)), `${server}${tool} is a read`);
    for (const tool of unguarded) assert.equal(judgeTrackerWrite(config, `${server}${tool}`, { id: 'OTHER-1' }, null), null, `${server}${tool} is unguarded`);
  }
  assert.match(read('docs/config.md').replace(/\s+/gu, ' '), /`mark_notification` stays out of the patterns on purpose, so it is unguarded: it changes only one person's inbox state/u);
});

test('a tool outside writeTools passes unchecked, so setup and the manual route match the patterns to the connection', () => {
  const config = read('docs/config.md').replace(/\s+/gu, ' ');
  assert.match(config, /a tool that matches no pattern in `writeTools` passes unchecked, including every tool of a connection under another server name/u);
  assert.match(config, /A connection under another server name goes in `servers`/u, 'the manual route');
  assert.match(read(DISPATCHES).replace(/\s+/gu, ' '), /A connection under a server name the plugin does not know goes in `"servers": \["<name>"\]`/u, 'setup');
});

test('id is read on every write tool: a non-issue named like an issue key is refused, and its UUID passes', () => {
  const { config } = loadConfig(findProject(path.join(ROOT, 'examples/consumer')));
  assert.ok(config.tracker.team.keyFields.includes('id'));
  const reader = config.tracker.readTools[0];
  const server = serverPrefix(reader);
  const record = { value: config.tracker.workspace.expect, tool: reader };
  const judge = (input) => judgeTrackerWrite(config, `${server}save_issue_label`, input, record);
  const refusal = judge({ id: 'Sev-1' });
  assert.ok(refusal, 'a label named Sev-1 is refused');
  assert.match(refusal.reason, /pass the item's UUID/u);
  assert.equal(judge({ id: '11111111-2222-4333-8444-555555555555' }), null);

  const limit = /a non-issue whose name looks like an issue key, such as a label `Sev-1`, is refused, and the agent retries with its UUID/u;
  assert.match(read('docs/config.md').replace(/\s+/gu, ' '), limit);
});

test('createFields holds only the inputs that put a write in a team', () => {
  const { config } = loadConfig(findProject(path.join(ROOT, 'examples/consumer')));
  assert.deepEqual(config.tracker.team.createFields, ['team', 'addTeams', 'setTeams', 'leadTeam']);
  assert.deepEqual(config.tracker.team.keyFields, ['id', 'issueId', 'issue']);
  assert.match(read('docs/config.md'), /`createFields` holds the inputs that put a write in a team: `removeTeams` takes one out, and `teamId` takes a UUID/u);
});

test('an existing project has a written route to the key, since setup asks only while setting a project up', () => {
  const text = read('docs/config.md').replace(/\s+/gu, ' ');
  assert.match(text, /only while setting a project up, so an existing project adds the key by hand/u);
  assert.match(text, /raises \[`requires\.aidrian`\]\(#plugin-version\) to the plugin version that ships the key unless it is already higher/u);
  assert.match(text, /replaces the team in its `issue_tracker` doc and that doc's summary with a pointer to the key/u);
  assert.match(text, /and runs `aidrian check`/u);
});

test('the skills that name the knowledge as the team\'s owner defer to config.json tracker.team', () => {
  for (const rel of ['agent-issue-writer/references/linear.md', 'agent-issue-writer/SKILL.md', 'initiative-agent/SKILL.md']) {
    assert.match(read(`plugins/aidrian/skills/${rel}`), /\(team unless config\.json sets `tracker\.team`, transition rules/u, rel);
  }
});

test('setup raises requires.aidrian to the running plugin, whose version it reads rather than names', () => {
  const [block, ...extra] = blocks(DISPATCHES).filter((each) => each.section === TRACKER_SECTION && each.lang === 'sh');
  assert.equal(extra.length, 0, 'one sh block');
  const printed = runSh(block.body);
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(printed.stdout, `${pluginVersion()}\n`);

  const dispatches = read(DISPATCHES);
  const section = dispatches.slice(dispatches.indexOf(`## ${TRACKER_SECTION}`));
  assert.match(section, /`requires\.aidrian`[^.]*absent, null, or lower/u);
  assert.match(section, /part by part, as numbers/u, 'a string comparison puts 0.9.0 above 0.38.0');
  assert.match(section, /leave a higher value/iu);
  assert.doesNotMatch(section, /\b\d+\.\d+\.\d+\b/u, 'a version in the text would go stale');
});

test('the tracker reference and the example doc point at the key', () => {
  const tracker = read('plugins/aidrian/skills/knowledge/references/tracker.md');
  assert.match(tracker, /refus[^.]*has not read the connected workspace[^.]*call the read tool/iu, 'the refusal is the signal to read');
  assert.match(tracker, /no read ahead of a write/iu);
  assert.match(tracker, /When config\.json sets `tracker\.team`, [^.]*team's home/u);

  const doc = read('examples/consumer/docs/knowledge/engineering/issue-tracker.md');
  const { team } = json('examples/consumer/.aidrian/config.json').tracker;
  assert.doesNotMatch(doc, new RegExp(`\`${team.key}\``, 'u'), 'one home for the team');
  assert.match(doc, /`tracker`/u);
  const { summary } = json('examples/consumer/.aidrian/knowledge/engineering.json').docs['issue-tracker.md'];
  assert.doesNotMatch(summary, /The Linear team/u, 'the summary says what the doc now holds');
});

test('the config doc shows what setup writes, and says relation fields stay out on purpose', () => {
  const [example, written, ...extra] = blocks('docs/config.md').filter((block) => block.section === 'Tracker' && block.lang === 'json');
  assert.equal(extra.length, 0, 'two json blocks in the Tracker section: what setup writes, and a key written out');
  assert.ok(JSON.parse(written.body).tracker.writeTools.length > 0, 'the second shows the lists, which stay valid');
  const { tracker } = JSON.parse(example.body);
  assert.deepEqual(tracker, briefTracker({ expect: tracker.workspace.expect, key: tracker.team.key, name: tracker.team.values[0], project: tracker.project.values[0] }));
  const config = read('docs/config.md');
  assert.match(config, /Relation fields[^.]*left out[^.]*on purpose/u);
});

test('issue publishing takes the team from config.json tracker when set, else the knowledge', () => {
  const linear = read('plugins/aidrian/skills/agent-issue-writer/references/linear.md');
  assert.match(linear, /`<team>`[^\n]*config\.json `tracker\.team` when that key is set, else from that knowledge/u);
  assert.match(linear, /Take the name from config\.json `tracker\.team` when set, else from the project's `issue_tracker` knowledge/u);
});
