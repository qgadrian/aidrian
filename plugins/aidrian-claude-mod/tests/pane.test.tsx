import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// The band and the aidrian-mod pane, against a fake engine: the hooks here stand for the files, the processes, and the
// MCP servers the mod reaches, and answer from a `World` each test shapes.

const paneProps = {
  title: 'aidrian-mod',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { bodyRows: 40, offset: 0 },
} as never

const BAND = {
  plugin: 'aidrian-mod',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160, scroll: { bodyRows: 10, offset: 0 }, view: {} } as never,
  viewport: { columns: 165, rows: 40 },
} as const

const PANE = {
  plugin: 'aidrian-mod',
  component: 'Pane',
  props: paneProps,
  requestId: 'aidrian-mod',
  viewport: { columns: 64, rows: 60 },
} as const

const MAIN = '/work/tiger'
const WORKTREE = '/work/tiger/.claude/worktrees/feature'
const SESSION = 'session-1'
const TRANSCRIPT = `/work/.claude/projects/-work-tiger/${SESSION}.jsonl`
const NODE = '/fake/bin/node'
const GIT = '/fake/bin/git'
const CLI = '/fake/aidrian/lib/cli.mjs'
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u

type Run = { argv: readonly string[]; cwd?: string; env?: Record<string, string> }

type World = {
  cwd: string
  // The folders and files that exist, each by its own real path, and the PATH the mod reads.
  files: Set<string>
  dirs: Set<string>
  PATH: string
  // What `node <cli> session snapshot --json` prints, and its exit code, and how long it takes on the mocked clock.
  snapshot: Record<string, unknown>
  snapshotExit: number
  snapshotDelayMs: number
  // How long a git read takes, on the mocked clock.
  gitDelayMs: number
  transcript: string[]
  linear: Record<string, unknown> | null
  runs: Run[]
  mcpCalls: { server: string; tool: string; args: Record<string, unknown> }[]
}

type Clock = ReturnType<typeof mock.clock>

const BASE_FILES = [NODE, GIT, '/fake/aidrian/bin/aidrian', CLI, TRANSCRIPT]
const BASE_DIRS = [MAIN, WORKTREE, '/fake/bin', '/fake/aidrian', '/fake/aidrian/bin', '/fake/aidrian/lib', '/work/.claude/projects', '/work/.claude/projects/-work-tiger']

const world = (fields: Partial<World>): World => ({
  cwd: MAIN,
  files: new Set(BASE_FILES),
  dirs: new Set(BASE_DIRS),
  PATH: '/fake/aidrian/bin:/fake/bin',
  snapshot: {},
  snapshotExit: 0,
  snapshotDelayMs: 0,
  gitDelayMs: 0,
  transcript: [],
  linear: null,
  runs: [],
  mcpCalls: [],
  ...fields,
})

const ran = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

const transcriptText = (state: World) => state.transcript.map(line => `${line}\n`).join('')

const statOf = (state: World, path: string) => {
  if (path === TRANSCRIPT && state.files.has(path)) {
    return { kind: 'file', size: transcriptText(state).length, mtimeMs: 1, isLink: false, realPath: path }
  }
  if (state.files.has(path)) return { kind: 'file', size: 0, mtimeMs: 1, isLink: false, realPath: path }
  if (state.dirs.has(path)) return { kind: 'dir', size: 0, mtimeMs: 1, isLink: false, realPath: path }

  return null
}

const gitAnswer = (state: World, args: string, cwd: string) => {
  const isWorktree = cwd.startsWith(WORKTREE)

  if (args === 'branch --show-current') return ran(isWorktree ? 'feature' : 'main')
  if (args === 'rev-parse --absolute-git-dir') return ran(isWorktree ? `${MAIN}/.git/worktrees/feature` : `${MAIN}/.git`)
  if (args.endsWith('status --porcelain')) return ran('')

  return ran('', 1)
}

