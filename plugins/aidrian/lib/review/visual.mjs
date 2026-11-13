// The visual capture: the screens a change to the UI touches, captured at each configured width, locale, and variant
// before the visual reviewers (designer, ux-specialist) run, so they review pictures and measured facts, not only
// code. docs/review.md#visual-review describes the config. The core is platform-neutral: it picks the routes, builds
// the matrix, signs in through the project's hook, runs a platform adapter (lib/review/visual-web.mjs for the web),
// and keeps a manifest per head that reviewers, flow evidence (`capture:<key>`), and the upload all read.
//
// Only `aidrian pr review` uploads, and only files this capture wrote and listed in its manifest, checked by hash and
// by their PNG signature: an agent that drops a file into the captures folder cannot get it published.
//
// Images taken outside the tool, such as an end-to-end run's screenshots, are ingested (`aidrian pr ingest`,
// ingestCaptures) into the manifest's own `ingested` list, apart from `entries`: a flow verdict may cite one as
// `capture:<key>`, but it is never counted as a capture, never uploaded, and every surface marks it as ingested.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isFile, isObject, isWithin, resolvedPath } from '../fs.mjs';
import { forgeFor } from '../forges/index.mjs';
import { recordsFolder, stateDir } from '../project.mjs';
import { pathPattern } from './plan.mjs';
import { clip, INGEST_NOTE, REVIEWED_WITHOUT } from './state.mjs';
import { VISUAL_PER_RUN } from './config.mjs';

export const VISUAL_MARKER = '<!-- aidrian-visual-captures -->';
const ADAPTERS = Object.freeze({ web: fileURLToPath(new URL('./visual-web.mjs', import.meta.url)) });
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// The images an ingest takes, by their first bytes; `type` is the copy's extension.
const IMAGE_TYPES = Object.freeze([
  { type: 'png', is: (bytes) => bytes.subarray(0, PNG.length).equals(PNG) },
  { type: 'jpg', is: (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  { type: 'gif', is: (bytes) => ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('latin1')) },
  { type: 'webp', is: (bytes) => bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP' },
]);
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
// The most characters of an ingest's --source the manifest keeps, and of a source or a name in the summary's note.
const MAX_ORIGIN = 300;
const NOTE_PART = 80;
const URL_RE = /^https?:\/\/[^\s/]+(?:\/\S*)?$/u;
const CAPTURE_MS = 15 * 60_000;
// The most uploaded hashes the review record keeps; the oldest go first.
const MAX_UPLOADED = 600;

const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '') || 'root';
// A route's part of a capture key: readable, plus a short hash of the exact route, so `/a/b`, `/a-b`, and `/A/b` never
// share a file.
const routeId = (route) => `${slug(route)}-${createHash('sha256').update(route).digest('hex').slice(0, 6)}`;

// The (variant, locale) pairs one target captures, as `variant\0locale` strings: its own subsets, else every variant
// and locale. `"locales": []` is the default locale, the empty string here.
function targetPairs(visual, target) {
  const variants = target.variants ?? (visual.variants.length ? visual.variants.map((variant) => variant.id) : ['default']);
  const locales = target.locales ? (target.locales.length ? target.locales : ['']) : visual.locales.length ? visual.locales : [''];
  return variants.flatMap((variant) => locales.map((locale) => `${variant}\0${locale}`));
}

// The routes a change touches, as [{ route, base, pairs? }]: every route of a target whose files match a changed file,
// deleted files included, since removing a component changes the screen too. `base` is the target's named base, or null
// for the variant's own. `pairs` ([[variant, locale|null]]) is present when the touched targets narrow the route: a
// route two targets list gets the union of the captures each asks for, never a combination neither asked for.
export function visualRoutes(visual, changes) {
  if (!visual) return [];
  const routes = new Map();
  const full = targetPairs(visual, {});
  for (const target of visual.targets) {
    const patterns = target.files.map(pathPattern);
    if (!changes.some((change) => patterns.some((pattern) => pattern.test(change.file)))) continue;
    for (const route of target.routes) {
      const key = `${target.base ?? ''}\0${route}`;
      const known = routes.get(key) ?? { route, base: target.base ?? null, pairs: new Set() };
      for (const pair of targetPairs(visual, target)) known.pairs.add(pair);
      routes.set(key, known);
    }
  }
  return [...routes.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, { route, base, pairs }]) => {
    const everything = pairs.size === full.length && full.every((pair) => pairs.has(pair));
    return { route, base, ...(everything ? {} : { pairs: [...pairs].map((pair) => pair.split('\0')).map(([variant, locale]) => [variant, locale || null]) }) };
  });
}

