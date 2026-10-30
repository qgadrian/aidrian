// `aidrian report health`: one page over the other views. Seven signals (the knowledge budget, doc reads, agents, review
// rounds, hook denies, session cost, and the lesson inbox), each with its sample size and its threshold, mostly from
// config.json `telemetry.health`; then the problems, worst first, each naming the row of the harness-health skill's fix
// table that answers it. A signal with fewer than `minSample` samples says "not enough data" and is never a problem.
// Every verdict compares unrounded numbers; only what the view prints is rounded. docs/dispatch-log.md#health describes
// the view.

import { summarize, summarizeDenies } from './report-agents.mjs';
import { summarizeDocs } from './report-docs.mjs';
import { latestRows } from './jsonl.mjs';
import { lessonStats } from './lesson-inbox.mjs';
import { deliverySignal, denialSignal, roundLimitSignal } from './lesson-signals.mjs';
import { summarizeSessions } from './report-sessions.mjs';

// Each kind of problem, worst first, and its fix: the row of the harness-health skill's fix table that answers it.
// What blocks or loses work comes first, then what every session pays, then the cost of one agent, one rule, or one doc.
export const FIXES = {
  'p1-lesson': 'lesson-triage',
  'always-budget': 'split-doc',
  'tagged-doc': 'split-doc',
  redispatch: 'agent-prompt',
  'sent-back': 'agent-prompt',
  'review-rounds': 'round-cap',
  'late-findings': 'round-cap',
  'deny-hot-spot': 'deny-rule',
  'fix-recurred': 'lesson-triage',
  'cost-rise': 'cost',
  'top-doc': 'split-doc',
  'never-read': 'split-doc',
  'lesson-backlog': 'lesson-triage',
};
// The view lists this many docs with the most bytes read, and names at most this many tagged docs nobody read.
const TOP_DOCS = 3;
const NAMED_DOCS = 3;

// A problem the plugin already records as an automatic lesson (lesson-signals.mjs) takes that lesson's key and labels,
// so a lesson captured from this report is the same lesson seen again, not a second one.
const labels = ({ tier, kind, target, key }) => ({ tier, kind, target, key });
// The signal that finds each kind of problem a lesson can hold.
const SIGNAL_OF = {
  'always-budget': 'budget', 'tagged-doc': 'budget', redispatch: 'agents', 'sent-back': 'agents', 'review-rounds': 'reviews',
  'late-findings': 'reviews', 'deny-hot-spot': 'denies', 'cost-rise': 'cost', 'top-doc': 'docs', 'never-read': 'docs',
};

const OK = 'ok';
const PROBLEM = 'problem';
const NOT_ENOUGH = 'not_enough_data';
const UNAVAILABLE = 'unavailable';

const percentOf = (part, whole) => (whole ? (part / whole) * 100 : null);
const sumOf = (list, valueOf) => list.reduce((total, item) => total + (valueOf(item) ?? 0), 0);
// A signal made of parts is a problem when one part is, ok when one part was judged, and not enough data otherwise.
const overall = (statuses) => (statuses.includes(PROBLEM) ? PROBLEM : statuses.includes(OK) ? OK : NOT_ENOUGH);
// A percent as the view prints it: whole, or to a tenth when a whole number would not show that it is over its threshold.
const shown = (percent, threshold) => {
  const whole = Math.round(percent);
  return percent > threshold && whole <= threshold ? Math.round(percent * 10) / 10 : whole;
};

// { thresholds, problems, signals }. `knowledge` is knowledgeOf's { indexed, always, tags }; `reviews` is reviewRounds'
// result, or its { error }; `lessons` is the folded inbox.
export function summarizeHealth(input) {
  const { config } = input;
  const { problems, signals } = judge(input);
  sinceResolution(problems, input);
  const order = Object.keys(FIXES);
  const ratio = (item) => (item.threshold > 0 ? item.value / item.threshold : item.value);
  problems.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || ratio(b) - ratio(a) || String(a.subject).localeCompare(String(b.subject)));
  const { maxOpen, maxAgeDays } = config.lessons;
  return { thresholds: { health: config.telemetry.health, budgets: config.knowledge.budgets, lessons: { maxOpen, maxAgeDays } }, problems, signals };
}

