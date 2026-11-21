// A pull request's diff, as `aidrian pr product-feedback diff` writes it for the product-manager read: the forge's, or,
// when the forge refuses a diff that large (diffTooLarge), git's own diff of the two commits the forge names
// (changeEnds), run in this checkout. A shallow checkout is refused before anything runs: its merge base may be missing,
// or an older one, so its diff could fail or be wrong. A commit the checkout lacks is fetched first, by its id alone, from
// the remote that names the pull request's repository, else `origin`, with no configured refspec applied (`--refmap=`)
// and no bundle imported (`-c fetch.bundleURI=`), so the fetch writes and prunes no ref. git runs through runGit: an
// argument list, never a shell, under the plugin's hardened settings. Any other forge failure still fails, as it always has.

import { diffTooLarge, remoteIdentity } from './forges/index.mjs';
import { runGit } from './git.mjs';
import { ghError } from './pr-auto-merge.mjs';

// A full commit id: SHA-1, or SHA-256 for a repository that uses it.
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
// The most a local diff may print, as the forge's own reads (GH_MAX_BUFFER_BYTES): past it the command fails, naming it.
export const LOCAL_DIFF_MAX_BYTES = 64 * 1024 * 1024;
// A fetch and a diff of a large pull request take longer than runGit's default, which is a hook's.
const FETCH_TIMEOUT_MS = 120_000;
const DIFF_TIMEOUT_MS = 60_000;

// The diff of `pr` ({ number, host, repo }) as { text, local }: `local` is null for the forge's, else
// { base, head, fetched, command }: the two commits git compared, the ones it fetched, and the diff command as shown. Throws with what failed.
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
// The shallow probe must answer `true` or `false`; any other answer stops it before any read or fetch.
function localDiff({ forge, pr, root }) {
  const probe = runGit(['rev-parse', '--is-shallow-repository'], root);
  const shallow = probe.status === 0 ? probe.stdout.trim() : null;
  if (shallow !== 'true' && shallow !== 'false') throw new Error(`git rev-parse --is-shallow-repository failed (${gitError(probe)})`);
  if (shallow === 'true') {
    throw new Error(`this checkout is shallow, so the local diff of #${pr.number} could be wrong or fail; run \`git fetch --unshallow ${shellQuoted(remoteOf(root, pr))}\` here and then the command again, or run the command from a full clone`);
  }
  const { base, head } = endsOf(forge, pr);
  const fetched = [base, head].filter((sha, index, all) => all.indexOf(sha) === index && !hasCommit(root, sha));
  if (fetched.length) fetchCommits(root, pr, fetched);
  const flags = ['--no-relative', '--ignore-submodules=none', '--submodule=short'];
  const command = `git diff ${flags.join(' ')} ${base}...${head}`;
  const result = runGit(['diff', '--no-color', ...flags, `${base}...${head}`, '--'], root, { maxBuffer: LOCAL_DIFF_MAX_BYTES, timeout: DIFF_TIMEOUT_MS });
  if (result.error?.code === 'ENOBUFS') throw new Error(`${command} printed more than ${LOCAL_DIFF_MAX_BYTES / 1024 / 1024} MB`);
  if (result.status !== 0) throw new Error(`${command} failed (${gitError(result)})`);
  return { text: result.stdout, local: { base, head, fetched, command } };
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

// Fetches `shas` from the pull request's remote, or throws when git fails or any is still missing after. The refspecs are
// the commit ids alone, with no destination, `--refmap=` applies none of the remote's configured `fetch` refspecs, and
// `-c fetch.bundleURI=` imports no bundle and its `refs/bundles/*`, so no ref is written; `--no-prune` keeps a prune
// setting from removing any, and FETCH_HEAD stays as it was.
function fetchCommits(root, pr, shas) {
  const remote = remoteOf(root, pr);
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const args = ['-c', 'fetch.bundleURI=', 'fetch', '--no-tags', '--no-prune', '--quiet', '--no-write-fetch-head', '--refmap=', remote, ...shas];
  const result = runGit(args, root, { timeout: FETCH_TIMEOUT_MS, env });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed (${gitError(result)})`);
  const missing = shas.filter((sha) => !hasCommit(root, sha));
  if (missing.length) throw new Error(`git fetch ${remote} did not bring ${missing.join(' ')}`);
}

// The remote whose fetch URL in `git remote -v`, the list the remotes check reads (checkoutRemotes), names the pull
// request's repository on its host, else `origin`. That list is git's own view: after any `url.*.insteadOf`, and with a
// remote set in any config scope, the command's own among them. A name git could read as an option is never one.
export function remoteOf(root, pr) {
  const listed = runGit(['remote', '-v'], root);
  const wanted = `${pr.host}/${pr.repo}`.toLowerCase();
  for (const line of listed.status === 0 ? listed.stdout.split('\n') : []) {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/u.exec(line.trim());
    const identity = match && !match[1].startsWith('-') ? remoteIdentity(match[2]) : null;
    if (identity && `${identity.host}/${identity.path}`.toLowerCase() === wanted) return match[1];
  }
  return 'origin';
}

// `text` as one word of a POSIX shell: in single quotes, each `'` written as `'\''`.
const shellQuoted = (text) => `'${text.replaceAll("'", "'\\''")}'`;

const gitError = (result) => String(result.stderr ?? '').split('\n').map((line) => line.trim()).filter(Boolean).at(-1)
  ?? result.error?.message ?? `exit ${result.status}`;
