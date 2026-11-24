// Bash rule: a pull request body written through `gh pr create` or `gh pr edit` has a `## ` heading for every section in
// config.json `github.requiredSections`, and no "Generated with [Claude Code]" footer. `gh pr create --fill` is refused:
// gh then writes the body from the commit messages. A non-web `gh pr create` with no --body or --body-file is refused
// too, when sections are configured: gh then takes the body from an editor, a prompt, or a template, unchecked.
// `--web` and `--help` pass. `gh pr edit` without a body flag passes (a title-only edit). A body flag whose body the
// rule cannot read (a variable, a substitution, stdin, a missing file, a device or a pipe, a file the line edits first)
// is refused when sections are configured, naming the one cause that applies (`bodyRead`). Runs only inside a project. A
// command substitution that runs, as in `url=$(gh pr create …)`, is read as the command line is. A leading `cd <dir> &&`
// moves the folder the body file and the project are read from; after any other directory change on the line, a relative
// body file is one the rule cannot read. A body file the same command line writes first, through `cat > file` or `tee
// file` fed a heredoc or a `cp` of a file the rule can read, is read as that command writes it (`lineWrites`), and
// `--body-file -` reads the heredoc fed to gh itself: the file does not exist yet when the hook runs.
//
// A call answers to the repository it targets. The project is the one the folder gh runs in finds (`chained` in
// shell-lex walkCommands). Where that folder cannot be known, a call that posts text is refused with the folder-written-out
// form (`unreadDestination`), and the session's project stands in only for one that names the session's repository. A call that names a repository
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

import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../../config.mjs';
import { forgeFor } from '../../forges/index.mjs';
import { claimProblem, passClaims, readCheckRuns, unsupportedClaims } from '../../check-runs.mjs';
import { runGit } from '../../git.mjs';
import { headings, sectionItems, unfencedLines } from '../../markdown-sections.mjs';
import { findProject, projectCheckouts, stateDir } from '../../project.mjs';
import { sessionFolder } from '../../session-folder.mjs';
import { remoteRepos, repoName } from '../../review-gate.mjs';
import { boundedSearch, timeBudget } from '../../bounded-regexp.mjs';
import { lexPipeline, readInvocation, readShortOptions, shellWord, walkCommands } from '../../shell-lex.mjs';
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
export function check(command, { cwd = process.cwd(), env = process.env, listOpenPrs = openPrBodies(cwd), input = {}, readRuns = sessionRuns(input) } = {}) {
  if (env[OVERRIDE] === '1') return null;
  for (const { call, entry, written } of bodyCalls(command, cwd)) {
    const { folder, chained, line } = entry;
    const unread = unreadDestination(call, entry, cwd, env);
    if (unread) return deny(unread);
    const reason = judge(call, line, { cwd: folder ?? cwd, projectFolder: chained ?? cwd, ghRepo: invocationRepo(entry.invocation.environment, env), folderKnown: folder !== null, env, written, listOpenPrs: chained === null || chained === cwd ? listOpenPrs : openPrBodies(chained), readRuns });
    if (reason) return withFolderNote(reason, entry, cwd);
  }
  return null;
}

// A deny under the session's rules for a call whose project this rule cannot read from the folder gh runs in: after a
// `cd` joined to gh by a `;` or a newline rather than `&&` alone, which gh runs past when the `cd` fails, or a folder a
// variable holds, as in `env -C "$W"` or `cd "$W" &&`. The reason says whose rules they are, and the form that answers
// to another project's, a folder written out, so a refusal never reads as that project's config. A leading `cd` into
// another project is named.
function withFolderNote(reason, { folder, chained }, cwd) {
  if (chained !== null) return reason;
  const own = findProject(cwd);
  if (!own) return reason;
  const there = folder === null ? null : findProject(folder);
  if (there?.root === own.root) return reason;
  const into = there ? `the \`cd\` into ${folder} is joined to gh by a \`;\` or a newline, not \`&&\` alone, so gh runs in the session's folder when it fails`
    : 'the folder gh runs in is one this rule cannot read, such as one a variable holds, or one after a `cd` joined to gh by a `;` or a newline';
  const word = there ? shellWord({ text: folder, dynamic: false }) : '<the folder, written out>';
  const note = ` These are the rules of ${own.root}, the session's project: ${into}. For another project's rules, run \`env -C ${word} gh …\`.`;
  const at = reason.indexOf('\nTo override');
  return at < 0 ? `${reason}${note}` : `${reason.slice(0, at)}${note}${reason.slice(at)}`;
}

