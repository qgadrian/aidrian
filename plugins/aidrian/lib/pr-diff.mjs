// A pull request's diff, as `aidrian pr product-feedback diff` writes it for the product-manager read: the forge's, or,
// when the forge refuses a diff that large (diffTooLarge), git's own diff of the two commits the forge names
// (changeEnds), run in this checkout. A commit the checkout lacks is fetched first, from the remote that names the pull
// request's repository, else `origin`. git runs through runGit: an argument list, never a shell, under the plugin's
// hardened settings. Any other forge failure still fails, as it always has.

import { diffTooLarge, remoteIdentity } from './forges/index.mjs';
import { readRemoteUrls, runGit } from './git.mjs';
import { ghError } from './pr-auto-merge.mjs';

// A full commit id: SHA-1, or SHA-256 for a repository that uses it.
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
// The most a local diff may print, as the forge's own reads (GH_MAX_BUFFER_BYTES): past it the command fails, naming it.
export const LOCAL_DIFF_MAX_BYTES = 64 * 1024 * 1024;
// A fetch and a diff of a large pull request take longer than runGit's default, which is a hook's.
const FETCH_TIMEOUT_MS = 120_000;
const DIFF_TIMEOUT_MS = 60_000;

// The diff of `pr` ({ number, host, repo }) as { text, local }: `local` is null for the forge's, else
// { base, head, fetched }, the two commits git compared and the ones it fetched. Throws with what failed.
export function pullRequestDiff({ forge, pr, root }) {
  try {
    return { text: forge.diff(pr.number, { repo: `${pr.host}/${pr.repo}` }), local: null };
  } catch (error) {
    if (!diffTooLarge(error)) throw new Error(`could not read the diff of #${pr.number} with gh (${ghError(error)})`);
  }
  try {
    return localDiff({ forge, pr, root });
  } catch (error) {
    throw new Error(`gh refused the diff of #${pr.number} as too large, and the local diff failed: ${error.message}`);
  }
}

// git's diff of the merge base of the pull request's base and its head, to its head, as GitHub shows a pull request.
function localDiff({ forge, pr, root }) {
  const { base, head } = endsOf(forge, pr);
  const fetched = [base, head].filter((sha, index, all) => all.indexOf(sha) === index && !hasCommit(root, sha));
  if (fetched.length) fetchCommits(root, pr, fetched);
  const result = runGit(['diff', '--no-color', `${base}...${head}`, '--'], root, { maxBuffer: LOCAL_DIFF_MAX_BYTES, timeout: DIFF_TIMEOUT_MS });
  if (result.error?.code === 'ENOBUFS') throw new Error(`git diff ${base}...${head} printed more than ${LOCAL_DIFF_MAX_BYTES / 1024 / 1024} MB`);
  if (result.status !== 0) throw new Error(`git diff ${base}...${head} failed (${gitError(result)})`);
  return { text: result.stdout, local: { base, head, fetched } };
}

// The two commits the forge names for the pull request, each a full commit id, or it throws.
function endsOf(forge, pr) {
  let ends;
  try {
    ends = forge.changeEnds(pr.number, { repo: `${pr.host}/${pr.repo}` });
  } catch (error) {
    throw new Error(`could not read its base and head commits with gh (${ghError(error)})`);
  }
  const { base, head } = ends ?? {};
  if (!COMMIT.test(base ?? '') || !COMMIT.test(head ?? '')) throw new Error(`gh gave ${JSON.stringify(base ?? null)} and ${JSON.stringify(head ?? null)} as its base and head, not full commit ids`);
  return { base, head };
}

const hasCommit = (root, sha) => runGit(['cat-file', '-e', `${sha}^{commit}`], root).status === 0;

// Fetches `shas` from the pull request's remote, or throws when git fails or any is still missing after.
function fetchCommits(root, pr, shas) {
  const remote = remoteOf(root, pr);
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const result = runGit(['fetch', '--no-tags', '--quiet', remote, ...shas], root, { timeout: FETCH_TIMEOUT_MS, env });
  if (result.status !== 0) throw new Error(`git fetch ${remote} ${shas.join(' ')} failed (${gitError(result)})`);
  const missing = shas.filter((sha) => !hasCommit(root, sha));
  if (missing.length) throw new Error(`git fetch ${remote} did not bring ${missing.join(' ')}`);
}

// The remote whose URL names the pull request's repository on its host, else `origin`. A name git could read as an
// option is never one.
export function remoteOf(root, pr) {
  const listed = readRemoteUrls(root);
  const wanted = `${pr.host}/${pr.repo}`.toLowerCase();
  for (const line of listed.status === 0 ? listed.stdout.split('\n') : []) {
    const match = /^remote\.(.+)\.url (.+)$/u.exec(line);
    const identity = match ? remoteIdentity(match[2]) : null;
    if (identity && !match[1].startsWith('-') && `${identity.host}/${identity.path}`.toLowerCase() === wanted) return match[1];
  }
  return 'origin';
}

const gitError = (result) => String(result.stderr ?? '').split('\n').map((line) => line.trim()).filter(Boolean).at(-1)
  ?? result.error?.message ?? `exit ${result.status}`;
