// What a project run's start gate checks of the repository before a session no Human attends starts beside it
// (lib/project-run-gate.mjs): the repository's own git state, and the files a host would load. Every git call goes through gateGit (lib/git.mjs), and an object it compares against is read through
// `git cat-file --batch` and its hash checked here, from the commit the forge reported, so neither a replace ref, a
// graft, an index flag, nor a filter can stand in for what a review saw.
//   - repositoryProblem: a stateless halt for a repository whose git state could run a program or move a fetch: replace
//     refs, grafts, or a config key of REFUSED_KEYS in a scope git reads for the folder.
//   - trustProblem, ancestorProblem: the host files a session in an attempt's clone would load, the clone's own and those
//     in a folder above it. The main checkout's own host files refuse no start: the clone loads none of them.

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { foldCase, isWithin, resolvedPath } from './fs.mjs';
import { repoIdentity } from './forges/index.mjs';
import { GATE_CONFIG, gateGit } from './git.mjs';
import { instructionNames } from './hosts/index.mjs';
import { GUARDED_PATHS } from './project.mjs';

// How far down the default branch's first-parent chain a main checkout's HEAD may lag the tip.
export const LAG_CAP = 500;
const BOOLEAN = /^(?:true|false|yes|no|on|off|1|0)$/iu;

// The config keys a repository may not set in a scope git reads for it, as patterns over the lower-case key, each with
// whether a value refuses (by default, any). `local` names those a user's own global or system config may hold, which
// only the repository's own scopes (local, worktree) and a command's (`git -c`, GIT_CONFIG_*) may not: a credential
// helper, an LFS-style filter, an SSH command or proxy, and a protocol allowance are ordinary there, and an include is
// read through. A session no Human attends that runs confined cannot write the user's own config; the rest refuse in
// every scope. `url.*.insteadof` is judged apart.
const REFUSED_KEYS = [
  [/^core\.(?:sshcommand|gitproxy|askpass)$/u, null, 'local'],
  [/^core\.(?:alternaterefscommand|worktree)$/u],
  [/^core\.bare$/u, (value) => /^(?:true|yes|on|1)$/iu.test(value)],
  [/^core\.fsmonitor$/u, (value) => !BOOLEAN.test(value)],
  [/^credential\.(?:.+\.)?helper$/u, null, 'local'],
  [/^remote\..+\.(?:uploadpack|receivepack|vcs|proxy)$/u],
  [/^http\.(?:.+\.)?proxy$/u, null, 'local'],
  [/^http\.(?:.+\.)?sslverify$/u, (value) => !/^(?:true|yes|on|1)$/iu.test(value)],
  [/^(?:include\.path|includeif\..+)$/u, null, 'local'],
  [/^filter\..+\.(?:clean|smudge|process)$/u, null, 'local'],
  [/^diff\..+\.(?:command|textconv)$/u],
  [/^protocol\.(?:.+\.)?allow$/u, null, 'local'],
];
const OWN_SCOPES = new Set(['local', 'worktree', 'command']);

const tampering = (what, dir) => `${what}, in the repository at ${dir}, which may mean someone tampered with it; do not run git in that repository until a person has checked it`;

// The settings gateGit itself passes with `-c`, which git lists in the command scope: `key=value`, the key in lower case.
const OWN_SETTINGS = new Set(GATE_CONFIG.filter((_each, at) => at % 2 === 1).map((pair) => {
  const at = pair.indexOf('=');
  return `${pair.slice(0, at).toLowerCase()}=${pair.slice(at + 1)}`;
}));

// The config entries git reads for the folder `dir`, as [{ scope, key, value }], or null when git cannot list them. The
// gate's own settings are left out; any other in the command scope, as GIT_CONFIG_PARAMETERS would give, stays.
function configEntries(dir) {
  const read = gateGit(['config', '--list', '--show-scope', '-z'], dir, { timeout: 30_000 });
  if (read.status !== 0) return null;
  const parts = read.stdout.split('\0');
  const entries = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [scope, pair] = [parts[i], parts[i + 1]];
    const at = pair.indexOf('\n');
    const entry = { scope, key: (at < 0 ? pair : pair.slice(0, at)).toLowerCase(), value: at < 0 ? '' : pair.slice(at + 1) };
    if (!(scope === 'command' && OWN_SETTINGS.has(`${entry.key}=${entry.value}`))) entries.push(entry);
  }
  return entries;
}