// Why the gh call `call` (readBodyCall), run as the walkCommands entry `entry` from a session whose folder `cwd` lies in
// a project, may not post: the folder gh runs in is one this rule cannot read (`chained` null), so the rules of the
// repository it posts to, its public text patterns, private words, pull request contract, and attribution, are not
// known, and the session's own never stand in for them. The answer names the form that is read, the folder written out.
// null for a call that names its repository (-R, a URL target, GH_REPO), which is judged as that name says
// (targetsAnotherRepo), one that posts no text, a help, web, or dry run, a session in no project, and a leading `cd`
// into the session's own project: gh then runs there or, when that `cd` fails, in the session's folder, both under the
// same rules. The pull request body, public text, and attribution rules each refuse with it.
export function unreadDestination(call, entry, cwd, env = process.env) {
  if (entry.chained !== null || call.help || call.web || call.dryRun || call.deleteLast || !postsText(call)) return null;
  const ghRepo = invocationRepo(entry.invocation.environment, env);
  const named = targetUrl(call) ?? call.repo ?? (ghRepo ? { text: ghRepo, dynamic: false } : null);
  if (named && !named.dynamic && repoName(named.text) !== null) return null;
  const own = findProject(cwd);
  if (!own) return null;
  const there = entry.folder === null ? null : findProject(entry.folder);
  if (there?.root === own.root) return null;
  const word = there ? shellWord({ text: entry.folder, dynamic: false }) : '<the folder, written out>';
  const cause = there
    ? `the \`cd\` into ${entry.folder} is joined to gh by a \`;\` or a newline, not \`&&\` alone, so gh may post from the session's folder instead`
    : 'gh runs in a folder this hook cannot read, such as one a variable holds, or one after a `cd` joined to gh by a `;` or a newline';
  return `${cause}, and the rules of the repository it posts to cannot be read. Its public text patterns, private words, pull request contract, ` +
    `and attribution go unchecked, and the rules of ${own.root}, the session's project, never stand in for them. ` +
    `Write the folder out, as \`env -C ${word} gh …\` or \`cd ${word} && gh …\`.`;
}

