// The delivery check behind a subagent's `stop` row (dispatch-rows.mjs stopRow, scripts/hook-subagent-stop.mjs): the .md
// and .json paths its last message presents as written, and those of them that exist under none of the roots such a path
// can be relative to. A path is sent back only when it exists nowhere the agent could have meant, so each root here is one
// a real report named a file from, and that the check once missed: the state folder (`dispatch/`, `plans/`, `reviews/`,
// `tmp/`), the plugin and its skill folders (`references/tracker.md`, `skills/<name>/...`), the project and every worktree
// of its repository, and any file the agent's own Read, Write, or Edit calls named, such as one in another project.
// docs/hooks.md#delivery-check.

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { checkoutRoots, runGit } from './git.mjs';
import { stateDir } from './project.mjs';
import { readText, filesTouched } from './transcript.mjs';

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

// The paths a subagent's last message presents as delivered, and those of them that exist nowhere: { claims, missing }.
export function checkDelivery(input, project) {
  const cwd = typeof input.cwd === 'string' ? input.cwd : project.root;
  const claims = claimedPaths(input.last_assistant_message);
  if (!claims.length) return { claims, missing: [] };
  const missing = missingPaths(claims, cwd, { roots: () => deliveryRoots(project, cwd), touched: () => touchedFiles(input) });
  return { claims, missing };
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
