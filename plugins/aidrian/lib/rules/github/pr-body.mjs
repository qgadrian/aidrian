// Bash rule: a pull request body written through `gh pr create` or `gh pr edit` has a `## ` heading for every section in
// config.json `github.requiredSections`, and no "Generated with [Claude Code]" footer. `gh pr create --fill` is refused:
// gh then writes the body from the commit messages. A non-web `gh pr create` with no --body or --body-file is refused
// too, when sections are configured: gh then takes the body from an editor, a prompt, or a template, unchecked.
// `--web` and `--help` pass. `gh pr edit` without a body flag passes (a title-only edit). A body flag whose body the
// rule cannot read (a variable, a substitution, stdin, a missing file, a device or a pipe, a file the line edits first)
// is refused when sections are configured, naming the one cause that applies (`unreadBody`). Runs only inside a project. A
// command substitution that runs, as in `url=$(gh pr create …)`, is read as the command line is. A leading `cd <dir> &&`
// moves the folder the body file and the project are read from; after any other directory change on the line, a relative
// body file is one the rule cannot read. A body file the same command line writes first, through `cat > file` or `tee
// file` fed a heredoc or a `cp` of a file the rule can read, is read as that command writes it (`lineWrites`), and
// `--body-file -` reads the heredoc fed to gh itself: the file does not exist yet when the hook runs.
//
// A call answers to the repository it targets. The project is the one the folder gh runs in finds (`chained` in
// shell-lex walkCommands), and the session's only where that folder cannot be known. A call that names a repository
// other than that checkout's remotes, by -R, a pull request URL, or GH_REPO, answers to no rule here
// (`targetsAnotherRepo`): the machine cannot find that repository's config.
//
// `github.pullRequest` adds the project's contract (docs/config.md#pull-request-contract), each part off until set:
// the title pattern, an issue key outside the title's leading bracket, the closed list of sections, the items of the
// deferral and residual sections, a body file in a shared temp folder, and a body identical to another open pull
// request's. A title is checked only when the command sets one, so a body-only edit never blocks on an old title.
//
// Every deny about where the body comes from names the one place the pr-write skill writes it: the literal path
// `<state>/tmp/pr-body-<branch>.md`, computed for the project and branch, or that pattern when either is unknown, in
// its second sentence, right after the cause, as the two steps that pass (`twoSteps`). The first sentence stays the
// cause, since the dispatch log records it.

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../../config.mjs';
import { forgeFor } from '../../forges/index.mjs';
import { runGit } from '../../git.mjs';
import { headings, sectionItems, unfencedLines } from '../../markdown-sections.mjs';
import { findProject, stateDir } from '../../project.mjs';
import { remoteRepos, repoName } from '../../review-gate.mjs';
import { boundedSearch, timeBudget } from '../../bounded-regexp.mjs';
import { lexPipeline, readInvocation, readShortOptions, walkCommands } from '../../shell-lex.mjs';
import { invocationRepo } from './review-request.mjs';

export const OVERRIDE = 'AIDRIAN_ALLOW_PR_BODY';

const FOOTER = /Generated with \[Claude Code\]/u;
const FILL = new Set(['--fill', '--fill-first', '--fill-verbose', '-f']);
// The short options of `gh pr` and `gh issue` create, edit, and comment that take a value; -d, -e, -f, and -w are switches.
const SHORT_VALUES = new Set(['-a', '-B', '-b', '-F', '-H', '-l', '-m', '-p', '-r', '-R', '-T', '-t']);
// Close, reopen, and merge read the same letters differently: `gh pr merge` has -d, -m, -r, and -s as switches.
const CLOSE_SHORT_VALUES = new Set(['-c', '-r', '-R']);
const MERGE_SHORT_VALUES = new Set(['-A', '-b', '-F', '-R', '-t']);
const VERB_SHORT_VALUES = new Map([['close', CLOSE_SHORT_VALUES], ['reopen', CLOSE_SHORT_VALUES], ['merge', MERGE_SHORT_VALUES]]);
// The gh commands whose text readBodyCall reads.
const TEXT_VERBS = new Map([
  ['pr', new Set(['create', 'edit', 'comment', 'close', 'reopen', 'merge'])],
  ['issue', new Set(['create', 'edit', 'comment', 'close', 'reopen'])],
]);
// The canonical heredoc form, `--body "$(cat <<'EOF' … EOF)"`, and only it, since another command may print something
// else, read from the raw command: the token holding it is
// dynamic, and its text has lost the body's quotes. -b takes it attached too, or at the end of a cluster. The
// substitution must be the whole word and hold only the heredoc. Group 4 is the body.
const HEREDOC_WORD = String.raw`(?<quote>"?)\$\(\s*cat\s*<<-?\s*(['"]?)(\w+)\2\r?\n([\s\S]*?)\r?\n[ \t]*\3[ \t]*\r?\n?[ \t]*\)\k<quote>(?=\s|$|[;&|)])`;
const BODY_HEREDOC = new RegExp(String.raw`(?:--body(?:=|\s+)|-[A-Za-z]*b=?\s*)` + HEREDOC_WORD, 'gu');
// The same for a call whose text may be a closing comment: the pull request rules count only body heredocs.
export const TEXT_HEREDOC = new RegExp(String.raw`(?:--(?:body|comment)(?:=|\s+)|-[A-Za-z]*[bc]=?\s*)` + HEREDOC_WORD, 'gu');