// Whether the gh call `call` posts text: a create or a comment always does, through an editor or a prompt when given no
// body; an edit, a close, a reopen, or a merge only with a body or a title.
const postsText = (call) => ['create', 'comment'].includes(call.subcommand) || call.fill || call.body !== null || call.bodyFile !== null || call.title !== null;

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
  // A word the command reads resolves in the folder it runs in, and a redirect's target in its shell's, which opens it
  // before a wrapper such as `env -C` moves (shell-lex walkCommands `shell`).
  const fileOf = (each, entry, folder = entry.folder) => {
    const known = token(each, entry);
    return known && !known.dynamic && known.text && known.text !== '-' ? joinedIn(folder, known.text) : null;
  };
  const targetOf = (each, entry) => fileOf(each, entry, entry.shell === undefined ? entry.folder : entry.shell);
  // `files` is keyed by each file's identity (fileIdentity), so two names of one file, through a link or a second hard
  // link, are one entry; a path whose identity cannot be told is no key, and a write to one may be to any file.
  const same = (a, b) => a !== null && b !== null && mayAlias(fileIdentity(a), fileIdentity(b));
  const outputs = (segment) => segment.flatMap((each, i) => (each.operator && each.operator !== '<' && !segment[i + 1]?.fdDup ? [[each, segment[i + 1]]] : []));
  const overwrites = (entry, file) => {
    const body = file ? fileOf(file, entry) : null;
    return body !== null && outputs(entry.segment).some(([, each]) => {
      const target = targetOf(each, entry);
      return target === null || fileIdentity(target) === null || same(target, body);
    });
  };
  const note = (entry) => {
    const { segment, invocation, folder, heredocs = [] } = entry;
    const at = (each) => fileOf(each, entry);
    const opened = (each) => targetOf(each, entry);
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
      [target, text] = [opened(redirects[0][1]), stdinBody(entry)];
    } else if (program === 'tee' && args.length === 1 && !args[0].text.startsWith('-')) {
      target = at(args[0]);
      // A redirect of its own output onto the same file races the write, and so may one the rule cannot place: what
      // lands there is unknown.
      text = target !== null && redirects.some(([, each]) => {
        const out = opened(each);
        return out === null || fileIdentity(out) === null || same(out, target);
      }) ? null : stdinBody(entry);
    } else if (program === 'cp' && !redirects.length) {
      const operands = args.filter((arg) => !/^-[fpv]+$/u.test(arg.text));
      const source = operands.length === 2 && !operands[0].text.startsWith('-') ? at(operands[0]) : null;
      target = source === null || operands[1].text.endsWith('/') ? null : at(operands[1]);
      if (target !== null && isDirectory(target)) target = null;
      else if (target !== null) {
        const from = fileIdentity(source);
        const before = from === null ? { text: null } : writtenText(files, from);
        text = before ? before.text : readText(source);
      }
    }
    const unknown = () => {
      for (const known of files.keys()) files.set(known, null);
    };
    // A write to `file` with `value`: to its identity, or, for a file whose identity cannot be told, to any file.
    const write = (file, value) => {
      const key = fileIdentity(file);
      if (key === null) return unknown();
      // Another spelling of the name may be this very file.
      for (const known of files.keys()) if (known !== key && mayAlias(known, key)) files.set(known, null);
      files.set(key, value);
    };
    // A command that is neither a known reader nor one of the writes above may change any file: a script, `sed -i`, or
    // a program fed its own code on stdin.
    if (target === null && !isReader(invocation)) {
      unknown();
      // A file it names on disk is one it may change too.
      for (const each of segment) {
        const file = each.operator || each.fdDup ? null : at(each);
        if (file !== null) write(file, null);
      }
    }
    for (const [, each] of redirects) {
      const file = opened(each);
      if (file !== null) write(file, null);
      else unknown();
    }
    if (target !== null) write(target, text);
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

// A path joined as the system opens it, a link followed before a `..` after it, never normalized first.
const joinedIn = (folder, file) => (path.isAbsolute(file) ? file : folder === null ? null : `${folder}/${file}`);

// The identity of the file the absolute path `file` names, for telling two names of one file apart, or null when it
// cannot be told: an existing file's device and inode, so a second hard link is the same file; else the real path of
// the part of the path that exists, as the system resolves it, each link before a `..` after it (realpathSync.native,
// never Node's own, which drops a `..` first), a link at the end of that part, even one whose target is not there yet,
// followed in turn, with the rest joined on, in the case it was spelled. A read that fails, or more links than
// LINK_HOPS, gives null. Whether a disk folds case is not told from here, so two spellings of a name are neither one
// file nor two: a write to either makes the other unknown, and a read of one never takes the other's text (writtenText).
export function fileIdentity(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
  const gone = (error) => ['ENOENT', 'ENOTDIR'].includes(error?.code);
  let head = file;
  const rest = [];
  for (let hops = 0; hops <= LINK_HOPS; hops += 1) {
    try {
      const real = realpathSync.native(head);
      if (rest.length === 0) {
        const stat = statSync(real);
        if (!stat.isDirectory()) return `inode:${stat.dev}:${stat.ino}`;
      }
      return path.join(real, ...rest);
    } catch (error) {
      if (!gone(error)) return null;
    }
    let link = null;
    try {
      if (lstatSync(head).isSymbolicLink()) link = readlinkSync(head);
    } catch (error) {
      if (!gone(error)) return null;
    }
    if (link !== null) {
      head = path.isAbsolute(link) ? link : `${path.dirname(head)}/${link}`;
      continue;
    }
    const parent = path.dirname(head);
    if (parent === head) return path.join(head, ...rest);
    rest.unshift(path.basename(head));
    head = parent;
  }
  return null;
}
const LINK_HOPS = 40;

