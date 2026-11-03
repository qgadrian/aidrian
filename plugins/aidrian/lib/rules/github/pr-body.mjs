// Bash rule: a pull request body written through `gh pr create` or `gh pr edit` has a `## ` heading for every section in
// config.json `github.requiredSections`, and no "Generated with [Claude Code]" footer. `gh pr create --fill` is refused:
// gh then writes the body from the commit messages. A non-web `gh pr create` with no --body or --body-file is refused
// too, when sections are configured: gh then takes the body from an editor, a prompt, or a template, unchecked.
// `--web` and `--help` pass. `gh pr edit` without a body flag passes (a title-only edit). A body flag whose body the
// rule cannot read (a variable, a substitution, stdin, a missing file) is refused when sections are configured. Runs only inside a project. A
// command substitution that runs, as in `url=$(gh pr create …)`, is read as the command line is. A leading `cd <dir> &&`
// moves the folder the body file and the project are read from; after any other directory change on the line, a relative
// body file is one the rule cannot read. A body file the same command line writes first, through `cat > file` or `tee
// file` fed a heredoc or a `cp` of a file the rule can read, is read as that command writes it (`lineWrites`), and
// `--body-file -` reads the heredoc fed to gh itself: the file does not exist yet when the hook runs.
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

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../../config.mjs';
import { runGh } from '../../gh.mjs';
import { runGit } from '../../git.mjs';
import { headings, sectionItems, unfencedLines } from '../../markdown-sections.mjs';
import { findProject, stateDir } from '../../project.mjs';
import { lexCommand, readInvocation, readShortOptions, walkCommands } from '../../shell-lex.mjs';

export const OVERRIDE = 'AIDRIAN_ALLOW_PR_BODY';

const FOOTER = /Generated with \[Claude Code\]/u;
const FILL = new Set(['--fill', '--fill-first', '--fill-verbose', '-f']);
// The short options of `gh pr create` and `gh pr edit` that take a value; -d, -e, -f, and -w are switches.
const SHORT_VALUES = new Set(['-a', '-B', '-b', '-F', '-H', '-l', '-m', '-p', '-r', '-R', '-T', '-t']);
// The canonical heredoc form, `--body "$(cat <<'EOF' … EOF)"`, and only it, since another command may print something
// else, read from the raw command: the token holding it is
// dynamic, and its text has lost the body's quotes. -b takes it attached too, or at the end of a cluster. The
// substitution must be the whole word and hold only the heredoc. Group 4 is the body.
const BODY_HEREDOC = /(?:--body(?:=|\s+)|-[A-Za-z]*b=?\s*)(?<quote>"?)\$\(\s*cat\s*<<-?\s*(['"]?)(\w+)\2\r?\n([\s\S]*?)\r?\n[ \t]*\3[ \t]*\r?\n?[ \t]*\)\k<quote>(?=\s|$|[;&|)])/gu;

// Shared temp folders: concurrent sessions write the same names there, and one session's body can publish as another's.
const SHARED_TEMP = ['/tmp/', '/private/tmp/', '/var/tmp/', '/private/var/tmp/', '/var/folders/', '/private/var/folders/'];
// How long the open pull request lookup of `duplicateBody` may take, inside the hook's 5 s.
const LIST_TIMEOUT_MS = 3000;