// One entry per route, width, locale, and variant, or per the route's `pairs` and width. A route may hold `{locale}`,
// filled per locale. Throws past VISUAL_PER_RUN images, naming the routes, so the review stops loudly rather than
// capture part of the matrix.
export function visualMatrix(visual, routes) {
  const locales = visual.locales.length ? visual.locales : [null];
  const variants = visual.variants.length ? visual.variants.map((variant) => variant.id) : ['default'];
  const order = [null, ...visual.locales];
  const entries = [];
  for (const { route, base, pairs } of routes) {
    const id = base ? routeId(`${base}:${route}`) : routeId(route);
    const wanted = pairs
      ? variants.flatMap((variant) => order.filter((locale) => pairs.some(([v, l]) => v === variant && l === locale)).map((locale) => [variant, locale]))
      : variants.flatMap((variant) => locales.map((locale) => [variant, locale]));
    for (const [variant, locale] of wanted) {
      for (const width of visual.viewports) {
        entries.push({ key: [id, width, locale ?? 'default', variant].join('--'), route, ...(base ? { base } : {}), width, locale, variant });
      }
    }
  }
  if (new Set(entries.map((entry) => entry.key)).size !== entries.length) throw new Error('review.visual: two captures share a key; list each locale and route once');
  if (entries.length > VISUAL_PER_RUN) {
    throw new Error(`the visual capture would take ${entries.length} images, past ${VISUAL_PER_RUN}: narrow review.visual.targets for these routes, or split the pull request: ${routes.map(({ route, base }) => (base ? `${base}:${route}` : route)).join(', ')}`);
  }
  return entries;
}

// The variants the capture signs in: those with an account that some entry uses. A variant every touched target
// leaves out is never signed in, so its missing credentials cannot stop a capture that does not need it.
export const signedVariants = (visual, entries) => visual.variants.filter((variant) => variant.account && entries.some((entry) => entry.variant === variant.id));

export const captureDir = (project, pr, head) => path.join(recordsFolder(stateDir(project)), `pr-${pr}`, 'captures', head);

// The manifest a capture wrote for `head`, or null.
export function readManifest(project, pr, head) {
  try {
    const manifest = JSON.parse(readFileSync(path.join(captureDir(project, pr, head), 'manifest.json'), 'utf8'));
    return isObject(manifest) && manifest.head === head && Array.isArray(manifest.entries) ? manifest : null;
  } catch {
    return null;
  }
}

// The images ingested for this head, never null.
const ingestedOf = (manifest) => (Array.isArray(manifest?.ingested) ? manifest.ingested.filter((entry) => isObject(entry) && typeof entry.key === 'string' && entry.sha256 && isObject(entry.source)) : []);

// The keys a flow verdict may cite as `capture:<key>`: the entries of this head's manifest that captured an image, and
// the images ingested for it.
export const captureKeys = (manifest) => new Set([...(manifest?.entries ?? []).filter((entry) => entry.sha256), ...ingestedOf(manifest)].map((entry) => entry.key));

// The tool's own reason in a manifest's `reason`, without the ingest note withIngested added.
function toolReason(reason) {
  if (typeof reason !== 'string') return null;
  const at = reason.startsWith(INGEST_NOTE) ? 0 : reason.indexOf(`; ${INGEST_NOTE}`);
  return at === -1 ? reason : reason.slice(0, at) || null;
}

