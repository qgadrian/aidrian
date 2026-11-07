#!/usr/bin/env node
// A gh that answers the reads of the ready hold and of `aidrian pr product-feedback` for pull request 7 of acme/notes,
// and nothing else: it never reaches GitHub. In-process, `answer(args, spec)` is the exec seam's answer; as a program,
// it reads its spec from the file READY_GH_SPEC names, appends each call to READY_GH_LOG, and sleeps `sleepMs` first.

import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const URL7 = 'https://github.com/acme/notes/pull/7';

// The node ids of pull request 7, current and legacy, that the graphql lookup knows.
export const NODE_IDS = ['PR_kwDOabc123', 'MDExOlB1bGxSZXF1ZXN0MQ=='];
// The branch whose pull request is 7.
export const BRANCH = 'feature/absences';

const notFound = () => Object.assign(new Error('gh: Not Found (HTTP 404)'), { stderr: 'gh: Not Found (HTTP 404)\n', status: 1 });
const noPull = (what) => Object.assign(new Error(`no pull requests found for ${what}`), { stderr: `no pull requests found for ${what}\n`, status: 1 });

// Whether gh would read `-R` (or GH_REPO) as acme/notes, in each spelling it takes: OWNER/REPO, HOST/OWNER/REPO, or a URL.
const isNotes = (repo) => /^(?:(?:https?|ssh):\/\/(?:git@)?|git@)?(?:(?:www\.)?github\.com[/:])?acme\/notes(?:\.git)?\/?$/iu.test(repo);
// Whether gh would read `target` as pull request 7 of the repository `repo` names (null: acme/notes, this checkout's):
// none (the current branch), the branch, a number as Go reads one, or a URL, whose repository gh takes over `-R`.
function isSeven(target, repo) {
  const url = /^https?:\/\/(?:www\.)?github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#].*)?$/iu.exec(target ?? '');
  if (url) return isNotes(url[1]) && Number(url[2]) === 7;
  if (repo !== null && !isNotes(repo)) return false;
  return target === null || target === BRANCH || /^#?\+?0*7$/u.test(target);
}

// gh's stdout for `args`, or a thrown error as execFileSync throws it. `spec`: { head, base, config, files, user }.
export function answer(args, spec) {
  const { head, base = 'main', config = null, files = [{ path: 'src/ui/page.js', changeType: 'MODIFIED' }] } = spec;
  if (args[0] === 'pr' && args[1] === 'view') {
    const target = args[2] && !args[2].startsWith('-') ? args[2] : null;
    const at = args.indexOf('--repo');
    if (!isSeven(target, at === -1 ? null : args[at + 1])) throw noPull(target ?? 'the current branch');
    return JSON.stringify({ number: 7, headRefOid: head, baseRefName: base, author: { login: 'adrian' }, url: URL7, files, changedFiles: files.length,
      reviewDecision: '', latestReviews: [], isCrossRepository: false });
  }
  if (args[0] !== 'api') throw Object.assign(new Error(`fake gh: no answer for ${args.join(' ')}`), { stderr: 'unknown\n', status: 1 });
  if (args[1] === 'graphql') {
    const id = args.find((each) => each.startsWith('id='))?.slice('id='.length);
    return JSON.stringify({ data: { node: NODE_IDS.includes(id) ? { url: URL7 } : null } });
  }
  const route = args.at(-1);
  if (route === 'user') return JSON.stringify({ login: spec.user ?? 'adrian' });
  if (route === 'repos/acme/notes') return JSON.stringify({ default_branch: 'main' });
  if (route === 'repos/acme/notes/pulls/7') return JSON.stringify({ author_association: 'MEMBER', base: { repo: { fork: false } } });
  const content = /^repos\/acme\/notes\/contents\/(.+)\?ref=/u.exec(route);
  if (content && decodeURIComponent(content[1]) === '.aidrian/config.json' && config !== null) {
    return JSON.stringify({ type: 'file', encoding: 'base64', content: Buffer.from(config).toString('base64') });
  }
  if (content) throw notFound();
  throw Object.assign(new Error(`fake gh: no answer for ${args.join(' ')}`), { stderr: 'unknown\n', status: 1 });
}

// node --test also runs every file under test/ as a test file: with no spec named, it is only the module.
if (process.argv[1] === fileURLToPath(import.meta.url) && process.env.READY_GH_SPEC) {
  const spec = JSON.parse(readFileSync(process.env.READY_GH_SPEC, 'utf8'));
  if (process.env.READY_GH_LOG) appendFileSync(process.env.READY_GH_LOG, `${JSON.stringify(process.argv.slice(2))}\n`);
  if (spec.sleepMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, spec.sleepMs);
  try {
    process.stdout.write(answer(process.argv.slice(2), spec));
  } catch (error) {
    process.stderr.write(error.stderr ?? `${error.message}\n`);
    process.exit(1);
  }
}
