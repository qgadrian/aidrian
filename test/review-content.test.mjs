import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { contentFlows } from '../plugins/aidrian/lib/review/content.mjs';
import { changedFiles, diffLines } from '../plugins/aidrian/lib/review/diff.mjs';
import { isolate } from '../plugins/aidrian/lib/review/env.mjs';
import { acquiredVars, callsWith, EXTENSIONS_RE, importWord, parse, RESOLVE_SUFFIXES } from '../plugins/aidrian/lib/review/trace-js.mjs';

// A privileged-client flow as a project with a service-role database client would write it: the paths that hold the
// client, the added lines that acquire it, and the content and trace keys for what neither shows.
const FLOW = 'service-role';
const FACTORIES = [String.raw`get\w*AdminClient\s*\(`, String.raw`getSupabase\w*Client\s*\(\s*\{\s*admin\s*:\s*true\b`];
const flow = {
  files: [
    String.raw`re:^src\/core\/supabase\/(?:get-admin-client|route-handler-client|server-component-client|action-client)\.`,
    String.raw`re:^src\/(?:lib|app\/api)\/admin\/tasks\/`,
    String.raw`re:^src\/lib\/(?:areas\/mutations\/delete-area|staff\/(?:mutations\/set-staff-services|queries\/get-staff-(?:by-uuid|public)))\.`,
  ],
  added: [
    String.raw`\bget\w*AdminClient\s*\(`,
    String.raw`\badmin\s*:\s*true\b`,
    String.raw`\bsupabaseAdmin\b`,
    String.raw`\bSUPABASE_SERVICE_ROLE_KEY\b`,
    String.raw`['"]service_role['"]`,
  ],
  require: ['agent:security-engineer'],
  content: {
    roots: ['src', 'supabase/functions'],
    exclude: [String.raw`re:(?:^|\/)(?:__tests__|__mocks__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|^src\/tests\/`],
    probes: [String.raw`\badminClient\b`],
    trace: {
      variables: ['adminClient', 'supabaseAdmin', 'ctx.adminClient'],
      factories: FACTORIES,
      params: ['client', 'supabase', 'db'],
      aliases: { '~/': 'src/' },
      hops: 2,
    },
  },
};
const flows = { [FLOW]: flow, booking: { files: ['src/booking/**'] } };

const ACQUIRE = '  const client = getSupportAiAdminClient();';
const consumer = (filter) => ['export const load = async (orgId) => {', ACQUIRE, `  return client.from('drafts').select('*')${filter};`, '};', ''].join('\n');
// The client handed down as `adminClient`, which no added-line pattern names.
const ctxConsumer = (filter) =>
  ['export const load = async (ctx, orgId) => {', '  const { adminClient } = ctx;', `  return adminClient.from('drafts').select('*')${filter};`, '};', ''].join('\n');
const FILE = 'src/lib/support/mutations/create-x.ts';
const CTX_FILE = 'src/lib/support/mutations/ctx-x.ts';
const QUERY_ONLY = { [FILE]: ["  return client.from('drafts').select('*');"] };
const ADDED_REASON = String.raw`head content matches /\bget\w*AdminClient\s*\(/ in `;
const PROBE_REASON = String.raw`head content matches /\badminClient\b/ in `;

// A throwaway repository under the system temp folder, with `files` at base and `changed` on top of them at head.
// Every git call runs in it with the hook variables removed, so no test ever acts on another repository.
function fixture(t, files, changed = null) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-review-content-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => {
    const out = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: root, env: isolate({ ...process.env }), encoding: 'utf8' });
    if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
    return out.stdout.trim();
  };
  const write = (all) => {
    for (const [rel, text] of Object.entries(all)) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), text);
    }
  };
  git('init', '-q', '-b', 'main', '.');
  write(files);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  if (changed) {
    write(changed);
    git('add', '-A');
    git('commit', '-q', '-m', 'change');
  }
  return { root, base, head: git('rev-parse', 'HEAD') };
}

// The content flows for one change whose head text is `text`, with the added lines given.
const select = (t, change, text, addedLines = {}) => {
  const { root, head } = fixture(t, { [change.file]: text, 'src/other.ts': 'export const x = 1;\n' });
  return contentFlows({ root, head, changes: [change], addedLines, flows });
};
const change = (file, status = 'M') => ({ file, status, added: 1, removed: 1 });

