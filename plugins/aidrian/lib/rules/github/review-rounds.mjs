// Bash rule: the review-round cap holds for agents. On whenever config.json `github.reviewer` names a review bot.
// It denies:
//   - a command that sets AIDRIAN_ALLOW_EXTRA_ROUNDS, inline (`VAR=1 cmd`), through env, or with export, declare,
//     typeset, local, or readonly, also when `builtin` runs it: the Human sets it in their own shell, and an agent only
//     on the Human's word, below;
//   - a direct request for a bot review through gh, in every form the review gate reads (lib/rules/github/review-request.mjs):
//     only `aidrian pr await-review --request` and `aidrian pr review` post one, and they count rounds against
//     `github.maxReviewRounds` first. A direct comment would skip that count, which is how one pull request once took
//     twenty bot reviews.
// The one exception to the first: inline on a literal `aidrian pr review <PR> [--with-bot] --max-rounds <M> [--repo <repo>]`
// or `aidrian pr await-review <PR> --request --max-rounds <M> [--repo <repo>]`, with `<repo>` the repository the command
// acts on (review-signoff.mjs approvalTarget): its `--repo`, which must be one of this checkout's remotes, else the one
// repository its remotes name. When this session's transcript holds either of the Human's words:
//   - an answer to an AskUserQuestion naming `<repo>#<PR>` and `--max-rounds <M>`, whose chosen option starts with
//     "Approve" (checked first);
//   - a prompt the Human typed (review-extend.mjs transcriptTyped: a prompt sent as sdk, as by a script or the desktop
//     app, an accepted suggestion, a slash command, a paste the host tagged, and every agent, peer, or tool text do not
//     count) that is, whole, `grant up to <N> review rounds on <repo>#<PR>`, in any letter case, for every `<M>` up to
//     `<N>`; 0 allows nothing. The whole message, not one line of it: the host leaves a short paste (up to 800
//     characters and 2 line breaks) untagged, so a line quoted inside a message must not count, and a message holding
//     a lone CR or a Unicode line separator or format character is no grant. The latest such message decides. An
//     answer that does not start with "Approve", to a question naming `<repo>#<PR>` and a `--max-rounds`, withdraws it
//     unless both carry a timestamp and the grant's is later; and a grant not earlier than an approving answer bounds
//     that answer by its count. A grant is read only on a host whose transcript the host layer says this rule reads.
//     The grant names `<owner>/<name>#<PR>` and never leans on the session's one open pull request: a hook reads no forge,
//     so it cannot know which are open; a session may work in several checkouts; and the answer names the same, so one
//     rule holds for both.
// Both rest on the transcript, a file in the agent's own account: an agent with a shell could forge either an answer or
// a typed grant there, a residual accepted for both routes.
// In a checkout whose remotes name several repositories, only a raise that ends in `--repo <repo>` gets it: without one,
// the command acts on the forge's default, which a hook does not read.
// Every refusal of the override names one route and the nearest miss, so the first deny leads somewhere: while a check at
// the cap waits for the judge or the Human, its route (review-extend.mjs waitingRoute), which needs no variable; else the
// ask, where an answer or a typed grant can approve it. The miss names, in this order, the checkout, the command's form,
// a chain or prefix, no origin, a transcript it cannot read, then what the typed grant and the answers lack. A deny
// names a typed message's form, never its words. Anything the rule cannot read lets the command run.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../../config.mjs';
import { detectHost } from '../../hosts/index.mjs';
import { ROUNDS_OVERRIDE, TYPED_GRANT_FORM } from '../../pr-await-review.mjs';
import { findProject } from '../../project.mjs';
import { aidrianArgs, assignsVariable, commandLines, lexCommand, readInvocation } from '../../shell-lex.mjs';
import { readLocalState } from '../../review/state.mjs';
import { transcriptAnswers, transcriptTyped, waitingRoute } from '../review-extend.mjs';
import { approvalTarget, callRepo, namesChange, NOTIFY, severalRemotes } from '../review-signoff.mjs';
import { repoName } from '../../remotes.mjs';
import { readRequests } from './review-request.mjs';

