// `aidrian test changed`: runs the test files a change touches, the local check the push-first rule
// (lib/rules/push-first.mjs, docs/hooks.md#push-first) names instead of a full suite, which CI runs on the pushed head.
// The change is the checkout's files against `--base`, else the branch's remote copy, else the merge base with the
// default branch on `origin`: committed, uncommitted, and untracked files that git does not ignore. A test file it touches
// is one the change itself adds or edits, one that names a changed file (needlesOf), or a Go `_test.go` beside a changed
// `.go` file. A nested package's tests are left out, since its own runner runs them. With nothing to run it prints the
// node runner's zero summary, so its row shows no test passed, and supports no claim.
// The command is config.json `testing.changedCommand`, else `npm test --` when package.json has a test script, with the
// files after it; its exit status is the command's.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { commandConfig } from './config.mjs';
import { currentRoot, runGit } from './git.mjs';
import { findProject } from './project.mjs';
import { remoteCopy } from './rules/push-first.mjs';

// A test file, as the review's quiet test patterns name one: `*.test.*`, `*.spec.*`, `*_test.*`, or one in a test folder.
export const TEST_FILE = /(?:^|\/)(?:test|tests|__tests__|spec)\/|\.(?:test|spec)\.[^/]+$|_test\.[^/]+$/u;
const CODE_FILE = /\.(?:[cm]?[jt]sx?|json|py|go|rs|rb|ex|exs|php|java|kt|swift|cs)$/u;

const lines = (result) => (result.status === 0 ? result.stdout.split('\n').map((line) => line.trim()).filter(Boolean) : null);

// The base the change is read against, as a revision, or null when none can be found.
export function changeBase(root, { base = null, defaultBranch = 'main', git = runGit } = {}) {
  if (base) return base;
  const copy = remoteCopy(root, git);
  if (copy) return copy.ref;
  const merged = git(['merge-base', 'HEAD', `refs/remotes/origin/${defaultBranch}`], root);
  return merged.status === 0 ? merged.stdout.trim() : null;
}

// The files the change touches, from the checkout's top, or null when git cannot say.
export function changedFiles(root, base, git = runGit) {
  const diffed = lines(git(['diff', '--name-only', '--no-renames', base, '--'], root));
  const untracked = lines(git(['ls-files', '--others', '--exclude-standard'], root));
  return diffed && untracked ? [...new Set([...diffed, ...untracked])].sort() : null;
}

// The words a test names a changed file by, none for a test file itself: a code file by its name, and by its name with no
// extension, as an import often writes it (`./check-runs`); `index.*` by its folder and name; any other file by its path.
export function needlesOf(file) {
  if (TEST_FILE.test(file)) return [];
  if (!CODE_FILE.test(file)) return [file];
  const name = path.posix.basename(file);
  const stem = name.replace(/\.[^.]+$/u, '');
  const named = name.startsWith('index.') ? path.posix.join(path.posix.basename(path.posix.dirname(file)), name) : name;
  const short = name.startsWith('index.') ? path.posix.join(path.posix.basename(path.posix.dirname(file)), stem) : stem;
  return [...new Set([named, ...(short.length >= 4 ? [short] : [])])];
}

// The test files the change touches: the changed ones that still exist, then the ones that name a changed file. A test
// file in a nested package, a folder below the top with a package.json of its own, is left out: its own runner runs it.
export function touchedTests(root, files, git = runGit) {
  const listed = lines(git(['ls-files', '--cached', '--others', '--exclude-standard'], root)) ?? [];
  const exists = new Set(listed);
  const packages = listed.filter((file) => file.includes('/') && path.posix.basename(file) === 'package.json').map((file) => `${path.posix.dirname(file)}/`);
  const ours = (file) => TEST_FILE.test(file) && !packages.some((folder) => file.startsWith(folder));
  const own = files.filter((file) => ours(file) && exists.has(file));
  const needles = [...new Set(files.flatMap(needlesOf))];
  // Go tests a package from the same folder, and names no file: every `_test.go` beside a changed `.go` file.
  const goFolders = new Set(files.filter((file) => file.endsWith('.go') && !file.endsWith('_test.go')).map((file) => path.posix.dirname(file)));
  const beside = listed.filter((file) => file.endsWith('_test.go') && goFolders.has(path.posix.dirname(file)));
  const named = needles.length
    ? lines(git(['grep', '--no-recurse-submodules', '--untracked', '-l', '-F', ...needles.flatMap((needle) => ['-e', needle]), '--'], root)) ?? []
    : [];
  return [...new Set([...own, ...beside, ...named.filter(ours)])].sort();
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
      const tests = touchedTests(root, files);
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
      const line = `${command} ${tests.map(quote).join(' ')}`;
      console.log(`aidrian test changed: ${tests.length} test file(s) against ${base}: ${line}`);
      const ran = spawnSync(line, { cwd: root, shell: true, stdio: 'inherit' });
      return ran.status ?? 1;
    },
  },
};
