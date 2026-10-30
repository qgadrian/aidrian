// Command line for knowledge.mjs. Users run it through bin/aidrian-knowledge. `aidrian check` validates the same data.

import path from 'node:path';

import { indexRows, initBucket, listTags, loadKnowledge, pluginTags, routeKnowledge, searchKnowledge } from './knowledge.mjs';
import { findProject, noProjectMessage } from './project.mjs';

const USAGE = `usage: aidrian-knowledge <command> [--project DIR] [args]

  route TAG...     print the docs to read for these tags, "always" docs first
  tags             print each tag and how many docs it loads
  search WORD...   print the best 8 docs whose tags, path, or summary hold these words; --all prints every match
  index            print every doc: path, tags, and summary, separated by tabs
  init FOLDER      draft a knowledge index for FOLDER, a folder of docs, in the project folder

The project is the nearest one at or above DIR, which defaults to the current folder.
FOLDER is relative to the project root. \`aidrian check\` validates the project folder and every index.
A doc from a local knowledge source prints its absolute path, and its source as the last column.`;

const args = process.argv.slice(2);
const command = args.shift();
if (['--help', '-h', 'help'].includes(command)) {
  console.log(USAGE);
  process.exit(0);
}
let start = process.cwd();
let all = false;
const rest = [];
while (args.length) {
  const arg = args.shift();
  if (arg === '--project') {
    start = args.shift();
    // An option's value never starts with "-": `--project --bogus` is a missing folder, not a folder named --bogus.
    if (!start || start.startsWith('-')) fail(`${USAGE}\n\n--project needs a folder.`);
  } else if (arg === '--all' && command === 'search') {
    all = true;
  } else if (arg.startsWith('-')) {
    fail(`${USAGE}\n\nunknown option: ${arg}`);
  } else {
    rest.push(arg);
  }
}

if (!['route', 'tags', 'search', 'index', 'init'].includes(command)) fail(USAGE);
if (['tags', 'index'].includes(command) && rest.length) fail(`${USAGE}\n\nunexpected argument: ${rest[0]}`);
if (command === 'search' && !rest.length) fail(`${USAGE}\n\nsearch needs at least one word.`);
if (command === 'init' && rest.length !== 1) fail(`${USAGE}\n\ninit needs one folder.`);

const project = findProject(start);
if (!project) fail(noProjectMessage(path.resolve(start)));
if (command === 'init') init(project, rest[0]);

const { buckets, errors } = loadKnowledge(project);
if (errors.length) fail(errors.join('\n'));

// One output line: the doc path, `columns`, and the source when the doc comes from a local source.
const sourceOf = new Map(indexRows(buckets).map((doc) => [doc.path, doc.source]));
const line = (doc, ...columns) => [doc, ...columns, ...(sourceOf.get(doc) ? [sourceOf.get(doc)] : [])].join('\t');

if (command === 'route') {
  // A tag the plugin asks for may be one the project does not define; it loads nothing. Any other tag is a typo.
  const known = [...new Set([...pluginTags(), ...listTags(buckets).map(([tag]) => tag)])].sort();
  const unknown = rest.filter((tag) => !known.includes(tag));
  if (unknown.length) fail(`unknown tag: ${unknown.join(', ')}\nknown tags: ${known.join(', ')}`);
  const docs = routeKnowledge(buckets, rest);
  for (const doc of docs) console.log(line(doc));
  // A tag no doc carries yet still routes: to the "always" docs alone. Say so on stderr, which a script reading the
  // paths does not read.
  const tagged = buckets.some((bucket) => rest.some((tag) => Object.hasOwn(bucket.tags, tag) && bucket.tags[tag].length > 0));
  if (!tagged) console.error(`no docs tagged ${rest.join(', ')}${docs.length ? '; printed only the "always" docs' : ', and no "always" docs'}`);
} else if (command === 'tags') {
  const tags = listTags(buckets);
  for (const [tag, count] of tags) console.log(`${tag}\t${count}`);
  if (!tags.length) console.error('no tags in use yet: add tags to the docs in the knowledge indexes');
} else if (command === 'search') {
  const hits = searchKnowledge(buckets, rest, all ? Infinity : 8);
  if (!hits.length) fail('no match');
  for (const doc of hits) console.log(line(doc.path, doc.summary));
} else {
  for (const doc of indexRows(buckets)) console.log(line(doc.path, doc.tags.join(','), doc.summary));
}

function init(project, folder) {
  let result;
  try {
    result = initBucket(project, folder);
  } catch (error) {
    fail(error.message);
  }
  for (const warning of result.warnings) console.error(warning);
  console.log(`wrote ${result.file}: ${result.docs} doc${result.docs === 1 ? '' : 's'} in ${result.dir}, each with a drafted summary and no tags`);
  console.log('next: correct the summaries, add tags and "always" docs, then run aidrian check');
  process.exit(0);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
