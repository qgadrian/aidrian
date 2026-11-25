// The merges a project run leaves to the Human that init names in its first output (lib/project-human-merges.mjs): each
// resumed issue's open pull request that changes a path auto-merge never merges, by the gate's own rule
// (pr-auto-merge.mjs neverMerged), and each issue whose tracker text names a policy file, as a warning. In process, with
// a stand-in forge: no child process.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { neverMerged } from '../plugins/aidrian/lib/pr-auto-merge.mjs';
import { humanMergeLines } from '../plugins/aidrian/lib/project-human-merges.mjs';
import { landedStates, mayStart, planRun } from '../plugins/aidrian/lib/project-run.mjs';

const REPOSITORY = { host: 'github.com', owner: 'Acme', name: 'widgets' };
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
// The branch every resumed issue here goes on on, and every pull request comes from, unless a test says otherwise.
const BRANCH = 'feat/eng-export';
const notFound = () => Object.assign(new Error('gh: Not Found (HTTP 404)'), { stderr: 'gh: Not Found (HTTP 404)\n' });

const fileOf = (value) => ({ type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(value)).toString('base64') });

// A forge whose default branch `main` commits `autoMerge` under github, and each branch of `branches` its own, a value or
// a function that throws; every branch's pointer file names the folder `dir`, when given, in the project folder `folder`.
// Its pull requests are `views` by number, each { files, state, base }: a value, or a function that throws.
function stubForge({ autoMerge = { allow: true }, branches = {}, views = {}, config = null, dir = null, folder = '' } = {}) {
  const calls = [];
  const configs = { main: autoMerge, ...branches };
  const forge = {
    calls,
    repository: (repo) => {
      calls.push(['repository', repo]);
      return { default_branch: 'main' };
    },
    contents: (repo, file, ref) => {
      calls.push(['contents', repo, file, ref]);
      if (dir && file === `${folder}.aidrian.json`) return fileOf({ dir });
      const committed = configs[String(ref).replace('refs/heads/', '')];
      if (file !== `${folder}${dir ?? '.aidrian'}/config.json` || !committed) throw notFound();
      if (typeof config === 'function') return config();
      if (typeof committed === 'function') return committed();
      return fileOf({ version: 1, github: { autoMerge: committed, requiredChecks: ['test'] } });
    },
    change: (ref, fields, options) => {
      calls.push(['change', ref, fields, options]);
      const view = views[ref];
      if (!view) throw notFound();
      if (typeof view === 'function') return view();
      const files = view.files.map((path) => ({ path, changeType: 'MODIFIED' }));
      return { number: Number(ref), headRefOid: HEAD, baseRefName: view.base ?? 'main', baseRefOid: BASE, author: { login: 'adrian' }, url: `https://github.com/Acme/widgets/pull/${ref}`, files, changedFiles: files.length, reviewDecision: '', latestReviews: [], state: view.state ?? 'OPEN', headRefName: view.branch ?? BRANCH, isCrossRepository: view.fork === true };
    },
  };
  return forge;
}

const lines = (forge, { resumed = [], ...more }) => humanMergeLines({ forge, repository: REPOSITORY, prefix: () => '', ...more, resumed: resumed.map((each) => ({ branch: BRANCH, ...each })) });
const LIFTED = { allow: true, includeGuardedPaths: true, includePolicyFiles: true };

