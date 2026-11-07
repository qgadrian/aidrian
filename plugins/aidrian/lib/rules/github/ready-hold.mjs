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

import { forgeFor } from '../../forges/index.mjs';
import { runGit } from '../../git.mjs';
import { VIEW_FIELDS } from '../../pr-auto-merge.mjs';
import { feedbackStatus, localFeedback } from '../../pr-product-feedback.mjs';
import { findProject } from '../../project.mjs';
import { originRepo } from '../../review-gate.mjs';
import { walkCommands } from '../../shell-lex.mjs';
import { projectReader, UNKNOWN, unreadable } from '../product-feedback-answer.mjs';
import { commandPath, readWords } from './review-request.mjs';

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
// character, or a substitution, can build a word the rule then reads as unreadable.
const CANDIDATE = /re\S{0,4}dy|markPullRequestReadyForReview|[$`{[*?]/iu;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'eval']);
const READY_VALUES = new Set(['-R', '--repo']);
// gh reads a bool flag's value with Go's strconv.ParseBool: these are true.
const TRUE_WORDS = new Set(['1', 't', 'T', 'TRUE', 'true', 'True']);
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
  const undo = flags.filter((flag) => flag.name === '--undo').at(-1);
  if (undo && (undo.value === null || (!undo.value.dynamic && TRUE_WORDS.has(undo.value.text)))) return null;
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

// Whether fed text names marking ready: the word `gh` and a word close to `ready`, with quotes and backslashes taken out.
const namesReady = (text) => {
  const plain = text.replace(/["'\\]/gu, '');
  return plain.includes(MUTATION) || (/\bgh\b/u.test(plain) && READY_LIKE.test(plain));
};

// The forge methods whose answer is the same from any folder: each names its repository or node, as an `api` route does.
const ANY_FOLDER = new Set(['nodeChange', 'repository', 'contents', 'pull', 'viewer', 'comment']);

// The forge (lib/forges), bounded by one deadline, at a folder: each call gets the time left, is stopped with SIGKILL at
// it, and none starts past it. A call with the same arguments runs once, from any folder when ANY_FOLDER holds its method.
// `forge` is the test seam: forgeFor's signature, (cwd, options) → the facade.
function deadlineForge({ forge = forgeFor, now = Date.now, deadlineMs = DEADLINE_MS, startedAt = Infinity } = {}) {
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
function marked(call, forge) {
  if (call.ids) {
    return call.ids.flatMap((id) => {
      try {
        const url = forge.nodeChange(id)?.data?.node?.url;
        return typeof url === 'string' ? [{ value: url, view: null }] : [];
      } catch {
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

// The deny for a pull request status says is owed.
function owedReason({ pr, reason, why, owed }) {
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

// The deny reason for `calls`, each { call, projects }, or null. Any failure to read the state lets a call run.
function judgeCalls(calls, seams) {
  const local = new Map();
  const localOf = (project) => {
    if (!local.has(project.root)) local.set(project.root, localFeedback(project));
    return local.get(project.root);
  };
  const may = (project) => ['on', 'maybe'].includes(localOf(project).state);
  if (calls.some(({ call, projects }) => call.fed && projects.some((project) => localOf(project).state === 'on'))) return FED_REASON;
  const marks = calls.filter(({ call }) => !call.fed).reduce((sum, { call }) => sum + (call.ids?.length || 1), 0);
  if (marks > 1 && calls.some(({ projects }) => projects.some(may))) return MANY_REASON;
  let forgeAt = null;
  for (const { call, projects } of calls) {
    if (call.fed || call.unreadable) continue;
    const judged = projects.filter(may);
    if (!judged.length) continue;
    forgeAt ??= deadlineForge(seams);
    let pulls;
    try {
      pulls = marked(call, forgeAt(judged[0].root));
    } catch {
      continue;
    }
    for (const project of judged) {
      for (const { value, view } of pulls) {
        try {
          const { exit, result } = feedbackStatus(value, project, { forge: forgeAt(project.root), view, local: localOf(project), mainBranch: mainBranchOf(project) });
          if (exit === 2) return owedReason(result);
        } catch {}
      }
    }
  }
  return null;
}

const named = (call) => Boolean(call.ids || call.repo || call.url);

// The deny reason for `command`, or null. `cwd` is the session's folder, `env` the hook's own environment; the rest are the
// seams of deadlineForge.
export function check(command, { cwd = process.cwd(), env = process.env, ...seams } = {}) {
  if (env[OVERRIDE] === '1' || !CANDIDATE.test(command)) return null;
  const found = walkCommands(command, cwd).flatMap((entry) => {
    const text = fedText(entry);
    if (text !== null) return namesReady(text) ? [{ entry, call: { fed: true } }] : [];
    const call = readReady(entry.invocation, env);
    return call ? [{ entry, call }] : [];
  });
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
  return judgeCalls(calls, seams);
}

// The deny reason for one MCP call that marks ready, `given` as { owner, repo, pullNumber, draft }, or null. A number it
// cannot read lets it run, as a target the shell fills in does.
export function checkMcp(given, { cwd = process.cwd(), env = process.env, ...seams } = {}) {
  if (env[OVERRIDE] === '1' || given?.draft === true || given?.draft === undefined) return null;
  const project = findProject(cwd);
  if (!project) return null;
  const n = Number(given.pullNumber);
  if (!(Number.isInteger(n) && n > 0)) return null;
  const repo = typeof given.owner === 'string' && typeof given.repo === 'string' ? `${given.owner}/${given.repo}` : null;
  return judgeCalls([{ call: { target: String(n), repo, url: false }, projects: [project] }], seams);
}
