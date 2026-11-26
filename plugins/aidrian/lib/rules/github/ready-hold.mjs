// Bash rule, and the decision of the GitHub MCP hook on a call that marks a draft ready: no draft is marked ready while its
// product feedback is owed, as `aidrian pr product-feedback status` says (pr-product-feedback.mjs feedbackStatus).
// docs/hooks.md#ready-hold. Marking ready is:
//   - `gh pr ready` with a number, a URL, a branch, or none, `-R`/`--repo` or GH_REPO naming the repository; `--undo` runs,
//     unless its last value is one gh reads as false;
//   - `gh api` naming `markPullRequestReadyForReview`, whatever the endpoint is spelled;
//   - the MCP tools `mcp__github__update_pull_request` with a `draft` that is not true and
//     `mcp__github__update_pull_request_draft_state` with the same, or a host connector's call that stands for one
//     (scripts/hook-mcp-github.mjs, hosts githubCall).
// Each is read wherever it runs (shell-lex walkCommands): in a substitution, `sh -c`, `eval`, or a heredoc fed to a shell.
// A call is judged in the project of the folder gh runs in (the answer rule's projectReader); in the session's project
// when that folder cannot be read; and, when the call names its repository, in the session's project as well, whenever that
// repository is one of its remotes (status refuses any other). Either project saying owed holds it. status runs at each
// project's root, in this process, never in a folder the command names.
//
// Cost, in this order: a command that names no ready starts no process. A matched one reads, from git alone, whether the
// project may run product feedback (localFeedback): a project without the key pays no gh call. Only then does it ask
// GitHub, every forge call under one shared deadline (DEADLINE_MS and HOOK_BUDGET_MS, inside the hook's 5 s) through the
// forge facade (lib/forges), and the pull request is viewed once.
// It lets the command run when it cannot read the call or the state: a word the shell fills in or expands as the program,
// `pr`, `ready`, or the target (a repository the shell fills in counts as the session's, as the merge guard reads it), a
// graphql call with no literal id or one that names no pull request, gh failing or past the deadline, status exiting 3,
// a repository that is no remote. It refuses with no network call only two forms, where git says the project runs product
// feedback: text fed to a shell that names a ready, and a command that marks more than one pull request ready, which
// one deadline cannot check.
// `AIDRIAN_ALLOW_UNHELD_READY=1` in the hook's own environment, set by a person before the session, lets every one run. Only
// this rule reads it, from `env`, so an inline setter in a command lifts nothing.
//
// In a project run's issue session (unattended-mark.mjs issueHeld) the session can write every ref of its clone, whose git
// folder it is granted, so git alone never says off and never names the default branch there: every ready asks GitHub.
// There it guesses no repository: it checks a `gh pr ready` only in one form (plainReady), `gh pr ready <number or URL>`
// as the command's first, run from the clone the mark records, with no `-R`, `--repo`, GH_REPO, GIT_DIR, or GIT_WORK_TREE
// in the command or the hook's environment, and refuses any other with FORM_REASON. So it refuses a ready it cannot read
// as one (unreadReady): gh with `pr` and `ready` around a word the shell fills in, and `gh pr ready` in the command a
// launcher runs, as xargs or a `-c` string hands it on. It refuses each read that fails (strictReason):
// gh failing or past the deadline, and status exiting 3. A ready a variable spells (`gh $X 7`) is out of its sight.
// The MCP call names its repository, which must be the clone's origin. The deny of an owed one names the stop the run records.

import { existsSync } from 'node:fs';
import path from 'node:path';

import { forgeFor } from '../../forges/index.mjs';
import { resolvedPath } from '../../fs.mjs';
import { runGit } from '../../git.mjs';
import { VIEW_FIELDS } from '../../pr-auto-merge.mjs';
import { feedbackStatus, issueReads, localFeedback } from '../../pr-product-feedback.mjs';
import { findProject } from '../../project.mjs';
import { originRepo, repoName } from '../../review-gate.mjs';
import { shellPlain, walkCommands } from '../../shell-lex.mjs';
import { issueHeld, readUnattendedMark } from '../../unattended-mark.mjs';
import { projectReader, UNKNOWN, unreadable } from '../product-feedback-answer.mjs';
import { commandPath, readWords, switchValue } from './review-request.mjs';

