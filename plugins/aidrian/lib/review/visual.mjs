// The visual capture: the screens a change to the UI touches, captured at each configured width, locale, and variant
// before the visual reviewers (designer, ux-specialist) run, so they review pictures and measured facts, not only
// code. docs/review.md#visual-review describes the config. The core is platform-neutral: it picks the routes, builds
// the matrix, signs in through the project's hook, runs a platform adapter (lib/review/visual-web.mjs for the web),
// and keeps a manifest per head that reviewers, flow evidence (`capture:<key>`), and the upload all read.
//
// Only `aidrian pr review` uploads, and only files this capture wrote and listed in its manifest, checked by hash and
// by their PNG signature: an agent that drops a file into the captures folder cannot get it published.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isObject } from '../fs.mjs';
import { runGh } from '../gh.mjs';
import { stateDir } from '../project.mjs';
import { pathPattern } from './plan.mjs';
import { VISUAL_PER_RUN } from './config.mjs';

export const VISUAL_MARKER = '<!-- aidrian-visual-captures -->';
const ADAPTERS = Object.freeze({ web: fileURLToPath(new URL('./visual-web.mjs', import.meta.url)) });
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const URL_RE = /^https?:\/\/[^\s/]+(?:\/\S*)?$/u;
const CAPTURE_MS = 15 * 60_000;
// The most uploaded hashes the review record keeps; the oldest go first.
const MAX_UPLOADED = 600;

const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '') || 'root';
// A route's part of a capture key: readable, plus a short hash of the exact route, so `/a/b`, `/a-b`, and `/A/b` never
// share a file.
const routeId = (route) => `${slug(route)}-${createHash('sha256').update(route).digest('hex').slice(0, 6)}`;

// The routes a change touches: every route of a target whose files match a changed file, deleted files included,
// since removing a component changes the screen too.
export function visualRoutes(visual, changes) {
  if (!visual) return [];
  const routes = new Set();
  for (const target of visual.targets) {
    const patterns = target.files.map(pathPattern);
    if (changes.some((change) => patterns.some((pattern) => pattern.test(change.file)))) for (const route of target.routes) routes.add(route);
  }
  return [...routes].sort();
}

// One entry per route, width, locale, and variant. A route may hold `{locale}`, filled per locale. Throws past
// VISUAL_PER_RUN images, naming the routes, so the review stops loudly rather than capture part of the matrix.
export function visualMatrix(visual, routes) {
  const locales = visual.locales.length ? visual.locales : [null];
  const variants = visual.variants.length ? visual.variants : [{ id: 'default' }];
  const entries = [];
  for (const route of routes) {
    for (const variant of variants) {
      for (const locale of locales) {
        for (const width of visual.viewports) {
          entries.push({ key: [routeId(route), width, locale ?? 'default', variant.id].join('--'), route, width, locale, variant: variant.id });
        }
      }
    }
  }
  if (new Set(entries.map((entry) => entry.key)).size !== entries.length) throw new Error('review.visual: two captures share a key; list each locale and route once');
  if (entries.length > VISUAL_PER_RUN) {
    throw new Error(`the visual capture would take ${entries.length} images, past ${VISUAL_PER_RUN}: narrow review.visual.targets for these routes, or split the pull request: ${routes.join(', ')}`);
  }
  return entries;
}

export const captureDir = (project, pr, head) => path.join(stateDir(project), 'reviews', `pr-${pr}`, 'captures', head);

// The manifest a capture wrote for `head`, or null.
export function readManifest(project, pr, head) {
  try {
    const manifest = JSON.parse(readFileSync(path.join(captureDir(project, pr, head), 'manifest.json'), 'utf8'));
    return isObject(manifest) && manifest.head === head && Array.isArray(manifest.entries) ? manifest : null;
  } catch {
    return null;
  }
}

// The keys a flow verdict may cite as `capture:<key>`: the entries of this head's manifest that captured an image.
export const captureKeys = (manifest) => new Set((manifest?.entries ?? []).filter((entry) => entry.sha256).map((entry) => entry.key));

const fail = (status, reason) => ({ status, reason });

// The base URL a hook printed: its first line, which must be an http(s) URL.
function urlFrom(text, what) {
  const line = String(text ?? '').trim().split('\n')[0]?.trim() ?? '';
  if (!URL_RE.test(line)) throw new Error(`${what} printed no http(s) URL`);
  return line.replace(/\/+$/u, '');
}