test('trace-js: the source files it reads, the suffixes it resolves, and the word an importer names a file by', () => {
  assert.ok(['a.ts', 'a.tsx', 'a.js', 'a.jsx', 'a.mjs', 'a.cjs', 'a.mts', 'a.cts'].every((file) => EXTENSIONS_RE.test(file)));
  assert.ok(!['a.mdx', 'a.json', 'a.sql', 'a.d'].some((file) => EXTENSIONS_RE.test(file)));
  assert.deepEqual(RESOLVE_SUFFIXES, ['', '.ts', '.tsx', '.mjs', '.js', '/index.ts', '/index.tsx']);
  assert.equal(importWord('src/lib/widgets/load-widget.ts'), 'load-widget');
  assert.equal(importWord('src/lib/gadgets/mutations/index.ts'), 'mutations');
});

test('trace-js parse: named, default, namespace, aliased, and barrel imports resolve to tracked files; packages do not', () => {
  const tracked = new Set(['src/lib/widgets.ts', 'src/lib/x/index.ts', 'src/lib/y.mjs', 'src/a/b.ts', 'supabase/functions/f/db.ts']);
  const text = [
    "import {\n  // the loader\n  loadWidget,\n  /* renamed */ saveWidget as save,\n  type Widget,\n  'kebab-name' as kebab,\n} from './widgets';",
    "import def, { y } from '~/lib/y.mjs';",
    "import * as x from '~/lib/x';",
    "import { b } from '../a/b';",
    "import { z } from 'zod';",
    "export { b as bee, type c } from '../a/b';",
    "export * from './widgets';",
    '',
  ].join('\n');
  const { imports, reExports } = parse('src/lib/a.ts', text, { tracked, aliases: { '~/': 'src/' } });
  assert.deepEqual([...imports.keys()], ['loadWidget', 'save', 'Widget', 'def', 'y', 'x', 'b'], 'comments, `type`, and quoted names are read right');
  assert.deepEqual(imports.get('save'), { target: 'src/lib/widgets.ts', imported: 'saveWidget' });
  assert.deepEqual(imports.get('def'), { target: 'src/lib/y.mjs', imported: 'default' });
  assert.deepEqual(imports.get('x'), { target: 'src/lib/x/index.ts', imported: '*' });
  assert.deepEqual(reExports, [{ target: 'src/a/b.ts', names: new Map([['bee', 'b'], ['c', 'c']]) }], '`export *` is not followed');
  const edge = parse('supabase/functions/f/index.ts', "import { w } from './db.ts';\nimport { v } from '~/lib/widgets';\n", { tracked });
  assert.deepEqual([...edge.imports], [['w', { target: 'supabase/functions/f/db.ts', imported: 'w' }]], 'an alias is followed only when configured');
});

test('trace-js callsWith: balanced arguments, quoted strings left out, generic and member calls, dotted variables', () => {
  const factory = new RegExp(String.raw`\b(?:${FACTORIES.map((source) => `(?:${source})`).join('|')})`, 'u');
  const names = new Set(['load', 'tasks', 'report']);
  const text = [
    'load(id, client);',
    "report({ fingerprint: ['supabase-x'] });",
    'tasks.update<{ a: string }>(ctx.adminClient, id);',
    'load(getAdminClient());',
    'other(client);',
    'load(wrap(a, b), `${db}`);',
    '',
  ].join('\n');
  assert.deepEqual(callsWith(text, names, ['client', 'supabase', 'db', 'ctx.adminClient'], factory), [
    { name: 'load', variable: 'client', line: 1 },
    { name: 'tasks.update', variable: 'ctx.adminClient', line: 3 },
    { name: 'load', variable: 'an inline factory call', line: 4 },
    { name: 'load', variable: 'db', line: 6 },
  ]);
  assert.deepEqual(callsWith('load(getAdminClient());', names, [], null), [], 'no factory, no inline match');
  const pad = (n) => `load(${'x'.repeat(n)}, adminClient);`;
  assert.equal(callsWith(pad(19980), names, ['adminClient']).length, 1, 'an argument list under the cap is read whole');
  assert.equal(callsWith(pad(20000), names, ['adminClient']).length, 0, 'past 20000 characters the arguments are cut');
});

