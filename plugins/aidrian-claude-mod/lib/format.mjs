// What the Claude mod draws from an `aidrian session snapshot` object: the band's segments, the pane's rows, the
// ticket, the alerts, and the notice for a snapshot it could not read. Every part is `{ text, color }`, the color a
// name the mod's Text takes (COLORS), so no part holds an escape sequence. Every string drawn passes displayText here,
// though the snapshot already applied it, and a number is drawn only when it is a finite number (a count, a safe
// integer). The words match `aidrian session snapshot --line` (docs/handoff.md#the-snapshot).
// A mod module has no Node: this file imports nothing.

// The characters no display text keeps: every character of the Unicode categories Cc, Cf, Zl, Zp, and Cs. The aidrian
// plugin's own pattern is HIDDEN in its lib/hidden-text.mjs; a mod cannot import across plugins, so this is its copy, and
// test/claude-mod-format.test.mjs runs this displayText and the snapshot's over the same inputs.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu;

// The longest text displayText keeps, in code points: a title, a name (a branch, an owner, a repository, a slug, or a
// ticket key), and a path or URL. The snapshot's DISPLAY_CAPS.
export const DISPLAY_CAPS = Object.freeze({ title: 200, name: 100, path: 1024 });

// `text` without a hidden character, cut at `cap` code points.
export const displayText = (text, cap = DISPLAY_CAPS.name) => [...String(text).replace(HIDDEN, '')].slice(0, cap).join('');

// The color of each kind of part: a theme key, which follows a light or a dark theme, but for `cyan`, a raw color name
// the engine's Color admits, as the source mod drew it.
export const COLORS = Object.freeze({
  quiet: 'subtle', offer: 'warning', due: 'claude', reminded: 'claude', ceiling: 'error', armed: 'cyan',
  text: 'text', muted: 'subtle', passed: 'success', failed: 'error', pending: 'warning', merged: 'merged',
});

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const textOf = (value, cap) => (typeof value === 'string' ? displayText(value, cap) : '');
const part = (text, color = COLORS.text) => ({ text, color });
const SEPARATOR = ' · ';

// The forge table: the words and the link pattern of a change on each forge, keyed by the snapshot row's `forge`, the
// adapter's id. It is the mod's only naming of a forge. A row whose forge has no entry is a `change`, with no link.
const GITHUB_PULL = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})\/pull\/([1-9][0-9]{0,9})$/u;
export const FORGES = Object.freeze({
  github: Object.freeze({
    change: 'pull request', one: 'PR', many: 'PRs',
    // https://github.com/<owner>/<name>/pull/<n>, for the row's own repository and number on github.com.
    isLink: (row) => {
      const found = typeof row.url === 'string' ? GITHUB_PULL.exec(row.url) : null;
      if (found === null || row.host !== 'github.com' || ['.', '..'].includes(found[2])) return false;
      return `${found[1]}/${found[2]}`.toLowerCase() === String(row.repo).toLowerCase() && Number(found[3]) === row.number;
    },
  }),
});
const NO_FORGE = Object.freeze({ change: 'change', one: 'change', many: 'changes', isLink: () => false });
const forgeOf = (row) => (typeof row.forge === 'string' && Object.hasOwn(FORGES, row.forge) ? FORGES[row.forge] : NO_FORGE);

// What each handoff level shows, as the snapshot's line words it: the ratio, then the handoff's state.
const LEVEL_WORDS = Object.freeze({
  quiet: (ratio) => ratio,
  offer: (ratio, pays) => (pays ? `${ratio} · handoff ${pays}` : ratio),
  due: (ratio, pays) => `${ratio} · handoff due${pays ? `, ${pays}` : ''}`,
  reminded: (ratio, pays) => LEVEL_WORDS.due(ratio, pays),
  ceiling: () => 'handoff now',
});

// The handoff segment, once the session made a model call: the level's words in its color, and an armed continuation's
// `armed <chain>/<maxChain>` in cyan after them. Nothing for a level it does not know.
export function handoffParts(handoff) {
  if (!isObject(handoff) || !isNumber(handoff.ratio) || handoff.ratio <= 0) return [];
  const { level } = handoff;
  if (typeof level !== 'string' || !Object.hasOwn(LEVEL_WORDS, level)) return [];
  const pays = isNumber(handoff.breakEven) ? `pays back in ~${Math.round(handoff.breakEven)} calls` : '';
  const parts = [part(LEVEL_WORDS[level](`${handoff.ratio.toFixed(1)}x`, pays), COLORS[level])];
  if (handoff.continueArmed === true && isCount(handoff.chain)) parts.push(part(SEPARATOR, COLORS.muted), part(armedWords(handoff), COLORS.armed));
  return parts;
}

