// The line-length check for Markdown files: one sentence per line reads well in every diff, and the limit
// (config.json `docs.wrapLimit`) keeps a line on one screen. Text that wrapping would damage is never reported:
// YAML frontmatter, fenced and indented code, table rows, and a line whose overflow is one unbreakable token, such as a URL.

const FENCE = /^(`{3,}|~{3,})(.*)$/;
const FRONTMATTER = /^---\s*$/;

// Fence state after `line`: null outside a fence. A fence closes only on its own character, at least as long as the
// opener, with nothing but spaces after it; so a ```` block can show a ``` line, and a ```js line inside a block is code.
export function nextFenceState(fence, line) {
  const match = FENCE.exec(String(line ?? '').trimStart());
  if (!match) return fence;
  if (fence === null) return { char: match[1][0], length: match[1].length };
  if (match[1][0] !== fence.char || match[1].length < fence.length) return fence;
  return /^[ \t]*\r?$/.test(match[2]) ? null : fence;
}

// The lines of a Markdown document longer than `limit`, as { line (1-based), length }.
export function findWrapViolations(text, limit) {
  const violations = [];
  const lines = String(text ?? '').split('\n');
  let fence = null;
  let inFrontmatter = FRONTMATTER.test(lines[0] ?? '');
  for (const [index, line] of lines.entries()) {
    if (inFrontmatter) {
      if (index > 0 && FRONTMATTER.test(line)) inFrontmatter = false;
      continue;
    }
    const wasInFence = fence !== null;
    fence = nextFenceState(fence, line);
    if (wasInFence || fence !== null) continue;
    if (line.trimStart().startsWith('|') || line.startsWith('    ') || line.startsWith('\t')) continue;
    // Wrapping breaks only at whitespace, so a line whose longest token is over the limit cannot be fixed.
    if (line.length > limit && line.split(/\s+/).every((token) => token.length <= limit)) violations.push({ line: index + 1, length: line.length });
  }
  return violations;
}

// The 1-based lines of `fileText` that `introduced` spans, every occurrence; null when it is not in the file.
export function affectedLines(fileText, introduced) {
  if (typeof introduced !== 'string' || introduced === '') return null;
  const hits = new Set();
  for (let at = fileText.indexOf(introduced); at !== -1; at = fileText.indexOf(introduced, at + introduced.length)) {
    const first = fileText.slice(0, at).split('\n').length;
    for (let n = first; n < first + introduced.split('\n').length; n += 1) hits.add(n);
  }
  return hits.size > 0 ? hits : null;
}
