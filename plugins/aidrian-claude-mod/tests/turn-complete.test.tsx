import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const FOCUS_SCRIPT = 'tell application "System Events" to get name of first process whose frontmost is true'
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u

const FOLDER = '/work/workspace/tiger'

type Surface = { surface: 'terminal' | null; isInteractive: boolean }

const TERMINAL: Surface = { surface: 'terminal', isInteractive: true }

// Stands for the engine around a session's start, then starts one on `surface`. No aidrian plugin is found, so the
// snapshot starts no process.
const startSession = async ($: Engine, on: On, { surface, isInteractive }: Surface) => {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as never)
  on('session.id', () => ({ value: 'session-1' }))
  on('session.root', () => ({ value: FOLDER }))
  on('agent.list', () => ({ value: [] }) as never)
  on('env.get', () => ({ value: undefined }))
  on('fs.stat', () => ({ deny: 'ENOENT' }) as never)
  await $.session.start({ cwd: FOLDER, surface, isInteractive })
}

const captureLogs = async ($: Engine, on: On, surface: Surface = TERMINAL) => {
  const lines: string[] = []

  mock.clock(on)
  on('session.cwd', () => ({ value: FOLDER }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.log', ($, e) => {
    if (e.text.startsWith('aidrian-mod shadow')) lines.push(e.text)

    return { value: undefined }
  })
  await startSession($, on, surface)

  return lines
}

type Shown = { kind: 'toast' | 'notify'; text: string; title?: string }

// Stands for the engine in live mode: the folder, the sounds, the toast and the desktop notification, and osascript,
// which prints `front` as the app in front.
const captureAlerts = async ($: Engine, on: On, front: string, surface: Surface = TERMINAL) => {
  const shown: Shown[] = []
  const runs: (readonly string[])[] = []
  const played: string[] = []

  mock.clock(on)
  on('session.cwd', () => ({ value: FOLDER }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('audio.play', ($, e) => {
    played.push(JSON.stringify(e))

    return { value: undefined } as never
  })
  on('ui.toast', ($, e) => {
    shown.push({ kind: 'toast', text: e.text })

    return { value: undefined } as never
  })
  on('ui.notify', ($, e) => {
    shown.push({ kind: 'notify', text: e.text, title: e.title })

    return { value: undefined } as never
  })
  on('process.run', ($, e) => {
    runs.push(e.argv)

    return { value: { exitCode: 0, stdout: `${front}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await startSession($, on, surface)

  return { shown, runs, played }
}

const SHADOW = { options: { mode: 'shadow' } }

const turn = { answer: 'Tests pass.\nMore detail', isAborted: false, turnId: 't1', reason: 'answer' } as const

describe('turn.complete in shadow mode', () => {
  test('a long main-loop turn logs a Done notification', SHADOW, async ($, on) => {
    const lines = await captureLogs($, on)

    await $.turn.complete({ ...turn, durationMs: 45_000 })

    expect(lines).toEqual(['aidrian-mod shadow: would notify [done] tiger: Done in 45s. Tests pass.'])
  })

  test('a turn shorter than the threshold logs nothing', SHADOW, async ($, on) => {
    const lines = await captureLogs($, on)

    await $.turn.complete({ ...turn, durationMs: 5_000 })

    expect(lines).toEqual([])
  })

  test('a subagent turn logs nothing', SHADOW, async ($, on) => {
    const lines = await captureLogs($, on)

    await $.turn.complete({ ...turn, durationMs: 45_000, agentId: 'agent-1' })

    expect(lines).toEqual([])
  })

  test('an aborted turn logs nothing', SHADOW, async ($, on) => {
    const lines = await captureLogs($, on)

    await $.turn.complete({ ...turn, durationMs: 45_000, isAborted: true, reason: 'aborted' })

    expect(lines).toEqual([])
  })

  test('an answer line with escape sequences and bidi controls logs without them', SHADOW, async ($, on) => {
    const lines = await captureLogs($, on)

    await $.turn.complete({ ...turn, answer: 'Done \u001b]52;c;aGk=\u0007here\u001b[2J \u202eevil', durationMs: 45_000 })

    expect(lines.length).toBe(1)
    expect(HIDDEN.test(lines[0] ?? '')).toBe(false)
  })
})

describe('the focus check compares focusApp with the app in front', () => {
  const LIVE_ITERM = { options: { mode: 'live', sounds: false, focusApp: 'iTerm2' } }

  test('the terminal app in front: a toast, and osascript ran its constant script', LIVE_ITERM, async ($, on) => {
    const { shown, runs } = await captureAlerts($, on, 'iTerm2')

    await $.turn.complete({ ...turn, durationMs: 45_000 })

    expect(shown).toEqual([{ kind: 'toast', text: 'Done in 45s. Tests pass.' }])
    expect(runs).toEqual([['/usr/bin/osascript', '-e', FOCUS_SCRIPT]])
    expect(runs.flat().some(arg => arg.includes('iTerm2'))).toBe(false)
  })

  test('another app in front: a desktop notification titled with the folder', LIVE_ITERM, async ($, on) => {
    const { shown } = await captureAlerts($, on, 'kitty')

    await $.turn.complete({ ...turn, durationMs: 45_000 })

    expect(shown).toEqual([{ kind: 'notify', text: 'Done in 45s. Tests pass.', title: 'tiger' }])
  })

  test('the default focusApp is kitty', { options: { mode: 'live', sounds: false } }, async ($, on) => {
    const { shown } = await captureAlerts($, on, 'kitty')

    await $.turn.complete({ ...turn, durationMs: 45_000 })

    expect(shown.map(one => one.kind)).toEqual(['toast'])
  })

  test('a notification shows no escape sequence or bidi control', LIVE_ITERM, async ($, on) => {
    const { shown } = await captureAlerts($, on, 'kitty')

    await $.turn.complete({ ...turn, answer: 'ok \u001b]52;c;aGk=\u0007 \u202eevil\u200f', durationMs: 45_000 })

    expect(shown.length).toBe(1)
    expect(HIDDEN.test(shown[0]?.text ?? '')).toBe(false)
  })
})

describe('only an interactive terminal session gets alerts', () => {
  const PRINT: Surface = { surface: null, isInteractive: false }

  test('a -p session gets no notification, toast, or sound, and runs no focus check', { options: { mode: 'live', sounds: true } }, async ($, on) => {
    const { shown, runs, played } = await captureAlerts($, on, 'iTerm2', PRINT)

    await $.turn.complete({ ...turn, durationMs: 45_000 })
    await $.turn.complete({ ...turn, durationMs: 45_000, reason: 'error' })

    expect(shown).toEqual([])
    expect(runs).toEqual([])
    expect(played).toEqual([])
  })

  test('a -p session logs no shadow line', SHADOW, async ($, on) => {
    const lines = await captureLogs($, on, PRINT)

    await $.turn.complete({ ...turn, durationMs: 45_000 })

    expect(lines).toEqual([])
  })
})