// `armed <chain>/<maxChain>` only when the chain is within its limit, else the chain alone, `armed <chain>`, as for a
// maxChain of "unlimited". A defensive rule: the snapshot reads an armed chain through the aidrian plugin's isArmed,
// which holds it at or below maxChain, so the band never draws a fraction above one even if a later snapshot did not.
function armedWords({ chain, maxChain }) {
  const within = isCount(maxChain) && chain <= maxChain;
  return within ? `armed ${chain}/${maxChain}` : `armed ${chain}`;
}

// Where a change's checks stand: failed when one failed, pending when one is pending and none failed, passed when all
// passed or were skipped, and null with no check, or with counts that are not counts.
function checksState(checks) {
  if (!isObject(checks) || !['passed', 'failed', 'pending', 'skipped'].every((name) => isCount(checks[name]))) return null;
  if (checks.failed > 0) return 'failed';
  if (checks.pending > 0) return 'pending';
  return checks.passed + checks.skipped > 0 ? 'passed' : null;
}

const changeRowsOf = (prs) => (Array.isArray(prs) ? prs.filter(isObject) : []);

// The summary's words: the forge's when every row has that one forge, a change's otherwise.
function summaryWords(rows) {
  const forges = new Set(rows.map(forgeOf));
  return forges.size === 1 ? [...forges][0] : NO_FORGE;
}

// How many change numbers the summary lists before it counts the rest as `+N`.
export const LISTED_CHANGES = 5;

// The most characters, by code point, a summary holds. Its one `⏳` is two columns wide, so 58 characters fit the 61
// columns a 64-column band leaves its changes row. A constant, never the terminal's width, so the band and the line
// print the same words. The snapshot's SUMMARY_BUDGET.
export const SUMMARY_BUDGET = 58;

// The label rule of the snapshot's line, in its lib/session-prs.mjs, written again here, since a mod cannot import
// across plugins: a row has a number when it is a safe integer above 0, and its repository is its host and its path in
// lower case. test/claude-mod-format.test.mjs holds the band's words equal to the line's.
// Lower case matches GitHub's case-insensitive paths; on a forge with case-sensitive paths, two repositories that
// differ only in case share one letter, an accepted residual of pull request #426.
const hasNumber = (row) => Number.isSafeInteger(row.number) && row.number > 0;
const repositoryOf = (row) => `${row.host}/${String(row.repo).toLowerCase()}`;

// The letters of a repository's place in the sorted list: 0 is `a`, 25 `z`, 26 `aa`, 701 `zz`, 702 `aaa`.
function lettersOf(index) {
  let letters = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(97 + ((n - 1) % 26)) + letters;
  return letters;
}

// Each row's label, null for a row with no number. When the numbered rows come from more than one repository, each
// number carries its repository's letter, `a#42`: `a` is the first of their repositories sorted by UTF-16 code unit, so
// a letter changes only when the set of repositories does, never with the rows' order. One repository: bare `#42`.
// A label holds no repository text, so no cut can make two repositories read the same.
function changeLabels(rows) {
  const repositories = [...new Set(rows.filter(hasNumber).map(repositoryOf))].sort();
  const letters = new Map(repositories.length > 1 ? repositories.map((key, index) => [key, lettersOf(index)]) : []);
  return rows.map((row) => (hasNumber(row) ? `${letters.get(repositoryOf(row)) ?? ''}#${row.number}` : null));
}

// How many of `count` labels the summary lists: the most whose text, `textAt(k)`, keeps within SUMMARY_BUDGET, or 0.
// A summary never cuts a label; it lists fewer and counts the rest in `+N`.
function listedCount(count, textAt) {
  let listed = count;
  while (listed > 0 && [...textAt(listed)].length > SUMMARY_BUDGET) listed -= 1;
  return listed;
}

