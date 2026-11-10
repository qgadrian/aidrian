import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { committedConfig, loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { findProject, projectAt } from '../plugins/aidrian/lib/project.mjs';
import { citationProblem } from '../plugins/aidrian/lib/review/flows.mjs';
import { reviewPrompt, runExec } from '../plugins/aidrian/lib/review/reviewers.mjs';
import { recordPass, recordSignoff, reviewStep } from '../plugins/aidrian/lib/review/run.mjs';

// A project whose `.aidrian/` folder sits below the repository root, at apps/web/: every path it configures is relative
// to that folder, so it reviews and guards as a project at the repository root does. Each repository is made with
// `git init` under mkdtemp. Only the GIT_DIR tests set GIT_DIR, to a temporary repository's own git folder.
const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'plugins/aidrian/bin/aidrian');
const MAIN = /aidrian worktree new <branch>/u;

const clean = async () => ({ status: 'done', findings: [], verdicts: [], dropped: [] });
const BOOKING_DOC = '# Booking\n\n## No double booking\nTwo bookings never hold one slot.\n\n## Refund cap\nA refund never exceeds the charge.\n';

function tempDir(t) {
  // realpath: on macOS the temporary folder is behind a symlink.
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-below-root-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const gitIn = (dir) => (...args) => {
  const result = spawnSync('git', ['-C', dir, '-c', 'user.name=Tester', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};

// A repository with `main`, holding the project under apps/web/ with `baseConfig` and apps/api/b.js beside it, and a
// `feat` branch made by `change(write, writeTop, below)`. `write` takes project-relative paths, `writeTop`
// repository-relative ones, and `below` is the project's folder. `at` moves the project, '' to the repository root.
// Returns the helpers a review step needs, with GitHub faked in memory.
function repo(t, { baseConfig = { version: 1 }, change, headConfig, baseFiles = {}, at = 'apps/web' } = {}) {
  const dir = tempDir(t);
  const below = path.join(dir, at);
  const git = gitIn(dir);
  const writeTop = (file, text) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  };
  const write = (file, text) => writeTop(path.join(at, file), text);
  git('init', '-q', '-b', 'main');
  writeTop('.gitignore', 'node_modules/\n');
  writeTop('apps/api/b.js', 'export const b = 1;\n');
  write('.aidrian/config.json', JSON.stringify(baseConfig));
  write('src/app.js', 'export const app = 1;\n');
  write('docs/flows/booking.md', BOOKING_DOC);
  for (const [file, text] of Object.entries(baseFiles)) write(file, text);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('switch', '-q', '-c', 'feat');
  change(write, writeTop, below);
  if (headConfig) write('.aidrian/config.json', JSON.stringify(headConfig));
  git('add', '-A');
  git('commit', '-q', '-m', 'change');
  const comments = [];
  const forge = {
    change: () => ({ number: 7, headRefOid: git('rev-parse', 'HEAD'), baseRefName: 'main', url: 'https://github.com/o/r/pull/7' }),
    repo: () => 'o/r',
    conversationComments: () => comments,
    postComment: (_repo, _n, body) => comments.push({ id: comments.length + 1, body, author_association: 'MEMBER' }),
    editComment: (_repo, id, body) => (comments.find((c) => c.id === id).body = body),
  };
  // A fresh project per step, so a local settings file written mid-test is read.
  const step = (deps = {}) => {
    const current = projectAt(below);
    return reviewStep({ pr: '7' }, { project: current, config: loadConfig(current).config, forge, codex: () => ({ ok: true }), ...deps });
  };
  return { dir, below, git, write, writeTop, comments, project: projectAt(below), step };
}

const holdsAll = (pass, evidence) => JSON.stringify(pass.flows.flatMap((flow) => flow.invariants.map((each) => ({ flow: flow.id, invariant: each.id, verdict: 'holds', evidence }))));

test('a below-root flow that passes aidrian lint review is selected, with its invariants read at the base', async (t) => {
  const flows = { booking: { files: ['src/booking/**'], invariants: 'docs/flows/booking.md', require: ['agent:product-manager'] } };
  const r = repo(t, { baseConfig: { version: 1, review: { flows } }, change: (write) => write('src/booking/book.js', 'export const book = 1;\n') });
  const lint = spawnSync(CLI, ['lint', 'review', '--project', r.below], { encoding: 'utf8' });
  assert.deepEqual([lint.status, lint.stderr], [0, '']);
  const first = await r.step({ exec: clean });
  assert.equal(first.status, 'dispatch');
  const pass = first.dispatch.find((each) => each.agent === 'product-manager');
  assert.deepEqual(pass.files, ['src/booking/book.js']);
  assert.deepEqual(pass.flows.find((flow) => flow.id === 'booking').invariants.map((each) => each.id), ['no-double-booking', 'refund-cap'], 'the base config was read, not defaults');
});

test('a pull request that changes a below-root project\'s config gets the harness sign-off, and evidence reads from the project', async (t) => {
  const flows = { booking: { files: ['src/booking/**'] } };
  const r = repo(t, { baseConfig: { version: 1, review: { flows } }, headConfig: { version: 1 }, change: (write) => write('src/booking/book.js', 'x\n') });
  const first = await r.step({ exec: clean });
  assert.deepEqual(first.plan.flows, ['booking', 'harness-config']);
  for (const pass of first.dispatch) recordPass(r.project, { pr: 7, repo: 'o/r', pass: pass.pass, head: first.head, reviewer: 'code-reviewer', findings: 0, fixed: 0, verdictsText: holdsAll(pass, 'src/booking/book.js:1') });
  const human = await r.step({ exec: clean });
  assert.equal(human.status, 'human_required');
  assert.deepEqual(human.flows, ['harness-config'], 'a citation of a project-relative path counts');
  recordSignoff(r.project, { pr: 7, repo: 'o/r', flow: 'harness-config', head: first.head, by: 'Tester' });
  assert.equal((await r.step({ exec: clean })).status, 'received');
});

test('a below-root project\'s exec reviewer runs from its folder in the base checkout, and editing its script is a change to the review', async (t) => {
  const scan = (title) => `let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log(JSON.stringify({findings:${title ? `[{file:'src/app.js',line:1,title:'${title}',body:'b',severity:'low'}]` : '[]'},verdicts:[]})))`;
  const reviewers = { scan: { kind: 'exec', command: ['node', 'scripts/scan.mjs'], timeoutSec: 30 } };
  const r = repo(t, {
    baseConfig: { version: 1, review: { reviewers } },
    baseFiles: { 'scripts/scan.mjs': scan('base found it') },
    change: (write) => {
      write('scripts/scan.mjs', scan(null));
      write('src/app.js', 'z\n');
      write('.aidrian.local.json', JSON.stringify({ review: { engine: 'scan' } }));
    },
  });
  const first = await r.step();
  assert.ok(first.plan.flows.includes('harness-config'), 'editing a reviewer\'s script is a change to the review');
  for (const pass of first.dispatch) recordPass(r.project, { pr: 7, repo: 'o/r', pass: pass.pass, head: first.head, reviewer: 'code-reviewer', findings: 0, fixed: 0, verdictsText: holdsAll(pass, 'src/app.js:1') });
  const result = await r.step();
  assert.equal(result.status, 'fix_required');
  assert.equal(result.open[0].findings[0].title, 'base found it', 'the pull request\'s emptied scanner did not run');
});

test('a below-root project\'s plan command runs from its folder, with the project\'s and the checkout top\'s dependencies linked in', async (t) => {
  const planner = `import depth from 'dep';
import agent from 'hoisted';
let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log(JSON.stringify({depth,stages:[{name:'local',passes:[{id:agent,reviewer:agent,kind:'agent',files:null}]}]})));`;
  const r = repo(t, {
    baseConfig: { version: 1, review: { planCommand: 'node scripts/plan.mjs' } },
    baseFiles: { 'scripts/plan.mjs': planner },
    change: (write, writeTop) => {
      write('src/app.js', 'y\n');
      write('node_modules/dep/index.js', 'module.exports = \'split\';\n');
      writeTop('node_modules/hoisted/index.js', 'module.exports = \'hoisted-reviewer\';\n');
    },
  });
  const result = await r.step({ exec: clean });
  assert.equal(result.plan.depth, 'split', 'the depth the project\'s own package gives');
  const agents = result.status === 'dispatch' ? result.dispatch.map((each) => each.agent) : (await r.step({ exec: clean })).dispatch.map((each) => each.agent);
  assert.ok(agents.includes('hoisted-reviewer'), 'the reviewer the package at the checkout top names');
});

test('a below-root project\'s checklist and cited doc section resolve, and an edit inside that section needs the Human', async (t) => {
  const flows = { booking: { files: ['src/booking/**'], invariants: [{ id: 'cap', cite: 'docs/flows/booking.md#refund-cap' }], require: ['agent:product-manager'] } };
  const base = { version: 1, github: { reviewGate: { enabled: true, checklist: 'docs/review-checklist.md' } }, review: { flows } };
  const r = repo(t, {
    baseConfig: base,
    baseFiles: { 'docs/review-checklist.md': '# Checklist\n\nNames every owner.\n' },
    change: (write) => write('src/booking/book.js', 'export const book = 1;\n'),
  });
  const first = await r.step({ exec: clean });
  assert.equal(first.status, 'dispatch');
  const pass = first.dispatch.find((each) => each.agent === 'product-manager');
  assert.match(pass.checklist.text, /Names every owner/u);
  assert.match(pass.flows.find((flow) => flow.id === 'booking').invariants[0].source, /A refund never exceeds/u);
  assert.ok(!first.plan.flows.includes('harness-config'), 'the cited doc did not change');

  const edited = repo(t, {
    baseConfig: base,
    baseFiles: { 'docs/review-checklist.md': '# Checklist\n\nNames every owner.\n' },
    change: (write) => {
      write('src/booking/book.js', 'export const book = 1;\n');
      write('docs/flows/booking.md', BOOKING_DOC.replace('never exceeds the charge', 'may exceed the charge'));
    },
  });
  assert.ok((await edited.step({ exec: clean })).plan.flows.includes('harness-config'), 'the cited section changed');
});

test('a below-root project\'s visual target and checklist resolve', async (t) => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const visual = { platform: 'web', targets: [{ files: ['src/components/**'], routes: ['/dashboard'] }], viewports: [360], checklist: 'docs/fit.md#fit-checks' };
  const flows = { ui: { files: ['src/components/**'], invariants: [{ id: 'fit', text: 'No horizontal overflow at the fit-check widths.' }], require: ['agent:designer'] } };
  const r = repo(t, {
    baseConfig: { version: 1, review: { flows, visual } },
    baseFiles: { 'docs/fit.md': '# Fit\n\n## Fit checks\nNo page scrolls sideways at 360 px.\n' },
    change: (write) => write('src/components/Button.tsx', 'export const Button = () => <button />;\n'),
  });
  r.write('.aidrian.local.json', JSON.stringify({ review: { visual: { baseUrl: 'http://localhost:3000' } } }));
  const captureSpawn = (_node, _args, { input }) => {
    const job = JSON.parse(input);
    const results = job.entries.map((entry) => {
      const file = path.join(job.outDir, `${entry.key}.png`);
      writeFileSync(file, Buffer.concat([PNG, Buffer.from(entry.key)]));
      return { key: entry.key, file, facts: { status: 200, overflowX: null, clippedText: [], smallTargets: [] } };
    });
    return { status: 0, stdout: JSON.stringify({ results }), stderr: '' };
  };
  const first = await r.step({ exec: clean, captureSpawn });
  assert.equal(first.status, 'dispatch');
  const pass = first.dispatch.find((each) => each.agent === 'designer');
  assert.equal(pass.visual.status, 'captured');
  assert.match(pass.visual.checklist.text, /sideways/u);
});

test('a below-root project\'s content selection reads the changed file\'s head text', async (t) => {
  const flows = { pay: { files: ['src/nothing/**'], content: { roots: ['src'], probes: ['chargeCard'] }, invariants: [{ id: 'cap', text: 'A refund never exceeds the charge.' }], require: ['agent:product-manager'] } };
  const r = repo(t, {
    baseConfig: { version: 1, review: { flows } },
    baseFiles: { 'src/pay.js': 'export const pay = () => chargeCard();\n' },
    change: (write) => write('src/pay.js', 'export const pay = () => chargeCard();\nexport const two = 2;\n'),
  });
  assert.ok((await r.step({ exec: clean })).plan.flows.includes('pay'), 'the probe is on a line the change does not add, so only the head text selects it');
});

test('a below-root project\'s flow selects on the lines a change adds, and an added line outside the project selects nothing', async (t) => {
  const flows = { pay: { files: ['src/nothing/**'], added: ['refundCard'], invariants: [{ id: 'cap', text: 'A refund never exceeds the charge.' }], require: ['agent:product-manager'] } };
  const baseConfig = { version: 1, review: { flows } };
  const inside = repo(t, { baseConfig, change: (write) => write('src/pay.js', 'export const pay = () => refundCard();\n') });
  assert.ok((await inside.step({ exec: clean })).plan.flows.includes('pay'));
  const outside = repo(t, { baseConfig, change: (write, writeTop) => {
    write('src/app.js', 'export const app = 2;\n');
    writeTop('apps/api/b.js', 'export const b = () => refundCard();\n');
  } });
  assert.ok(!(await outside.step({ exec: clean })).plan.flows.includes('pay'));
});

test('a below-root project\'s deleted flow test stops the review', async (t) => {
  const flows = { booking: { files: ['src/booking/**'], tests: ['test/booking*'] } };
  const r = repo(t, {
    baseConfig: { version: 1, review: { flows } },
    baseFiles: { 'test/booking.test.js': 'x\n', 'src/booking/a.js': 'y\n' },
    change: (_write, _writeTop, below) => rmSync(path.join(below, 'test/booking.test.js')),
  });
  const result = await r.step({ exec: clean });
  assert.equal(result.status, 'fix_required');
  assert.deepEqual(result.tests_removed.map((each) => [each.flow, each.deleted]), [['booking', ['test/booking.test.js']]]);
});

test('a below-root project reviews only its own folder: a change outside it needs no review, and is left out of a mixed one', async (t) => {
  const outside = repo(t, { change: (_write, writeTop) => writeTop('apps/api/b.js', 'export const b = 2;\n') });
  const none = await outside.step({ exec: () => assert.fail('nothing to review') });
  assert.equal(none.status, 'none_needed');
  assert.equal(outside.comments.length, 0);

  const flows = { app: { files: ['src/**'], invariants: [{ id: 'x', text: 'The app still starts.' }], require: ['agent:product-manager'] } };
  const mixed = repo(t, {
    baseConfig: { version: 1, review: { flows } },
    change: (write, writeTop) => {
      writeTop('apps/api/b.js', 'export const b = 2;\n');
      writeTop('src/top.js', 'export const top = 1;\n');
      write('src/app.js', 'export const app = 2;\n');
    },
  });
  const first = await mixed.step({ exec: clean });
  assert.deepEqual(first.dispatch.find((each) => each.agent === 'product-manager').files, ['src/app.js'], 'a top-level src/ is not this project\'s src/');
});

test('a below-root reviewer is told to run its diff with --relative and to cite from the project root; a root-level one reads what it always read', async (t) => {
  const flows = { booking: { files: ['src/booking/**'], invariants: 'docs/flows/booking.md', require: ['agent:product-manager'] } };
  const options = { baseConfig: { version: 1, review: { flows } }, change: (write) => write('src/booking/book.js', 'export const book = 1;\n') };
  const told = /in that folder with `--relative`.*Cite evidence from the project root, as `files` lists them/u;
  const reviewer = async (r) => (await r.step({ exec: clean })).dispatch.find((each) => each.agent === 'product-manager');
  const below = repo(t, options);
  const pass = await reviewer(below);
  assert.match(pass.brief, told);
  assert.match(pass.brief, /apps\/web\//u);
  const root = repo(t, { ...options, at: '' });
  assert.doesNotMatch((await reviewer(root)).brief ?? '', /--relative/u);

  // What Codex reads on stdin, from the folder it runs in.
  const prompted = async (dir, input) => {
    let prompt = '';
    const spawnImpl = (_command, argv) => {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => {}, unref: () => {} });
      child.stdin.on('data', (chunk) => (prompt += chunk));
      child.stdin.on('end', () => {
        writeFileSync(argv[argv.indexOf('-o') + 1], JSON.stringify({ findings: [], verdicts: [] }));
        child.stdout.end();
        child.stderr.end();
        setImmediate(() => child.emit('close', 0));
      });
      return child;
    };
    await runExec({ name: 'codex-local', kind: 'exec', builtIn: 'codex', timeoutSec: 5 }, input, { root: dir, env: {}, spawnImpl });
    return prompt;
  };
  const input = { base: 'b1', head: 'h1', files: null, flows: [] };
  assert.match(await prompted(below.below, input), told);
  assert.equal(await prompted(root.dir, input), reviewPrompt(input), 'at the repository root the prompt is the same text');
  assert.doesNotMatch(reviewPrompt(input), /--relative/u);
});

