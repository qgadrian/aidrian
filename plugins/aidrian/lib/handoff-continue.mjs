// `aidrian handoff continue BRIEF [--route ROUTE]`: the gate between a checked handoff brief and a continuation that
// resumes from it with nothing typed but what the route asks (docs/handoff.md#continue). It arms only a brief that is
// right inside `<state>/handoffs/`, passed `aidrian handoff check` with these exact bytes, was written in the last
// BRIEF_WINDOW, and is below `session.handoff.maxChain` continuations in a row. Exits:
//   2  usage, a config with errors, an unknown --route, or a brief the store does not hold;
//   0  `continue: none`, with one `fallback:` line when a route was asked for and cannot run here;
//   1  a refusal the session can fix, on stderr: no passing check of these bytes, a brief too old to arm, or a Chain
//      below the floor this session was given when a continuation started it;
//   0  `continue: <route>` and a `say:` line, once the marker is armed.
// The latest run decides: once the brief resolves and the session id is known, any marker the session armed before
// goes, whatever the exit, so a clear never delivers an earlier brief. A disk that refuses the store's write exits 2.
// The main session alone runs it: the agent-gates hook refuses it to a subagent, whose shell carries the main session's
// id (lib/handoff-guard.mjs handoffContinueDenial). The route a host can do, and what it asks of the Human, are the host
// adapter's `capabilities.handoffContinue`; this file names no host.

import { createHash } from 'node:crypto';
import path from 'node:path';

import { commandConfig } from './config.mjs';
import { CONTINUE_ROUTES } from './config-schema.mjs';
import { arm, cancelArmed, checkedSha, fresh, openStore, readContainedBrief, readFrom, SESSION_ID, SLUG, slugOf, sweep } from './handoff-markers.mjs';
import { continueRoutes, detectHost, sessionIdentity } from './hosts/index.mjs';
import { projectAt, stateDir } from './project.mjs';

// How old a brief the gate arms may be: it runs in the turn that wrote the brief, and a check and fix round fits.
export const BRIEF_WINDOW = 15 * 60 * 1000;

// The route a handoff goes on by: { route, fallback }. `override` is the command's --route, which may pick `none`,
// `clear`, or `compact` whatever `configured` (session.handoff.continue) says, and `background` only when `configured`
// is `background`. A route `host` does not list gives `none` with the fallback line that says why.
export function effectiveRoute(configured, host, override) {
  const route = override ?? configured;
  if (route === 'none') return { route, fallback: null };
  if (route === 'background' && configured !== 'background') {
    return { route: 'none', fallback: '--route background runs only when session.handoff.continue is "background"' };
  }
  if (!continueRoutes(host).includes(route)) {
    return { route: 'none', fallback: `the ${route} route does not run on this host (${host.name}); a person resumes the brief` };
  }
  return { route, fallback: null };
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Runs the gate on `brief`, a path from `cwd`, and returns { exitCode, out, err }: the lines for stdout and stderr.
// `chainOf` reads a brief's chain count (lib/handoff-brief.mjs). Throws config.mjs's CONFIG_ERROR, exit 2, on a config
// with errors.
export function continueBrief(brief, { override, chainOf, env = process.env, cwd = process.cwd(), now = Date.now() }) {
  if (override !== undefined && !CONTINUE_ROUTES.includes(override)) {
    return { exitCode: 2, out: [], err: [`--route must be ${CONTINUE_ROUTES.map((each) => `"${each}"`).join(', ')}`] };
  }
  const project = projectAt(cwd);
  const config = commandConfig(project, { exitCode: 2 });
  const { continue: configured, maxChain } = config.session.handoff;
  const store = openStore(stateDir(project, { config, env }), { checkouts: project.checkouts, maxChain });
  const given = path.resolve(cwd, brief);
  const found = readContainedBrief(store.handoffs, given);
  if (found.problem) return { exitCode: 2, out: [], err: [`${given} ${found.problem}`] };

  const session = sessionIdentity(env).session;
  const known = typeof session === 'string' && SESSION_ID.test(session);
  try {
    if (known) cancelArmed(store, session, { now });
    return decide({ found, store, session: known ? session : null, override, configured, maxChain, chainOf, env, now });
  } catch (error) {
    if (typeof error?.code !== 'string') throw error;
    return { exitCode: 2, out: [], err: [`could not arm the continuation of ${found.path} (${error.code})`] };
  }
}

// The gate's steps 2 to 5 on a brief that resolved, once any earlier marker of `session` is gone.
function decide({ found, store, session, override, configured, maxChain, chainOf, env, now }) {
  const host = detectHost({ env });
  const { route, fallback } = effectiveRoute(configured, host, override);
  const none = (why) => ({ exitCode: 0, out: ['continue: none', ...(why ? [`fallback: ${why}`] : [])], err: [] });
  if (route === 'none') return none(fallback);
  const slug = slugOf(found.path);
  const chain = chainOf(found.bytes.toString('utf8'));
  if (!session) return none('this host tells the command no session id, so no continuation can be armed');
  if (!SLUG.test(slug)) return none(`the slug ${JSON.stringify(slug)} is not letters, digits, dots, dashes, and underscores, up to 100, starting with a letter or digit`);
  if (store.refused) return none(store.refused);
  if (Number.isInteger(chain) && chain >= maxChain) {
    return none(`this brief has Chain ${chain}, and session.handoff.maxChain allows ${maxChain} continuations in a row; a person resumes it, which starts the count again`);
  }

  const hash = sha256(found.bytes);
  if (chain === null || checkedSha(store, path.basename(found.path), { now }) !== hash) {
    return refuse(`${found.path} has no passing check of its current text: run \`aidrian handoff check ${found.path}\` first, then run this again`);
  }
  const floor = readFrom(store, session, { now });
  if (floor?.slug === slug && chain < floor.chain) {
    return refuse(`the brief's Chain is below this session's floor ${floor.chain}; set Chain: ${floor.chain} in ${found.path}, check it, and run this again`);
  }
  const mtime = Math.floor(found.mtimeMs);
  if (!fresh(mtime, now, BRIEF_WINDOW)) {
    const when = mtime > now ? 'is dated in the future' : `was last written ${Math.round((now - mtime) / 60000)} minutes ago`;
    return refuse(`${found.path} ${when}, and the gate arms only a brief written in the last ${BRIEF_WINDOW / 60000} minutes: refresh the brief, check it, and run this again`);
  }

  sweep(store, now);
  if (!arm(store, { route, session, brief: found.path, slug, chain, sha256: hash }, { now })) {
    return { exitCode: 2, out: [], err: [`could not arm the continuation of ${found.path}`] };
  }
  const steps = host.capabilities.handoffContinue.steps[route];
  return {
    exitCode: 0,
    out: [
      `continue: ${route}`,
      `say: To continue from the brief ${slug}, ${steps}. The new session resumes from ${found.path}; if no banner names ${slug}, resume with the session-continue skill and the slug ${slug}.`,
    ],
    err: [],
  };
}

function refuse(reason) {
  return { exitCode: 1, out: [], err: [`aidrian handoff continue: ${reason}`] };
}
