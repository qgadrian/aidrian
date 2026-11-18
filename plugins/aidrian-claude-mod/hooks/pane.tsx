import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions, SessionMeasureInput } from 'claude-code'

import type { AgentRow, Effort, Issue, Repo, SnapshotResult, Usage } from '../types'
import { bandSegments, changeRows, changesParts, COLORS, displayText, noticeOf, ticketRow } from '../lib/format.mjs'
import type { Part, Row, Segment } from '../lib/format.mjs'
import { cacheTtlOf, cleanModel, dateMs, effortOf, formatDuration, issueOf, repoOf } from '../lib/pane-data.mjs'
import { ISSUE_TOOL, issueLookup, LINEAR_SERVERS } from '../lib/servers.mjs'
import { configDirOf, findTranscript, ownPlace, poller, runnerFor, runSnapshot } from '../lib/snapshot-client.mjs'

// The band above the prompt and the aidrian-mod pane. Everything the snapshot, the Linear lookup, or git gives is drawn
// through lib/format.mjs, which cleans each string and writes no escape sequence. No hook here starts a process: each
// hands $.process.run to the lib, whose one resolver starts every process. Nothing drawn here reaches the model: the
// pane command answers with constant text.

const PANE = 'aidrian-mod'
const ISSUE_TTL_MS = 5 * 60_000
const SNAPSHOT_EVERY_TICKS = 60
const DEFAULT_AGENT_WINDOW = 200_000
const TRANSCRIPT_TAIL_BYTES = 1_048_576
const SPINNER = ['◐', '◓', '◑', '◒']
const GIT_TIMEOUT_MS = 5000
const GIT_STATUS_TIMEOUT_MS = 10_000
// The git reads of the band, each a fixed argv: no setting or snapshot string is ever an argument, and the resolver
// runs git by its absolute path, never a shell. `--no-optional-locks` keeps `status` from writing the index, so it
// takes no lock a git command of the person's could meet; `-c core.fsmonitor=false` stops it from starting the
// fsmonitor program the repository's config may name. A repository's own configured filter drivers can still run while
// `status` reads changed files, as they do in Claude Code's own start-up status read.
const GIT_BRANCH = ['branch', '--show-current']
const GIT_DIR = ['rev-parse', '--absolute-git-dir']
const GIT_STATUS = ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'status', '--porcelain']

const result = atom({ plugin: 'aidrian-mod', key: 'result' } as const, null)
const repoAtom = atom({ plugin: 'aidrian-mod', key: 'repo' } as const, null)
const issueAtom = atom({ plugin: 'aidrian-mod', key: 'issue' } as const, null)
const refreshedAt = atom({ plugin: 'aidrian-mod', key: 'refreshedAt' } as const, null)
const isRefreshing = atom({ plugin: 'aidrian-mod', key: 'isRefreshing' } as const, false)
const effort = atom({ plugin: 'aidrian-mod', key: 'effort' } as const, null)
const usage = atom({ plugin: 'aidrian-mod', key: 'usage' } as const, null)
const cacheAt = atom({ plugin: 'aidrian-mod', key: 'cacheAt' } as const, null)
const cacheTtl = atom({ plugin: 'aidrian-mod', key: 'cacheTtlMs' } as const, null)
const now = atom({ plugin: 'aidrian-mod', key: 'now' } as const, 0)
const agents = atom({ plugin: 'aidrian-mod', key: 'agents' } as const, [])
const showFinished = atom({ plugin: 'aidrian-mod', key: 'showFinished' } as const, true)

// Theme keys, so every colour follows a light or a dark theme. The names say what each looks like on the default themes.
const COLOR = {
  red: 'error',
  orange: 'claude',
  amber: 'warning',
  green: 'success',
  cyan: 'cyan',
  orchid: 'merged',
} as const

type Settings = { prefixes: string; cacheTtlMs: number }

type Target = { session: string; cwd: string; root: string }

type Refresh = SnapshotResult & { repo?: Repo | null }

// Kept in the module, not in `$.state`: a reload runs session.start again, which sets them anew. `alerts` says whether
// the session is an interactive terminal one, the only kind the notifications reach; `transcript` is the session's
// checked transcript, which the cache lifetime is read from: the one a snapshot run was given, or the one the lib finds
// when no run has given one; `draws` counts the refreshes drawn, so an older one stores no transcript; `issueKey` is
// the ticket the newest draw looks up, so a slow lookup of another key stores nothing; `lookup` is the Linear lookup in
// flight, which a refresh of the same key waits on rather than starting another.
const live: {
  client: { trigger: () => Promise<void> } | null
  alerts: boolean
  ticks: number
  cwd: string | null
  transcript: { session: string; file: string } | null
  issue: { key: string; value: Issue | null; fetchedAt: number } | null
  issueKey: string | null
  lookup: { key: string; answer: Promise<Issue | null> } | null
  draws: number
} = { client: null, alerts: false, ticks: 0, cwd: null, transcript: null, issue: null, issueKey: null, lookup: null, draws: 0 }