// Every signal over the rows since `sinceMs`, and the problems they found, unranked.
function judge({ rows, sinceMs = 0, now = Date.now(), knowledge, reviews, lessons = [], config }) {
  const limits = config.telemetry.health;
  const problems = [];
  const add = (kind, fields) => problems.push({ kind, fix: FIXES[kind], subject: null, lesson: null, ...fields });
  const signals = {
    budget: budgetSignal(knowledge, config.knowledge.budgets, add),
    docs: docsSignal(rows, sinceMs, knowledge, limits, add),
    agents: agentsSignal(rows, sinceMs, limits, add),
    reviews: reviewsSignal(reviews, limits, add),
    denies: deniesSignal(rows, sinceMs, limits, config.telemetry.hookDenies, add),
    cost: costSignal(rows, sinceMs, limits, add),
    lessons: lessonsSignal(lessons, sinceMs, now, config.lessons, add),
  };
  return { problems, signals };
}

// Sets each problem's `resolved` and `since_resolution`, both null unless a resolved lesson holds its lesson key.
// `resolved` is that lesson's { id, at, outcome }. `since_resolution` is { n, status }: the same problem judged on the
// rows dated after the resolution alone, so that capturing it reopens the fix only on evidence the fix could have
// changed, never on the failures that led to it. A resolution before the window predates every row, so the problem
// stands as judged; the reviews cannot be split by time, so after a resolution inside the window they are `unavailable`.
function sinceResolution(problems, input) {
  const lessons = input.lessons ?? [];
  const byId = new Map(lessons.map((lesson) => [lesson.id, lesson]));
  const later = new Map();
  for (const problem of problems) {
    // The first lesson with the key holds it, or the lesson it was merged into.
    let holder = problem.lesson && lessons.find((lesson) => lesson.key === problem.lesson.key);
    for (let hops = 0; holder?.mergedInto && hops < 100; hops += 1) holder = byId.get(holder.mergedInto);
    const last = holder?.status === 'resolved' ? holder.resolutions.at(-1) : null;
    problem.resolved = last ? { id: holder.id, at: last.at, outcome: last.outcome } : null;
    problem.since_resolution = last ? judgedAfter(problem, Date.parse(last.at), input, later) : null;
  }
}

function judgedAfter({ kind, subject, sample }, resolvedMs, input, later) {
  if (!Number.isFinite(resolvedMs)) return { n: null, status: UNAVAILABLE };
  if (resolvedMs < (input.sinceMs ?? 0)) return { n: sample.n, status: PROBLEM };
  // Strictly after, as an occurrence must be to count against a fix.
  if (!later.has(resolvedMs)) later.set(resolvedMs, judge({ ...input, sinceMs: resolvedMs + 1, reviews: null, lessons: [] }));
  const { problems, signals } = later.get(resolvedMs);
  const again = problems.find((item) => item.kind === kind && item.subject === subject);
  if (again) return { n: again.sample.n, status: PROBLEM };
  // Not found again: not enough data or unavailable as the signal says, else judged and within its threshold.
  const signal = signals[SIGNAL_OF[kind]];
  const agent = signal.agents?.find((item) => item.agent_type === subject);
  const part = signal.agents ? (agent?.[kind === 'redispatch' ? 'redispatch' : 'sent_back'] ?? { n: 0, status: NOT_ENOUGH })
    : { n: signal.sample?.n ?? null, status: signal.status };
  return { n: part.n, status: part.status === NOT_ENOUGH || part.status === UNAVAILABLE ? part.status : OK };
}

