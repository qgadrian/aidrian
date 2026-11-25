// A visual target's `routeFrom` (docs/review.md#visual-review): the route a changed file yields, its template filled
// with the captures of a `re:` pattern over the file's path. The template is the team's, checked with the config; the
// file name is the pull request's, so it is untrusted, and the filled route is held to one rule.

import { pathPattern } from './plan.mjs';

// The one rule, fail closed: a path of segments that hold only the characters a URL never encodes, letters, digits,
// and `. _ ~ -`, none of them `.` or `..`. So a scheme, a host, a leading `//`, a backslash, an encoded `..`, a query,
// a space, a control character, and a dynamic segment such as `[id]` are all refused, and nothing is ever encoded.
const ROUTE_PATH = /^(?!.*\/\.{1,2}(?:\/|$))\/(?:[\w.~-]+(?:\/[\w.~-]+)*\/?)?$/u;
// A capture's key is its file's name, so a longer route could not be written to disk.
const MAX_ROUTE = 150;
const REFUSED = `yields no path on the target's base: a filled route is at most ${MAX_ROUTE} characters, its segments hold only letters, digits, and . _ ~ -, and none is . or ..`;

const CAPTURE = /\$(\d+)/gu;
const fill = (template, group) => template.replace(CAPTURE, (_, number) => group(Number(number)));
// The template with each `{locale}` segment, which the capture fills later, standing as plain text: a `{locale}` in part
// of a segment, or one a file name brings, stays and fails the rule.
const withoutLocale = (template) => template.split('/').map((segment) => (segment === '{locale}' ? 'x' : segment)).join('/');

// The problem with a `routeFrom` whose pattern compiles, or null.
export function templateProblem({ pattern, route }) {
  const captures = new RegExp(`${pathPattern(pattern).source}|`, 'u').exec('').length - 1;
  const missing = [...route.matchAll(CAPTURE)].find(([, number]) => Number(number) < 1 || Number(number) > captures);
  if (missing) return `names ${missing[0]}, and the pattern has ${captures} capture${captures === 1 ? '' : 's'}`;
  if (!ROUTE_PATH.test(fill(withoutLocale(route), () => 'x'))) return 'must be a path starting with / that holds only letters, digits, . _ ~ -, captures such as $1, and whole {locale} segments';
  return null;
}

// What `file` yields: null when the pattern does not match it, { route }, or { problem } for a route the rule refuses.
export function fileRoute({ pattern, route }, file) {
  const match = pathPattern(pattern).exec(file);
  if (!match) return null;
  const group = (number) => match[number] ?? '';
  const filled = fill(route, group);
  return ROUTE_PATH.test(fill(withoutLocale(route), group)) && filled.length <= MAX_ROUTE ? { route: filled } : { problem: REFUSED };
}
