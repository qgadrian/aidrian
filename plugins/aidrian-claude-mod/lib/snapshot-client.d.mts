// The types of snapshot-client.mjs, for the hooks' type check.

export type Stat = { kind: string; size: number; mtimeMs: number; isLink: boolean; realPath?: string }
export type RunResult = { exitCode: number; stdout: string; stderr: string }
export type Io = {
  fs: {
    read: (path: string, options?: { offset?: number; length?: number }) => Promise<unknown>
    list: (path: string) => Promise<readonly { name: string; kind: string }[]>
    stat: (path: string, options?: { resolve: boolean }) => Promise<Stat>
  }
  run: (argv: readonly string[], init: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }) => Promise<RunResult>
  now: () => Promise<number>
  env: { PATH?: string; HOME?: string; CLAUDE_CONFIG_DIR?: string }
  pluginRoot: string
  enabledPlugins: () => Promise<unknown>
}
export type Target = { session: string; cwd: string; root: string }
export type Place = { configDir: string; marketplace: string }
export type ResultKind = 'ok' | 'missing' | 'refused' | 'no-node' | 'off' | 'failed' | 'timed-out'
export type SnapshotRun = { kind: ResultKind; snapshot?: Record<string, unknown>; transcript?: string | null }
export type Runner = {
  entries: string[]
  outside: (real: string) => boolean
  which: (name: string) => Promise<string | null>
  run: (name: 'node' | 'git', args: readonly string[], options?: { cwd?: string; timeoutMs?: number }) => Promise<RunResult>
  frontmostApp: () => Promise<string | null>
}

export const SESSION_ID: RegExp
export const SNAPSHOT_TIMEOUT_MS: number
export const OSASCRIPT: string
export const FOCUS_SCRIPT: string
export function runnerFor(io: Io, fences: { cwd: string; root: string }): Promise<Runner>
export function ownPlace(io: Io): Promise<Place | null>
export function findCli(io: Io, options: { cwd: string; runner: Runner }): Promise<{ kind: string; cli?: string; place: Place | null }>
export function configDirOf(io: Io, place: Place | null): string | null
export function findTranscript(io: Io, options: { configDir: string | null; session: string }): Promise<string | null>
export function snapshotArgs(options: { cli: string; session: string; transcript?: string | null; ticketPrefixes?: string }): string[]
export function runSnapshot(io: Io, options: Target & { ticketPrefixes?: string }): Promise<SnapshotRun>
export function poller<R>(options: {
  target: () => Promise<Target>
  snapshot: (asked: Target) => Promise<R>
  draw: (result: R, asked: Target) => void
}): { trigger: () => Promise<void> }
