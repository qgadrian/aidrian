// Command line for knowledge.mjs. Users run it through bin/aidrian-knowledge; `npm run check` runs it with node directly.

import path from 'node:path';

import { CONFIG, findProjectRoot, loadConfig } from './config.mjs';
import { indexRows, initBucket, listTags, loadKnowledge, pluginTags, routeKnowledge, searchKnowledge } from './knowledge.mjs';

const USAGE = `usage: aidrian-knowledge <command> [--project DIR] [args]

  check            validate ${CONFIG} and every bucket it lists
  route TAG...     print the docs to read for these tags, "always" docs first
  tags             print each tag and how many docs it loads
  search WORD...   print the best 8 docs whose tags, path, or summary hold these words; --all prints every match
  index            print every doc: path, tags, and summary, separated by tabs
  init FOLDER      draft FOLDER/bucket.json for a folder of docs, and ${CONFIG} when there is none

DIR defaults to the nearest folder at or above the current one that has ${CONFIG}.
FOLDER is relative to that folder, or to the current one when there is no ${CONFIG} yet.`;

const args = process.argv.slice(2);
const command = args.shift();
let project = process.cwd();
let all = false;
const rest = [];
while (args.length) {
  const arg = args.shift();
  if (arg === '--project') {
    project = args.shift();
    // An option's value never starts with "-": `--project --bogus` is a missing folder, not a folder named --bogus.
    if (!project || project.startsWith('-')) fail(`${USAGE}\n\n--project needs a folder.`);
  } else if (arg === '--all' && command === 'search') {
    all = true;
  } else if (arg.startsWith('-')) {
    fail(`${USAGE}\n\nunknown option: ${arg}`);
  } else {
    rest.push(arg);
  }
}

if (!['check', 'route', 'tags', 'search', 'index', 'init'].includes(command)) fail(USAGE);
if (['check', 'tags', 'index'].includes(command) && rest.length) fail(`${USAGE}\n\nunexpected argument: ${rest[0]}`);
if (command === 'search' && !rest.length) fail(`${USAGE}\n\nsearch needs at least one word.`);
if (command === 'init' && rest.length !== 1) fail(`${USAGE}\n\ninit needs one folder.`);

if (command === 'init') init(findProjectRoot(project) ?? path.resolve(project), rest[0]);

const root = findProjectRoot(project);
if (!root) fail(`no ${CONFIG} at or above ${project}`);

const { buckets, errors } = loadKnowledge(root);
if (errors.length) fail(errors.join('\n'));

if (command === 'check') {
  console.log(`ok: ${buckets.length} buckets, ${indexRows(buckets).length} docs`);
} else if (command === 'route') {
  // A tag the plugin asks for may be one the project does not define; it loads nothing. Any other tag is a typo.
  const known = [...new Set([...pluginTags(), ...listTags(buckets).map(([tag]) => tag)])].sort();
  const unknown = rest.filter((tag) => !known.includes(tag));
  if (unknown.length) fail(`unknown tag: ${unknown.join(', ')}\nknown tags: ${known.join(', ')}`);
  for (const doc of routeKnowledge(buckets, rest)) console.log(doc);
} else if (command === 'tags') {
  for (const [tag, count] of listTags(buckets)) console.log(`${tag}\t${count}`);
} else if (command === 'search') {
  const hits = searchKnowledge(buckets, rest, all ? Infinity : 8);
  if (!hits.length) fail('no match');
  for (const doc of hits) console.log(`${doc.path}\t${doc.summary}`);
} else {
  for (const doc of indexRows(buckets)) console.log(`${doc.path}\t${doc.tags.join(',')}\t${doc.summary}`);
}

function init(root, folder) {
  let result;
  try {
    result = initBucket(root, folder);
  } catch (error) {
    fail(error.message);
  }
  console.log(`wrote ${result.dir}/bucket.json: ${result.docs} docs, each with a drafted summary and no tags`);
  if (result.createdConfig) console.log(`wrote ${CONFIG}: buckets ["${result.dir}"]`);
  else if (!loadConfig(root).config.buckets.includes(result.dir)) console.log(`add "${result.dir}" to "buckets" in ${CONFIG}`);
  console.log('next: correct the summaries, add tags and "always" docs, then run aidrian-knowledge check');
  process.exit(0);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