// Shared temp folders: concurrent sessions write the same names there, and one session's body can publish as another's.
const SHARED_TEMP = ['/tmp/', '/private/tmp/', '/var/tmp/', '/private/var/tmp/', '/var/folders/', '/private/var/folders/'];
// How long the open pull request lookup of `duplicateBody` may take, inside the hook's 5 s.
const LIST_TIMEOUT_MS = 3000;

// The deny reason for `command`, or null. `listOpenPrs(repo)` returns [{ number, body }] or null; it is the test seam
// of the one check that leaves the process.
export function check(command, { cwd = process.cwd(), env = process.env, listOpenPrs = openPrBodies(cwd) } = {}) {
  if (env[OVERRIDE] === '1') return null;
  for (const { call, entry, written } of bodyCalls(command, cwd)) {
    const { folder, chained, line } = entry;
    const reason = judge(call, line, { cwd: folder ?? cwd, projectFolder: chained ?? cwd, ghRepo: invocationRepo(entry.invocation.environment, env), folderKnown: folder !== null, env, written, listOpenPrs: chained === null || chained === cwd ? listOpenPrs : openPrBodies(chained) });
    if (reason) return reason;
  }
  return null;
}

// Each gh call `read` matches, as { call, entry, written }, with the folder it runs in (shell-lex `walkCommands`), in
// substitutions and inline shells too: `cd <worktree> && gh pr create --body-file b.md` reads that worktree's b.md and
// project. In a folder this rule cannot know, the project is the session's and a relative body file is unreadable. After
// a later `cd` joined by `&&`, `chained` still names the project, though a relative body file stays unreadable. Each call
// takes its own heredoc from its line, as `heredocs` finds them, and `written` holds the files the line wrote before it (`lineWrites`).
export function* bodyCalls(command, cwd, read = readPrCall, heredocs = BODY_HEREDOC) {
  const pending = new Map();
  const writes = lineWrites(command);
  for (const entry of walkCommands(command, cwd)) {
    const { segment, line } = entry;
    if (read(segment)) {
      // The same line text can run again, as two identical `sh -c` bodies do: a spent queue starts over.
      if (!pending.get(line)?.length) pending.set(line, callsOn(line, read, heredocs));
      const call = pending.get(line).shift();
      if (call) {
        call.stdin = stdinBody(entry);
        call.bodyFile = writes.token(call.bodyFile, entry);
        call.bodyOverwritten = writes.overwrites(entry, call.bodyFile);
        yield { call, entry, written: writes.files };
      }
    }
    // A gh call's own output can rewrite a body file a later gh call reads: `gh pr create … > b.md`.
    writes.note(entry);
  }
}

