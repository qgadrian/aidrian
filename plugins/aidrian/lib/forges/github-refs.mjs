// GitHub's branch name patterns, as deployment branch policies, branch protection rules, and rulesets match them, and
// whether one of them can name an issue's branch. GitHub matches them with Ruby's File.fnmatch, with File::FNM_PATHNAME:
// `*` and `?` stop at a slash, `[...]` names one character, `\` escapes the next one, and `**/` matches any number of
// folders. A bare `**`, which Ruby reads as `*`, and `{a,b}` alternatives, which only File::FNM_EXTGLOB reads, are
// taken here as matching more: `**` any text, slashes too, and braces each alternative. A wider match counts more
// environments open, never fewer.

// The most alternatives one pattern's braces expand to; the rest are dropped.
const BRACE_CAP = 64;
// What a wildcard is filled with to name a branch the pattern matches (witnesses).
const FILLERS = Object.freeze(['x', 'issue-1']);
// Branch names in the shapes an issue's branch takes: with no slash, one, and two. A ruleset over every branch, and one
// whose excludes rule out the names its own patterns give, are tried on these.
const SAMPLE_BRANCHES = Object.freeze(['x', 'issue-1', 'feat/issue-1-x', 'x/y/z']);
// The characters a one-character wildcard or set is tried with.
const CHARACTERS = 'xyzq0_-.';

// The patterns `pattern`'s top-level `{a,b}` alternatives stand for, nested ones too, at most BRACE_CAP. A brace with no
// comma, or none that closes, is a literal.
export function braceExpand(pattern) {
  for (let open = 0; open < pattern.length; open += 1) {
    if (pattern[open] === '\\') {
      open += 1;
      continue;
    }
    if (pattern[open] !== '{') continue;
    const parts = braceParts(pattern, open);
    if (!parts) continue;
    const head = pattern.slice(0, open);
    const tail = pattern.slice(parts.close + 1);
    return parts.alternatives.flatMap((each) => braceExpand(`${head}${each}${tail}`)).slice(0, BRACE_CAP);
  }
  return [pattern];
}

// The alternatives of the brace that opens at `open` and the index it closes at, or null for one with no comma at its
// own depth or no close.
function braceParts(pattern, open) {
  const alternatives = [];
  let depth = 0;
  let start = open + 1;
  for (let at = open + 1; at < pattern.length; at += 1) {
    const char = pattern[at];
    if (char === '\\') at += 1;
    else if (char === '{') depth += 1;
    else if (char === '}' && depth > 0) depth -= 1;
    else if (char === ',' && depth === 0) {
      alternatives.push(pattern.slice(start, at));
      start = at + 1;
    } else if (char === '}') {
      if (!alternatives.length) return null;
      alternatives.push(pattern.slice(start, at));
      return { alternatives, close: at };
    }
  }
  return null;
}

// A literal, escaped for a regular expression with the `u` flag, outside a set and inside one.
const escapeText = (text) => text.replace(/[\\^$.*+?()[\]{}|/]/gu, '\\$&');
const escapeSet = (text) => text.replace(/[\\\]\[^-]/gu, '\\$&');

// The `[...]` set that opens at `open`: { body, close, negated }, its characters as a regular expression class body, or
// null when no `]` closes it, so the `[` is a literal. A `]` right after the opening (or after `!` or `^`) is a member.
function setAt(pattern, open) {
  let at = open + 1;
  const negated = pattern[at] === '!' || pattern[at] === '^';
  if (negated) at += 1;
  const first = at;
  let body = '';
  for (; at < pattern.length; at += 1) {
    const char = pattern[at];
    if (char === ']' && at > first) return { body, close: at, negated };
    if (char === '\\' && at + 1 < pattern.length) {
      at += 1;
      body += escapeSet(pattern[at]);
    } else if (char === '-' && at > first && pattern[at + 1] !== ']' && at + 1 < pattern.length) body += '-';
    else body += escapeSet(char);
  }
  return null;
}

// The regular expression source of one brace-free pattern.
function patternSource(pattern) {
  let source = '';
  for (let at = 0; at < pattern.length; at += 1) {
    const char = pattern[at];
    if (char === '\\' && at + 1 < pattern.length) {
      at += 1;
      source += escapeText(pattern[at]);
    } else if (char === '*' && pattern[at + 1] === '*') {
      while (pattern[at + 1] === '*') at += 1;
      const folders = pattern[at + 1] === '/';
      if (folders) at += 1;
      source += folders ? '(?:.*/)?' : '.*';
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else if (char === '[' && setAt(pattern, at)) {
      const set = setAt(pattern, at);
      source += set.negated ? `[^/${set.body}]` : `(?!/)[${set.body}]`;
      at = set.close;
    } else source += escapeText(char);
  }
  return source;
}

// Whether the branch name `name` matches GitHub's pattern `pattern`, as this module's header reads one. A pattern no
// regular expression can stand for, such as a set with a reversed range, matches nothing.
export function fnmatch(pattern, name) {
  if (typeof pattern !== 'string' || typeof name !== 'string') return false;
  return braceExpand(pattern).some((each) => {
    try {
      return new RegExp(`^${patternSource(each)}$`, 'u').test(name);
    } catch {
      return false;
    }
  });
}

// Names `pattern` matches, one per filler for each of its brace alternatives: each wildcard filled, and each set given a
// character it holds.
export function witnesses(pattern) {
  if (typeof pattern !== 'string') return [];
  return braceExpand(pattern).flatMap((each) => FILLERS.map((filler) => witness(each, filler))).filter((name) => fnmatch(pattern, name));
}

function witness(pattern, filler) {
  let name = '';
  for (let at = 0; at < pattern.length; at += 1) {
    const char = pattern[at];
    if (char === '\\' && at + 1 < pattern.length) {
      at += 1;
      name += pattern[at];
    } else if (char === '*') {
      while (pattern[at + 1] === '*') at += 1;
      name += filler;
    } else if (char === '?') name += filler[0];
    else if (char === '[' && setAt(pattern, at)) {
      const set = setAt(pattern, at);
      name += [...CHARACTERS, ...set.body.replace(/\\/gu, '')].find((each) => fnmatch(pattern.slice(at, set.close + 1), each)) ?? filler[0];
      at = set.close;
    } else name += char;
  }
  return name;
}

// Whether a rule over the branch name patterns `include`, less those that match `exclude`, can match an issue's branch:
// a name `issueBranch` takes for one, among the names the include patterns give (witnesses) and SAMPLE_BRANCHES.
// SHORTCUT: excludes are tried on those names only, so a ruleset whose excludes rule out each of them, but not some other
// name its includes match, counts as matching no issue's branch; trying every shape would replace this if a team
// writes such excludes.
export function patternsReach(include, exclude, issueBranch) {
  const names = [...SAMPLE_BRANCHES, ...include.flatMap(witnesses)];
  return names.some((name) => issueBranch(name) && include.some((pattern) => fnmatch(pattern, name)) && !exclude.some((pattern) => fnmatch(pattern, name)));
}

// A branch ruleset's ref_name condition `ref` as a pattern over branch names: `~ALL` every branch, `~DEFAULT_BRANCH` the
// default branch `main` alone, and `refs/heads/<pattern>` its pattern. Any other text is taken as a pattern as it is.
export function rulesetPattern(ref, main) {
  const text = String(ref);
  if (text === '~ALL') return '**';
  if (text === '~DEFAULT_BRANCH') return String(main ?? '').replace(/[\\*?[{]/gu, '\\$&');
  return text.startsWith('refs/heads/') ? text.slice('refs/heads/'.length) : text;
}