// The deny reason for `command`, or null. `listOpenPrs(repo)` returns [{ number, body }] or null; it is the test seam
// of the one check that leaves the process.
export function check(command, { cwd = process.cwd(), env = process.env, listOpenPrs = openPrBodies(cwd) } = {}) {
  if (env[OVERRIDE] === '1') return null;
  // Each gh call with the folder it runs in (shell-lex `walkCommands`), in substitutions and inline shells too:
  // `cd <worktree> && gh pr create --body-file b.md` reads that worktree's b.md and project. In a folder this rule
  // cannot know, the project is the session's and a relative body file is unreadable. Each call takes its own heredoc
  // from readPrCalls on its line.
  const pending = new Map();
  const writes = lineWrites(command);
  for (const entry of walkCommands(command, cwd)) {
    const { segment, folder, line } = entry;
    if (!readPrCall(segment)) {
      writes.note(entry);
      continue;
    }
    // The same line text can run again, as two identical `sh -c` bodies do: a spent queue starts over.
    if (!pending.get(line)?.length) pending.set(line, readPrCalls(line));
    const call = pending.get(line).shift();
    if (call) {
      call.stdin = stdinBody(entry);
      call.bodyFile = writes.token(call.bodyFile, entry);
      call.bodyOverwritten = writes.overwrites(entry, call.bodyFile);
      const reason = judge(call, line, { cwd: folder ?? cwd, folderKnown: folder !== null, env, written: writes.files, listOpenPrs: folder === null || folder === cwd ? listOpenPrs : openPrBodies(folder) });
      if (reason) return reason;
    }
    // Its own output can rewrite a body file a later gh call reads: `gh pr create … > b.md`.
    writes.note(entry);
  }
  return null;
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

const readText = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

// A heredoc match's body (group 4) as bash passes it: as written under a quoted delimiter (group 2), or under a bare one
// when it holds nothing bash expands (`$`, a backtick, or a backslash); else null, a body no rule can know.
export const unchangedHeredoc = (match) => (match[2] || !/[$`\\]/u.test(match[4]) ? match[4] : null);

// Every `gh pr create|edit` call of one command line, in order, as readPrCall reads it, with `heredoc`: the body of the
// heredoc its dynamic --body holds. The n-th dynamic body takes the line's n-th body heredoc, and only when the counts
// match: otherwise no dynamic body is read, so one call's heredoc never stands in for another's. A heredoc under a bare
// delimiter that holds `$`, a backtick, or a backslash is expanded by bash, so it is not read either.
export function readPrCalls(line) {
  const calls = lexCommand(line).map((segment) => readPrCall(segment)).filter(Boolean);
  const dynamic = calls.filter((call) => call.body?.dynamic);
  const heredocs = [...line.matchAll(BODY_HEREDOC)].map(unchangedHeredoc);
  dynamic.forEach((call, i) => {
    call.heredoc = heredocs.length === dynamic.length ? heredocs[i] : null;
  });
  return calls;
}

// { subcommand, fill, draft, body, bodyFile, title, repo, target, head, base, dryRun } for a `gh [-R repo] pr create|edit …` segment, else null.
// Later flags win, as in gh. `title`, `repo`, `head`, and `base` are tokens; `target` is the first positional (the pull request an edit
// names).
export function readPrCall(segment) {
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
  // `gh pr new` is gh's built-in alias for `gh pr create`.
  if (words[1] === 'new') words[1] = 'create';
  if (words[0] !== 'pr' || !['create', 'edit'].includes(words[1])) return null;
  const call = { subcommand: words[1], fill: false, draft: false, web: false, help, body: null, bodyFile: null, title: null, repo, target: null, head: null, base: null, dryRun: false };
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
      const explicit = split && !readShortOptions(`-${split[1]}`, SHORT_VALUES).value ? split : null;
      const { options, value } = readShortOptions(explicit ? `-${explicit[1]}` : text, SHORT_VALUES);
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
    else if (flag === '--body' || flag === '-b') [call.body, call.bodyFile] = [value(), null];
    else if (flag === '--body-file' || flag === '-F') [call.bodyFile, call.body] = [value(), null];
    else if (flag === '--title' || flag === '-t') call.title = value();
    else if (flag === '--head' || flag === '-H') call.head = value();
    else if (flag === '--base' || flag === '-B') call.base = value();
    else if (flag === '--repo' || flag === '-R') call.repo = value();
    else if (SHORT_VALUES.has(flag) || LONG_VALUES.has(flag)) value();
    else if (!text.startsWith('-') && call.target === null) call.target = args[i];
  }
  return call;
}

// A boolean option's value as gh (pflag) reads it: bare or a pflag true word is on, a false word is off. A value the
// rule cannot read is neither, so it grants no exemption.
const isTrue = (inline, dynamic = false) => inline === null || (!dynamic && /^(?:true|1|t|TRUE|True|T)$/u.test(inline));
const isFalse = (inline, dynamic = false) => inline !== null && !dynamic && /^(?:false|0|f|FALSE|False|F)$/u.test(inline);

// The long options of `gh pr create` and `gh pr edit` that take a value, so their value is never read as the target.
const LONG_VALUES = new Set([
  '--assignee', '--base', '--head', '--label', '--milestone', '--project', '--reviewer', '--template', '--recover', '--attach',
  '--add-assignee', '--remove-assignee', '--add-label', '--remove-label', '--add-project', '--remove-project',
  '--add-reviewer', '--remove-reviewer',
]);

function judge(call, command, { cwd, folderKnown = true, env, written = new Map(), listOpenPrs }) {
  const project = findProject(cwd);
  if (!project) return null;
  const { config } = loadConfig(project);
  const contract = config.github.pullRequest;
  if (call.help) return null;
  const state = () => stateFolder(project, config, env);
  const steps = () => twoSteps(bodyFilePath(state(), call, folderKnown ? cwd : null), call);
  if (call.fill && call.subcommand === 'create') {
    return deny(`\`--fill\` writes the body from the commit messages, without the sections config.json \`github.requiredSections\` asks for. ${steps()}`);
  }
  if (contract.sharedTempBodyFile && call.bodyFile && call.bodyFile.text !== '-' && isSharedTemp(call.bodyFile.text, cwd, env, project.root, state)) {
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
    return deny('the body is one this rule cannot read: a variable, a command substitution, stdin without a heredoc, or a file that ' +
      `does not exist yet. ${steps()} A file that another command on this line edits, such as \`sed -i\` or a script, counts as ` +
      'not there yet: run gh as its own command after it. Never pass the path through `$(…)` or a variable, or the sections ' +
      'config.json `github.requiredSections` asks for go unchecked.');
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
  const wanted = new RegExp(pattern.replaceAll('{types}', types).replaceAll('{issueKey}', `(?:${issueKey ?? '(?!)'})`), 'u');
  if (!wanted.test(token.text)) {
    return deny(`the title "${token.text}" does not match config.json \`github.pullRequest.title\`: ${pattern} ` +
      `({types} is ${config.git.commits.types.join('|')}${issueKey ? `, {issueKey} is ${issueKey}` : ''}).`);
  }
  if (issueKeyPattern(issueKey)?.test(token.text.replace(/^\[[^\]]*\]/u, ''))) {
    return deny('the title names an issue key outside its leading [...] bracket, which links the pull request to an issue it ' +
      'does not implement. Move the key into the bracket if this pull request implements it; otherwise reword the title without it.');
  }
  return null;
}

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
function stateFolder(project, config, env) {
  try {
    return stateDir(project, { config, env });
  } catch {
    return null;
  }
}