// The deny's first sentence, which every refusal of the override starts with; the dispatch log records it.
export const OVERRIDE_REASON =
  `Blocked: ${ROUNDS_OVERRIDE} lets review rounds go past config.json github.maxReviewRounds, and only the Human sets it, on their word.`;

// The ask route, named only where an answer or a typed grant can approve the raise: no check waits at the cap, a
// checkout with an origin, and a transcript the rule reads. `typed` adds the typed grant, for a host whose typed prompts
// the rule reads; `several`, for a checkout whose remotes name several repositories, the `--repo` the raise then ends in.
export function askRoute({ typed = true, several = false } = {}) {
  const repo = several ? ' --repo <owner>/<name>' : '';
  const answer = 'Stop at round_limit, report the findings that keep coming back, and ask the Human with AskUserQuestion ' +
    'whether to continue, naming `<owner>/<name>#<PR>` and `--max-rounds <N>`, with a recommended option that starts with "Approve". ' +
    `${NOTIFY} On that answer run exactly \`${ROUNDS_OVERRIDE}=1 aidrian pr review <PR> --max-rounds <N>${repo}\`, ` +
    `or the same on \`aidrian pr await-review <PR> --request\`${several ? ', from the pull request\'s checkout, where `<owner>/<name>` is the repository the question names, one of this checkout\'s remotes' : ''}.`;
  if (!typed) return answer;
  return `${answer} Or the Human types, as a message of its own, \`${TYPED_GRANT_FORM}\`, which approves that command for every \`--max-rounds\` up to <N>. ` +
    `A later typed \`${TYPED_GRANT_FORM.replace('<N>', '0')}\` withdraws a raise, and a later, lower count bounds an earlier answer.`;
}
export const ASK_ROUTE = askRoute();

export const REQUEST_REASON =
  'Blocked: request a bot review with `aidrian pr await-review --request` (or `aidrian pr review --with-bot`), which counts ' +
  'the rounds against config.json github.maxReviewRounds before it posts. A direct request skips that count.';

export const botNamed = (reviewer) => typeof reviewer === 'string' && reviewer !== '' && reviewer.toLowerCase() !== 'none';

// Whether one invocation sets the override.
export const setsOverride = (invocation) => assignsVariable(invocation, ROUNDS_OVERRIDE);

// The two forms an answer can approve, as written after the variable; `--with-bot` is the review step that also runs the bot.
// Either may name `--repo <owner>/<name>`, the repository it acts on, which a checkout whose remotes name several needs:
// right after the pull request, as the review step prints its rerun, or last. One `--repo` only (approvalTarget).
const REPO = '(?:--repo (\\S+) )?';
const RAISE_FORMS = {
  review: new RegExp(`^${REPO}(?:--with-bot )?--max-rounds (\\d+)(?: --repo (\\S+))?$`, 'u'),
  'await-review': new RegExp(`^${REPO}--request --max-rounds (\\d+)(?: --repo (\\S+))?$`, 'u'),
};

// The pull request number of an `aidrian pr review|await-review <PR>` invocation, or null.
function raisedPr(invocation) {
  const [verb, sub, pr] = (aidrianArgs(invocation) ?? []).map((word) => (word.dynamic ? null : word.text));
  return verb === 'pr' && Object.hasOwn(RAISE_FORMS, sub) && /^\d+$/u.test(pr ?? '') ? pr : null;
}

// The command to hand the Human for the raise `words` asked for, without its cap: the plan's or the bot's count, and the bot
// stage when the review step runs it. Each counts its own rounds, so the other would raise the wrong cap.
function handoverOf(words) {
  const texts = (words ?? []).map((word) => (word.dynamic ? null : word.text));
  const pr = /^\d+$/u.test(texts[2] ?? '') ? texts[2] : '<PR>';
  if (texts[1] === 'await-review') return `aidrian pr await-review ${pr} --request`;
  return texts.includes('--with-bot') ? `aidrian pr review ${pr} --with-bot` : `aidrian pr review ${pr}`;
}

