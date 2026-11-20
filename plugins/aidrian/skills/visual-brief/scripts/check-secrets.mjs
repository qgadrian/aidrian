// Final check for common credential shapes in a staged, standalone HTML brief.
// Deliberately report no input text, file paths, or runtime error messages.
import { readFileSync } from 'node:fs';

// Fixed prefixes from common API credentials, plus three-part JWTs.
const SIGNATURES = [
  /\b(?:gh[pousr]_[a-z\d]{30,}|github_pat_[a-z\d_]{22,})\b/iu,
  /\bsk-[a-z\d_-]{20,}/iu,
  /\b(?:sk|rk)_(?:live|test)_[a-z\d]{12,}\b/iu,
  /\b(?:AKIA|ASIA)[A-Z\d]{16}\b/u,
  /\bAIza[a-z\d_-]{35}/iu,
  /\bxox[abprs]-[a-z\d-]{12,}/iu,
  /\beyJ[\w-]+\.[\w-]+\.[\w-]+/u,
];
const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9 ]* )?PRIVATE KEY(?: BLOCK)?-----/u;
const URL_CREDENTIALS = /(?<![\w+.-])[a-z][a-z\d+.-]*:\/\/[^\s/?#\0<>"'@]+@[^/\s\0<>"']/iu;
// AWS, Google, CloudFront and Azure use these parameter names in signed URLs.
const SIGNED_URL = /[?&](?:x-(?:amz|goog)-(?:signature|credential|security-token)|signature|sig|awsaccesskeyid|googleaccessid|key-pair-id|access_token)=[^&\s\0<>"'#]/iu;
const ASSIGNMENT = new RegExp(
  String.raw`(?<![\w.-])(?:data-)?((?:proxy[-_])?authorization|(?:set[-_])?cookie|x[-_]api[-_]key|` +
  String.raw`api[-_ ]?key|client[-_ ]?secret|(?:access|refresh|auth|session)[-_ ]?token|token|password|passwd|` +
  String.raw`secret[-_ ]?key|aws[-_]secret[-_]access[-_]key)["']?\s*[:=]\s*(?:(?:bearer|basic|token)\s+)?` +
  String.raw`(?:"([^"\0\n]*)"|'([^'\0\n]*)'|(<[^<>\0\n]+>|\[[^[\]\0\n]+\]|\$\{[^{}\0\n]+\}|[^\s\0<>"',;#}\])]+))`,
  'giu',
);
// Keep the exceptions exact, or recognize an explicit variable reference.
const PLACEHOLDER = /^(?:|\*+|x{3,}|redacted|removed|omitted|placeholder|example|null|none|n\/a|change[_-]?me|your[_-](?:api[_-]?key|token|secret|password)|\$(?:\{[a-z_]\w*\}|[a-z_]\w*))$/iu;
// These authored inline elements can wrap a value without creating a separate block of text.
const INLINE_MARKUP = /<\/?(?:a|abbr|b|code|em|i|kbd|mark|s|samp|small|span|strong|sub|sup|u|var|wbr)(?=[\s/>])[^<>]*>/giu;
// Decode syntax emitted by HTML escaping and named equivalents for URL and assignment delimiters.
const ENTITIES = {
  amp: '&', apos: "'", colon: ':', commat: '@', equals: '=', gt: '>', lt: '<',
  nbsp: ' ', newline: ' ', num: '#', percnt: '%', period: '.', quest: '?',
  quot: '"', sol: '/', tab: ' ', lowbar: '_', hyphen: '-',
};

function normalizedLine(line) {
  // Keep real tag boundaries. An escaped angle bracket still belongs to the source text.
  return line.replaceAll('<', '\0').replace(/&(?:#(x[\da-f]+|\d+);?|([a-z]+);)/giu, (original, numeric, named) => {
    if (named) {
      const name = named.toLowerCase();
      return Object.hasOwn(ENTITIES, name) ? ENTITIES[name] : original;
    }
    const hex = numeric[0].toLowerCase() === 'x';
    const code = hex ? Number.parseInt(numeric.slice(1), 16) : Number(numeric);
    if (code === 10 || code === 13) return ' '; // Keep the original line numbers after decoding.
    return code <= 0x10ffff ? String.fromCodePoint(code) : original;
  }).replace(/\p{Cf}/gu, '');
}

function hasAssignedValue(line, next = '') {
  const text = line + '\n' + next;
  for (const match of text.matchAll(ASSIGNMENT)) {
    if (match.index >= line.length) break;
    const [, field, doubleQuoted, singleQuoted, bare] = match;
    const value = (doubleQuoted ?? singleQuoted ?? bare).trim().replace(/^[<\[]|[>\]]$/gu, '');
    // A wrapped value can leave just the scheme in the raw source copy. The visible copy checks the value.
    if (/authorization$/iu.test(field) && /^(?:bearer|basic|token)$/iu.test(value)) continue;
    if (!PLACEHOLDER.test(value)) return true;
  }
  return false;
}

function check(html) {
  const lines = html.split(/\r\n|\r|\n/u);
  // Check raw attributes and comments, and values presented through authored inline markup.
  const normalizedLines = lines.map(normalizedLine);
  const visibleLines = lines.map((line) => normalizedLine(line.replace(INLINE_MARKUP, '')));
  let found = false;
  for (const [index, normalized] of normalizedLines.entries()) {
    const visible = visibleLines[index];
    const pctDecoded = normalized.replace(/%([\da-f]{2})/giu, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
    const assigned = hasAssignedValue(normalized, normalizedLines[index + 1]) || hasAssignedValue(visible, visibleLines[index + 1]);
    const rules = [
      ['credential-signature', SIGNATURES.some((pattern) => pattern.test(pctDecoded) || pattern.test(visible))],
      ['private-key', PRIVATE_KEY.test(pctDecoded) || PRIVATE_KEY.test(visible)],
      ['credential-value', assigned],
      ['url-credentials', URL_CREDENTIALS.test(normalized) || URL_CREDENTIALS.test(pctDecoded) || URL_CREDENTIALS.test(visible)],
      ['signed-url', SIGNED_URL.test(normalized) || SIGNED_URL.test(pctDecoded) || SIGNED_URL.test(visible)],
    ];
    for (const [rule, matches] of rules) {
      if (!matches) continue;
      console.log(rule + ':' + (index + 1));
      found = true;
    }
  }
  return found ? 1 : 0;
}

function main(args) {
  if (args.length !== 1 || !args[0] || args[0].startsWith('-')) {
    console.error('Usage: node check-secrets.mjs <html-file>');
    return 2;
  }
  let html;
  try {
    html = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(args[0]));
  } catch {
    console.error('Could not read HTML file.');
    return 2;
  }
  return check(html);
}

process.exitCode = main(process.argv.slice(2));
