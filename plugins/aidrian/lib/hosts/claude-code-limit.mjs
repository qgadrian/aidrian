// Whether a Claude Code session a project run started met a usage or rate limit, from its own transcript
// (lib/project-limit.mjs, through `capabilities.projectStart.limitOf`). UNVERIFIED: no live session has shown what a
// limit leaves there. The record read is the one the host writes itself when an API call fails for good: an `assistant`
// entry with `isApiErrorMessage: true`. Its structured `error`, where the host writes one, decides: only `rate_limit`,
// the class the host's own code gives an account's limit too, is a limit. With none, its text, the host's own, must start
// with a limit's words, such as `Claude AI usage limit reached|<epoch seconds>`, `5-hour limit reached ∙ resets 5pm`,
// `You've hit your limit · resets 5pm (Europe/Madrid)`, or `API Error: 429` once the host's own retries ran out: the
// shapes the host's issue reports, changelog, and binary give, kept as fixtures in test/project-limit.test.mjs. The
// reset time is read against the entry's own `timestamp`, so a record read later still names the same time.
// Only the session's last assistant entry counts, and only when the host marked it so: no tool's output and no text the
// model wrote is read, so neither can fake a limit, and a limit the session got past counts no more.
// The transcript is `<config folder>/projects/<start folder, each character but a letter or digit as ->/<session>.jsonl`,
// else that file in any project folder there, as lib/hosts/claude-code-background.mjs sessionMode reads it.

import { readdirSync } from 'node:fs';
import path from 'node:path';

import { tailObjects } from '../fs.mjs';
import { configFolder } from './claude-code-sandbox.mjs';
import { clockTime, durationTime, epochTime } from './limit-time.mjs';

// How much of a transcript's end is read: the last entries, which a limit ends on.
const TAIL = 1024 * 1024;
const ID = /^[0-9A-Za-z][\w-]{3,127}$/u;
// How the host's own error text starts when it reports a limit, and the words that make it a usage limit, not a rate limit.
const LIMIT_TEXT = /^\s*(?:Claude AI usage limit reached|Claude usage limit reached|(?:5-hour|weekly|session|daily|opus|sonnet|usage)\s+limit reached|You've hit your (?:[\w-]+ )?limit|API Error: 429\b)/iu;
const USAGE = /\busage limit\b|\blimit reached\b|\bhit your (?:[\w-]+ )?limit\b/iu;
const EPOCH = /\|\s*(\d{9,11})\b/u;
const RESET = /\breset(?:s)?(?:\s+at)?\s+([^|]{1,80})/iu;
const AGAIN = /\btry again in\s+([^|]{1,80})/iu;
const ZONE = /\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){1,2}|UTC)\)/u;

// The transcript files the session `session` started in `cwd` may have, the likeliest first.
function transcripts({ session, cwd, env, home }) {
  const projects = path.join(configFolder(env, home), 'projects');
  const name = `${session}.jsonl`;
  const first = typeof cwd === 'string' ? [path.join(projects, cwd.replace(/[^A-Za-z0-9]/gu, '-'), name)] : [];
  let folders = [];
  try {
    folders = readdirSync(projects);
  } catch {
    // No projects folder: no transcript.
  }
  return [...new Set([...first, ...folders.map((folder) => path.join(projects, folder, name))])];
}

// The text of an entry's message: its text blocks, or its text.
function entryText(entry) {
  const content = entry?.message?.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join(' ') : '';
}

// When the limit the host's text `text`, written at `now`, reports lifts, in milliseconds since the epoch, or null when
// it names no time: an epoch after a bar first, then `resets <clock time>`, then `resets in` or `try again in` a span.
export function resetOf(text, now) {
  const epoch = EPOCH.exec(text);
  const atEpoch = epoch ? epochTime(epoch[1], now) : null;
  if (atEpoch !== null) return atEpoch;
  const reset = RESET.exec(text);
  const atClock = reset ? clockTime(reset[1], now, ZONE.exec(reset[1])?.[1] ?? null) : null;
  if (atClock !== null) return atClock;
  const span = reset ? durationTime(reset[1], now) : null;
  if (span !== null) return span;
  const again = AGAIN.exec(text);
  return again ? durationTime(again[1], now) : null;
}

// The limit the host's API error entry `entry` reports: { kind: 'usage' | 'rate', until, at }, `at` the entry's own
// time, or null when it gives none, `until` read against it, else `now`, and null when the text names no time; or null
// when the entry reports no limit.
export function entryLimit(entry, now) {
  if (entry?.type !== 'assistant' || entry.isApiErrorMessage !== true) return null;
  const text = entryText(entry);
  if (typeof entry.error === 'string' ? entry.error !== 'rate_limit' : !LIMIT_TEXT.test(text)) return null;
  const written = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN;
  const at = Number.isFinite(written) ? written : null;
  return { kind: USAGE.test(text) ? 'usage' : 'rate', until: resetOf(text, at ?? now), at };
}

// Whether the session `session`, started in `cwd`, last met a usage or rate limit: entryLimit's answer for the last
// assistant entry of its transcript, or null when there is none, it reports no limit, or no transcript can be read.
export function transcriptLimit({ session, cwd, env, home, now = Date.now() }) {
  if (typeof session !== 'string' || !ID.test(session)) return null;
  for (const file of transcripts({ session, cwd, env, home })) {
    const entries = tailObjects(file, TAIL);
    if (entries === null) continue;
    const last = entries.filter((entry) => entry.type === 'assistant' && (entry.sessionId === undefined || entry.sessionId === session)).at(-1);
    return entryLimit(last, now);
  }
  return null;
}