// How the miss opens for a transcript the rule cannot read, by its cause (sessionSaid).
const UNREAD = {
  host: 'This host writes no transcript this rule reads',
  path: 'The hook payload names no session transcript',
  file: 'The session transcript could not be read',
};
// How it ends: the raise `command` for the Human's own shell.
const shellOf = (command) => `hand the Human \`${ROUNDS_OVERRIDE}=1 ${command}\` to run in their own shell (\`!\` in the prompt, or another terminal).`;

// Why the override on `invocation` is not a raise the Human approved, or null when it is. `said` is sessionSaid's
// { answers, typed, unread }, and `target` review-signoff.mjs approvalTarget for the command. The checkout comes first,
// then the command's form, then the transcript, so the first deny names the one thing to change.
export function raiseMiss(invocation, said, target) {
  const words = aidrianArgs(invocation);
  const texts = words && !words.some((word) => word.dynamic) ? words.map((word) => word.text) : [];
  const [verb, sub, pr] = texts;
  if (target.miss === 'remotes') {
    return `This checkout's remotes name more than one repository (${target.remotes.join(', ')}), so an answer or a typed grant lets an agent set ${ROUNDS_OVERRIDE} ` +
      `only on a raise that ends in \`--repo <owner>/<name>\`, the one the question or grant names: \`${ROUNDS_OVERRIDE}=1 ${handoverOf(words)} --max-rounds <N> --repo <owner>/<name>\`, as one plain command. ` +
      `Or hand the Human \`${ROUNDS_OVERRIDE}=1 ${handoverOf(words)} --max-rounds <N>\` to run in their own shell (\`!\` in the prompt, or another terminal).`;
  }
  const form = verb === 'pr' && Object.hasOwn(RAISE_FORMS, sub) && /^\d+$/u.test(pr ?? '') ? RAISE_FORMS[sub].exec(texts.slice(3).join(' ')) : null;
  const max = form?.[2];
  const formRepo = form?.[1] ?? form?.[3];
  if (!max) {
    return `An answer or a typed grant approves only \`${ROUNDS_OVERRIDE}=1 aidrian pr review <PR> --max-rounds <N>\`, with \`--with-bot\` before \`--max-rounds\` when the step runs the bot, ` +
      `or \`${ROUNDS_OVERRIDE}=1 aidrian pr await-review <PR> --request --max-rounds <N>\`, either with one \`--repo <owner>/<name>\` right after \`<PR>\` or last when it names its repository, every word written out, with no variable or other flag.`;
  }
  if (target.miss === 'plain') return 'An approved raise runs only as one plain command, with no `cd`, `env -C`, chain, or other prefix: run it from the pull request\'s checkout.';
  if (target.miss === 'repo' || (formRepo !== undefined && repoName(formRepo) !== target.repo)) {
    return `The raise's \`--repo\` must name, written out as \`<owner>/<name>\`, one of the repositories this checkout's remotes name (${(target.remotes ?? []).join(', ') || 'none'}): ` +
      'an answer or a typed grant counts only on the repository the command acts on.';
  }
  if (target.miss === 'origin') return 'This checkout has no origin, so no answer or typed grant can name its repository: the Human runs the command in their own shell.';
  if (said.unread) return `${UNREAD[said.unread]}, so no answer or typed grant counts here: ${shellOf(`${handoverOf(words)} --max-rounds ${max}`)}`;
  const named = `${target.repo}#${pr}`;
  const grant = latestGrant(said.typed, named);
  const asked = answerRoute(said.answers, target.repo, pr, max);
  if (asked.approved) return boundMiss(grant, asked.approved, named, max);
  const typed = typedMiss(said, grant, named, max);
  if (typed === null) return null;
  return [typed, asked.miss].filter(Boolean).join(' ');
}