// Why the `url.<base>.insteadof` or `.pushinsteadof` entry `entry` moves origin away from `pinned`, or null: it applies
// to an origin URL that starts with its value, and the URL it rewrites that one to names another repository.
function insteadOfProblem(entry, origins, pinned) {
  const match = /^url\.(.+)\.(?:push)?insteadof$/u.exec(entry.key);
  if (!match) return null;
  for (const url of origins.filter((each) => entry.value !== '' && each.startsWith(entry.value))) {
    const id = repoIdentity(`${match[1]}${url.slice(entry.value.length)}`);
    if (!id || `${id.host}/${id.path}`.toLowerCase() !== pinned) return `git config ${entry.key} rewrites origin's URL ${url} to another repository`;
  }
  return null;
}

// Why the gate may not run git in any of `dirs`, folders of one repository, or null: a ref under refs/replace/, an
// info/grafts file, or a config key REFUSED_KEYS names in a scope git reads for that folder (`--show-scope` lists each,
// a worktree's config.worktree among them), or an insteadOf that moves origin off `repository`, the one init pinned. It
// asks nothing of the forge and records nothing; its answer says the repository may have been tampered with.
// core.hooksPath is not refused: gateGit sets it.
export function repositoryProblem(dirs, repository) {
  const pinned = `${repository.host}/${repository.owner}/${repository.name}`.toLowerCase();
  for (const dir of dirs) {
    const common = gateGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir, { timeout: 30_000 });
    if (common.status !== 0) return tampering('git cannot name the repository\'s git folder', dir);
    const replaced = gateGit(['for-each-ref', '--count=1', '--format=%(refname)', 'refs/replace/'], dir, { timeout: 30_000 });
    if (replaced.status !== 0 || replaced.stdout.trim() !== '') return tampering('it holds a replace ref, which makes git read another object in place of one a review saw', dir);
    if (existsSync(path.join(common.stdout.trim(), 'info', 'grafts'))) return tampering('it holds an info/grafts file, which rewrites the history git reads', dir);
    const entries = configEntries(dir);
    if (!entries) return tampering('git cannot list its config', dir);
    const origins = entries.filter((each) => /^remote\.origin\.(?:url|pushurl)$/u.test(each.key)).map((each) => each.value);
    for (const entry of entries) {
      const refused = REFUSED_KEYS.find(([pattern, value, only]) => pattern.test(entry.key) && (!only || OWN_SCOPES.has(entry.scope)) && (!value || value(entry.value)));
      if (refused) return tampering(`its ${entry.scope} git config sets ${entry.key}, which can run a program or move where git reads or sends, and the gate runs git only without it`, dir);
      const moved = insteadOfProblem(entry, origins, pinned);
      if (moved) return tampering(moved, dir);
    }
  }
  return null;
}

// The paths git lists with `args`, a subcommand and its options, in the checkout `dir`, split on NUL, or null when git
// fails. `-z` goes right after the subcommand: after a `--` it would be a path.
function listed(dir, [subcommand, ...args]) {
  const read = gateGit([subcommand, '-z', ...args], dir, { timeout: 60_000 });
  return read.status === 0 ? read.stdout.split('\0').filter(Boolean) : null;
}

// The hash a commit id `id` is in: SHA-1, or SHA-256 for a 64-digit id.
const hashOf = (id) => (id.length === 64 ? 'sha256' : 'sha1');
const objectId = (type, body, hash) => createHash(hash).update(Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body])).digest('hex');