test('a below-root project\'s evidence reads from its own folder, not the repository root', (t) => {
  const r = repo(t, { change: (write) => write('src/app.js', 'export const app = 2;\n') });
  const head = r.git('rev-parse', 'HEAD');
  const problem = (evidence) => citationProblem(evidence, { root: r.below, head });
  assert.equal(problem('src/app.js:1'), null);
  assert.equal(problem('./src/app.js:1'), null);
  assert.match(problem('apps/web/src/app.js:1'), /is not in/u, 'the repository-root spelling is not how a project cites');
  assert.match(problem('src/app.js:9'), /no line 9/u);
});

test('committedConfig reads a below-root project\'s own file', (t) => {
  const r = repo(t, { baseConfig: { version: 1, github: { maxReviewRounds: 9 } }, change: (write) => write('src/app.js', 'x\n') });
  assert.equal(committedConfig(findProject(r.below), 'HEAD').github.maxReviewRounds, 9);
});

// `aidrian pre-commit`, run as the hook runs it, without an override the shell running the tests may hold.
const preCommit = (cwd, env = {}, args = []) => {
  const merged = { ...process.env, ...env };
  delete merged.AIDRIAN_ALLOW_MAIN_COMMIT;
  const { status, stderr } = spawnSync(CLI, ['pre-commit', ...args], { cwd, encoding: 'utf8', env: merged });
  return { status, stderr };
};

