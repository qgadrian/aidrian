// The web adapter of the visual capture (lib/review/visual.mjs): one screenshot per route, width, locale, and variant,
// with the geometry facts a reviewer cannot see in a picture, measured in the page. It runs as its own process in the
// project folder and loads the project's own Playwright (`playwright` or `@playwright/test`): the plugin ships no
// browser. Input on stdin: { outDir, entries: [{ key, url, width, locale, variant, auth? }], storageStates: { auth: file } },
// where `auth` names the signed-in persona of the entry's variant, or of its variant and locale.
// Output on stdout: { results: [{ key, file, facts } | { key, error }] }, or exit 3 with the reason when Playwright or
// its browser is missing. Animations and the caret are off, and motion is reduced, so the same page gives the same
// bytes and a re-run uploads nothing new.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The touch-target size under which a control is reported: 44 CSS pixels, the common platform guideline.
export const MIN_TARGET = 44;
const MAX_FACTS = 20;
const HEIGHT = 900;
const NAVIGATION_MS = 30_000;

// The facts of the page, measured in the browser: horizontal overflow, text cut off by its box, and controls smaller
// than MIN_TARGET. Each list stops at MAX_FACTS, and says how many more there were.
export function measure({ minTarget, maxFacts }) {
  const describe = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/u).slice(0, 2).join('.')}` : '';
    const words = (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/gu, ' ').slice(0, 40);
    return `${el.tagName.toLowerCase()}${id}${cls}${words ? ` "${words}"` : ''}`;
  };
  const doc = document.scrollingElement || document.documentElement;
  const clipped = [];
  const small = [];
  let clippedMore = 0;
  let smallMore = 0;
  const controls = 'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=checkbox], [role=tab]';
  for (const el of document.body.querySelectorAll('*')) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    const leafText = el.children.length === 0 && (el.textContent || '').trim() !== '';
    const cuts = ['hidden', 'clip'].includes(style.overflowX) || style.textOverflow === 'ellipsis';
    if (leafText && cuts && el.scrollWidth > el.clientWidth + 1) {
      if (clipped.length < maxFacts) clipped.push(describe(el));
      else clippedMore += 1;
    }
    if (el.matches(controls) && (box.width < minTarget || box.height < minTarget)) {
      if (small.length < maxFacts) small.push(`${describe(el)} ${Math.round(box.width)}x${Math.round(box.height)}`);
      else smallMore += 1;
    }
  }
  return {
    overflowX: doc.scrollWidth > doc.clientWidth + 1 ? { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth } : null,
    clippedText: clipped,
    ...(clippedMore ? { clippedTextMore: clippedMore } : {}),
    smallTargets: small,
    ...(smallMore ? { smallTargetsMore: smallMore } : {}),
  };
}

// The project's Playwright browser type, or null.
function chromiumOf(cwd) {
  const require = createRequire(path.join(cwd, 'package.json'));
  for (const name of ['playwright', '@playwright/test']) {
    try {
      const loaded = require(name);
      if (loaded?.chromium) return loaded.chromium;
    } catch {}
  }
  return null;
}

async function main() {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const chromium = chromiumOf(process.cwd());
  if (!chromium) {
    process.stderr.write('Playwright is not installed in this project: add playwright or @playwright/test, then `npx playwright install chromium`\n');
    process.exitCode = 3;
    return;
  }
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    process.stderr.write(`the Playwright browser did not start: ${String(error?.message ?? error).split('\n')[0]} (run \`npx playwright install chromium\`)\n`);
    process.exitCode = 3;
    return;
  }
  const results = [];
  try {
    for (const entry of input.entries) {
      const context = await browser.newContext({
        viewport: { width: entry.width, height: HEIGHT },
        deviceScaleFactor: 1,
        ...(entry.locale ? { locale: entry.locale } : {}),
        reducedMotion: 'reduce',
        ...(entry.auth && input.storageStates?.[entry.auth] ? { storageState: input.storageStates[entry.auth] } : {}),
      });
      try {
        const page = await context.newPage();
        const response = await page.goto(entry.url, { waitUntil: 'networkidle', timeout: NAVIGATION_MS });
        const file = path.join(input.outDir, `${entry.key}.png`);
        await page.screenshot({ path: file, fullPage: true, animations: 'disabled', caret: 'hide' });
        const facts = await page.evaluate(measure, { minTarget: MIN_TARGET, maxFacts: MAX_FACTS });
        results.push({ key: entry.key, file, facts: { status: response?.status() ?? null, ...facts } });
      } catch (error) {
        results.push({ key: entry.key, error: String(error?.message ?? error).split('\n')[0].slice(0, 300) });
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  process.stdout.write(`${JSON.stringify({ results })}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${String(error?.message ?? error).split('\n')[0]}\n`);
    process.exitCode = 1;
  });
}
