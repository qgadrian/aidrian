// The drafts a pull request leaves in the state folder's `tmp/` (docs/project-folder.md#local-state), and their removal
// once the pull request is merged or closed. A draft is named for its pull request's number: the findings files each
// agent pass of `aidrian pr review` writes, in `review-<n>/`, or `review-<n>-<owner>--<name>/` for a pull request of
// another remote's repository, either led by the issue key in an issue session (dispatch.mjs findingsFile), and the files skills draft for
// one pull request, `pr-<n>-review.md` and `product-feedback-<n>.md` with its `product-feedback-<n>-items.json`.
// They hold full finding text, from security passes too, and nothing reads them once the pull request has closed.
// A draft whose pull request is open, or whose state the forge cannot give, is kept. Drafts named for a branch, such
// as `pr-body-<branch>.md`, are not a pull request's by number, and stay.

import { lstatSync, readdirSync, rmdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import { forgeFor } from '../forges/index.mjs';
import { stateDir } from '../project.mjs';
import { remoteRepos } from '../remotes.mjs';
import { recordRepos } from './state.mjs';

// A draft's name, with its pull request's number in the one group that matched.
// A findings folder of another remote's repository names it, `<owner>--<name>`: GitHub owners hold no `--`.
// An issue session's findings folder leads with its issue key (dispatch.mjs findingsFile). An issue session names its
// own scratch for its key too, so such a folder loses only its findings files, and goes only once nothing else is left
// (removeDraft).
const ISSUE_LED = /^(?:[a-z][a-z0-9]{0,15}-)?[1-9][0-9]{0,8}-review-/u;
const DRAFT = /^(?:(?:(?:[a-z][a-z0-9]{0,15}-)?[1-9][0-9]{0,8}-)?review-([1-9]\d{0,9})(?:-([\w.-]+?)--([\w.-]+))?|pr-([1-9]\d{0,9})-review\.md|product-feedback-([1-9]\d{0,9})(?:-items\.json|\.md))$/u;
// The most pull requests one sweep reads the state of, lowest number first: each is one forge call.
export const MAX_SWEPT = 50;
// The forge's states of a pull request no draft is kept for.
const ENDED = new Map([['MERGED', 'merged'], ['CLOSED', 'closed']]);

// The drafts in `dir`, by pull request, lowest number first: Map<key, { pr, repo, files }>, `repo` null for a draft
// that names none, and `<owner>/<name>` for a findings folder of another remote's repository, kept apart from its
// number's other drafts, since its pull request is another one.
export function draftsByPr(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return new Map();
  }
  const out = new Map();
  for (const name of names.sort()) {
    const match = DRAFT.exec(name);
    if (!match) continue;
    const pr = Number(match[1] ?? match[4] ?? match[5]);
    const repo = match[2] ? `${match[2]}/${match[3]}`.toLowerCase() : null;
    const key = repo ? `${pr}@${repo}` : String(pr);
    const group = out.get(key) ?? { pr, repo, files: [] };
    group.files.push(name);
    out.set(key, group);
  }
  return new Map([...out].sort(([, a], [, b]) => a.pr - b.pr || (a.repo === null ? -1 : b.repo === null ? 1 : a.repo.localeCompare(b.repo))));
}

// Removes the drafts of every pull request in `tmp/` that the forge reads as merged or closed, at most MAX_SWEPT of
// them. The repository asked is the one a findings folder names, else every one this machine holds a review record of
// that number for, else every one the remotes name when they name several, else the checkout's own. Returns
// { removed: [{ pr, state, files }], kept: [{ pr, reason }], failed: [{ pr, file, error }] }: kept is an open pull
// request, one whose state could not be read, or one past the limit.
export function sweepDrafts(project, { forge = forgeFor(project.root), limit = MAX_SWEPT, dir = path.join(stateDir(project), 'tmp') } = {}) {
  const out = { removed: [], kept: [], failed: [] };
  let read = 0;
  // A known limit, accepted: every cleanup reads from the lowest pull request number, so when more than `limit` pull
  // requests with drafts stay open or unreadable, the ones past them are never read and their drafts stay. It needs over
  // 50 open pull requests with drafts on one machine, so a start that rotates between cleanups is not worth its cost.
  for (const { pr, repo: named, files } of draftsByPr(dir).values()) {
    const tag = named ? { repo: named } : {};
    if (read >= limit) {
      out.kept.push({ pr, ...tag, reason: `past the ${limit} pull requests one cleanup reads` });
      continue;
    }
    read += 1;
    // A draft keyed by its repository asks that one. A draft that names none may be any repository's pull request of
    // that number: it goes only once every repository this machine holds a review record of that number for reads as
    // merged or closed; with no record, every repository the remotes name when they name several, else the checkout's own.
    const recorded = named ? [named] : recordRepos(project, pr).filter(Boolean);
    const remotes = recorded.length ? [] : [...new Set(remoteRepos(project))];
    const repos = recorded.length ? recorded : remotes.length > 1 ? remotes : [];
    const states = (repos.length ? repos : [null]).map((repo) => {
      try {
        return forge.change(String(pr), 'state', repo ? { repo } : {})?.state ?? null;
      } catch {
        return null;
      }
    });
    const open = states.find((state) => !ENDED.has(state));
    if (open !== undefined) {
      out.kept.push({ pr, ...tag, reason: open === 'OPEN' ? 'open' : 'its state could not be read' });
      continue;
    }
    const state = states.at(-1);
    const gone = [];
    for (const file of files) {
      try {
        if (removeDraft(path.join(dir, file), ISSUE_LED.test(file))) gone.push(file);
      } catch (error) {
        out.failed.push({ pr, file, error: error.message });
      }
    }
    if (gone.length) out.removed.push({ pr, ...tag, state: ENDED.get(state), files: gone });
  }
  return out;
}

// Removes the draft `file`: whole, or, for a folder an issue session's key leads (`led`), only the regular
// `*.findings.json` files in it, and then the folder once it is empty. A led entry that is no folder, or a link, stays.
// Returns whether the draft is gone.
function removeDraft(file, led) {
  if (!led) {
    rmSync(file, { recursive: true, force: true });
    return true;
  }
  const stat = lstatSync(file);
  if (!stat.isDirectory()) return false;
  for (const name of readdirSync(file)) {
    const entry = path.join(file, name);
    if (name.endsWith('.findings.json') && lstatSync(entry).isFile()) rmSync(entry, { force: true });
  }
  if (readdirSync(file).length) return false;
  rmdirSync(file);
  return true;
}
