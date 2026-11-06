// The forges the plugin knows, one adapter a file, and the one that serves a checkout. A static import, as with hosts and
// trackers: no adapter is loaded by name. Today every checkout is served by GitHub.

import { createGithubForge } from './github.mjs';

// `options` are the adapter's, such as `mediaType` (github.mjs).
export const forgeFor = (cwd, options = {}) => createGithubForge({ ...options, cwd });