// The `always` docs against knowledge.budgets.alwaysBytes and each tagged doc against taggedDocBytes, as on disk now.
function budgetSignal({ indexed, always, tags }, { alwaysBytes, taggedDocBytes }, add) {
  const sample = { n: indexed.length, of: 'indexed docs' };
  const oversized = indexed.filter((doc) => tags[doc.path]?.length && doc.bytes > taggedDocBytes).map((doc) => ({ ...doc, tags: tags[doc.path] }));
  const base = { sample, always_bytes: always.bytes, oversized };
  if (!indexed.length && !always.bytes) return { status: NOT_ENOUGH, ...base };
  const over = always.bytes > alwaysBytes;
  if (over) {
    add('always-budget', {
      value: always.bytes, threshold: alwaysBytes, sample,
      summary: `The always docs are ${always.bytes} bytes, over knowledge.budgets.alwaysBytes (${alwaysBytes}); every session and subagent reads them.`,
      lesson: { tier: 'P2', kind: 'improvement', target: 'project', key: 'health:always-budget' },
    });
  }
  for (const doc of oversized) {
    add('tagged-doc', {
      subject: doc.path, value: doc.bytes, threshold: taggedDocBytes, sample,
      summary: `${doc.path} is ${doc.bytes} bytes, over knowledge.budgets.taggedDocBytes (${taggedDocBytes}); ` +
        `every route to ${doc.tags.join(', ')} reads it whole.`,
      lesson: { tier: 'P2', kind: 'improvement', target: 'project', key: `health:tagged-doc:${doc.path}` },
    });
  }
  return { status: over || oversized.length ? PROBLEM : OK, ...base };
}

// The docs with the most bytes read, and the tagged docs nobody read: a route reaches them and no agent opens them.
function docsSignal(rows, sinceMs, { indexed, tags }, { minSample, topDocPercent }, add) {
  const { docs, totals, never_read: neverRead } = summarizeDocs(rows, { sinceMs, indexed });
  const sample = { n: totals.rows, of: 'agent and session rows that recorded doc reads' };
  const top = docs.slice(0, TOP_DOCS).map((doc) => {
    const share = doc.read_bytes === null ? null : percentOf(doc.read_bytes, totals.read_bytes);
    return { path: doc.path, reads: doc.reads, bytes: doc.bytes, read_bytes: doc.read_bytes, percent: share === null ? null : shown(share, topDocPercent) };
  });
  const unread = neverRead.filter((doc) => tags[doc.path]?.length).map((doc) => doc.path);
  const base = { sample, read_bytes: totals.read_bytes, top, never_read: neverRead.length, never_read_tagged: unread };
  if (sample.n < minSample) return { status: NOT_ENOUGH, ...base };
  const first = docs[0];
  const share = first && first.read_bytes !== null ? percentOf(first.read_bytes, totals.read_bytes) : null;
  // One doc read alone takes all the bytes read, which says nothing about its cost.
  const heavy = docs.length > 1 && share !== null && share > topDocPercent;
  if (heavy) {
    add('top-doc', {
      subject: first.path, value: shown(share, topDocPercent), threshold: topDocPercent, sample,
      summary: `${first.path} takes ${shown(share, topDocPercent)}% of the ${kb(totals.read_bytes)} of knowledge docs read, over ${topDocPercent}%: ` +
        `${first.reads} reads of ${kb(first.bytes)}.`,
      lesson: { tier: 'P2', kind: 'improvement', target: 'project', key: `health:top-doc:${first.path}` },
    });
  }
  if (unread.length) {
    add('never-read', {
      value: unread.length, threshold: 0, sample,
      summary: `${plural(unread.length, 'tagged doc')} never read in ${sample.n} rows with doc reads: ${unread.slice(0, NAMED_DOCS).join(', ')}` +
        `${unread.length > NAMED_DOCS ? `, and ${unread.length - NAMED_DOCS} more` : ''}.`,
      lesson: { tier: 'P3', kind: 'improvement', target: 'project', key: 'health:never-read' },
    });
  }
  return { status: heavy || unread.length ? PROBLEM : OK, ...base };
}

