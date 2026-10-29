// Command line for knowledge.mjs. Run it through bin/aidrian-knowledge.

import { MANIFEST, findProjectRoot, listTags, loadKnowledge, pluginTags, routeKnowledge } from './knowledge.mjs';

const USAGE = `usage: aidrian-knowledge <command> [--project DIR] [tags...]

  check          validate ${MANIFEST} and every bucket it lists
  route TAG...   print the docs to read for these tags, "always" docs first
  tags           print each tag and how many docs it loads

DIR defaults to the nearest folder at or above the current one that has ${MANIFEST}.`;

const args = process.argv.slice(2);
const command = args.shift();
let project = process.cwd();
const rest = [];
while (args.length) {
  const arg = args.shift();
  if (arg === '--project') {
    project = args.shift();
    if (!project) fail(`${USAGE}\n\n--project needs a folder.`);
  } else if (arg.startsWith('-')) {
    fail(`${USAGE}\n\nunknown option: ${arg}`);
  } else {
    rest.push(arg);
  }
}

if (!['check', 'route', 'tags'].includes(command)) fail(USAGE);
const root = findProjectRoot(project);
if (!root) fail(`no ${MANIFEST} at or above ${project}`);

const { buckets, errors } = loadKnowledge(root);
if (errors.length) fail(errors.join('\n'));

if (command === 'check') {
  const docs = routeKnowledge(buckets, listTags(buckets).map(([tag]) => tag));
  console.log(`ok: ${buckets.length} buckets, ${docs.length} docs`);
} else if (command === 'route') {
  // A tag the plugin asks for may be one the project does not define; it loads nothing. Any other tag is a typo.
  const known = [...new Set([...pluginTags(), ...listTags(buckets).map(([tag]) => tag)])].sort();
  const unknown = rest.filter((tag) => !known.includes(tag));
  if (unknown.length) fail(`unknown tag: ${unknown.join(', ')}\nknown tags: ${known.join(', ')}`);
  for (const doc of routeKnowledge(buckets, rest)) console.log(doc);
} else {
  for (const [tag, count] of listTags(buckets)) console.log(`${tag}\t${count}`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
