// `aidrian test changed`: runs the test files a change touches, the local check the push-first rule
// (lib/rules/push-first.mjs, docs/hooks.md#push-first) names instead of a full suite, which CI runs on the pushed head.
// The change is the checkout's files against `--base`, else the branch's remote copy while it is not at HEAD, else the
// merge base with the default branch on `origin`: committed, uncommitted, and untracked files that git does not ignore. A test file it touches
// is one the change itself adds or edits, one that names a changed file (needlesOf), or a Go `_test.go` beside a changed
// `.go` file. A nested package's tests are left out, since its own runner runs them. With no `testing.changedCommand`, the
// files go to `node --test`, so a test file must also be a module node loads with no flag (NODE_MODULE); any other file
// in a test folder, such as a fixture, is an input, and its tests are the ones that name it. A configured command gets
// every changed file in a test folder that is a file on disk, outside a nested package, as it is, with no search for its users. With nothing to run it prints the
// node runner's zero summary, so its row shows no test passed, and supports no claim.
// The command is config.json `testing.changedCommand`, else `npm test --` when package.json has a test script, with the
// files after it; its exit status is the command's. When that command ends in jest or `node --test` (testRunner), which
// read a file as a pattern, each file goes with its pattern characters escaped as that runner reads them (literalPattern), so a path such as
// `app/[org]/page.test.ts` runs its tests.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { CODE_FILE, commandKey, TEST_FILE } from './check-runs.mjs';
import { commandConfig } from './config.mjs';
import { isFile } from './fs.mjs';
import { currentRoot, runGit } from './git.mjs';
import { findProject } from './project.mjs';
import { remoteCopy } from './rules/push-first.mjs';
import { lexPipeline, readInvocation } from './shell-lex.mjs';

export { TEST_FILE };

// A module `node --test` loads on every supported Node with no flag; a TypeScript project sets `testing.changedCommand`.
export const NODE_MODULE = /\.[cm]?js$/u;

const lines = (result) => (result.status === 0 ? result.stdout.split('\n').map((line) => line.trim()).filter(Boolean) : null);

// The base the change is read against, as a revision, or null when none can be found. A remote copy at HEAD, as on a
// branch just pushed, holds the whole change already, so the base is then the merge base, as with no remote copy, and
// the remote copy only when git finds no merge base.
export function changeBase(root, { base = null, defaultBranch = 'main', git = runGit } = {}) {
  if (base) return base;
  const copy = remoteCopy(root, git);
  const commit = (ref) => {
    const read = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], root);
    return read.status === 0 ? read.stdout.trim() : null;
  };
  if (copy && commit(copy.ref) !== commit('HEAD')) return copy.ref;
  const merged = git(['merge-base', 'HEAD', `refs/remotes/origin/${defaultBranch}`], root);
  return merged.status === 0 ? merged.stdout.trim() : (copy?.ref ?? null);
}

// The files the change touches, from the checkout's top, or null when git cannot say.
export function changedFiles(root, base, git = runGit) {
  const diffed = lines(git(['diff', '--name-only', '--no-renames', base, '--'], root));
  const untracked = lines(git(['ls-files', '--others', '--exclude-standard'], root));
  return diffed && untracked ? [...new Set([...diffed, ...untracked])].sort() : null;
}

// A script named as a test, which no other test imports. A module in a test folder named otherwise, such as a helper, is
// one tests import, and a fixture named like a test, such as `expected.test.json` or a `.jsx` one `node --test` does not
// load, one tests read: under the default runner their users are searched for too.
const NAMED_TEST = /(?:\.(?:test|spec)|_test)\.[cm]?[jt]sx?$/u;

