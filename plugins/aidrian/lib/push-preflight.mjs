// The push preflight (docs/handoff.md#the-push-preflight): before a run no Human attends starts work, whether the host
// would let a session push to the remote, `origin`, of the folder the run will work in. Two entry points ask it: the
// background route of the handoff gate (lib/handoff-continue.mjs startInBackground), on the folder the host starts the
// new session in, which falls back to the clear route on a denial; and `aidrian push-preflight [--cwd DIR]`, which the
// autopilot skill runs at launch. Only a clear denial stops a run: a host with no answer, a folder that is not there,
// such as a worktree not yet created, a remote this cannot read, or anything that throws answers `unknown`, and the run
// starts as before.
// The host sees the remote only as `host/owner/repo` (project.mjs normalizeRemote), held to plain ASCII, so the user
// name and password of its URL never reach an adapter or a message. This file names no host and no host setting: the
// adapter's capabilities.pushPermission does (lib/hosts/index.mjs pushPermission). It never loads lib/forges/, since
// every hook that loads the gate would load the forge adapter with it.

import { statSync } from 'node:fs';
import path from 'node:path';

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
// A remote git reaches over the network: a URL whose scheme is one git's own transports speak, or scp-style
// `[user@]host:path`, a colon before any slash. git reads anything else, such as `mirrors.example/acme/widget.git`, as a
// path on this machine, relative to the repository, whatever host it seems to name; and `<helper>::<address>` goes to a
// remote helper, not to a host.
const NETWORK = /^(?:(?:https?|ftps?|ssh|git|git\+ssh|ssh\+git):\/\/|[^/:\\]+:(?!\/\/|:))/iu;
// The only repository the host is asked about and a message prints: a host name with at least one dot, then two or
// more path segments of plain ASCII, in lower case. Anything else answers unknown and is never sent or printed: what a
// password with an `@` or a `:` leaves behind, a query, a fragment, an invisible or right-to-left character, and a host
// with no dot, such as an SSH host alias (`git@github-work:acme/widget.git`), which names no host a setting would.
const REPOSITORY = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?:\/(?!\.{1,2}(?:\/|$))[a-z0-9._~%+-]+){2,}$/u;

// { answer: 'allowed' | 'unknown' } or { answer: 'denied', repository, message }, never thrown. `message` is one line,
// with no final full stop, so a caller can go on after it: it names the host, the setting and the file to change, the
// repository, the Human, and the host's AI. The remote is the URL a push goes to, `origin`'s push URL, which is its
// fetch URL unless `remote.origin.pushurl` sets another. `git` is runGit's shape, which a test replaces.
export function pushPreflight({ cwd, env = process.env, host, session, git = runGit } = {}) {
  try {
    // In the try: a folder removed under the process answers unknown. A folder that is not there, such as the worktree
    // of a run not yet created, has no remote of its own: one above it is not the run's.
    const folder = cwd ?? process.cwd();
    if (!statSync(folder).isDirectory()) return UNKNOWN;
    const asked = host ?? detectHost({ env });
    const read = git(['remote', 'get-url', '--push', '--all', 'origin'], folder);
    if (read?.status !== 0 || typeof read.stdout !== 'string') return UNKNOWN;
    const url = read.stdout.replace(/\r?\n$/u, '');
    // Several push URLs, or none: no one remote to judge. A remote on this machine has no host to ask about.
    if (url === '' || url.length > MAX_URL || hasControl(url) || /\s/u.test(url) || LOCAL.test(url) || !NETWORK.test(url)) return UNKNOWN;
    // normalizeRemote drops a `.git` in lower case alone; `.GIT` goes here, so the repository has one name.
    const repository = normalizeRemote(url).toLowerCase().replace(/\.git$/u, '');
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

// `folder` as an absolute path, from the folder the command runs in, or undefined when that folder is gone, which
// pushPreflight then reads as no remote. A folder that is not there answers unknown in pushPreflight.
function absolute(folder) {
  try {
    return path.resolve(folder);
  } catch {
    return path.isAbsolute(folder) ? folder : undefined;
  }
}

export const commands = {
  'push-preflight': {
    usage: '[--cwd DIR]',
    about: 'say whether the host would let a session push to the remote origin, before a run no Human attends: '
      + 'push: allowed or push: unknown exits 0; push: denied exits 1, with what to change on stderr; '
      + '--cwd names the folder the run will work in, by default this one',
    run(args) {
      const named = args.length === 2 && args[0] === '--cwd' && args[1] !== '';
      if (args.length > 0 && !named) {
        console.error(usageLines('push-preflight', commands['push-preflight'].usage, 'usage: ').join('\n'));
        return 2;
      }
      // A folder removed under the command, or one that is not there yet, reads no remote: unknown.
      const read = named ? pushPreflight({ cwd: absolute(args[1]) }) : pushPreflight();
      console.log(`push: ${read.answer}`);
      if (read.answer !== 'denied') return 0;
      console.error(`aidrian push-preflight: ${read.message}`);
      return 1;
    },
  },
};
