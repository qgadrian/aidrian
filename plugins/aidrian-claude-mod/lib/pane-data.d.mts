// The types of pane-data.mjs, for the hooks' type check.

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number
export type Issue = { key: string; title: string; status: string; url: string }
export type Repo = { label: string; isWorktree: boolean; isDirty: boolean }

export function issueOf(key: string, content: unknown): Issue | null
export function cacheTtlOf(tail: unknown): number | null
export function passResponse<C extends { kind: string }, R extends { usage: unknown }>(
  stream: AsyncIterable<C> & { readonly result: Promise<R> },
  onResponse: () => Promise<unknown>,
): AsyncGenerator<C, R>
export function repoOf(answers: { branch: unknown; gitDir: unknown; status: unknown }): Repo
export function modelVersion(id: string): { family: string; major: number; minor: number } | null
export function effortOf(inputs: { seen?: Effort | null; fromEnv: unknown; model: string; settings: unknown }): Effort | null
export function cleanModel(model: string): string
export function formatDuration(ms: number): string
export function dateMs(at: unknown): number | null
export function untilText(at: unknown, now: number): string
export function agentRowParts(agent: unknown, columns?: number): { text: string; color: string }[]
