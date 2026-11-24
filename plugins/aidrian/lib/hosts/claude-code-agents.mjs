// The effort a Claude Code subagent runs at, as its start can tell it, for the `Agent-Effort:` hint the SubagentStart hook
// gives it (scripts/hook-session-start.mjs effortLine). The hint only saves a commit's first try: the attribution rule
// (lib/rules/attribution.mjs) reads the effort from the subagent's own transcript at commit time, and stays the authority.

import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, statSync } from 'node:fs';
import path from 'node:path';

import { agentCall } from '../agent-models.mjs';

// This plugin's generated Claude Code agents (scripts/build.mjs), and the project folder the host reads agents from.
const PLUGIN_AGENTS = path.resolve(import.meta.dirname, '../../agents');
export const PROJECT_AGENTS = '.claude/agents';
const PREFIX = 'aidrian:';
const NAME = /^[\w-]{1,64}$/u;
// The largest definition read: a longer file is skipped, as is anything but a regular file.
export const DEFINITION_CAP = 64 * 1024;
const NO_BLOCK = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);
// The most a project scan reads: folder entries listed, Markdown files read, and their bytes in all. A scan that would
// pass one gives no hint.
export const SCAN_BUDGET = Object.freeze({ entries: 200, files: 64, bytes: 1024 * 1024 });
// CLAUDE_CODE_EFFORT_LEVEL values that leave the effort to the launcher: no hint names one then.
const AUTOMATIC = new Set(['auto', 'unset']);

// A YAML scalar as written after `key:`: a quoted one up to its closing quote, a plain one up to a ` #` comment.
function scalar(raw) {
  const quote = raw[0];
  if (quote === '"') {
    const found = /^"((?:[^"\\]|\\.)*)"/u.exec(raw);
    if (!found) return null;
    try {
      return JSON.parse(`"${found[1]}"`);
    } catch {
      return null;
    }
  }
  if (quote === '\'') {
    const found = /^'((?:[^']|'')*)'/u.exec(raw);
    return found ? found[1].replaceAll('\'\'', '\'') : null;
  }
  return raw.replace(/(?:^|[ \t])#.*$/u, '').trim();
}

// The `key:` value of the frontmatter of `text` (scalar), or null.
function frontmatterValue(text, key) {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text)?.[1];
  const found = block === undefined ? null : new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`, 'mu').exec(block);
  return found ? scalar(found[1]) : null;
}

// The text of `file` when it is a regular file, or a link to one, of at most DEFINITION_CAP bytes, opened so a FIFO or a
// device never blocks; else null.
function read(file) {
  let fd;
  try {
    const entry = lstatSync(file);
    const target = entry.isSymbolicLink() ? statSync(file) : entry;
    if (!target.isFile() || target.size > DEFINITION_CAP) return null;
    fd = openSync(file, NO_BLOCK);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > DEFINITION_CAP) return null;
    const buffer = Buffer.alloc(opened.size);
    return buffer.subarray(0, readSync(fd, buffer, 0, opened.size, 0)).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// The first of `folders` that is a folder, or null: a linked worktree with no agents folder reads the main checkout's.
function agentsFolder(folders) {
  for (const folder of folders) {
    try {
      if (statSync(folder).isDirectory()) return folder;
    } catch {
      // Not there: the next one.
    }
  }
  return null;
}

// The text of the definition of the agent `type` names: this plugin's own for `aidrian:<name>`, else the `*.md` of the
// first of `folders` there is whose frontmatter `name` is `type`, as Claude Code names a custom subagent; null for
// another plugin's agent, a built-in one, or one no file defines.
function definitionOf(type, folders) {
  if (type.startsWith(PREFIX)) {
    const name = type.slice(PREFIX.length);
    return NAME.test(name) ? read(path.join(PLUGIN_AGENTS, `${name}.md`)) : null;
  }
  const folder = NAME.test(type) ? agentsFolder(folders) : null;
  const files = folder === null ? null : listed(folder);
  if (files === null) return null;
  // Past SCAN_BUDGET.files files, or SCAN_BUDGET.bytes bytes read in all, the scan stops with no definition.
  let bytes = 0;
  for (const file of files.slice(0, SCAN_BUDGET.files)) {
    const text = read(path.join(folder, file));
    if (text === null) continue;
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > SCAN_BUDGET.bytes) return null;
    if (frontmatterValue(text, 'name') === type) return text;
  }
  return null;
}

// The `*.md` names of `folder`, sorted, or null when it cannot be listed or holds more than SCAN_BUDGET.entries entries:
// the scan then names no definition, whichever of them would match.
function listed(folder) {
  let dir;
  const names = [];
  try {
    dir = opendirSync(folder);
    for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
      if (names.length === SCAN_BUDGET.entries) return null;
      names.push(entry.name);
    }
  } catch {
    return null;
  } finally {
    dir?.closeSync();
  }
  return names.filter((name) => name.endsWith('.md')).sort();
}

// The effort the subagent of the SubagentStart payload `input` runs at, one of `efforts`, or null, the first of:
//   1. the level the payload carries (`effort.level`);
//   2. `override`, the level the host's environment sets for every agent (CLAUDE_CODE_EFFORT_LEVEL); `auto` or `unset`
//      there leaves the effort to the launcher, and then no hint names one;
//   3. the effort the project's config.json `models` gives this plugin's agent, as the Agent tool's PreToolUse hook adds
//      it to the dispatch (agent-models.mjs agentCall);
//   4. its definition's `effort:` frontmatter, from this plugin's agents or the first of `folders` there is.
// A dispatch that sets its own effort may still differ, which the commit check names.
export function subagentEffort({ input, folders = [], efforts, models, override = null }) {
  const given = input?.effort?.level;
  if (efforts.includes(given)) return given;
  if (AUTOMATIC.has(override)) return null;
  if (efforts.includes(override)) return override;
  const type = typeof input?.agent_type === 'string' ? input.agent_type : '';
  const configured = type && models ? agentCall({ subagent_type: type }, models)?.effort : undefined;
  if (efforts.includes(configured)) return configured;
  const text = type ? definitionOf(type, folders) : null;
  const declared = text === null ? null : frontmatterValue(text, 'effort');
  return efforts.includes(declared) ? declared : null;
}
