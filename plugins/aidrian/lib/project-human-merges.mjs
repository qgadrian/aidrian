// The merges a project run leaves to the Human that init can already see, named in its first output so the Human hears
// of them before the run starts its first issue, never hours later when an issue's session reaches auto-merge:
//   - each open pull request of an issue the run resumes (project-run.mjs resumedIssues), from the branch it resumes on,
//     whose changed files hold a path auto-merge never merges, by the gate's own rule (pr-auto-merge.mjs neverMerged)
//     under the default branch's policy and the pull request's base's, read from the forge as the gate reads them
//     (branchPolicies), lifts included;
//   - each issue the run may still start (project-run.mjs mayStart) whose tracker text names a policy file (project.mjs
//     isPolicyPath), the config a pointer file relocates included, as a warning, since its diff does not exist yet;
//     while the default branch lifts policy files (includesPolicyFiles), only one that names the pointer file.
// It writes nothing and refuses nothing: a read the forge cannot answer is a line saying what cannot be told.
// Every read goes through the forge facade, and none is made with no resumed pull request and no text to read.

import path from 'node:path';

import { branchPolicies, ghError, includesPolicyFiles, movedPointer, neverMerged, readView, startDocs, VIEW_FIELDS, wholeFiles } from './pr-auto-merge.mjs';
import { isPolicyPath } from './project.mjs';

// The line prefix of every merge this module names, which the driver gives the Human word for word.
export const NEEDS_MERGE = 'needs your merge';
// The tracker text an issue's read records that the warning reads (project-issue-text.mjs recordedTexts).
const TEXT_FIELDS = ['title', 'description', 'criteria'];

// The recorded text of issue `key` in `texts`, or '' when no read recorded any.
const textOf = (texts, key) => TEXT_FIELDS.map((field) => texts?.[key]?.[field]).filter((each) => typeof each === 'string').join('\n');
// The path-like words of `text`: split on spaces, quotes, and brackets, with a trailing stop or colon taken off.
const words = (text) => text.split(/[\s`'"()[\]{}<>,;|*]+/u).map((word) => word.replace(/[.:!?]+$/u, '')).filter(Boolean);

const firstLine = (error) => String(error.message).split('\n')[0];

// The warning of each issue of `keys` whose text in `texts` names a policy file, one line an issue. A text names a path
// from the top of the repository or from the project folder `folder`, so each word, normalized, is judged as both. Both
// lifts leave the pointer file alone (movedPointer), as the gate does.
function textLines({ forge, pinned, folder, keys, texts }) {
  let policies;
  try {
    policies = branchPolicies(forge, { ...pinned, base: null }, folder);
  } catch (error) {
    return [`${NEEDS_MERGE}, unknown: the default branch's config on the forge cannot be read (${firstLine(error)}), so which issues name a policy file auto-merge never merges cannot be told`];
  }
  const isHeld = includesPolicyFiles(policies)
    ? (file) => movedPointer([{ path: file }], folder) !== undefined
    : (file) => isPolicyPath(file, policies.policyFiles);
  const isNamed = (word) => [word, `${folder}${word}`].some((file) => isHeld(path.posix.normalize(file)));
  return keys.flatMap((key) => {
    const named = words(textOf(texts, key)).find(isNamed);
    return named ? [`${NEEDS_MERGE}, maybe: ${key}'s text names ${JSON.stringify(named)}, a policy file auto-merge never merges, so a pull request that changes it waits for your merge`] : [];
  });
}