// Whether this session takes notifications: an interactive session drawn in a terminal, as session.start said. A `-p`
// run, the SDK, and the desktop app take none.
export function alertsOn() {
  return live.alerts
}

// What the lib reads outside itself, as lib/snapshot-client.mjs describes `io`: the engine's own calls, handed over.
// The engine takes a noun of $ only as a call (`$.fs.read(...)`), never as a value, so each is handed as a function
// that passes its arguments through. `run` is the one place a hook names $.process.run: only the lib's resolver calls
// it, with the argv and env it built.
export async function engineIo($: EngineInterface) {
  const env = async (value: Promise<string | undefined>) => value.catch(() => undefined)

  return {
    fs: {
      read: (path: string, options: { offset?: number; length?: number } = {}) => $.fs.read(path, options),
      list: (path: string) => $.fs.list(path),
      stat: (path: string, options: { resolve: boolean } = { resolve: false }) => $.fs.stat(path, options),
    },
    run: (argv: readonly string[], init: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }) => $.process.run(argv, init),
    now: () => $.clock.now(),
    env: { PATH: await env($.env.get('PATH')), HOME: await env($.env.get('HOME')), CLAUDE_CONFIG_DIR: await env($.env.get('CLAUDE_CONFIG_DIR')) },
    pluginRoot: $.plugin.root,
    enabledPlugins: () => $.settings.read({ key: 'enabledPlugins' }),
  }
}

const targetOf = async ($: EngineInterface): Promise<Target> => ({ session: await $.session.id(), cwd: await $.session.cwd(), root: await $.session.root() })

export function registerPane(on: On, options: PluginOptions) {
  const settings: Settings = {
    prefixes: String(options.ticketPrefixes ?? ''),
    cacheTtlMs: Number(options.cacheTtlSeconds) * 1000,
  }

  on('session.start', async ($, e, next) => {
    live.alerts = e.surface === 'terminal' && e.isInteractive === true

    // The band and the pane draw only on the terminal, so the desktop app, `-p` and the SDK start no timer and no process.
    if (e.surface !== 'terminal') {
      return next(e)
    }

    await $.command.register({
      name: PANE,
      description: 'Open the aidrian-mod pane (handoff, changes, harness signals, model, limits, agents); add hide to close it',
      argumentHint: '[hide]',
    })
    const io = await engineIo($)
    live.client = poller({
      target: () => targetOf($),
      snapshot: (asked: Target) => readAll(io, asked, settings.prefixes),
      draw: (drawn: Refresh, asked: Target) => void drawRefresh($, drawn, asked, settings).catch(() => undefined),
    })
    live.ticks = 0
    live.cwd = null
    live.issue = null
    live.issueKey = null
    live.lookup = null
    live.transcript = null
    await update($, isRefreshing, () => false)
    const startedAt = await $.clock.now()
    await update($, now, () => startedAt)
    $.clock.every(1000, () => void tick($).catch(() => undefined))
    refreshLater($)

    return next(e)
  })

  on('command.run', { command: PANE }, async ($, e) => {
    if (e.args.trim() === 'hide') {
      await $.ui.close({ id: PANE })

      return { text: 'The aidrian-mod pane is closed. The band above the prompt stays.' }
    }

    await $.ui.open({ id: PANE, title: 'aidrian-mod', focus: true })
    refreshLater($)

    return { text: 'The aidrian-mod pane is open.' }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const id = e.agentId
      await update($, agents, list => list.map(row => (row.id === id ? { ...row, status: 'running', endedAt: null } : row)))
    }

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)

    if ('agentId' in spawned && typeof spawned.agentId === 'string') {
      const startedAt = await $.clock.now()
      const row: AgentRow = {
        id: spawned.agentId,
        type: displayText(e.subagentType ?? 'agent'),
        description: displayText(e.description ?? '', 200),
        model: displayText(spawned.model ?? ''),
        status: 'running',
        startedAt,
        endedAt: null,
        contextTokens: null,
        lastTool: null,
        steps: 0,
      }
      await update($, agents, list => [...list.filter(one => one.id !== row.id), row].slice(-20))
      refreshLater($)
    }

    return spawned
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined && e.effort !== undefined) {
      const level = e.effort
      await update($, effort, () => level)
    }

    for await (const chunk of next(e)) {
      if (e.agentId !== undefined && (chunk.kind === 'tool' || chunk.kind === 'stop')) {
        await recordAgentChunk($, e.agentId, chunk)
      }

      yield chunk
    }
  })

  // The desktop app's local session loads user-scope mods too and draws their trees for the `desktop` surface. The band
  // and the pane are for the terminal only.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.surface !== 'terminal') {
      return next(e)
    }

    return band($.ui.resolve(e), await renderState($), settings, e.props.bodyColumns)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface !== 'terminal') {
      return next(e)
    }

    return pane($, $.ui.resolve(e), await renderState($), settings)
  })
}

