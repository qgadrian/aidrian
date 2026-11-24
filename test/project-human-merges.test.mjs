// The merges a project run leaves to the Human that init names in its first output (lib/project-human-merges.mjs): each
// resumed issue's open pull request that changes a path auto-merge never merges, by the gate's own rule
// (pr-auto-merge.mjs neverMerged), and each issue whose tracker text names a policy file, as a warning. In process, with
// a stand-in forge: no child process.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { neverMerged } from '../plugins/aidrian/lib/pr-auto-merge.mjs';
import { humanMergeLines } from '../plugins/aidrian/lib/project-human-merges.mjs';

const REPOSITORY = { host: 'github.com', owner: 'Acme', name: 'widgets' };
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const notFound = () => Object.assign(new Error('gh: Not Found (HTTP 404)'), { stderr: 'gh: Not Found (HTTP 404)\n' });

// A forge whose default branch `main` commits `autoMerge` under github, and whose pull requests are `views` by number,
// each { files, state }: a value, or a function that throws.
function stubForge({ autoMerge = { allow: true }, views = {}, config = null } = {}) {
  const calls = [];
  const forge = {
    calls,
    repository: (repo) => {
      calls.push(['repository', repo]);
      return { default_branch: 'main' };
    },
    contents: (repo, file, ref) => {
      calls.push(['contents', repo, file, ref]);
      if (file !== '.aidrian/config.json' || ref !== 'refs/heads/main') throw notFound();
      if (typeof config === 'function') return config();
      const text = JSON.stringify({ version: 1, github: { autoMerge, requiredChecks: ['test'] } });
      return { type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64') };
    },
    change: (ref, fields, options) => {
      calls.push(['change', ref, fields, options]);
      const view = views[ref];
      if (!view) throw notFound();
      if (typeof view === 'function') return view();
      const files = view.files.map((path) => ({ path, changeType: 'MODIFIED' }));
      return { number: Number(ref), headRefOid: HEAD, baseRefName: 'main', baseRefOid: BASE, author: { login: 'adrian' }, url: `https://github.com/Acme/widgets/pull/${ref}`, files, changedFiles: files.length, reviewDecision: '', latestReviews: [], state: view.state ?? 'OPEN' };
    },
  };
  return forge;
}

const lines = (forge, more) => humanMergeLines({ forge, repository: REPOSITORY, prefix: () => '', ...more });
const LIFTED = { allow: true, includeGuardedPaths: true, includePolicyFiles: true };

test('a resumed issue whose open pull request changes .aidrian/config.json is named with its path, and an issue whose text names a policy file is warned of', () => {
  const forge = stubForge({ views: { 12: { files: ['src/app.js', '.aidrian/config.json'] }, 13: { files: ['src/other.js'] } } });
  const issues = [
    { key: 'ENG-1', status: 'started' },
    { key: 'ENG-2', status: 'started' },
    { key: 'ENG-3', status: 'unstarted' },
    { key: 'ENG-4', status: 'canceled' },
    { key: 'ENG-5', status: 'backlog' },
  ];
  const texts = {
    // ENG-1 has its pull request's line already, so its text adds no second one.
    'ENG-1': { title: 'Raise the cap', description: 'Set it in `.aidrian/config.json`.' },
    'ENG-3': { title: 'Move the switch', description: 'Write "github": { "autoMerge": "on" } into .aidrian.local.json.', criteria: '' },
    'ENG-4': { title: 'Canceled', description: 'Edit .aidrian/config.json' },
    'ENG-5': { title: 'Docs', description: 'Mention aidrian/config.json and .aidrian/config.json.bak in the readme.' },
  };
  const resumed = [{ key: 'ENG-1', pr: 12 }, { key: 'ENG-2', pr: 13 }];
  assert.deepEqual(lines(forge, { resumed, issues, texts }), [
    'needs your merge: #12 changes ".aidrian/config.json", which auto-merge never merges',
    'needs your merge, maybe: ENG-3\'s text names ".aidrian.local.json", a policy file auto-merge never merges, so a pull request that changes it waits for your merge',
  ]);
  // Each pull request is read in the pinned repository, with its state.
  assert.deepEqual(forge.calls.filter(([method]) => method === 'change').map(([, ref, fields, options]) => [ref, fields.endsWith(',state'), options.repo]), [['12', true, 'github.com/Acme/widgets'], ['13', true, 'github.com/Acme/widgets']]);
});

test('a run with none lists nothing, and reads nothing from the forge', () => {
  const forge = stubForge();
  const issues = [{ key: 'ENG-1', status: 'unstarted' }, { key: 'ENG-2', status: 'started' }];
  assert.deepEqual(lines(forge, { resumed: [{ key: 'ENG-2', pr: null }], issues, texts: { 'ENG-1': { title: 'Export', description: 'Write src/export.js.' } } }), []);
  assert.deepEqual(forge.calls, []);
  // A pull request that changes no such path, or one that is no longer open, adds nothing either.
  const read = stubForge({ views: { 7: { files: ['src/app.js'] }, 8: { files: ['.aidrian/config.json'], state: 'CLOSED' } } });
  assert.deepEqual(lines(read, { resumed: [{ key: 'ENG-2', pr: 7 }, { key: 'ENG-3', pr: 8 }], issues }), []);
});

test('guarded paths are named only without includeGuardedPaths, and policy files only without includePolicyFiles, as the gate reads the default branch', () => {
  const views = { 21: { files: ['CLAUDE.md'] }, 22: { files: ['.aidrian/config.json'] }, 23: { files: ['.aidrian.json'] } };
  const resumed = [{ key: 'ENG-1', pr: 21 }, { key: 'ENG-2', pr: 22 }, { key: 'ENG-3', pr: 23 }];
  const issues = [{ key: 'ENG-4', status: 'unstarted' }];
  const texts = { 'ENG-4': { description: 'Change .aidrian/config.json' } };
  const named = (autoMerge) => lines(stubForge({ autoMerge, views }), { resumed, issues, texts });
  assert.deepEqual(named({ allow: true }), [
    'needs your merge: #21 changes "CLAUDE.md", which auto-merge never merges',
    'needs your merge: #22 changes ".aidrian/config.json", which auto-merge never merges',
    'needs your merge: #23 changes ".aidrian.json", which auto-merge never merges',
    'needs your merge, maybe: ENG-4\'s text names ".aidrian/config.json", a policy file auto-merge never merges, so a pull request that changes it waits for your merge',
  ]);
  const guardedLifted = named({ allow: true, includeGuardedPaths: true });
  assert.equal(guardedLifted.some((line) => line.includes('#21')), false, 'includeGuardedPaths lets a host instruction file through');
  assert.equal(guardedLifted.length, 3, guardedLifted.join('\n'));
  // Both lifts: policy files merge, so neither the config nor the text is named; the pointer file never merges by itself.
  assert.deepEqual(named(LIFTED), ['needs your merge: #23 changes ".aidrian.json", which auto-merge never merges']);
  // includePolicyFiles alone lifts nothing.
  assert.equal(named({ allow: true, includePolicyFiles: true }).length, 4);
});

test('a read the forge cannot answer says what cannot be told, and blocks nothing', () => {
  const issues = [{ key: 'ENG-1', status: 'started' }];
  const broken = stubForge({ config: () => {
    throw Object.assign(new Error('boom'), { stderr: 'gh: Server Error (HTTP 500)\n' });
  } });
  const [policy] = lines(broken, { resumed: [{ key: 'ENG-1', pr: 5 }], issues });
  assert.match(policy, /^needs your merge, unknown: the default branch's config on the forge cannot be read \(could not read \.aidrian\/config\.json on Acme\/widgets main with gh \(gh: Server Error \(HTTP 500\)\)\), so which pull requests auto-merge never merges cannot be told$/u);
  const failing = stubForge({ views: { 5: () => {
    throw Object.assign(new Error('boom'), { stderr: 'gh: Bad credentials (HTTP 401)\n' });
  } } });
  assert.deepEqual(lines(failing, { resumed: [{ key: 'ENG-1', pr: 5 }], issues }), ['needs your merge, unknown: #5 of ENG-1: the forge cannot read it (gh: Bad credentials (HTTP 401)), so whether auto-merge merges it cannot be told']);
  assert.deepEqual(humanMergeLines({ forge: stubForge(), repository: REPOSITORY, prefix: () => null, resumed: [{ key: 'ENG-1', pr: 5 }], issues }), ['needs your merge, unknown: git cannot say where the project folder is in the repository, so which pull requests auto-merge never merges cannot be told']);
});

test('neverMerged judges each changed file by the paths check alone, and the pointer file under both lifts', () => {
  const policies = (autoMerge) => ({ main: 'main', policy: { github: { autoMerge } }, basePolicy: { github: { autoMerge } }, policyFiles: ['.aidrian.json', '.aidrian/config.json'], configFile: '.aidrian/config.json' });
  const files = (...paths) => paths.map((path) => ({ path, changeType: 'MODIFIED' }));
  assert.equal(neverMerged(files('src/app.js', 'docs/readme.md'), '', policies({})), null);
  assert.deepEqual(neverMerged(files('src/app.js', '.github/workflows/ci.yml'), '', policies({})), { path: '.github/workflows/ci.yml', why: 'it changes ".github/workflows/ci.yml", which instructs AI sessions, or decides CI\'s verdict or auto-merge' });
  assert.equal(neverMerged(files('.github/workflows/ci.yml'), '', policies({ includeGuardedPaths: true })), null);
  assert.equal(neverMerged(files('.aidrian/config.json'), '', policies({ includeGuardedPaths: true })).path, '.aidrian/config.json');
  assert.equal(neverMerged(files('.aidrian/config.json'), '', policies({ includeGuardedPaths: true, includePolicyFiles: true })), null);
  assert.match(neverMerged(files('.AIDRIAN.json'), '', policies({ includeGuardedPaths: true, includePolicyFiles: true })).why, /the pointer file that locates the config/u);
  // A project below the top of the repository: a file outside its folder has had no review.
  assert.equal(neverMerged(files('apps/web/src/a.js', 'tools/b.js'), 'apps/web/', policies({})).path, 'tools/b.js');
});
