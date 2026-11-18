// The types of servers.mjs, for the hooks' type check.

export const LINEAR_SERVERS: readonly string[]
export const ISSUE_TOOL: 'get_issue'
export function ticketPrefixes(prefixes: unknown): string[] | null
export function issueLookup(ticket: unknown, prefixes: unknown): { id: string } | null
