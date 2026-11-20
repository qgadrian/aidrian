// Check the restricted static HTML syntax used by visual briefs. This is not a sanitizer.
import { readFileSync } from 'node:fs';

const ELEMENTS = new Set((
  'html head meta title style body header footer main nav aside section article div span ' +
  'h1 h2 h3 h4 h5 h6 p a em strong abbr b i mark s small u sub sup code pre samp kbd var q blockquote cite ' +
  'time br wbr hr ul ol li dl dt dd figure figcaption details summary ' +
  'table caption colgroup col thead tbody tfoot tr th td ' +
  'svg g defs symbol use rect circle ellipse line polyline polygon path text tspan desc ' +
  'lineargradient radialgradient stop clippath mask marker'
).split(' '));
const ATTRIBUTES = new Set((
  'id class lang dir title role hidden open reversed tabindex datetime start value type ' +
  'colspan rowspan scope headers span width height viewbox preserveaspectratio x y x1 x2 y1 y2 dx dy cx cy r rx ry ' +
  'd points transform gradientunits gradienttransform offset refx refy markerwidth markerheight orient ' +
  'patternunits text-anchor dominant-baseline font-family font-size font-weight opacity fill-opacity stroke-opacity ' +
  'stroke-width stroke-linecap stroke-linejoin stroke-dasharray vector-effect'
).split(' '));
const PAINT_ATTRIBUTES = new Set((
  'style fill stroke stop-color clip-path mask filter marker-start marker-mid marker-end'
).split(' '));
const SAFE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
const SPACE = /[\t\n\f\r ]*/y;
const TAG = /<(\/?)([a-z][a-z\d-]*)(?=[\t\n\f\r />])/iy;
const ATTRIBUTE = /([a-z][a-z\d:-]*)(?:[\t\n\f\r ]*=[\t\n\f\r ]*(?:"([^"<]*)"|'([^'<]*)'))?/iy;
const STYLE_END = /<\/style[\t\n\f\r ]*>/ig;
const FRAGMENT = /^#[a-z\d_.:-]+$/iu;

function matchAt(pattern, html, start) {
  pattern.lastIndex = start;
  return pattern.exec(html);
}

function readAttributes(html, start, closing) {
  const entries = new Map();
  let pos = start;
  for (;;) {
    const previous = pos;
    pos += matchAt(SPACE, html, pos)[0].length;
    if (html[pos] === '>') return { entries, end: pos + 1 };
    if (!closing && html.startsWith('/>', pos)) return { entries, end: pos + 2 };
    if (closing || pos === previous) return null;
    const attr = matchAt(ATTRIBUTE, html, pos);
    if (!attr) return null;
    const name = attr[1].toLowerCase();
    if (entries.has(name)) return null;
    entries.set(name, attr[2] ?? attr[3] ?? '');
    pos = ATTRIBUTE.lastIndex;
  }
}

function safeCss(css, attribute = false) {
  if (/[\\<]/u.test(css) || (attribute && css.includes('&'))) return false;
  const clean = css.replace(/\/\*[\s\S]*?\*\//gu, '').replace(
    /\burl\(\s*(?:(#[\w.:-]+)|"(#[\w.:-]+)"|'(#[\w.:-]+)')\s*\)/giu,
    '',
  );
  return !/@(?!media\b|supports\b|page\b|layer\b|container\b)/iu.test(clean) &&
    !/\b(?:url|src|image|(?:-webkit-)?image-set)\s*\(/iu.test(clean);
}

function safeMeta(entries) {
  if (entries.size === 1) return entries.get('charset')?.toLowerCase() === 'utf-8';
  if (entries.size !== 2) return false;
  if (entries.get('name')?.toLowerCase() === 'viewport') return entries.has('content');
  return entries.get('http-equiv')?.toLowerCase() === 'content-security-policy' &&
    entries.get('content') === SAFE_CSP;
}

function safeCitation(href, rel = '') {
  if (FRAGMENT.test(href)) return true;
  if (!/^https?:\/\/[^/?#&\\\s]+(?:[/?#]|$)/iu.test(href) || /[\s\\\p{Cc}]/u.test(href)) return false;
  if (!URL.canParse(href)) return false;
  const url = new URL(href);
  return !url.username && !url.password && rel.toLowerCase().split(/\s+/u).includes('noreferrer');
}

function checkAttributes(tag, entries) {
  if (tag === 'meta') return safeMeta(entries) ? null : 'offline-meta';
  for (const [name, value] of entries) {
    if (PAINT_ATTRIBUTES.has(name)) {
      if (!safeCss(value, true)) return 'offline-css';
      continue;
    }
    if (name === 'href' && tag === 'a') {
      if (!safeCitation(value, entries.get('rel'))) return 'offline-citation';
      continue;
    }
    if (name === 'href' && tag === 'use' && FRAGMENT.test(value)) continue;
    if (name === 'rel' && tag === 'a') continue;
    if (name === 'xmlns' && tag === 'svg' && value === 'http://www.w3.org/2000/svg') continue;
    if (ATTRIBUTES.has(name) || /^(?:aria|data)-[a-z\d-]+$/u.test(name)) continue;
    return 'offline-attribute';
  }
  return null;
}

function commentEnd(html, start) {
  const end = html.indexOf('-->', start + 4);
  const body = html.slice(start + 4, end);
  if (end < 0 || body.startsWith('>') || body.startsWith('->') || body.includes('--') || body.endsWith('-')) return -1;
  return end + 3;
}

// Require ordinary authored tags and quoted attributes. Unexpected syntax needs manual repair before preview.
function check(html) {
  const doctype = /^\s*<!doctype html[\t\n\f\r ]*>/iu.exec(html);
  if (!doctype || html.includes('\0')) return ['offline-markup', 0];
  let pos = doctype[0].length;
  while ((pos = html.indexOf('<', pos)) !== -1) {
    if (html.startsWith('<!--', pos)) {
      const end = commentEnd(html, pos);
      if (end < 0) return ['offline-markup', pos];
      pos = end;
      continue;
    }
    const token = matchAt(TAG, html, pos);
    if (!token) return ['offline-markup', pos];
    const [, closing, name] = token;
    const tag = name.toLowerCase();
    if (!ELEMENTS.has(tag)) return ['offline-element', pos];
    const attrs = readAttributes(html, TAG.lastIndex, closing);
    if (!attrs) return ['offline-markup', pos];
    if (!closing) {
      const problem = checkAttributes(tag, attrs.entries);
      if (problem) return [problem, pos];
    }
    if (tag === 'style' && !closing) {
      STYLE_END.lastIndex = attrs.end;
      const end = STYLE_END.exec(html);
      if (!end || !safeCss(html.slice(attrs.end, end.index))) return ['offline-css', pos];
      pos = STYLE_END.lastIndex;
      continue;
    }
    pos = attrs.end;
  }
  return null;
}

function main(args) {
  if (args.length !== 1 || !args[0] || args[0].startsWith('-')) {
    console.error('Usage: node check-offline.mjs <html-file>');
    return 2;
  }
  let html;
  try {
    html = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(args[0]));
  } catch {
    console.error('Could not read HTML file.');
    return 2;
  }
  const result = check(html);
  if (!result) return 0;
  const [rule, pos] = result;
  const line = html.slice(0, pos).split(/\r\n|\r|\n/u).length;
  console.log(rule + ':' + line);
  return 1;
}

process.exitCode = main(process.argv.slice(2));