// Per agent type: the share of dispatches that repeat a task, over its dispatches, and the share of runs the delivery
// check sent back, over its runs whose stop rows say so. A run that named a missing file before stop rows recorded
// `sent_back` is unknown: it leaves the sample as it leaves the rate, and counts in `unknown`. The shares come from the
// counts, since summarize() rounds its rates.
function agentsSignal(rows, sinceMs, { minSample, redispatchPercent, sentBackPercent }, add) {
  const rate = (n, count, threshold) => {
    const percent = percentOf(count, n);
    const status = n < minSample || percent === null ? NOT_ENOUGH : percent > threshold ? PROBLEM : OK;
    return { n, percent: percent === null ? null : shown(percent, threshold), status };
  };
  const agents = summarize(rows, { sinceMs }).agents.map((agent) => {
    const redispatch = rate(agent.dispatches, agent.redispatched, redispatchPercent);
    const unknown = agent.runs_without_send_back;
    const sentBack = { ...rate(agent.runs - unknown, agent.sent_back, sentBackPercent), unknown };
    const sentBackLesson = labels(deliverySignal({ agentType: agent.agent_type, missing: [] }));
    if (redispatch.status === PROBLEM) {
      add('redispatch', {
        subject: agent.agent_type, value: redispatch.percent, threshold: redispatchPercent, sample: { n: redispatch.n, of: 'dispatches' },
        summary: `${agent.agent_type}: ${redispatch.percent}% of ${redispatch.n} dispatches repeated a task already dispatched in the same session, ` +
          `over ${redispatchPercent}%.`,
        lesson: { tier: 'P2', kind: 'improvement', target: sentBackLesson.target, key: `health:redispatch:${agent.agent_type}` },
      });
    }
    if (sentBack.status === PROBLEM) {
      add('sent-back', {
        subject: agent.agent_type, value: sentBack.percent, threshold: sentBackPercent, sample: { n: sentBack.n, of: 'runs with a known send-back' },
        summary: `${agent.agent_type}: the delivery check sent back ${agent.sent_back} of ${sentBack.n} runs (${sentBack.percent}%), over ${sentBackPercent}%; ` +
          'each named a file it had not written.',
        lesson: sentBackLesson,
      });
    }
    return { agent_type: agent.agent_type, redispatch, sent_back: sentBack };
  });
  return { status: overall(agents.flatMap((agent) => [agent.redispatch.status, agent.sent_back.status])), agents };
}

// The review bot's rounds per reviewed pull request, and its late findings that sat on a line it had already reviewed.
// The average comes from each pull request's rounds, since reviewRounds() rounds its own; the view prints it to the hundredth.
// Why reviews were not read when the caller passed none; any other error is gh's own.
const NOT_READ = 'not read';
// What the text view says for a gh error, which is most often a project with no GitHub remote or a gh that is missing
// or signed out; --json keeps gh's own message.
const GH_UNAVAILABLE = 'gh could not read the pull requests: no GitHub remote, or gh is missing or not signed in (--json has its error)';

function reviewsSignal(reviews, { minSample, reviewRounds, lateFindingPercent }, add) {
  if (!reviews || reviews.error) return { status: UNAVAILABLE, error: reviews?.error ?? NOT_READ };
  const avg = reviews.rounds.length ? sumOf(reviews.rounds, (pr) => pr.rounds) / reviews.rounds.length : null;
  const rounds = { n: reviews.rounds.length, avg, five_or_more: reviews.five_or_more, merged: reviews.merged, truncated: reviews.truncated };
  rounds.status = rounds.n < minSample ? NOT_ENOUGH : avg > reviewRounds ? PROBLEM : OK;
  const share = percentOf(reviews.late_on_seen_line ?? 0, reviews.late_checked ?? 0);
  const late = { n: reviews.late_checked ?? 0, on_seen_line: reviews.late_on_seen_line ?? 0, percent: share === null ? null : shown(share, lateFindingPercent) };
  late.status = late.n < minSample || share === null ? NOT_ENOUGH : share > lateFindingPercent ? PROBLEM : OK;
  if (rounds.status === PROBLEM) {
    add('review-rounds', {
      value: hundredths(avg), threshold: reviewRounds, sample: { n: rounds.n, of: 'reviewed pull requests' },
      summary: `The review bot took ${hundredths(avg)} rounds a pull request on ${rounds.n} reviewed, over ${reviewRounds}; ` +
        `${rounds.five_or_more} needed 5 or more.`,
      lesson: labels(roundLimitSignal({ pr: null, maxRounds: reviewRounds, rounds: null })),
    });
  }
  if (late.status === PROBLEM) {
    add('late-findings', {
      value: late.percent, threshold: lateFindingPercent, sample: { n: late.n, of: 'late findings checked' },
      summary: `${late.on_seen_line} of ${late.n} late findings checked (${late.percent}%) sat on a line the bot had already reviewed, ` +
        `over ${lateFindingPercent}%.`,
      lesson: { tier: 'P2', kind: 'improvement', target: 'project', key: 'health:late-findings' },
    });
  }
  return { status: overall([rounds.status, late.status]), rounds, late };
}

