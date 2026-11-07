// The ratchet of the provider-agnostic rule (docs/working-agreement.md): shared code outside lib/hosts/ and lib/trackers/ reads no
// host's environment variable and branches on no host's tool or name. ALLOWED is the list of what is left, with why; it can
// only shrink, since an entry that no longer holds fails too.
//
// The standard vocabulary stays out of that rule, and every use of it is listed so a new one is a decision: the tool names
// hooks.json matches, Bash, Agent, Task, AskUserQuestion, EnterWorktree, ExitPlanMode, Read, Edit, and their kin. They are what
// the shared code reads, the way mcp__<server>__<tool> is, and a host that names them differently maps to them in `hookInput`.
// apply_patch is not in that vocabulary: it is one host's file edit, read through `fileEditOf`.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PLUGIN = path.resolve(import.meta.dirname, '../plugins/aidrian');
const SHARED = ['lib', 'scripts', 'bin'];
const ADAPTER_FOLDERS = [`lib${path.sep}hosts${path.sep}`, `lib${path.sep}trackers${path.sep}`];

const COUPLINGS = {
  // CODEX_TIMEOUT_SEC is the plugin's own constant, for the second-opinion command, and no variable of Codex.
  'host variable': /\b(?:CLAUDECODE|CLAUDE_[A-Z0-9][A-Z0-9_]*|CODEX_(?!TIMEOUT_SEC\b)[A-Z0-9][A-Z0-9_]*|PLUGIN_(?:ROOT|DATA)[A-Z0-9_]*)\b/gu,
  // An environment read by a computed or bracketed name: the name above sees the literal, and this one the access to a part of it.
  'env bracket': /\benv\[\s*['"`](?:CLAUDE|CODEX|PLUGIN)/gu,
  'host tool': /['"`](?:apply_patch|Edit|Write|NotebookEdit|Bash|Agent|Task|AskUserQuestion|EnterWorktree|ExitPlanMode|TodoWrite|Read|Grep|Glob|LS|NotebookRead|spawn_agent)['"`]/gu,
  'host name': /[!=]==\s*['"`](?:Claude Code|claude-code|claude|Claude|Codex|codex)['"`]/gu,
};

// `<file>|<coupling>`: how many it holds, and why it stays. Each one is a reason, not a to-do: a line goes when its reason does.
const VOCABULARY = 'The standard tool vocabulary, which hooks.json matches and a host maps to.';
const ALLOWED = {
  'lib/agent-gates.mjs|host tool': { count: 7, why: `${VOCABULARY} The read tools a subagent keeps, and Bash(...) patterns.` },
  'lib/attribution.mjs|host tool': { count: 1, why: 'Not a tool: the commit trailer named Agent.' },
  'lib/config-guard.mjs|host tool': { count: 2, why: `${VOCABULARY} A Bash call's targets.` },
  'lib/decisions-cli.mjs|host tool': { count: 2, why: `${VOCABULARY} A command asks the main-checkout rule about a file by building a standard Edit call.` },
  'lib/quorum.mjs|host name': { count: 3, why: 'The quorum provider and action named codex: a second-opinion command the plugin runs, whichever host is running.' },
  'lib/review/quota.mjs|host name': { count: 1, why: 'It words a message about the reviewer that ran out of quota, a review bot or the Codex command, whichever host runs.' },
  'lib/review/reviewers.mjs|host name': { count: 1, why: 'The built-in reviewer named codex: a command the plugin runs, whichever host is running.' },
  'lib/stop-announce.mjs|host tool': { count: 1, why: `${VOCABULARY} The question tool the send-back reason names, as each host's model calls it.` },
  'lib/transcript.mjs|host tool': { count: 2, why: 'Reads Claude Code transcripts, whose tool names these are; other hosts stay behind capabilities.transcripts.' },
  'scripts/hook-agent-post.mjs|host tool': { count: 2, why: `${VOCABULARY} This hook runs on what hooks.json matches, Agent or Task.` },
  'scripts/hook-agent-pre.mjs|host tool': { count: 2, why: `${VOCABULARY} This hook runs on what hooks.json matches, Agent or Task.` },
  'scripts/hook-ask.mjs|host tool': { count: 1, why: `${VOCABULARY} This hook runs on what hooks.json matches.` },
  'scripts/hook-bash.mjs|host tool': { count: 1, why: `${VOCABULARY} This hook runs on what hooks.json matches.` },
  'scripts/hook-enter-worktree.mjs|host tool': { count: 1, why: `${VOCABULARY} This hook runs on what hooks.json matches.` },
  'scripts/hook-plan-exit.mjs|host tool': { count: 1, why: `${VOCABULARY} This hook runs on what hooks.json matches.` },
};

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return walk(full);
  // The commands in bin/ are shell scripts with no extension.
  return /\.m?js$/u.test(entry.name) || path.basename(dir) === 'bin' ? [full] : [];
});

// The code of a file, without its comment lines and its text after ` // `: a comment may say what a host does.
const code = (file) => readFileSync(file, 'utf8').split('\n').filter((line) => !/^\s*(?:\/\/|\*|\/\*|#)/u.test(line)).map((line) => line.replace(/\s\/\/ .*$/u, '')).join('\n');

function found() {
  const hits = {};
  for (const file of SHARED.flatMap((folder) => walk(path.join(PLUGIN, folder)))) {
    const relative = path.relative(PLUGIN, file);
    if (ADAPTER_FOLDERS.some((folder) => relative.startsWith(folder))) continue;
    const text = code(file);
    for (const [coupling, pattern] of Object.entries(COUPLINGS)) {
      const count = [...text.matchAll(pattern)].length;
      if (count) hits[`${relative.split(path.sep).join('/')}|${coupling}`] = count;
    }
  }
  return hits;
}

test('shared code reads no host variable and branches on no host tool or name, past the list', () => {
  const hits = found();
  const extra = Object.entries(hits).filter(([key, count]) => count > (ALLOWED[key]?.count ?? 0));
  assert.deepEqual(extra, [], 'a new coupling: move it behind lib/hosts/ (docs/providers/adding-a-host.md), or list it here with why it stays');
});

test('the list only shrinks: an entry that no longer holds, or holds fewer, comes off it', () => {
  const hits = found();
  const stale = Object.entries(ALLOWED).filter(([key, { count }]) => (hits[key] ?? 0) < count).map(([key]) => key);
  assert.deepEqual(stale, []);
  for (const [key, { why }] of Object.entries(ALLOWED)) assert.ok(typeof why === 'string' && why !== '', key);
});

test('the ratchet sees each blind spot it had', () => {
  const sample = `if (env.CLAUDE_CODE_AGENT || env.CODEX_THREAD_ID || env.PLUGIN_ROOT || env.CLAUDE_2) run();
if (tool === 'apply_patch' || name === 'Edit') run();
const edits = ['Write', "NotebookEdit"];
if (host === 'Codex' || provider === 'codex') run();
const value = env['CODEX_' + 'X'];
`;
  const count = (name) => [...sample.matchAll(COUPLINGS[name])].length;
  assert.equal(count('host variable'), 4, 'with a digit in the name, and PLUGIN_ROOT');
  assert.equal(count('host tool'), 4, 'a tool in a comparison and in a list');
  assert.equal(count('host name'), 2, 'lower case too');
  assert.equal(count('env bracket'), 1);
  assert.equal([...'const CODEX_TIMEOUT_SEC = 780;'.matchAll(COUPLINGS['host variable'])].length, 0);
  assert.ok(SHARED.includes('bin'), 'the commands are shared code too');
  assert.ok(walk(path.join(PLUGIN, 'bin')).length > 0, 'and the walk reaches them');
});
