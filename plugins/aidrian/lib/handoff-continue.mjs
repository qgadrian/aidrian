// `aidrian handoff continue BRIEF [--route ROUTE]`: the gate between a checked handoff brief and a continuation that
// resumes from it with nothing typed but what the route asks (docs/handoff.md#continue). It arms only a brief that is
// right inside `<state>/handoffs/`, passed `aidrian handoff check` with these exact bytes, was written in the last
// BRIEF_WINDOW, and is below `session.handoff.maxChain` continuations in a row. Exits:
//   2  usage, a config with errors, an unknown --route, or a brief the store does not hold;
//   0  `continue: none`, with one `fallback:` line when a route was asked for and cannot run here, such as for a brief
//      whose path holds a control character, which that line does not print;
//   1  a refusal the session can fix, on stderr: no passing check of these bytes, a brief too old to arm, or a Chain
//      below the floor this session was given when a continuation started it;
//   0  `continue: <route>` and a `say:` line, once the marker is armed, or, on the background route, once the new
//      session started; a background session that did not start gives `continue: none` and its `fallback:` line.
// The latest run decides: once the brief resolves and the session id is known, any marker the session armed before
// goes, whatever the exit, so a clear never delivers an earlier brief. A disk that refuses the store's write exits 2.
// The background route arms no marker: the gate starts the new session itself, through the host adapter's
// `startBackground` and the injectable `run`, and records its chain floor (startInBackground).
// The main session alone runs it: the agent-gates hook refuses it to a subagent, whose shell carries the main session's
// id (lib/handoff-guard.mjs handoffContinueDenial). The route a host can do, and what it asks of the Human, are the host
// adapter's `capabilities.handoffContinue`; this file names no host. `aidrian handoff route` (routeOf) prints the route
// the gate would take here, for the skill's first step, and writes nothing.
// The hooks' side of the clear route is at the end: a prompt cancels an armed marker (cancelOnPrompt), the session end
// promotes it (promoteCleared), and the session start the clear begins takes it and delivers it (takeCleared,
// deliverCleared, continuationContext). The hooks load this file only on a host that lists a route.

import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { commandConfig } from './config.mjs';
import { CONTINUE_ROUTES } from './config-schema.mjs';
import { arm, cancelArmed, checkedSha, clearPending, fresh, hasControl, noteFrom, openStore, promote, readContainedBrief, readFrom, SESSION_ID, SLUG, slugOf, sweep, takeReady } from './handoff-markers.mjs';
import { foldCase, resolvedPath } from './fs.mjs';
import { worktreePaths } from './git.mjs';
import { worktreeOf } from './handoff-sections.mjs';
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
const routeProblem = (override) => (override !== undefined && !CONTINUE_ROUTES.includes(override)
  ? { exitCode: 2, out: [], err: [`--route must be ${CONTINUE_ROUTES.map((each) => `"${each}"`).join(', ')}`] }
  : null);

// `aidrian handoff route [--route ROUTE]`: the route a handoff from `cwd` would go on by on this host, as effectiveRoute
// decides, so the session-handoff skill knows before it writes the brief whether to settle every running agent.
// It prints `route: <route>`, `none` on a fallback, and the `fallback:` line then, exit 0; exit 2 on an unknown --route
// or a config with errors (CONFIG_ERROR). It opens no store and writes nothing. The gate may still fall back for what
// only a brief or the store tells, such as its chain or a store it refuses.
export function routeOf({ override, env = process.env, cwd = process.cwd() } = {}) {
  const bad = routeProblem(override);
  if (bad) return bad;
  const config = commandConfig(projectAt(cwd), { exitCode: 2 });
  const { route, fallback } = effectiveRoute(config.session.handoff.continue, detectHost({ env }), override);
  return { exitCode: 0, out: [`route: ${route}`, ...(fallback ? [`fallback: ${fallback}`] : [])], err: [] };
}

// Runs the gate on `brief`, a path from `cwd`, and returns { exitCode, out, err }: the lines for stdout and stderr.
// `chainOf` reads a brief's chain count (lib/handoff-brief.mjs). Throws config.mjs's CONFIG_ERROR, exit 2, on a config
// with errors. `run`, spawnSync's shape, is what the background route starts commands with: the host's own when omitted,
// and a test's stand-in, so no test starts a real session.
export function continueBrief(brief, { override, chainOf, env = process.env, cwd = process.cwd(), now = Date.now(), run }) {
  const bad = routeProblem(override);
  if (bad) return bad;
  const project = projectAt(cwd);
  const config = commandConfig(project, { exitCode: 2 });
  const { continue: configured, maxChain } = config.session.handoff;
  const store = openStore(stateDir(project, { config, env }), { checkouts: project.checkouts, maxChain });
  const given = path.resolve(cwd, brief);
  const found = readContainedBrief(store, given);
  if (found.problem) return { exitCode: 2, out: [], err: [`${given} ${found.problem}`] };

  const session = sessionIdentity(env).session;
  const known = typeof session === 'string' && SESSION_ID.test(session);
  try {
    if (known) cancelArmed(store, session, { now });
    return decide({ found, store, session: known ? session : null, override, configured, maxChain, chainOf, env, now, root: project.root, run });
  } catch (error) {
    if (typeof error?.code !== 'string') throw error;
    return { exitCode: 2, out: [], err: [`could not arm the continuation of ${found.path} (${error.code})`] };
  }
}