// The one deadline every gh call of one check shares: 3.5 s from the first gh call, and never later than 4 s after the
// hook's process started (`startedAt`, when the hook passes it), so another rule's lookups in the same command, such as
// pr-body's or the merge guard's, leave the hook inside its 5 s.
export const DEADLINE_MS = 3500;
export const HOOK_BUDGET_MS = 4000;
export const OVERRIDE = 'AIDRIAN_ALLOW_UNHELD_READY';
const MUTATION = 'markPullRequestReadyForReview';
// A word close to `ready`, as text a shell is fed may spell it: `re""ady`, `"ready"`, or printf's `re%sdy`.
const READY_LIKE = /re\S{0,4}dy/iu;
// Only a command holding one of these can mark ready: every other Bash call pays for this one look. A glob or brace
// character, or a substitution, can build a word the rule then reads as unreadable. It looks at the command as the shell
// reads its words (shell-lex shellPlain), so a quote, a backslash, or a line continuation inside a word (`r""eady`,
// `r\e\a\d\y`, `r\<newline>eady`) hides nothing.
const CANDIDATE = /re\S{0,4}dy|markPullRequestReadyForReview|[$`{[*?]/iu;
// Whether `command` may mark a pull request ready, by CANDIDATE. The ready checks hold shares it.
export const mayMarkReady = (command) => CANDIDATE.test(shellPlain(command));
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'eval']);
const READY_VALUES = new Set(['-R', '--repo']);
// Pull request node ids: the current `PR_…`, and the legacy base64 of `011:PullRequest…`.
const NODE_IDS = /\bPR_[A-Za-z0-9_-]{4,}|\bMDExOlB1bGxSZXF1ZXN0[A-Za-z0-9+/=]+|(?<=pullRequestId\s*:\s*\\?")[^"\\\s]+/gu;
const URL_TARGET = /^https?:\/\//iu;
const BARE = /^#?(\d+)$/u;

// GH_REPO for this invocation as written, after its assignments and env changes, or null for this repository: a value the
// rule cannot read counts as this one, as the merge guard's review-request invocationRepo reads it.
function ghRepoAsWritten(environment, env) {
  let repo = env.GH_REPO || null;
  for (const change of environment) {
    if (change.clear) repo = change.keep?.includes('GH_REPO') ? repo : null;
    else if (change.name === 'GH_REPO') repo = change.value && !change.value.dynamic && change.value.text ? change.value.text : null;
  }
  return repo;
}

// What one gh invocation marks ready, or null when it marks none, or when gh's command words are words the rule cannot
// read: { target, repo, url } with `target` the pull request as written (a number, URL, branch) or null for the current
// branch, `repo` the repository as written or null for this one, and `url` whether the target is a URL, which gh takes
// over `-R`; { ids } for a graphql call, its literal pull request ids; or { unreadable } for one it cannot read.
export function readReady({ program, args, environment = [] }, env = {}) {
  if (program !== 'gh') return null;
  const command = commandPath(args);
  if (command[0] === 'api') {
    if (!args.some(({ text }) => text.includes(MUTATION))) return null;
    const ids = [...new Set(args.filter((token) => !unreadable(token)).flatMap(({ text }) => text.match(NODE_IDS) ?? []))];
    return ids.length ? { ids } : { unreadable: 'a graphql call whose pull request id is not written out' };
  }
  if (command[0] !== 'pr' || command[1] !== 'ready') return null;
  const { words, flags } = readWords(args, READY_VALUES);
  if (switchValue(args, flags, '--undo') === true) return null;
  const word = words[2] ?? null;
  if (word && (unreadable(word) || word.text.startsWith('-'))) return { unreadable: 'a pull request the shell fills in' };
  const target = word?.text ?? null;
  const url = target !== null && URL_TARGET.test(target);
  const flag = flags.filter((each) => READY_VALUES.has(each.name)).at(-1);
  // A repository the shell fills in or expands counts as this one, as the merge guard reads it.
  const filled = args.some((token) => token.expands && /^(?:-R|--repo)/u.test(token.text));
  const fromFlag = flag && flag.value && !unreadable(flag.value) && !filled ? flag.value.text : null;
  const repo = url ? null : flag ? fromFlag : ghRepoAsWritten(environment, env);
  return { target, repo, url };
}

// The text a shell is fed that the walk could not read as commands, or null: what a pipe or a script feeds a shell
// (walkCommands `unread`), and a shell's `-c` string or `eval` words built by a command substitution.
function fedText({ unread, invocation, line }) {
  if (unread !== undefined) return unread;
  if (!SHELLS.has(invocation.program)) return null;
  return invocation.args.some(({ text, dynamic }) => dynamic && /\$\(|`/u.test(text)) ? line : null;
}