// Stands for the engine, the disk, node, git, and the Linear servers.
const fakeWorld = (on: On, clock: Clock, state: World) => {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as never)
  on('session.cwd', () => ({ value: state.cwd }))
  on('session.root', () => ({ value: MAIN }))
  on('session.id', () => ({ value: SESSION }))
  on('agent.list', () => ({ value: [] }) as never)
  on('env.get', ($, e) => {
    const values: Record<string, string> = { PATH: state.PATH, HOME: '/work' }

    return { value: values[e.name] }
  })
  on('fs.stat', ($, e) => {
    const found = statOf(state, e.path)

    return found ? ({ value: found } as never) : ({ deny: 'ENOENT' } as never)
  })
  on('fs.list', () => ({ value: [{ name: '-work-tiger', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }) as never)
  on('fs.read', ($, e) => {
    const text = transcriptText(state)
    const offset = e.offset ?? 0

    return { value: text.slice(offset, offset + (e.length ?? text.length)) } as never
  })
  on('mcp.call', ($, e) => {
    state.mcpCalls.push({ server: e.server, tool: e.tool, args: e.args })
    if (e.server !== 'linear-server' || state.linear === null) return { deny: 'not connected' } as never

    return { value: { content: [{ type: 'text', text: JSON.stringify(state.linear) }], isError: false } } as never
  })
  on('process.run', async ($, e) => {
    const cwd = e.init?.cwd ?? state.cwd
    state.runs.push({ argv: e.argv, cwd, env: e.init?.env })

    if (e.argv[0] === NODE) {
      if (state.snapshotDelayMs > 0) await clock.sleep(state.snapshotDelayMs)
      // A run past its time limit: the engine kills it and the call rejects.
      if (state.snapshotDelayMs > (e.init?.timeoutMs ?? 30_000)) return { deny: 'timed out' } as never

      return ran(JSON.stringify(state.snapshot), state.snapshotExit)
    }
    if (e.argv[0] === GIT) {
      if (state.gitDelayMs > 0) await clock.sleep(state.gitDelayMs)

      return gitAnswer(state, e.argv.slice(1).join(' '), cwd)
    }

    return ran('', 127)
  })
}

const startIn = async ($: Engine, on: On, state: World, surface: 'terminal' | 'desktop' = 'terminal') => {
  const clock = mock.clock(on, { now: 0 })
  fakeWorld(on, clock, state)
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  await $.session.start({ cwd: state.cwd, surface, isInteractive: true })
  await clock.settle()

  return clock
}

const endTurn = ($: Engine) => $.turn.complete({ answer: 'ok', isAborted: false, turnId: 't1', reason: 'answer', durationMs: 1000 })

const band = ($: Engine) => $.ui.mount({ ...BAND, surface: 'terminal' })

const pane = ($: Engine) => $.ui.mount({ ...PANE, surface: 'terminal' })

// Stands for the engine's own band or pane, drawn when no plugin draws one.
const engineDraws = (on: On) =>
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

const pull = (number: number, fields: Record<string, unknown> = {}) => ({
  forge: 'github',
  host: 'github.com',
  repo: 'acme/notes',
  number,
  title: `Change ${number}`,
  url: `https://github.com/acme/notes/pull/${number}`,
  isDraft: false,
  state: 'open',
  mergeable: true,
  reviewDecision: null,
  unresolvedThreads: 0,
  checks: { passed: 3, failed: 0, pending: 0, skipped: 0 },
  ...fields,
})

const HANDOFF_DUE = { ratio: 2.3, breakEven: 24, level: 'due', nextRatio: 2.5, context: 1, ceiling: null, chain: 1, maxChain: 3, continueArmed: true, lastBrief: null }

describe('aidrian-mod pane', () => {
  test('draws the model card and an empty agents card on the terminal', async ($, on) => {
    on('session.model', () => ({ value: 'Opus 5.5 (1M context)' }))

    const drawing = await pane($)

    expect(await drawing.find({ type: 'Text', text: /Opus 5\.5/ })).toBeDefined()
    expect(await drawing.find({ type: 'Text', text: /No subagents in this session yet/ })).toBeDefined()
  })

  test('draws a running subagent with its role and model', async ($, on) => {
    on('session.model', () => ({ value: 'Opus 5.5' }))
    on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'agent-1' }))
    mock.clock(on)

    await $.agent.spawn({
      prompt: 'Find the mod API types',
      description: 'Find mod API types',
      subagentType: 'Explore',
      parentModel: 'claude-opus-5-5',
    } as never)

    const drawing = await pane($)

    expect(await drawing.find({ type: 'Text', text: /Explore/ })).toBeDefined()
    expect(await drawing.find({ type: 'Text', text: /1 running/ })).toBeDefined()
    expect(await drawing.find({ type: 'Text', text: /Haiku 5\.5/ })).toBeDefined()
  })
})

