// The forges the plugin knows, one adapter a file, and the one that serves a checkout. A static import, as with hosts and
// trackers: no adapter is loaded by name. Today every checkout is served by GitHub.
//
// Shared code imports from this file only, never from an adapter (test/forge-coupling.test.mjs): what it needs of a forge
// is forgeFor's methods, and the helpers below. repoIdentity is the facade's; the others are GitHub's today, as the
// payloads are: a second forge reshapes them with its adapter.

import { changeNotFound, CONFIG_COMMANDS, createGithubForge, GITHUB_JSON, isLogin, isTrustedCommenter, MAX_BODY, REVIEWS_PAGE } from './github.mjs';
import { repoIdentity } from './identity.mjs';

// A repository's `{ host, path }` from a remote or a `-R` value: the facade's own helper (identity.mjs), which reads
// text before any forge is chosen.
export { repoIdentity };

// Whether a forge call that reads one pull request (`change`) failed because the forge has no such pull request, which
// is final, rather than because it could not answer now.
export { changeNotFound };

// The forge CLIs' subcommands that write the user's own config, each { programs, subcommands, valueOptions, what }:
// the union of every forge adapter's list, whichever forge serves a checkout, since a session may run any forge's CLI.
// One adapter today; a second adds its list here.
const ADAPTER_CONFIG_COMMANDS = Object.freeze([CONFIG_COMMANDS]);
export const forgeConfigCommands = () => ADAPTER_CONFIG_COMMANDS.flat();

// Whether a comment's author belongs to the repository. Each forge method object carries it too.
export { isTrustedCommenter };

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