// `text` on one line as a Markdown code span, whatever backticks it holds (a fence longer than its longest run), so a
// mention, link, or markup in it renders as text.
function codeSpan(text) {
  const plain = String(text ?? '').replace(/\s+/gu, ' ').trim();
  const fence = '`'.repeat(Math.max(0, ...[...plain.matchAll(/`+/gu)].map((run) => run[0].length)) + 1);
  const pad = plain.startsWith('`') || plain.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${plain}${pad}${fence}`;
}

// Who ingested an image, as posted: the git user's name, and in an AI session the agent, or that the host named none.
// The Human's own shell, where no host is detected, gives the name alone.
const ingestedBy = (source, cut = (text) => text) => `${codeSpan(cut(source.by))}${source.session === 'ai' ? (source.agent ? ` via ${codeSpan(cut(source.agent))}` : ' in an AI session, agent unknown') : ''}`;

// `text` cut to NOTE_PART characters, marked when cut; a code span is built around the result, never cut inside one.
const shortened = (text) => {
  const plain = String(text ?? '').replace(/\s+/gu, ' ').trim();
  return plain.length > NOTE_PART ? `${plain.slice(0, NOTE_PART - 1)}…` : plain;
};

// The reason with the ingest note, built to fit the review summary's clip whole, so the clip never cuts a code span and
// leaves its rest to render as Markdown: whole entries only, each source and name shortened, and the rest counted.
function ingestReason(own, ingested) {
  const lead = `${own ? `${own}; ` : ''}${INGEST_NOTE}`;
  const parts = ingested.map((entry) => `${entry.key} from ${codeSpan(shortened(entry.source.origin))} by ${ingestedBy(entry.source, shortened)}`);
  const fits = (text) => clip(text) === text.replace(/\s+/gu, ' ');
  for (let shown = parts.length; shown >= 1; shown -= 1) {
    const rest = parts.length - shown;
    const text = `${lead}${parts.slice(0, shown).join('; ')}${rest ? ` and ${rest} more, listed in the captures comment` : ''}`;
    if (fits(text)) return text;
  }
  return `${lead}${parts.length} image(s), listed in the captures comment`;
}

// `manifest` with the head's ingested images, and, unless the tool captured every image, a reason that names each
// one with its source, which the review summary prints: an ingest is never shown as a measured capture.
function withIngested(manifest, ingested) {
  if (!ingested.length) return manifest;
  const { reason, ...rest } = manifest;
  if (manifest.status === 'captured') return { ...rest, ingested };
  return { ...rest, reason: ingestReason(toolReason(reason), ingested), ingested };
}

// `aidrian pr ingest`: copies each image in `files` into the head's capture folder and records it in the manifest's
// `ingested` list, with its key, hash, type, and `source` { origin, path, by, agent, session, at }, where `session` is
// `ai` when the command ran in an AI session (the host layer detected one, or names the agent) and `shell` otherwise.
// The source is what the caller says: an audit entry, not proof. Every file is checked before
// anything is written, so `dryRun` (`--check`) runs every refusal and writes nothing. A file must be an image (PNG,
// JPEG, GIF, or WebP, by its bytes) inside the working tree or the state folder, with symlinks resolved. The key is
// `ingest-<name>-<hash>`: the same bytes under the same name replace their entry, and two files that share a name never
// share a key. A manifest with no tool capture gets the status `ingested`. Returns { manifest, ingested }.
export function ingestCaptures({ project, pr, head, files, source, by, agent = null, session = null, dryRun = false }) {
  const origin = String(source ?? '').replace(/\s+/gu, ' ').trim().slice(0, MAX_ORIGIN);
  if (!origin) throw new Error('--source needs text: say where the image came from, such as the tool or run that took it');
  // The source reaches the review summary, whose record is an HTML comment: no source may open or close one.
  if (/[<>]/u.test(origin)) throw new Error('--source cannot hold < or >: name the tool or run in plain words');
  // The same rule for the names, which come from git and the host rather than the caller's words.
  const name = (text) => String(text ?? '').replace(/[<>]/gu, '').replace(/\s+/gu, ' ').trim();
  const who = { by: name(by) || 'unknown', agent: name(agent) || null };
  const kind = who.agent || session === 'ai' ? 'ai' : 'shell';
  if (typeof head !== 'string' || !FULL_SHA.test(head)) throw new Error('head must be the full commit SHA');
  if (!Array.isArray(files) || !files.length) throw new Error('at least one image file is required');
  const roots = [resolvedPath(project.root), resolvedPath(stateDir(project))].filter(Boolean);
  const dir = captureDir(project, pr, head);
  const at = new Date().toISOString();
  const found = new Map();
  for (const file of files) {
    if (!isFile(file)) throw new Error(`${file} is not a file`);
    const real = resolvedPath(file);
    if (!real || !roots.some((root) => isWithin(root, real))) throw new Error(`${file} is outside the working tree and the state folder`);
    const bytes = readFileSync(real);
    const image = IMAGE_TYPES.find((each) => each.is(bytes));
    if (!image) throw new Error(`${file} is not an image: PNG, JPEG, GIF, or WebP`);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const key = `ingest-${slug(path.basename(file, path.extname(file)))}-${sha256.slice(0, 6)}`;
    found.set(key, { bytes, entry: { key, file: path.join(dir, `${key}.${image.type}`), sha256, type: image.type, source: { origin, path: real, ...who, session: kind, at } } });
  }
  const ingested = [...found.values()].map(({ entry }) => entry);
  const known = readManifest(project, pr, head);
  const merged = [...ingestedOf(known).filter((entry) => !found.has(entry.key)), ...ingested];
  const manifest = withIngested(known ?? { version: 1, head, at, status: 'ingested', entries: [] }, merged);
  if (dryRun) return { manifest, ingested };
  mkdirSync(dir, { recursive: true });
  // The copy holds the bytes that were hashed, whatever the source file holds by now.
  for (const { bytes, entry } of found.values()) writeFileSync(entry.file, bytes);
  writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, ingested };
}

const fail = (status, reason) => ({ status, reason });

// The `baseUrl` and `bases` a login printed, checked: { url?, bases? }, or { error }.
function overrides(printed, what) {
  try {
    const out = {};
    if (printed.baseUrl !== undefined) out.url = urlFrom(printed.baseUrl, what);
    // Named bases, for a target whose screens live on another host or path of this variant (a per-variant
    // subdomain, the app root): { "bases": { "guest": "http://shop.localhost:3000" } }.
    if (printed.bases !== undefined) {
      if (!isObject(printed.bases)) return { error: `${what}: "bases" must map names to URLs` };
      out.bases = Object.fromEntries(Object.entries(printed.bases).map(([name, value]) => [name, urlFrom(value, `${what}, base ${name}`)]));
    }
    return out;
  } catch (error) {
    return { error: error.message };
  }
}

// The base URL a hook printed: its first line, which must be an http(s) URL.
function urlFrom(text, what) {
  const line = String(text ?? '').trim().split('\n')[0]?.trim() ?? '';
  if (!URL_RE.test(line)) throw new Error(`${what} printed no http(s) URL`);
  return line.replace(/\/+$/u, '');
}

// Captures this head's matrix and writes its manifest; a captured manifest already there for the head is returned as
// is, so the capture runs once per head. Every write keeps the images ingested for the head (withIngested), and an
// ingest-only manifest is captured over, never taken for a capture. `withBase(use)` runs `use(hook)` in a checkout of the base, where `hook(command,
// input)` runs a review.visual command line from the base branch with `input` on stdin and returns its stdout:
// a pull request cannot change the login or preview code it is captured with. `baseUrl` is this machine's setting.
export async function captureVisual({ project, pr, head, visual, entries, baseUrl, env, withBase, spawn = spawnSync }) {
  // A capture that worked is reused; one that did not (no base URL, a server that was down) runs again next time.
  const known = readManifest(project, pr, head);
  if (known?.status === 'captured') return known;
  const dir = captureDir(project, pr, head);
  mkdirSync(dir, { recursive: true });
  const carried = ingestedOf(known);
  const write = (fresh) => {
    const manifest = withIngested(fresh, carried);
    writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  };
  const base = { version: 1, head, platform: visual.platform, at: new Date().toISOString() };
  const authFiles = [];
  try {
    const prepared = await withBase(async (hook) => {
      let url = baseUrl;
      if (!url && visual.preview) url = urlFrom(await hook(visual.preview, { pr, head }), 'review.visual.preview');
      if (!url) return fail('unavailable', 'no base URL: set review.visual.baseUrl in the local settings file, or review.visual.preview');
      // One profile per variant ({ url, bases, auth }), and per variant and locale where the login printed one.
      const profiles = {};
      const storageStates = {};
      // Storage states are numbered, never named after a variant or locale, so no two profiles share a file.
      const keep = (storageState) => {
        const id = `auth-${authFiles.length + 1}`;
        const file = path.join(dir, `.${id}.json`);
        writeFileSync(file, JSON.stringify(storageState), { mode: 0o600 });
        chmodSync(file, 0o600);
        authFiles.push(file);
        storageStates[id] = file;
        return id;
      };
      for (const variant of signedVariants(visual, entries)) {
        const what = `review.visual.login for ${variant.id}`;
        let signedIn;
        try {
          signedIn = JSON.parse(await hook(visual.login, { account: variant.account, variant: variant.id, baseUrl: url, locales: visual.locales }));
        } catch (error) {
          return fail('failed', `${what}: ${error.message.split('\n')[0]}`);
        }
        if (!isObject(signedIn?.storageState)) return fail('failed', `${what} printed no { "storageState": {...} }`);
        const own = overrides(signedIn, what);
        if (own.error) return fail('failed', own.error);
        const profile = { url: own.url ?? url, bases: own.bases ?? {}, auth: keep(signedIn.storageState), locales: {} };
        // A signed-in profile per locale, for screens whose language comes from a stored preference and not the
        // browser: { "locales": { "de": { "storageState": {...}, "baseUrl"?, "bases"? } } }. Each field it gives
        // replaces the variant's for that locale's captures.
        if (signedIn.locales !== undefined) {
          if (!isObject(signedIn.locales)) return fail('failed', `${what}: "locales" must map locale tags to { "storageState"?, "baseUrl"?, "bases"? }`);
          for (const [locale, value] of Object.entries(signedIn.locales)) {
            const at = `${what}, locale ${locale}`;
            if (!visual.locales.includes(locale)) return fail('failed', `${at}: not in review.visual.locales`);
            if (!isObject(value) || (value.storageState !== undefined && !isObject(value.storageState))) return fail('failed', `${at}: must be { "storageState"?, "baseUrl"?, "bases"? }`);
            const mine = overrides(value, at);
            if (mine.error) return fail('failed', mine.error);
            profile.locales[locale] = {
              url: mine.url ?? profile.url,
              bases: mine.bases ?? profile.bases,
              auth: value.storageState ? keep(value.storageState) : profile.auth,
            };
          }
        }
        profiles[variant.id] = profile;
      }
      return { profiles, fallback: url, storageStates };
    });
    if (prepared.status) return write({ ...base, ...prepared, entries: [] });
    const profileOf = (entry) => {
      const profile = prepared.profiles[entry.variant];
      return profile ? profile.locales[entry.locale] ?? profile : { url: prepared.fallback, bases: {}, auth: null };
    };
    const prefix = (entry) => (entry.base ? profileOf(entry).bases[entry.base] : profileOf(entry).url);
    // An entry whose named base this variant's login did not print is reported, never captured on another host.
    const missingBase = new Map(entries.filter((entry) => !prefix(entry)).map((entry) => [entry.key, `review.visual.login printed no base "${entry.base}" for ${entry.variant}`]));
    const jobs = entries.filter((entry) => !missingBase.has(entry.key)).map((entry) => ({
      key: entry.key,
      url: `${prefix(entry)}${entry.locale ? entry.route.replaceAll('{locale}', entry.locale) : entry.route.replaceAll('/{locale}', '').replaceAll('{locale}', '')}`,
      width: entry.width,
      locale: entry.locale,
      variant: entry.variant,
      ...(profileOf(entry).auth ? { auth: profileOf(entry).auth } : {}),
    }));
    const run = spawn(process.execPath, [ADAPTERS[visual.platform]], {
      cwd: project.root, env, input: JSON.stringify({ outDir: dir, entries: jobs, storageStates: prepared.storageStates }), encoding: 'utf8', timeout: CAPTURE_MS, maxBuffer: 64 * 1024 * 1024,
    });
    const reason = String(run.stderr ?? '').trim().split('\n').at(-1) ?? '';
    if (run.status === 3) return write({ ...base, status: 'unavailable', reason, entries: [] });
    if (run.status !== 0) return write({ ...base, status: 'failed', reason: reason || (run.signal ? `killed by ${run.signal}` : `exit ${run.status}`), entries: [] });
    const results = new Map((JSON.parse(run.stdout).results ?? []).map((result) => [result.key, result]));
    const captured = entries.map((entry) => {
      if (missingBase.has(entry.key)) return { ...entry, error: missingBase.get(entry.key) };
      const result = results.get(entry.key);
      const file = path.join(dir, `${entry.key}.png`);
      if (!result || result.error || !existsSync(file)) return { ...entry, error: result?.error ?? 'no image' };
      const bytes = readFileSync(file);
      if (!bytes.subarray(0, PNG.length).equals(PNG)) return { ...entry, error: 'not a PNG' };
      return { ...entry, file, sha256: createHash('sha256').update(bytes).digest('hex'), facts: result.facts ?? {} };
    });
    // Captured only when every image is: a matrix with a failed entry (a server that was down) runs again next time,
    // and its good images still reach the reviewers and the upload.
    const good = captured.filter((entry) => entry.sha256).length;
    const status = good === captured.length ? 'captured' : good ? 'partial' : 'failed';
    return write({ ...base, status, ...(status === 'captured' ? {} : { reason: `${captured.length - good} of ${captured.length} captures failed: ${captured.find((entry) => entry.error)?.error}` }), baseUrl: prepared.fallback, entries: captured });
  } catch (error) {
    return write({ ...base, status: 'failed', reason: error.message.split('\n')[0], entries: [] });
  } finally {
    for (const file of authFiles) rmSync(file, { force: true });
  }
}

// What the capture attaches: review.visual.attach, else by the repository's visibility read now: `auto` on a private
// or internal repository, `local` on a public one, where an upload is public for good.
export const attachMode = (visual, visibility) => visual.attach ?? (['PRIVATE', 'INTERNAL'].includes(String(visibility).toUpperCase()) ? 'auto' : 'local');

// Uploads the manifest's images that are not on record yet through the gh-image extension, and returns
// { uploaded: { sha256: url }, error }. Only entries whose file is in this head's capture folder, whose bytes still hash
// to the manifest's sha256, and that start with the PNG signature go up. A missing gh-image is an error to show, never
// a blocked review.
// `image(repo, files)` runs `gh image` through the forge facade's uploadImages and returns its spawn result.
export function ghImage(repo, files, forge = forgeFor(undefined)) {
  try {
    return { status: 0, stdout: forge.uploadImages(repo, files) };
  } catch (error) {
    return { status: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? error.message ?? '') };
  }
}

export function uploadCaptures({ project, pr, manifest, uploaded = {}, repo, image = ghImage }) {
  const dir = captureDir(project, pr, manifest.head);
  const fresh = [];
  for (const entry of manifest.entries) {
    if (!entry.sha256 || uploaded[entry.sha256] || fresh.some((each) => each.sha256 === entry.sha256)) continue;
    if (path.dirname(path.resolve(entry.file)) !== path.resolve(dir)) continue;
    let bytes;
    try {
      bytes = readFileSync(entry.file);
    } catch {
      continue;
    }
    if (!bytes.subarray(0, PNG.length).equals(PNG) || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) continue;
    fresh.push(entry);
  }
  if (!fresh.length) return { uploaded: {}, error: null };
  const run = image(repo, fresh.map((entry) => entry.file));
  if (run.error || run.status !== 0) {
    const why = run.error?.message ?? String(run.stderr ?? '').trim().split('\n').at(-1) ?? `exit ${run.status}`;
    return { uploaded: {}, error: `gh image did not upload the captures (${why}); install it with \`gh extension install drogers0/gh-image\`. They stay local.` };
  }
  const links = [...String(run.stdout).matchAll(/!\[([^\]]*)\]\((https:\/\/[^)\s]+)\)/gu)].map((m) => ({ alt: m[1], url: m[2] }));
  const out = {};
  for (const entry of fresh) {
    const link = links.find((each) => each.alt === entry.key || each.alt === `${entry.key}.png`);
    if (link) out[entry.sha256] = link.url;
  }
  return { uploaded: out, error: Object.keys(out).length < fresh.length ? `gh image returned ${Object.keys(out).length} of ${fresh.length} links` : null };
}