// The words a test names a changed file by: a code file by its name, and by its name with no extension, as an import often
// writes it (`./check-runs`); `index.*` by its folder and name; a fixture in a test folder by its path and its name, as a
// test joins it to its folder; any other file by its path. touchedTests searches none for a file the runner runs itself.
export function needlesOf(file) {
  if (!CODE_FILE.test(file)) return TEST_FILE.test(file) ? [...new Set([file, path.posix.basename(file)])] : [file];
  const name = path.posix.basename(file);
  const stem = name.replace(/\.[^.]+$/u, '');
  const named = name.startsWith('index.') ? path.posix.join(path.posix.basename(path.posix.dirname(file)), name) : name;
  const short = name.startsWith('index.') ? path.posix.join(path.posix.basename(path.posix.dirname(file)), stem) : stem;
  return [...new Set([named, ...(short.length >= 4 ? [short] : [])])];
}

// The test files the change touches: the changed ones that still exist, then the ones that name a changed file. A test
// file in a nested package, a folder below the top with a package.json of its own, is left out: its own runner runs it.
// `nodeOnly`, for the default `npm test --` command, keeps only NODE_MODULE test files, and leaves Go to a configured command.
export function touchedTests(root, files, git = runGit, { nodeOnly = false } = {}) {
  const listed = lines(git(['ls-files', '--cached', '--others', '--exclude-standard'], root)) ?? [];
  const exists = new Set(listed);
  const packages = listed.filter((file) => file.includes('/') && path.posix.basename(file) === 'package.json').map((file) => `${path.posix.dirname(file)}/`);
  const isTest = (file) => TEST_FILE.test(file) && (!nodeOnly || NODE_MODULE.test(file));
  const ours = (file) => isTest(file) && !packages.some((folder) => file.startsWith(folder));
  // A file on disk too: git still lists a tracked file deleted, or replaced by a folder, until that is staged.
  const own = files.filter((file) => ours(file) && exists.has(file) && isFile(path.join(root, file)));
  // No search for the users of a file the active runner gets as a test: under a configured command any file of `own`, as it
  // is; under `nodeOnly`, one of them named as a test. A helper `nodeOnly` runs, or a file left out of `own`, is searched for.
  const runs = new Set(own.filter((file) => !nodeOnly || NAMED_TEST.test(file)));
  const needles = [...new Set(files.filter((file) => !runs.has(file)).flatMap(needlesOf))];
  // Go tests a package from the same folder, and names no file: every `_test.go` beside a changed `.go` file.
  const goFolders = new Set(files.filter((file) => file.endsWith('.go') && !file.endsWith('_test.go')).map((file) => path.posix.dirname(file)));
  const beside = nodeOnly ? [] : listed.filter((file) => file.endsWith('_test.go') && goFolders.has(path.posix.dirname(file)));
  const named = needles.length
    ? lines(git(['grep', '--no-recurse-submodules', '--untracked', '-l', '-F', ...needles.flatMap((needle) => ['-e', needle]), '--'], root)) ?? []
    : [];
  // Only files on disk reach the runner, whatever selected them: git lists a stale entry until its removal is staged.
  return [...new Set([...own, ...beside, ...named.filter(ours)])].filter((file) => isFile(path.join(root, file))).sort();
}

// The command that runs test files, or null: the configured one, else `npm test --` for a package.json test script.
export function testCommand(root, testing = {}) {
  if (testing.changedCommand) return testing.changedCommand;
  try {
    return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))?.scripts?.test ? 'npm test --' : null;
  } catch {
    return null;
  }
}

// The runner a test command ends in, `jest` or `node` (`node --test`), or null for any other: its last command, read by
// the shell lexer with wrappers such as `npx` peeled (check-runs.mjs commandKey), else the package.json script that
// command runs (`npm test`, `npm run <name>`, and their pnpm, yarn, and bun forms), followed at most 5 deep. Both read a
// file argument as a pattern: jest as a regular expression, node as a glob. Jest given `--runTestsByPath` anywhere on the
// way reads exact paths, so it is none.
export function testRunner(root, command, depth = 0, scripts = null) {
  const words = lastCommandWords(command);
  const [program, ...rest] = words;
  if (rest.includes('--runTestsByPath')) return null;
  if (program === 'jest') return 'jest';
  if (program === 'node') {
    if (rest.some((word) => /(?:^|\/)(?:jest\/bin\/jest\.js|\.bin\/jest)$/u.test(word))) return 'jest';
    return rest.includes('--test') ? 'node' : null;
  }
  const name = scriptName(words);
  if (name === null || depth >= 5) return null;
  if (scripts === null) {
    try {
      scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))?.scripts ?? {};
    } catch {
      return null;
    }
  }
  return typeof scripts[name] === 'string' ? testRunner(root, scripts[name], depth + 1, scripts) : null;
}

