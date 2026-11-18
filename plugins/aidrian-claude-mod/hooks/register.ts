import type { EngineInterface, Register } from 'claude-code'

import { alertText } from '../lib/format.mjs'
import { runnerFor } from '../lib/snapshot-client.mjs'
import { alertsOn, engineIo, recordCacheBucket, recordTurnEnd, recordUsage, registerPane } from './pane'

// The notifications: a long turn done, an approval or a question waiting, an engine notification, a failed Bash
// command, a compaction, and a rate limit at 85% and 90%. Every text and title shown goes through format.mjs's
// alertText, the one filter on that path. The focus check runs the lib's constant osascript script and compares the
// focusApp setting with what it prints; the setting never reaches the script.

type Cue = 'done' | 'attention' | 'error' | 'limit'

type Alert = { cue: Cue; text: string; isDesktop: boolean }

const RATE_LIMIT_STEPS = [90, 85]
const WINDOW_LABELS: Record<string, string> = { five_hour: '5h limit', seven_day: '7-day limit' }

// Covered elsewhere: permission_prompt by classic.PermissionRequest, idle_prompt by turn.complete, plugin_notification
// is another plugin's own notify.
const SKIPPED_NOTIFICATION_TYPES = new Set(['permission_prompt', 'idle_prompt', 'plugin_notification'])

type Settings = { isLive: boolean; hasFocusCheck: boolean; focusApp: string; hasSounds: boolean; gain: number }

export const register: Register = (on, options) => {
  const isLive = options.mode === 'live'
  const minTurnMs = Number(options.notifyMinTurnSeconds) * 1000
  const settings: Settings = {
    isLive,
    hasFocusCheck: options.focusCheck === true,
    focusApp: String(options.focusApp ?? ''),
    hasSounds: options.sounds === true,
    gain: Number(options.volume),
  }
  const lastStepByWindow = new Map<string, number>()

  registerPane(on, options)

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await recordTurnEnd($, e.agentId, e.reason)
    const isMainLoop = e.agentId === undefined

    if (isMainLoop) {
      await recordCacheBucket($).catch(() => undefined)
    }

    if (isMainLoop && e.reason === 'answer' && e.durationMs >= minTurnMs) {
      await deliverAlert($, settings, {
        cue: 'done',
        text: `Done in ${formatDuration(e.durationMs)}. ${firstLine(e.answer)}`,
        isDesktop: true,
      })
    }

    if (isMainLoop && e.reason === 'error') {
      await deliverAlert($, settings, { cue: 'error', text: 'The turn stopped on an API error', isDesktop: true })
    }

    return result
  })

  on('classic.PermissionRequest', async ($, e, next) => {
    const result = await next(e)

    if (result.decision === undefined) {
      await deliverAlert($, settings, { cue: 'attention', text: `Needs approval: ${e.tool_name}`, isDesktop: true })
    }

    return result
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    await deliverAlert($, settings, { cue: 'attention', text: 'Claude has a question for you', isDesktop: true })

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Notification', async ($, e, next) => {
    const result = await next(e)

    if (!isLive && alertsOn()) {
      $.ui.log(alertText({ text: `aidrian-mod shadow: engine notification type=${e.notification_type}: ${e.message}` }).text)
    }

    if (!SKIPPED_NOTIFICATION_TYPES.has(e.notification_type)) {
      await deliverAlert($, settings, { cue: 'attention', text: e.message, isDesktop: true })
    }

    return result
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    const isMainLoop = !('agentId' in e) || e.agentId === undefined

    if (isMainLoop && ran.deny === undefined && ran.isError === true) {
      await deliverAlert($, settings, { cue: 'error', text: `Bash failed: ${firstLine(e.command)}`, isDesktop: false })
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    if (e.trigger !== 'precompute') {
      await deliverAlert($, settings, { cue: 'limit', text: 'Compacting the conversation', isDesktop: false })
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    await recordUsage($, e)
    const now = await $.clock.now()

    for (const window of e.rateLimits) {
      const step = RATE_LIMIT_STEPS.find(threshold => window.percentUsed >= threshold) ?? 0
      const previousStep = lastStepByWindow.get(window.kind) ?? 0
      lastStepByWindow.set(window.kind, step)

      if (step > previousStep) {
        const label = WINDOW_LABELS[window.kind] ?? window.kind
        const resets = window.resetsAt ? `, resets in ${formatDuration(Date.parse(window.resetsAt) - now)}` : ''
        await deliverAlert($, settings, { cue: 'limit', text: `${label} at ${Math.round(window.percentUsed)}%${resets}`, isDesktop: false })
      }
    }

    return next(e)
  })
}

// An alert reaches only an interactive session drawn in a terminal: a `-p` run, the SDK, and the desktop app get no
// sound, toast, notification, or shadow line, and run no focus check.
async function deliverAlert($: EngineInterface, settings: Settings, alert: Alert) {
  if (!alertsOn()) {
    return
  }

  const folder = basename(await $.session.cwd())

  if (!settings.isLive) {
    const kind = alert.isDesktop ? 'notify' : 'toast'
    $.ui.log(alertText({ text: `aidrian-mod shadow: would ${kind} [${alert.cue}] ${folder}: ${alert.text}` }).text)
    return
  }

  if (settings.hasSounds) {
    void $.audio.play({ asset: `sounds/${alert.cue}.wav` }, { gain: settings.gain }).catch(() => undefined)
  }

  const shown = alertText({ text: alert.text, title: folder })
  const isQuiet = !alert.isDesktop || (settings.hasFocusCheck && (await isTerminalInFront($, settings.focusApp)))

  if (isQuiet) {
    $.ui.toast(shown.text)
    return
  }

  await $.ui.notify(shown.text, { title: shown.title }).catch(() => undefined)
}

// Whether the frontmost app is the terminal: the lib runs osascript with its own constant script, and its output is
// only compared with the setting, never shown.
async function isTerminalInFront($: EngineInterface, focusApp: string) {
  const runner = await runnerFor(await engineIo($), { cwd: await $.session.cwd(), root: await $.session.root() })
  const front = await runner.frontmostApp()

  return front !== null && front === focusApp
}

const basename = (path: string) => path.split('/').filter(Boolean).pop() ?? path

const firstLine = (text: string) => {
  const line = text.trim().split('\n')[0] ?? ''

  return line.length > 120 ? `${line.slice(0, 119)}…` : line
}

const formatDuration = (ms: number) => {
  const minutes = Math.max(0, Math.round(ms / 60000))

  if (ms < 60000) {
    return `${Math.max(0, Math.round(ms / 1000))}s`
  }

  if (minutes < 60) {
    return `${minutes}m`
  }

  const rest = minutes % 60 > 0 ? `${minutes % 60}m` : ''

  return `${Math.floor(minutes / 60)}h${rest}`
}