// The record's uploaded hashes with `more` added, the oldest dropped past MAX_UPLOADED.
export const keepUploaded = (uploaded, more) => Object.fromEntries(Object.entries({ ...uploaded, ...more }).slice(-MAX_UPLOADED));

// The captures comment: one per pull request, edited in place for each head. Ingested images get their own table,
// with their source and no image: they are never uploaded, and their local path stays out of a posted comment.
// `reviewed` (state.mjs visualReviewed): a visual pass has its result on this head, so a failure's reason, which may
// ask to wait for a deploy and run the review again, gives way to the line that the passes reviewed it without it.
export function capturesBody(manifest, uploaded, { mode, visibility, error, reviewed = false }) {
  const lines = [VISUAL_MARKER, `### Visual capture: \`${manifest.head.slice(0, 7)}\``, ''];
  const ingested = ingestedOf(manifest);
  // The Attach line gives the tool's own status and only the count of ingests; their table names each source.
  const own = manifest.status === 'captured'
    ? `${manifest.entries.filter((entry) => entry.sha256).length} of ${manifest.entries.length} captured.`
    : manifest.status === 'ingested' ? '' : reviewed ? `${manifest.status}; ${REVIEWED_WITHOUT}.` : ingested.length ? `${manifest.status}${toolReason(manifest.reason) ? `: ${toolReason(manifest.reason)}` : ''}.` : `${manifest.status}: ${manifest.reason}`;
  lines.push(`Attach: **${mode}**${visibility ? `, ${String(visibility).toLowerCase()} repository` : ''}. ${[own, ingested.length ? `${ingested.length} ingested, not captured.` : ''].filter(Boolean).join(' ')}`);
  if (error) lines.push('', `> ${error}`);
  const byRoute = new Map();
  for (const entry of manifest.entries) byRoute.set(entry.route, [...(byRoute.get(entry.route) ?? []), entry]);
  for (const [route, list] of byRoute) {
    lines.push('', `#### \`${route}\``, '', '| Capture | Image | Facts |', '| --- | --- | --- |');
    for (const entry of list) {
      const url = entry.sha256 ? uploaded[entry.sha256] : null;
      const facts = entry.error ? `error: ${entry.error}` : factsLine(entry.facts);
      lines.push(`| \`${entry.width}px ${entry.locale ?? ''} ${entry.variant}\` | ${url ? `![${entry.key}](${url})` : mode === 'auto' ? 'not uploaded' : 'kept local'} | ${facts.replaceAll('|', '\\|')} |`);
    }
  }
  if (ingested.length) {
    lines.push('', '#### Ingested, not captured', '', '| Capture | Source | By |', '| --- | --- | --- |');
    // Origin, name, and agent as code spans: no mention, link, or markup of theirs renders in a posted comment.
    const cell = (text) => text.replaceAll('|', '\\|');
    for (const { key, source } of ingested) lines.push(`| \`${key}\` | ${cell(codeSpan(source.origin))} | ${cell(ingestedBy(source))} |`);
  }
  return lines.join('\n');
}

