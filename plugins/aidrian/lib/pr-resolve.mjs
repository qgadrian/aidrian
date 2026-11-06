// `aidrian pr resolve <pull request URL, number, or #number>`: what the persona-audit skill knows of a pull request before
// it reads the diff, as one JSON object. The argument comes from a person or a pasted link, so it is held to an anchored
// allowlist, its repository must be a remote of this checkout, and gh gets `<n> --repo <host>/<owner>/<name>`, never the
// raw URL. A bare number lets gh pick the repository, so the answer is held to the same remotes; so is a URL's, since gh
// follows a repository that moved. A refusal names its kind and never echoes the argument, which may hold a token.
// `host` is printed beside `repo`: `--repo <owner>/<name>` alone would reach gh's default host. A merged or closed pull
// request resolves too: the walk rules decide what it can be walked at.
// `limited` says the pull request comes from outside, so a run does not walk it. `preview_url` is the one preview a run
// may walk: the newest status of a GitHub deployment for the exact head, at success, on no production environment, under
// a host a `- Preview:` line of `product-access` names, and null otherwise; reading it never ends the run. A pattern under
// shared hosting, such as `*.vercel.app`, is not refused: the deployment source is what stops a stranger's page. That is
// also its limit: a Preview line trusts everything able to create deployments, so a project whose workflow deploys fork
// builds with a write token names no Preview line until that is fixed.
// docs/personas.md#a-pull-request-link-alone describes the JSON.
// Exit 0 with the JSON, 3 on a refusal, a gh failure, an answer it cannot read, or a config.json with errors.

import { readFileSync } from 'node:fs';

import { runGh } from './gh.mjs';
import { loadKnowledge } from './knowledge.mjs';
import { ACCESS_DOC, personaDocs, previewPatterns } from './personas.mjs';
import { checkoutRemotes } from './pr-checks.mjs';
import { projectAt } from './project.mjs';
import { MEMBER_ASSOCIATIONS } from './review/state.mjs';