// Whether fed text names marking ready: the word `gh` and a word close to `ready`, read as the shell reads its words.
const namesReady = (text) => {
  const plain = shellPlain(text);
  return plain.includes(MUTATION) || (/\bgh\b/u.test(plain) && READY_LIKE.test(plain));
};

// The forge methods whose answer is the same from any folder: each names its repository or node, as an `api` route does.
const ANY_FOLDER = new Set(['nodeChange', 'changeEdits', 'repository', 'contents', 'pull', 'viewer', 'comment']);

// The forge (lib/forges), bounded by one deadline, at a folder: each call gets the time left, is stopped with SIGKILL at
// it, and none starts past it. A call with the same arguments runs once, from any folder when ANY_FOLDER holds its method.
// `forge` is the test seam: forgeFor's signature, (cwd, options) → the facade. The ready checks hold shares it.
export function deadlineForge({ forge = forgeFor, now = Date.now, deadlineMs = DEADLINE_MS, startedAt = Infinity } = {}) {
  const deadline = Math.min(now() + deadlineMs, startedAt + HOOK_BUDGET_MS);
  const seen = new Map();
  const call = (cwd, method, args) => {
    const key = JSON.stringify([ANY_FOLDER.has(method) ? '' : cwd, method, args]);
    if (!seen.has(key)) {
      // Whole milliseconds: execFileSync refuses a fractional timeout, and `startedAt` (performance.timeOrigin) is one.
      const left = Math.floor(deadline - now());
      try {
        if (left <= 0) throw new Error('the ready hold ran out of time');
        seen.set(key, { out: forge(cwd, { timeoutMs: left, killSignal: 'SIGKILL' })[method](...args) });
      } catch (error) {
        seen.set(key, { error });
      }
    }
    const { out, error } = seen.get(key);
    if (error) throw error;
    return out;
  };
  return (cwd) => {
    const methods = Object.entries(forge(cwd)).filter(([name, value]) => typeof value === 'function' && name !== 'isTrustedCommenter');
    return Object.freeze(Object.fromEntries(methods.map(([name]) => [name, (...args) => call(cwd, name, args)])));
  };
}

// The pull requests one ready call marks, each { value, view }: `value` what status takes, a number or a URL, and `view`
// gh's answer when the rule viewed it, so status views it once. A bare number with no repository goes to status as it is;
// any other target is viewed as written, with `-R` as written, so gh reads every spelling it accepts. An id that names no
// pull request marks none the rule can check.
// In an issue session (`strict`), a node read that fails throws, as a view that fails does.
function marked(call, forge, strict = false) {
  if (call.ids) {
    return call.ids.flatMap((id) => {
      try {
        const url = forge.nodeChange(id)?.data?.node?.url;
        return typeof url === 'string' ? [{ value: url, view: null }] : [];
      } catch (error) {
        if (strict) throw error;
        return [];
      }
    });
  }
  const bare = call.target === null ? null : BARE.exec(call.target);
  if (bare && call.repo === null) return [{ value: String(Number(bare[1])), view: null }];
  const view = forge.change(call.target, VIEW_FIELDS, { repo: call.repo });
  return typeof view?.url === 'string' ? [{ value: view.url, view }] : [];
}

