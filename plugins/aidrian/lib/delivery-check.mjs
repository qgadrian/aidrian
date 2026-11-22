// The delivery check behind a subagent's `stop` row (dispatch-rows.mjs stopRow, scripts/hook-subagent-stop.mjs): the .md
// and .json paths its last message presents as written, and those of them that exist under none of the roots such a path
// can be relative to. A path is sent back only when it exists nowhere the agent could have meant, so each root here is one
// a real report named a file from, and that the check once missed: the state folder (`dispatch/`, `plans/`, `reviews/`,
// `tmp/`), the plugin and its skill folders (`references/tracker.md`, `skills/<name>/...`), the project and every worktree
// of its repository, and any file the agent's own Read, Write, or Edit calls named, such as one in another project.
// The check also reads the subagent's brief: a handoff file the brief asks this agent to write, an absolute
// `<state>/dispatch/*.json` path whose name holds the agent's own, must exist when it stops. A handback can reach another
// session than the one that dispatched it, or none once that one has ended, so the file is the record its dispatcher reads.
// When the agent stops without it, with none of its own background tasks running, and is not sent back for another reason,
// the stop hook writes its final report there (deliverHandoffs): a brief can name the file for an agent with no file tool or shell, or make it optional,
// and the report is the handoff either way. The agent is sent back for it only when it has no report to write.
// A handoff file counts as written only when it is a regular file changed at or after the subagent's transcript began,
// by its first entry's timestamp: one an earlier dispatch left, a link, or a folder is stale, owed, and replaced. A
// transcript with no timestamp keeps the file's existence as the test. The brief's `Handoff file: <path>` lines name the
// run's output, so a sign-off brief that names an earlier run's handoff of the same role to read never owes it; a brief
// with no such line owes its one file of the agent's role, and none when it names several.
// While one of its own background tasks runs and a later stop is sure, the file is not due yet, and owes nothing.
// docs/hooks.md#delivery-check.

import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { checkoutRoots, repositoryCheckouts } from './git.mjs';
import { stateDir } from './project.mjs';
import { firstPrompt, readText, filesTouched, lastHandback } from './transcript.mjs';