// Captures this head's matrix and writes its manifest; a captured manifest already there for the head is returned as
// is, so the capture runs once per head. `withBase(use)` runs `use(hook)` in a checkout of the base, where `hook(command,
// input)` runs a review.visual command line from the base branch with `input` on stdin and returns its stdout:
// a pull request cannot change the login or preview code it is captured with. `baseUrl` is this machine's setting.
export async function captureVisual({ project, pr, head, visual, entries, baseUrl, env, withBase, spawn = spawnSync }) {
  // A capture that worked is reused; one that did not (no base URL, a server that was down) runs again next time.
  const known = readManifest(project, pr, head);
  if (known?.status === 'captured') return known;
  const dir = captureDir(project, pr, head);
  mkdirSync(dir, { recursive: true });
  const write = (manifest) => {
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
      const urls = {};
      const storageStates = {};
      for (const variant of visual.variants) {
        urls[variant.id] = url;
        if (!variant.account) continue;
        let signedIn;
        try {
          signedIn = JSON.parse(await hook(visual.login, { account: variant.account, variant: variant.id, baseUrl: url }));
        } catch (error) {
          return fail('failed', `review.visual.login for ${variant.id}: ${error.message.split('\n')[0]}`);
        }
        if (!isObject(signedIn?.storageState)) return fail('failed', `review.visual.login for ${variant.id} printed no { "storageState": {...} }`);
        if (signedIn.baseUrl !== undefined) urls[variant.id] = urlFrom(signedIn.baseUrl, `review.visual.login for ${variant.id}`);
        const file = path.join(dir, `.auth-${variant.id}.json`);
        writeFileSync(file, JSON.stringify(signedIn.storageState), { mode: 0o600 });
        chmodSync(file, 0o600);
        authFiles.push(file);
        storageStates[variant.id] = file;
      }
      return { urls, fallback: url, storageStates };
    });
    if (prepared.status) return write({ ...base, ...prepared, entries: [] });
    const jobs = entries.map((entry) => ({
      key: entry.key,
      url: `${prepared.urls[entry.variant] ?? prepared.fallback}${entry.locale ? entry.route.replaceAll('{locale}', entry.locale) : entry.route.replaceAll('/{locale}', '').replaceAll('{locale}', '')}`,
      width: entry.width,
      locale: entry.locale,
      variant: entry.variant,
    }));
    const run = spawn(process.execPath, [ADAPTERS[visual.platform]], {
      cwd: project.root, env, input: JSON.stringify({ outDir: dir, entries: jobs, storageStates: prepared.storageStates }), encoding: 'utf8', timeout: CAPTURE_MS, maxBuffer: 64 * 1024 * 1024,
    });
    const reason = String(run.stderr ?? '').trim().split('\n').at(-1) ?? '';
    if (run.status === 3) return write({ ...base, status: 'unavailable', reason, entries: [] });
    if (run.status !== 0) return write({ ...base, status: 'failed', reason: reason || (run.signal ? `killed by ${run.signal}` : `exit ${run.status}`), entries: [] });
    const results = new Map((JSON.parse(run.stdout).results ?? []).map((result) => [result.key, result]));
    const captured = entries.map((entry) => {
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
// `image(repo, files)` runs `gh image` and returns its spawn result.
export function ghImage(repo, files) {
  try {
    return { status: 0, stdout: runGh(['image', '--repo', repo, ...files], { timeoutMs: 10 * 60_000 }) };
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

// The captures comment: one per pull request, edited in place for each head.
export function capturesBody(manifest, uploaded, { mode, visibility, error }) {
  const lines = [VISUAL_MARKER, `### Visual capture: \`${manifest.head.slice(0, 7)}\``, ''];
  lines.push(`Attach: **${mode}**${visibility ? `, ${String(visibility).toLowerCase()} repository` : ''}. ${manifest.status === 'captured' ? `${manifest.entries.filter((entry) => entry.sha256).length} of ${manifest.entries.length} captured.` : `${manifest.status}: ${manifest.reason}`}`);
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

// What a visual reviewer's pass reads: the captures with their facts and upload links, and the checklist.
export function visualInput(manifest, uploaded, checklist) {
  return {
    status: manifest.status,
    ...(manifest.reason ? { reason: manifest.reason } : {}),
    ...(checklist ? { checklist } : {}),
    cite: 'cite a capture in a flow verdict as capture:<key>',
    captures: manifest.entries.map(({ key, route, width, locale, variant, file, facts, error, sha256 }) => ({
      key, route, width, locale, variant, ...(file ? { file } : {}), ...(sha256 && uploaded[sha256] ? { url: uploaded[sha256] } : {}), ...(facts ? { facts } : {}), ...(error ? { error } : {}),
    })),
  };
}