type Ui = ReturnType<EngineInterface['ui']['resolve']>

type RenderState = {
  result: SnapshotResult | null
  repo: Repo | null
  issue: Issue | null
  refreshedAt: number | null
  isRefreshing: boolean
  cacheTtlMs: number | null
  effort: Effort | null
  usage: Usage | null
  cacheAt: number | null
  now: number
  agents: AgentRow[]
  showFinished: boolean
  model: string
}

async function renderState($: EngineInterface): Promise<RenderState> {
  return {
    result: await read($, result),
    repo: await read($, repoAtom),
    issue: await read($, issueAtom),
    refreshedAt: await read($, refreshedAt),
    isRefreshing: await read($, isRefreshing),
    effort: await currentEffort($),
    usage: await read($, usage),
    cacheAt: await read($, cacheAt),
    cacheTtlMs: await read($, cacheTtl),
    now: await read($, now),
    agents: await read($, agents),
    showFinished: await read($, showFinished),
    model: cleanModel(await $.session.model()),
  }
}

const snapshotOf = (state: { result: SnapshotResult | null }) => (state.result?.kind === 'ok' ? (state.result.snapshot ?? null) : null)

// The ticket row for the snapshot's ticket, with what Linear answered only when it answered for that key.
const ticketOf = (state: RenderState) => {
  const ticket = snapshotOf(state)?.ticket ?? null
  const key = ticket !== null && typeof ticket === 'object' ? (ticket as { key?: unknown }).key : null
  const issue = state.issue !== null && state.issue.key === key ? state.issue : null

  return ticketRow(ticket, issue)
}

const drawParts = (ui: Ui, parts: Part[]) => {
  const { Text } = ui

  return parts.map(part => <Text color={part.color}>{part.text}</Text>)
}

