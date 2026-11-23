// B of the handoff cost model (docs/handoff.md#the-cost-model): the tokens a fresh session reads to resume from a brief,
// before its first edit or dispatch, per project. The Stop hook records one sample for each session that resumed from a
// brief, read from that session's own transcript (lib/transcript.mjs resumeRead), in `<state>/resume-tokens.json`;
// resumeTokens picks the value every reader of the cost model uses, so the Stop hook, the plan offer, and
// `aidrian session snapshot` never disagree.
//   resume-tokens.json  { samples: [{ session, tokens, at }] }   the newest KEPT_SAMPLES, oldest first

import { randomBytes } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { checkoutHolding, isObject, ownFolderSync, resolvedPath } from './fs.mjs';
import { readOwnFile, SESSION_ID } from './handoff-markers.mjs';
import { projectCheckouts, stateDir } from './project.mjs';
import { stateHeld } from './session-folder.mjs';
import { CONTINUATION_LEAD, resumeRead } from './transcript.mjs';

// The value with too few samples: the median over one machine's Claude Code transcripts, 405 sessions that handed off and
// 105 that resumed (docs/handoff.md#the-cost-model).
export const RESUME_TOKENS = 44_000;
// The samples a measured value needs, the most kept, and how long one counts.
export const MIN_SAMPLES = 5;
export const KEPT_SAMPLES = 50;
export const SAMPLE_DAYS = 30;
export const RESUME_FILE = 'resume-tokens.json';
// The largest samples file read: 50 samples take about 5 KiB.
const SAMPLES_CAP = 64 * 1024;
const SAMPLE_WINDOW = SAMPLE_DAYS * 24 * 60 * 60 * 1000;

const isSample = (value) => isObject(value) && typeof value.session === 'string' && SESSION_ID.test(value.session)
  && Number.isInteger(value.tokens) && value.tokens >= 0 && Number.isFinite(value.at);

// The samples of the state folder `state` taken in the SAMPLE_DAYS before `now`, oldest first, at most KEPT_SAMPLES.
// A file that is missing, a link, another user's, one its group or other users may write, over SAMPLES_CAP, or not this
// shape reads as none.
export function readSamples(state, now = Date.now()) {
  const read = readOwnFile(path.join(state, RESUME_FILE), { cap: SAMPLES_CAP });
  const held = read !== null && read.stat.nlink === 1 && (read.stat.mode & 0o022) === 0;
  const samples = held ? parsed(read.text)?.samples : null;
  if (!Array.isArray(samples)) return [];
  return samples.filter((each) => isSample(each) && now - each.at >= 0 && now - each.at <= SAMPLE_WINDOW).slice(-KEPT_SAMPLES);
}

const parsed = (text) => {
  try {
    return text === null ? null : JSON.parse(text);
  } catch {
    return null;
  }
};

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

// The B the cost model uses for config.json `session.handoff` in the state folder `state`: { tokens, source, samples }.
// `source` is `config` when `resumeTokens` is set there, which wins; else `measured`, the median of the samples, once
// there are MIN_SAMPLES; else `default`, RESUME_TOKENS. `samples` counts those read, null under `config`. A state folder
// of null reads no samples.
export function resumeTokens(handoff, state, now = Date.now()) {
  const set = handoff?.resumeTokens;
  if (Number.isInteger(set) && set > 0) return { tokens: set, source: 'config', samples: null };
  const samples = state ? readSamples(state, now) : [];
  if (samples.length >= MIN_SAMPLES) return { tokens: Math.round(median(samples.map(({ tokens }) => tokens))), source: 'measured', samples: samples.length };
  return { tokens: RESUME_TOKENS, source: 'default', samples: samples.length };
}

// The state folder `state`, a real path, when the samples may be kept there, else null: it lies inside none of the
// repository's `checkouts`, which git listed, so no branch supplies the file, and it and every folder above it let no
// other user replace what lies below (lib/session-folder.mjs stateHeld). The hooks ask through resumeState, and the
// snapshot with the state folder and checkouts it already read. Null gives no samples, so B is the default.
export const samplesFolder = (state, checkouts) => (state !== null && Array.isArray(checkouts)
  && checkoutHolding(state, checkouts) === undefined && stateHeld(state) ? state : null);

// samplesFolder for the state folder of `project` under `config`, or null when it cannot be named.
export function resumeState(project, config) {
  try {
    return samplesFolder(resolvedPath(stateDir(project, { config })), projectCheckouts(project));
  } catch {
    return null;
  }
}

// `handoff` with `resumeTokens` set to the value resumeTokens picks: what every caller hands lib/session-length.mjs.
export const resolvedHandoff = (handoff, state, now = Date.now()) => ({ ...handoff, resumeTokens: resumeTokens(handoff, state, now).tokens });

// Records the sample of the session `session` from its transcript `text`, once per session: the tokens recorded, or null
// when the session shows no resume, has made no call of `workTools` yet, already has a sample, measured a call with no
// time or one too old to keep, or the write failed.
// A transcript that names neither the session-continue skill nor a continuation block is not parsed at all.
export function recordResume(state, session, text, workTools, now = Date.now()) {
  if (typeof session !== 'string' || !SESSION_ID.test(session) || !workTools?.length) return null;
  if (!text.includes('session-continue') && !text.includes(CONTINUATION_LEAD)) return null;
  const samples = readSamples(state, now);
  if (samples.some((each) => each.session === session)) return null;
  const read = resumeRead(text, workTools);
  // Kept at the time of the call it measured, so a session read again after its sample left the window, or was pushed
  // out by newer ones, falls out again at once; a call with no time, or one already out of the window, is not kept.
  if (read === null || read.at === null || now - read.at > SAMPLE_WINDOW) return null;
  const sample = { session, tokens: read.tokens, at: read.at };
  const next = [...samples, sample].sort((a, b) => a.at - b.at).slice(-KEPT_SAMPLES);
  return next.includes(sample) && writeSamples(state, next) ? read.tokens : null;
}

// Writes the samples as a new temporary file, mode 0600, renamed over the file, in a state folder this user owns.
// SHORTCUT: two sessions that record at the same moment may keep only one of their samples; a median of up to 50 loses
// little, and a lock would cost every stop.
function writeSamples(state, samples) {
  if (!ownFolderSync(state)) return false;
  const file = path.join(state, RESUME_FILE);
  const temporary = path.join(state, `.${RESUME_FILE}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify({ samples })}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
    return true;
  } catch {
    rmSync(temporary, { force: true });
    return false;
  }
}