// The body file the pr-write skill writes, `<state>/tmp/pr-body-<branch>.md`, as { file, note }: the literal path, and
// what its placeholders mean, or ''. The branch is the call's static --head, or the one checked out where gh runs. A part
// it cannot know stays a placeholder.
export function bodyFilePath(state, call, cwd) {
  const head = call.head && !call.head.dynamic ? call.head.text.replace(/^[^:]*:/u, '') : null;
  let branch = head || null;
  if (!branch && cwd !== null) {
    const result = runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd);
    branch = result.status === 0 ? result.stdout.trim() || null : null;
  }
  const file = `pr-body-${branch ? branch.replaceAll('/', '-') : '<branch>'}.md`;
  const notes = [state ? null : '`<state>` is the folder `aidrian state` prints', branch ? null : '`<branch>` is the branch name with each `/` replaced by `-`'];
  const known = notes.filter(Boolean);
  return { file: state ? path.join(state, 'tmp', file) : `<state>/tmp/${file}`, note: known.length ? ` (${known.join('; ')})` : '' };
}

// The two steps that pass, for a deny about where the body comes from: write the body to the one file, then hand gh
// that path written out. The heredoc form is the one `lineWrites` reads in the same command.
function twoSteps({ file, note }, call) {
  const target = call.subcommand === 'edit' && call.target && !call.target.dynamic ? ` ${call.target.text}` : '';
  return `Do this instead: 1. write the body to \`${file}\`${note}, with the file tool or with \`cat > ${file} <<'EOF'\` ` +
    `earlier in this command; 2. run \`gh pr ${call.subcommand}${target} --body-file ${file}\`, the path written out (the pr-write skill).`;
}

// The open pull requests' bodies through gh, or null when gh cannot answer in time.
function openPrBodies(cwd) {
  return (repo) => {
    const args = ['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number,body', ...(repo ? ['--repo', repo] : [])];
    try {
      return JSON.parse(runGh(args, { cwd, exec: (file, argv, options) => execFileSync(file, argv, { ...options, timeout: LIST_TIMEOUT_MS }) }));
    } catch {
      return null;
    }
  };
}

// The body text, or null when this rule cannot know it. A null `cwd` is a folder it cannot know: only an absolute body
// file reads. A dynamic --body reads the heredoc readPrCalls gave the call, `--body-file -` the heredoc check gave it as
// `stdin`, and a file the line wrote earlier the text `written` (lineWrites) holds for it.
export function readBody(call, cwd, written = new Map()) {
  if (call.bodyOverwritten) return null;
  if (call.body) return call.body.dynamic ? call.heredoc ?? null : call.body.text;
  if (!call.bodyFile || call.bodyFile.dynamic) return null;
  if (call.bodyFile.text === '-') return call.stdin ?? null;
  if (cwd === null && !path.isAbsolute(call.bodyFile.text)) return null;
  const file = resolveIn(cwd, call.bodyFile.text);
  if (written.has(file)) return written.get(file);
  try {
    // Joined, not resolved: the filesystem follows a symlink before a `..`, as gh opens the operand.
    const file = call.bodyFile.text;
    return readFileSync(path.isAbsolute(file) ? file : `${cwd}/${file}`, 'utf8');
  } catch {
    return null;
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