test('a resumed issue whose open pull request changes .aidrian/config.json is named with its path, and an issue whose text names a policy file is warned of', () => {
  const forge = stubForge({ views: { 12: { files: ['src/app.js', '.aidrian/config.json'] }, 13: { files: ['src/other.js'] } } });
  // ENG-4 is none the run may start.
  const startable = new Set(['ENG-1', 'ENG-2', 'ENG-3', 'ENG-5']);
  const texts = {
    // ENG-1 has its pull request's line already, so its text adds no second one.
    'ENG-1': { title: 'Raise the cap', description: 'Set it in `.aidrian/config.json`.' },
    'ENG-3': { title: 'Move the switch', description: 'Write "github": { "autoMerge": "on" } into .aidrian.local.json.', criteria: '' },
    'ENG-4': { title: 'Canceled', description: 'Edit .aidrian/config.json' },
    'ENG-5': { title: 'Docs', description: 'Mention aidrian/config.json and .aidrian/config.json.bak in the readme.' },
  };
  const resumed = [{ key: 'ENG-1', pr: 12 }, { key: 'ENG-2', pr: 13 }];
  assert.deepEqual(lines(forge, { resumed, startable, texts }), [
    'needs your merge: #12 changes ".aidrian/config.json", which auto-merge never merges',
    'needs your merge, maybe: ENG-3\'s text names ".aidrian.local.json", a policy file auto-merge never merges, so a pull request that changes it waits for your merge',
  ]);
  // Each pull request is read in the pinned repository, with its state.
  assert.deepEqual(forge.calls.filter(([method]) => method === 'change').map(([, ref, fields, options]) => [ref, fields.endsWith(',state,headRefName,isCrossRepository'), options.repo]), [['12', true, 'github.com/Acme/widgets'], ['13', true, 'github.com/Acme/widgets']]);
});

test('a run with none lists nothing, and reads nothing from the forge', () => {
  const forge = stubForge();
  const startable = ['ENG-1', 'ENG-2'];
  // A text of an issue the run may not start is not read, so it makes no read of the forge either.
  assert.deepEqual(lines(forge, { resumed: [{ key: 'ENG-2', pr: null }], startable, texts: { 'ENG-9': { title: 'Other', description: 'Edit .aidrian/config.json' } } }), []);
  assert.deepEqual(forge.calls, []);
  // A text that names no policy file, a pull request that changes no such path, and one no longer open add nothing.
  const read = stubForge({ views: { 7: { files: ['src/app.js'] }, 8: { files: ['.aidrian/config.json'], state: 'CLOSED' } } });
  assert.deepEqual(lines(read, { resumed: [{ key: 'ENG-2', pr: 7 }, { key: 'ENG-3', pr: 8 }], startable, texts: { 'ENG-1': { title: 'Export', description: 'Write src/export.js.' } } }), []);
});

test('a config the pointer file relocates is warned of when it is the only path named, from the project folder or the top', () => {
  const relocated = 'settings/harness/config.json';
  const warning = (path) => [`needs your merge, maybe: ENG-1's text names ${JSON.stringify(path)}, a policy file auto-merge never merges, so a pull request that changes it waits for your merge`];
  const warned = (path, forge, more = {}) => lines(forge, { startable: ['ENG-1'], texts: { 'ENG-1': { description: `Raise the cap in ${path}.` } }, ...more });
  for (const path of [relocated, `./${relocated}`]) assert.deepEqual(warned(path, stubForge({ dir: 'settings/harness' })), warning(path));
  // With no pointer file, the same path is no policy file.
  assert.deepEqual(warned(relocated, stubForge()), []);
  const nested = () => stubForge({ dir: 'settings/harness', folder: 'apps/web/' });
  for (const path of [relocated, `apps/web/${relocated}`]) assert.deepEqual(warned(path, nested(), { prefix: () => 'apps/web/' }), warning(path));
});

