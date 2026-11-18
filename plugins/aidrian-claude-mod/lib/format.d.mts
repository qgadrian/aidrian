// The types of format.mjs, for the hooks' type check.

export type Part = { text: string; color: string }
export type Segment = { id: 'handoff' | 'changes' | 'harness'; parts: Part[] }
export type Row = { parts: Part[]; link: string | null }

export const DISPLAY_CAPS: Readonly<{ title: number; name: number; path: number }>
export function displayText(text: unknown, cap?: number): string
export const COLORS: Readonly<Record<'quiet' | 'offer' | 'due' | 'reminded' | 'ceiling' | 'armed' | 'text' | 'muted' | 'passed' | 'failed' | 'pending' | 'merged', string>>
export const FORGES: Readonly<Record<string, Readonly<{ change: string; one: string; many: string; isLink: (row: Record<string, unknown>) => boolean }>>>
export function handoffParts(handoff: unknown): Part[]
export function changesParts(prs: unknown): Part[]
export function harnessParts(snapshot: { lessons?: unknown; decisions?: unknown; worktrees?: unknown; audits?: unknown }): Part[]
export function bandSegments(snapshot: unknown): Segment[]
export function plainText(segments: Segment[]): string
export function changeRows(prs: unknown): Row[]
export function isIssueLink(url: unknown, key: unknown): boolean
export function ticketRow(ticket: unknown, issue?: { title?: string; status?: string; url?: string } | null): Row | null
export function alertText(alert?: { text?: string; title?: string }): { text: string; title: string }
export const NOTICES: Readonly<Record<'missing' | 'no-node' | 'refused' | 'failed' | 'timed-out' | 'off', string>>
export function noticeOf(result: unknown): string | null