describe('aidrian-mod band', () => {
  test('draws the model, limits and agents rows above the prompt', async ($, on) => {
    on('session.model', () => ({ value: 'claude-opus-5-5[1m]' }))

    const drawing = await band($)

    expect(await drawing.find({ type: 'Text', text: /^Opus 5\.5$/ })).toBeDefined()
    expect(await drawing.find({ type: 'Text', text: /^ctx/ })).toBeDefined()
  })

  test('shows when the 5-hour and the 7-day limits renew', async ($, on) => {
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('session.measure', () => ({ changed: [] }))
    // The band reads the session clock, which starts at 0 in a test.
    const start = 0
    mock.clock(on, { now: start })
    const inHours = (hours: number) => new Date(start + hours * 3_600_000).toISOString()
    await $.session.measure({
      context: { percent: 40, window: 200_000 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 26, resetsAt: inHours(3) },
        { kind: 'seven_day', percentUsed: 15, resetsAt: inHours(50) },
      ],
    } as never)

    const drawing = await band($)

    expect(await drawing.find({ type: 'Text', text: /^ ↻3h00m$/ })).toBeDefined()
    expect(await drawing.find({ type: 'Text', text: /^ ↻2d2h$/ })).toBeDefined()
  })
})

describe('aidrian-mod surfaces', () => {
  test('draws the band on the terminal and nothing of its own in the desktop app', async ($, on) => {
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    engineDraws(on)

    const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })

    expect(await terminal.find({ type: 'Text', text: /^Opus 5\.5$/ })).toBeDefined()
    expect(await desktop.find({ type: 'Text', text: /^engine$/ })).toBeDefined()
    expect(await desktop.find({ type: 'Text', text: /Opus 5\.5/ })).toBeUndefined()
  })

  test('draws nothing of its own in the desktop pane', async ($, on) => {
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    engineDraws(on)

    const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })

    expect(await terminal.find({ type: 'Text', text: /Agents/ })).toBeDefined()
    expect(await desktop.find({ type: 'Text', text: /^engine$/ })).toBeDefined()
    expect(await desktop.find({ type: 'Text', text: /Agents/ })).toBeUndefined()
  })

  test('a session the desktop app starts runs no process', async ($, on) => {
    const state = world({ cwd: WORKTREE })
    const clock = await startIn($, on, state, 'desktop')
    await clock.advance(61_000)

    expect(state.runs).toEqual([])
  })
})

describe('every process goes through the resolver', () => {
  test('node and git run by an absolute path, never a shell, with PATH of checked entries only', async ($, on) => {
    const state = world({ snapshot: { prs: [] } })
    await startIn($, on, state)

    expect(state.runs.length).toBeGreaterThan(0)
    for (const run of state.runs) {
      expect(run.argv[0]?.startsWith('/')).toBe(true)
      expect(['sh', 'bash', 'zsh'].includes(String(run.argv[0]).split('/').pop() ?? '')).toBe(false)
      expect(run.env?.PATH).toBe('/fake/aidrian/bin:/fake/bin')
    }
    expect(state.runs.some(run => run.argv[0] === NODE && run.argv[1] === CLI && run.argv.includes('--json'))).toBe(true)
  })

  test('the snapshot gets the session and its transcript as --name=value flags', async ($, on) => {
    const state = world({ snapshot: {} })
    await startIn($, on, state)
    const snapshotRun = state.runs.find(run => run.argv[0] === NODE)

    expect(snapshotRun?.argv.slice(2)).toEqual(['session', 'snapshot', '--json', `--session=${SESSION}`, `--transcript=${TRANSCRIPT}`])
  })
})