test('trace-js acquiredVars: the variables a factory call assigns, with let, var, a type, or await', () => {
  const source = FACTORIES.map((each) => `(?:${each})`).join('|');
  const text = [
    'const a = getAdminClient();',
    'let b: SupabaseClient<Db> = await getSupabaseServerClient({ admin: true });',
    'var c = getSupabaseServerClient();',
    'const d = await getSupportAiAdminClient();',
    '',
  ].join('\n');
  assert.deepEqual([...acquiredVars(text, source)], ['a', 'b', 'd']);
  assert.deepEqual([...acquiredVars(text, null)], []);
});

test('a changed source file that uses the client outside its added lines selects the flow by its head content', (t) => {
  assert.deepEqual(select(t, change(FILE), consumer(''), QUERY_ONLY), [{ id: FLOW, files: [FILE], reasons: [`${ADDED_REASON}${FILE}`] }]);
  assert.deepEqual(select(t, change(CTX_FILE), ctxConsumer('')), [{ id: FLOW, files: [CTX_FILE], reasons: [`${PROBE_REASON}${CTX_FILE}`] }], 'the client handed down in ctx');
  const edge = 'supabase/functions/send-x/index.ts';
  assert.deepEqual(select(t, change(edge), consumer('')).map((each) => each.files), [[edge]], 'an Edge Function');
});

test('what the built-in plan covers, tests, deletions, files outside the roots, and files without the client add nothing', (t) => {
  const cases = [
    ['a files match', change('src/core/supabase/get-admin-client.ts'), consumer(''), {}],
    ['an added line an added pattern matches', change(FILE), consumer(''), { [FILE]: [ACQUIRE] }],
    ['a test file', change('src/lib/support/mutations/create-x.test.ts'), consumer(''), {}],
    ['a mocks file', change('src/lib/__mocks__/x.ts'), ctxConsumer(''), {}],
    ['a deleted file', change(FILE, 'D'), consumer(''), {}],
    ['a migration', change('supabase/migrations/20990101000000_x.sql'), consumer(''), {}],
    ['a non-source file under src', change('src/content/docs/en/x.mdx'), ctxConsumer(''), {}],
    ['an e2e file', change('e2e/helpers/seed-x.ts'), ctxConsumer(''), {}],
    ['a scripts file', change('scripts/x.mjs'), ctxConsumer(''), {}],
    ['a root config file', change('next.config.ts'), consumer(''), {}],
    ['a sibling folder that shares a root prefix', change('srcx/a.ts'), consumer(''), {}],
    ['a file without the client', change(FILE), "export const load = () => client.from('drafts');\n", QUERY_ONLY],
  ];
  for (const [label, each, text, addedLines] of cases) assert.deepEqual(select(t, each, text, addedLines), [], label);
});

test('mixed with a built-in file, only the content-matched file is named, in the reasons too', (t) => {
  const builtIn = 'src/core/supabase/get-admin-client.ts';
  const { root, head } = fixture(t, { [builtIn]: consumer(''), [CTX_FILE]: ctxConsumer('') });
  const result = contentFlows({ root, head, changes: [change(builtIn), change(CTX_FILE)], addedLines: {}, flows });
  assert.deepEqual(result, [{ id: FLOW, files: [CTX_FILE], reasons: [`${PROBE_REASON}${CTX_FILE}`] }]);
});

test('a flow without content takes no part and runs no git; one without trace greps nothing', (t) => {
  const never = () => {
    throw new Error('git ran');
  };
  assert.deepEqual(contentFlows({ root: '/nonexistent', head: 'h', changes: [change(FILE)], flows: { booking: { files: ['src/**'] } }, spawn: never }), []);
  const { root, head } = fixture(t, { [FILE]: consumer(''), [CTX_FILE]: "export const load = () => 1;\n" });
  const ran = [];
  const spawn = (command, args, options) => {
    ran.push(args[0]);
    return spawnSync(command, args, options);
  };
  const noTrace = { ...flow, content: { ...flow.content, trace: undefined } };
  const result = contentFlows({ root, head, changes: [change(FILE), change(CTX_FILE)], flows: { [FLOW]: noTrace }, spawn });
  assert.deepEqual(result.map((each) => each.files), [[FILE]]);
  assert.deepEqual(ran, ['ls-tree', 'cat-file'], 'one listing and one batched read, no grep');
});

