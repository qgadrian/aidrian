// The forges the plugin knows, one adapter a file, and the one that serves a checkout. A static import, as with hosts and
// trackers: no adapter is loaded by name. Today every checkout is served by GitHub.
//
// Shared code imports from this file only, never from an adapter (test/forge-coupling.test.mjs): what it needs of a forge
// is forgeFor's methods, and the helpers below. repoIdentity is the facade's; the others are GitHub's today, as the
// payloads are: a second forge reshapes them with its adapter.

import { createGithubForge, GITHUB_JSON, isTrustedCommenter, REVIEWS_PAGE } from './github.mjs';
import { repoIdentity } from './identity.mjs';

// A repository's `{ host, path }` from a remote or a `-R` value: the facade's own helper (identity.mjs), which reads
// text before any forge is chosen.
export { repoIdentity };

// Whether a comment's author belongs to the repository. Each forge method object carries it too.
export { isTrustedCommenter };

// The most reviews, and the most inline comments of one review, that one `reviewsWithComments` call reads.
export { REVIEWS_PAGE };

// `options` are the adapter's, such as `timeoutMs` (github.mjs), plus the facade's own:
// - `strictJson`: every REST call names the forge's JSON media type, and an empty answer is null, not an empty list,
//   as `aidrian pr await-review` has always read. For GitHub it is the adapter's `mediaType`, GitHub's JSON media type,
//   which only `strictJson` sets: a `mediaType` a caller passes is dropped, so no shared code names a forge's media type.
export const forgeFor = (cwd, { strictJson = false, mediaType, ...options } = {}) =>
  createGithubForge({ ...options, ...(strictJson ? { mediaType: GITHUB_JSON } : {}), cwd });