describe('aidrian-mod follows the session directory', () => {
  test('shows the worktree after the session moves into it', async ($, on) => {
    const state = world({ cwd: MAIN })
    const clock = await startIn($, on, state)

    expect(await (await band($)).find({ type: 'Text', text: /^main$/ })).toBeDefined()

    state.cwd = WORKTREE
    await clock.advance(1000)
    const after = await band($)

    expect(await after.find({ type: 'Text', text: /^feature$/ })).toBeDefined()
    expect(await after.find({ type: 'Text', text: /^main$/ })).toBeUndefined()
  })

  test('drops a result read for a directory the session already left', async ($, on) => {
    const state = world({ cwd: MAIN })
    const clock = await startIn($, on, state)

    state.gitDelayMs = 4500
    state.cwd = WORKTREE
    await clock.advance(1000)
    state.cwd = MAIN
    // git answers for the worktree at 5.5s, after the session went back.
    await clock.advance(4500)

    expect(await (await band($)).find({ type: 'Text', text: /^feature$/ })).toBeUndefined()

    state.gitDelayMs = 0
    await clock.advance(5000)
    const settled = await band($)

    expect(await settled.find({ type: 'Text', text: /^main$/ })).toBeDefined()
    expect(await settled.find({ type: 'Text', text: /^feature$/ })).toBeUndefined()
  })
})

describe('aidrian-mod cache', () => {
  const MINUTE = 60_000

  const cacheText = async ($: Engine) => {
    const drawing = await band($)

    return {
      drawing,
      left: async (text: RegExp) => (await drawing.find({ type: 'Text', text }))?.props.color,
    }
  }

  test('warm: a hot-springs emoji and the minutes left in the warm theme colour', async ($, on) => {
    await startIn($, on, world({}))
    await endTurn($)
    const { drawing, left } = await cacheText($)

    expect(await drawing.find({ type: 'Text', text: /♨️/ })).toBeDefined()
    expect(await left(/^60m$/)).toBe('claude')
    expect((await drawing.find({ type: 'Text', text: /^cache $/ }))?.props.color).toBe('inactive')
  })

  // A ten-minute lifetime, so the countdown crosses each line in few ticks of the band's one-second clock.
  const TEN_MINUTES = { options: { cacheTtlSeconds: 600 } }

  test('25% or less left: warning; 10% or less: error', TEN_MINUTES, async ($, on) => {
    const clock = await startIn($, on, world({}))
    await endTurn($)

    await clock.advance(8 * MINUTE)
    expect(await (await cacheText($)).left(/^2m$/)).toBe('warning')

    await clock.advance(MINUTE)
    expect(await (await cacheText($)).left(/^1m$/)).toBe('error')
  })

  test('cold: a snowflake and the word cold in the blue theme colour', TEN_MINUTES, async ($, on) => {
    const clock = await startIn($, on, world({}))
    await endTurn($)
    await clock.advance(11 * MINUTE)
    const { drawing, left } = await cacheText($)

    expect(await drawing.find({ type: 'Text', text: /❄️/ })).toBeDefined()
    expect(await left(/^cold$/)).toBe('suggestion')
  })
})

