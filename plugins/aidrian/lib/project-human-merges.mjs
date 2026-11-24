// The merges a project run leaves to the Human that init can already see, named in its first output so the Human hears
// of them before the run starts its first issue, never hours later when an issue's session reaches auto-merge:
//   - each open pull request of an issue the run resumes (project-run.mjs resumedIssues) whose changed files hold a path
//     auto-merge never merges, by the gate's own rule (pr-auto-merge.mjs neverMerged) under the default branch's policy
//     on the forge, read as the gate reads it (branchPolicies), lifts included;
//   - each issue the run may still start whose tracker text names a policy file (project.mjs isPolicyPath), as a
//     warning, since its diff does not exist yet, unless the default branch lifts policy files (includesPolicyFiles).
// It writes nothing and refuses nothing: a read the forge cannot answer is a line saying what cannot be told.
// Every read goes through the forge facade, and only when a resumed issue names a pull request or an issue's text names
// a policy file by its fixed name.

import { branchPolicies, ghError, includesPolicyFiles, neverMerged, readView, startDocs, VIEW_FIELDS, wholeFiles } from './pr-auto-merge.mjs';
import { isPolicyPath } from './project.mjs';

// The line prefix of every merge this module names, which the driver gives the Human word for word.
export const NEEDS_MERGE = 'needs your merge';
// The tracker text an issue's read records that the warning reads (project-issue-text.mjs recordedTexts).
const TEXT_FIELDS = ['title', 'description', 'criteria'];
// The statuses whose issue a run never starts, so its text warns of nothing.
const SETTLED = new Set(['completed', 'canceled']);

// The path-like words of `text`: split on spaces, quotes, and brackets, with a trailing stop or colon taken off.
const words = (text) => String(text ?? '').split(/[\s`'"()[\]{}<>,;|*]+/u).map((word) => word.replace(/[.:!?]+$/u, '')).filter(Boolean);

// The policy file each issue of `issues` names in its text `texts[key]`, as [{ key, path }], by `policyFiles`, in the
// snapshot's order, one per issue: an issue the run never starts, or one of `skip`, is left out.
function namedPolicyFiles(issues, texts, policyFiles = [], skip = new Set()) {
  const named = [];
  for (const issue of issues) {
    if (SETTLED.has(issue.status) || skip.has(issue.key)) continue;
    const text = TEXT_FIELDS.map((field) => texts?.[issue.key]?.[field]).filter((each) => typeof each === 'string').join('\n');
    const path = words(text).find((word) => isPolicyPath(word, policyFiles));
    if (path) named.push({ key: issue.key, path });
  }
  return named;
}

// The lines init and its check print for the merges the Human owes, as this file's header says, or none. `forge` is the
// forge facade, `repository` the one init pins ({ host, owner, name }), `prefix` a function that gives the project's
// folder from the top of the repository, with its trailing slash, or null when git cannot say (git.mjs knownPrefix),
// asked only once a read is needed, `pluginRepository` whether the project is the plugin's own (project.mjs
// isPluginRepository), `resumed` resumedIssues' resumed entries ({ key, pr }), `issues` the snapshot's issues, and
// `texts` the recorded tracker texts by key. Each line starts with NEEDS_MERGE:
//   `needs your merge: #<n> changes <path>, which auto-merge never merges`, for an open pull request;
//   `needs your merge, maybe: <key>'s text names <path>, ...`, for an issue's text;
//   `needs your merge, unknown: ...`, for a read that failed, naming what cannot be told.
export function humanMergeLines({ forge, repository, prefix = () => '', pluginRepository = false, resumed = [], issues = [], texts = {} }) {
  const pulls = resumed.filter((each) => Number.isInteger(each.pr) && each.pr > 0);
  if (!pulls.length && !namedPolicyFiles(issues, texts).length) return [];
  if (!repository) return [];
  const folder = prefix();
  if (folder === null) return [`${NEEDS_MERGE}, unknown: git cannot say where the project folder is in the repository, so which pull requests auto-merge never merges cannot be told`];
  const named = `${repository.owner}/${repository.name}`;
  let policies;
  try {
    policies = branchPolicies(forge, { repo: named, host: repository.host, base: null }, folder);
  } catch (error) {
    return [`${NEEDS_MERGE}, unknown: the default branch's config on the forge cannot be read (${String(error.message).split('\n')[0]}), so which pull requests auto-merge never merges cannot be told`];
  }
  const lines = [];
  const listed = new Set();
  // What the start hook loads, read once and only for a pull request whose files the paths check reads.
  let loaded;
  const docs = (pr) => {
    if (loaded === undefined) {
      loaded = startDocs(forge, pr, policies.main, policies.configFile, folder);
      if (typeof loaded === 'string') lines.push(`${NEEDS_MERGE}, unknown: ${loaded}, so a pull request that changes a doc every session loads is not named`);
    }
    return typeof loaded === 'string' ? undefined : loaded;
  };
  for (const { key, pr: number } of pulls) {
    const unknown = (why) => lines.push(`${NEEDS_MERGE}, unknown: #${number} of ${key}: ${why}, so whether auto-merge merges it cannot be told`);
    let view;
    try {
      view = forge.change(String(number), `${VIEW_FIELDS},state`, { repo: `${repository.host}/${named}` });
    } catch (error) {
      unknown(`the forge cannot read it (${ghError(error)})`);
      continue;
    }
    if (view?.state !== 'OPEN') continue;
    const pr = readView(view);
    if (typeof pr === 'string') {
      unknown(pr);
      continue;
    }
    if (pr.repo.toLowerCase() !== named.toLowerCase() || pr.host.toLowerCase() !== repository.host.toLowerCase()) continue;
    const whole = wholeFiles(forge, pr);
    if (typeof whole === 'string') {
      unknown(whole);
      continue;
    }
    const never = neverMerged(whole.files, folder, policies, { startDocs: docs(pr), pluginRepository });
    if (!never) continue;
    listed.add(key);
    lines.push(`${NEEDS_MERGE}: #${number} changes ${JSON.stringify(never.path)}, which auto-merge never merges`);
  }
  if (!includesPolicyFiles(policies)) {
    for (const { key, path } of namedPolicyFiles(issues, texts, policies.policyFiles, listed)) {
      lines.push(`${NEEDS_MERGE}, maybe: ${key}'s text names ${JSON.stringify(path)}, a policy file auto-merge never merges, so a pull request that changes it waits for your merge`);
    }
  }
  return lines;
}