// The default branch's name as origin/HEAD names it, for a pull request on origin's repository, or null: status then
// asks GitHub.
const mainBranchOf = (project) => (pr) => {
  if (originRepo(project) !== pr.repo.toLowerCase()) return null;
  const shown = runGit(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], project.root);
  return shown.status === 0 ? shown.stdout.trim().replace(/^refs\/remotes\/origin\//u, '') || null : null;
};

const owedLine = ({ title, command }) => `${JSON.stringify(title)}: \`${command}\``;

// The stop an issue session records while product feedback is owed on `pr`, which it does not run.
export const issueStop = (pr) => `product feedback is owed on #${pr}, which an issue session does not run: the Human runs pr-product-feedback on it, then marks it ready`;

// The deny for a pull request status says is owed. In an issue session it names the stop the run records instead.
function owedReason({ pr, reason, why, owed }, strict = false) {
  if (strict) {
    return `Blocked: this marks pull request #${pr} ready, and its product feedback is still owed: ${why}. ` +
      `A project run's issue session does not run product feedback: leave the draft, and record the result pr_open with the stop "${issueStop(pr)}".`;
  }
  const what = reason === 'not_run'
    ? `${why}. Run the \`pr-product-feedback\` skill on it`
    : `${why}: ${owed.map(owedLine).join('; ')}`;
  const choice = owed.some((each) => each.kind === 'choice') ? ' A product choice is the Human\'s: ask with AskUserQuestion, or with no Human present report the question and leave the draft.' : '';
  return `Blocked: this marks pull request #${pr} ready, and its product feedback is still owed: ${what}.${choice} ` +
    `Then run \`aidrian pr product-feedback status ${pr}\` until it exits 0, and mark it ready after that; until then it stays a draft.`;
}

export const FED_REASON =
  'Blocked: this feeds a shell text that names marking a pull request ready, which the ready hold cannot read as commands, ' +
  'and this project runs product feedback, which holds a draft while its feedback is owed. Run `aidrian pr product-feedback status <PR>`, ' +
  'then mark it ready with `gh pr ready <PR>`, the number written out, as its own command.';
export const MANY_REASON =
  'Blocked: this marks more than one pull request ready in one command, and the ready hold checks the product feedback of each ' +
  'within one time limit, which one command shares. Run one `gh pr ready <n>` per command.';

// The deny an issue session gets for a ready the hold could not read, `why` naming what it could not read.
export const strictReason = (why) =>
  `Blocked: this marks a pull request ready in a project run's issue session, and the ready hold could not read ${why}, ` +
  'so it cannot tell whether product feedback is owed. Run `aidrian pr product-feedback status <PR>`, then `gh pr ready <PR>` with the ' +
  'number written out, as its own command, from the attempt\'s clone; when gh keeps failing, leave the draft and say so in the report.';
// The one deny an issue session gets for a ready in any form but `gh pr ready <number or URL>` run first from its clone
// (plainReady): the hold there never guesses which repository or pull request gh would mark.
export const FORM_REASON =
  'Blocked: this marks a pull request ready in a project run\'s issue session in a form the ready hold does not check there: ' +
  'it checks only `gh pr ready <PR>`, the number or URL written out, as the command\'s first, run from the attempt\'s clone, ' +
  'with no `cd` or other folder before it and no `-R`, `--repo`, or `GH_REPO`. Run `gh pr ready <PR>` from the clone, with no repository option.';
// The deny an issue session gets for an MCP ready that does not name its clone's origin repository as owner and repo.
export const MCP_REPO_REASON =
  'Blocked: this marks a pull request ready in a project run\'s issue session, and the call does not name the attempt\'s clone\'s ' +
  'origin repository as its owner and repo, which the ready hold there requires. Name both, or run `gh pr ready <PR>` from the clone.';