function guarded(t, guard, file, dir = tempDir(t)) {
  mkdirSync(dir, { recursive: true });
  const git = gitIn(dir);
  git('init', '-q', '-b', 'main');
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), JSON.stringify({ version: 1, git: { mainCheckout: { guard } } }));
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  git('switch', '-q', '--orphan', 'fresh');
  assert.equal(existsSync(path.join(dir, file)), false, 'the orphan switch removed config.json');
  return dir;
}

test('the commit guard reads a below-root project\'s config from the default branch after an orphan switch empties its folder', (t) => {
  const on = guarded(t, true, 'apps/web/.aidrian/config.json');
  assert.equal(existsSync(path.join(on, 'apps/web')), false, 'the project folder is gone from disk');
  const refused = preCommit(on, {}, ['--project', 'apps/web']);
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, MAIN);
  const off = guarded(t, false, 'apps/web/.aidrian/config.json');
  assert.deepEqual(preCommit(off, {}, ['--project', 'apps/web']), { status: 0, stderr: '' }, 'the committed guard is off');
});

test('the commit guard reads a project relocated by .aidrian.json from the default branch after an orphan switch', (t) => {
  const relocated = (guard, prefix) => {
    const dir = tempDir(t);
    const git = gitIn(dir);
    git('init', '-q', '-b', 'main');
    mkdirSync(path.join(dir, prefix, 'tools/aidrian'), { recursive: true });
    writeFileSync(path.join(dir, prefix, '.aidrian.json'), JSON.stringify({ dir: 'tools/aidrian' }));
    writeFileSync(path.join(dir, prefix, 'tools/aidrian/config.json'), JSON.stringify({ version: 1, git: { mainCheckout: { guard } } }));
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    git('switch', '-q', '--orphan', 'fresh');
    assert.equal(existsSync(path.join(dir, prefix, '.aidrian.json')), false, 'the orphan switch removed .aidrian.json');
    return dir;
  };
  for (const [prefix, args] of [['.', []], ['apps/web', ['--project', 'apps/web']]]) {
    const refused = preCommit(relocated(true, prefix), {}, args);
    assert.equal(refused.status, 1, `${prefix}: ${refused.stderr}`);
    assert.match(refused.stderr, MAIN);
    assert.deepEqual(preCommit(relocated(false, prefix), {}, args), { status: 0, stderr: '' }, `${prefix}: the committed guard is off`);
  }
});