// Whether two identities (fileIdentity) may be one file: the same, or, for names that are no file yet or below a
// folder, the same but for letter case, which a disk that folds it reads as one name.
const mayAlias = (a, b) => a !== null && b !== null && (a === b || (!a.startsWith('inode:') && !b.startsWith('inode:') && a.toLowerCase() === b.toLowerCase()));

// What the line wrote to the file of identity `key`, from `written` (lineWrites files): { text } when it holds that
// file's text, { text: null } when a write it cannot read, or one to a name that may be the same file, came before,
// and null when the line wrote neither.
function writtenText(files, key) {
  if (files.has(key)) return { text: files.get(key) };
  for (const known of files.keys()) if (mayAlias(known, key)) return { text: null };
  return null;
}

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

function judge(call, command, { cwd, projectFolder, ghRepo, folderKnown = true, env, written = new Map(), listOpenPrs, readRuns = () => null }) {
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
  const { text: body, unread: why } = bodyRead(call, folderKnown ? cwd : null, written);
  if (why && sectioned) {
    const { cause, fix } = why;
    return deny(`the body is one this rule cannot read: ${cause}, so the sections config.json \`github.requiredSections\` asks for go unchecked. ` +
      `${fix ? `${fix} ` : ''}${steps()}`);
  }
  const reason = body === null ? null : judgeBody(body, config) ?? judgeEvidence(body, call, { config, project, folder: folderKnown ? cwd : projectFolder, readRuns, listOpenPrs })
    ?? judgeDuplicate(body, call, contract, listOpenPrs);
  return reason ?? judgeTitle(call.title, config);
}

// The `## Tests run` lines that say a test command passed, each needing a run of it on the session's check-run record
// that passed at the tree of HEAD in `folder`, or of the commit the line names ("at 056c3c2"), with the counts the line
// states (lib/check-runs.mjs). `readRuns(project, config)` gives the record's rows, or null when this session has none
// it can read: then nothing is judged, nor is a line whose tree git cannot give. The record is of this checkout, so a
// body for another branch is not judged (`ownBranch`), and an edit judges only the lines its pull request's body lacks.
function judgeEvidence(body, call, { config, project, folder, readRuns, listOpenPrs }) {
  let claims = passClaims(body, { testing: config.testing });
  if (!claims.length) return null;
  const runs = readRuns(project, config);
  if (runs === null) return null;
  const own = ownBranch(call, folder, listOpenPrs);
  if (!own) return null;
  if (own.body !== null) {
    const old = new Set(passClaims(own.body, { testing: config.testing }).map(({ clause, key }) => `${key}\n${clause}`));
    claims = claims.filter(({ clause, key }) => !old.has(`${key}\n${clause}`));
  }
  const trees = new Map();
  const treeAt = (commit) => {
    if (!trees.has(commit)) {
      const read = runGit(['rev-parse', '--verify', '--quiet', `${commit}^{tree}`], folder);
      trees.set(commit, read.status === 0 ? read.stdout.trim() : null);
    }
    return trees.get(commit);
  };
  // Digits alone git cannot read are a number, such as "at 1234567 ms", and leave the line to HEAD's tree.
  const missing = claims.filter((claim) => {
    const named = claim.commits.filter((id) => /[a-f]/u.test(id) || treeAt(id) !== null).at(-1);
    const tree = treeAt(named ?? 'HEAD');
    return tree !== null && unsupportedClaims([claim], runs, { tree }).length > 0;
  });
  if (!missing.length) return null;
  return deny(`${claimProblem(missing, runs, { where: 'the `## Tests run` section' })} The run must be of the files of HEAD ` +
    `(tree ${String(treeAt('HEAD') ?? 'unknown').slice(0, 12)}), or of the commit the line names, such as "at <commit id>". ` +
    `Unclaimed lines: ${missing.map(({ clause }) => `"${excerpt(clause)}"`).join(', ')}.`);
}