// The objects `ids` of the repository at `root`, read with one `git cat-file --batch`, as a Map of id to { type, body },
// each kept only when its bytes hash to its id; null when git cannot read them.
function readObjects(root, ids) {
  if (ids.length === 0) return new Map();
  const read = gateGit(['cat-file', '--batch'], root, { input: Buffer.from(`${ids.join('\n')}\n`), encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024, timeout: 120_000 });
  if (read.status !== 0 || !Buffer.isBuffer(read.stdout)) return null;
  const out = read.stdout;
  const objects = new Map();
  let at = 0;
  while (at < out.length) {
    const end = out.indexOf(0x0a, at);
    if (end < 0) break;
    const [id, type, size] = out.subarray(at, end).toString('latin1').split(' ');
    at = end + 1;
    if (type === 'missing' || type === undefined) continue;
    const body = out.subarray(at, at + Number(size));
    at += Number(size) + 1;
    if (objectId(type, body, hashOf(id)) === id) objects.set(id, { type, body });
  }
  return objects;
}

// A commit's tree and parents, from its verified body: { tree, parents }.
function commitOf(body) {
  const head = body.toString('utf8').split('\n\n')[0].split('\n');
  return { tree: head.find((line) => line.startsWith('tree '))?.slice(5) ?? null, parents: head.filter((line) => line.startsWith('parent ')).map((line) => line.slice(7)) };
}

// The entries of a verified tree body, in the hash of `id`: [{ mode, name, id }].
function treeEntries(body, hash) {
  const length = hash === 'sha256' ? 32 : 20;
  const entries = [];
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    const nul = body.indexOf(0, space);
    if (space < 0 || nul < 0) break;
    entries.push({ mode: body.subarray(at, space).toString('latin1'), name: body.subarray(space + 1, nul).toString('utf8'), id: body.subarray(nul + 1, nul + 1 + length).toString('hex') });
    at = nul + 1 + length;
  }
  return entries;
}

// The files of the commit `commit`, every blob and link of its tree by path, as a Map of path to { mode, id }, read and
// verified through readObjects; null when an object cannot be read or does not hash to its id. Kept per commit id, which
// names its tree for good.
const trees = new Map();
export function commitFiles(root, commit) {
  if (trees.has(commit)) return trees.get(commit);
  const hash = hashOf(commit);
  const head = readObjects(root, [commit])?.get(commit);
  const { tree } = head?.type === 'commit' ? commitOf(head.body) : {};
  if (!tree) return null;
  const files = new Map();
  let level = [{ id: tree, prefix: '' }];
  while (level.length) {
    const objects = readObjects(root, [...new Set(level.map((each) => each.id))]);
    if (!objects) return null;
    const next = [];
    for (const { id, prefix } of level) {
      const object = objects.get(id);
      if (object?.type !== 'tree') return null;
      for (const entry of treeEntries(object.body, hash)) {
        const file = `${prefix}${entry.name}`;
        if (entry.mode === '40000') next.push({ id: entry.id, prefix: `${file}/` });
        else if (entry.mode !== '160000') files.set(file, { mode: entry.mode, id: entry.id });
      }
    }
    level = next;
  }
  trees.set(commit, files);
  return files;
}

// Whether the commit `head` lies on the first-parent chain of `tip`, within LAG_CAP commits, each read and verified
// through readObjects: true, false, or null when a commit cannot be read.
function onFirstParents(root, tip, head) {
  let id = tip;
  for (let step = 0; step <= LAG_CAP && id; step += 1) {
    if (id === head) return true;
    const object = readObjects(root, [id])?.get(id);
    if (object?.type !== 'commit') return null;
    [id] = commitOf(object.body).parents;
  }
  return false;
}

