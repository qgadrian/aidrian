// The OpenCode bridge's route list: reading routes.generated.json, the hooks.json hooks `npm run build` writes as
// { event, matcher, script, args, timeoutMs }, and selecting the routes that run on a call. bridge.mjs runs what this
// selects. It imports node: built-ins alone, so it loads in OpenCode's Bun and under `node --test` alike.

import { readFileSync } from 'node:fs';

// A generated route the bridge can spawn as it is: a script's file name, literal --flag arguments, and a timeout a timer
// takes, as scripts/build.mjs writes them.
const usable = (route) => typeof route === 'object' && route !== null && typeof route.event === 'string'
  && typeof route.script === 'string' && /^[a-z0-9-]+\.mjs$/u.test(route.script)
  && Array.isArray(route.args) && route.args.every((arg) => typeof arg === 'string' && /^--[a-z][a-z0-9-]*$/u.test(arg))
  && Number.isInteger(route.timeoutMs) && route.timeoutMs >= 1 && route.timeoutMs <= 2 ** 31 - 1
  && (route.matcher === null || typeof route.matcher === 'string');

// The usable routes of the generated file `file`, in its order, or null when it cannot be read or holds no list. An
// entry the bridge cannot spawn as it is, such as one whose flag is no literal --flag, is left out.
export function readRoutes(file) {
  let routes;
  try {
    routes = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  return Array.isArray(routes) ? routes.filter(usable) : null;
}

// The routes of `routes` that run on the OpenCode tool hook `hook` for a call of the standard tool `name`: each whose
// event `events` maps to `hook` and whose matcher fires on `name`, "*" on every tool and a pattern when it matches
// anywhere in the name with the u flag, as Claude Code tests a hooks.json regular expression (a list of names comes
// anchored from scripts/build.mjs), in the list's order. A route with no matcher is of an event that names no tool, so it never fires on a
// tool hook, and neither does one whose pattern does not compile.
export function selectRoutes(routes, events, hook, name) {
  if (!Array.isArray(routes) || typeof name !== 'string') return [];
  return routes.filter((route) => typeof route?.event === 'string' && Object.hasOwn(events, route.event)
    && events[route.event] === hook && fires(route.matcher, name));
}

function fires(matcher, name) {
  if (matcher === '*') return true;
  if (typeof matcher !== 'string') return false;
  try {
    return new RegExp(matcher, 'u').test(name);
  } catch {
    return false;
  }
}