test('a pull request is judged by its own base and the default branch together', () => {
  const resumed = [{ key: 'ENG-1', pr: 31 }];
  const named = (file, main, release) => lines(stubForge({ autoMerge: main, branches: { release }, views: { 31: { files: [file], base: 'release' } } }), { resumed });
  const line = (file) => [`needs your merge: #31 changes ${JSON.stringify(file)}, which auto-merge never merges`];
  const none = { allow: true };
  for (const file of ['CLAUDE.md', '.aidrian/config.json']) {
    assert.deepEqual(named(file, LIFTED, none), line(file), `${file}, the base lifts nothing`);
    assert.deepEqual(named(file, none, LIFTED), line(file), `${file}, the default branch lifts nothing`);
    assert.deepEqual(named(file, LIFTED, LIFTED), [], `${file}, both lift it`);
  }
  // A base whose config cannot be read leaves that pull request alone untold.
  const failing = () => {
    throw Object.assign(new Error('boom'), { stderr: 'gh: Server Error (HTTP 500)\n' });
  };
  const forge = stubForge({ branches: { release: failing }, views: { 31: { files: ['CLAUDE.md'], base: 'release' }, 32: { files: ['CLAUDE.md'] } } });
  const [unknown, other, ...rest] = lines(forge, { resumed: [...resumed, { key: 'ENG-2', pr: 32 }] });
  assert.match(unknown, /^needs your merge, unknown: #31 of ENG-1: the config of its base "release" or of the default branch cannot be read on the forge \(could not read \.aidrian\/config\.json on Acme\/widgets release with gh \(gh: Server Error \(HTTP 500\)\)\), so whether auto-merge merges it cannot be told$/u);
  assert.equal(other, 'needs your merge: #32 changes "CLAUDE.md", which auto-merge never merges');
  assert.deepEqual(rest, []);
});

test('a remembered pull request that is not from the branch the issue resumes on says nothing, and leaves the text its warning', () => {
  const texts = { 'ENG-1': { description: 'Edit .aidrian/config.json' } };
  for (const other of [{ branch: 'feat/unrelated' }, { fork: true }]) {
    const forge = stubForge({ views: { 41: { files: ['CLAUDE.md'], ...other } } });
    assert.deepEqual(lines(forge, { resumed: [{ key: 'ENG-1', pr: 41 }], startable: ['ENG-1'], texts }), [
      'needs your merge, maybe: ENG-1\'s text names ".aidrian/config.json", a policy file auto-merge never merges, so a pull request that changes it waits for your merge',
    ]);
  }
});

test('an open pull request whose branch the forge does not say is told as unknown', () => {
  for (const missing of ['headRefName', 'isCrossRepository']) {
    const forge = stubForge({ views: { 42: { files: ['.aidrian/config.json'] } } });
    const change = forge.change;
    forge.change = (...args) => ({ ...change(...args), [missing]: undefined });
    assert.deepEqual(lines(forge, { resumed: [{ key: 'ENG-1', pr: 42 }] }), ['needs your merge, unknown: #42 of ENG-1: the forge does not say which branch it is from, so whether auto-merge merges it cannot be told'], missing);
  }
});

test('under both lifts a text is warned of only when it names the pointer file', () => {
  const warned = (named, folder = '') => lines(stubForge({ autoMerge: LIFTED, folder }), { prefix: () => folder, startable: ['ENG-1'], texts: { 'ENG-1': { description: `Edit ${named}` } } }).length;
  for (const named of ['.aidrian.json', './.aidrian.json', '.AIDRIAN.json']) assert.equal(warned(named), 1, named);
  for (const named of ['.aidrian.json', 'apps/web/.aidrian.json', '/apps/web/.aidrian.json', '/../apps/web/.aidrian.json', '//apps/web/.aidrian.json']) assert.equal(warned(named, 'apps/web/'), 1, named);
  // A path from the top of the repository is never read from the nested project's folder.
  assert.equal(warned('/.aidrian.json', 'apps/web/'), 0);
  for (const named of ['.aidrian/config.json', 'other/.aidrian.json']) assert.equal(warned(named), 0, named);
});

test('the issues a run may start leave out a landed, a canceled, and a skipped one', () => {
  const issue = (key, status, blockedBy = []) => ({ key, branch: `feat/${key.toLowerCase()}`, status, blockedBy });
  const snapshot = { outside: [], issues: [issue('ENG-1', 'started'), issue('ENG-2', 'unstarted', ['ENG-1']), issue('ENG-3', 'canceled'), issue('ENG-4', 'unstarted', ['ENG-3']), issue('ENG-5', 'unstarted', ['ENG-2'])] };
  const startable = mayStart(planRun(snapshot, landedStates([{ key: 'ENG-1', pr: 12 }])));
  assert.deepEqual([...startable].sort(), ['ENG-2', 'ENG-5']);
  const texts = Object.fromEntries(snapshot.issues.map(({ key }) => [key, { description: 'Edit .aidrian/config.json' }]));
  assert.deepEqual(lines(stubForge(), { startable, texts }).map((line) => line.match(/ENG-\d/u)[0]).sort(), ['ENG-2', 'ENG-5']);
});

test('guarded paths are named only without includeGuardedPaths, and policy files only without includePolicyFiles, as the gate reads the default branch', () => {
  const views = { 21: { files: ['CLAUDE.md'] }, 22: { files: ['.aidrian/config.json'] }, 23: { files: ['.aidrian.json'] } };
  const resumed = [{ key: 'ENG-1', pr: 21 }, { key: 'ENG-2', pr: 22 }, { key: 'ENG-3', pr: 23 }];
  const texts = { 'ENG-4': { description: 'Change .aidrian/config.json' } };
  const named = (autoMerge) => lines(stubForge({ autoMerge, views }), { resumed, startable: ['ENG-4'], texts });
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
  const broken = stubForge({ config: () => {
    throw Object.assign(new Error('boom'), { stderr: 'gh: Server Error (HTTP 500)\n' });
  } });
  const [policy, ...more] = lines(broken, { startable: ['ENG-1'], texts: { 'ENG-1': { description: 'Edit .aidrian/config.json' } } });
  assert.match(policy, /^needs your merge, unknown: the default branch's config on the forge cannot be read \(could not read \.aidrian\/config\.json on Acme\/widgets main with gh \(gh: Server Error \(HTTP 500\)\)\), so which issues name a policy file auto-merge never merges cannot be told$/u);
  assert.deepEqual(more, []);
  const failing = stubForge({ views: { 5: () => {
    throw Object.assign(new Error('boom'), { stderr: 'gh: Bad credentials (HTTP 401)\n' });
  } } });
  assert.deepEqual(lines(failing, { resumed: [{ key: 'ENG-1', pr: 5 }] }), ['needs your merge, unknown: #5 of ENG-1: the forge cannot read it (gh: Bad credentials (HTTP 401)), so whether auto-merge merges it cannot be told']);
  assert.deepEqual(humanMergeLines({ forge: stubForge(), repository: REPOSITORY, prefix: () => null, resumed: [{ key: 'ENG-1', pr: 5 }] }), ['needs your merge, unknown: git cannot say where the project folder is in the repository, so which pull requests auto-merge never merges cannot be told']);
});

test('neverMerged judges each changed file by the paths check alone, and the pointer file under both lifts', () => {
  const policies = (autoMerge) => ({ main: 'main', policy: { github: { autoMerge } }, basePolicy: { github: { autoMerge } }, policyFiles: ['.aidrian.json', '.aidrian/config.json'], configFile: '.aidrian/config.json' });
  const files = (...paths) => paths.map((path) => ({ path, changeType: 'MODIFIED' }));
  assert.equal(neverMerged(files('src/app.js', 'docs/readme.md'), '', policies({})), null);
  assert.deepEqual(neverMerged(files('src/app.js', '.github/workflows/ci.yml'), '', policies({})), { path: '.github/workflows/ci.yml', why: 'it changes ".github/workflows/ci.yml", which instructs AI sessions, or decides CI\'s verdict or auto-merge' });
  assert.equal(neverMerged(files('.github/workflows/ci.yml'), '', policies({ includeGuardedPaths: true })), null);
  assert.equal(neverMerged(files('.aidrian/config.json'), '', policies({ includeGuardedPaths: true })).path, '.aidrian/config.json');
  assert.equal(neverMerged(files('.aidrian/config.json'), '', policies({ includeGuardedPaths: true, includePolicyFiles: true })), null);
  // Another spelling of the pointer, which the gate's spelling rule refuses before the lifts, and the pointer itself.
  assert.match(neverMerged(files('.AIDRIAN.json'), '', policies({ includeGuardedPaths: true, includePolicyFiles: true })).why, /^it changes "\.AIDRIAN\.json" is "\.aidrian\.json" in another spelling/u);
  assert.match(neverMerged(files('.aidrian.json'), '', policies({ includeGuardedPaths: true, includePolicyFiles: true })).why, /the pointer file that locates the config/u);
  // A project below the top of the repository: a file outside its folder has had no review.
  assert.equal(neverMerged(files('apps/web/src/a.js', 'tools/b.js'), 'apps/web/', policies({})).path, 'tools/b.js');
});