// The words of the last command of `text`, as the test-run key spells them, or none for one the shell fills in.
function lastCommandWords(text) {
  const last = lexPipeline(String(text)).segments.filter((segment) => segment.length > 0).at(-1);
  if (!last) return [];
  const invocation = readInvocation(last);
  return invocation.dynamic ? [] : commandKey(invocation).split(' ');
}

// The package.json script a command's words run, or null: `npm test`, `npm run <name>`, `pnpm|yarn [run] <name>`, `bun run <name>`.
function scriptName([manager, verb, next]) {
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(manager) || verb === undefined || verb.startsWith('-')) return null;
  if (['run', 'run-script'].includes(verb)) return next && !next.startsWith('-') ? next : null;
  if (manager === 'bun') return null;
  if (['test', 't', 'tst'].includes(verb)) return 'test';
  return manager === 'npm' ? null : verb;
}

// A file as the runner `runner` (testRunner) reads it as itself: a Next.js segment such as `[id]` or `(group)` is
// otherwise a character class or a group, and the runner finds no test in it. Jest's regular expression takes a
// backslash before each such character. Node's glob takes none, so each glob character goes inside a class, as `[[]`;
// a parenthesis is no glob character there.
export function literalPattern(file, runner) {
  if (runner === 'jest') return file.replace(/[[\](){}*?+|^$\\]/gu, '\\$&');
  if (runner === 'node') return file.replace(/[[\]{}*?]/gu, '[$&]');
  return file;
}

const quote = (word) => (/^[\w@%+=:,./-]+$/u.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`);

export const commands = {
  test: {
    usage: 'changed [--base <revision>] [--list]',
    about: 'run only the test files the change touches: changed test files and the ones that name a changed file, against the branch\'s remote copy or --base; --list prints them',
    run(args) {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { base: { type: 'string' }, list: { type: 'boolean' } } });
      if (positionals.length !== 1 || positionals[0] !== 'changed') {
        console.error(`usage: aidrian test ${commands.test.usage}`);
        return 2;
      }
      const root = currentRoot(process.cwd());
      const project = findProject(process.cwd());
      if (!root) {
        console.error('aidrian test changed: not in a git checkout');
        return 2;
      }
      const config = project ? commandConfig(project) : null;
      const base = changeBase(root, { base: values.base ?? null, defaultBranch: config?.git.defaultBranch });
      const files = base ? changedFiles(root, base) : null;
      if (!files) {
        console.error(`aidrian test changed: git cannot read the change against ${base ?? 'a base'}; pass --base <revision>`);
        return 2;
      }
      const tests = touchedTests(root, files, runGit, { nodeOnly: !config?.testing?.changedCommand });
      const command = testCommand(root, config?.testing);
      if (values.list) {
        console.log(tests.join('\n'));
        return 0;
      }
      if (!tests.length) {
        console.log(`aidrian test changed: no test file touches the ${files.length} changed file(s) against ${base}\nℹ tests 0\nℹ pass 0\nℹ fail 0`);
        return 0;
      }
      if (!command) {
        console.error(`aidrian test changed: no command runs test files here; set config.json testing.changedCommand. The files:\n${tests.join('\n')}`);
        return 2;
      }
      const runner = testRunner(root, command);
      const line = `${command} ${tests.map((file) => quote(literalPattern(file, runner))).join(' ')}`;
      console.log(`aidrian test changed: ${tests.length} test file(s) against ${base}: ${line}`);
      const ran = spawnSync(line, { cwd: root, shell: true, stdio: 'inherit' });
      return ran.status ?? 1;
    },
  },
};