// The plugin's rules that blocked denyHotSpot calls or more, over the sessions the log saw in the window.
function deniesSignal(rows, sinceMs, { minSample, denyHotSpot }, recorded, add) {
  if (!recorded) return { status: UNAVAILABLE, error: 'telemetry.hookDenies is off' };
  const denies = summarizeDenies(rows, { sinceMs });
  const seen = new Set(rows.filter((row) => row.event !== 'rotate' && Date.parse(row.ts) >= sinceMs && row.session_id).map((row) => row.session_id));
  const sample = { n: seen.size, of: 'sessions' };
  const rules = denies.by_rule.map((rule) => ({ rule: rule.rule, count: rule.count, agents: rule.agents, reason: rule.reasons[0]?.[0] ?? null }));
  const base = { sample, count: denies.count, rules };
  if (sample.n < minSample) return { status: NOT_ENOUGH, ...base };
  const hot = rules.filter((rule) => rule.count >= denyHotSpot);
  for (const rule of hot) {
    const agents = rule.agents.map(([agent, count]) => `${agent} ${count}`).join(', ');
    add('deny-hot-spot', {
      subject: rule.rule, value: rule.count, threshold: denyHotSpot, sample,
      summary: `The ${rule.rule} rule blocked ${rule.count} calls in ${sample.n} sessions, ${denyHotSpot} or more: by ${agents}` +
        `${rule.reason ? `; most often: ${rule.reason}` : '.'}`,
      lesson: labels(denialSignal({ rule: rule.rule })),
    });
  }
  return { status: hot.length ? PROBLEM : OK, ...base };
}

// The cost a session of the newer half of the window's sessions against the older half, in the order they ended. The
// averages are compared unrounded: rounded to the cent, $0.014 against $0.016 reads as a 100% rise, and $0.004 as nothing.
function costSignal(rows, sinceMs, { minSample, costRisePercent }, add) {
  const summary = summarizeSessions(rows, { sinceMs });
  const ended = latestRows(rows.filter((row) => row.event === 'session' && Date.parse(row.ts) >= sinceMs), 'session', 'session_id')
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const half = Math.floor(ended.length / 2);
  const average = (list) => (list.length ? sumOf(list, (row) => row.cost_usd) / list.length : null);
  const older = average(ended.slice(0, half));
  const newer = average(ended.slice(half));
  const top = summary.top[0] ?? null;
  const base = {
    sample: { n: ended.length, of: 'sessions' }, cost_usd: summary.cost_usd, main_cost_usd: summary.main.cost_usd,
    subagents_cost_usd: summary.subagents.cost_usd, older: { n: half, avg_usd: older }, newer: { n: ended.length - half, avg_usd: newer },
    change_percent: null, top: top && { session_id: top.session_id, ts: top.ts, cost_usd: top.cost_usd },
  };
  if (half < minSample || !older) return { status: NOT_ENOUGH, ...base };
  const change = percentOf(newer - older, older);
  base.change_percent = shown(change, costRisePercent);
  if (change <= costRisePercent) return { status: OK, ...base };
  add('cost-rise', {
    value: base.change_percent, threshold: costRisePercent, sample: base.sample,
    summary: `The newer ${plural(base.newer.n, 'session')} cost ${money(newer)} a session against ${money(older)} for the older ${half}, ` +
      `up ${base.change_percent}%, over ${costRisePercent}%; the most costly was ${top.session_id} at ${money(top.cost_usd)}.`,
    lesson: { tier: 'P2', kind: 'improvement', target: null, key: 'health:cost-rise' },
  });
  return { status: PROBLEM, ...base };
}

