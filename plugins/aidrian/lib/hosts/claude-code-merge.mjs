// Claude Code's answer to capabilities.mergePermission (docs/providers/claude-code.md#merge-permission-in-auto-mode):
// whether the settings it can read hold no rule or entry that names a merge, where auto mode's classifier blocks by
// default the merge of a pull request no human approved (code.claude.com/docs/en/permission-modes and
// auto-mode-config, read on 2026-11-25, with no live run). That block is the Human's to keep or to except, in settings
// of their own: this file only reads, and its answer allows nothing. `uncovered` is given for one shape alone: auto
// mode, a user settings file that is read, no permission rule in it that may reach a merge, and lists of auto mode this
// file knows, where the built-in block rules stand and no entry names a merge. Prose that names none may still cover
// one, which no matcher reads. Every other shape answers `unknown`, and nothing here throws on one. It reads the user
// settings alone: an issue's session starts with `--setting-sources user` (claude-code-background.mjs launch), so no
// project or local settings file applies to its merge. Managed settings and a `--settings` value are not read. It reads
// no network and starts no process.

import path from 'node:path';

import { sessionMode } from './claude-code-background.mjs';
import { configDir } from './claude-code-config.mjs';
import { DEFAULTS, isObject, isStrings, mayReach, MISSING, readSettings, RULE_LISTS } from './claude-code-settings.mjs';

const UNKNOWN = Object.freeze({ answer: 'unknown' });
// The command an issue's session merges with, which a permission rule may reach.
const MERGE = 'gh pr merge';
// A rule that names a merge of a pull request in other words, such as `mcp__github__merge_pull_request` or
// `Bash(gh -R acme/widget pr merge:*)`: the word `merge`, and a word for a pull request or its command.
const MERGE_WORD = /merge/iu;
const CHANGE_WORD = /(?<![\p{L}\p{N}])(?:gh|prs?|pulls?)(?![\p{L}\p{N}])|pull.?request/iu;
// An auto mode entry that may speak of a merge: the prose is the classifier's to read, so any such word is enough.
const MERGE_PROSE = /merg|pull.?request|(?<![\p{L}\p{N}])prs?(?![\p{L}\p{N}])/iu;
// What the host blocks, and what of its settings was checked: never that nothing covers a merge.
const WHY = 'in auto mode it blocks by default a merge of a pull request no human approved, and the settings this check can read hold no rule or entry that names a merge';
// The lists of auto mode: the two a custom entry may except a merge in, and the two whose built-in rules block one,
// which a custom list keeps only with "$defaults" in it.
const PROSE_LISTS = ['environment', 'allow'];
const BLOCK_LISTS = ['soft_deny', 'hard_deny'];
const KNOWN_KEYS = new Set([...PROSE_LISTS, ...BLOCK_LISTS, 'classifyAllShell']);

const mayReachMerge = (rule) => mayReach(rule, MERGE) || (MERGE_WORD.test(rule) && CHANGE_WORD.test(rule));

// Whether the permission rules of the user settings `settings`, read, hold none that may reach a merge; rules of a shape
// this does not know may hold one.
function rulesLeaveMerge(settings) {
  const { permissions } = settings;
  if (permissions === undefined) return true;
  if (!isObject(permissions)) return false;
  const lists = RULE_LISTS.map((key) => permissions[key]).filter((list) => list !== undefined);
  return lists.every((list) => isStrings(list) && !list.some(mayReachMerge));
}

// Whether auto mode's lists in the user settings `user` are ones this knows, keep the built-in block rules, and mention
// no merge.
function autoModeLeavesMerge({ autoMode }) {
  if (autoMode === undefined) return true;
  if (!isObject(autoMode) || Object.keys(autoMode).some((key) => !KNOWN_KEYS.has(key))) return false;
  const silent = (list) => list === undefined || (isStrings(list) && !list.some((entry) => MERGE_PROSE.test(entry)));
  const kept = (list) => list === undefined || (isStrings(list) && list.some((entry) => entry.trim() === DEFAULTS));
  return PROSE_LISTS.every((key) => silent(autoMode[key])) && BLOCK_LISTS.every((key) => kept(autoMode[key]));
}

// { answer: 'unknown' }, or { answer: 'uncovered', setting, file, why }, for the session `session` whose permission mode
// the run will have, its transcript found from the folder `cwd`. `readMode` reads the session's mode,
// which a test replaces; outside `auto` no classifier judges a merge, and no settings file is read.
export function mergePermission({ session, cwd, env = process.env, readMode = sessionMode }) {
  if (readMode({ session, cwd, env }) !== 'auto') return UNKNOWN;
  const file = path.join(configDir(env), 'settings.json');
  if (!path.isAbsolute(file)) return UNKNOWN;
  const user = readSettings(file);
  if (user === MISSING || user === null) return UNKNOWN;
  if (!rulesLeaveMerge(user) || !autoModeLeavesMerge(user)) return UNKNOWN;
  return { answer: 'uncovered', setting: 'autoMode.allow', file, why: WHY };
}
