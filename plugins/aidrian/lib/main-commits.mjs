// What a commit in the main checkout gets: config.json `git.mainCheckout.commits`, "block", "warn", or "allow".
// docs/config.md lists the key. No dependencies: this file runs from the installed plugin, which has no node_modules.

// The mode for commits in the main checkout. null follows the guard: "block" when it is on, "allow" when it is off.
export function commitMode(config) {
  const { commits, guard } = config.git.mainCheckout;
  if (commits !== null) return commits;
  return guard ? 'block' : 'allow';
}