// The first path `wanted(path)` takes, in the checkout `root`, whose bytes on disk differ from its blob in the commit
// `tip`, as { path }: a file the tip has that is missing, changed, or of another kind, or a tracked file the tip lacks.
// Read from the disk itself, never through the index, so a file git is told to skip, or a filter rewrites, still counts;
// the tip's files are read through commitFiles, verified by their hashes. { problem } when they cannot be read; null
// when every one matches.
export function rawMismatch(root, tip, wanted) {
  const files = commitFiles(root, tip);
  const tracked = listed(root, ['ls-files', '--full-name']);
  if (!files || !tracked) return { problem: 'git cannot list the base tip\'s files and the tracked ones' };
  const blobs = [...files].filter(([file]) => wanted(file));
  const known = new Set(blobs.map(([file]) => file));
  for (const file of tracked.filter(wanted)) if (!known.has(file)) return { path: file };
  for (const [file, { mode, id }] of blobs) {
    const full = path.join(root, file);
    let bytes;
    try {
      const stat = lstatSync(full);
      if (mode === '120000') bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(full)) : null;
      else bytes = stat.isFile() ? readFileSync(full) : null;
    } catch {
      bytes = null;
    }
    if (bytes === null || objectId('blob', bytes, hashOf(tip)) !== id) return { path: file };
  }
  return null;
}

// rawMismatch of the main checkout `main` against the commit `tip`, or null when its files `wanted` takes match the main
// checkout's own HEAD, that HEAD lies on the tip's first-parent chain (an earlier commit of the default branch, which a
// review saw, as until someone pulls an earlier issue's merge), and the tip deleted none of the files HEAD has there. A
// HEAD only the main checkout has, one the default branch took in through a merge's second parent, a lag past LAG_CAP,
// or a file changed on disk, gives the tip's mismatch.
export function reviewedMismatch(main, tip, wanted) {
  const raw = rawMismatch(main, tip, wanted);
  if (!raw || raw.problem) return raw;
  const head = gateGit(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], main, { timeout: 30_000 }).stdout?.trim();
  if (!head || head.length !== tip.length || head === tip || onFirstParents(main, tip, head) !== true) return raw;
  const [had, has] = [commitFiles(main, head), commitFiles(main, tip)];
  if (!had || !has) return raw;
  const deleted = [...had.keys()].find((file) => wanted(file) && !has.has(file));
  if (deleted) return { path: deleted };
  return rawMismatch(main, head, wanted) ? raw : null;
}