// The lesson inbox: P1 lessons, the backlog against lessons.maxOpen and lessons.maxAgeDays, and fixes since `sinceMs`
// that recurred. These are counts, not rates, so no minimum sample applies; each is already a lesson.
function lessonsSignal(lessons, sinceMs, now, { maxOpen, maxAgeDays }, add) {
  const { open, fixes } = lessonStats(lessons, { sinceMs, now });
  const recurred = fixes.filter((fix) => fix.recurred);
  const sample = { n: open.count, of: 'open lessons' };
  const base = { sample, p1: open.tiers.P1, tiers: open.tiers, oldest_days: open.oldest_days, fixes: fixes.length, recurred: recurred.map((fix) => fix.id) };
  if (open.tiers.P1) {
    add('p1-lesson', { value: open.tiers.P1, threshold: 0, sample, summary: `${plural(open.tiers.P1, 'P1 lesson')} open: each blocked or lost work.` });
  }
  if (recurred.length) {
    add('fix-recurred', {
      value: recurred.length, threshold: 0, sample: { n: fixes.length, of: 'fixes in the window' },
      summary: `${recurred.length} of ${plural(fixes.length, 'fix', 'fixes')} in the window recurred, so the problem came back: ` +
        `${recurred.map((fix) => fix.id).join(', ')}.`,
    });
  }
  // Each reason as [value, threshold, words]; the problem carries the first one's numbers.
  const reasons = [];
  if (maxOpen && open.count > maxOpen) reasons.push([open.count, maxOpen, `${open.count} open, over lessons.maxOpen (${maxOpen})`]);
  if (maxAgeDays && open.oldest_days > maxAgeDays) {
    reasons.push([open.oldest_days, maxAgeDays, `the oldest is ${open.oldest_days} days old, over lessons.maxAgeDays (${maxAgeDays})`]);
  }
  if (reasons.length) {
    const [[value, threshold]] = reasons;
    add('lesson-backlog', { value, threshold, sample, summary: `The lesson inbox needs triage: ${reasons.map((reason) => reason[2]).join('; ')}.` });
  }
  return { status: open.tiers.P1 || recurred.length || reasons.length ? PROBLEM : OK, ...base };
}

const kb = (bytes) => (bytes === null ? '?' : `${(bytes / 1024).toFixed(1)} KB`);
// To the cent, or to two significant digits under ten cents, so that a cheap session never reads as $0.00.
const money = (usd) => `$${usd > 0 && usd < 0.1 ? Number(usd.toPrecision(2)) : usd.toFixed(2)}`;
const hundredths = (value) => Math.round(value * 100) / 100;
const plural = (count, word, words = `${word}s`) => `${count} ${count === 1 ? word : words}`;
const LABELS = { [OK]: 'ok', [PROBLEM]: 'problem', [NOT_ENOUGH]: 'not enough data', [UNAVAILABLE]: 'unavailable' };
// "n=3 of 5": a sample below the minimum names both.
const n = (count, minSample) => (count < minSample ? `n=${count}, needs ${minSample}` : `n=${count}`);