test('several content flows share one head read; each lists at most 25 reasons', (t) => {
  const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`src/lib/m/f${String(i).padStart(2, '0')}.ts`, ctxConsumer('')]));
  const { root, head } = fixture(t, many);
  const ran = [];
  const spawn = (command, args, options) => {
    ran.push(args[0]);
    return spawnSync(command, args, options);
  };
  const other = { files: ['src/nothing/**'], content: { roots: ['src/lib'], probes: [String.raw`\bfrom\(`] } };
  const result = contentFlows({ root, head, changes: Object.keys(many).map((file) => change(file)), flows: { [FLOW]: flow, other }, spawn });
  assert.deepEqual(result.map((each) => [each.id, each.files.length, each.reasons.length]), [[FLOW, 30, 25], ['other', 30, 25]]);
  assert.equal(ran.filter((each) => each === 'cat-file').length, 1, 'one batched read for both flows');
  assert.equal(ran.filter((each) => each === 'ls-tree').length, 1);
  assert.equal(ran.filter((each) => each === 'grep').length, 0, 'every file matched by content, so no trace runs');
});

test('end to end: only query lines change under an untouched or handed-down client, and the flow is still selected', (t) => {
  const DROPPED = 'src/lib/support/mutations/drop-x.ts';
  const filter = ".eq('organization_id', orgId)";
  const { root, base, head } = fixture(
    t,
    { [FILE]: consumer(''), [CTX_FILE]: ctxConsumer(''), 'src/other.ts': 'export const x = 1;\n', [DROPPED]: consumer('') },
    { [FILE]: consumer(filter), [CTX_FILE]: ctxConsumer(filter), 'src/other.ts': 'export const x = 2;\n', [DROPPED]: 'export const load = async () => [];\n' },
  );
  const { addedLines } = diffLines(root, base, head);
  assert.deepEqual(addedLines[FILE], [`  return client.from('drafts').select('*')${filter};`], 'only the query line is added');
  assert.deepEqual(addedLines[CTX_FILE], [`  return adminClient.from('drafts').select('*')${filter};`], 'only the query line is added');
  const result = contentFlows({ root, head, changes: changedFiles(root, base, head), addedLines, flows });
  assert.deepEqual(result.map((each) => [each.id, each.files]), [[FLOW, [FILE, CTX_FILE].sort()]]);
});

test('end to end: a callee handed the client as a plain `client` is left to its named path entry', (t) => {
  const CALLER = 'src/lib/staff/loaders/load-staff-x.ts';
  const CALLEE = 'src/lib/staff/queries/get-staff-public.ts';
  const caller = (uid) =>
    ["import { getStaffPublic } from '../queries/get-staff-public';", `export const load = async (${uid}) => {`, '  const client = getAdminClient();', `  return getStaffPublic(client, ${uid});`, '};', ''].join('\n');
  const callee = (filter) => ['export const getStaffPublic = async (client, uid) =>', `  client.from('staff').select('*').eq('uid', uid)${filter};`, ''].join('\n');
  const { root, base, head } = fixture(t, { [CALLER]: caller('uid'), [CALLEE]: callee('') }, { [CALLER]: caller('staffUid'), [CALLEE]: callee(".eq('is_public', true)") });
  const { addedLines } = diffLines(root, base, head);
  const result = contentFlows({ root, head, changes: changedFiles(root, base, head), addedLines, flows });
  // The caller's content names the client, so the content scan selects it; the callee's names only `client`.
  assert.deepEqual(result.map((each) => [each.id, each.files]), [[FLOW, [CALLER]]]);
  assert.ok(flow.files.some((entry) => new RegExp(entry.slice('re:'.length), 'u').test(CALLEE)), `${CALLEE} is named by a files entry`);
});

const callee = (name, table, params, filter) => [`export const ${name} = async (${params}) =>`, `  client.from('${table}').select('*')${filter};`, ''].join('\n');