// What the command line `top` sets up before a later command on it runs, as { files, token, note }. `files` maps each
// absolute path the line writes to the text it then holds, or to null when a command changes it in a way this rule
// cannot know. `token(t, entry)` gives a dynamic token whose whole value is a variable the top line set to a literal,
// `$F` or `${S}/tmp/b.md`, as the static token bash would see. `note(entry)` takes each walkCommands entry in the order
// it runs, a gh call after its own check, and records:
// - `NAME=value` and `export NAME=value` on the top line with a literal value (or one this rule expands), for `token`.
//   A nested shell or substitution has a scope of its own, so it resolves no variable, and one it assigns is dropped:
//   the top line's value may then no longer hold;
// - `cat > file` or `tee file` fed one heredoc that bash passes unchanged, and no other input, and `cp [-fpv] source
//   file`, whose source this rule reads or the line wrote, as that text;
// - any other command that writes to a file (a redirect), or that names it and is not a known reader (such as `sed -i`
//   or a script), as null: the file then holds what that command made of it, which the rule never guesses at. One that
//   writes to, or names, a word this rule cannot resolve could be any file, so every file the line wrote turns null.
// `overwrites(entry, file)` says whether the command redirects any output, on any descriptor, onto `file`, or onto a
// target it cannot resolve (`"$OUT"`): bash truncates it before the command reads it.
// The pull request body rule and the attribution rule both read a body file through it.
export function lineWrites(top) {
  const files = new Map();
  const vars = new Map();
  const nested = (entry) => entry?.line !== undefined && entry.line !== top;
  const token = (each, entry) => {
    if (!each?.dynamic || nested(entry)) return each ?? null;
    const match = /^\$(?:(\w+)|\{(\w+)\})(\/[^$`*?\\]*)?$/u.exec(each.text);
    const value = match ? vars.get(match[1] ?? match[2]) : undefined;
    return value === undefined ? each : { text: `${value}${match[3] ?? ''}`, dynamic: false };
  };
  const assign = (name, value) => {
    const known = token(value);
    if (known && !known.dynamic) vars.set(name, known.text);
    else vars.delete(name);
  };
  const fileOf = (each, entry) => {
    const known = token(each, entry);
    return known && !known.dynamic && known.text && known.text !== '-' ? resolveIn(entry.folder, known.text) : null;
  };
  const outputs = (segment) => segment.flatMap((each, i) => (each.operator && each.operator !== '<' && !segment[i + 1]?.fdDup ? [[each, segment[i + 1]]] : []));
  const overwrites = (entry, file) => {
    const body = file ? fileOf(file, entry) : null;
    return body !== null && outputs(entry.segment).some(([, each]) => [null, body].includes(fileOf(each, entry)));
  };
  const note = (entry) => {
    const { segment, invocation, folder, heredocs = [] } = entry;
    const at = (each) => fileOf(each, entry);
    const { program, args, environment = [] } = invocation;
    const set = nested(entry) ? (name) => vars.delete(name) : assign;
    if (program === '') {
      for (const { name, value } of environment) if (name) set(name, value ?? null);
      return;
    }
    if (program === 'export') {
      for (const arg of args) {
        const split = /^(\w+)=(.*)$/su.exec(arg.text);
        if (split) set(split[1], { text: split[2], dynamic: arg.dynamic });
      }
      return;
    }
    // The output redirections and the file each writes; `2>&1` and `>&-` name a descriptor, not a file, and write none.
    const redirects = outputs(segment);
    let target = null;
    let text = null;
    // Only standard output writes the file: `cat 2> b.md` leaves it empty.
    // A duplicate onto standard output (`>&2`, `1>&2`) may move it off the file: what lands there is unknown.
    const stdoutMoved = segment.some((each, i) => each.operator === '>' && segment[i + 1]?.fdDup && [undefined, '1'].includes(each.fd));
    if (program === 'cat' && args.every((arg) => arg.text === '-') && redirects.length === 1 && redirects[0][0].operator === '>' &&
      [undefined, '1'].includes(redirects[0][0].fd) && !stdoutMoved) {
      [target, text] = [at(redirects[0][1]), stdinBody(entry)];
    } else if (program === 'tee' && args.length === 1 && !args[0].text.startsWith('-')) {
      target = at(args[0]);
      // A redirect of its own output onto the same file races the write: what lands there is unknown.
      text = target !== null && redirects.some(([, each]) => at(each) === target) ? null : stdinBody(entry);
    } else if (program === 'cp' && !redirects.length) {
      const operands = args.filter((arg) => !/^-[fpv]+$/u.test(arg.text));
      const source = operands.length === 2 && !operands[0].text.startsWith('-') ? at(operands[0]) : null;
      target = source === null || operands[1].text.endsWith('/') ? null : at(operands[1]);
      if (target !== null && isDirectory(target)) target = null;
      else if (target !== null) text = files.has(source) ? files.get(source) : readText(source);
    }
    const unknown = () => {
      for (const known of files.keys()) files.set(known, null);
    };
    // A command that is neither a known reader nor one of the writes above may change any file: a script, `sed -i`, or
    // a program fed its own code on stdin.
    if (target === null && !isReader(invocation)) {
      unknown();
      // A file it names on disk is one it may change too.
      for (const each of segment) {
        const file = each.operator || each.fdDup ? null : at(each);
        if (file !== null) files.set(file, null);
      }
    }
    for (const [, each] of redirects) {
      const file = at(each);
      if (file !== null) files.set(file, null);
      else unknown();
    }
    if (target !== null) files.set(target, text);
  };
  return { files, token, note, overwrites };
}

// Programs that change no existing file, so running one before gh leaves a body file the line wrote as it was. A
// redirect from one of them still writes its target. git and gh count only for subcommands that write no work file.
const READERS = new Set(['cat', 'grep', 'egrep', 'fgrep', 'rg', 'head', 'tail', 'wc', 'ls', 'test', '[', 'diff', 'cmp', 'dirname',
  'basename', 'realpath', 'readlink', 'stat', 'file', 'echo', 'printf', 'mkdir', 'true', 'false', ':', 'pwd', 'sleep', 'jq']);
const GIT_READERS = new Set(['push', 'fetch', 'log', 'status', 'diff', 'show', 'rev-parse', 'add', 'commit', 'branch', 'remote', 'ls-files', 'rev-list']);
const GH_WRITERS = new Set(['download', 'clone', 'checkout']);

function isReader({ program, args }) {
  if (READERS.has(program)) return true;
  const words = args.filter((arg, i) => !arg.text.startsWith('-') && !['-C', '-c'].includes(args[i - 1]?.text)).map((arg) => arg.text);
  if (program === 'git') return GIT_READERS.has(words[0]);
  if (program === 'gh') return !words.some((word) => GH_WRITERS.has(word));
  return false;
}

// The body of a command's one heredoc on its standard input, as bash passes it (unchangedHeredoc), or null: none,
// several, one bash expands, or one fed to another descriptor (`3<<EOF`), which the command does not read as its input.
const onlyHeredoc = (heredocs) => (heredocs.length === 1 && [undefined, '0'].includes(heredocs[0].fd) &&
  (!heredocs[0].expands || !/[$`\\]/u.test(heredocs[0].body)) ? heredocs[0].body : null);

// The body of the one heredoc fed to a command's input, for a walkCommands entry, or null. An input redirect beside it,
// `< file` or `<<< word`, may replace it, so the input is one this rule cannot know.
export const stdinBody = ({ segment = [], heredocs = [] }) => (segment.some((each) => each.operator === '<') ? null : onlyHeredoc(heredocs));

const resolveIn = (folder, file) => (path.isAbsolute(file) ? path.resolve(file) : folder === null ? null : path.resolve(folder, file));

const isDirectory = (file) => {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
};

// A regular file's text, or null. A device or a FIFO is no body: reading one can hang the hook, or read as empty and pass.
const readText = (file) => {
  try {
    return statSync(file).isFile() ? readFileSync(file, 'utf8') : null;
  } catch {
    return null;
  }
};

// A heredoc match's body (group 4) as bash passes it: as written under a quoted delimiter (group 2), or under a bare one
// when it holds nothing bash expands (`$`, a backtick, or a backslash); else null, a body no rule can know.
export const unchangedHeredoc = (match) => (match[2] || !/[$`\\]/u.test(match[4]) ? match[4] : null);

// Every `gh pr create|edit` call of one command line, in order, as readPrCall reads it, with `heredoc`: the body of the
// heredoc its dynamic --body holds. A call reads only a heredoc in its own words, and only when they hold exactly one:
// another command's heredoc on the line never stands in for its body. A heredoc under a bare delimiter that holds `$`, a
// backtick, or a backslash is expanded by bash, so it is not read either.
export const readPrCalls = (line) => callsOn(line, readPrCall);

function callsOn(line, read, pattern = BODY_HEREDOC) {
  const { segments, spans } = lexPipeline(line);
  return segments.flatMap((segment, i) => {
    const call = read(segment);
    if (!call) return [];
    if (call.body?.dynamic) {
      const own = [...line.slice(...spans[i]).matchAll(pattern)];
      call.heredoc = own.length === 1 ? unchangedHeredoc(own[0]) : null;
    }
    return [call];
  });
}

// A `gh [-R repo] pr create|edit …` segment, as readBodyCall reads it, else null.
export function readPrCall(segment) {
  const call = readBodyCall(segment);
  return call?.noun === 'pr' && ['create', 'edit'].includes(call.subcommand) ? call : null;
}

// { noun, subcommand, fill, draft, body, bodyFile, title, repo, target, head, base, dryRun, deleteLast } for a segment
// of `gh [-R repo] pr|issue create|edit|comment|close|reopen …` or `gh pr merge …`, else null. Later flags win, as in gh.
// `title`, `repo`, `head`, and `base` are tokens; `target` is the first positional (the issue or pull request named). A
// closing comment is the `body`, and the subject of a merge the `title`.
export function readBodyCall(segment) {
  const { program, args } = readInvocation(segment);
  if (program !== 'gh') return null;
  let i = 0;
  const words = [];
  let repo = null;
  let help = false;
  for (; i < args.length && words.length < 2; i += 1) {
    const { text, dynamic } = args[i];
    if (dynamic) return null;
    if (text === '-h' || /^--help(?:=|$)/u.test(text)) help = isTrue(text.includes('=') ? text.slice(text.indexOf('=') + 1) : null);
    else if (text === '-R' || text === '--repo') repo = args[++i] ?? null;
    else if (text.startsWith('--repo=')) repo = { text: text.slice('--repo='.length), dynamic };
    else if (!text.startsWith('-')) words.push(text);
  }
  // `gh pr new` and `gh issue new` are gh's built-in aliases for `create`.
  if (words[1] === 'new') words[1] = 'create';
  if (!TEXT_VERBS.get(words[0])?.has(words[1])) return null;
  const shorts = VERB_SHORT_VALUES.get(words[1]) ?? SHORT_VALUES;
  const closing = ['close', 'reopen'].includes(words[1]);
  const call = { noun: words[0], subcommand: words[1], fill: false, draft: false, web: false, help, body: null, bodyFile: null, title: null, repo, target: null, head: null, base: null, dryRun: false, deleteLast: false };
  for (; i < args.length; i += 1) {
    const { text, dynamic } = args[i];
    // After `--` every word is a positional: no flag, but still the pull request an edit names.
    if (text === '--') {
      call.target ??= args[i + 1] ?? null;
      break;
    }
    let [flag, inline] = text.startsWith('--') && text.includes('=') ? [text.slice(0, text.indexOf('=')), text.slice(text.indexOf('=') + 1)] : [text, null];
    if (/^-[^-]/u.test(text)) {
      // A short word as gh reads it: `-dF body.md`, `-Fbody.md`, and `-F=body.md`. A switch ending a cluster takes an
      // explicit value after `=`, as pflag reads it: `-w=0` and `-dw=false` are web off.
      const split = /^-([^=]+)=(.*)$/u.exec(text);
      const explicit = split && !readShortOptions(`-${split[1]}`, shorts).value ? split : null;
      const { options, value } = readShortOptions(explicit ? `-${explicit[1]}` : text, shorts);
      const last = options.at(-1);
      const on = (option) => options.includes(option) && (option !== last || !explicit || isTrue(explicit[2], dynamic));
      // --fill is refused unless it is statically off; --web and --help exempt only when statically on.
      if (options.includes('-f') && !(last === '-f' && explicit && isFalse(explicit[2], dynamic))) call.fill = true;
      if (options.includes('-w')) call.web = on('-w');
      if (options.includes('-d')) call.draft = on('-d');
      if (options.includes('-h')) call.help = on('-h');
      if (!value) continue;
      [flag, inline] = [value.option, value.attached?.replace(/^=/u, '') ?? null];
    }
    const value = () => (inline !== null ? { text: inline, dynamic } : args[++i] ?? null);
    if (FILL.has(flag)) call.fill = true;
    else if (flag === '--web') call.web = isTrue(inline, dynamic);
    else if (flag === '--draft') call.draft = isTrue(inline, dynamic);
    else if (flag === '--dry-run') call.dryRun = isTrue(inline, dynamic);
    else if (flag === '--help') call.help = isTrue(inline, dynamic);
    else if (flag === '--delete-last') call.deleteLast = isTrue(inline, dynamic);
    else if (flag === '--body' || flag === '-b' || (closing && (flag === '--comment' || flag === '-c'))) [call.body, call.bodyFile] = [value(), null];
    else if (flag === '--body-file' || flag === '-F') [call.bodyFile, call.body] = [value(), null];
    else if (flag === '--title' || flag === '-t' || (call.subcommand === 'merge' && flag === '--subject')) call.title = value();
    else if (flag === '--head' || flag === '-H') call.head = value();
    else if (flag === '--base' || flag === '-B') call.base = value();
    else if (flag === '--repo' || flag === '-R') call.repo = value();
    else if (shorts.has(flag) || LONG_VALUES.has(flag)) value();
    else if (!text.startsWith('-') && call.target === null) call.target = args[i];
  }
  return call;
}

// Whether the call names a repository other than those of `project`'s checkout: by -R, the URL it targets (`targetUrl`),
// or else `ghRepo`, the GH_REPO in force (review-request `invocationRepo`). A value the rule cannot read, or a checkout
// with no remote to compare, is not another repository, so the project's rules hold.
export function targetsAnotherRepo(call, project, ghRepo) {
  // A URL target names its repository, whatever -R says, as gh reads it.
  const named = targetUrl(call) ?? call.repo ?? { text: ghRepo, dynamic: false };
  const repo = named.dynamic ? null : repoName(named.text);
  if (repo === null) return false;
  const own = remoteRepos(project);
  return own.length > 0 && !own.includes(repo);
}

// The target when it is a URL gh reads as one: scheme and host are required, since `gh pr edit team/pull/3` names a branch.
// A pull request call takes only a pull request's URL; an issue or a comment call takes an issue's too.
function targetUrl(call) {
  if (call.subcommand === 'create' || !call.target || call.target.dynamic) return null;
  const kinds = call.noun === 'issue' || call.subcommand === 'comment' ? 'pull|issues' : 'pull';
  return new RegExp(String.raw`^https?://[^/\s]+/[^/\s]+/[^/\s]+/(?:${kinds})/\d+(?:[/?#]|$)`, 'iu').test(call.target.text) ? call.target : null;
}

// A boolean option's value as gh (pflag) reads it: bare or a pflag true word is on, a false word is off. A value the
// rule cannot read is neither, so it grants no exemption.
const isTrue = (inline, dynamic = false) => inline === null || (!dynamic && /^(?:true|1|t|TRUE|True|T)$/u.test(inline));
const isFalse = (inline, dynamic = false) => inline !== null && !dynamic && /^(?:false|0|f|FALSE|False|F)$/u.test(inline);

// The long options of the commands readBodyCall reads that take a value, so their value is never read as the target.
const LONG_VALUES = new Set([
  '--assignee', '--base', '--head', '--label', '--milestone', '--project', '--reviewer', '--template', '--recover', '--attach',
  '--add-assignee', '--remove-assignee', '--add-label', '--remove-label', '--add-project', '--remove-project',
  '--add-reviewer', '--remove-reviewer',
  '--type', '--parent', '--blocked-by', '--blocking', '--add-blocked-by', '--add-blocking', '--remove-blocked-by', '--remove-blocking',
  '--add-sub-issue', '--remove-sub-issue',
  '--reason', '--duplicate-of', '--author-email', '--match-head-commit',
]);

function judge(call, command, { cwd, projectFolder, ghRepo, folderKnown = true, env, written = new Map(), listOpenPrs }) {
  const project = findProject(projectFolder);
  if (!project || targetsAnotherRepo(call, project, ghRepo)) return null;
  const { config } = loadConfig(project);
  const contract = config.github.pullRequest;
  if (call.help) return null;
  const state = () => stateFolder(project, config, env);
  const steps = () => twoSteps(bodyFilePath(state(), call, folderKnown ? cwd : null), call);
  if (call.fill && call.subcommand === 'create') {
    return deny(`\`--fill\` writes the body from the commit messages, without the sections config.json \`github.requiredSections\` asks for. ${steps()}`);
  }
  if (contract.sharedTempBodyFile && call.bodyFile && call.bodyFile.text !== '-' && isSharedTemp(call.bodyFile.text, projectFolder, env, project.root, state)) {
    return deny(`the body file \`${call.bodyFile.text}\` is in a shared temp folder, which concurrent sessions overwrite. ${steps()} ` +
      "The host's scratchpad and the system temp folder are such folders: another session's body can publish under this pull request " +
      '(config.json `github.pullRequest.sharedTempBodyFile`).');
  }
  const sectioned = config.github.requiredSections.length > 0 || Boolean(contract.sections?.length);
  if (call.subcommand === 'create' && !call.web && !call.body && !call.bodyFile && sectioned) {
    return deny('`gh pr create` has no --body or --body-file, so gh takes the body from an editor, a prompt, or a template, unchecked. ' +
      `${steps()} The body needs the sections config.json \`github.requiredSections\` asks for.`);
  }
  const body = readBody(call, folderKnown ? cwd : null, written);
  if (body === null && sectioned && (call.body || call.bodyFile)) {
    const { cause, fix } = unreadBody(call, folderKnown ? cwd : null, written);
    return deny(`the body is one this rule cannot read: ${cause}, so the sections config.json \`github.requiredSections\` asks for go unchecked. ` +
      `${fix ? `${fix} ` : ''}${steps()}`);
  }
  const reason = body === null ? null : judgeBody(body, config) ?? judgeDuplicate(body, call, contract, listOpenPrs);
  return reason ?? judgeTitle(call.title, config);
}

function judgeBody(body, config) {
  const contract = config.github.pullRequest;
  if (FOOTER.test(body)) {
    const replaced = config.attribution.pullRequest.length
      ? ' The lines config.json `attribution.pullRequest` asks for, which the attribution rule prints, take its place.' : '';
    return deny('the body carries the "Generated with [Claude Code]" footer. Drop that line: this project\'s rule takes precedence over ' +
      `the host's attribution instructions that ask for it.${replaced} Claude Code's setting \`"attribution": { "pr": "" }\` in ` +
      '`.claude/settings.json` stops the host from asking.');
  }
  const missing = config.github.requiredSections.filter((section) => !hasSection(body, section));
  if (missing.length) {
    return deny(`the body has no ${missing.map((section) => `\`## ${section}\``).join(', ')} section. ` +
      `config.json \`github.requiredSections\` lists the sections every body has: ${config.github.requiredSections.join(', ')}. ` +
      'Write the body with the pr-write skill.');
  }
  if (contract.sections) {
    const extra = [...new Set(headings(body).filter((title) => !contract.sections.includes(title)))];
    if (extra.length) {
      return deny(`the body adds the section(s) ${extra.map((title) => `\`## ${title}\``).join(', ')}, which are not on the closed list ` +
        `in config.json \`github.pullRequest.sections\`: ${contract.sections.join(', ')}. Fold the content into one of those.`);
    }
  }
  const key = issueKeyPattern(contract.issueKey);
  if (contract.residuals) {
    const { section, fields } = contract.residuals;
    for (const item of sectionItems(body, section) ?? []) {
      const lacking = fields.filter((field) => !item.text.includes(`${field}:`));
      const problem = lacking.length ? `it is missing ${lacking.map((field) => `\`${field}:\``).join(', ')}`
        : key?.test(item.text) ? 'it names an issue: a tracked item is a deferral, not a residual' : null;
      if (problem) {
        return deny(`\`## ${section}\` item "${excerpt(item.text)}" is not a valid residual: ${problem}. ` +
          `Every item states ${fields.map((field) => `\`${field}:\``).join(', ')} and names no issue (config.json \`github.pullRequest.residuals\`).`);
      }
    }
  }
  if (contract.deferrals) {
    const { section, field, reasons } = contract.deferrals;
    for (const item of sectionItems(body, section) ?? []) {
      const problem = deferralProblem(item, contract.deferrals, key);
      if (problem) {
        return deny(`\`## ${section}\` item "${excerpt(item.text)}" is not a valid deferral: ${problem}. ` +
          `Every item carries a \`${field}:\` from ${reasons.join(', ')}${key ? ', and the issue it was deferred to' : ''} ` +
          '(config.json `github.pullRequest.deferrals`). Fix the finding in this pull request instead of relabelling why it was not fixed.');
      }
    }
  }
  return null;
}