// The answer in `answers` that approves `--max-rounds <max>` on `<repo>#<pr>`, as { approved }, or why none does, as { miss }.
function answerRoute(answers, repo, pr, max) {
  if (!answers.length) return { miss: 'The transcript holds no AskUserQuestion answer.' };
  const named = `${repo}#${pr}`;
  const onPr = answers.filter(({ question }) => namesChange(question, repo, pr));
  if (!onPr.length) return { miss: `No answered question names \`${named}\`.` };
  const onMax = onPr.filter(({ question }) => new RegExp(`--max-rounds ${max}(?!\\d)`, 'u').test(question));
  if (!onMax.length) return { miss: `The questions naming \`${named}\` do not name \`--max-rounds ${max}\`.` };
  const last = onMax.at(-1);
  if (approves(last.answer)) return { approved: last };
  const replaced = onMax.slice(0, -1).some((each) => approves(each.answer)) ? ' That later answer replaced an earlier approval of the same question.' : '';
  return { miss: `The Human picked "${last.answer}", not the option that starts with "Approve".${replaced}` };
}

// Whether timestamp `a` is readably earlier than `b`. A missing or unparseable one is never earlier.
const earlier = (a, b) => a !== null && b !== null && Date.parse(a) < Date.parse(b);

// Why a typed grant not earlier than the approving answer `approved` keeps `--max-rounds <max>` from running, or null.
function boundMiss(grant, approved, named, max) {
  if (!grant || earlier(grant.at, approved.at) || Number(max) <= grant.count) return null;
  if (grant.count === 0) return `The Human's typed \`${TYPED_GRANT_FORM.replace('<N>', '0').replace('<owner>/<name>#<PR>', named)}\`, not earlier than the approving answer, withdrew it.`;
  return `The Human's typed grant on \`${named}\`, not earlier than the approving answer, allows \`--max-rounds\` up to ${grant.count}, not ${max}.`;
}

const approves = (answer) => /^\s*approve\b/iu.test(answer);

// A typed grant: the whole message `grant up to <N> review rounds on <target>` (this file's header). One trailing CRLF
// may end it; any other CR, a Unicode line or paragraph separator, or a format character makes it none.
const GRANT = /^grant up to (\d{1,4}) review rounds? on (\S+?)\.?$/iu;
const SEPARATORS = /[\r\v\f\u0085\p{Zl}\p{Zp}\p{Cf}]/u;
function grantOf(text) {
  const body = text.replace(/\r\n$/u, '');
  const [, count, on] = SEPARATORS.test(body) ? [] : GRANT.exec(body.trim()) ?? [];
  return count === undefined ? null : { count: Number(count), on: on.toLowerCase() };
}

// The latest grant the Human typed on `named` (`<repo>#<PR>`): { count, at }, or null.
function latestGrant(typed, named) {
  const key = named.toLowerCase();
  const entry = typed.filter((each) => each.typed && grantOf(each.text)?.on === key).at(-1);
  return entry ? { count: grantOf(entry.text).count, at: entry.at } : null;
}

// A loose match that only picks a hint, never a grant.
const readsLikeGrant = (text) => /\b(?:grant|allow|approv)\w*/iu.test(text) && /\b\d+\b/u.test(text) && /\b(?:rounds?|reviews?)\b/iu.test(text);

// The latest answer that withdraws a typed grant given at `at`: not an approval, to a question naming `<repo>#<pr>` and
// a `--max-rounds`, and not strictly earlier than the grant by readable timestamps. Null when none does.
function withdrawal(answers, named, at) {
  const [repo, pr] = named.split('#');
  return answers.filter((each) => namesChange(each.question, repo, pr) && /--max-rounds \d/u.test(each.question) && !approves(each.answer) && !earlier(each.at, at)).at(-1) ?? null;
}