describe('aidrian-mod cache lifetime from the transcript', () => {
  const reply = (buckets: string, isSidechain = false) =>
    `{"type":"assistant","isSidechain":${isSidechain},"message":{"usage":{"input_tokens":3,"cache_creation":${buckets}}}}`
  const FIVE_MINUTES_ONLY = 300

  test('reads a 5-minute bucket, through the file and no process', async ($, on) => {
    const state = world({ transcript: [reply('{"ephemeral_5m_input_tokens":1687,"ephemeral_1h_input_tokens":0}')] })
    await startIn($, on, state)
    const before = state.runs.length
    await endTurn($)

    expect(await (await band($)).find({ type: 'Text', text: /^5m$/ })).toBeDefined()
    expect(state.runs.slice(before).every(run => run.argv[0] === NODE || run.argv[0] === GIT)).toBe(true)
  })

  test('reads a 1-hour bucket in either key order', { options: { cacheTtlSeconds: FIVE_MINUTES_ONLY } }, async ($, on) => {
    const state = world({ transcript: [reply('{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":900}')] })
    await startIn($, on, state)
    await endTurn($)

    expect(await (await band($)).find({ type: 'Text', text: /^60m$/ })).toBeDefined()

    state.transcript = [reply('{"ephemeral_1h_input_tokens":900,"ephemeral_5m_input_tokens":0}')]
    await endTurn($)

    expect(await (await band($)).find({ type: 'Text', text: /^60m$/ })).toBeDefined()
  })

  test('skips subagent lines and keeps the lifetime when a reply wrote nothing', async ($, on) => {
    const state = world({
      transcript: [reply('{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":1687}'), reply('{"ephemeral_1h_input_tokens":500,"ephemeral_5m_input_tokens":0}', true)],
    })
    await startIn($, on, state)
    await endTurn($)

    expect(await (await band($)).find({ type: 'Text', text: /^5m$/ })).toBeDefined()

    state.transcript = [reply('{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0}')]
    await endTurn($)

    expect(await (await band($)).find({ type: 'Text', text: /^5m$/ })).toBeDefined()
  })

  const FIVE_MINUTE_REPLY = () => reply('{"ephemeral_5m_input_tokens":1687,"ephemeral_1h_input_tokens":0}')

  test('reads the lifetime in a folder with no aidrian plugin, where no snapshot runs', async ($, on) => {
    const state = world({ PATH: '/fake/bin', transcript: [FIVE_MINUTE_REPLY()] })
    await startIn($, on, state)
    await endTurn($)

    expect(state.runs.some(run => run.argv[0] === NODE)).toBe(false)
    expect(await (await band($)).find({ type: 'Text', text: /^5m$/ })).toBeDefined()
  })

  test('reads the lifetime at the end of a first turn that ends before the first snapshot returns', async ($, on) => {
    const state = world({ snapshotDelayMs: 3000, transcript: [FIVE_MINUTE_REPLY()] })
    await startIn($, on, state)
    await endTurn($)

    expect(await (await band($)).find({ type: 'Text', text: /^5m$/ })).toBeDefined()
  })

  test('reads the lifetime again when a refresh first finds the transcript', async ($, on) => {
    const state = world({ transcript: [FIVE_MINUTE_REPLY()] })
    state.files.delete(TRANSCRIPT)
    const clock = await startIn($, on, state)
    await endTurn($)

    expect(await (await band($)).find({ type: 'Text', text: /^60m$/ })).toBeDefined()

    state.files.add(TRANSCRIPT)
    await clock.advance(60_000)

    expect(await (await band($)).find({ type: 'Text', text: /^(5m|4m)$/ })).toBeDefined()
  })
})

