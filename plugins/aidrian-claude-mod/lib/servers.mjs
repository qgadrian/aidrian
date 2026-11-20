// The Claude mod's one MCP call: `get_issue` with `{ id }`, for a ticket key a validated prefix matched, to the first
// connected server of LINEAR_SERVERS. A mod's $.mcp.call asks no permission and passes no aidrian hook, so nothing
// else in the mod calls a server. A mod module has no Node: this file imports nothing.

// The servers a Linear connection is known to show in Claude Code, in the spelling the aidrian plugin's Linear adapter
// gives (its lib/trackers/linear.mjs): its `servers.any`, then its `servers['claude-code']`. A mod cannot import across
// plugins, so test/claude-mod-servers.test.mjs holds this copy equal to the adapter's lists.
export const LINEAR_SERVERS = Object.freeze(['linear', 'linear-server', 'plugin_linear_linear', 'claude_ai_Linear']);

export const ISSUE_TOOL = 'get_issue';

// Ticket prefixes, as the snapshot takes them: at most 32, each a letter and up to 15 letters or digits.
const PREFIX = /^[A-Za-z][A-Za-z0-9]{0,15}$/u;
const MAX_PREFIXES = 32;
const KEY = /^([A-Za-z][A-Za-z0-9]{0,15})-[0-9]{1,9}$/u;

// The pipe-separated `prefixes` as a list, or null when one is of the wrong shape or there are too many.
export function ticketPrefixes(prefixes) {
  if (typeof prefixes !== 'string') return null;
  const list = prefixes === '' ? [] : prefixes.split('|');
  if (list.length > MAX_PREFIXES || !list.every((prefix) => PREFIX.test(prefix))) return null;
  return list;
}

// The arguments of the issue lookup for one of the snapshot's `tickets`: `{ id }` when its key is `<PREFIX>-<n>` for one of
// the valid `prefixes`, else null, as for a GitHub `#N` key, which shows as it is, with no title.
export function issueLookup(ticket, prefixes) {
  const list = ticketPrefixes(prefixes);
  const key = ticket !== null && typeof ticket === 'object' ? ticket.key : null;
  const found = list && typeof key === 'string' ? KEY.exec(key) : null;
  if (found === null || !list.some((prefix) => prefix.toUpperCase() === found[1].toUpperCase())) return null;
  return { id: key };
}
