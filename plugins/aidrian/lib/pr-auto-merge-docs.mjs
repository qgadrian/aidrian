// The `none_needed` route of `aidrian pr auto-merge`'s review check (lib/pr-auto-merge.mjs reviewProblem): when a pull
// request that needed no review may merge with no Human. The team opts in by naming the files in
// `github.autoMerge.unreviewedPaths`, committed on both the default branch and the base: the gate cannot tell which files
// an AI session reads as instructions, so it takes the team's word for which files no session reads, and only then.
// On top of the list, every changed file must be added, modified, or deleted, sort as `review.nonBehaviour` by the
// default branch's review lists (a `review.ignore` file was read by no review), have an extension of SAFE_EXTENSIONS, and
// pass the per-path refusals: no GUARDED_PATHS file whatever includeGuardedPaths says, which holds every host's
// instruction files, no knowledge doc the start hook loads (startLoadProblem), no folder or name that starts with ".",
// and no test file, fixture, or golden file. The record's plan reasons must be exactly ONLY_NON_BEHAVIOUR, at depth
// `none`. Last, every file still at the head must be a regular file there (modeProblem): the forge's changed-file list
// gives no mode, so the head's tree is read. Beyond the two branches' config.json, it reads what the paths check read of
// the default branch's knowledge, and that tree. Not configurable past the list.

import path from 'node:path';

import { GUARDED_PATHS } from './project.mjs';
import { QUIET_TEST_FILES } from './review/diff.mjs';
import { globPattern } from './fs.mjs';
import { classify, ONLY_NON_BEHAVIOUR, pathPattern } from './review/plan.mjs';

