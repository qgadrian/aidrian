// The delivery check behind a subagent's `stop` row (dispatch-rows.mjs stopRow, scripts/hook-subagent-stop.mjs): the .md
// and .json paths its last message presents as written, and those of them that exist under none of the roots such a path
// can be relative to. A path is sent back only when it exists nowhere the agent could have meant, so each root here is one
// a real report named a file from, and that the check once missed: the state folder (`dispatch/`, `plans/`, `reviews/`,
// `tmp/`), the plugin and its skill folders (`references/tracker.md`, `skills/<name>/...`), the project and every worktree
// of its repository, and any file the agent's own Read, Write, or Edit calls named, such as one in another project.
// The check also reads the subagent's brief: a handoff file the brief asks this agent to write, an absolute
// `<state>/dispatch/*.json` path whose name holds the agent's own, must exist when it stops. A handback can reach another
// session than the one that dispatched it, or none once that one has ended, so the file is the record its dispatcher reads.
// docs/hooks.md#delivery-check.

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { checkoutRoots, runGit } from './git.mjs';
import { stateDir } from './project.mjs';
import { firstPrompt, readText, filesTouched } from './transcript.mjs';

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
export function checkDelivery(input, project) {
  const cwd = typeof input.cwd === 'string' ? input.cwd : project.root;
  const claims = claimedPaths(input.last_assistant_message);
  const unwritten = unwrittenHandoffs(input, project);
  if (!claims.length) return { claims, missing: [], unwritten };
  const missing = missingPaths(claims, cwd, { roots: () => deliveryRoots(project, cwd), touched: () => touchedFiles(input) });
  return { claims, missing, unwritten };
}

// The handoff files a subagent's brief asks it to write that do not exist: each absolute `<state>/dispatch/<name>.json`
// in the transcript's first prompt whose `<name>` holds the agent's own name, such as `feat-12-S1-code-reviewer.json` for
// `aidrian:code-reviewer`. A path named for another agent, such as a handoff the brief tells it to read, is not its own.
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
  const named = [...brief.matchAll(new RegExp(`${escapeRegExp(folder)}/([\\w.@+-]+\\.json)`, 'gu'))];
  // The agent's name as a whole word of the file name: `critic` is not in `fix-critical-S1-backend-developer.json`.
  const word = new RegExp(`(?:^|[-_.])${escapeRegExp(agent)}[-_.]`, 'u');
  const own = named.filter((match) => word.test(match[1])).map((match) => match[0]);
  return [...new Set(own)].filter((file) => !existsSync(file));
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

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
  const resolve = (base, claim) => (claim.startsWith('~/') ? path.join(homedir(), claim.slice(2)) : path.resolve(base, claim));
  let checkouts;
  let others;
  let files;
  return claims.filter((claim) => {
    if (existsSync(resolve(cwd, claim))) return false;
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

// The other roots a relative claim may be read from: the project, its state folder, every worktree of its repository,
// this plugin, its skills folder, and each skill's folder.
export function deliveryRoots(project, cwd) {
  const roots = [project.root];
  try {
    roots.push(stateDir(project));
  } catch {
    // No state folder to read: the other roots still count.
  }
  roots.push(...worktreeRoots(cwd), PLUGIN_FOLDER, ...skillFolders());
  return [...new Set(roots)];
}

// Every worktree of the repository `cwd` is in, from `git worktree list`; none outside git.
function worktreeRoots(cwd) {
  const { status, stdout } = runGit(['worktree', 'list', '--porcelain'], cwd);
  if (status !== 0) return [];
  return stdout.split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length));
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