// The deny reason for `calls`, each { call, projects, plain }, or null, `plain` saying the call has the one form an issue
// session's ready takes (plainReady). Any failure to read the state lets a call run, but in an issue session (`strict`),
// where each failure refuses, any other form refuses, and git's answer is never read (pr-product-feedback.mjs issueReads,
// which `status` takes there too).
function judgeCalls(calls, seams, strict = false) {
  const local = new Map();
  const strictReads = issueReads();
  const localOf = (project) => {
    if (!local.has(project.root)) local.set(project.root, strict ? strictReads.local : localFeedback(project));
    return local.get(project.root);
  };
  const may = (project) => ['on', 'maybe'].includes(localOf(project).state);
  if (calls.some(({ call, projects }) => call.fed && (strict || projects.some((project) => localOf(project).state === 'on')))) return FED_REASON;
  const marks = calls.filter(({ call }) => !call.fed).reduce((sum, { call }) => sum + (call.ids?.length || 1), 0);
  if (marks > 1 && (strict || calls.some(({ projects }) => projects.some(may)))) return MANY_REASON;
  let forgeAt = null;
  for (const { call, projects, plain } of calls) {
    if (call.fed) continue;
    if (strict && plain === false) return FORM_REASON;
    if (call.unreadable) {
      if (strict) return strictReason(call.unreadable);
      continue;
    }
    const judged = projects.filter(may);
    if (!judged.length) {
      if (strict) return strictReason('the project of the folder gh runs in');
      continue;
    }
    forgeAt ??= deadlineForge(seams);
    let pulls;
    try {
      pulls = marked(call, forgeAt(judged[0].root), strict);
    } catch (error) {
      if (strict) return strictReason(`the pull request with gh (${firstLine(error)})`);
      continue;
    }
    if (strict && !pulls.length) return strictReason('which pull request the call marks');
    for (const project of judged) {
      for (const { value, view } of pulls) {
        try {
          const mainBranch = strict ? strictReads.mainBranch : mainBranchOf(project);
          const { exit, result } = feedbackStatus(value, project, { forge: forgeAt(project.root), view, local: localOf(project), mainBranch });
          if (exit === 2) return owedReason(result, strict);
        } catch (error) {
          if (strict) return strictReason(`its product feedback (${firstLine(error)})`);
        }
      }
    }
  }
  return null;
}

const firstLine = (error) => String(error?.message ?? error).split('\n')[0].slice(0, 200);

// The issue mark of the session the hook's payload `input` names (unattended-mark.mjs issueHeld), or null when it works no
// project run's issue. A mark it cannot read holds no issue: the sandbox still holds the session.
function issueMark(unattendedMark) {
  try {
    const mark = unattendedMark();
    return issueHeld(mark) ? mark : null;
  } catch {
    return null;
  }
}
const markReader = (input, home) => () => readUnattendedMark(input?.session_id, home ? { home } : {});

// The project of the clone an issue mark records (`cwd`, the folder the start began the session in), or null.
function cloneProject(mark) {
  if (typeof mark.cwd !== 'string' || !path.isAbsolute(mark.cwd)) return null;
  try {
    return findProject(mark.cwd);
  } catch {
    return null;
  }
}
const real = (folder) => resolvedPath(folder) ?? path.resolve(folder);

// Whether the folder `cwd` is the clone `clone` (the mark's cwd) or inside it, in its own checkout: no folder from `cwd`
// up to the clone holds a `.git` of another checkout, so gh reads the clone's repository there.
function inClone(cwd, clone) {
  const here = real(cwd);
  const root = real(clone);
  if (here !== root && !here.startsWith(`${root}${path.sep}`)) return false;
  for (let dir = here; dir !== root; dir = path.dirname(dir)) if (existsSync(path.join(dir, '.git'))) return false;
  return true;
}

// The words that choose a repository for gh or git other than the folder's own: `-R` and `--repo`, attached or apart,
// and the variables. An issue session's ready refuses any of them anywhere in the command, or in the hook's environment.
const REPO_WORDS = /(?<![\w-])(?:-R|--repo)|\b(?:GH_REPO|GIT_DIR|GIT_WORK_TREE)\b/u;
const REPO_VARS = ['GH_REPO', 'GIT_DIR', 'GIT_WORK_TREE'];