function band(ui: Ui, state: RenderState, settings: Settings, columns: number) {
  const { Box, Text } = ui
  const segments = bandSegments(snapshotOf(state))
  const running = state.agents.filter(row => row.status === 'running').length
  const ticket = ticketOf(state)
  const hasPlace = state.repo !== null || ticket !== null || running > 0
  const alerts = bandAlerts(state.usage?.contextPercent ?? null)
  const agentWord = running === 1 ? 'agent' : 'agents'
  const dot = <Text color={RULE}> · </Text>

  return (
    <Box flexDirection="column">
      <Text color="promptBorder">{'─'.repeat(Math.max(1, columns))}</Text>
      <Box flexDirection="column">
        {modelLine(ui, state, settings)}
        {hasPlace && (
          <Box paddingLeft={3}>
            <Text wrap="truncate-end">
              {state.repo && repoLabel(ui, state.repo)}
              {ticket && (
                <Text>
                  {state.repo && dot}
                  {drawParts(ui, ticket.parts.slice(0, 1).map((part: Part) => ({ ...part, color: COLOR.orchid })))}
                  {drawParts(ui, ticket.parts.slice(1).map((part: Part) => ({ ...part, text: ` ${part.text}` })))}
                </Text>
              )}
              {running > 0 && (
                <Text>
                  {(state.repo || ticket) && dot}
                  <Text color={COLOR.cyan}>
                    {agentGlyph('running', state.now).icon} {running} {agentWord}
                  </Text>
                </Text>
              )}
            </Text>
          </Box>
        )}
        {segments.length > 0 && (
          <Box paddingLeft={3}>
            <Text wrap="truncate-end">
              {segments.map((segment: Segment, index: number) => (
                <Text>
                  {index > 0 && dot}
                  {drawParts(ui, segment.parts)}
                </Text>
              ))}
            </Text>
          </Box>
        )}
        {alerts.length > 0 && (
          <Box paddingLeft={3}>
            <Text wrap="truncate-end" color="error">
              {alerts.join(' · ')}
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  )
}

function modelLine(ui: Ui, state: RenderState, settings: Settings) {
  const { Text } = ui
  const style = modelStyle(state.model)
  const ttl = state.cacheTtlMs ?? settings.cacheTtlMs
  const fiveHour = limitOf(state, 'five_hour')
  const sevenDay = limitOf(state, 'seven_day')
  const cacheLeft = state.cacheAt === null ? null : ttl - (state.now - state.cacheAt)
  const dot = <Text color={RULE}> · </Text>

  return (
    <Text wrap="truncate-end">
      {style.emoji}{' '}
      <Text bold color={style.color}>
        {state.model}
      </Text>
      {state.effort !== null && <Text color={effortColor(state.effort)}> {String(state.effort)}</Text>}
      {dot}
      {meter(ui, 'ctx', state.usage?.contextPercent ?? null, contextColor)}
      {dot}
      {isWarm(cacheLeft) ? '♨️ ' : '❄️ '}
      <Text color={LABEL}>cache </Text>
      <Text color={cacheColor(cacheLeft, ttl)}>{cacheWords(cacheLeft, '–', '')}</Text>
      {dot}
      {limitText(ui, '5h', fiveHour, state.now)}
      {dot}
      {limitText(ui, '7d', sevenDay, state.now)}
    </Text>
  )
}

const limitOf = (state: { usage: Usage | null }, kind: string) => state.usage?.limits.find(limit => limit.kind === kind) ?? null

function limitText(ui: Ui, label: string, limit: Usage['limits'][number] | null, nowMs: number) {
  const { Text } = ui

  return (
    <Text>
      <Text color={LABEL}>{label} </Text>
      <Text color={limit ? usageColor(limit.percent) : undefined}>{limit ? `${Math.round(limit.percent)}%` : '–'}</Text>
      {limit?.resetsAt && <Text color={LABEL}> {resetLabel(limit.resetsAt, nowMs)}</Text>}
    </Text>
  )
}

function repoLabel(ui: Ui, repo: Repo) {
  const { Text } = ui

  return (
    <Text>
      <Text color={LABEL}>
        {repo.isWorktree ? '⧉' : '⎇'}
        {'  '}
      </Text>
      <Text color={COLOR.amber}>{repo.label}</Text>
      {repo.isDirty && <Text color={COLOR.orange}> ●</Text>}
    </Text>
  )
}

// Labels and reset times use `inactive`, which the default themes make lighter than `subtle` on a dark background and
// darker on a light one. Separators and empty meter cells take `subtle`, so they stay a step behind the labels.
const LABEL = 'inactive'
const RULE = COLORS.muted

function meter(ui: Ui, label: string, percent: number | null, ramp: (value: number) => string | undefined) {
  const { Text } = ui

  if (percent === null) {
    return (
      <Text>
        <Text color={LABEL}>{label} – </Text>
        <Text color={RULE}>{'─'.repeat(8)}</Text>
      </Text>
    )
  }

  const cells = bar(percent, 8)
  const color = ramp(percent)

  return (
    <Text>
      <Text color={LABEL}>{label} </Text>
      <Text color={color}>{`${Math.round(percent)}% `}</Text>
      <Text color={color ?? 'text'}>{'━'.repeat(cells.filled.length)}</Text>
      <Text color={RULE}>{'─'.repeat(cells.empty.length)}</Text>
    </Text>
  )
}

const bandAlerts = (percent: number | null) => (percent !== null && percent >= 70 ? [`🧠 context ${Math.round(percent)}%: run /compact soon`] : [])

function pane($: EngineInterface, ui: Ui, state: RenderState, settings: Settings) {
  const { Box, Text, Button } = ui
  const notice = noticeOf(state.result)
  const updated = state.refreshedAt === null ? '' : `updated ${formatAgo(state.now - state.refreshedAt)}`
  const freshness = state.isRefreshing ? 'refreshing…' : updated
  const finishedLabel = state.showFinished ? 'Hide done' : 'Show done'

  return (
    <Box flexDirection="column" gap={1}>
      {modelCard(ui, state, settings)}
      {ticketCard(ui, state)}
      {changesCard(ui, snapshotOf(state)?.prs)}
      {harnessCard(ui, snapshotOf(state))}
      {notice && <Text dimColor>{notice}</Text>}
      {agentsCard(ui, state)}
      <Box flexDirection="row" justifyContent="space-between">
        <Text dimColor>
          {placeWords(state.repo)}
          {'  '}
          {freshness}
        </Text>
        <Box flexDirection="row" gap={1}>
          <Button key="finished" hotkey="f" label={finishedLabel} onPress={() => void update($, showFinished, value => !value).catch(() => undefined)} />
          <Button key="refresh" hotkey="r" label="Refresh" onPress={() => refreshLater($)} />
        </Box>
      </Box>
    </Box>
  )
}

// The checkout in the pane's footer: a worktree mark, the label, and a dot for changes.
function placeWords(repo: Repo | null) {
  if (repo === null) return 'no git repo'

  const mark = repo.isWorktree ? '⧉ ' : ''
  const dirty = repo.isDirty ? ' ●' : ''

  return `${mark}${truncate(repo.label, 28)}${dirty}`
}

function modelCard(ui: Ui, state: RenderState, settings: Settings) {
  const { Box, Text } = ui
  const style = modelStyle(state.model)
  const ttl = state.cacheTtlMs ?? settings.cacheTtlMs
  const fiveHour = limitOf(state, 'five_hour')
  const sevenDay = limitOf(state, 'seven_day')
  const cacheLeft = state.cacheAt === null ? null : ttl - (state.now - state.cacheAt)
  const effortWords = state.effort === null ? 'effort after first turn' : String(state.effort)
  const windowWords = state.usage?.contextWindow === 1_000_000 ? '1M' : ''

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={style.color} paddingX={1}>
      <Text>
        {style.emoji}{' '}
        <Text bold color={style.color}>
          {state.model}
        </Text>
        {'  '}
        <Text color={effortColor(state.effort)}>{effortWords}</Text>
      </Text>
      {meterRow(ui, '🧠 ctx  ', state.usage?.contextPercent ?? null, contextColor, windowWords)}
      <Text>
        {isWarm(cacheLeft) ? '♨️ ' : '❄️ '}
        <Text color={LABEL}>cache  </Text>
        <Text color={cacheColor(cacheLeft, ttl)}>{cacheWords(cacheLeft, 'no turn yet', ' left')}</Text>
      </Text>
      {meterRow(ui, '⏳ 5h   ', fiveHour?.percent ?? null, usageColor, resetLabel(fiveHour?.resetsAt ?? null, state.now))}
      {meterRow(ui, '📅 7d   ', sevenDay?.percent ?? null, usageColor, resetLabel(sevenDay?.resetsAt ?? null, state.now))}
    </Box>
  )
}

function ticketCard(ui: Ui, state: RenderState) {
  const { Box, Text, Link } = ui
  const ticket = ticketOf(state)

  if (ticket === null) {
    return null
  }

  const [key, ...rest] = ticket.parts

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={COLOR.orchid} paddingX={1}>
      <Text wrap="truncate-end">
        <Text bold color={COLOR.orchid}>
          ◆ {key?.text ?? ''}
        </Text>
        {drawParts(ui, rest.map((part: Part) => ({ ...part, text: `  ${part.text}` })))}
      </Text>
      {ticket.link && <Link href={ticket.link} label="Open the issue ↗" />}
    </Box>
  )
}

