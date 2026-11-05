// The ratchet of the provider-agnostic rule (docs/working-agreement.md): shared code outside lib/hosts/ reads no host's
// environment variable and branches on no host's tool or name. ALLOWED is the list of what is left, with why; it can only
// shrink, since an entry that no longer holds fails too.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PLUGIN = path.resolve(import.meta.dirname, '../plugins/aidrian');
const SHARED = ['lib', 'scripts'];
const HOST_LAYER = `lib${path.sep}hosts${path.sep}`;

const COUPLINGS = {
  // CODEX_TIMEOUT_SEC is the plugin's own constant, for the second-opinion command, and no variable of Codex.
  'host variable': /\b(?:CLAUDECODE|CLAUDE_[A-Z][A-Z_]*|CODEX_(?!TIMEOUT_SEC\b)[A-Z][A-Z_]*|PLUGIN_ROOT)\b/gu,
  'host tool': /['"]apply_patch['"]|[!=]==\s*['"](?:Edit|Write|NotebookEdit)['"]/gu,
  'host name': /[!=]==\s*['"](?:Claude Code|claude-code|claude|Claude|Codex)['"]/gu,
};

// `<file>|<coupling>`: how many it holds, and why it stays. Each one is a reason, not a to-do: a line goes when its reason does.
const ALLOWED = {
  'lib/review/quota.mjs|host name': { count: 1, why: 'It words a message about the reviewer that ran out of quota, a review bot or the Codex command, whichever host runs.' },
};

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return walk(full);
  return /\.m?js$/u.test(entry.name) ? [full] : [];
});

// The code of a file, without its comment lines and its text after ` // `: a comment may say what a host does.
const code = (file) => readFileSync(file, 'utf8').split('\n').filter((line) => !/^\s*(?:\/\/|\*|\/\*)/u.test(line)).map((line) => line.replace(/\s\/\/ .*$/u, '')).join('\n');

function found() {
  const hits = {};
  for (const file of SHARED.flatMap((folder) => walk(path.join(PLUGIN, folder)))) {
    const relative = path.relative(PLUGIN, file);
    if (relative.startsWith(HOST_LAYER)) continue;
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
  assert.deepEqual(extra, [], 'a new coupling: move it behind lib/hosts/ (docs/providers/adding-a-host.md)');
});

test('the list only shrinks: an entry that no longer holds, or holds fewer, comes off it', () => {
  const hits = found();
  const stale = Object.entries(ALLOWED).filter(([key, { count }]) => (hits[key] ?? 0) < count).map(([key]) => key);
  assert.deepEqual(stale, []);
  for (const [key, { why }] of Object.entries(ALLOWED)) assert.ok(typeof why === 'string' && why !== '', key);
});

test('the ratchet sees what it says it does', () => {
  const sample = "if (env.CLAUDE_CODE_AGENT || env.CODEX_THREAD_ID) run();\nif (tool === 'apply_patch' || name === 'Edit') run();\nif (host === 'Codex') run();\n";
  for (const [coupling, pattern] of Object.entries(COUPLINGS)) assert.ok([...sample.matchAll(pattern)].length > 0, coupling);
  assert.equal([...'const CODEX_TIMEOUT_SEC = 780;'.matchAll(COUPLINGS['host variable'])].length, 0);
});
