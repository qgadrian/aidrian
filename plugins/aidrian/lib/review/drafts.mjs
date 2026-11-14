// The drafts a pull request leaves in the state folder's `tmp/` (docs/project-folder.md#local-state), and their removal
// once the pull request is merged or closed. A draft is named for its pull request's number: the findings files each
// agent pass of `aidrian pr review` writes, in `review-<n>/`, or `review-<n>-<owner>--<name>/` for a pull request of
// another remote's repository (dispatch.mjs findingsFile), and the files skills draft for
// one pull request, `pr-<n>-review.md` and `product-feedback-<n>.md` with its `product-feedback-<n>-items.json`.
// They hold full finding text, from security passes too, and nothing reads them once the pull request has closed.
// A draft whose pull request is open, or whose state the forge cannot give, is kept. Drafts named for a branch, such
// as `pr-body-<branch>.md`, are not a pull request's by number, and stay.

import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import { forgeFor } from '../forges/index.mjs';
import { stateDir } from '../project.mjs';
import { readLocalState } from './state.mjs';

// A draft's name, with its pull request's number in the one group that matched.
// A findings folder of another remote's repository names it, `<owner>--<name>`: GitHub owners hold no `--`.
const DRAFT = /^(?:review-([1-9]\d{0,9})(?:-([\w.-]+?)--([\w.-]+))?|pr-([1-9]\d{0,9})-review\.md|product-feedback-([1-9]\d{0,9})(?:-items\.json|\.md))$/u;
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
// them. The repository asked is the one the pull request's review record names, else the checkout's own. Returns
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
    const repo = named ?? readLocalState(project, pr)?.repo;
    let state = null;
    try {
      state = forge.change(String(pr), 'state', typeof repo === 'string' && repo ? { repo } : {})?.state ?? null;
    } catch {}
    if (!ENDED.has(state)) {
      out.kept.push({ pr, ...tag, reason: state === 'OPEN' ? 'open' : 'its state could not be read' });
      continue;
    }
    const gone = [];
    for (const file of files) {
      try {
        rmSync(path.join(dir, file), { recursive: true, force: true });
        gone.push(file);
      } catch (error) {
        out.failed.push({ pr, file, error: error.message });
      }
    }
    if (gone.length) out.removed.push({ pr, ...tag, state: ENDED.get(state), files: gone });
  }
  return out;
}