// Whether the walked command `entry`, the `at`th the command runs, is the one ready form an issue session checks:
// `gh pr ready <number or URL>`, every word written out, as the command's first, in the folder the session is in, with no
// wrapper folder and no variable set for it.
function plainReady({ invocation, folder }, at, cwd) {
  const args = invocation.args ?? [];
  return at === 0 && !invocation.dynamic && !invocation.chdir && (invocation.environment ?? []).length === 0
    && typeof folder === 'string' && real(folder) === real(cwd)
    && args.length === 3 && args.every((token) => !unreadable(token)) && args[0].text === 'pr' && args[1].text === 'ready'
    && (BARE.test(args[2].text) || URL_TARGET.test(args[2].text));
}

// The programs that run a command their words name, which the walk may not read as one: their words are read for gh's
// ready. A shell's only after `-c`, find's only after an option that runs a command.
const LAUNCHERS = new Set(['xargs', 'parallel', 'find', 'watch', 'nohup', 'nice', 'time', 'command', 'exec', 'sudo', 'doas', 'timeout', 'env', ...SHELLS]);
const FIND_RUNS = new Set(['-exec', '-execdir', '-ok', '-okdir']);

// gh's first two command words as tokens, as commandPath reads them.
function commandTokens(args) {
  const words = commandPath(args);
  const tokens = [];
  for (const token of args) if (tokens.length < words.length && token.text === words[tokens.length]) tokens.push(token);
  return tokens;
}

// The words written out of the command a launcher runs, split at white space, as a `-c` string or watch's one word holds
// several; [] for a program that is no launcher.
function launchedWords({ program, args = [] }) {
  if (!LAUNCHERS.has(program)) return [];
  const literal = args.filter((token) => !unreadable(token));
  const from = program === 'find' ? literal.findIndex(({ text }) => FIND_RUNS.has(text))
    : SHELLS.has(program) && program !== 'eval' ? literal.findIndex(({ text }) => /^-[A-Za-z]*c[A-Za-z]*$/u.test(text)) : -1;
  if ((program === 'find' || (SHELLS.has(program) && program !== 'eval')) && from === -1) return [];
  return literal.slice(from + 1).flatMap(({ text }) => text.split(/\s+/u)).filter(Boolean);
}

// A ready the hold cannot read, which only an issue session refuses (check), or null:
//   - gh, which readReady reads as no ready, whose command words are not both written out, with `pr` and then `ready`
//     among its words written out, as `gh pr "$X" ready 7`, but an `--undo`. gh whose command words are written out
//     and are another subcommand, as `gh pr create --title ready`, is none.
//   - a launcher (LAUNCHERS) whose command holds `gh pr ready` or `gh api` with the mutation, as `xargs gh pr ready`,
//     `find -exec gh pr ready 7 ;`, `watch 'gh pr ready 7'`, or `sh -c '…'`. `echo gh pr ready 7` runs no command.
// A ready a variable spells, as `X="pr ready"; gh $X 7`, it does not see.
export function unreadReady(invocation) {
  if (!invocation || typeof invocation.program !== 'string' || invocation.dynamic) return null;
  const args = invocation.args ?? [];
  if (invocation.program === 'gh') {
    const [noun, verb] = commandTokens(args);
    if (noun && !unreadable(noun) && (noun.text !== 'pr' || (verb && !unreadable(verb)))) return null;
    const words = args.filter((token) => !unreadable(token)).map(({ text }) => text);
    const pr = words.indexOf('pr');
    if (pr === -1 || !words.slice(pr + 1).includes('ready')) return null;
    return switchValue(args, readWords(args, READY_VALUES).flags, '--undo') === true ? null : 'gh pr ready around a word the shell fills in';
  }
  const words = launchedWords(invocation);
  const at = words.findIndex((word) => /(?:^|\/)gh$/u.test(word));
  if (at === -1) return null;
  const rest = words.slice(at + 1);
  const [noun, verb] = commandPath(rest.map((text) => ({ text })));
  return (noun === 'pr' && verb === 'ready') || rest.some((word) => word.includes(MUTATION)) ? `gh run by ${invocation.program}` : null;
}