const NUMBER = /^#?(\d+)$/u;
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//u;
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u;
const PULL_PATH = /^\/([^/?#]+)\/([^/?#]+)\/pull\/(\d+)(?:\/(?:files|commits|checks|changes))?(?:[?#].*)?$/u;
const SLUG = /^[A-Za-z0-9._-]+$/u;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const VIEW_FIELDS = 'number,url,headRefOid,baseRefName,state,isCrossRepository';
const USAGE = 'usage: aidrian pr resolve <pull request URL, number, or #number>';
// As written: `new URL` drops a default port, and forgives a backslash, a space, or an upper-case scheme.
const PREVIEW_WRITTEN = /^https:\/\/[^/?#:\\\s]+(?:[/?#]|$)/u;
// A session pastes the URL into a command: these break out of its quotes or expand inside them. They read as no URL. This
// is no full shell quoting, so a session still quotes the URL.
const PREVIEW_UNSAFE = /['$`\p{Cc}]/u;
// `new URL` decodes a host and maps its fullwidth forms, so a host is held to this after parsing, whatever was written.
const PREVIEW_HOSTNAME = /^[a-z0-9.-]+$/u;

// Whether a pull request comes from outside the team, from gh's `isCrossRepository` and its pulls API answer: another
// repository's branch, a base that is itself a fork, or an author with no standing here. Null when either cannot be read,
// since the limits turn on it and nothing stands in for it. `aidrian pr product-feedback record` stores the same word.
export function fromOutside(isCrossRepository, pull) {
  if (typeof isCrossRepository !== 'boolean' || typeof pull?.author_association !== 'string' || !pull.author_association || typeof pull.base?.repo?.fork !== 'boolean') return null;
  return isCrossRepository || pull.base.repo.fork || !MEMBER_ASSOCIATIONS.has(pull.author_association);
}

const safeName = (part) => SLUG.test(part) && part !== '.' && part !== '..';
const wholeNumber = (digits) => {
  const number = Number(digits);
  return number > 0 && Number.isSafeInteger(number) ? number : null;
};

// A number as { number }, a URL as { host, owner, name, number }, anything else as { refusal }. The refusal holds only
// fixed words: the argument may carry a token.
export function parseTarget(value) {
  const refuse = (refusal) => ({ refusal });
  const NOT_A_NUMBER = 'number: a pull request number is a whole number from 1';
  const bare = NUMBER.exec(value);
  if (bare) {
    const number = wholeNumber(bare[1]);
    return number ? { number } : refuse(NOT_A_NUMBER);
  }
  const scheme = SCHEME.exec(value)?.[1];
  if (!scheme) return refuse('argument: not a pull request URL or a number');
  if (scheme !== 'https') return refuse('scheme: a pull request URL is https');
  const rest = value.slice('https://'.length);
  const host = /^[^/?#]*/u.exec(rest)[0];
  if (host.includes('@')) return refuse('userinfo: a pull request URL carries no user name or token');
  if (!HOST.test(host)) return refuse('host: a pull request URL names a plain host, with no port');
  const parts = PULL_PATH.exec(rest.slice(host.length));
  if (!parts) return refuse('path: a pull request URL ends in /pull/<number>, with an optional /files, /commits, /checks, or /changes, and any query or fragment');
  const [, owner, name, digits] = parts;
  if (!safeName(owner) || !safeName(name)) return refuse('owner or name: each is letters, digits, and . _ -, and neither is . or ..');
  const number = wholeNumber(digits);
  return number ? { host, owner, name, number } : refuse(NOT_A_NUMBER);
}

const repository = ({ host, owner, name }) => `${host}/${owner}/${name}`;

// The project's product-access doc, found as the persona lint finds it.
function projectPreviewPatterns(project) {
  return personaDocs(project.root, loadKnowledge(project).buckets).filter(({ id }) => id === ACCESS_DOC).flatMap(({ file }) => previewPatterns(readFileSync(file, 'utf8')));
}

// An exact host, or one leading `*.` standing for exactly one label.
const hostMatches = (host, pattern) => {
  if (!pattern.startsWith('*.')) return host === pattern;
  const suffix = pattern.slice(1);
  const label = host.slice(0, -suffix.length);
  return host.endsWith(suffix) && label !== '' && !label.includes('.');
};

// `value` as a URL a run may walk, or null: https, no userinfo, no port, written or default, none of PREVIEW_UNSAFE as
// written or as parsed, a plain hostname, and a host a pattern names.
export function previewFrom(value, patterns) {
  if (typeof value !== 'string' || !PREVIEW_WRITTEN.test(value) || PREVIEW_UNSAFE.test(value)) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password || !PREVIEW_HOSTNAME.test(url.hostname) || PREVIEW_UNSAFE.test(url.href)) return null;
  return patterns.some((pattern) => hostMatches(url.hostname, pattern)) ? url.href : null;
}

// The first deployment of exactly this head, on no production environment, whose newest status, by id, is a success with
// a URL that passes, or null. A later status overrides an earlier success; a newer failed deployment does not void an
// older one still at success. A read that fails ends the lookup at null.
function deploymentPreview({ host, repo, head }, patterns, gh) {
  const read = (route) => {
    try {
      const list = JSON.parse(gh(['api', '--hostname', host, route]));
      return Array.isArray(list) ? list : null;
    } catch {
      return null;
    }
  };
  for (const deployment of read(`repos/${repo}/deployments?sha=${head}`) ?? []) {
    if (deployment?.sha !== head || !Number.isSafeInteger(deployment?.id)) continue;
    if (deployment.production_environment === true || (typeof deployment.environment === 'string' && /production/iu.test(deployment.environment))) continue;
    const statuses = read(`repos/${repo}/deployments/${deployment.id}/statuses`);
    if (!statuses) return null;
    const newest = statuses.filter((status) => Number.isSafeInteger(status?.id)).reduce((best, status) => (!best || status.id > best.id ? status : best), null);
    const url = newest?.state === 'success' ? previewFrom(newest.environment_url, patterns) : null;
    if (url) return url;
  }
  return null;
}

// The CLI body. `gh`, `remotes`, and `patterns` are the test seams: (args) → stdout, () → checkoutRemotes, and () → the
// Preview patterns, which may throw when the doc cannot be read: no patterns, so no preview.
export function runResolve(
  argv,
  config,
  gh = (args) => runGh(args),
  remotes = () => checkoutRemotes(process.cwd()),
  patterns = () => projectPreviewPatterns(projectAt(process.cwd())),
) {
  const fail = (message) => {
    console.error(`error: ${message}`);
    return 3;
  };
  if (argv.length !== 1) return fail(USAGE);
  const target = parseTarget(argv[0]);
  if (target.refusal) return fail(target.refusal);
  const isRemote = (where) => remotes().includes(repository(where).toLowerCase());
  const notRemote = (where) => `not a remote: ${repository(where)} is not a remote of this checkout: compared host ${where.host}, owner, and name with each remote, and an SSH host alias is not matched`;
  if (target.host && !isRemote(target)) return fail(notRemote(target));
  const read = (args) => {
    try {
      return JSON.parse(gh(args));
    } catch (error) {
      return { failed: String(error?.stderr || error?.message || error).trim().split('\n')[0] };
    }
  };
  const view = read(['pr', 'view', String(target.number), ...(target.host ? ['--repo', repository(target)] : []), '--json', VIEW_FIELDS]);
  if (view?.failed) return fail(`gh: could not read pull request ${target.number}: ${view.failed}`);
  const unreadable = () => fail(`gh: could not read pull request ${target.number}: its answer is not what gh prints`);
  // The repository gh answered for, by the URL it gave, under the same rules as an argument.
  const answered = typeof view?.url === 'string' ? parseTarget(view.url) : {};
  if (!answered.host || answered.number !== target.number || view.number !== target.number) return unreadable();
  if (!isRemote(answered)) return fail(notRemote(answered));
  if (typeof view.headRefOid !== 'string' || !SHA.test(view.headRefOid) || !view.baseRefName || !view.state || typeof view.isCrossRepository !== 'boolean') return unreadable();
  const repo = `${answered.owner}/${answered.name}`;
  const pull = read(['api', '--hostname', answered.host, `repos/${repo}/pulls/${target.number}`]);
  if (pull?.failed) return fail(`gh: could not read pull request ${target.number}: ${pull.failed}`);
  // The walk limits turn on this word, so nothing stands in for it.
  const limited = fromOutside(view.isCrossRepository, pull);
  if (limited === null) return unreadable();
  let allowed = [];
  try {
    if (!limited) allowed = patterns();
  } catch {
    allowed = [];
  }
  const previewUrl = allowed.length ? deploymentPreview({ host: answered.host, repo, head: view.headRefOid }, allowed, gh) : null;
  console.log(JSON.stringify({
    number: target.number,
    host: answered.host,
    repo,
    head: view.headRefOid,
    base: view.baseRefName,
    state: view.state,
    cross_repository: view.isCrossRepository,
    author_association: pull.author_association,
    limited,
    preview_url: previewUrl,
    max_personas: config.review.productFeedback.maxPersonas,
  }));
  return 0;
}