// The facts in a few words, for the comment.
export function factsLine(facts = {}) {
  const parts = [];
  if (facts.status && facts.status >= 400) parts.push(`HTTP ${facts.status}`);
  if (facts.overflowX) parts.push(`horizontal overflow ${facts.overflowX.scrollWidth}>${facts.overflowX.clientWidth}`);
  if (facts.clippedText?.length) parts.push(`${facts.clippedText.length + (facts.clippedTextMore ?? 0)} clipped text`);
  if (facts.smallTargets?.length) parts.push(`${facts.smallTargets.length + (facts.smallTargetsMore ?? 0)} small targets`);
  return parts.join('; ') || 'none';
}

// What a visual reviewer's pass reads: the captures with their facts and upload links, the ingested images with their
// source, and the checklist.
export function visualInput(manifest, uploaded, checklist) {
  return {
    status: manifest.status,
    ...(manifest.reason ? { reason: manifest.reason } : {}),
    ...(checklist ? { checklist } : {}),
    cite: 'cite a capture in a flow verdict as capture:<key>; an entry with ingested: true was taken outside the tool and carries no measured facts',
    captures: [
      ...manifest.entries.map(({ key, route, width, locale, variant, file, facts, error, sha256 }) => ({
        key, route, width, locale, variant, ...(file ? { file } : {}), ...(sha256 && uploaded[sha256] ? { url: uploaded[sha256] } : {}), ...(facts ? { facts } : {}), ...(error ? { error } : {}),
      })),
      ...ingestedOf(manifest).map(({ key, file, source }) => ({ key, file, ingested: true, source: { origin: source.origin, path: source.path, by: source.by, agent: source.agent ?? null, session: source.session === 'ai' ? 'ai' : 'shell', at: source.at } })),
    ],
  };
}
