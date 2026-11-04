import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { parse } from 'yaml';

import { decisionClasses, VOCAB_PATH } from '../plugins/aidrian/lib/decisions.mjs';
import { pluginTags } from '../plugins/aidrian/lib/knowledge.mjs';
import { bannedPatterns } from '../scripts/banned-terms.mjs';
import { CLAUDE_AGENTS, GROUPS, readAgents } from '../scripts/build.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PLUGIN = path.join(ROOT, 'plugins/aidrian');
const json = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));

const VOCABULARY = pluginTags();
// Both hosts list every agent and skill description in every session, used or not. Say when to use it, nothing more.
const MAX_DESCRIPTION = 160;

test('both marketplaces publish the same plugin, and both plugin manifests agree', () => {
  const claudeMarket = json('.claude-plugin/marketplace.json');
  const codexMarket = json('.agents/plugins/marketplace.json');
  assert.equal(claudeMarket.name, codexMarket.name);
  assert.deepEqual(claudeMarket.plugins.map((p) => [p.name, p.source]), [['aidrian', './plugins/aidrian']]);
  assert.deepEqual(codexMarket.plugins.map((p) => [p.name, p.source]), [['aidrian', { source: 'local', path: './plugins/aidrian' }]]);

  const claude = json('plugins/aidrian/.claude-plugin/plugin.json');
  const codex = json('plugins/aidrian/plugin.json');
  for (const key of ['name', 'version', 'description', 'author', 'repository']) assert.deepEqual(codex[key], claude[key], key);
  // An explicit "agents" list replaces Claude Code's agents/ scan; with one, Claude Code 2.1.312 loaded no agents at all.
  assert.equal('agents' in claude, false);
});

