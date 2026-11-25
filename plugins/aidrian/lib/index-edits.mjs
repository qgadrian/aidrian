// The knowledge index files an attempt on the base branch's copies of the host files (lib/project-start.mjs
// prepareAttempt) may still change, in git's index alone: the host's start hook and `aidrian-knowledge` read an index
// from disk as instructions, so the disk keeps the base copy, and the branch's own version stays data in git. The start
// gives them once, from the pinned base tip, its start row keeps them, and the push guard
// (lib/issue-push-checkout.mjs) holds the attempt's commits to them.

import { cleanText } from './clean-text.mjs';
import { isGuardedPath, knowledgeIn } from './project.mjs';

// The most index files one start gives.
const INDEX_CAP = 20;
// The most characters a list in base-copies.txt shows of a name.
const BASE_COPY_NAME_CAP = 200;
// A path as such a list shows it: cleaned to one line and cut.
export const shownPath = (file) => cleanText(file, BASE_COPY_NAME_CAP, { domains: false });
const INDEX_NAME = /^[a-z0-9][\w.-]*\.json$/u;
// The mode of a plain file, the only one an index may have.
export const PLAIN_FILE = '100644';
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

// The index files of `files`, the paths a start put base copies at, as [{ path, base }]: each direct `.json` child of
// the knowledge folder beside the config.json `policyFiles` names, which the gate resolved at the base tip, in its exact
// case and with a plain name, none a host loads at any depth (GUARDED_PATHS), that the branch's head holds as a plain
// file and whose path a list shows exactly as it is (shownPath), since the session types it. `head` and `tip` are the two commits' files
// (project-trust.mjs commitFiles); `base` is the tip's blob there, null when it has none. None unless `policy`, read at
// that tip, has includePolicyFiles on.
export function indexFilesOf({ policy, policyFiles, files, head, tip }) {
  const config = policyFiles?.[1];
  if (policy?.includePolicyFiles !== true || typeof config !== 'string' || !head || !tip) return [];
  const folder = `${knowledgeIn(config)}/`;
  const named = (name) => INDEX_NAME.test(name) && !isGuardedPath(name);
  const editable = (file) => file.startsWith(folder) && named(file.slice(folder.length)) && head.get(file)?.mode === PLAIN_FILE && shownPath(file) === file;
  return files.filter(editable).slice(0, INDEX_CAP).map((file) => ({ path: file, base: tip.get(file)?.id ?? null }));
}

// The entries of a start row's `indexFiles` in the shape indexFilesOf gives; one of any other shape is dropped.
export const indexFilesIn = (value) => (Array.isArray(value) ? value : [])
  .filter((each) => typeof each?.path === 'string' && (each.base === null || (typeof each.base === 'string' && OBJECT_ID.test(each.base))))
  .map(({ path, base }) => ({ path, base }));

// How a session changes such a file, for the first message and the push guard's refusals. `<path>` stays a placeholder:
// a file name is the branch's text, so it reaches neither as a command.
export const INDEX_RECIPE = 'from the clone\'s root, each word that holds `<path>` quoted as one shell word, `git show :<path>` into a temporary file outside the clone, edit that, `git hash-object -w --no-filters <temporary file>`, '
  + `\`git update-index --cacheinfo ${PLAIN_FILE},<id>,<path> --skip-worktree -- <path>\`, then \`git commit\` with no \`-a\` and no path`;