// The deny reason for `command`, or null. `cwd` is the session's folder, `env` the hook's own environment, `input` the hook's
// payload, whose session's mark `unattendedMark` reads (the seam); the rest are the seams of deadlineForge. The mark is read
// only for a command that holds a ready, or one the hold cannot read (unreadReady).
export function check(command, { cwd = process.cwd(), env = process.env, input = {}, home, unattendedMark = markReader(input, home), ...seams } = {}) {
  if (env[OVERRIDE] === '1' || !mayMarkReady(command)) return null;
  const found = [];
  const hidden = [];
  let at = 0;
  for (const entry of walkCommands(command, cwd)) {
    const text = fedText(entry);
    if (text !== null) {
      if (namesReady(text)) found.push({ entry, call: { fed: true }, at });
    } else {
      const call = readReady(entry.invocation, env);
      if (call) found.push({ entry, call, at });
      else if (unreadReady(entry.invocation)) hidden.push({ entry, call: { hidden: true }, at });
    }
    at += 1;
  }
  if (!found.length && !hidden.length) return null;
  const mark = issueMark(unattendedMark);
  if (mark) {
    // An issue session's every ready is judged in the clone its mark records, and checked in the one form alone. A ready
    // it cannot read is one in another form, after fed text and more than one ready, which judgeCalls refuses first.
    const clone = cloneProject(mark);
    if (!clone) return strictReason('the clone this session\'s mark records');
    const free = !REPO_WORDS.test(shellPlain(command)) && !REPO_VARS.some((name) => env[name]) && inClone(cwd, mark.cwd);
    // A graphql call names its pull request by node id, from any folder: it is judged as it is.
    const api = (entry) => commandPath(entry.invocation.args ?? [])[0] === 'api';
    const plain = ({ entry, call, at: index }) => !call.fed && !call.hidden && (api(entry) || (free && plainReady(entry, index, cwd)));
    return judgeCalls([...found, ...hidden].map((each) => ({ call: each.call, projects: [clone], plain: plain(each) })), seams, true);
  }
  if (!found.length) return null;
  // Every folder the rule cannot read is UNKNOWN: the hold needs no record to hold.
  const projectIn = projectReader(command, cwd, env, { on: () => true, unknownWhen: () => true });
  let session;
  const sessionProject = () => (session === undefined ? (session = findProject(cwd)) : session);
  const calls = found.map(({ entry, call }) => {
    const here = projectIn(entry.folder);
    // A folder it cannot read, as after `cd "$PWD"`: the session's project, where gh resolves the branch.
    // A folder in no project: only a call that names its repository is the session's.
    const list = here === UNKNOWN ? [sessionProject()] : here === null ? (named(call) ? [sessionProject()] : []) : named(call) ? [here, sessionProject()] : [here];
    const projects = list.filter((project, at) => project && list.findIndex((other) => other?.root === project.root) === at);
    return { call, projects };
  });
  return judgeCalls(calls, seams, false);
}

const named = (call) => Boolean(call.ids || call.repo || call.url);

// The deny reason for one MCP call that marks ready, `given` as { owner, repo, pullNumber, draft }, or null. A number it
// cannot read lets it run, as a target the shell fills in does, but in an issue session, as check's reads, where it is
// judged in the clone the mark records and must name that clone's origin repository as its owner and repo.
export function checkMcp(given, { cwd = process.cwd(), env = process.env, input = {}, home, unattendedMark = markReader(input, home), ...seams } = {}) {
  if (env[OVERRIDE] === '1' || given?.draft === true || given?.draft === undefined) return null;
  const mark = issueMark(unattendedMark);
  const project = mark ? cloneProject(mark) : findProject(cwd);
  if (!project) return mark ? strictReason('the clone this session\'s mark records') : null;
  const n = Number(given.pullNumber);
  if (!(Number.isInteger(n) && n > 0)) return mark ? strictReason('the pull request number') : null;
  const repo = typeof given.owner === 'string' && typeof given.repo === 'string' ? `${given.owner}/${given.repo}` : null;
  if (mark && (repoName(repo) === null || repoName(repo) !== originRepo(project))) return MCP_REPO_REASON;
  return judgeCalls([{ call: { target: String(n), repo, url: false }, projects: [project] }], seams, Boolean(mark));
}