// Whether the body is for the branch checked out in `folder`, as { body }: the pull request's current body on an edit
// the open list holds, else null. Null when it is for another branch, or an edit of a pull request the list cannot
// show: a `--head` that names another branch, or a pull request whose head is another branch. Several open pull requests
// the edit's branch name fits, which nothing settles, leave the body null, so every clause is judged.
function ownBranch(call, folder, listOpenPrs) {
  const read = runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], folder);
  const branch = read.status === 0 ? read.stdout.trim() : null;
  if (!branch) return null;
  if (call.subcommand === 'create') {
    if (call.head?.dynamic) return null;
    const head = call.head?.text?.replace(/^[^:]+:/u, '') ?? branch;
    return head === branch ? { body: null } : null;
  }
  const target = editTarget(call);
  if (!target) return null;
  let open = null;
  try {
    open = listOpenPrs(call.repo?.text ?? null);
  } catch {
    open = null;
  }
  const named = namedPulls(open, target, branch);
  if (named.length === 1) {
    const [pull] = named;
    if (pull.headRefName !== branch) return null;
    return { body: typeof pull.body === 'string' ? pull.body : null };
  }
  if (named.length > 1) return named.every((pr) => pr.headRefName === branch) ? { body: null } : null;
  // No list, or no such open pull request: an edit of this branch's own pull request is still this branch's.
  return target.number === undefined && (target.head ?? branch) === branch ? { body: null } : null;
}