// One row a change, its words and its link from format.mjs's forge table.
function changesCard(ui: Ui, prs: unknown) {
  const { Box, Text, Link } = ui
  const rows = changeRows(prs)

  if (rows.length === 0) {
    return null
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={COLOR.orange} paddingX={1}>
      <Text bold>{drawParts(ui, changesParts(prs))}</Text>
      {rows.map((row: Row) => (
        <Box flexDirection="column">
          <Text wrap="truncate-end">{drawParts(ui, row.parts.flatMap((part: Part, index: number) => (index > 0 ? [{ text: ' · ', color: RULE }, part] : [part])))}</Text>
          {row.link && <Link href={row.link} label="Open ↗" />}
        </Box>
      ))}
    </Box>
  )
}

// The handoff segment and the harness row, as the band draws them.
function harnessCard(ui: Ui, snapshot: Record<string, unknown> | null) {
  const { Box, Text } = ui
  const segments = bandSegments(snapshot).filter((segment: Segment) => segment.id !== 'changes')

  if (segments.length === 0) {
    return null
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={COLOR.cyan} paddingX={1}>
      {segments.map((segment: Segment) => (
        <Text wrap="truncate-end">{drawParts(ui, segment.parts)}</Text>
      ))}
    </Box>
  )
}

function agentsCard(ui: Ui, state: RenderState) {
  const { Box, Text } = ui
  const running = state.agents.filter(row => row.status === 'running' || row.status === 'pending' || row.status === 'waiting')
  const finished = state.agents.filter(row => !running.includes(row))
  const shown = [...running, ...(state.showFinished ? finished.slice(-6).reverse() : [])]

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={COLOR.cyan} paddingX={1}>
      <Text>
        <Text bold color={COLOR.cyan}>
          🤖 Agents
        </Text>
        <Text dimColor>
          {'  '}
          {running.length} running · {finished.length} done
        </Text>
      </Text>
      {shown.length === 0 && <Text dimColor>No subagents in this session yet.</Text>}
      {shown.map(row => agentRow(ui, row, state.now))}
    </Box>
  )
}

function agentRow(ui: Ui, row: AgentRow, nowMs: number) {
  const { Box, Text } = ui
  const glyph = agentGlyph(row.status, nowMs)
  const elapsed = (row.endedAt ?? nowMs) - row.startedAt
  const window = row.model.includes('[1m]') ? 1_000_000 : DEFAULT_AGENT_WINDOW
  const percent = row.contextTokens === null ? null : (row.contextTokens * 100) / window
  const isActive = row.status === 'running'
  const tool = row.lastTool && isActive ? ` · ${row.lastTool}` : ''
  const tokens = row.contextTokens === null ? '' : ` · ${formatTokens(row.contextTokens)}/${formatTokens(window)}`

  return (
    <Box key={row.id} flexDirection="column">
      <Text>
        <Text color={glyph.color}>{glyph.icon}</Text>{' '}
        <Text bold={isActive} dimColor={!isActive}>
          {padEnd(truncate(row.type, 16), 16)}
        </Text>{' '}
        <Text color={isActive ? COLOR.cyan : LABEL}>{padStart(formatDuration(elapsed), 6)}</Text>
        {'  '}
        {agentContext(ui, percent)}
      </Text>
      <Text dimColor wrap="truncate-end">
        {'   '}
        {row.description}
        {tool} · {shortModel(row.model)}
        {tokens}
      </Text>
    </Box>
  )
}

