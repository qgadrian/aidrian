// The forges the plugin knows, one adapter a file, and the one that serves a checkout. A static import, as with hosts and
// trackers: no adapter is loaded by name. Today every checkout is served by GitHub.
//
// Shared code imports from this file only, never from an adapter (test/forge-coupling.test.mjs): what it needs of a forge
// is forgeFor's methods, and the helpers below. repoIdentity is the facade's; the others are GitHub's today, as the
// payloads are: a second forge reshapes them with its adapter.

import { apiWrite, changeNotFound, CONFIG_COMMANDS, createGithubForge, diffTooLarge, domains, GITHUB_JSON, isLogin, isTrustedCommenter, MAX_BODY, REF_COMMANDS, REVIEWS_PAGE, servedRepository, TOKEN_VARS, WORKFLOW_FOLDERS } from './github.mjs';
import { apiRoot, gitHelperValue, loginStep, tokenNote, tokenVarFor } from './github-token.mjs';
import { remoteIdentity, repoIdentity } from './identity.mjs';

// A repository's `{ host, path }` from a remote or a `-R` value: the facade's own helper (identity.mjs), which reads
// text before any forge is chosen. remoteIdentity reads a remote URL alone, and is null for one git reads as a folder.
export { remoteIdentity, repoIdentity };

// Whether a forge call that reads one pull request (`change`) failed because the forge has no such pull request, which
// is final, rather than because it could not answer now.
export { changeNotFound };

// Whether a `diff` call failed because the forge refuses a diff that large, which a local diff of the two commits
// `changeEnds` names can stand in for, rather than for any other reason.
export { diffTooLarge };

// The forge CLIs' subcommands that write the user's own config, each { programs, subcommands, valueOptions, what }:
// the union of every forge adapter's list, whichever forge serves a checkout, since a session may run any forge's CLI.
// One adapter today; a second adds its list here.
const ADAPTER_CONFIG_COMMANDS = Object.freeze([CONFIG_COMMANDS]);
export const forgeConfigCommands = () => ADAPTER_CONFIG_COMMANDS.flat();

// What a project run's issue session never asks of any forge, whichever serves its checkout, since it may run any
// forge's CLI (lib/issue-forge-guard.mjs): forgeRefCommands(), the CLI subcommands that release, run a workflow, or
// change the repository's settings, secrets, or keys, each { programs, subcommands, valueOptions, what };
// forgeApiWrite(program, tokens), what a call of the CLI's raw API writes that the session never writes, or null; and
// forgeWorkflowFolders(), the folders of a repository whose files the forge runs with its secrets on a push.
const ADAPTER_REF_COMMANDS = Object.freeze([REF_COMMANDS]);
export const forgeRefCommands = () => ADAPTER_REF_COMMANDS.flat();
export const forgeApiWrite = (program, tokens) => apiWrite(program, tokens);
export const forgeWorkflowFolders = () => [...WORKFLOW_FOLDERS];

// The network hosts a session must reach to push to, and read from, the forge serving `repository`, { host, ... } as a
// project run pins it: the allowlist of a confined session's sandbox. Today every repository is served by GitHub.
export const forgeDomains = (repository) => domains(repository?.host);

// The environment variables the forge's CLI reads its token from: the one credential a confined session's sandbox keeps.
export const forgeTokenVars = () => [...TOKEN_VARS];

// What a project run needs to hand its issue session the forge token (lib/project-token.mjs): forgeTokenVar(host), the
// variable the forge's CLI and its git credential helper both read a token for `host` from; forgeLoginStep(host), the
// step that signs the CLI in; and forgeTokenNote(token), why a token reaches more than the run's repository, or null.
// The token itself comes from forgeFor's `authToken({ host })`, and whether it may push from its `tokenCanPush`.
export const forgeTokenVar = (host) => tokenVarFor(host);
// The git credential helper, as a `credential.helper` value, that answers git with the token the forge CLI's variable
// holds, from the CLI on `env`'s PATH; null when the CLI is not there.
export const forgeGitHelper = (env) => gitHelperValue(env);
export const forgeLoginStep = (host) => loginStep(host);

// The host the forge at `host` serves its API from, lower-cased: GitHub's `api.github.com` for github.com, and the
// host itself for a GitHub Enterprise Server, which serves it under /api/v3.
export const forgeApiHost = (host) => new URL(apiRoot(host)).hostname.toLowerCase();
export const forgeTokenNote = (token) => tokenNote(token);

// Whether a comment's author belongs to the repository. Each forge method object carries it too.
export { isTrustedCommenter };

// The repository check: given origin's identity, as repoIdentity reads it, the repository as the active adapter names it
// to its forge, or null when that adapter does not serve it. Pass the answer as a method's `repo` option; on null, call
// no forge.
export { servedRepository };

// Whether a name is shaped like a login of the forge, as an invariant's `approvers` must be.
export { isLogin };

// The most reviews, and the most inline comments of one review, that one `reviewsWithComments` call reads.
export { REVIEWS_PAGE };

// The longest body the forge takes for a comment, a review, or a review comment, in characters: a post checks its
// escaped length against it.
export { MAX_BODY };

// `options` are the adapter's, such as `timeoutMs` (github.mjs), plus the facade's own:
// - `strictJson`: an empty answer is null, not an empty list, as `aidrian pr await-review` has always read. That is
//   the whole promise to shared code. The GitHub adapter keeps it by naming GitHub's JSON media type (`mediaType`) on
//   every REST call, and only `strictJson` sets it: a `mediaType` a caller passes is dropped, so no shared code names a
//   forge's media type.
export const forgeFor = (cwd, { strictJson = false, mediaType, ...options } = {}) =>
  createGithubForge({ ...options, ...(strictJson ? { mediaType: GITHUB_JSON } : {}), cwd });