// The pull request an edit names, as gh reads its target: { number } for a number or a pull request URL (targetUrl),
// else { head, owner } for a branch name, `feat/x` or `owner:feat/x`, with `head` null for no target, the checked-out
// branch's. `team/pull/3` is a branch name. Null for a target the rule cannot read.
function editTarget(call) {
  if (call.target?.dynamic) return null;
  const text = call.target?.text ?? '';
  if (/^#?\d+$/u.test(text)) return { number: Number(text.replace('#', '')) };
  const url = targetUrl(call)?.text;
  if (url) return { number: Number(/\/pull\/(\d+)(?:[/?#]|$)/u.exec(url)[1]) };
  if (text === '') return { head: null, owner: null };
  const owned = /^([^:/]+):(.+)$/u.exec(text);
  return owned ? { head: owned[2], owner: owned[1] } : { head: text, owner: null };
}

// The open pull requests of `open` that `target` (editTarget) fits: the one of its number, or each whose head branch
// is its branch name (`branch` for none) and, for an `owner:` name, whose head repository that owner holds. [] with no list.
function namedPulls(open, target, branch) {
  if (!Array.isArray(open)) return [];
  if (target.number !== undefined) return open.filter((pr) => pr?.number === target.number);
  const head = target.head ?? branch;
  const owner = target.owner?.toLowerCase() ?? null;
  return open.filter((pr) => pr?.headRefName === head && (owner === null || pr?.headRepositoryOwner?.login?.toLowerCase() === owner));
}

// The check-run rows of the session `input` names, through its session folder, or null when it has none.
export function sessionRuns(input) {
  return (project, config) => {
    if (typeof input?.session_id !== 'string') return null;
    const folder = sessionFolder(stateDir(project, { config }), input.session_id, { checkouts: projectCheckouts(project) });
    return folder ? readCheckRuns(folder) : null;
  };
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
// Only where the target is known: a create, or an edit that names its pull request by number, URL, or a branch name
// that one open pull request alone fits (editTarget, namedPulls). Fails open.
function judgeDuplicate(body, call, contract, listOpenPrs) {
  if (!contract.duplicateBody || body.trim() === '' || call.repo?.dynamic) return null;
  const target = call.subcommand === 'edit' ? editTarget(call) : null;
  if (call.subcommand === 'edit' && (!target || target.head === null)) return null;
  // Without -R, a pull request URL names the repository the edit goes to.
  const urlRepo = target?.number === undefined ? null : /github\.com\/([^/]+\/[^/]+)\/pull\//u.exec(targetUrl(call)?.text ?? '')?.[1] ?? null;
  let open;
  try {
    open = listOpenPrs(call.repo?.text ?? urlRepo);
  } catch {
    return null;
  }
  let self = null;
  if (target) {
    const named = namedPulls(open, target, null);
    if (target.number === undefined && named.length !== 1) return null;
    self = target.number ?? named[0].number;
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
  // Once a repository per hook: the evidence check and the duplicate check may both ask.
  const listed = new Map();
  return (repo) => {
    if (!listed.has(repo)) {
      try {
        listed.set(repo, forge.openChanges(200, 'number,body,headRefName,headRepositoryOwner', { repo }));
      } catch {
        listed.set(repo, null);
      }
    }
    return listed.get(repo);
  };
}

// The body text, or null when this rule cannot know it. A null `cwd` is a folder it cannot know: only an absolute body
// file reads. A dynamic --body reads the heredoc readPrCalls gave the call, `--body-file -` the heredoc check gave it as
// `stdin`, and a file the line wrote earlier the text `written` (lineWrites) holds for it.
export const readBody = (call, cwd, written = new Map()) => bodyRead(call, cwd, written).text;

const unread = (cause, fix = '') => ({ text: null, unread: { cause, fix } });

// The body as { text, unread } from one read: `text` as readBody gives it, and when it is null for a call with a body
// flag, `unread` as { cause, fix }, the cause a deny names first and the one step it needs beyond the two that pass, or
// ''. A rule that refuses an unread body takes both from this one call: a second read could find a file the first did
// not, and leave the text unchecked with no cause to refuse it. The pull request body, public text, and attribution rules
// refuse with it, so the first deny names the form that passes.
export function bodyRead(call, cwd, lineFiles = new Map()) {
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
  // Only a line that wrote files asks which file this is: the read below is then the one look at it.
  const file = lineFiles.size ? fileIdentity(joinedIn(cwd, given)) : null;
  if (file === null && lineFiles.size) {
    return unread(`the body file \`${given}\` is one whose identity the hook cannot tell, so whether another command on this line writes it first cannot be told`, 'Run that command first, then gh as its own command.');
  }
  const before = file === null ? null : writtenText(lineFiles, file);
  if (before) {
    const { text } = before;
    return text !== null ? { text } : unread('another command on this line changes the body file before gh reads it, such as a script or `sed -i`, ' +
      'or a redirect', 'Run that command first, then gh as its own command.');
  }
  // Joined, not resolved: the filesystem follows a symlink before a `..`, as gh opens the operand.
  const read = bodyFileText(path.isAbsolute(given) ? given : `${cwd}/${given}`);
  if (read.text !== undefined) return { text: read.text };
  if (read.missing) return unread(`the body file \`${given}\` does not exist yet`);
  if (read.notFile) return unread(`the body file \`${given}\` is a device, a pipe, or a folder, not a regular file`);
  return unread(`the body file \`${given}\` is a regular file the hook cannot open (${read.error})`, 'Check its permissions.');
}

// A body file's text from one stat, as { text }, or what kept it: { missing }, { notFile } for a device, a FIFO, or a
// folder (reading one can hang the hook, or read as empty and pass), or { error } with the code of a failed read.
function bodyFileText(file) {
  let stat;
  try {
    stat = statSync(file);
  } catch (error) {
    return ['ENOENT', 'ENOTDIR'].includes(error?.code) ? { missing: true } : { error: error?.code ?? 'an unknown error' };
  }
  if (!stat.isFile()) return { notFile: true };
  try {
    return { text: readFileSync(file, 'utf8') };
  } catch (error) {
    return { error: error?.code ?? 'an unknown error' };
  }
}

function hasSection(body, section) {
  const wanted = section.trim().toLowerCase();
  return [...unfencedLines(body)].some((line) => /^##\s/u.test(line) && line.slice(2).trim().toLowerCase() === wanted);
}

function deny(problem) {
  return `Blocked: ${problem}\nTo override for an explicit, user-confirmed reason, set ${OVERRIDE}=1 in your own shell before starting the session ` +
    "(agents must never set it on the user's behalf).";
}