// The changes summary, `PRs ✓2 ✗0 ⏳1 · #12, #34, +1`: the noun, the counts of changes, not checks (a change with no
// check counts in none), then the labels of the first LISTED_CHANGES numbered rows (changeLabels), each in the color of
// its checks, as many as SUMMARY_BUDGET holds, and `+N` for the rest and any row with no number. The counts come first
// so a narrow terminal cuts numbers, never a failure. With no number to list, `3 PRs · ✓2 ✗0 ⏳1`.
export function changesParts(prs) {
  const rows = changeRowsOf(prs);
  if (rows.length === 0) return [];
  const words = summaryWords(rows);
  const states = rows.map((row) => checksState(row.checks));
  const count = (state) => states.filter((each) => each === state).length;
  const labels = changeLabels(rows).map((label, index) => ({ label, state: states[index] })).filter(({ label }) => label !== null).slice(0, LISTED_CHANGES);
  const noun = rows.length === 1 ? words.one : words.many;
  const counts = [
    part(`✓${count('passed')}`, COLORS.passed), part(' '),
    part(`✗${count('failed')}`, COLORS.failed), part(' '),
    part(`⏳${count('pending')}`, COLORS.pending),
  ];
  const partsAt = (listed) => [
    part(`${noun} `), ...counts, part(SEPARATOR),
    ...labels.slice(0, listed).flatMap(({ label, state }, index) => [...(index ? [part(', ')] : []), part(label, state === null ? COLORS.text : COLORS[state])]),
    ...(rows.length > listed ? [part(`, +${rows.length - listed}`)] : []),
  ];
  const listed = listedCount(labels.length, (each) => partsAt(each).map(({ text }) => text).join(''));
  return listed === 0 ? [part(`${rows.length} ${noun}${SEPARATOR}`), ...counts] : partsAt(listed);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The harness row: the P1 lessons, the provisional decisions, the merged worktrees not cleaned, and the untriaged audit
// findings, each only above zero.
export function harnessParts({ lessons, decisions, worktrees, audits }) {
  const shown = [
    [lessons?.byTier?.P1, (n) => `📥 ${n} P1`, COLORS.pending],
    [decisions?.provisional, (n) => `⚖️ ${plural(n, 'decision')}`, COLORS.text],
    [worktrees?.mergedNotCleaned, (n) => `🧹 ${plural(n, 'worktree')}`, COLORS.text],
    [audits?.untriaged, (n) => `🔎 ${plural(n, 'finding')}`, COLORS.text],
  ].filter(([n]) => isCount(n) && n > 0);
  return shown.flatMap(([n, words, color], index) => [...(index ? [part(SEPARATOR, COLORS.muted)] : []), part(words(n), color)]);
}

// The band's segments, in the line's order, each `{ id, parts }`, only those that hold something.
export function bandSegments(snapshot) {
  const snap = isObject(snapshot) ? snapshot : {};
  return [
    { id: 'handoff', parts: handoffParts(snap.handoff) },
    { id: 'changes', parts: changesParts(snap.prs) },
    { id: 'harness', parts: harnessParts(snap) },
  ].filter((segment) => segment.parts.length > 0);
}

// The band as one line of plain text, its segments joined by ` · `.
export const plainText = (segments) => segments.map((segment) => segment.parts.map((each) => each.text).join('')).join(SEPARATOR);

const STATE_COLORS = Object.freeze({ open: COLORS.passed, closed: COLORS.muted, merged: COLORS.merged });
const REVIEW_WORDS = Object.freeze({
  approved: part('approved', COLORS.passed),
  changes_requested: part('changes requested', COLORS.failed),
  review_required: part('review required', COLORS.pending),
});
const CHECK_MARKS = Object.freeze([['passed', '✓'], ['failed', '✗'], ['pending', '⏳']]);

// A change's state, review, threads, and checks, each only when the row holds one of the values the snapshot lists.
function changeStatus(row) {
  const parts = [];
  if (typeof row.state === 'string' && Object.hasOwn(STATE_COLORS, row.state)) {
    const draft = row.state === 'open' && row.isDraft === true;
    const state = draft ? part('draft', COLORS.muted) : part(row.state, STATE_COLORS[row.state]);
    parts.push(state);
  }
  if (row.mergeable === false) parts.push(part('conflicts', COLORS.failed));
  if (typeof row.reviewDecision === 'string' && Object.hasOwn(REVIEW_WORDS, row.reviewDecision)) parts.push(REVIEW_WORDS[row.reviewDecision]);
  if (isCount(row.unresolvedThreads) && row.unresolvedThreads > 0) parts.push(part(`💬 ${row.unresolvedThreads}`, COLORS.pending));
  const checks = isObject(row.checks) ? row.checks : {};
  parts.push(...CHECK_MARKS.filter(([name]) => isCount(checks[name])).map(([name, mark]) => part(`${mark}${checks[name]}`, COLORS[name])));
  if (row.stale === true) parts.push(part('stale', COLORS.muted));
  if (row.unsupported === true) parts.push(part('unsupported', COLORS.muted));
  return parts;
}

// The pane's rows, one a change: `{ parts, link }`, the link the row's url only when it matches its forge's pattern
// for the row, else null, and the url then shows nowhere. The first part is the forge's word and the row's label as
// the band lists it, `PR a#42`, and the second its repository, so each letter shows beside the repository it names.
export function changeRows(prs) {
  const rows = changeRowsOf(prs);
  const labels = changeLabels(rows);
  return rows.map((row, index) => {
    const forge = forgeOf(row);
    const label = labels[index] === null ? '' : ` ${labels[index]}`;
    const where = [textOf(row.host, DISPLAY_CAPS.name), textOf(row.repo, DISPLAY_CAPS.path)].filter(Boolean).join('/');
    const title = textOf(row.title, DISPLAY_CAPS.title);
    const parts = [part(`${forge.one}${label}`), ...(where ? [part(where, COLORS.muted)] : []), ...(title ? [part(title)] : []), ...changeStatus(row)];
    return { parts, link: forge.isLink(row) ? row.url : null };
  });
}

// https://linear.app/<workspace>/issue/<key>, with an optional slug, for the key looked up.
const LINEAR_ISSUE = /^https:\/\/linear\.app\/[A-Za-z0-9_-]{1,64}\/issue\/([A-Za-z][A-Za-z0-9]{0,15}-[0-9]{1,9})(?:\/[A-Za-z0-9-]{1,200})?$/u;
export const isIssueLink = (url, key) => {
  const found = typeof url === 'string' && typeof key === 'string' ? LINEAR_ISSUE.exec(url) : null;
  return found !== null && found[1].toUpperCase() === key.toUpperCase();
};

// The ticket row: its key, and the title and state of the issue looked up for it, `{ title, url, status }` as the
// tracker answered, or null. The link is the issue's url only when it is that key's issue page. Null with no key.
export function ticketRow(ticket, issue = null) {
  const key = isObject(ticket) ? textOf(ticket.key, DISPLAY_CAPS.name) : '';
  if (key === '') return null;
  const found = isObject(issue) ? issue : {};
  const title = textOf(found.title, DISPLAY_CAPS.title);
  const status = textOf(found.status, DISPLAY_CAPS.name);
  const parts = [part(key), ...(title ? [part(title)] : []), ...(status ? [part(status, COLORS.muted)] : [])];
  return { parts, link: isIssueLink(found.url, ticket.key) ? found.url : null };
}

// An alert's text and title, as $.ui.toast, $.ui.notify, and $.ui.log get them: the one filter on that path.
export const alertText = ({ text = '', title = '' } = {}) => ({ text: textOf(text, DISPLAY_CAPS.title), title: textOf(title, DISPLAY_CAPS.name) });

// What the pane says when the snapshot client's result (lib/snapshot-client.mjs) holds no snapshot; null for `ok`.
// A plugin that is installed is never called missing: `no-node` and `refused` name what stood in the way.
export const NOTICES = Object.freeze({
  missing: 'The aidrian plugin is not installed for this folder: install it to see the handoff verdict, the changes this session touched, and the harness signals.',
  'no-node': "The aidrian plugin is installed, but no node was found in a PATH folder outside this session's folder, the only place the mod runs programs from: install Node, or start Claude Code with Node's folder on PATH.",
  refused: "The aidrian plugin installed for this folder failed the mod's safety checks (its files are missing, a link, or outside Claude Code's plugin cache), so the mod does not run it: reinstall it.",
  failed: 'The aidrian plugin returned no snapshot: update it to the latest release.',
  'timed-out': 'The aidrian snapshot took longer than 10 seconds and was stopped: the band shows the model, limits, and cache until the next try, at the next turn or within a minute.',
  off: "The aidrian plugin is off for this folder: turn it on in Claude Code's plugin settings to see the handoff verdict, the changes this session touched, and the harness signals.",
});
export const noticeOf = (result) => (isObject(result) && Object.hasOwn(NOTICES, result.kind) ? NOTICES[result.kind] : null);