function agentContext(ui: Ui, percent: number | null) {
  const { Text } = ui

  if (percent === null) {
    return <Text dimColor>{'·'.repeat(10)} –</Text>
  }

  return (
    <Text>
      <Text color={contextColor(percent) ?? COLOR.green}>{bar(percent, 10).filled}</Text>
      <Text dimColor>{bar(percent, 10).empty}</Text> <Text color={contextColor(percent)}>{Math.round(percent)}%</Text>
    </Text>
  )
}

function meterRow(ui: Ui, label: string, percent: number | null, ramp: (value: number) => string | undefined, tail: string) {
  const { Text } = ui

  if (percent === null) {
    return (
      <Text>
        {label}
        <Text dimColor>{'▱'.repeat(10)} –</Text>
      </Text>
    )
  }

  const cells = bar(percent, 10)
  const color = ramp(percent)

  return (
    <Text>
      {label}
      <Text color={color ?? COLOR.green}>{cells.filled}</Text>
      <Text dimColor>{cells.empty}</Text> <Text color={color}>{padStart(`${Math.round(percent)}%`, 4)}</Text>
      <Text color={LABEL}>{tail ? `  ${tail}` : ''}</Text>
    </Text>
  )
}

export async function recordUsage($: EngineInterface, measured: SessionMeasureInput) {
  const limits = measured.rateLimits.map(limit => ({
    kind: limit.kind,
    percent: limit.percentUsed,
    resetsAt: dateMs(limit.resetsAt),
  }))
  const latest: Usage = { contextPercent: measured.context.percent ?? null, contextWindow: measured.context.window, limits }

  await update($, usage, () => latest)
}

// The cache lifetime of the last main-chain reply, read through $.fs from the tail of the session's transcript, which
// lib/snapshot-client.mjs found and checked: no process. Some sessions write only 5-minute buckets, others only 1-hour
// ones; with no transcript, the cacheTtlSeconds setting stands.
export async function recordCacheBucket($: EngineInterface) {
  const file = await transcriptOf($)

  if (file === null) {
    return
  }

  const { size } = await $.fs.stat(file)
  const offset = Math.max(0, size - TRANSCRIPT_TAIL_BYTES)
  const tail = await $.fs.read(file, { offset, length: size - offset })
  const ttl = cacheTtlOf(tail)

  if (ttl !== null) {
    await update($, cacheTtl, () => ttl)
  }
}

// The session's transcript: the one a snapshot run of this session was given, else the one the lib finds for it, as
// in a folder with no aidrian plugin, where no snapshot runs, or before the session's first run returns.
async function transcriptOf($: EngineInterface) {
  const session = await $.session.id()

  if (live.transcript?.session === session) {
    return live.transcript.file
  }

  const io = await engineIo($)
  const file = await findTranscript(io, { configDir: configDirOf(io, await ownPlace(io)), session })

  if (file !== null) {
    live.transcript = { session, file }
  }

  return file
}

export async function recordTurnEnd($: EngineInterface, agentId: string | undefined, reason: string) {
  const at = await $.clock.now()

  if (agentId === undefined) {
    await update($, cacheAt, () => at)
    refreshLater($)
    return
  }

  const status = agentEndStatus(reason)
  await update($, agents, list => list.map(row => (row.id === agentId ? { ...row, status, endedAt: at } : row)))
}

const agentEndStatus = (reason: string) => {
  if (reason === 'answer') return 'completed'
  if (reason === 'aborted') return 'killed'

  return 'failed'
}

// The effort of the last turn. Before the first turn no event carries it, so lib/pane-data.mjs's effortOf reads it the
// way Claude Code picks it. `--effort` and `/effort` do not show here; the first turn corrects them.
async function currentEffort($: EngineInterface): Promise<Effort | null> {
  const seen = await read($, effort)

  if (seen !== null) {
    return seen
  }

  const fromEnv = await $.env.get('CLAUDE_CODE_EFFORT_LEVEL').catch(() => undefined)
  const model = await $.session.model()
  const settings = await $.settings.read().catch(() => ({}))

  return effortOf({ fromEnv, model, settings })
}

// Each second: the clock the countdowns read, and a snapshot when the session moved to another folder (EnterWorktree,
// ExitWorktree, `/cd`, a `cd` in Bash) or a minute passed.
async function tick($: EngineInterface) {
  const at = await $.clock.now()
  await update($, now, () => at)
  live.ticks += 1
  const hasMoved = live.cwd !== null && (await $.session.cwd()) !== live.cwd

  if (hasMoved || live.ticks % SNAPSHOT_EVERY_TICKS === 0) {
    await refreshSnapshot($)
  }
}

