// Whether OpenCode is set up to run this plugin for a project, from OpenCode's config files alone. It reads only the
// variables that locate those files (OPENCODE_CONFIG, OPENCODE_CONFIG_DIR, XDG_CONFIG_HOME, HOME) and no host-detection
// variable, so its answer does not depend on which host's shell runs `aidrian check`; the check also counts that host as
// set up (lib/tracker-check.mjs). OpenCode 2.4.0 reads its global config from OPENCODE_CONFIG_DIR, else from opencode
// under the user's config folder, the file OPENCODE_CONFIG names, and opencode.json or opencode.jsonc, in a folder and
// in its .opencode folder, in the folder a session starts in and every folder above it up to `/` (the embedded source of
// its binary, ConfigDiscovery.discover). The probe reads the project's root and the folders above it up to and including
// the home folder, or up to `/` when the root is not under home, at most ANCESTORS_MAX of them. A
// plugin is an entry of the `plugins` list, a string or `{ package, options }` (opencode.ai/docs/plugins); `plugin`, the
// key's singular form, is read too, since a name read where it does not count only adds a warning.

import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const NAMES = ['opencode.json', 'opencode.jsonc'];
// A config larger than this is no config a person wrote, and is not read.
const MAX_BYTES = 1024 * 1024;
// The most folders the walk up from a project's root reads, the root among them.
const ANCESTORS_MAX = 64;

const absolute = (value) => typeof value === 'string' && path.isAbsolute(value);

// The index just past the string that opens with the quote at `start`, or the text's length when it never closes.
function stringEnd(text, start) {
  for (let at = start + 1; at < text.length; at += 1) {
    if (text[at] === '\\') at += 1;
    else if (text[at] === '"') return at + 1;
  }
  return text.length;
}

// `text` without the parts `drop(text, at)` names outside strings: each returns the index to go on from, or -1 to keep.
function outsideStrings(text, drop) {
  let kept = '';
  for (let at = 0; at < text.length;) {
    if (text[at] === '"') {
      const end = stringEnd(text, at);
      kept += text.slice(at, end);
      at = end;
      continue;
    }
    const next = drop(text, at);
    if (next < 0) kept += text[at];
    at = next < 0 ? at + 1 : next;
  }
  return kept;
}

// A line or block comment's end, or -1 when no comment opens at `at`. An unclosed block comment runs to the end.
const comment = (text, at) => {
  if (text.startsWith('//', at)) return text.includes('\n', at) ? text.indexOf('\n', at) : text.length;
  if (text.startsWith('/*', at)) return text.includes('*/', at + 2) ? text.indexOf('*/', at + 2) + 2 : text.length;
  return -1;
};

// A comma whose next mark is a closing bracket: JSONC's trailing comma, dropped.
const CLOSES = /\s*[}\]]/uy;
const trailingComma = (text, at) => {
  if (text[at] !== ',') return -1;
  CLOSES.lastIndex = at + 1;
  return CLOSES.test(text) ? at + 1 : -1;
};

// The value of a JSONC text, or undefined when it does not parse.
export function jsoncValue(text) {
  try {
    return JSON.parse(outsideStrings(outsideStrings(text, comment), trailingComma));
  } catch {
    return undefined;
  }
}

// Whether a plugin specifier names this plugin: the package name aidrian, at a version or not, or a Git specifier or
// path whose last part is plugins/aidrian, the folder the package is.
export function namesThisPlugin(spec) {
  if (typeof spec !== 'string') return false;
  const plain = spec.trim().replaceAll('\\', '/').replace(/\/+$/u, '');
  return plain === 'aidrian' || plain.startsWith('aidrian@') || /(?:^|[/:])plugins\/aidrian$/u.test(plain);
}

// The text of the config file `file`, read through the one descriptor whose kind and size were checked, so a file swapped
// after the check is never what is read; null for a file that is missing, no regular file, or over MAX_BYTES. A named
// pipe opens without waiting (O_NONBLOCK) and is refused. A link is followed: a person's config may live in a dotfiles folder.
function configText(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    const buffer = Buffer.alloc(stat.size);
    return buffer.subarray(0, readSync(fd, buffer, 0, stat.size, 0)).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Whether the config file `file` lists this plugin. A file that is missing, no regular file, too large, or not JSONC counts as none.
function listsThisPlugin(file) {
  const text = configText(file);
  if (text === null) return false;
  try {
    const config = jsoncValue(text);
    if (typeof config !== 'object' || config === null) return false;
    const entries = [config.plugins, config.plugin].flatMap((list) => (Array.isArray(list) ? list : []));
    return entries.some((entry) => namesThisPlugin(typeof entry === 'string' ? entry : entry?.package));
  } catch {
    return false;
  }
}

const homeOf = (env) => (absolute(env.HOME) ? env.HOME : homedir());

// The folder OpenCode reads its global config from.
function globalFolder(env) {
  if (absolute(env.OPENCODE_CONFIG_DIR)) return env.OPENCODE_CONFIG_DIR;
  return path.join(absolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(homeOf(env), '.config'), 'opencode');
}

// `root` and each folder above it, up to and including `home` when `root` lies under it, else up to `/`.
function ancestors(root, home) {
  const top = path.resolve(home);
  const under = path.relative(top, root);
  const stop = under === '' || (!under.startsWith('..') && !path.isAbsolute(under)) ? top : path.parse(root).root;
  const folders = [];
  for (let folder = path.resolve(root); folders.length < ANCESTORS_MAX; folder = path.dirname(folder)) {
    folders.push(folder);
    if (folder === stop || path.dirname(folder) === folder) break;
  }
  return folders;
}

// Whether OpenCode's global config, the file OPENCODE_CONFIG names, or the config of the project at `root`, or of a
// folder above it, when `root` is given, lists this plugin. Never throws.
export function setUp({ env = process.env, root } = {}) {
  try {
    const vars = env ?? {};
    const folders = absolute(root) ? ancestors(root, homeOf(vars)).flatMap((folder) => [folder, path.join(folder, '.opencode')]) : [];
    const files = [
      ...(absolute(vars.OPENCODE_CONFIG) ? [vars.OPENCODE_CONFIG] : []),
      ...[globalFolder(vars), ...folders].flatMap((folder) => NAMES.map((name) => path.join(folder, name))),
    ];
    return files.some(listsThisPlugin);
  } catch {
    return false;
  }
}
