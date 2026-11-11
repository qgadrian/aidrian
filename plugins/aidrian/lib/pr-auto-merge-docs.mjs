// The `none_needed` route of `aidrian pr auto-merge`'s review check (lib/pr-auto-merge.mjs reviewProblem): when a pull
// request that needed no review may merge with no Human. The team opts in by naming the files in
// `github.autoMerge.unreviewedPaths`, committed on both the default branch and the base: the gate cannot tell which files
// an AI session reads as instructions, so it takes the team's word for which files no session reads, and only then.
// On top of the list, every changed file must be added, modified, or deleted, sort as `review.nonBehaviour` by the
// default branch's review lists (a `review.ignore` file was read by no review), have an extension of SAFE_EXTENSIONS, and
// pass the per-path refusals: no GUARDED_PATHS file whatever includeGuardedPaths says, no folder or name that starts
// with ".", no HOST_INSTRUCTIONS name, and no test file, fixture, or golden file. The record's plan reasons must be
// exactly ONLY_NON_BEHAVIOUR, at depth `none`. It reads nothing beyond the two branches' config.json. Not configurable past
// the list. Symlink and gitlink modes are not checked: gh lists no file mode (issue #259).

import path from 'node:path';

import { GUARDED_PATHS } from './project.mjs';
import { QUIET_TEST_FILES } from './review/diff.mjs';
import { globPattern } from './fs.mjs';
import { classify, ONLY_NON_BEHAVIOUR, pathPattern } from './review/plan.mjs';

// The only extensions a pull request merged with no review may change, whatever a list says: Markdown and raster
// images. A file with no extension, an SVG, which can hold script, and every other text format are out.
const SAFE_EXTENSIONS = Object.freeze(['.md', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico']);

// The instruction files of AI hosts by name, at any depth and in any case, such as AGENTS.override.md or CLAUDE.local.md.
// The hosts' folders, such as .cursor/ or .github/prompts/, all start with ".", which DOT_SEGMENT refuses.
const HOST_INSTRUCTIONS = /(?:^|\/)(?:AGENTS?|CLAUDE|GEMINI|QWEN|WARP|CRUSH|CONVENTIONS)(?:\.[^/]+)?\.md$/iu;

// A folder or file name that starts with ".", anywhere in the path: tools and AI hosts read such paths as settings.
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

// Why the change type `changeType` of `named` keeps the route off, or null.
function changeProblem(named, changeType) {
  if (PLAIN_CHANGES.has(changeType)) return null;
  if (changeType === 'COPIED') return `it adds ${named} as a copy of another file, which gh does not name`;
  if (changeType === 'CHANGED') return `it changes ${named} as CHANGED, a type change, which may make it a link or a submodule`;
  return `it changes ${named} as ${changeType || 'no change type'}, which may hide what it does`;
}

// Why one changed file's path keeps the route off, or null. `file` is { path, changeType } from the top of the
// repository; `own` its path from the project root.
function pathProblem({ path: file, changeType }, own) {
  const named = JSON.stringify(file);
  const changed = changeProblem(named, changeType);
  if (changed) return changed;
  if (GUARDED_PATHS.test(file) || GUARDED_PATHS.test(own)) return `it changes ${named}, which instructs AI sessions`;
  if (DOT_SEGMENT.test(file)) return `it changes ${named}, whose path has a folder or file name that starts with ".", which tools and AI hosts read as settings`;
  if (HOST_INSTRUCTIONS.test(file)) return `it changes ${named}, an instruction file of an AI host`;
  if (TEST_FILES.some((pattern) => pattern.test(own)) || FIXTURES.test(own)) return `it changes ${named}, a test file, fixture, or golden file, which a test reads`;
  return null;
}

// Why one changed file keeps the route off, or null: its path, the default branch's review lists, the safe extensions,
// and each branch's `unreviewedPaths`, [[where, matchers]].
function fileProblem(file, prefix, review, lists) {
  const named = JSON.stringify(file.path);
  if (!file.path.startsWith(prefix)) return `it changes ${named}, outside this project's folder`;
  const own = file.path.slice(prefix.length);
  const problem = pathProblem(file, own);
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
// the default branch first and the base once, and `listErrors` the errors either config has under that key.
export function noneNeededProblem(outcome, { files = null, prefix = '', review = null, errors = [], lists = null, listErrors = [] }) {
  const { reasons } = outcome;
  if (!Array.isArray(reasons) || reasons.length !== 1 || reasons[0] !== ONLY_NON_BEHAVIOUR) return `its plan's reasons are not exactly ${JSON.stringify([ONLY_NON_BEHAVIOUR])}`;
  if (outcome.depth !== 'none') return 'its plan\'s depth is not `none`';
  if (!Array.isArray(files) || !Array.isArray(review?.ignore) || !Array.isArray(review?.nonBehaviour) || !Array.isArray(lists) || !lists.length) return 'the gate has no file list or no lists to sort it by';
  if (listErrors.length) return `the team's config cannot say which files may merge with no review (${JSON.stringify(listErrors[0])})`;
  const empty = lists.find(([, list]) => !Array.isArray(list) || !list.length);
  if (empty) return `the team lists no github.autoMerge.unreviewedPaths on ${empty[0]}`;
  const broken = errors.find(unreadableLists);
  if (broken) return `the default branch's config cannot say which files cannot change behaviour (${JSON.stringify(broken)})`;
  if (!files.length) return 'nothing was reviewed';
  const matchers = lists.map(([where, list]) => [where, list.map(wholePath)]);
  for (const file of files) {
    const problem = fileProblem(file, prefix, review, matchers);
    if (problem) return problem;
  }
  return null;
}