// What is wrong with one deferral item, or null. The first `<field>:` on the item's own line declares its reason, and
// the reason's first bare word decides it: a reason from the list passes whatever prose follows it. Any other reason is
// named, as one of the never-valid ones when it is. A key in a sub-bullet or later on the line is prose about the field.
function deferralProblem(item, { field, reasons, neverValid = [] }, key) {
  const declared = new RegExp(`[\`*_]*${escape(field)}[\`*_]*\\s*[:=]\\s*`, 'iu').exec(item.first);
  const value = declared ? item.first.slice(declared.index + declared[0].length).replace(VALUE_WRAPPER, '') : null;
  const head = value?.match(/^[a-z0-9_-]+/iu)?.[0] ?? '';
  if (!head) return `it carries no \`${field}:\` value`;
  if (!reasons.includes(head)) {
    const given = value.split(/\s+[—–-]\s+|[;,:(`]/u)[0].trim() || value.trim();
    const shown = given.length > 48 ? `${given.slice(0, 47)}…` : given;
    const never = neverValid.find((phrase) => new RegExp(escape(phrase).replace(/<[^>]+>/gu, '(?:<[^>]+>|[\\w./-]+)'), 'iu').test(given));
    return never ? `its reason "${shown}" is a never-valid reason ("${never}")` : `its reason "${shown}" is not one of ${reasons.join(', ')}`;
  }
  return key && !key.test(item.text) ? 'it names no issue to defer the work to' : null;
}

// Markdown emphasis and quotes around a value that are not part of it.
const VALUE_WRAPPER = /^[\s`*_"'\u201c\u201d\u2018\u2019]+|[\s`*_"'\u201c\u201d\u2018\u2019]+$/gu;

// A body identical to another open pull request's describes a different branch: a stale or another session's body file.
// Only where the target is known: a create, or an edit that names its pull request by number or URL. Fails open.
function judgeDuplicate(body, call, contract, listOpenPrs) {
  if (!contract.duplicateBody || body.trim() === '' || call.repo?.dynamic) return null;
  let self = null;
  if (call.subcommand === 'edit') {
    const text = call.target?.dynamic ? '' : call.target?.text ?? '';
    self = /^\d+$/u.test(text) ? Number(text) : Number(/\/pull\/(\d+)(?:[/?#]|$)/u.exec(text)?.[1] ?? Number.NaN);
    if (Number.isNaN(self)) return null;
  }
  // Without -R, a pull request URL names the repository the edit goes to.
  const urlRepo = /github\.com\/([^/]+\/[^/]+)\/pull\//u.exec(call.target?.dynamic ? '' : call.target?.text ?? '')?.[1] ?? null;
  let open;
  try {
    open = listOpenPrs(call.repo?.text ?? urlRepo);
  } catch {
    return null;
  }
  const twin = Array.isArray(open) ? open.find((pr) => pr?.number !== self && typeof pr?.body === 'string' && pr.body.trim() === body.trim()) : null;
  return twin ? deny(`the body is identical to open pull request #${twin.number}'s, so it describes another branch; ` +
    "a stale or another session's body file is the usual cause. Write the body from this branch's diff (the pr-write skill).") : null;
}

function judgeTitle(token, config) {
  const { title: pattern, issueKey } = config.github.pullRequest;
  if (!pattern || !token || token.dynamic) return null;
  const types = config.git.commits.types.map(escape).join('|');
  const wanted = pattern.replaceAll('{types}', types).replaceAll('{issueKey}', `(?:${issueKey ?? '(?!)'})`);
  // The project's patterns run under a time limit (lib/bounded-regexp.mjs); one that runs out checks nothing.
  const budget = timeBudget(TITLE_BUDGET_MS, TITLE_BUDGET_MS);
  const found = boundedSearch(wanted, 'u', token.text, budget);
  if (found === null) return null;
  if (found < 0) {
    return deny(`the title "${token.text}" does not match config.json \`github.pullRequest.title\`: ${pattern} ` +
      `({types} is ${config.git.commits.types.join('|')}${issueKey ? `, {issueKey} is ${issueKey}` : ''}).`);
  }
  const key = issueKeyPattern(issueKey);
  if (key && (boundedSearch(key.source, 'u', token.text.replace(/^\[[^\]]*\]/u, ''), budget) ?? -1) >= 0) {
    return deny('the title names an issue key outside its leading [...] bracket, which links the pull request to an issue it ' +
      'does not implement. Move the key into the bracket if this pull request implements it; otherwise reword the title without it.');
  }
  return null;
}

// The time the title pattern and the issue key may take together.
const TITLE_BUDGET_MS = 300;

// The issue key as a whole word: `XABC-1` and `ABC-1a` are not `ABC-\d+` keys.
const issueKeyPattern = (key) => (key ? new RegExp(`(?<![A-Za-z0-9])(?:${key})(?![A-Za-z0-9])`, 'u') : null);

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

const excerpt = (text) => {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > 72 ? `${flat.slice(0, 71)}…` : flat;
};

// Whether a body file path is in a shared temp folder: as written (`$TMPDIR/…` before the shell expands it), or resolved.
// A file inside the project or its state folder is not, even when that folder itself sits in a temp folder. `state()`
// gives the state folder or null; it runs git, so only for a file in a temp folder.
function isSharedTemp(text, cwd, env, root, state = () => null) {
  if (/^\$\{?TMPDIR\}?\//u.test(text)) return true;
  const file = path.resolve(cwd, text);
  if (file.startsWith(`${root}${path.sep}`)) return false;
  const tmpdir = path.isAbsolute(env.TMPDIR ?? '') ? `${env.TMPDIR.replace(/\/+$/u, '')}/` : null;
  if (!SHARED_TEMP.some((prefix) => file.startsWith(prefix)) && !(tmpdir !== null && file.startsWith(tmpdir))) return false;
  const folder = state();
  if (folder === null) return true;
  let real = folder;
  try {
    real = realpathSync(folder);
  } catch {
    // A state folder not made yet holds no file to compare.
  }
  return ![folder, real].some((dir) => file.startsWith(`${dir}${path.sep}`));
}

// The project's state folder (`aidrian state`), or null when it cannot be read: a deny message never fails.
export function stateFolder(project, config, env) {
  try {
    return stateDir(project, { config, env });
  } catch {
    return null;
  }
}

// The body file the pr-write skill writes, `<state>/tmp/pr-body-<branch>.md`, as { file, note }: the literal path, and
// what its placeholders mean, or ''. The branch is the call's static --head, or the one checked out where gh runs. A part
// it cannot know stays a placeholder. An issue or a comment gets its own file, so it never overwrites a pull request's body.
export function bodyFilePath(state, call, cwd) {
  const head = call.head && !call.head.dynamic ? call.head.text.replace(/^[^:]*:/u, '') : null;
  let branch = head || null;
  if (!branch && cwd !== null) {
    const result = runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd);
    branch = result.status === 0 ? result.stdout.trim() || null : null;
  }
  const stem = { comment: 'comment-body', merge: 'merge-body' }[call.subcommand] ?? (call.noun === 'issue' ? 'issue-body' : 'pr-body');
  const file = `${stem}-${branch ? branch.replaceAll('/', '-') : '<branch>'}.md`;
  const notes = [state ? null : '`<state>` is the folder `aidrian state` prints', branch ? null : '`<branch>` is the branch name with each `/` replaced by `-`'];
  const known = notes.filter(Boolean);
  return { file: state ? path.join(state, 'tmp', file) : `<state>/tmp/${file}`, note: known.length ? ` (${known.join('; ')})` : '' };
}

// The two steps that pass, for a deny about where the body comes from: write the body to the one file, then hand gh
// that path written out. The heredoc form is the one `lineWrites` reads in the same command.
export function twoSteps({ file, note }, call) {
  const target = call.subcommand !== 'create' && call.target && !call.target.dynamic ? ` ${call.target.text}` : '';
  const skill = call.noun === 'pr' && ['create', 'edit'].includes(call.subcommand) ? ' (the pr-write skill)' : '';
  return `Do this instead: 1. write the body to \`${file}\`${note}, with the file tool or with \`cat > ${file} <<'EOF'\` ` +
    `earlier in this command; 2. run \`gh ${call.noun} ${call.subcommand}${target} --body-file ${file}\`, the path written out${skill}.`;
}

// The forge the open pull request lookup reads through: every call bounded at LIST_TIMEOUT_MS. `options` are the
// adapter's, such as its `run` in a test.
export const listForge = (cwd, options = {}) => forgeFor(cwd, { ...options, timeoutMs: LIST_TIMEOUT_MS });

// The open pull requests' bodies through the forge facade, or null when gh cannot answer in time.
export function openPrBodies(cwd, forge = listForge(cwd)) {
  return (repo) => {
    try {
      return forge.openChanges(200, 'number,body', { repo });
    } catch {
      return null;
    }
  };
}

// The body text, or null when this rule cannot know it. A null `cwd` is a folder it cannot know: only an absolute body
// file reads. A dynamic --body reads the heredoc readPrCalls gave the call, `--body-file -` the heredoc check gave it as
// `stdin`, and a file the line wrote earlier the text `written` (lineWrites) holds for it.
export const readBody = (call, cwd, written = new Map()) => bodyRead(call, cwd, written).text;

// Why readBody gives no text for a call with a body flag, as { cause, fix }: the cause a deny names first, and the one
// step it needs beyond the two that pass, or ''. Null when the body reads, or the call has no body flag. The pull request
// body rule and the public text rule refuse with it, so the first deny names the form that passes.
export const unreadBody = (call, cwd, written = new Map()) => bodyRead(call, cwd, written).unread ?? null;

const unread = (cause, fix = '') => ({ text: null, unread: { cause, fix } });

function bodyRead(call, cwd, written) {
  if (call.bodyOverwritten) {
    return unread('a redirect on the gh call writes onto its own body file, which bash empties before gh reads it', 'Send that output to another file.');
  }
  if (call.body) {
    if (!call.body.dynamic) return { text: call.body.text };
    return call.heredoc != null ? { text: call.heredoc } : unread('it is a variable, a command substitution, or a heredoc bash expands');
  }
  if (!call.bodyFile) return { text: null };
  const given = call.bodyFile.text;
  if (call.bodyFile.dynamic) {
    return unread(`the body file \`${given}\` is a variable this command does not set to a literal path, or a command substitution`,
      'Never pass the path through `$(…)` or a variable no literal sets on this line: write it out.');
  }
  if (given === '-') {
    return call.stdin != null ? { text: call.stdin } : unread('`--body-file -` reads standard input, and that input is not one heredoc bash passes unchanged, such as a pipe');
  }
  if (cwd === null && !path.isAbsolute(given)) {
    return unread(`the body file \`${given}\` is a relative path, and the folder gh runs in is unknown after that directory change`, 'Write the path out in full.');
  }
  const file = resolveIn(cwd, given);
  if (written.has(file)) {
    const text = written.get(file);
    return text !== null ? { text } : unread('another command on this line changes the body file before gh reads it, such as a script or `sed -i`, ' +
      'or a redirect', 'Run that command first, then gh as its own command.');
  }
  // Joined, not resolved: the filesystem follows a symlink before a `..`, as gh opens the operand.
  const text = readText(path.isAbsolute(given) ? given : `${cwd}/${given}`);
  if (text !== null) return { text };
  return existsSync(path.isAbsolute(given) ? given : `${cwd}/${given}`)
    ? unread(`the body file \`${given}\` is a device, a pipe, or a folder, not a regular file`)
    : unread(`the body file \`${given}\` does not exist yet`);
}

function hasSection(body, section) {
  const wanted = section.trim().toLowerCase();
  return [...unfencedLines(body)].some((line) => /^##\s/u.test(line) && line.slice(2).trim().toLowerCase() === wanted);
}

function deny(problem) {
  return `Blocked: ${problem}\nTo override for an explicit, user-confirmed reason, set ${OVERRIDE}=1 in your own shell before starting the session ` +
    "(agents must never set it on the user's behalf).";
}