test('a commit routed through GIT_DIR after an orphan switch is still judged by the root-level project\'s committed config', (t) => {
  const dir = guarded(t, true, '.aidrian/config.json');
  const refused = preCommit(tempDir(t), { GIT_DIR: path.join(dir, '.git') });
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, MAIN);
});

test('a commit routed through an absolute GIT_DIR from the folder above the repository reads the config the ref holds', (t) => {
  const above = tempDir(t);
  const on = guarded(t, true, '.aidrian/config.json', path.join(above, 'on'));
  const refused = preCommit(above, { GIT_DIR: path.join(on, '.git') });
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, MAIN);
  const off = guarded(t, false, '.aidrian/config.json', path.join(above, 'off'));
  assert.deepEqual(preCommit(above, { GIT_DIR: path.join(off, '.git') }), { status: 0, stderr: '' }, 'the committed guard is off, and it was read');
});

test('a commit routed through a relative GIT_DIR from the folder above the repository is refused', (t) => {
  const above = tempDir(t);
  guarded(t, true, '.aidrian/config.json', path.join(above, 'on'));
  const refused = preCommit(above, { GIT_DIR: 'on/.git' });
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, MAIN);
});

test('--project through a symlink or a symlinked parent still reads the committed config after an orphan switch', (t) => {
  const scratch = tempDir(t);
  const refusedAt = (cwd, project) => {
    const refused = preCommit(cwd, {}, ['--project', project]);
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, MAIN);
  };
  const direct = guarded(t, true, '.aidrian/config.json', path.join(scratch, 'direct'));
  symlinkSync(direct, path.join(scratch, 'link'));
  refusedAt(direct, path.join(scratch, 'link'));

  const parent = guarded(t, true, '.aidrian/config.json', path.join(scratch, 'real/repo'));
  symlinkSync(path.join(scratch, 'real'), path.join(scratch, 'alias'));
  refusedAt(parent, path.join(scratch, 'alias/repo'));

  const web = guarded(t, true, 'apps/web/.aidrian/config.json', path.join(scratch, 'real/mono'));
  refusedAt(web, path.join(scratch, 'alias/mono/apps/web'));
});