describe('the snapshot rows', () => {
  const SNAPSHOT = {
    handoff: HANDOFF_DUE,
    prs: [pull(12), pull(13, { checks: { passed: 1, failed: 1, pending: 1, skipped: 0 }, url: 'https://github.com/other/repo/pull/13' })],
    lessons: { open: 2, byTier: { P1: 1, P2: 1, P3: 0 } },
    worktrees: { owned: 2, mergedNotCleaned: 1 },
    decisions: { provisional: 0 },
    audits: { untriaged: 0 },
    ticket: null,
    errors: [],
  }

  test('the band draws the handoff segment, the pull request summary, and the harness row', async ($, on) => {
    await startIn($, on, world({ snapshot: SNAPSHOT }))
    const drawing = await band($)

    expect(await drawing.find({ type: 'Text', text: /^2\.3x · handoff due, pays back in ~24 calls$/ })).toBeDefined()
    expect(await drawing.find({ type: 'Text', text: /^armed 1\/3$/ })).toBeDefined()
    expect(await drawing.find({ type: 'Text', text: /^2 PRs · $/ })).toBeDefined()
    expect((await drawing.find({ type: 'Text', text: /^✓1$/ }))?.props.color).toBe('success')
    expect((await drawing.find({ type: 'Text', text: /^✗1$/ }))?.props.color).toBe('error')
    expect(await drawing.find({ type: 'Text', text: /^📥 1 P1$/ })).toBeDefined()
    expect(await drawing.find({ type: 'Text', text: /^🧹 1 worktree$/ })).toBeDefined()
    expect(await drawing.find({ type: 'Text', text: /decision/ })).toBeUndefined()
  })

  test('the pane lists one row per pull request, linking only the url that matches its row', async ($, on) => {
    await startIn($, on, world({ snapshot: SNAPSHOT }))
    const drawing = await pane($)

    expect(await drawing.find({ type: 'Text', text: /^PR #12$/ })).toBeDefined()
    expect(await drawing.find({ type: 'Text', text: /^PR #13$/ })).toBeDefined()
    const links = (await drawing.findAll({ type: 'Link' })).map(link => link.props.href)

    expect(links).toEqual(['https://github.com/acme/notes/pull/12'])
  })

  test('no hidden character of a title or a check reaches the band or the pane', async ($, on) => {
    const hostile = pull(14, { title: 'Fix \u001b]52;c;aGk=\u0007 it\u001b[2J \u202eevil\u200f\u2060\u{E0041}' })
    await startIn($, on, world({ snapshot: { ...SNAPSHOT, prs: [hostile] } }))

    for (const drawing of [await band($), await pane($)]) {
      const texts = (await drawing.findAll({ type: 'Text' })).map(found => found.text)

      expect(texts.length).toBeGreaterThan(0)
      expect(texts.filter(text => HIDDEN.test(text))).toEqual([])
    }
  })

  test('an empty snapshot draws no handoff, pull request, or harness part', async ($, on) => {
    await startIn($, on, world({ snapshot: { handoff: null, prs: null, lessons: null, worktrees: null, decisions: null, audits: null, ticket: null, errors: [] } }))
    const drawing = await band($)

    expect(await drawing.find({ type: 'Text', text: /handoff|PRs?\b|📥|🧹|⚖️|🔎/ })).toBeUndefined()
  })
})

describe('the ticket', () => {
  const ISSUE = { title: 'Ship the band', status: 'In Progress', url: 'https://linear.app/acme/issue/ABC-12/ship-the-band' }

  test('a key a prefix matched is looked up with get_issue and { id } alone, and links to its Linear page', { options: { ticketPrefixes: 'ABC' } }, async ($, on) => {
    const state = world({ snapshot: { ticket: { key: 'ABC-12', source: 'branch' } }, linear: ISSUE })
    await startIn($, on, state)
    const drawing = await pane($)

    expect(state.mcpCalls.map(call => [call.server, call.tool, call.args])).toEqual([
      ['linear', 'get_issue', { id: 'ABC-12' }],
      ['linear-server', 'get_issue', { id: 'ABC-12' }],
    ])
    expect(await drawing.find({ type: 'Text', text: /Ship the band/ })).toBeDefined()
    expect((await drawing.findAll({ type: 'Link' })).map(link => link.props.href)).toEqual([ISSUE.url])
    expect(state.runs.find(run => run.argv[0] === NODE)?.argv).toContain('--ticket-prefixes=ABC')
  })

  test('a Linear url that is not the key`s page is no link', { options: { ticketPrefixes: 'ABC' } }, async ($, on) => {
    const state = world({ snapshot: { ticket: { key: 'ABC-12', source: 'branch' } }, linear: { ...ISSUE, url: 'https://linear.app.example.org/acme/issue/ABC-12' } })
    await startIn($, on, state)

    expect(await (await pane($)).findAll({ type: 'Link' })).toEqual([])
  })

  test('a GitHub #N key shows as it is, with no lookup', async ($, on) => {
    const state = world({ snapshot: { ticket: { key: '#42', source: 'branch' } } })
    await startIn($, on, state)

    expect(await (await band($)).find({ type: 'Text', text: /^#42$/ })).toBeDefined()
    expect(state.mcpCalls).toEqual([])
  })
})

describe('the pane names a snapshot it could not read', () => {
  test('no aidrian plugin: missing', async ($, on) => {
    await startIn($, on, world({ PATH: '/fake/bin' }))

    expect(await (await pane($)).find({ type: 'Text', text: /^The aidrian plugin is not installed for this folder: install it/ })).toBeDefined()
  })

  test('the plugin found, and no node: no-node', async ($, on) => {
    const state = world({})
    state.files.delete(NODE)
    await startIn($, on, state)

    expect(await (await pane($)).find({ type: 'Text', text: /^The aidrian plugin is installed, but no node was found in a PATH folder outside this session's folder/ })).toBeDefined()
    expect(state.runs.some(run => run.argv[0] === NODE)).toBe(false)
  })

  test('a snapshot that exits non-zero: failed', async ($, on) => {
    await startIn($, on, world({ snapshotExit: 1 }))

    expect(await (await pane($)).find({ type: 'Text', text: /^The aidrian plugin returned no snapshot: update it to the latest release\.$/ })).toBeDefined()
  })

  test('a snapshot past its 10s limit: timed out', async ($, on) => {
    const state = world({ snapshotDelayMs: 11_000 })
    const clock = await startIn($, on, state)
    await clock.advance(11_000)

    expect(state.runs.find(run => run.argv[0] === NODE)).toBeDefined()
    expect(await (await pane($)).find({ type: 'Text', text: /^The aidrian snapshot took longer than 10 seconds and was stopped: / })).toBeDefined()
  })
})

describe('aidrian-mod effort before the first turn', () => {
  test("reads the model's entry in modelSettings", async ($, on) => {
    on('session.model', () => ({ value: 'claude-opus-5-5[1m]' }))
    on('settings.read', () => ({ value: { effortLevel: 'high', modelSettings: { 'claude-opus-5-5': { effortLevel: 'low' } } } }))

    expect(await (await band($)).find({ type: 'Text', text: /low/ })).toBeDefined()
  })

  test('ignores the top-level effortLevel on Opus 5.5 and shows its default', async ($, on) => {
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('settings.read', () => ({ value: { effortLevel: 'high' } }))

    expect(await (await band($)).find({ type: 'Text', text: /medium/ })).toBeDefined()
  })

  test('prefers CLAUDE_CODE_EFFORT_LEVEL over the settings', async ($, on) => {
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('env.get', () => ({ value: 'xhigh' }))
    on('settings.read', () => ({ value: { modelSettings: { 'claude-opus-5-5': { effortLevel: 'low' } } } }))

    expect(await (await band($)).find({ type: 'Text', text: /xhigh/ })).toBeDefined()
  })
})

describe('the pane command answers with constant text', () => {
  test('open and hide', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }) as never)
    on('ui.close', () => ({ value: undefined }) as never)
    await startIn($, on, world({}))

    expect(await $.command.run({ command: 'aidrian-mod', args: '' } as never)).toEqual({ text: 'The aidrian-mod pane is open.' })
    expect(await $.command.run({ command: 'aidrian-mod', args: 'hide' } as never)).toEqual({ text: 'The aidrian-mod pane is closed. The band above the prompt stays.' })
  })
})