// Why the worktree `dir` may not start a session no Human attends, or null: a host config or instruction file
// (GUARDED_PATHS) differs from the commit `tip`, or one is there untracked or git-ignored. Ignored folders are listed
// whole, so a dependency folder is one entry, and a guarded folder such as `.claude/` counts as itself.
export function trustProblem(dir, tip) {
  const changed = listed(dir, ['diff', '--name-only', '--no-renames', tip, '--']);
  const untracked = listed(dir, ['ls-files', '--others', '--exclude-standard']);
  const ignored = listed(dir, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory']);
  if (!changed || !untracked || !ignored) return 'git cannot list the worktree\'s changed, untracked, and ignored files';
  const guarded = (file) => GUARDED_PATHS.test(file) || GUARDED_PATHS.test(file.replace(/\/$/u, ''));
  const differ = changed.filter(guarded);
  // The index may be told to skip a file (assume-unchanged, skip-worktree) or a filter may rewrite it: the bytes on disk decide.
  const raw = rawMismatch(dir, tip, guarded);
  if (raw?.problem) return raw.problem;
  if (raw) differ.push(raw.path);
  if (differ.length) return `its host config or instruction files differ from the base tip: ${[...new Set(differ)].slice(0, 3).join(', ')}`;
  const local = [...untracked, ...ignored].filter(guarded);
  if (local.length) return `it holds host config or instruction files git does not track, which no review saw: ${local.slice(0, 3).join(', ')}`;
  return null;
}

// Why a host would load instructions no review saw from a folder above `dir`, an attempt's clone or a folder in the runs
// folder, or null. Each folder above it, up to but not including the file system's root, may hold a host instruction
// file or folder (lib/hosts/index.mjs instructionNames), which every host that reads it loads into the session. One is
// allowed only inside the main checkout of `project`, tracked by git, and the same as the commit `tip`, or an ancestor
// of it the main checkout is at (reviewedMismatch), with nothing untracked or ignored in a folder. A host's own user
// folder, read for every session wherever it starts, and its own top-level files are the user's, such as Claude Code's
// `.claude` and `.claude/CLAUDE.md` in the home folder, which a default state folder lies under: the entry, by its path
// or its real path, is a user folder, or its folder is one, so a user folder or a memory file in it that is a symlink,
// as a dotfiles checkout makes, stays the user's. Nothing deeper is: a state folder inside a user folder has its own
// instruction files, which no review saw, checked as any other. `env` names those user folders. The state folder lies
// outside every checkout (project-run.mjs runPlace), so the advice moves the file or the state folder.
export function ancestorProblem(dir, { project, tip, env = process.env }) {
  const { files, folders, userFolders } = instructionNames(env);
  const users = userFolders.flatMap((each) => {
    const given = path.resolve(each);
    return [given, path.join(resolvedPath(path.dirname(given)) ?? path.dirname(given), path.basename(given)), resolvedPath(given) ?? given];
  }).map(foldCase);
  const usersHold = (file) => {
    const real = resolvedPath(file) ?? file;
    return [file, real, path.dirname(file), path.dirname(real)].some((each) => users.includes(foldCase(each)));
  };
  const main = resolvedPath(project.checkouts.at(-1)) ?? project.checkouts.at(-1);
  const start = resolvedPath(dir) ?? path.resolve(dir);
  for (let folder = path.dirname(start); folder !== path.dirname(folder); folder = path.dirname(folder)) {
    for (const name of [...files, ...folders]) {
      const file = path.join(folder, name);
      let stat;
      try {
        stat = lstatSync(file);
      } catch {
        continue;
      }
      if (usersHold(file)) continue;
      const why = reviewedProblem({ main, file, folder: stat.isDirectory(), tip });
      if (why) return `the host loads ${file}, in a folder above the attempt's clone, and ${why}; move it away, or set state.dir to a folder with no host instruction file above it`;
    }
  }
  return null;
}

// Why the host instruction file or folder `file` is not one a review saw, or null: it must lie inside the main checkout
// `main`, be tracked there, and match the commit `tip`, or an ancestor of it the main checkout is at (reviewedMismatch),
// and a folder must hold nothing untracked or ignored.
function reviewedProblem({ main, file, folder, tip }) {
  if (!isWithin(main, file) || file === main) return 'it lies outside the main checkout, where no review sees it';
  const rel = path.relative(main, file);
  const tracked = gateGit(['ls-files', '-z', '--', rel], main, { timeout: 60_000 });
  if (tracked.status !== 0 || tracked.stdout === '') return 'git does not track it';
  const raw = reviewedMismatch(main, tip, (each) => each === rel || each.startsWith(`${rel}/`));
  if (raw) return raw.problem ?? 'it differs from the base tip';
  if (!folder) return null;
  const others = gateGit(['ls-files', '-z', '--others', '--exclude-standard', '--', rel], main, { timeout: 60_000 });
  const ignored = gateGit(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory', '--', rel], main, { timeout: 60_000 });
  if (others.status !== 0 || ignored.status !== 0 || others.stdout !== '' || ignored.stdout !== '') return 'it holds files git does not track';
  return null;
}

// Why the origin of the checkout `dir` may send work elsewhere than `repository`, or null: each fetch and push URL git
// resolves for it, with pushurl, insteadOf, and pushInsteadOf applied, must name that repository on its host.
export function pushProblem(dir, repository) {
  const want = `${repository.host}/${repository.owner}/${repository.name}`.toLowerCase();
  for (const args of [['remote', 'get-url', '--all', 'origin'], ['remote', 'get-url', '--push', '--all', 'origin']]) {
    const read = gateGit(args, dir, { timeout: 30_000 });
    const urls = read.status === 0 ? read.stdout.split('\n').map((line) => line.trim()).filter(Boolean) : [];
    if (urls.length === 0) return 'git names no URL for origin';
    for (const url of urls) {
      const id = repoIdentity(url);
      if (!id || `${id.host}/${id.path}`.toLowerCase() !== want) return `origin ${args.includes('--push') ? 'pushes' : 'fetches'} to a URL that does not name ${want}, the repository the run pinned`;
    }
  }
  return null;
}

// The real path of `file`, or null.
export const realOf = (file) => {
  try {
    return realpathSync(file);
  } catch {
    return null;
  }
};