test('a repository with a separate git folder, on an orphan branch, is guarded by its committed config', (t) => {
  const dir = tempDir(t);
  const repository = path.join(dir, 'repo');
  gitIn(dir)('init', '-q', '-b', 'main', '--separate-git-dir', path.join(dir, 'store.git'), repository);
  mkdirSync(path.join(repository, '.aidrian'));
  writeFileSync(path.join(repository, '.aidrian/config.json'), JSON.stringify({ version: 1, git: { mainCheckout: { guard: true } } }));
  const git = gitIn(repository);
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  git('switch', '-q', '--orphan', 'fresh');
  const refused = preCommit(repository);
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, MAIN);
});

test('evidence below the root must name a file, and a file outside the project still counts', (t) => {
  const dir = tempDir(t);
  const git = gitIn(dir);
  git('init', '-q', '-b', 'main');
  mkdirSync(path.join(dir, 'apps/web/src'), { recursive: true });
  mkdirSync(path.join(dir, 'packages/shared'), { recursive: true });
  writeFileSync(path.join(dir, 'apps/web/src/a.js'), '1\n');
  writeFileSync(path.join(dir, 'packages/shared/lock.js'), '1\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  const options = { root: path.join(dir, 'apps/web'), head: git('rev-parse', 'HEAD').trim() };
  for (const file of ['src/a.js:1', '../../packages/shared/lock.js:1']) assert.equal(citationProblem(file, options), null, file);
  for (const folder of ['src:1', './:1', '.:1', '..:1', '../../packages:1']) assert.notEqual(citationProblem(folder, options), null, folder);
});