// The agents Claude Code loads, as scripts/build.mjs generates them from agents-src/ and providers/claude.json.
function claudeAgents() {
  return readdirSync(CLAUDE_AGENTS).filter((file) => file.endsWith('.md')).sort().map((file) => {
    const [, frontmatter, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(readFileSync(path.join(CLAUDE_AGENTS, file), 'utf8'));
    return { file, meta: parse(frontmatter), body };
  });
}

test('every agent has the frontmatter Claude Code needs and preloads the knowledge skill', () => {
  const agents = claudeAgents();
  assert.deepEqual(agents.map(({ meta }) => meta.name), readAgents().map(({ meta }) => meta.name));
  for (const { file, meta, body } of agents) {
    assert.equal(meta.name, file.replace(/\.md$/, ''), file);
    assert.ok(meta.description?.length > 20, `${file}: description`);
    assert.ok(meta.description.length <= MAX_DESCRIPTION, `${file}: description over ${MAX_DESCRIPTION} characters`);
    assert.ok(['haiku', 'sonnet', 'opus', 'fable', 'inherit'].includes(meta.model), `${file}: model`);
    assert.ok(['low', 'medium', 'high', 'xhigh', 'max'].includes(meta.effort), `${file}: effort`);
    assert.deepEqual(meta.skills, ['aidrian:knowledge'], `${file}: skills`);
    const loads = body.match(/^Before you start, follow the `knowledge` skill\. (.*)$/gm) ?? [];
    assert.equal(loads.length, 1, `${file}: one knowledge-loading line`);
  }
});

// A frontmatter `tools` or `disallowedTools` value: Claude Code takes a YAML list or a comma-separated string.
const toolList = (value) => (value === undefined ? [] : Array.isArray(value) ? value : String(value).split(',')).map((tool) => String(tool).trim());
const mcpTools = (tools) => toolList(tools).filter((tool) => tool.startsWith('mcp__'));

// Claude Code gives an agent without `tools` every tool the session has, the project's own MCP servers included.
// An allowlist that names one vendor's MCP tools ties the agent to that setup and hides any other tracker or server.
// Add an agent here, with the reason, only when its whole purpose is that vendor.
const MCP_ALLOWLISTS = new Map();

test('no agent allowlists an MCP tool, so a project\'s own MCP tools reach it', () => {
  assert.deepEqual(mcpTools('Read, mcp__github__get_commit'), ['mcp__github__get_commit']);
  assert.deepEqual(mcpTools(['Bash', 'mcp__plugin_linear_linear__get_issue']), ['mcp__plugin_linear_linear__get_issue']);
  const agents = claudeAgents();
  for (const { file, meta } of agents) {
    if (!MCP_ALLOWLISTS.has(meta.name)) assert.deepEqual(mcpTools(meta.tools), [], `${file}: drop the mcp__ tools, or the whole \`tools\` list`);
  }
  for (const name of MCP_ALLOWLISTS.keys()) {
    assert.ok(agents.some(({ meta }) => meta.name === name && mcpTools(meta.tools).length), `${name} allowlists no MCP tool; remove it from MCP_ALLOWLISTS`);
  }
});

// With no allowlist, an agent also inherits NotebookEdit, which writes files as Write and Edit do.
test('an agent denied Write and Edit is denied NotebookEdit too', () => {
  for (const { file, meta } of claudeAgents()) {
    const denied = toolList(meta.disallowedTools);
    if (denied.includes('Write') && denied.includes('Edit')) assert.ok(denied.includes('NotebookEdit'), `${file}: add NotebookEdit to disallowedTools`);
  }
});

test('every skill has a name matching its folder and a description', () => {
  const skills = readdirSync(path.join(PLUGIN, 'skills'));
  assert.ok(skills.includes('knowledge'));
  for (const skill of skills) {
    const text = readFileSync(path.join(PLUGIN, 'skills', skill, 'SKILL.md'), 'utf8');
    const meta = parse(/^---\n([\s\S]*?)\n---\n/.exec(text)[1]);
    assert.equal(meta.name, skill);
    assert.ok(meta.description?.length > 20, `${skill}: description`);
    assert.ok(meta.description.length <= MAX_DESCRIPTION, `${skill}: description over ${MAX_DESCRIPTION} characters`);
  }
});

test('the agent and skill tables list every shipped agent and skill once, and nothing else', () => {
  const doc = readFileSync(path.join(ROOT, 'docs/agents-and-skills.md'), 'utf8');
  const rows = (heading) => {
    const section = doc.split(`\n## ${heading}\n`)[1].split('\n#')[0];
    return [...section.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((match) => match[1]).sort();
  };
  assert.deepEqual(rows('Agents'), readAgents().map((agent) => agent.meta.name).sort());
  assert.deepEqual(rows('Skills'), readdirSync(path.join(PLUGIN, 'skills')).sort());
});

test('the agent tables are the agents-src/ group folders: one table per group, in GROUPS order, with that folder\'s agents', () => {
  const doc = readFileSync(path.join(ROOT, 'docs/agents-and-skills.md'), 'utf8');
  const section = doc.split('\n## Agents\n')[1].split('\n## ')[0];
  const tables = [...section.matchAll(/^\| ([^|`]+?) \| What it does \|\n\| --- \| --- \|\n((?:\|.*\n?)*)/gm)]
    .map(([, heading, rows]) => [heading, [...rows.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((match) => match[1]).sort()]);
  const agents = readAgents();
  const groups = Object.entries(GROUPS).map(([group, heading]) => [
    heading,
    agents.filter((agent) => agent.group === group).map((agent) => agent.meta.name).sort(),
  ]);
  assert.deepEqual(tables, groups);
});

// Codex cuts a SKILL.md at 8,000 bytes: MAX_SKILL_PROMPT_BYTES in codex-rs/ext/skills/src/render.rs.
// Keep a margin. A longer skill keeps its steps in SKILL.md and moves detail into references/, steps/, or modes/ files,
// each named in SKILL.md with when to read it.
const MAX_SKILL_BYTES = 7500;

test('every SKILL.md fits in Codex\'s skill size, with a margin', () => {
  const over = readdirSync(path.join(PLUGIN, 'skills'))
    .map((skill) => [skill, statSync(path.join(PLUGIN, 'skills', skill, 'SKILL.md')).size])
    .filter(([, bytes]) => bytes > MAX_SKILL_BYTES);
  assert.deepEqual(over, [], `move detail into references/, steps/, or modes/ files; the limit is ${MAX_SKILL_BYTES} bytes`);
});

// `claude --agent aidrian:orchestrator` makes this file the session's instructions, paid for on every turn.
// Count bytes, as `wc -c` does: a check that counted characters would pass a file over the limit.
const MAX_ORCHESTRATOR_BYTES = 9000;

test('the orchestrator agent file fits in 9,000 bytes', () => {
  const bytes = statSync(path.join(CLAUDE_AGENTS, 'orchestrator.md')).size;
  assert.ok(bytes <= MAX_ORCHESTRATOR_BYTES, `orchestrator.md is ${bytes} bytes; move detail into the orchestration skill`);
});

test('the orchestrator checks the work against the project`s core invariants, and names only files it can show', () => {
  // A resumed brief's locked scope missed a core product mode, and the orchestrator asked whether to fix the gap; a
  // report named a shortened path and one no agent wrote, and the stop hook sent it back.
  const orchestrator = readFileSync(path.join(PLUGIN, 'agents-src/coordination/orchestrator.md'), 'utf8').replace(/\s+/g, ' ');
  const checkpoint = orchestrator.slice(orchestrator.indexOf('## Checkpoint'), orchestrator.indexOf('## Routing'));
  assert.match(checkpoint, /On resume and before reporting near-done, check the work against the project's core invariants \(`AGENTS\.md`, its `always` knowledge\)/);
  assert.match(checkpoint, /a locked scope waives none\. A gap is a defect to route, `product-manager` first, and fix here; ask the Human only a real choice it opens, never whether to fix it\./);
  assert.match(orchestrator, /- Report a result, or name a file, that no agent's handoff or command output shows; give paths in full, never with `\.\.\.`/);
});

// modes/ holds one file per mode of a skill that runs in several, read only once that mode is selected.
test('a skill names each of its references/, steps/, and modes/ files, and every such file the plugin names exists', () => {
  const skills = path.join(PLUGIN, 'skills');
  const extra = (skill) => ['references', 'steps', 'modes'].flatMap((sub) => {
    const dir = path.join(skills, skill, sub);
    return existsSync(dir) ? readdirSync(dir).map((file) => `${sub}/${file}`) : [];
  });
  const shipped = new Set(readdirSync(skills).flatMap(extra));
  const unnamed = [];
  for (const skill of readdirSync(skills)) {
    const text = readFileSync(path.join(skills, skill, 'SKILL.md'), 'utf8');
    for (const file of extra(skill)) if (!text.includes(file)) unnamed.push(`${skill}/${file}`);
  }
  assert.deepEqual(unnamed, [], 'SKILL.md must say when to read each of its files');
  const dangling = [];
  for (const file of markdownFiles(PLUGIN)) {
    for (const [ref] of readFileSync(file, 'utf8').matchAll(/\b(?:references|steps|modes)\/[\w.-]+\.md\b/g)) {
      if (!shipped.has(ref)) dangling.push(`${path.relative(ROOT, file)}: ${ref}`);
    }
  }
  assert.deepEqual(dangling, []);
});

test('every tag the agents and skills ask for is in the knowledge skill tag list', () => {
  assert.ok(VOCABULARY.length >= 5, 'the knowledge skill lists its tags');
  for (const tag of ['backend', 'security', 'review', 'support', 'marketing']) assert.ok(VOCABULARY.includes(tag), tag);
  const used = new Set();
  for (const file of markdownFiles(PLUGIN)) {
    const text = readFileSync(file, 'utf8');
    // A tag list may wrap: read on to the end of its paragraph.
    for (const list of text.match(/[Kk]nowledge tags: .*(?:\n.+)*/g) ?? []) {
      for (const [, tag] of list.matchAll(/`([a-z][a-z0-9_]*)`/g)) used.add(tag);
    }
    for (const [, tag] of text.matchAll(/`([a-z][a-z0-9_]*)` knowledge\b/g)) used.add(tag);
  }
  // `always` is the bucket list every agent loads, not a tag.
  const unknown = [...used].filter((tag) => tag !== 'always' && !VOCABULARY.includes(tag));
  assert.deepEqual(unknown, [], 'add the tag to the knowledge skill, or use an existing one');
});

test('an agent and the skill of the same name ask for the same knowledge tags', () => {
  // The sentence up to its period, without a "plus ..." clause: that clause adds a tag for one kind of task only.
  const tags = (file) => {
    const sentence = /[Kk]nowledge tags: ([^.]*)/.exec(readFileSync(file, 'utf8'))?.[1].split(/\bplus\b/)[0] ?? '';
    return [...sentence.matchAll(/`([a-z][a-z0-9_]*)`/g)].map(([, tag]) => tag).sort();
  };
  const pairs = readAgents().filter(({ meta }) => existsSync(path.join(PLUGIN, 'skills', meta.name, 'SKILL.md')));
  assert.ok(pairs.length >= 3, 'agent and skill pairs are found');
  for (const { file, meta: { name } } of pairs) {
    const agent = tags(path.join(PLUGIN, 'agents-src', file));
    assert.ok(agent.length, `${name}: the agent lists its knowledge tags`);
    assert.deepEqual(tags(path.join(PLUGIN, 'skills', name, 'SKILL.md')), agent, `${name}: the skill and the agent list the same tags`);
  }
});

test('a skill that names this plugin\'s agents says how each host names them, or loads the knowledge skill, which does', () => {
  const HOST_NAMES = 'as `aidrian:<name>` in Claude Code and `aidrian-<name>` in Codex';
  const agents = readAgents().map(({ meta }) => meta.name);
  const skill = (name) => readFileSync(path.join(PLUGIN, 'skills', name, 'SKILL.md'), 'utf8');
  assert.ok(skill('knowledge').includes(HOST_NAMES), 'the knowledge skill states the rule');
  for (const name of readdirSync(path.join(PLUGIN, 'skills'))) {
    const text = skill(name);
    const named = agents.filter((agent) => agent !== name && text.includes(`\`${agent}\``));
    if (!named.length) continue;
    const loadsKnowledge = /^Before you start, follow the `knowledge` skill\./m.test(text);
    assert.ok(loadsKnowledge || text.includes(HOST_NAMES), `${name} names ${named.join(', ')}`);
  }
});

test('plugin content holds no project-specific paths or leftover template markers', () => {
  const banned = [
    /docs\/ai-rules/,
    /(^|[^.\w])\.agent\//,
    /\.agents\/skills/,
    /\{\{(slot|host|provider):/,
    /consuming project/,
    /primary provider/,
    /scripts\/agent-context/,
  ];
  const hits = [];
  for (const file of allFiles(PLUGIN)) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of banned) if (pattern.test(text)) hits.push(`${path.relative(ROOT, file)}: ${pattern}`);
  }
  assert.deepEqual(hits, []);
});

// The repository names no project it came from, no person, and no third-party skill. The owner's GitHub slug appears only
// where a user needs it to install the plugin: the README, the manifests' repository URLs, and the example's marketplace source.
// Private words (source projects, their tracker keys, people) are never written here, where they would be public:
// they live in the git-ignored `.banned-terms.local`, one case-insensitive regular expression per line, `#` for a comment.
// Without that file only the public patterns run (scripts/banned-terms.mjs). The owner comes from the manifest, so this
// file never names it.
test('no tracked file names a source project, its tracker keys, a person, or a third-party skill', () => {
  const { repository } = json('plugins/aidrian/plugin.json');
  const slug = new URL(repository).pathname.replace(/^\/|\.git$/g, '');
  const owner = slug.split('/')[0];
  const installFiles = ['README.md', 'NOTICE', 'docs/adopting.md', 'examples/consumer/.claude/settings.json', 'plugins/aidrian/.claude-plugin/plugin.json', 'plugins/aidrian/plugin.json'];
  const banned = bannedPatterns(ROOT);
  const hits = [];
  for (const file of execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean)) {
    const text = `${file}\n${readFileSync(path.join(ROOT, file), 'utf8')}`;
    for (const pattern of banned) if (pattern.test(text)) hits.push(`${file}: ${pattern}`);
    const outsideInstall = installFiles.includes(file) ? text.replaceAll(slug, '') : text;
    if (outsideInstall.toLowerCase().includes(owner.toLowerCase())) hits.push(`${file}: the owner's GitHub name`);
  }
  assert.deepEqual(hits, []);
});

test('only the repository root and the example name a file AGENTS.md or CLAUDE.md, in any case', () => {
  // On a case-insensitive disk Claude Code loads docs/agents.md as a nested AGENTS.md into every session that reads in docs/.
  const instructionFiles = ['AGENTS.md', 'CLAUDE.md', 'examples/consumer/AGENTS.md', 'examples/consumer/CLAUDE.md'];
  const named = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0')
    .filter((file) => /^(agents|claude)\.md$/i.test(path.basename(file)));
  assert.deepEqual(named.filter((file) => !instructionFiles.includes(file)), []);
});

test('a skill that runs the pr-review-loop skill says when it marks the pull request ready', () => {
  // pr-review-loop leaves marking ready to such a caller, so a caller without the step leaves a green pull request a draft.
  const callers = [['autopilot', 'references/phases.md'], ['orchestration', 'SKILL.md']];
  const loop = readFileSync(path.join(PLUGIN, 'skills/pr-review-loop/SKILL.md'), 'utf8');
  assert.match(loop, /review of the current head signed off/, 'the loop marks ready only after the current head is reviewed');
  assert.match(loop.replace(/\s+/g, ' '), /Run as a step of another skill or agent, never mark it ready: that is the caller's step, after all its reviews\./,
    'the loop leaves ready to any caller, without naming one');
  for (const [skill, file] of callers) {
    const text = readFileSync(path.join(PLUGIN, 'skills', skill, file), 'utf8');
    assert.match(text, /gh pr ready <n>/, `${skill} marks the pull request ready`);
    assert.match(text, /github\.markReady/, `${skill} reads github.markReady`);
  }
  // markReady is "auto" by default (lib/config.mjs), so every skill that marks ready names that default, and
  // pr-merge-when-green marks a signed-off draft ready instead of always asking.
  for (const file of ['pr-review-loop/SKILL.md', 'autopilot/references/phases.md', 'orchestration/SKILL.md', 'pr-merge-when-green/SKILL.md']) {
    const text = readFileSync(path.join(PLUGIN, 'skills', file), 'utf8').replace(/\s+/g, ' ');
    assert.match(text, /`github\.markReady` is `"auto"`, the default/, `${file} names "auto" as the markReady default`);
  }
});

test('pr-write hands an opened or updated pull request to the review loop as github.reviewLoop says', () => {
  // With reviewLoop "auto", the default, a session that opened a pull request and stopped left it unreviewed.
  const text = readFileSync(path.join(PLUGIN, 'skills/pr-write/SKILL.md'), 'utf8').replace(/\s+/g, ' ');
  const handoff = text.slice(text.indexOf('## Then the review loop'));
  assert.match(handoff, /config\.json `github\.reviewLoop`/, 'pr-write reads github.reviewLoop');
  assert.match(handoff, /`"auto"`, the default: .*runs the `pr-review-loop` skill on the pull request right away, without asking the Human\./);
  assert.match(handoff, /`"ask"`: offer the loop, and run it when the Human asks\./);
  assert.match(handoff, /Inside a skill or agent that runs its own review loop, leave the loop to it, so the loop runs once\./,
    'a caller that runs the loop itself, such as autopilot, still runs it once');
});

test('the lesson skill takes a feedback draft note from context and leaves the draft to the Human', () => {
  // A session asked to write a lesson for a Claude Code feedback draft cannot read, edit, or delete that queue,
  // so the skill says where the note comes from and that the Human sends or discards the draft.
  const text = readFileSync(path.join(PLUGIN, 'skills/lesson/SKILL.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(text, /For a lesson from a Claude Code feedback draft, the note comes from the draft text in context: no command reads, edits, or deletes that draft\./);
  assert.match(text, /Tell the Human it stays queued for the Human to send, if it is a Claude Code bug, or discard\./);
});

test('an implementing skill ends at its draft, and the orchestrator owns what follows', () => {
  // A continuation clause buried mid-phase in issue-implement lost to the skill's own terminal signals,
  // and an orchestrator session stopped at the draft instead of running the review loop.
  const read = (rel) => readFileSync(path.join(PLUGIN, rel), 'utf8').replace(/\s+/g, ' ');
  const orchestrator = read('agents-src/coordination/orchestrator.md');
  assert.match(orchestrator, /its gates win, and its end is a step of your task, not the task's end/);
  assert.match(orchestrator, /`plan-implement` skill\. When its report names an opened draft, continue with the `orchestration` skill § 3 from step 4 to its end\./);
  assert.match(orchestrator, /5\. Close only when every slice passed and, with a pull request open, the `orchestration` skill § 3 stopped;/,
    'the orchestrator closes only after the review loop stopped');

  const close = readFileSync(path.join(PLUGIN, 'skills/issue-implement/steps/phases-5-8-close.md'), 'utf8');
  const report = close.slice(close.indexOf('## Phase 8')).replace(/\s+/g, ' ');
  assert.match(report, /This skill ends at the draft, its integration review, and the report: the skill's result, not the session's last message\. The caller owns what follows\./);
  assert.doesNotMatch(report, /orchestrator/, 'phase 8 names no caller: the caller owns what follows');
  assert.equal((close.match(/ends at (the|a) draft/g) ?? []).length, 1, 'the skill states its end once, in phase 8');
  assert.equal((report.match(/ends at (the|a) draft/g) ?? []).length, 1, 'that one statement is in phase 8');
  assert.doesNotMatch(close, /Under the `orchestrator`/, 'the skill states no caller-conditional continuation');
  assert.doesNotMatch(read('skills/issue-implement/references/hard-rules.md'), /run ends at a draft/);

  // The orchestrator keys on the skill's verdicts, so they stay pinned.
  const skill = readFileSync(path.join(PLUGIN, 'skills/issue-implement/SKILL.md'), 'utf8');
  const output = skill.slice(skill.indexOf('## Output'));
  assert.match(output, /`done: draft pull request opened`/);
  assert.match(output, /`partial: review left findings open`/);

  const orchestration = read('skills/orchestration/SKILL.md');
  assert.match(orchestration, /Open a draft with the `pr-write` skill, unless the implementing skill already opened it: its integration review was step 3\./);
  const prSection = orchestration.slice(orchestration.indexOf('## 3. The pull request'));
  const step4 = prSection.match(/ 4\. (.*?) 5\. /)?.[1] ?? '';
  assert.match(step4, /`pr-review-loop`/, '§ 3 step 4, where the orchestrator continues, runs the review loop');
});

test('a calling skill such as autopilot owns what follows the implementing skill, so the review loop runs once', () => {
  // In an orchestrator session that runs autopilot, both the orchestrator's continuation and autopilot's phases would run the loop.
  const read = (rel) => readFileSync(path.join(PLUGIN, rel), 'utf8').replace(/\s+/g, ' ');
  const orchestrator = read('agents-src/coordination/orchestrator.md');
  const routing = orchestrator.slice(orchestrator.indexOf('## Routing'));
  assert.match(routing, /When a calling skill, such as `autopilot`, ran it, that skill's steps continue instead; § 3 never runs twice\./);
  assert.equal((orchestrator.match(/a calling skill/g) ?? []).length, 1, 'the orchestrator states the caller rule once');
  const autopilot = read('skills/autopilot/SKILL.md');
  assert.match(autopilot, /The engine ends at its draft, and these phases own what follows: the review loop runs once\./);
  assert.match(autopilot, /The `orchestration` skill's § 3 rules apply inside phases 3 and 4, never as a second loop after them\./);
});

test('the security-sensitive finding rules live in the orchestration skill § 4, which the orchestrator loads before any finding', () => {
  // The orchestrator agent file is held to 9,000 bytes; the finding rules moved to the skill that owns review findings.
  const read = (rel) => readFileSync(path.join(PLUGIN, rel), 'utf8').replace(/\s+/g, ' ');
  const orchestrator = read('agents-src/coordination/orchestrator.md');
  assert.doesNotMatch(orchestrator, /## Security-sensitive findings/);
  assert.match(orchestrator, /3\. Before the first editing dispatch, pull request step, or finding to close, load the `orchestration` skill\./);
  assert.match(orchestrator, /`security-engineer`, which never edits and alone closes a security finding \(orchestration skill § 4\)/);
  const skill = read('skills/orchestration/SKILL.md');
  const findings = skill.slice(skill.indexOf('## 4. Review findings'));
  assert.match(findings, /\*\*Security-sensitive findings\*\*, on auth, tenant isolation, another user's data, public trust boundaries, server-side validation, abuse, payment or webhook trust, or privileged access: only `security-engineer` closes or excludes one\. Weak evidence goes to `explorer`\./);
  assert.match(findings, /"Disputed" closes nothing: escalate to the Human with the owning agent and the missing evidence\./);
  assert.match(skill, /before its first editing dispatch, pull request step, or finding to close/);
});

test('a skill ends at its own output: no sentence names a caller to say what follows it', () => {
  // A continuation clause in the called skill loses to its own end, and the caller's next step never runs. The
  // orchestration skill is written for the orchestrator itself, so it is the caller's text.
  const walk = (dir) => readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : entry.name.endsWith('.md') ? [path.join(dir, entry.name)] : []));
  const skills = path.join(PLUGIN, 'skills');
  const caller = /`(?:autopilot|orchestrator)`/;
  const continuation = /\b(?:the caller|continues?|then run|next step|what follows)\b/i;
  const found = walk(skills).filter((file) => !path.relative(skills, file).startsWith('orchestration/')).flatMap((file) =>
    readFileSync(file, 'utf8').replace(/\s+/g, ' ').split(/(?<=\.)\s+/)
      .filter((sentence) => caller.test(sentence) && continuation.test(sentence))
      .map((sentence) => `${path.relative(skills, file)}: ${sentence}`));
  assert.deepEqual(found, []);
  const checklist = readFileSync(path.join(PLUGIN, 'skills/skill-writer/references/checklist.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(checklist, /The skill ends at its own output and never names who continues/);
  assert.match(readFileSync(path.join(ROOT, 'docs/architecture.md'), 'utf8').replace(/\s+/g, ' '),
    /a skill ends at its own output and never names who continues; the caller's text names the next step\./);
});

test('the local banned terms file stays out of git', () => {
  const ignored = spawnSync('git', ['check-ignore', '-q', '.banned-terms.local'], { cwd: ROOT });
  assert.equal(ignored.status, 0, '.banned-terms.local must be git-ignored');
});

test('only lib/project.mjs names the project folder; other plugin code asks it for paths', () => {
  const naming = allFiles(PLUGIN).filter((file) => file.endsWith('.mjs') && readFileSync(file, 'utf8').includes('.aidrian'));
  assert.deepEqual(naming.map((file) => path.relative(PLUGIN, file)), ['lib/project.mjs']);
});

const DECISION_RULE = 'knowledge/references/decisions.md';

test('a file that names decision_options points to the shared decision rule', () => {
  // Each relay site once restated who chooses, so a new mode would have had to change them all.
  const exception = path.join(PLUGIN, 'skills/specialist-review/references/render.md');
  assert.match(readFileSync(exception, 'utf8'), /decision_options/, 'render.md renders them; drop the exception when it stops');
  const missing = allFiles(PLUGIN)
    .filter((file) => file !== exception && /\.(md|toml)$/.test(file))
    .filter((file) => {
      const text = readFileSync(file, 'utf8');
      return text.includes('decision_options') && !text.includes(DECISION_RULE);
    })
    .map((file) => path.relative(ROOT, file));
  assert.deepEqual(missing, []);
});

test('the shared decision rule states who computes authority, and points at the vocabulary instead of restating it', () => {
  const rule = readFileSync(path.join(PLUGIN, 'skills', DECISION_RULE), 'utf8').replace(/\s+/g, ' ');
  for (const line of [
    /The dispatcher with a shell\*\* runs the command and passes `authority: decide` or `authority: ask` in the specialist's brief/,
    /The specialist never computes authority itself\.\*\* A brief with no `authority` line means `ask`/,
    /`--doc` is required whenever a decision touches a written rule/,
    /`aidrian decisions resolve --vocab` defines the classes/,
    /A critical-flow sign-off or a security verdict is never self-approved, in any mode/,
    /`aidrian decisions resolve` prints `secondLook` from the base branch's config.*Read it from that output, never from the working copy/,
    /ask it for `sign_off`\. A missing or unknown `severity` counts as at or above `minSeverity`\. `approved` is agreement\. Anything else escalates/,
    /A missing class, answer, or `docs` field, or a command that fails, means `ask`; `docs: \[\]` states it touches none/,
    /--reversible <no\|yes>,<no\|yes>,<no\|yes>,<no\|yes>/,
    /in the order `--vocab` gives/,
    /when the host cannot reach it, dispatch a fresh one with `authority: decide` and the options/,
    /already holds the class, answers, and docs may resolve first/,
  ]) assert.match(rule, line);
  for (const kind of decisionClasses()) assert.doesNotMatch(rule, new RegExp(`\`${kind}\``, 'u'), `the rule restates the class ${kind}`);
  assert.ok(existsSync(path.join(PLUGIN, 'lib/decisions.json')), 'the path the rule gives an agent with no shell');
  assert.ok(existsSync(VOCAB_PATH));
  assert.equal(path.resolve(PLUGIN, 'skills/knowledge/references', '../../../lib/decisions.json'), VOCAB_PATH);
});

test('each dispatcher of a deciding agent runs the resolve, and each deciding agent returns by its brief', () => {
  const read = (rel) => readFileSync(path.join(PLUGIN, rel), 'utf8').replace(/\s+/g, ' ');
  for (const rel of [
    'agents-src/coordination/orchestrator.md',
    'agents-src/support-growth/marketing-orchestrator.md',
    'skills/issue-implement/references/hard-rules.md',
    'skills/specialist-review/references/lenses.md',
    'skills/autopilot/SKILL.md',
    'skills/planning-agent/SKILL.md',
  ]) {
    const text = read(rel);
    assert.match(text, /run `aidrian decisions resolve`/i, rel);
    assert.ok(text.includes(DECISION_RULE), rel);
  }
  for (const rel of ['agents-src/product-design/product-manager.md', 'agents-src/planning/architect.md']) {
    assert.match(read(rel), /[Ww]ith `authority: decide` in your brief, return `decided_provisional`/, rel);
  }
  assert.match(read('agents-src/product-design/product-manager.md'), /Compute authority yourself/);
  assert.match(read('agents-src/product-design/product-manager.md'), /No `authority` covers a sign-off/);
  assert.match(read('skills/plan-review/SKILL.md'), /no `authority` covers this gate/);
  assert.match(read('agents-src/coordination/orchestrator.md'), /On an owner's `decision_options`, run `aidrian decisions resolve` and pass `authority`: `knowledge\/references\/decisions\.md`; under `ask`, return `needs_input` with them, attributed/);
  assert.match(read('skills/issue-implement/references/hard-rules.md'), /as `knowledge\/references\/decisions\.md` says\. Under `ask`, stop and ask; under `decide`, follow its order to the end/);
  const planning = read('skills/planning-agent/SKILL.md');
  const delegation = planning.slice(planning.indexOf('## Allowed Planning Delegation'), planning.indexOf('## Workflow'));
  assert.match(delegation, /run `aidrian decisions resolve` as `knowledge\/references\/decisions\.md` says\. Under `ask`, the decision becomes an `Open questions` entry.*record the `decided_provisional` in `## Approach` and your handoff/);
  assert.match(delegation, /You may also consult the agent the command's `secondLook` names, for that look only\./);
  const lenses = read('skills/specialist-review/references/lenses.md');
  const onOptions = lenses.slice(lenses.indexOf('## When an agent returns decision_options'), lenses.indexOf('## architect'));
  assert.match(onOptions, /Under `ask`, or with no agent id, render the needs-input block/);
  assert.match(onOptions, /send the kept agent `authority: decide` with the host's message tool, naming the decision/);
  assert.match(onOptions, /when the rule's second look would apply, render the needs-input block as under `ask`/);
  assert.match(read('skills/specialist-review/references/render.md'), /verbatim, leaving out `class`, `reversible`, and `docs`/);
  assert.match(read('agents-src/planning/architect.md'), /you never compute authority/);
  const handoff = read('skills/knowledge/references/handoff.md');
  for (const field of ['decision', 'options_considered', 'reason', 'class', 'reversible', 'docs', 'severity', 'revisit_trigger', 'reverts_by']) {
    assert.match(handoff.slice(handoff.indexOf('`decided_provisional`')), new RegExp(`\`${field}\``), field);
  }
});

test('autopilot parks a decision only under ask, and reports what an agent decided', () => {
  const autopilot = readFileSync(path.join(PLUGIN, 'skills/autopilot/SKILL.md'), 'utf8').replace(/\s+/g, ' ');
  assert.ok(autopilot.includes(`as \`${DECISION_RULE}\` says. Under \`decide\`, follow its order to the end and record the \`decided_provisional\` in the report.`));
  assert.match(autopilot, /Under `ask`, with a clearly safe default that can be undone, take it and flag it in the report, unless its `rule` is `escalate` or `escalate-doc`\. Otherwise park it/);
  assert.match(autopilot, /Fold each parked decision, each `decided_provisional`, and each finding left open/);
  assert.match(autopilot, /Decisions for the Human\*\*: each parked decision.*then each `decided_provisional`/);
  assert.match(autopilot, /Never approve one yourself: park it/);
});

test('plugin text names no bare slash command', () => {
  // Claude Code runs this plugin's skills as /aidrian:<skill>, so a bare /<name> is not a command this plugin provides.
  // Name the skill instead (it works on every host), or write /aidrian:<skill>.
  const hits = [];
  for (const file of markdownFiles(PLUGIN)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (/(^|[\s`"(])\/(?!aidrian:)[a-z][a-z0-9-]*(?=[\s`"),.;:]|$)/.test(line)) hits.push(`${path.relative(ROOT, file)}:${index + 1}`);
    });
  }
  assert.deepEqual(hits, []);
});

test('the example consumer supplies only its project folder, its docs, and settings, and enables this plugin', () => {
  const example = path.join(ROOT, 'examples/consumer');
  for (const own of ['.claude/agents', '.claude/skills', '.agents/skills', '.codex/agents', 'agents', 'skills']) {
    assert.equal(existsSync(path.join(example, own)), false, `${own} belongs in the plugin`);
  }
  const outsideFolder = allFiles(example).filter((file) => file.endsWith('.json') && !file.includes(`${path.sep}.aidrian${path.sep}`));
  assert.deepEqual(outsideFolder.map((file) => path.relative(example, file)).sort(), ['.claude/settings.json', 'package.json']);
  const marketplace = json('.claude-plugin/marketplace.json').name;
  const settings = json('examples/consumer/.claude/settings.json');
  assert.deepEqual(Object.keys(settings.extraKnownMarketplaces), [marketplace]);
  assert.deepEqual(settings.enabledPlugins, { [`aidrian@${marketplace}`]: true });
});

function allFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    return statSync(file).isDirectory() ? allFiles(file) : [file];
  });
}

function markdownFiles(dir) {
  return allFiles(dir).filter((file) => file.endsWith('.md'));
}

test('every agent that pushes, and the orchestration skill, says to wait in the foreground for what it starts', () => {
  // A subagent that ends its turn with a background push or reviewer running goes idle, and nothing wakes it.
  const read = (rel) => readFileSync(path.join(PLUGIN, rel), 'utf8').replace(/\s+/g, ' ');
  for (const rel of ['agents-src/build/backend-developer.md', 'agents-src/build/frontend-developer.md', 'agents-src/harness/harness-mechanic.md']) {
    const text = read(rel);
    assert.equal((text.match(/Wait in the foreground for every command and agent you start/g) ?? []).length, 1, `${rel} states the rule once`);
    assert.match(text, /a reviewer agent in the foreground/, rel);
  }
  assert.match(read('agents-src/coordination/integrator.md'), /Run the push in the foreground with a timeout, repeated until it ends/);
  const skill = read('skills/orchestration/SKILL.md');
  assert.match(skill, /An idle notice is not a result: before you act on one, check the branch and pull request yourself/);
  assert.match(skill, /every brief to an agent that pushes, waits on CI, or starts a reviewer says to wait in the foreground/);
});
