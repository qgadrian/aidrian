// What the band and the pane read from the engine, git, the transcript, and the Linear answer, as plain values: the
// hooks gather the raw text and hand it here, so the logic is tested by `node --test` (test/claude-mod-pane.test.mjs).
// A mod module has no Node: this file imports only the mod's own format.mjs.
import { COLORS, displayText } from './format.mjs';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const stringOf = (value) => (typeof value === 'string' ? value : '');

const parseObject = (text) => {
  try {
    const value = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
};

// The issue the Linear lookup answered for `key`, from the MCP result's content blocks: `{ key, title, status, url }`
// as raw strings, which format.mjs's ticketRow cleans, keeping the url as a link only for that key's page; null when
// no text block holds one JSON object.
export function issueOf(key, content) {
  const blocks = Array.isArray(content) ? content : [];
  const block = blocks.find((one) => isObject(one) && one.type === 'text');
  const raw = parseObject(stringOf(block?.text));
  if (raw === null) return null;
  const status = isObject(raw.status) ? raw.status.name : raw.status;
  return { key, title: stringOf(raw.title), status: stringOf(status), url: stringOf(raw.url) };
}

const ONE_HOUR_MS = 3_600_000;
const FIVE_MINUTES_MS = 300_000;

// The prompt cache lifetime of the last main-chain reply in `tail`, the end of the transcript: one hour or five minutes,
// by the bucket it wrote to, or null when the last 20 lines that name a cache write hold no main-chain reply that wrote
// one (both buckets 0), so the lifetime read before stands.
export function cacheTtlOf(tail) {
  const lines = String(tail).split('\n').filter((line) => line.includes('"cache_creation"')).slice(-20);
  const written = lines.reverse().map(parseObject).find((entry) => {
    const isMain = entry?.type === 'assistant' && entry.isSidechain !== true;
    return isMain && isObject(entry.message?.usage?.cache_creation);
  });
  const buckets = written?.message?.usage?.cache_creation;
  if (Number(buckets?.ephemeral_1h_input_tokens ?? 0) > 0) return ONE_HOUR_MS;
  if (Number(buckets?.ephemeral_5m_input_tokens ?? 0) > 0) return FIVE_MINUTES_MS;
  return null;
}

// A linked worktree's git folder: `<repository>/.git/worktrees/<name>`, the name at the end.
const LINKED_WORKTREE_DIR = /\/\.git\/worktrees\/([^/]+)$/u;

// The checkout from git's answers: `branch --show-current`, `rev-parse --absolute-git-dir`, and `status --porcelain`.
// A linked worktree is labelled by its folder name, a detached checkout (no branch) as `detached`, and every label
// passes displayText.
export function repoOf({ branch, gitDir, status }) {
  const worktree = LINKED_WORKTREE_DIR.exec(String(gitDir).trim());
  const name = worktree?.[1] ?? String(branch).trim();
  const label = displayText(name || 'detached');
  return { label, isWorktree: worktree !== null, isDirty: String(status).trim().length > 0 };
}

const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const isEffortLevel = (value) => typeof value === 'string' && EFFORT_LEVELS.includes(value);

// `claude-<family>-<major>[-<minor>][-<date>]` as `{ family, major, minor }`, or null.
export function modelVersion(id) {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/iu.exec(id);
  return match ? { family: match[1].toLowerCase(), major: Number(match[2]), minor: Number(match[3] ?? 0) } : null;
}

const isAtLeast = (version, major, minor) => version.major > major || (version.major === major && version.minor >= minor);

// The model's own effort when nothing sets one: medium from 5.5 on, xhigh for Opus 4.7, else unknown.
function defaultEffort(version) {
  if (isAtLeast(version, 5, 5)) return 'medium';
  const isOpus47 = version.family === 'opus' && version.major === 4 && version.minor === 7;
  return isOpus47 ? 'xhigh' : null;
}

// The effort of the session, the way Claude Code picks it: the last turn's (`seen`), the CLAUDE_CODE_EFFORT_LEVEL value
// (`fromEnv`), the model's entry in the settings' `modelSettings`, the top-level `effortLevel` (ignored from Opus 5.5
// on), then the model's default. `model` is the session's model as `/model` shows it.
export function effortOf({ seen = null, fromEnv, model, settings }) {
  if (seen !== null) return seen;
  if (isEffortLevel(fromEnv)) return fromEnv;
  const id = String(model).replace(/\s*\[1m\]$/iu, '');
  const version = modelVersion(id);
  if (version === null) return null;
  const saved = isObject(settings) ? settings : {};
  const perModel = isObject(saved.modelSettings) ? saved.modelSettings[id]?.effortLevel : undefined;
  if (isEffortLevel(perModel)) return perModel;
  const isNewOpus = version.family === 'opus' && isAtLeast(version, 5, 5);
  if (isEffortLevel(saved.effortLevel) && !isNewOpus) return saved.effortLevel;
  return defaultEffort(version);
}

// The model as a person reads it: `claude-opus-5-5[1m]` and `Opus 5.5 (1M context)` both as `Opus 5.5`; any other
// name as it is, through displayText.
export function cleanModel(model) {
  const bare = displayText(String(model).replace(/\s*\(1M context\)/iu, '').replace(/\s*\[1m\]/iu, ''));
  const id = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/iu.exec(bare);
  if (id === null) return bare;
  const family = id[1].charAt(0).toUpperCase() + id[1].slice(1);
  const minor = id[3] ? `.${id[3]}` : '';
  return `${family} ${id[2]}${minor}`;
}

// A duration in the largest two units: `45s`, `3m05s`, `2h07m`, `2d2h`.
export function formatDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

// The milliseconds of the date string `at`, or null when `at` is not a date string that parses to a finite time: a
// number is drawn only when finite.
export function dateMs(at) {
  const ms = typeof at === 'string' ? Date.parse(at) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

// The time from `now` to the date `at` names, as formatDuration writes it, or '' when `at` is not a date string.
export function untilText(at, now) {
  const ms = dateMs(at);
  return ms === null ? '' : formatDuration(ms - now);
}

// The emoji of a model family on an agent's row; an unknown family gets a neutral one.
const FAMILY_ICONS = Object.freeze({ fable: '🦄', opus: '🪐', sonnet: '🪶', haiku: '🍃' });
const AGENT_WINDOW = 200_000;
const ACTIVE = new Set(['running', 'pending', 'waiting']);

const compactTokens = (tokens) => {
  if (tokens >= 1_000_000) return `${Math.floor(tokens / 100_000) / 10}M`;
  return tokens >= 1000 ? `${Math.floor(tokens / 1000)}k` : String(tokens);
};

// One subagent's row in Claude Code's agent list, from the engine's AgentInfo (`name`, `type`, `label`,
// `description`, `model`, `effort`, `contextWindowSize`, `tokenCount`, `status`), as `{ text, color }` parts within
// `columns`: `name [type]  48% (96k) · 🪐 Opus 5.5 xhigh`, and the status after them when it is not running. The name
// is cut first, then the type dropped, so the context and the model always show. It replaces the deprecated
// subagentStatusLine script, with the type read from the engine rather than the transcript.
export function agentRowParts(agent, columns = 80) {
  const info = isObject(agent) ? agent : {};
  const firstLine = (value) => stringOf(value).split('\n')[0];
  const name = displayText(stringOf(info.name) || firstLine(info.label) || firstLine(info.description) || 'agent');
  const type = displayText(stringOf(info.type));
  const model = stringOf(info.model);
  const window = Number.isFinite(info.contextWindowSize) && info.contextWindowSize > 0
    ? info.contextWindowSize
    : (/\[1m\]/iu.test(model) ? 1_000_000 : AGENT_WINDOW);
  const tokens = Number.isFinite(info.tokenCount) && info.tokenCount > 0 ? info.tokenCount : 0;
  const percent = Math.floor((tokens * 100) / window);
  const heat = percent >= 75 ? COLORS.failed : percent >= 50 ? COLORS.pending : COLORS.text;
  const family = modelVersion(model.replace(/\s*\[1m\]$/iu, ''))?.family;
  const effort = typeof info.effort === 'string' || Number.isFinite(info.effort) ? displayText(String(info.effort)) : '';
  const status = displayText(stringOf(info.status));
  const tail = [
    { text: `  ${percent}%`, color: heat },
    { text: ` (${compactTokens(tokens)})`, color: COLORS.muted },
    { text: ` · ${FAMILY_ICONS[family] ?? '✨'} `, color: COLORS.text },
    { text: model ? cleanModel(model) : '?', color: COLORS.text },
    ...(effort ? [{ text: ` ${effort}`, color: COLORS.muted }] : []),
    ...(status && !ACTIVE.has(status) ? [{ text: ` · ${status}`, color: COLORS.muted }] : []),
  ];
  // The emoji takes two columns and counts as one or two code points, so each is counted as two.
  const width = (text) => [...text].reduce((sum, char) => sum + (/\p{Extended_Pictographic}/u.test(char) ? 2 : 1), 0);
  const room = Math.max(0, columns - tail.reduce((sum, each) => sum + width(each.text), 0));
  const typeText = type ? ` [${type}]` : '';
  const keepsType = typeText && room - width(typeText) >= 6;
  const nameRoom = room - (keepsType ? width(typeText) : 0);
  const shown = [...name].length > nameRoom ? `${[...name].slice(0, Math.max(0, nameRoom - 1)).join('')}…` : name;
  return [
    { text: shown, color: COLORS.armed },
    ...(keepsType ? [{ text: typeText, color: COLORS.passed }] : []),
    ...tail,
  ];
}
