// `aidrian report`: the views of the dispatch log (dispatch-log.mjs) and of the review bot's pull requests. The default
// view is per agent type (report-agents.mjs); `docs`, `sessions`, `reviews`, and `health` each have a module of their
// own. docs/dispatch-log.md describes every view.

import path from 'node:path';
import { parseArgs } from 'node:util';

import { commandConfig } from './config.mjs';
import { coverage, coverageLines, readLog } from './dispatch-log.mjs';
import { projectAt } from './project.mjs';
import { formatReport, summarize } from './report-agents.mjs';
import { formatDocs, knowledgeOf, summarizeDocs } from './report-docs.mjs';
import { formatSessions, summarizeSessions } from './report-sessions.mjs';

// `7d`, `24h`, `30m`, or a date (YYYY-MM-DD, midnight UTC): the earliest time to report, in ms.
export function parseSince(value, now = Date.now()) {
  const span = /^(\d+)([dhm])$/u.exec(value);
  if (span) return now - Number(span[1]) * { d: 86_400_000, h: 3_600_000, m: 60_000 }[span[2]];
  const date = /^\d{4}-\d{2}-\d{2}$/u.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN;
  // Date.parse rolls 2026-02-31 over to March 3; a date that does not read back the same is not a date.
  if (Number.isNaN(date) || new Date(date).toISOString().slice(0, 10) !== value) throw new Error(`--since takes 7d, 24h, 30m, or YYYY-MM-DD, not ${value}`);
  return date;
}

// The views of `aidrian report`; the first is the default.
const VIEWS = ['agents', 'docs', 'sessions', 'reviews', 'health'];
// The views that read the review bot's pull requests, and so take --prs.
const PR_VIEWS = ['agents', 'reviews', 'health'];
// `aidrian report reviews` and `health` read this many merged pull requests unless --prs says otherwise.
const DEFAULT_PRS = 20;

export const commands = {
  report: {
    usage: '[agents|docs|sessions|reviews|health] [--since 7d] [--prs N] [--json] [--project DIR]',
    about: 'summarize the dispatch log per agent type with hook denies, per knowledge doc read (docs), or per session ' +
      '(sessions), the bot reviews of the last N merged pull requests (reviews), or every signal against its threshold ' +
      '(health, since 30d by default); --prs N on the default view adds reviews',
    async run(args) {
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { since: { type: 'string' }, prs: { type: 'string' }, json: { type: 'boolean' }, project: { type: 'string' } },
      });
      const view = positionals[0] ?? VIEWS[0];
      if (positionals.length > 1 || !VIEWS.includes(view)) {
        console.error(`unknown report: ${positionals.join(' ')}; use aidrian report, or aidrian report ${VIEWS.slice(1).join(', ')}`);
        return 1;
      }
      if (!PR_VIEWS.includes(view) && values.prs !== undefined) {
        console.error(`--prs belongs to aidrian report, aidrian report reviews, and aidrian report health, not aidrian report ${view}`);
        return 1;
      }
      const prs = Number(values.prs ?? DEFAULT_PRS);
      if (!Number.isInteger(prs) || prs < 1) {
        console.error('--prs takes a whole number above 0');
        return 1;
      }
      const project = projectAt(path.resolve(values.project ?? '.'));
      const config = commandConfig(project);
      // Health judges each signal on a sample, so it reads a month by default.
      const since = values.since ?? (view === 'health' ? '30d' : '7d');
      let sinceMs;
      try {
        sinceMs = parseSince(since);
      } catch (error) {
        console.error(error.message);
        return 1;
      }
      if (view === 'reviews') {
        // The log plays no part: the pull requests are the last N merged, or those merged since --since when it is given.
        const { formatReviews, ghAt, reviewRounds } = await import('./report-reviews.mjs');
        const reviews = reviewRounds(prs, config.github.reviewer, ghAt(project.root), { sinceMs: values.since === undefined ? null : sinceMs });
        const label = values.since ?? null;
        console.log(values.json ? JSON.stringify({ since: label, prs, ...reviews }) : formatReviews(reviews, { since: label }));
        return 0;
      }
      const { file, rotated, rows, skipped } = readLog(project, config);
      const cover = coverage(rows, config, { sinceMs });
      if (view === 'health') {
        // Every other view's numbers, each against its threshold; the reviews are those merged in the same window.
        const { formatHealth, summarizeHealth } = await import('./report-health.mjs');
        const { ghAt, reviewRounds } = await import('./report-reviews.mjs');
        const { inboxPath, lessons } = await import('./lesson-inbox.mjs');
        const health = summarizeHealth({
          rows,
          sinceMs,
          knowledge: knowledgeOf(project, config),
          reviews: reviewRounds(prs, config.github.reviewer, ghAt(project.root), { sinceMs }),
          lessons: lessons(inboxPath(project, config)),
          config,
        });
        const notes = coverageLines(cover, { hookDenies: true, sendBacks: true });
        console.log(values.json ? JSON.stringify({ file, rotated, since, skipped, coverage: cover, ...health }) : formatHealth(health, { file, since, skipped, notes }));
        return 0;
      }
      if (view === 'sessions') {
        const sessions = summarizeSessions(rows, { sinceMs });
        const notes = coverageLines(cover, { docReads: false });
        console.log(values.json ? JSON.stringify({ file, rotated, since, skipped, coverage: cover, ...sessions }) : formatSessions(sessions, { file, since, skipped, notes }));
        return 0;
      }
      if (view === 'docs') {
        const { indexed, always } = knowledgeOf(project, config);
        const docs = summarizeDocs(rows, { sinceMs, indexed });
        const notes = coverageLines(cover);
        console.log(values.json ? JSON.stringify({ file, rotated, since, skipped, coverage: cover, always, ...docs }) : formatDocs(docs, { file, since, skipped, notes, always }));
        return 0;
      }
      const summary = summarize(rows, { sinceMs });
      const text = () => formatReport(summary, { file, since, skipped, notes: coverageLines(cover, { hookDenies: true, sendBacks: true }) });
      if (values.prs !== undefined) {
        // The alias the reviews view grew from: the default view, then the reviews of the last N merged pull requests.
        const { formatReviews, ghAt, reviewRounds } = await import('./report-reviews.mjs');
        summary.reviews = reviewRounds(prs, config.github.reviewer, ghAt(project.root));
        if (!values.json) console.log(`${text()}\n${formatReviews(summary.reviews)}`);
      } else if (!values.json) {
        console.log(text());
      }
      if (values.json) console.log(JSON.stringify({ file, rotated, since, skipped, coverage: cover, ...summary }));
      return 0;
    },
  },
};
