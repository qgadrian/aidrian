export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number

// The checkout the session's folder is in, read with git: its branch, or a linked worktree's folder name, and whether
// it holds changes (lib/pane-data.mjs's repoOf).
export type Repo = { label: string; isWorktree: boolean; isDirty: boolean }

// The last result of a snapshot run (lib/snapshot-client.mjs's runSnapshot): `ok` with the snapshot object, or a kind
// the pane names. The transcript is the one the run was given, which the band reads its cache lifetime from.
export type SnapshotResult = {
  kind: 'ok' | 'missing' | 'refused' | 'no-node' | 'off' | 'failed' | 'timed-out'
  snapshot?: Record<string, unknown>
  transcript?: string | null
}

// What the Linear lookup answered for a ticket key, as raw strings: format.mjs cleans each before it is drawn.
export type Issue = { key: string; title: string; status: string; url: string }

export type AgentRow = {
  id: string
  type: string
  description: string
  model: string
  status: string
  startedAt: number
  endedAt: number | null
  contextTokens: number | null
  lastTool: string | null
  steps: number
}

export type Limit = { kind: string; percent: number; resetsAt: number | null }

export type Usage = { contextPercent: number | null; contextWindow: number; limits: Limit[] }

declare module 'claude-code' {
  interface PluginState {
    'aidrian-mod': {
      result: SnapshotResult | null
      repo: Repo | null
      issues: Issue[]
      refreshedAt: number | null
      isRefreshing: boolean
      effort: Effort | null
      usage: Usage | null
      cacheAt: number | null
      cacheTtlMs: number | null
      now: number
      agents: AgentRow[]
      showFinished: boolean
    }
  }
}