async function recordAgentChunk($: EngineInterface, agentId: string, chunk: { kind: string; name?: string; usage?: unknown }) {
  const tokens = chunk.kind === 'stop' ? contextTokensOf(chunk.usage) : null
  const toolName = chunk.kind === 'tool' && typeof chunk.name === 'string' ? displayText(chunk.name) : null
  const steps = chunk.kind === 'stop' ? 1 : 0

  await update($, agents, list =>
    list.map(row =>
      row.id === agentId ? { ...row, contextTokens: tokens ?? row.contextTokens, lastTool: toolName ?? row.lastTool, steps: row.steps + steps } : row,
    ),
  ).catch(() => undefined)
}

// One snapshot and one git read for the session's folder, through the lib's poller: one run at a time, triggers during
// a run folded into one rerun, and a result for a folder the session left dropped.
async function refreshSnapshot($: EngineInterface) {
  const client = live.client

  if (client === null) {
    return
  }

  live.cwd = await $.session.cwd()
  await update($, isRefreshing, () => true)

  try {
    await client.trigger()
  } finally {
    await update($, isRefreshing, () => false)
  }

  await syncAgentStatuses($)
}

// A refresh no hook waits for: one that fails, as when the session ends while it runs, draws nothing.
function refreshLater($: EngineInterface) {
  void refreshSnapshot($).catch(() => undefined)
}

type Io = Awaited<ReturnType<typeof engineIo>>

async function readAll(io: Io, asked: Target, prefixes: string): Promise<Refresh> {
  const [snapshot, repo] = await Promise.all([runSnapshot(io, { ...asked, ticketPrefixes: prefixes }), loadRepo(io, asked).catch(() => null)])

  return { ...snapshot, repo }
}

// The poller does not wait for a draw, so a newer draw can start while this one waits on Linear; `isLatest` says
// whether this draw is still the newest, and only then are its transcript stored and its lookup started.
async function drawRefresh($: EngineInterface, drawn: Refresh, asked: Target, settings: Settings) {
  const draw = ++live.draws
  const isLatest = () => draw === live.draws
  const { repo = null, ...snapshot } = drawn
  const at = await $.clock.now()
  await update($, result, () => snapshot)
  await update($, repoAtom, () => repo)
  await update($, refreshedAt, () => at)

  if (!isLatest()) {
    return
  }

  await keepTranscript($, snapshot.transcript ?? null, asked.session)

  if (!isLatest()) {
    return
  }

  await loadIssue($, snapshot, settings.prefixes)
}

// The transcript a snapshot run was given becomes the session's; when it is the first the session has, the cache
// lifetime is read from it at once, rather than at the end of the next turn.
async function keepTranscript($: EngineInterface, file: string | null, session: string) {
  if (file === null) {
    return
  }

  const isFirst = live.transcript?.session !== session
  live.transcript = { session, file }

  if (isFirst) {
    await recordCacheBucket($).catch(() => undefined)
  }
}

async function syncAgentStatuses($: EngineInterface) {
  const listed = await $.agent.list().catch(() => [])
  const byId = new Map(listed.map(info => [info.id, info.status]))

  await update($, agents, list =>
    list.map(row => {
      const status = byId.get(row.id)

      return status === undefined || status === row.status ? row : { ...row, status }
    }),
  )
}

// The branch, worktree, and changes of the folder, each a git read with a fixed argv through the lib's resolver.
async function loadRepo(io: Io, { cwd, root }: Target): Promise<Repo | null> {
  const runner = await runnerFor(io, { cwd, root })
  const branchRun = await runner.run('git', GIT_BRANCH, { cwd, timeoutMs: GIT_TIMEOUT_MS })

  if (branchRun.exitCode !== 0) {
    return null
  }

  const [gitDirRun, statusRun] = await Promise.all([
    runner.run('git', GIT_DIR, { cwd, timeoutMs: GIT_TIMEOUT_MS }),
    runner.run('git', GIT_STATUS, { cwd, timeoutMs: GIT_STATUS_TIMEOUT_MS }),
  ])

  return repoOf({ branch: branchRun.stdout, gitDir: gitDirRun.stdout, status: statusRun.stdout })
}

// The title and state of the snapshot's ticket: the one MCP call of the mod, `get_issue` with the `{ id }` issueLookup
// gives for a key a valid prefix matched, to the first Linear server that answers. A GitHub `#N` key is not looked up.
// Called for the newest draw only, so the key it looks up becomes the active one; an answer is drawn only while its key
// is still active.
async function loadIssue($: EngineInterface, snapshot: SnapshotResult, prefixes: string) {
  const lookup = snapshot.kind === 'ok' ? issueLookup(snapshot.snapshot?.ticket ?? null, prefixes) : null
  live.issueKey = lookup?.id ?? null

  if (lookup === null) {
    await update($, issueAtom, () => null)
    return
  }

  const at = await $.clock.now()
  const cached = live.issue
  const isFresh = cached !== null && cached.key === lookup.id && at - cached.fetchedAt < ISSUE_TTL_MS
  const issue = isFresh ? cached.value : await sharedLookup($, lookup, at)

  if (live.issueKey !== lookup.id) {
    return
  }

  await update($, issueAtom, () => issue)
}

