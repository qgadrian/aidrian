// The push preflight (docs/handoff.md#the-push-preflight): before a run no Human attends starts work, whether the host
// would let a session push to this repository's remote, `origin`. Two entry points ask it: the background route of the
// handoff gate (lib/handoff-continue.mjs startInBackground), which falls back to the clear route on a denial, and
// `aidrian push-preflight`, which the autopilot skill runs at launch. Only a clear denial stops a run: a host with no
// answer, a remote this cannot read, or anything that throws answers `unknown`, and the run starts as before.
// The host sees the remote only as `host/owner/repo` (project.mjs normalizeRemote), held to plain ASCII, so the user
// name and password of its URL never reach an adapter or a message. This file names no host and no host setting: the
// adapter's capabilities.pushPermission does (lib/hosts/index.mjs pushPermission). It never loads lib/forges/, since
// every hook that loads the gate would load the forge adapter with it.

import { runGit } from './git.mjs';
import { hasControl } from './handoff-markers.mjs';
import { detectHost, pushPermission } from './hosts/index.mjs';
import { normalizeRemote } from './project.mjs';
import { usageLines } from './usage.mjs';

const UNKNOWN = Object.freeze({ answer: 'unknown' });
// A remote URL longer than this is no remote a host would name.
const MAX_URL = 1024;
// A remote on this machine: a path, a `~` path, a file: URL, or a drive letter. No host trusts or refuses a push there.
const LOCAL = /^(?:[/.~\\]|file:|[a-z]:[\\/])/iu;
// The only repository the host is asked about and a message prints: a host name, then two or more path segments of
// plain ASCII, in lower case. Anything else, such as what a password with an `@` or a `:` leaves behind, a query, a
// fragment, or an invisible or right-to-left character, answers unknown and is never sent or printed.
const REPOSITORY = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?:\/(?!\.{1,2}(?:\/|$))[a-z0-9._~%+-]+){2,}$/u;

// { answer: 'allowed' | 'unknown' } or { answer: 'denied', repository, message }, never thrown. `message` is one line,
// with no final full stop, so a caller can go on after it: it names the host, the setting and the file to change, the
// repository, the Human, and the host's AI. The remote is the URL a push goes to, `origin`'s push URL, which is its
// fetch URL unless `remote.origin.pushurl` sets another. `git` is runGit's shape, which a test replaces.
export function pushPreflight({ cwd, env = process.env, host, session, git = runGit } = {}) {
  try {
    // In the try: a folder removed under the process answers unknown.
    const folder = cwd ?? process.cwd();
    const asked = host ?? detectHost({ env });
    const read = git(['remote', 'get-url', '--push', '--all', 'origin'], folder);
    if (read?.status !== 0 || typeof read.stdout !== 'string') return UNKNOWN;
    const url = read.stdout.replace(/\r?\n$/u, '');
    // Several push URLs, or none: no one remote to judge.
    if (url === '' || url.length > MAX_URL || hasControl(url) || /\s/u.test(url) || LOCAL.test(url)) return UNKNOWN;
    const repository = normalizeRemote(url).toLowerCase();
    if (!REPOSITORY.test(repository)) return UNKNOWN;
    const asking = session === undefined ? asked.sessionId(env) : session;
    const said = pushPermission(asked, { repository, session: asking, cwd: folder, env });
    if (said.answer !== 'denied') return { answer: said.answer };
    const message = `${asked.name} would refuse a push to this repository's remote, ${repository}: ${said.setting} in ${said.file} ${said.why}. `
      + `Before a run no Human attends, the Human ${said.fix}; ${asked.ai} never changes that file`;
    return { answer: 'denied', repository, message };
  } catch {
    return UNKNOWN;
  }
}

export const commands = {
  'push-preflight': {
    usage: '',
    about: 'say whether the host would let a session push to the remote origin, before a run no Human attends: '
      + 'push: allowed or push: unknown exits 0; push: denied exits 1, with what to change on stderr',
    run(args) {
      if (args.length > 0) {
        console.error(usageLines('push-preflight', commands['push-preflight'].usage, 'usage: ').join('\n'));
        return 2;
      }
      const read = pushPreflight();
      console.log(`push: ${read.answer}`);
      if (read.answer !== 'denied') return 0;
      console.error(`aidrian push-preflight: ${read.message}`);
      return 1;
    },
  },
};
