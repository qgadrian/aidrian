// The ratchet of the forge facade (docs/working-agreement.md): shared code outside lib/forges/ reaches the code forge only
// through lib/forges/index.mjs. It imports no adapter, runs no gh, builds no GitHub REST route, and names no GitHub API
// host. ALLOWED is the list of what is left, with why; it can only shrink, since an entry that no longer holds fails too.
//
// Reading a gh command a session runs, as lib/rules/github/ does (`program === 'gh'`), is not a coupling: that code judges
// a command, and runs none. Any other 'gh' literal is, since it names the program to something that may run it.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PLUGIN = path.resolve(import.meta.dirname, '../plugins/aidrian');
const SHARED = ['lib', 'scripts', 'bin'];
const FORGES = `lib${path.sep}forges${path.sep}`;

const COUPLINGS = {
  // A string naming a module under forges/ other than index.mjs, in a static or a dynamic import alike: any adapter, today's or a
  // later one, however its path is spelled.
  'adapter import': /['"`][^'"`\n]*\bforges\/+(?:\.\/)*(?!index\.mjs)[\w-]+\.mjs(?:\?[^'"`\n]*)?['"`]/gu,
  // gh run by a child process: the program as its own argument, or the start of a command line.
  'gh spawn': /\b(?:execFileSync|execFile|execSync|exec|spawnSync|spawn)\(\s*['"`]gh(?:\s[^'"`\n]*)?['"`]/gu,
  // The program's name on its own, outside a comparison: a variable or a helper that later runs it. A rule that reads a
  // command compares its program to 'gh', and runs none.
  'gh literal': /(?<![!=]==\s*)['"`]gh['"`]/gu,
  'REST route': /repos\/\$\{/gu,
  'API host': /api\.github\.com/gu,
};

// `<file>|<coupling>`: how many it holds, and why it stays. Each one is a reason, not a to-do: a line goes when its reason does.
const ALLOWED = {
  'lib/pr-auto-merge.mjs|REST route': {
    count: 3,
    why: 'Not a call: the routes name, in the outsider check\'s error, which list gh could not read. The reads go through the forge.',
  },
};

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return walk(full);
  // The commands in bin/ are shell scripts with no extension.
  return /\.m?js$/u.test(entry.name) || path.basename(dir) === 'bin' ? [full] : [];
});

// The code of a file, without its comment lines and its text after ` // `: a comment may name a route or an adapter.
const code = (text) => text.split('\n').filter((line) => !/^\s*(?:\/\/|\*|\/\*|#)/u.test(line)).map((line) => line.replace(/\s\/\/ .*$/u, '')).join('\n');

const countIn = (text) => Object.fromEntries(Object.entries(COUPLINGS).map(([coupling, pattern]) => [coupling, [...code(text).matchAll(pattern)].length]));

function found() {
  const hits = {};
  for (const file of SHARED.flatMap((folder) => walk(path.join(PLUGIN, folder)))) {
    const relative = path.relative(PLUGIN, file);
    if (relative.startsWith(FORGES)) continue;
    for (const [coupling, count] of Object.entries(countIn(readFileSync(file, 'utf8')))) {
      if (count) hits[`${relative.split(path.sep).join('/')}|${coupling}`] = count;
    }
  }
  return hits;
}

test('shared code reaches the forge only through lib/forges/index.mjs, past the list', () => {
  const extra = Object.entries(found()).filter(([key, count]) => count > (ALLOWED[key]?.count ?? 0));
  assert.deepEqual(extra, [], 'a new coupling: call forgeFor (docs/providers/adding-a-host.md#adding-a-forge), or list it here with why it stays');
});

test('the list only shrinks: an entry that no longer holds, or holds fewer, comes off it', () => {
  const hits = found();
  const stale = Object.entries(ALLOWED).filter(([key, { count }]) => (hits[key] ?? 0) < count).map(([key]) => key);
  assert.deepEqual(stale, []);
  for (const [key, { why }] of Object.entries(ALLOWED)) assert.ok(typeof why === 'string' && why !== '', key);
});

test('the ratchet sees each coupling, and not a command a rule reads or a comment', () => {
  const sample = `import { runGh } from './forges/github-cli.mjs';
import { GITHUB_JSON } from "../forges/github.mjs";
const adapter = await import(\`../../forges/github.mjs\`);
import { createGitlabForge } from './forges/gitlab.mjs';
import { GITHUB_JSON as J } from './forges/./github.mjs';
execFileSync('gh', ['pr', 'view']);
spawnSync( "gh", args);
execSync('gh pr checks 7 --json name');
const route = \`repos/\${repo}/pulls/\${n}\`;
fetch('https://api.github.com/user');
const cmd = 'gh';
run('gh', a);
`;
  assert.deepEqual(countIn(sample), { 'adapter import': 5, 'gh spawn': 3, 'gh literal': 4, 'REST route': 1, 'API host': 1 });
  const clean = `import { forgeFor } from './forges/index.mjs';
if (program === 'gh' && args[0] === 'pr') judge(args);
execFileSync('git', ['status']);
spawnSync('ghq', ['list']);
// repos/\${repo} through forges/github.mjs, never api.github.com
const one = 1; // execFileSync('gh', ['api', \`repos/\${repo}\`])
`;
  assert.deepEqual(countIn(clean), { 'adapter import': 0, 'gh spawn': 0, 'gh literal': 0, 'REST route': 0, 'API host': 0 });
  assert.ok(walk(path.join(PLUGIN, 'bin')).length > 0, 'the commands are shared code too, and the walk reaches them');
});