export function formatHealth({ thresholds, problems, signals }, { file, since, skipped, notes = [] }) {
  const { minSample } = thresholds.health;
  const lines = [`Harness health, from ${file}, since ${since}${skipped ? ` (${skipped} unreadable rows skipped)` : ''}`, ...notes];
  if (problems.length) {
    lines.push(`Problems, worst first: ${problems.length}`, ...problems.map((item, index) => `  ${index + 1}. ${item.summary} Fix: ${item.fix}.`));
  } else {
    lines.push('Problems: none at these thresholds.');
  }
  lines.push(`Signals; n is the sample, and a signal under ${minSample} (telemetry.health.minSample) is not judged:`);
  const { budget, docs, agents, reviews, denies, cost, lessons } = signals;
  const head = (name, signal) => `  ${name}: ${LABELS[signal.status]}`;
  lines.push(`${head('Knowledge budget', budget)}; always docs ${budget.always_bytes} of ${thresholds.budgets.alwaysBytes} bytes, ` +
    `${budget.oversized.length} of ${budget.sample.n} indexed docs tagged and over ${thresholds.budgets.taggedDocBytes} bytes`);
  const topDocs = docs.top.map((doc) => `${doc.path} ${doc.percent === null ? '?' : `${doc.percent}%`}`).join(', ');
  lines.push(`${head('Doc reads', docs)} (${n(docs.sample.n, minSample)} rows); ` +
    `${topDocs ? `most bytes read: ${topDocs} of ${kb(docs.read_bytes)} (over ${thresholds.health.topDocPercent}% is a problem); ` : ''}` +
    `${docs.never_read} indexed docs never read, ${docs.never_read_tagged.length} of them tagged`);
  const agentLines = agents.agents.map((agent) => {
    const part = (label, judged) => {
      const sample = `${n(judged.n, minSample)}${judged.unknown ? `, ${judged.unknown} unknown` : ''}`;
      return judged.status === NOT_ENOUGH ? `${label} not enough data (${sample})` : `${judged.percent}% ${label} (${sample})`;
    };
    return `    ${agent.agent_type}: ${part('re-dispatched', agent.redispatch)}, ${part('sent back', agent.sent_back)}`;
  });
  lines.push(`${head('Agents', agents)}${agents.agents.length ? '' : '; no dispatches'} ` +
    `(thresholds: ${thresholds.health.redispatchPercent}% re-dispatched, ${thresholds.health.sentBackPercent}% sent back)`.trimEnd(), ...agentLines);
  if (reviews.status === UNAVAILABLE) lines.push(`${head('Reviews', reviews)}; ${reviews.error === NOT_READ ? NOT_READ : GH_UNAVAILABLE}`);
  else {
    const rounds = reviews.rounds.status === NOT_ENOUGH ? `rounds not enough data (${n(reviews.rounds.n, minSample)} reviewed)`
      : `${hundredths(reviews.rounds.avg)} rounds a pull request (n=${reviews.rounds.n} reviewed, threshold ${thresholds.health.reviewRounds})`;
    const late = reviews.late.status === NOT_ENOUGH ? `late findings not enough data (${n(reviews.late.n, minSample)} checked)`
      : `${reviews.late.percent}% of late findings on a line already reviewed (n=${reviews.late.n}, threshold ${thresholds.health.lateFindingPercent}%)`;
    lines.push(`${head('Reviews', reviews)}; ${rounds}; ${late}${reviews.rounds.truncated ? `; only the last ${reviews.rounds.merged} merged, the --prs limit` : ''}`);
  }
  if (denies.status === UNAVAILABLE) lines.push(`${head('Hook denies', denies)}; ${denies.error}`);
  else {
    const rules = denies.rules.map((rule) => `${rule.rule} ${rule.count}`).join(', ');
    lines.push(`${head('Hook denies', denies)} (${n(denies.sample.n, minSample)} sessions); ${denies.count} blocks${rules ? `: ${rules}` : ''} ` +
      `(${thresholds.health.denyHotSpot} or more by one rule is a hot spot)`);
  }
  const trend = cost.change_percent === null ? '' : `; ${money(cost.newer.avg_usd)} a session in the newer half against ${money(cost.older.avg_usd)}, ` +
    `${cost.change_percent >= 0 ? 'up' : 'down'} ${Math.abs(cost.change_percent)}% (threshold ${thresholds.health.costRisePercent}%)`;
  lines.push(`${head('Session cost', cost)} (${n(cost.older.n, minSample)} sessions a half); ${plural(cost.sample.n, 'session')}, ${money(cost.cost_usd)}${trend}`);
  const oldest = lessons.oldest_days === null ? '' : `, the oldest ${lessons.oldest_days} days`;
  lines.push(`${head('Lessons', lessons)}; ${lessons.sample.n} open, ${lessons.p1} P1${oldest}; ` +
    `${plural(lessons.fixes, 'fix', 'fixes')} in the window, ${lessons.recurred.length} recurred`);
  return lines.join('\n');
}
