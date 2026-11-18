// The `aidrian check` warning that auto-merge can ship a screen change no capture checked, and how it tells a web
// screen file from the rest. docs/config.md#auto-merge describes it.

import path from 'node:path';

import { isEntry, readJson } from './fs.mjs';

// A screen file, by a conservative guess from its path: a .tsx, .jsx, .vue, .svelte, or .html file outside docs,
// examples, vendored code, test folders, and dot folders, and not a test, spec, or story file.
// SHORTCUT: extensions alone; a project whose screens are .ts or templates of another kind is not seen, which only costs
// a warning. A per-project list would replace it if one is needed.
const SCREEN_FILE = /\.(?:tsx|jsx|vue|svelte|html)$/u;
const NOT_SCREEN_NAME = /\.(?:test|spec|stories)\.[^./]+$/u;
const NOT_SCREEN_FOLDERS = new Set(['docs', 'examples', 'node_modules', 'vendor', 'test', 'tests', '__tests__', 'e2e', 'fixtures', '__fixtures__']);
// A React Native app's screens are .tsx and .jsx files too, but `review.visual.platform` takes only "web", so no capture
// reaches them. With `nativeOnly`, those files do not count.
const NATIVE_SCREEN = /\.(?:tsx|jsx)$/u;
export function isScreenFile(file, { nativeOnly = false } = {}) {
  if (!SCREEN_FILE.test(file) || NOT_SCREEN_NAME.test(file)) return false;
  if (nativeOnly && NATIVE_SCREEN.test(file)) return false;
  return !file.split('/').slice(0, -1).some((folder) => folder.startsWith('.') || NOT_SCREEN_FOLDERS.has(folder));
}

// Whether a package.json depends on react-native and not on react-dom, which a React Native app that also renders for the
// web, such as through react-native-web or Expo for the web, depends on. A manifest that is not an object is not native.
export function isNativeOnly(pkg) {
  const deps = Object.assign({}, ...['dependencies', 'devDependencies', 'peerDependencies'].map((key) => (pkg?.[key] && typeof pkg[key] === 'object' ? pkg[key] : {})));
  return Object.hasOwn(deps, 'react-native') && !Object.hasOwn(deps, 'react-dom');
}

// Whether a file's own package is native-only: the nearest package.json above it, from its folder up to the project
// root, decides, so each workspace of a monorepo answers for its own files. When unsure, the file counts: with no
// manifest up to the root, or with one that does not parse, links outside the project, or is a broken link, it is not
// native. A broken link still stops the walk up, so a native root above it cannot answer for its workspace.
// `seen` caches the answer per folder, since a project's screens share few folders.
function nativeOnlyAt(root, folder, seen) {
  if (seen.has(folder)) return seen.get(folder);
  const rel = folder ? `${folder}/package.json` : 'package.json';
  let native;
  if (isEntry(path.join(root, rel))) native = isNativeOnly(readJson(root, rel, []));
  else native = folder ? nativeOnlyAt(root, path.posix.dirname(folder).replace(/^\.$/u, ''), seen) : false;
  seen.set(folder, native);
  return native;
}

// The tracked files that are web screens: each .tsx or .jsx file asks its own package whether it is native-only.
export function webScreenFiles(root, tracked) {
  const seen = new Map();
  return tracked.filter((file) => {
    if (!isScreenFile(file)) return false;
    if (!NATIVE_SCREEN.test(file)) return true;
    return !nativeOnlyAt(root, path.posix.dirname(file).replace(/^\.$/u, ''), seen);
  });
}

// A tracked path as a diagnostic names it: quoted as JSON, as the other commands name a path, so a line break or an
// ESC in a file name cannot start a line of its own or drive the terminal. JSON leaves DEL, the C1 controls, such as the
// one-byte CSI, and the Unicode line separators as they are, so those are escaped too.
const quotedPath = (file) => JSON.stringify(file).replace(/[\u007f-\u009f\u2028\u2029]/gu, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

// The warning that auto-merge can ship a screen change no capture checked: the team allows auto-merge, `review.visual`
// is unset, and git tracks a web screen file. Like the other checks, this reads the working copy. `tracked()` gives the
// tracked paths under the project root, or null when nothing says what is tracked, and runs only when the rest holds.
export function unseenScreenWarnings(project, config, tracked) {
  if (!config.github.autoMerge.allow || config.review.visual) return [];
  const screens = webScreenFiles(project.root, tracked() ?? []);
  if (!screens.length) return [];
  const count = screens.length === 1 ? '1 tracked screen file' : `${screens.length} tracked screen files`;
  return [`github.autoMerge.allow is true and review.visual is unset, so auto-merge can ship screen changes no capture checked (${count}, such as ${quotedPath(screens[0])}): set review.visual.targets to the routes and files of the project's screens`];
}