// The gate's steps 2 to 5 on a brief that resolved, once any earlier marker of `session` is gone.
function decide({ found, store, session, override, configured, maxChain, chainOf, env, now, root, run }) {
  const host = detectHost({ env });
  const { route, fallback } = effectiveRoute(configured, host, override);
  if (route === 'none') return none(fallback);
  // First: every later line may print the path, and the delivery refuses such a brief anyway.
  if (hasControl(store.handoffs) || hasControl(found.path)) {
    return none('the path of the handoffs folder or the brief holds a control character, so no continuation is armed from it; a person resumes the brief');
  }
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
  // A continued session's floor holds for every brief it writes, whatever its slug: a handoff under another name is
  // still the same run of continuations.
  const floor = readFrom(store, session, { now });
  if (floor && chain < floor.chain) {
    return refuse(`the brief's Chain is below this session's floor ${floor.chain}, which a continuation from the brief ${floor.slug} gave it; set Chain: ${floor.chain} in ${found.path}, check it, and run this again`);
  }
  const mtime = Math.floor(found.mtimeMs);
  if (!fresh(mtime, now, BRIEF_WINDOW)) {
    const when = mtime > now ? 'is dated in the future' : `was last written ${Math.round((now - mtime) / 60000)} minutes ago`;
    return refuse(`${found.path} ${when}, and the gate arms only a brief written in the last ${BRIEF_WINDOW / 60000} minutes: refresh the brief, check it, and run this again`);
  }

  sweep(store, now);
  if (route === 'background') return startInBackground({ host, found, slug, chain, store, session, env, now, root, run });
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

// The background route, once the brief passed every check: the host starts a new session in the brief's worktree,
// whose first message is backgroundPrompt, and the gate records that session's chain floor, as the delivery of a clear
// does. A session that did not start gives `continue: none` and its fallback line. The floor needs the new session's
// id, which the host reads back after the start; when it cannot, the prompt still names the count for the next brief.
function startInBackground({ host, found, slug, chain, store, session, env, now, root, run }) {
  const cwd = briefWorktree(found.bytes.toString('utf8'), root);
  const marker = { brief: found.path, slug, chain };
  const prompt = backgroundPrompt({ marker, maxChain: store.maxChain });
  let started;
  try {
    started = host.capabilities.handoffContinue.startBackground({ cwd, session, slug, env, prompt, run });
  } catch (error) {
    started = { problem: `the host's start failed (${error?.code ?? error?.message ?? 'no message'})` };
  }
  if (started.problem) return none(`no background session started, since ${started.problem}; a person resumes the brief`);
  if (typeof started.session === 'string' && SESSION_ID.test(started.session)) {
    try {
      noteFrom(store, started.session, { slug, chain: chain + 1, brief: found.path, route: 'background' }, { now });
    } catch {
      // No floor: the prompt still names the count for the next brief.
    }
  }
  const label = started.id ? `${started.name} (${started.id})` : started.name;
  return {
    exitCode: 0,
    out: [
      'continue: background',
      `say: The brief ${slug} continues in the new background session ${label}, started in ${cwd}, with nothing to type: ${started.look}. It resumes from ${found.path}; this session stops here.`,
    ],
    err: [],
  };
}

// The folder the background session starts in: the brief's `Worktree:` when git lists it as a worktree of the repository
// at `root` and its folder is there, compared by real path in the case the disk folds to, else `root`. A value with a
// control character is never taken, since the say line prints it.
function briefWorktree(text, root) {
  const named = worktreeOf(text);
  const real = named && path.isAbsolute(named) && !hasControl(named) ? resolvedPath(named) : null;
  if (!real || !statSync(real, { throwIfNoEntry: false })?.isDirectory()) return root;
  const listed = worktreePaths(root).map((each) => resolvedPath(each)).filter(Boolean);
  return listed.some((each) => foldCase(each) === foldCase(real)) ? real : root;
}

const none = (why) => ({ exitCode: 0, out: ['continue: none', ...(why ? [`fallback: ${why}`] : [])], err: [] });

function refuse(reason) {
  return { exitCode: 1, out: [], err: [`aidrian handoff continue: ${reason}`] };
}

// The continuation store of `project`, whose config is `config`, as a hook opens it.
export function projectStore(project, config, env = process.env) {
  return openStore(stateDir(project, { config, env }), { checkouts: project.checkouts, maxChain: config.session.handoff.maxChain });
}

// The id of the host process a hook of `host` runs under, the same before and after a clear, or null.
export const hookHostPid = (host) => host.capabilities.handoffContinue?.hookHostPid?.() ?? null;

// UserPromptSubmit in the main session: a prompt cancels the `clear` continuation its session armed, so a marker stays
// armed exactly until the session goes on, unless the host's `keepsArmed` says the prompt is its own clear or compact
// command. Returns the line that says so, or null.
export function cancelOnPrompt(store, host, { session, prompt }) {
  if (host.capabilities.handoffContinue?.keepsArmed?.(prompt) === true) return null;
  const marker = cancelArmed(store, session, { route: 'clear' });
  return marker && `Handoff: the continuation from the brief ${marker.slug} was cancelled, since this session went on; ` +
    'the session-handoff skill arms a new one when the session hands off again.';
}

// SessionEnd by a clear: the ending session's armed `clear` marker becomes ready for the session the clear starts.
export const promoteCleared = (store, host, session) => promote(store, session, { hostPid: hookHostPid(host) });

// How long the session start looks for a ready marker while a `clear` one is still armed, and how often.
export const CLEAR_WAIT = 600;
export const CLEAR_STEP = 100;

// SessionStart after a clear: the ready marker of the host process `hostPid`, claimed, or null. While any session of
// the store has a `clear` marker armed, the session end that would promote it may not have run yet, so it looks again
// every CLEAR_STEP, at most CLEAR_WAIT / CLEAR_STEP times more: a count of looks, so a clock set back cannot stretch the
// wait past the host's timeout. With no armed or ready file at all it returns after one listing. Each look takes the
// time afresh for the store's windows, which are strict to the millisecond.
export async function takeCleared(store, hostPid) {
  if (store.refused || hostPid === null) return null;
  for (let look = 0; ; look += 1) {
    // Read before the take: a session end writes its ready marker before it deletes the armed one.
    const { listed, armed } = clearPending(store, { now: Date.now() });
    if (!listed) return null;
    const marker = takeReady(store, { hostPid, now: Date.now() });
    if (marker || !armed || look >= CLEAR_WAIT / CLEAR_STEP) return marker;
    await sleep(CLEAR_STEP);
  }
}

// What the session start prints for the claimed ready `marker`: { systemMessage, context }. The brief is held to the
// gate's checks again and hashed; when it is gone, fails one, has changed since it was armed, or its chain is at
// session.handoff.maxChain, `context` is null and the banner names the resume by hand. Otherwise the chain floor of
// `session`, the new one, is written, and `context` is the continuation. Nothing of either comes from the brief's text,
// and its path is the real one the check resolved, never the marker's own spelling, and is printed only when it holds
// no control character; otherwise the banner names the slug alone.
export function deliverCleared(store, marker, session, { now = Date.now() } = {}) {
  sweep(store, now);
  const found = readContainedBrief(store, marker.brief);
  // Checked first: every other problem names the folder, and a path is printed only when it is plain text.
  const problem = (hasControl(store.handoffs) || hasControl(found.path ?? '') ? 'lies in a folder whose path holds a control character' : null)
    ?? found.problem
    ?? (sha256(found.bytes) !== marker.sha256 ? 'changed since it was armed' : null)
    ?? (marker.chain + 1 > store.maxChain ? `has Chain ${marker.chain}, and session.handoff.maxChain allows ${store.maxChain} continuations in a row` : null);
  if (problem) {
    return { systemMessage: `The handoff brief ${marker.slug} ${problem}, so this session did not load it: resume with the session-continue skill and the slug ${marker.slug}.`, context: null };
  }
  try {
    noteFrom(store, session, { slug: marker.slug, chain: marker.chain + 1, brief: found.path, route: marker.route }, { now });
  } catch {
    // No floor: the context still names the count for the next brief.
  }
  return {
    systemMessage: `Continuing from the handoff brief ${marker.slug}, ${found.path}: send any message to resume.`,
    context: continuationContext({ marker: { ...marker, brief: found.path }, maxChain: store.maxChain, source: 'clear' }),
  };
}

// The lines a session start adds after the start lines when it delivers `marker`, from its validated values alone:
// which brief this session continues and as which continuation, what to do on the first message, and the chain the
// next brief carries. `source` is how the session started, such as `clear`.
export function continuationContext({ marker, maxChain, source }) {
  return continuationLines({ marker, maxChain, how: `loaded automatically after a ${source}`, when: 'On the first message, unless it asks for something else, follow' });
}

// The first message of a session the background route starts, in the same words as continuationContext, from the
// brief's validated path, slug, and chain alone: nothing of the brief's text.
export function backgroundPrompt({ marker, maxChain }) {
  return continuationLines({ marker, maxChain, how: 'started in the background by the session that wrote it', when: 'Now follow' });
}

function continuationLines({ marker, maxChain, how, when }) {
  const next = marker.chain + 1;
  return [
    `Handoff continuation: this session continues the work of the handoff brief ${marker.brief}, for ${marker.slug}, ${how}, as continuation ${next} of ${maxChain}.`,
    `${when} the session-continue skill's steps on this brief: ` +
      `read the brief at ${marker.brief} in full first, enter its worktree, read the state fresh, report surprises, and continue at Next steps.`,
    `A later brief for this work carries Chain: ${next}.`,
  ].join('\n');
}