test('end to end: a callee handed the client is selected, by position, alias, barrel, namespace, inline factory, Edge Function, or hop', (t) => {
  const UPDATE = 'src/lib/widgets/mutations/update-widget.ts';
  const LOAD = 'src/lib/widgets/queries/load-widget.ts';
  const LIST = 'src/lib/widgets/queries/list-widgets.ts';
  const ARCHIVE = 'src/lib/gadgets/mutations/archive-gadget.ts';
  const WRITE = 'src/lib/gizmos/mutations/write-gizmo.ts';
  const ROW = 'src/lib/staff/queries/staff-row.ts';
  const INVITE = 'src/lib/invites/queries/find-invite.ts';
  // Re-exported by the same barrel, never imported from it: not selected.
  const RESTORE = 'src/lib/gadgets/mutations/restore-gadget.ts';
  const REPORT = 'src/lib/monitoring/report.ts';
  const FEED = 'src/lib/feeds/enqueue-feeds.ts';
  const TASK = 'src/lib/tasks/mutations/update-task.ts';
  const EDGE = 'supabase/functions/send-x/db.ts';
  const PADDED = [199, 200, 201].map((n) => [`src/lib/pads/pad-${n}.ts`, `pad${n}`, n]);
  // An argument list of exactly `n` characters before the client.
  const pad = (n) => `'${'x'.repeat(n - 4)}', `;
  const files = {
    [UPDATE]: callee('updateWidget', 'widgets', 'params, client', ''),
    [LOAD]: callee('loadWidget', 'widgets', 'client, id', ''),
    [LIST]: callee('listWidgets', 'widgets', 'client', ''),
    [ARCHIVE]: callee('archiveGadget', 'gadgets', 'id, client', ''),
    [WRITE]: callee('writeGizmo', 'gizmos', 'client, id', ''),
    [ROW]: callee('staffRow', 'staff', 'client, uid', ''),
    [INVITE]: callee('findInvite', 'invites', 'client, code', ''),
    [FEED]: callee('enqueueFeeds', 'feeds', 'client', ''),
    [TASK]: callee('updateTask', 'tasks', 'client, id', ''),
    [EDGE]: callee('writeRow', 'rows', 'client', ''),
    ...Object.fromEntries(PADDED.map(([file, name]) => [file, callee(name, 'pads', 'label, client', '')])),
    // The factory called inline as the argument.
    'src/app/api/cronjobs/enqueue-feeds/route.ts': ["import { enqueueFeeds } from '~/lib/feeds/enqueue-feeds';", 'export const GET = async () => enqueueFeeds(getAdminClient());', ''].join('\n'),
    // A namespace import.
    'src/lib/tasks/loaders/task-page.ts': [
      "import * as tasks from '~/lib/tasks/mutations/update-task';",
      'export const taskPage = async (ctx, id) => tasks.updateTask(ctx.adminClient, id);',
      '',
    ].join('\n'),
    // An Edge Function helper.
    'supabase/functions/send-x/index.ts': ["import { writeRow } from './db.ts';", 'export const handle = async (adminClient) => writeRow(adminClient);', ''].join('\n'),
    // Argument lists just under, at, and over the 200 characters a scan once stopped at.
    'src/lib/pads/loaders/pad-page.ts': [
      ...PADDED.map(([file, name]) => `import { ${name} } from '~/${file.slice('src/'.length).replace(/\.ts$/u, '')}';`),
      'export const padPage = async (adminClient) => {',
      ...PADDED.map(([, name, n]) => `  await ${name}(${pad(n)}adminClient);`),
      '};',
      '',
    ].join('\n'),
    // A generic call: type arguments between the name and the client.
    'src/app/app/invite/[code]/page.tsx': [
      "import { findInvite } from '~/lib/invites/queries/find-invite';",
      'export const getInvite = async (adminClient, code) =>',
      '  findInvite<{ a: string }>(adminClient, code);',
      '',
    ].join('\n'),
    // A test that hands the client over is not an importer.
    'src/lib/widgets/queries/list-widgets.test.ts': [
      "import { listWidgets } from './list-widgets';",
      "test('lists', async () => {",
      '  const adminClient = makeAdminClient();',
      '  await listWidgets(adminClient);',
      '});',
      '',
    ].join('\n'),
    // Hop 2 from a named callee, with no importer of its own here.
    'src/lib/staff/queries/get-staff-public.ts': ["import { staffRow } from './staff-row';", 'export const getStaffPublic = async (client, uid) => staffRow(client, uid);', ''].join('\n'),
    // The client as the second argument.
    'src/lib/widgets/loaders/save-widget.ts': [
      "import { updateWidget } from '~/lib/widgets/mutations/update-widget';",
      'export const save = async (params) => {',
      '  const client = getAdminClient();',
      '  await updateWidget(params, client);',
      '};',
      '',
    ].join('\n'),
    // ctx.adminClient handed to an aliased import inside an API handler.
    'src/app/api/widgets/[id]/route.ts': [
      "import { withApiKeyHandler } from '~/core/api/with-api-key-handler';",
      "import { loadWidget as load } from '../../../../lib/widgets/queries/load-widget';",
      'export const GET = withApiKeyHandler(async (request, ctx) => load(ctx.adminClient, request.id));',
      '',
    ].join('\n'),
    // Only ever called with the user-scoped client: no selection.
    'src/lib/widgets/loaders/list-page.ts': [
      "import { listWidgets } from '~/lib/widgets/queries/list-widgets';",
      'export const listPage = async () => {',
      '  const client = await getSupabaseRouteHandlerClient();',
      '  return listWidgets(client);',
      '};',
      '',
    ].join('\n'),
    // Through one barrel.
    'src/lib/gadgets/mutations/index.ts': "export { archiveGadget } from './archive-gadget';\nexport { restoreGadget } from './restore-gadget';\n",
    [RESTORE]: callee('restoreGadget', 'gadgets', 'id, client', ''),
    'src/lib/gadgets/loaders/archive-page.ts': ["import { archiveGadget } from '~/lib/gadgets/mutations';", 'export const archive = async (id, supabaseAdmin) => archiveGadget(id, supabaseAdmin);', ''].join('\n'),
    // Hop 2: the privileged importer hands the client to syncGizmo, which hands it on as `client` to writeGizmo.
    'src/lib/gizmos/helpers/sync-gizmo.ts': [
      "import { writeGizmo } from '../mutations/write-gizmo';",
      "import { report } from '../../monitoring/report';",
      'export const syncGizmo = async (client, id) => writeGizmo(client, id);',
      "export const failGizmo = () => report({ fingerprint: ['supabase-x'] });",
      '',
    ].join('\n'),
    // Called by the hop-1 callee with 'supabase-x' only inside a string: not selected.
    [REPORT]: callee('report', 'reports', 'event', ''),
    'src/lib/gizmos/loaders/sync-page.ts': [
      "import { syncGizmo } from '~/lib/gizmos/helpers/sync-gizmo';",
      'export const syncPage = async (ctx, id) => {',
      '  const { adminClient } = ctx;',
      '  return syncGizmo(adminClient, id);',
      '};',
      '',
    ].join('\n'),
  };
  const filter = ".eq('organization_id', orgId)";
  const changed = {
    [UPDATE]: callee('updateWidget', 'widgets', 'params, client', filter),
    [LOAD]: callee('loadWidget', 'widgets', 'client, id', filter),
    [LIST]: callee('listWidgets', 'widgets', 'client', filter),
    [ARCHIVE]: callee('archiveGadget', 'gadgets', 'id, client', filter),
    [WRITE]: callee('writeGizmo', 'gizmos', 'client, id', filter),
    [ROW]: callee('staffRow', 'staff', 'client, uid', filter),
    [INVITE]: callee('findInvite', 'invites', 'client, code', filter),
    [RESTORE]: callee('restoreGadget', 'gadgets', 'id, client', filter),
    [REPORT]: callee('report', 'reports', 'event', filter),
    [FEED]: callee('enqueueFeeds', 'feeds', 'client', filter),
    [TASK]: callee('updateTask', 'tasks', 'client, id', filter),
    [EDGE]: callee('writeRow', 'rows', 'client', filter),
    ...Object.fromEntries(PADDED.map(([file, name]) => [file, callee(name, 'pads', 'label, client', filter)])),
  };
  const { root, base, head } = fixture(t, files, changed);
  const { addedLines } = diffLines(root, base, head);
  const changes = changedFiles(root, base, head);
  for (const file of Object.keys(changed)) assert.equal(addedLines[file].length, 1, `only the query line of ${file} changes`);
  assert.deepEqual(changes.map((each) => each.file).sort(), Object.keys(changed).sort());

  const [entry, ...rest] = contentFlows({ root, head, changes, addedLines, flows });
  assert.deepEqual(rest, []);
  const expected = [ARCHIVE, UPDATE, LOAD, WRITE, ROW, INVITE, FEED, TASK, EDGE, ...PADDED.map(([file]) => file)].sort();
  assert.deepEqual([entry.id, entry.files], [FLOW, expected], 'the user-scoped, string-literal, and re-exported-only callees are not selected');
  const reason = (file) => entry.reasons.find((each) => each.includes(`${file} receives`)) ?? '';
  assert.match(reason(UPDATE), /save-widget\.ts:4 calls updateWidget\(\.\.\. client \.\.\.\)/u);
  assert.match(reason(LOAD), /route\.ts:3 calls load\(/u);
  assert.match(reason(ARCHIVE), /archive-page\.ts:2 calls archiveGadget\(/u);
  assert.match(reason(WRITE), /sync-gizmo\.ts:3 calls writeGizmo\(\.\.\. client \.\.\.\), and .*sync-page\.ts:4 hands it adminClient/u);
  assert.match(reason(INVITE), /page\.tsx:3 calls findInvite\(\.\.\. adminClient \.\.\.\)/u);
  assert.match(reason(FEED), /enqueue-feeds\/route\.ts:2 calls enqueueFeeds\(\.\.\. an inline factory call \.\.\.\)/u);
  assert.match(reason(TASK), /task-page\.ts:2 calls tasks\.updateTask\(/u);
  assert.match(reason(EDGE), /send-x\/index\.ts:2 calls writeRow\(\.\.\. adminClient \.\.\.\)/u);
  assert.match(reason(ROW), /get-staff-public\.ts:2 calls staffRow\(\.\.\. client \.\.\.\), and .* is a named service-role callee/u);
  assert.equal(entry.reasons.length, expected.length, 'one reason per callee');
  assert.ok(entry.reasons.every((each) => each.startsWith(`src/`) || each.startsWith('supabase/')), entry.reasons.join('\n'));
  assert.match(reason(UPDATE), new RegExp(`^${UPDATE} receives the ${FLOW} value: src/lib/widgets/loaders/save-widget\\.ts:4 `, 'u'));

  // One hop leaves out the callees only a client-like parameter reaches.
  const oneHop = { [FLOW]: { ...flow, content: { ...flow.content, trace: { ...flow.content.trace, hops: 1 } } } };
  const [hop1] = contentFlows({ root, head, changes, addedLines, flows: oneHop });
  assert.deepEqual(hop1.files, expected.filter((file) => file !== WRITE && file !== ROW));
});

test('a git run that fails throws and names the command; it never reads as nothing selected', (t) => {
  const { root } = fixture(t, { [FILE]: consumer('') });
  assert.throws(() => contentFlows({ root, head: '0'.repeat(40), changes: [change(FILE)], flows }), /git ls-tree at 0{40} failed: exit 128/u);

  const ok = { status: 0, signal: null, stdout: '', stderr: '' };
  const spawnWith = (failures) => (_command, args) => failures[args[0]] ?? (args[0] === 'cat-file' ? { ...ok, stdout: Buffer.alloc(0) } : ok);
  const run = (failures) => contentFlows({ root: '/nonexistent', head: 'HEAD', changes: [change(FILE)], flows, spawn: spawnWith(failures) });
  assert.throws(() => run({ 'ls-tree': { ...ok, status: 128, stderr: 'fatal: not a tree' } }), /git ls-tree at HEAD failed: exit 128: fatal: not a tree/u);
  for (const failure of [{ ...ok, status: 2 }, { ...ok, status: null, signal: 'SIGTERM' }, { ...ok, status: null, error: new Error('spawn git ENOENT') }]) {
    assert.throws(() => run({ grep: failure }), /git grep at HEAD failed/u, JSON.stringify(failure));
  }
  assert.deepEqual(run({ grep: { ...ok, status: 1 } }), [], 'grep exit 1 is no match');
  for (const failure of [{ ...ok, status: 128 }, { ...ok, status: null, signal: 'SIGKILL' }]) {
    assert.throws(() => run({ 'cat-file': failure }), /git cat-file --batch at HEAD failed/u, JSON.stringify(failure));
  }
});