// What one resumed issue's pull request `number` says: { line }, none when it needs no merge of the Human's or is not
// open in the pinned repository from the pinned repository's own `branch`, which the issue resumes on, as openPullHead
// (project-result.mjs) ties them, and `named` when the line names it. `policiesOf(base)` gives branchPolicies' answer for
// that base, and `docsOf(policies)` startDocs', each read once.
function pullLine({ forge, repository, pinned, folder, pluginRepository, policiesOf, docsOf, key, number, branch }) {
  const unknown = (why) => ({ line: `${NEEDS_MERGE}, unknown: #${number} of ${key}: ${why}, so whether auto-merge merges it cannot be told` });
  let view;
  try {
    view = forge.change(String(number), `${VIEW_FIELDS},state,headRefName,isCrossRepository`, { repo: `${repository.host}/${pinned.repo}` });
  } catch (error) {
    return unknown(`the forge cannot read it (${ghError(error)})`);
  }
  if (view?.state !== 'OPEN' || view.headRefName !== branch || view.isCrossRepository !== false) return {};
  const pr = readView(view);
  if (typeof pr === 'string') return unknown(pr);
  if (pr.repo.toLowerCase() !== pinned.repo.toLowerCase() || pr.host.toLowerCase() !== repository.host.toLowerCase()) return {};
  let policies;
  try {
    policies = policiesOf(pr.base);
  } catch (error) {
    return unknown(`the config of its base ${JSON.stringify(pr.base)} or of the default branch cannot be read on the forge (${firstLine(error)})`);
  }
  const whole = wholeFiles(forge, pr);
  if (typeof whole === 'string') return unknown(whole);
  const never = neverMerged(whole.files, folder, policies, { startDocs: docsOf(policies), pluginRepository });
  return never ? { named: true, line: `${NEEDS_MERGE}: #${number} changes ${JSON.stringify(never.path)}, which auto-merge never merges` } : {};
}

// A function of one argument that keeps `read`'s answer for each `keyOf(argument)`; a throw is not kept.
function kept(read, keyOf = (each) => each) {
  const answers = new Map();
  return (argument) => {
    const key = keyOf(argument);
    if (!answers.has(key)) answers.set(key, read(argument));
    return answers.get(key);
  };
}

// The lines init and its check print for the merges the Human owes, as this file's header says, or none. `forge` is the
// forge facade, `repository` the one init pins ({ host, owner, name }), `prefix` a function that gives the project's
// folder from the top of the repository, with its trailing slash, or null when git cannot say (git.mjs knownPrefix),
// asked only once a read is needed, `pluginRepository` whether the project is the plugin's own (project.mjs
// isPluginRepository), `resumed` resumedIssues' resumed entries ({ key, pr, branch }), `startable` the keys of the issues the
// run may still start (project-run.mjs mayStart), and `texts` the recorded tracker texts by key. Each line starts with
// NEEDS_MERGE:
//   `needs your merge: #<n> changes <path>, which auto-merge never merges`, for an open pull request;
//   `needs your merge, maybe: <key>'s text names <path>, ...`, for an issue's text;
//   `needs your merge, unknown: ...`, for a read that failed, naming what cannot be told.
export function humanMergeLines({ forge, repository, prefix = () => '', pluginRepository = false, resumed = [], startable = [], texts = {} }) {
  const pulls = resumed.filter((each) => Number.isInteger(each.pr) && each.pr > 0);
  const written = [...startable].filter((key) => textOf(texts, key).trim() !== '');
  if (!repository || (!pulls.length && !written.length)) return [];
  const folder = prefix();
  if (folder === null) return [`${NEEDS_MERGE}, unknown: git cannot say where the project folder is in the repository, so which pull requests auto-merge never merges cannot be told`];
  const pinned = { repo: `${repository.owner}/${repository.name}`, host: repository.host };
  const policiesOf = kept((base) => branchPolicies(forge, { ...pinned, base }, folder));
  const notes = [];
  const docsOf = kept((policies) => {
    const loaded = startDocs(forge, pinned, policies.main, policies.configFile, folder);
    if (typeof loaded !== 'string') return loaded;
    notes.push(`${NEEDS_MERGE}, unknown: ${loaded}, so a pull request that changes a doc every session loads is not named`);
    return undefined;
  }, ({ main, configFile }) => `${main}:${configFile}`);
  const read = pulls.map(({ key, pr: number, branch }) => ({ key, ...pullLine({ forge, repository, pinned, folder, pluginRepository, policiesOf, docsOf, key, number, branch }) }));
  // An issue whose pull request is named already needs no warning of its text.
  const named = new Set(read.filter((each) => each.named).map(({ key }) => key));
  const keys = written.filter((key) => !named.has(key));
  return [...notes, ...read.flatMap(({ line }) => (line ? [line] : [])), ...(keys.length ? textLines({ forge, pinned, folder, keys, texts }) : [])];
}