const CLAIMED_PATHS = 20;
// A path an agent's last message names: a .md or .json token with a `/`, not inside a URL or a template, and not after
// an ellipsis character, which shortens it.
const CLAIM = /(?<![\w.~/:@<>{}$*%#…-])(~?[\w.-]*\/[\w.~/-]*\.(?:md|json))(?![\w/<>{}*-])/gu;
// A line that presents a file as delivered: a delivery word that is not part of a path, or the 📄 file marker.
const DELIVERY_LINE = /(?<![\w./-])(?:wrote|written|created|saved|handoffs?|outputs?)(?![\w./-])|📄/iu;
// A path shortened with `...`, such as `.../review/x.json`: its full form is unknown, so it cannot be checked.
const ELIDED = /(?:^|\/)\.{3,}(?:\/|$)/u;
// This plugin's folder: lib/ is one below it.
const PLUGIN_FOLDER = path.resolve(import.meta.dirname, '..');

// The paths a subagent's last message presents as delivered, those of them that exist nowhere, and the handoff files its
// brief asks for that it has not written: { claims, missing, unwritten }.
// `since` is when the subagent's transcript began, or null (handoffSince).
export function checkDelivery(input, project) {
  const cwd = typeof input.cwd === 'string' ? input.cwd : project.root;
  const claims = claimedPaths(input.last_assistant_message);
  const unwritten = unwrittenHandoffs(input, project);
  const since = handoffSince(input);
  if (!claims.length) return { claims, missing: [], unwritten, since };
  const missing = missingPaths(claims, cwd, { roots: () => deliveryRoots(project, cwd), touched: () => touchedFiles(input) });
  return { claims, missing, unwritten, since };
}

// When the subagent's run began: the timestamp of its transcript's first entry, in milliseconds, or null when the
// transcript holds none.
export function handoffSince(input) {
  const transcript = typeof input.agent_transcript_path === 'string' ? readText(input.agent_transcript_path) : null;
  const first = transcript?.split('\n').find((line) => line.trim() !== '');
  if (!first) return null;
  try {
    const at = Date.parse(JSON.parse(first)?.timestamp);
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

// Whether the handoff file `file` counts as written by this run: with `since`, a regular file, not a link or a folder,
// whose status changed at or after it; without, any file there.
function handedIn(file, since) {
  if (since === null) return existsSync(file);
  try {
    const stat = lstatSync(file);
    return stat.isFile() && stat.ctimeMs >= since;
  } catch {
    return false;
  }
}

// The handoff files a subagent's brief asks it to write that it has not written (handedIn): each absolute
// `<state>/dispatch/<name>.json` in the transcript's first prompt whose `<name>` ends with the agent's own name, such as `feat-12-S1-code-reviewer.json`
// or `S1-code-reviewer-result.json` for `aidrian:code-reviewer`. A path named for another agent, such as a handoff the brief tells it to read, is not its own.
// With `Handoff file:` lines, only the paths on them count; without, only a brief that names one such file owes it.
// No brief, no agent name, or no state folder: none.
export function unwrittenHandoffs(input, project) {
  const agent = typeof input.agent_type === 'string' ? input.agent_type.split(':').pop() : '';
  const transcript = agent && typeof input.agent_transcript_path === 'string' ? readText(input.agent_transcript_path) : null;
  const brief = transcript ? firstPrompt(transcript) : null;
  if (!brief) return [];
  let folder;
  try {
    folder = path.join(stateDir(project), 'dispatch');
  } catch {
    return [];
  }
  const pathIn = (text) => [...text.matchAll(new RegExp(`${escapeRegExp(folder)}/([\\w.@+-]+\\.json)`, 'gu'))];
  // The agent's name as the file name's last word, or the one before a last word such as `result`: a branch that holds
  // the name, as in `fix-code-reviewer-S1-backend-developer.json`, does not make the file this agent's.
  const word = new RegExp(`(?:^|[-_.])${escapeRegExp(agent)}(?:[-_.]\\w+)?\\.json$`, 'u');
  const ownIn = (text) => [...new Set(pathIn(text).filter((match) => word.test(match[1])).map((match) => match[0]))];
  // The brief's `Handoff file:` lines name the run's output; any other file of its role there is one to read.
  // With no such line, a brief that names one file of its role owes it, and one that names several owes none.
  const marked = brief.split('\n').filter((line) => HANDOFF_MARKER.test(line));
  const own = marked.length ? ownIn(marked.join('\n')) : ownIn(brief);
  const briefed = marked.length || own.length === 1 ? own : [];
  const since = handoffSince(input);
  return briefed.filter((file) => !handedIn(file, since));
}

// A brief line that names the run's handoff file: `Handoff file: <path>`, in any case, after an optional list marker.
const HANDOFF_MARKER = /^\s*(?:[-*]\s+)?(?:\*\*)?handoff file:/iu;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

// `delivery` once the agent's final report is written to each handoff file it owes (`unwritten`), with `written`, the
// files the hook wrote, and those files out of `unwritten` and `missing`. A stop with a background task of the agent's
// own still `running`, and a later stop sure to come (the stop hook decides), is no end of its work, so nothing is written then, and no handoff is due yet: the owed files move
// from `unwritten` to `pending`, and out of `claims` and `missing` when the report names them, so they neither send the
// agent back nor count as undelivered, and the stop row says `pending`. The delivery check once
// filed a lesson on every such stop, though the next stop, with the task done, wrote the file. Nothing is written with
// no report either (finalReport).
// With `write: false`, nothing is written: the result is the delivery as it would be once every owed file is, with
// `written` empty, so the stop hook decides on a send-back before it writes. A report the agent is sent back to correct
// is not its last, and a file written from it would stand, since a later stop skips a handoff file that exists.
export function deliverHandoffs(input, delivery, { running = false, write = true } = {}) {
  const owed = delivery.unwritten ?? [];
  // A pending file is out of `claims` and `missing` too: a report that names it on a delivery line, such as a `Handoff:`
  // line, would otherwise send the agent back for it and count it undelivered, or show on the stop row as a file delivered.
  if (owed.length && running) {
    const named = { claims: uncovered(input, delivery.claims, owed), missing: uncovered(input, delivery.missing, owed) };
    return { ...delivery, ...named, unwritten: [], pending: owed, written: [] };
  }
  const report = owed.length ? finalReport(input) : null;
  if (report === null) return { ...delivery, written: [] };
  const written = write ? writeHandoffs(owed, report, { since: delivery.since ?? null }) : [];
  const covered = write ? written : owed;
  return { ...delivery, missing: uncovered(input, delivery.missing, covered), unwritten: owed.filter((file) => !covered.includes(file)), written };
}

// The `claims` that name none of `files`: a claim names a file when it resolves to it from the hook's folder,
// or is its tail.
function uncovered(input, missing, files) {
  const cwd = typeof input.cwd === 'string' ? input.cwd : null;
  const names = (claim) => files.some((file) => (cwd && file === resolveClaim(cwd, claim)) || file.endsWith(`${path.sep}${path.normalize(claim)}`));
  return missing.filter((claim) => !names(claim));
}

// The subagent's final report: the message of its last handback call (transcript.mjs lastHandback), else its last
// message; null when neither holds text.
export function finalReport(input) {
  const transcript = typeof input.agent_transcript_path === 'string' ? readText(input.agent_transcript_path) : null;
  const handback = transcript ? lastHandback(transcript) : null;
  const report = handback ?? input.last_assistant_message;
  return typeof report === 'string' && report.trim() !== '' ? report : null;
}

// Writes `report` to each of `files` this run has not written, and returns those written. A file that appeared since
// the check, as one its dispatcher wrote, is kept as it is; one that cannot be written is left owed. With `since`, when
// the subagent's run began, a stale file, one changed before it, a link, or anything but a regular file, is replaced: the
// report goes to a new temporary file beside it, made only when none is there, then renamed over it, so no link is
// followed. A folder cannot be replaced, and stays owed.
export function writeHandoffs(files, report, { since = null } = {}) {
  const body = `${JSON.stringify(handoffRecord(report), null, 2)}\n`;
  return files.filter((file) => {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      if (since === null) {
        writeFileSync(file, body, { flag: 'wx' });
        return true;
      }
      if (handedIn(file, since)) return false;
      const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      writeFileSync(temporary, body, { flag: 'wx', mode: 0o600 });
      try {
        renameSync(temporary, file);
      } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
      }
      return true;
    } catch {
      return false;
    }
  });
}

// What a handoff file holds for `report`: the JSON object it is, alone or as its one fenced block, else the report as
// text, `{ "written_by": "stop-hook", "report": "<text>" }`, so a reader can tell the hook wrote it.
const FENCED = /^```(?:json)?\s*\n([\s\S]*?)\n```$/u;
export function handoffRecord(report) {
  const text = report.trim();
  const json = FENCED.exec(text)?.[1] ?? text;
  try {
    const value = JSON.parse(json);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    // Not JSON: written as text.
  }
  return { written_by: 'stop-hook', report: text };
}

// The .md and .json paths a message presents as delivered, once each, at most CLAIMED_PATHS. A path on any other line
// is a mention, such as "docs/old.md does not exist", and is never checked; nor is a path shortened with `...` or `…`.
export function claimedPaths(message) {
  if (typeof message !== 'string') return [];
  const lines = message.split('\n').filter((line) => DELIVERY_LINE.test(line));
  const claims = lines.flatMap((line) => [...line.matchAll(CLAIM)].map((match) => match[1].replace(/[.]+$/u, '')));
  return [...new Set(claims.filter((claim) => !ELIDED.test(claim)))].slice(0, CLAIMED_PATHS);
}

// The claimed paths that exist nowhere: not absolute or from `cwd`, not from its checkout or the main checkout, and not
// from any of the other `roots` or the end of a `touched` file, each read only once a claim needs it.
export function missingPaths(claims, cwd, { roots = () => [], touched = () => [] } = {}) {
  let checkouts;
  let others;
  let files;
  return claims.filter((claim) => {
    if (existsSync(resolveClaim(cwd, claim))) return false;
    if (path.isAbsolute(claim) || claim.startsWith('~/')) return true;
    checkouts ??= checkoutRoots(cwd);
    if (checkouts && [checkouts.current, checkouts.main].some((root) => existsSync(path.join(root, claim)))) return false;
    others ??= roots();
    if (others.some((root) => existsSync(path.join(root, claim)))) return false;
    files ??= touched();
    const tail = `${path.sep}${path.normalize(claim)}`;
    return !files.some((file) => file.endsWith(tail) && existsSync(file));
  });
}

// A claimed path as a file: `~/` from the home folder, any other relative path from `base`.
const resolveClaim = (base, claim) => (claim.startsWith('~/') ? path.join(homedir(), claim.slice(2)) : path.resolve(base, claim));

// The other roots a relative claim may be read from: the project, its state folder, every worktree of its repository,
// this plugin, its skills folder, and each skill's folder.
export function deliveryRoots(project, cwd) {
  const roots = [project.root];
  try {
    roots.push(stateDir(project));
  } catch {
    // No state folder to read: the other roots still count.
  }
  roots.push(...(repositoryCheckouts(cwd) ?? []), PLUGIN_FOLDER, ...skillFolders());
  return [...new Set(roots)];
}

function skillFolders() {
  const skills = path.join(PLUGIN_FOLDER, 'skills');
  try {
    return [skills, ...readdirSync(skills, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(skills, entry.name))];
  } catch {
    return [];
  }
}

// The absolute files the subagent's own Read, Write, and Edit calls named.
function touchedFiles(input) {
  const transcript = typeof input.agent_transcript_path === 'string' ? readText(input.agent_transcript_path) : null;
  return transcript ? filesTouched(transcript).filter((file) => path.isAbsolute(file)) : [];
}