// The Linear lookup for `lookup`'s key: the one in flight for that key, else a new one. Its answer is cached when it
// comes while its key is still the active one, whichever draw started it, so refreshes during a slow lookup reuse it
// rather than each discarding the one before.
function sharedLookup($: EngineInterface, lookup: { id: string }, at: number): Promise<Issue | null> {
  if (live.lookup?.key === lookup.id) {
    return live.lookup.answer
  }

  const answer = askLinear($, lookup)
    .catch(() => null)
    .then(issue => {
      if (live.lookup?.answer === answer) {
        live.lookup = null
      }

      if (live.issueKey === lookup.id) {
        live.issue = { key: lookup.id, value: issue, fetchedAt: at }
      }

      return issue
    })
  live.lookup = { key: lookup.id, answer }

  return answer
}

async function askLinear($: EngineInterface, lookup: { id: string }): Promise<Issue | null> {
  for (const server of LINEAR_SERVERS) {
    const answer = await $.mcp.call(server, ISSUE_TOOL, lookup).catch(() => null)

    if (answer !== null) {
      return answer.isError ? null : issueOf(lookup.id, answer.content)
    }
  }

  return null
}

const contextTokensOf = (raw: unknown) => {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }

  const counts = raw as { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }

  return (counts.input_tokens ?? 0) + (counts.cache_read_input_tokens ?? 0) + (counts.cache_creation_input_tokens ?? 0)
}

const modelStyle = (model: string) => {
  const name = model.toLowerCase()

  if (name.includes('fable')) return { emoji: '🦄', color: COLOR.orchid }
  if (name.includes('opus')) return { emoji: '🪐', color: COLOR.amber }
  if (name.includes('sonnet')) return { emoji: '🪶', color: 'suggestion' }
  if (name.includes('haiku')) return { emoji: '🍃', color: COLOR.green }

  return { emoji: '✨', color: 'text' }
}

const EFFORT_COLORS: Record<string, string> = { low: LABEL, medium: COLOR.cyan, high: COLOR.amber, xhigh: COLOR.orange, max: COLOR.red }

const effortColor = (level: Effort | null) => (level === null ? LABEL : (EFFORT_COLORS[String(level)] ?? COLOR.amber))

const contextColor = (value: number) => {
  if (value >= 70) return COLOR.red
  if (value >= 40) return COLOR.orange
  if (value >= 20) return COLOR.amber

  return undefined
}

const usageColor = (value: number) => {
  if (value >= 85) return COLOR.red
  if (value >= 60) return COLOR.orange
  if (value >= 40) return COLOR.amber

  return undefined
}

const isWarm = (left: number | null) => left !== null && left > 0

const cacheWords = (left: number | null, none: string, suffix: string) => {
  if (left === null) return none
  if (left <= 0) return 'cold'

  return `${Math.ceil(left / 60_000)}m${suffix}`
}

// Theme keys, so both follow a light or a dark theme. `suggestion` is the theme's blue, `claude` its terracotta;
// `warning` and `error` take over near the end.
const cacheColor = (left: number | null, ttl: number) => {
  if (left === null || left <= 0) return 'suggestion'

  const share = (left * 100) / ttl

  if (share <= 10) return 'error'
  if (share <= 25) return COLOR.amber

  return 'claude'
}

const AGENT_GLYPHS: Record<string, { icon: string; color: string }> = {
  completed: { icon: '✓', color: COLOR.green },
  failed: { icon: '✗', color: COLOR.red },
  killed: { icon: '⊘', color: LABEL },
  waiting: { icon: '⏸', color: COLOR.amber },
  idle: { icon: '◌', color: LABEL },
}

const agentGlyph = (status: string, nowMs: number) => {
  if (status === 'running') {
    return { icon: SPINNER[Math.floor(nowMs / 1000) % SPINNER.length] ?? '◐', color: COLOR.cyan }
  }

  return AGENT_GLYPHS[status] ?? { icon: '○', color: LABEL }
}

const bar = (percent: number, width: number) => {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))

  return { filled: '▰'.repeat(filled), empty: '▱'.repeat(width - filled) }
}

const resetLabel = (resetsAt: number | null, nowMs: number) => (resetsAt === null ? '' : `↻${formatDuration(resetsAt - nowMs)}`)

const shortModel = (model: string) => cleanModel(model).replace(/^claude-/, '')

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

const padEnd = (text: string, width: number) => (text.length >= width ? text : text + ' '.repeat(width - text.length))

const padStart = (text: string, width: number) => (text.length >= width ? text : ' '.repeat(width - text.length) + text)

const formatTokens = (tokens: number) => (tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1000)}k`)

const formatAgo = (ms: number) => (ms < 60_000 ? 'just now' : `${formatDuration(ms)} ago`)