// The only extensions a pull request merged with no review may change, whatever a list says: Markdown and raster
// images. A file with no extension, an SVG, which can hold script, and every other text format are out.
const SAFE_EXTENSIONS = Object.freeze(['.md', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico']);

// A folder or file name that starts with ".", anywhere in the path: tools and AI hosts read such paths as settings, and
// every host's folder, such as .github/prompts/ or .kiro/, starts with one.
const DOT_SEGMENT = /(?:^|\/)\./u;

// What a test reads: the review's test files (review/diff.mjs), and fixture or golden folders.
const TEST_FILES = QUIET_TEST_FILES.map(pathPattern);
const FIXTURES = /(?:^|\/)(?:fixtures?|__fixtures__|testdata|test-data|goldens?|__goldens?__)\//iu;

// The change types a file may have: a type change (CHANGED), a copy, or a rename may hide what it does.
const PLAIN_CHANGES = new Set(['ADDED', 'MODIFIED', 'DELETED']);

// The default branch's config errors under `review`, such as a misspelt `review.nonBehavior`: any of them may leave its
// review lists other than the team meant.
const unreadableLists = (error) => error.includes('"review');

// An `unreviewedPaths` entry as a matcher of the whole path from the project root: a glob, or a `re:` anchored at both
// ends, so `re:README\.md$` does not admit prompts/README.md.
const wholePath = (entry) => (entry.startsWith('re:') ? new RegExp(`^(?:${entry.slice('re:'.length)})$`, 'u') : globPattern(entry));

// The git modes of a regular file, plain or executable. A symbolic link (120000) at an allowed path is no prose: a static
// server or site builder that follows it can publish what it points at. A submodule (160000) is another repository.
const FILE_MODES = new Set(['100644', '100755']);
const LINK_MODE = '120000';
const SUBMODULE_MODE = '160000';

// Why `loaded` cannot say what the start hook loads into every session, or null. `loaded` is what pr-auto-merge.mjs
// startDocs read from the default branch: { docs, folder }, each from the top of the repository, or a string saying why
// it could not be read.
export const startUnreadable = (loaded) =>
  (typeof loaded === 'string' ? `the default branch's knowledge cannot say which docs the start hook loads into every session (${loaded})` : null);

// Why the changed file `file`, from the top of the repository, is one the start hook loads, by `loaded`, or null: an
// `always` doc of a bucket, or a file in the knowledge folder whose indexes name them. Compared ignoring case, as the
// policy files are, since a disk that ignores case loads either spelling.
export function startLoadProblem(file, loaded) {
  const lower = file.toLowerCase();
  const named = JSON.stringify(file);
  if (loaded.docs.some((doc) => doc.toLowerCase() === lower)) return `it changes ${named}, a knowledge doc the start hook loads into every session`;
  if (loaded.folder && lower.startsWith(`${loaded.folder.toLowerCase()}/`)) return `it changes ${named}, in the default branch's knowledge folder, which decides what the start hook loads`;
  return null;
}

// Why a changed file still at `head` is no regular file there, or null. Each path is looked up in the head commit's
// tree, one folder at a time through `tree(sha)`, which gives a folder of the forge's tree ({ tree: [{ path, mode, type,
// sha }], truncated }) and throws on a failed read; each folder is read once. A deleted file is not at the head. A read
// that fails, or a folder the forge gives in part, keeps the route off: a mode it cannot read is no regular file.
function modeProblem(files, head, tree) {
  const short = String(head).slice(0, 7);
  const folders = new Map();
  const entriesOf = (sha, where) => {
    if (folders.has(sha)) return folders.get(sha);
    let body;
    try {
      body = tree(sha);
    } catch (error) {
      return `the head's tree at ${short} cannot be read (${error.message})`;
    }
    if (!Array.isArray(body?.tree) || body.truncated === true) return `the forge returned no whole tree of ${where} at head ${short}`;
    const entries = new Map(body.tree.map((entry) => [entry?.path, entry]));
    folders.set(sha, entries);
    return entries;
  };
  for (const { path: file, changeType } of files) {
    if (changeType === 'DELETED') continue;
    const named = JSON.stringify(file);
    const parts = file.split('/');
    let [sha, where] = [head, 'the repository root'];
    for (const [index, part] of parts.entries()) {
      const entries = entriesOf(sha, where);
      if (typeof entries === 'string') return entries;
      const entry = entries.get(part);
      if (!entry) return `it changes ${named}, which the head's tree does not hold`;
      const above = parts.slice(0, index + 1).join('/');
      if (index < parts.length - 1) {
        if (entry.type !== 'tree' || typeof entry.sha !== 'string') return `it changes ${named}, below ${JSON.stringify(above)}, which is no folder at the head`;
        [sha, where] = [entry.sha, JSON.stringify(above)];
        continue;
      }
      if (entry.mode === LINK_MODE) return `it changes ${named}, a symbolic link at the head, which a server or site builder may follow`;
      if (entry.mode === SUBMODULE_MODE) return `it changes ${named}, a submodule at the head, whose files no review read`;
      if (!FILE_MODES.has(entry.mode)) return `it changes ${named}, whose mode at the head is ${entry.mode ?? 'none'}, not a regular file's`;
    }
  }
  return null;
}

// Why the change type `changeType` of `named` keeps the route off, or null.
function changeProblem(named, changeType) {
  if (PLAIN_CHANGES.has(changeType)) return null;
  if (changeType === 'COPIED') return `it adds ${named} as a copy of another file, which gh does not name`;
  if (changeType === 'CHANGED') return `it changes ${named} as CHANGED, a type change, which may make it a link or a submodule`;
  return `it changes ${named} as ${changeType || 'no change type'}, which may hide what it does`;
}

// Why one changed file's path keeps the route off, or null. `file` is { path, changeType } from the top of the
// repository; `own` its path from the project root; `loaded` what the start hook loads. Each refusal reads the repository
// path, so a folder above the project root counts too; DOT_SEGMENT matches at any depth, so the repository path covers it.
function pathProblem({ path: file, changeType }, own, loaded) {
  const named = JSON.stringify(file);
  const changed = changeProblem(named, changeType);
  if (changed) return changed;
  if (GUARDED_PATHS.test(file) || GUARDED_PATHS.test(own)) return `it changes ${named}, which instructs AI sessions`;
  const started = startLoadProblem(file, loaded);
  if (started) return started;
  if (DOT_SEGMENT.test(file)) return `it changes ${named}, whose path has a folder or file name that starts with ".", which tools and AI hosts read as settings`;
  // On both paths, as GUARDED_PATHS above: a project inside a fixtures/ or tests/ folder is itself test data.
  const testRead = (each) => TEST_FILES.some((pattern) => pattern.test(each)) || FIXTURES.test(each);
  if (testRead(file) || testRead(own)) return `it changes ${named}, a test file, fixture, or golden file, which a test reads`;
  return null;
}

// Why one changed file keeps the route off, or null: its path, the default branch's review lists, the safe extensions,
// each branch's `unreviewedPaths`, [[where, matchers]], and what the start hook loads.
function fileProblem(file, prefix, review, lists, loaded) {
  const named = JSON.stringify(file.path);
  if (!file.path.startsWith(prefix)) return `it changes ${named}, outside this project's folder`;
  const own = file.path.slice(prefix.length);
  const problem = pathProblem(file, own, loaded);
  if (problem) return problem;
  const sorted = classify([{ file: own }], review);
  if (sorted.ignored.length) return `it changes ${named}, which the default branch's review.ignore lists, so no review read it`;
  if (sorted.behaviour.length) return `it changes ${named}, which the default branch's review.nonBehaviour does not list`;
  if (!SAFE_EXTENSIONS.includes(path.posix.extname(own).toLowerCase())) {
    return `it changes ${named}, whose extension is not one a merge with no review may change (${SAFE_EXTENSIONS.join(', ')})`;
  }
  const unlisted = lists.find(([, patterns]) => !patterns.some((pattern) => pattern.test(own)));
  return unlisted ? `it changes ${named}, which github.autoMerge.unreviewedPaths on ${unlisted[0]} does not list` : null;
}

// Why a `none_needed` outcome on the head does not stand for a review, or null. `files` is the paths check's whole list
// of changed files from the top of the repository, `prefix` the project's folder in it, `review` the default branch's
// `review` group, `errors` that config's errors, `lists` each branch's `unreviewedPaths` as [[`<repo> <branch>`, list]],
// the default branch first and the base once, and `listErrors` the errors either config has under that key. `startDocs`
// is what the start hook loads (startLoadProblem), and `tree` reads a folder of the head's tree (modeProblem); with
// either missing, the route is off.
export function noneNeededProblem(outcome, { files = null, prefix = '', review = null, errors = [], lists = null, listErrors = [], startDocs = null, tree = null }) {
  const { reasons } = outcome;
  if (!Array.isArray(reasons) || reasons.length !== 1 || reasons[0] !== ONLY_NON_BEHAVIOUR) return `its plan's reasons are not exactly ${JSON.stringify([ONLY_NON_BEHAVIOUR])}`;
  if (outcome.depth !== 'none') return 'its plan\'s depth is not `none`';
  if (!Array.isArray(files) || !Array.isArray(review?.ignore) || !Array.isArray(review?.nonBehaviour) || !Array.isArray(lists) || !lists.length) return 'the gate has no file list or no lists to sort it by';
  if (startDocs === null || typeof tree !== 'function') return 'the gate has not read what the start hook loads, or cannot read the head\'s tree';
  const unreadable = startUnreadable(startDocs);
  if (unreadable) return unreadable;
  if (listErrors.length) return `the team's config cannot say which files may merge with no review (${JSON.stringify(listErrors[0])})`;
  const empty = lists.find(([, list]) => !Array.isArray(list) || !list.length);
  if (empty) return `the team lists no github.autoMerge.unreviewedPaths on ${empty[0]}`;
  const broken = errors.find(unreadableLists);
  if (broken) return `the default branch's config cannot say which files cannot change behaviour (${JSON.stringify(broken)})`;
  if (!files.length) return 'nothing was reviewed';
  const matchers = lists.map(([where, list]) => [where, list.map(wholePath)]);
  for (const file of files) {
    const problem = fileProblem(file, prefix, review, matchers, startDocs);
    if (problem) return problem;
  }
  return modeProblem(files, outcome.head, tree);
}