// Why the Human's typed prompts in `said` hold no grant of `--max-rounds <max>` on `named`, given `grant`, its latest
// (latestGrant): null when they do, a sentence, or '' when no typed message bears on it. It never quotes the Human's words.
function typedMiss({ answers, typed, typedRead }, grant, named, max) {
  if (!typedRead) return 'This host is not one whose typed prompts the rule reads, so a typed grant does not count here; the answer route does.';
  if (grant) {
    const denial = withdrawal(answers, named, grant.at);
    if (denial) return `The Human's typed grant on \`${named}\` was withdrawn by a later answer, "${denial.answer}", to a question about its \`--max-rounds\`.`;
    return Number(max) <= grant.count ? null : `The Human's typed grant on \`${named}\` allows \`--max-rounds\` up to ${grant.count}, not ${max}.`;
  }
  const key = named.toLowerCase();
  const own = typed.filter((entry) => entry.typed);
  const guidance = `The Human types, as a message of its own: \`${TYPED_GRANT_FORM.replace('<owner>/<name>#<PR>', named)}\`.`;
  if (own.some(({ text }) => grantOf(text))) return `A typed grant in this session names another pull request, or no repository, not \`${named}\`. ${guidance}`;
  if (typed.some((entry) => !entry.typed && grantOf(entry.text)?.on === key)) {
    return `A grant on \`${named}\` reached this session by another route than the Human typing it at the prompt (a script, a client that sends prompts as sdk, ` +
      'such as the desktop app, an accepted suggestion, or a slash command), so it does not count.';
  }
  return own.some(({ text }) => readsLikeGrant(text)) ? `A typed message of the Human reads like a grant of review rounds, but not in the form this rule reads. ${guidance}` : '';
}

// What this session said, for the override: { answers, typed, typedRead, unread }. `unread` names why the rule reads no
// transcript, or is null: `host`, a host whose transcript it does not read; `path`, a payload naming none; `file`, a
// file it cannot read. An empty file is read, and holds nothing. Typed prompts are read only on a host that says it
// writes a transcript this rule reads, never on an unknown one (`typedRead`); the answers, as before, wherever a
// transcript is read.
function sessionSaid(env, input) {
  const none = { answers: [], typed: [], typedRead: false };
  const { transcripts } = detectHost({ env, input }).capabilities;
  if (transcripts === false) return { ...none, unread: 'host' };
  const file = input?.transcript_path;
  if (typeof file !== 'string' || file === '') return { ...none, unread: 'path' };
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { ...none, unread: 'file' };
  }
  const typedRead = transcripts === true;
  return { answers: transcriptAnswers(text), typed: typedRead ? transcriptTyped(text) : [], typedRead, unread: null };
}

// The route a check waiting at the cap of the raise's pull request offers, from this machine's review record of the
// repository the raise acts on (review-signoff.mjs callRepo), or null. Where that repository cannot be named, a raise with
// no `--repo` in a checkout whose remotes name several, or one no remote names, no record is read: another repository's
// check of the same number names no route here.
function pendingRoute(project, invocation) {
  const pr = raisedPr(invocation);
  if (!pr) return null;
  try {
    const target = callRepo(project, aidrianArgs(invocation));
    if (target.miss === 'remotes' || target.miss === 'repo') return null;
    const repoArg = target.repo && severalRemotes(project) ? ` --repo ${target.repo}` : '';
    return waitingRoute(pr, readLocalState(project, Number(pr), target.repo ?? undefined)?.extensions?.at(-1), repoArg);
  } catch {
    return null;
  }
}

// The deny reason for `command`, or null.
export function check(command, { cwd = process.cwd(), env = process.env, input = {} } = {}) {
  const project = findProject(cwd);
  if (!project) return null;
  const { config } = loadConfig(project);
  if (!botNamed(config.github.reviewer)) return null;
  const read = (file) => readFileSync(path.resolve(cwd, file), 'utf8');
  let said = null;
  for (const line of commandLines(command)) {
    for (const segment of lexCommand(line)) {
      const invocation = readInvocation(segment);
      if (setsOverride(invocation)) {
        said ??= sessionSaid(env, input);
        const target = approvalTarget(project, command, cwd, `${ROUNDS_OVERRIDE}=1\\s+`);
        const miss = raiseMiss(invocation, said, target);
        const asks = said.unread === null && target.miss !== 'origin';
        const ask = askRoute({ typed: said.typedRead, several: severalRemotes(project) });
        const route = pendingRoute(project, invocation) ?? (asks ? ask : null);
        if (miss) return [OVERRIDE_REASON, route, miss].filter(Boolean).join(' ');
      }
      if (readRequests(invocation, config.github.reviewer, read, env).length > 0) return REQUEST_REASON;
    }
  }
  return null;
}
