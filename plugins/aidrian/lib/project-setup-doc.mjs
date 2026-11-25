// The setup doc of a project run (docs/project-run-setup.md), as the preflight's lines (lib/project-preflight.mjs) and the
// run's summary (lib/project-run.mjs) point at it.

import { pluginRepository } from './config-version.mjs';

// The setup doc of a project run, and its section that clears each check's blocker, by the check's name: every blocker
// line, and the labels `ask`, ends with a pointer to it (setupPointer). `token` is the access check's section when no
// source gives a forge token, or that token may not push. test/project-run-report.test.mjs holds each anchor to a
// heading of the doc.
export const SETUP_DOC = 'docs/project-run-setup.md';
// The doc's address on the main branch of the repository the plugin's manifest names, so a fork points at its own: a
// project's checkout has no copy of the doc. Its path alone when the manifest names no repository.
export function setupDocUrl() {
  const repository = pluginRepository();
  return repository ? `${repository.replace(/(?:\.git)?\/*$/u, '')}/blob/main/${SETUP_DOC}` : SETUP_DOC;
}
export const SETUP_SECTIONS = Object.freeze({
  repository: 'origin-over-https', state: 'state-folder', run: 'after-a-halt-or-a-stop', instructions: 'state-folder',
  policy: 'team-config', machine: 'this-machine', commit: 'commits-in-attempt-clones', host: 'host-start', trust: 'trust-the-runs-folder', access: 'host-settings',
  token: 'forge-token-in-the-keychain', 'token-reads': 'forge-token-permissions', 'usage-limit': 'host-settings', tracker: 'team-config', 'auto-merge': 'auto-merge-and-ci',
  handoff: 'team-config', reviewer: 'review-bot', 'reviewer-seen': 'review-bot', ci: 'auto-merge-and-ci',
  'branch-protection': 'forge-rules', 'release-tags': 'forge-rules', 'workflow-secrets': 'forge-rules', labels: 'the-decision-label',
});
export const setupPointer = (section) => ` (setup: ${setupDocUrl()}#${SETUP_SECTIONS[section]})`;
