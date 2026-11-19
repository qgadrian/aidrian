// The per-start proof that a confined session's sandbox is in force, run from inside that session
// (docs/providers/claude-code.md#the-sandbox-proof). A beacon proves only that the plugin's hooks run; a host that drops
// an invalid sandbox setting silently would start a session whose shell writes and reaches anything. So, for a host
// that declares `capabilities.projectStart.confineProof`, each start runs four parts:
//   - prepareConfine, the start gate, before the launch: a localhost listener outside the sandbox (startListener), and
//     CONFINE_PLAN in the attempt's folder, which no confined session writes: what to probe, the listener's port, a host
//     outside every allowed domain, and a nonce that names every probe path.
//   - confineDenial, the agent gate hook, on every call of that session: until the start confirms the proof in the
//     session's own mark, only the exact `aidrian project confine <run> <issue>` runs; once the proof failed, nothing does.
//     The hook also checks that the cache variables of the session's shell are absent from its own environment, the
//     host process's, since only the session's sandboxed commands may get them.
//   - runConfine, `aidrian project confine`, inside the sandbox: tries each probe, and writes the verdict,
//     CONFINE_VERDICT, in the drop folder. Any probe that succeeds fails the proof.
//   - confineCheck, the start, outside the sandbox: reads the verdict, the listener's hits, and the leftovers of every
//     probe path, before it holds the session.
// The probes: create a file in each unattended mark folder, the attempt's folder, and the home folder; open the clone's
// git config and its `.claude/settings.json` for writing; remove the keep file of `cache` and `drop`; move each away,
// put a link in its place, and write through it; read each credential store and the main checkout; connect to a host
// outside every allowed domain, directly and through the sandbox's proxy; and connect to the listener. And the cache
// variables (project-registries.mjs cacheVars) must be in force in the shell, each with the value the gate wrote.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import net from 'node:net';
import path from 'node:path';

import { ATTEMPT_KEEP, attemptOf, KEPT_FOLDERS } from './attempt-clone.mjs';
import { bashCall } from './config-guard.mjs';
import { pauseSync } from './fs.mjs';
import { sessionIdentity } from './hosts/index.mjs';
import { REGISTRY_NAMES, registryHosts } from './project-registries.mjs';
import { CONFINE_STATES, markFolders } from './unattended-mark.mjs';

// The plan the gate writes in the attempt's folder, and the verdict the proof writes in the drop folder.
export const CONFINE_PLAN = 'confine-plan.json';
export const CONFINE_VERDICT = 'confine.json';
// The shell environment the gate writes in the attempt's folder: project-start.mjs's SHELL_VARS, which imports modules
// this one must not load in a hook's first steps; test/project-confine.test.mjs holds the two equal.
export const SHELL_VARS = 'shell-env.json';
// The listener's port file and the file it notes each connection in, both in the attempt's folder.
const LISTENER_FILE = 'confine-listener.json';
const HITS_FILE = 'confine-hits';
// How long the listener lives at most, should the start that runs it die, and how long the start waits for its port.
export const LISTENER_LIFE = 15 * 60 * 1000;
const LISTENER_START = 5000;
// How long a network probe waits for an answer; one with none counts as refused.
const NET_TIMEOUT = 3000;
// The most credential stores read, besides the main checkout.
const READ_CAP = 16;
const FILE_CAP = 64 * 1024;
const NONCE = /^[0-9a-f]{16}$/u;
// The hosts a probe may name as outside every allowed domain: each reserved for examples (RFC 2606), none a forge's or a
// registry's.
const UNLISTED = Object.freeze(['example.com', 'example.net', 'example.org']);
const PROXY_VARS = Object.freeze(['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']);
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

// The listener, run by `node -e` outside the sandbox: it notes each connection in the hits file, then closes it.
const LISTENER = [
  "const net = require('node:net'); const fs = require('node:fs');",
  'const [hits, portFile, life] = process.argv.slice(1);',
  "const server = net.createServer((socket) => { try { fs.appendFileSync(hits, 'hit\\n'); } catch {} socket.destroy(); });",
  "server.listen(0, '127.0.0.1', () => fs.writeFileSync(portFile, JSON.stringify({ port: server.address().port, pid: process.pid })));",
  'setTimeout(() => process.exit(0), Number(life));',
].join('\n');

const real = (file) => {
  try {
    return realpathSync(file);
  } catch {
    return null;
  }
};
const within = (folder, file) => file === folder || file.startsWith(`${folder}${path.sep}`);
const exists = (file) => {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    return error.code !== 'ENOENT' && error.code !== 'ENOTDIR';
  }
};

// The JSON object in the regular file `file`, of one link and at most FILE_CAP bytes, read without following a link, or
// null.
export function readSmallJson(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | NO_FOLLOW | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > FILE_CAP) return null;
    const buffer = Buffer.alloc(stat.size);
    const value = JSON.parse(buffer.subarray(0, readSync(fd, buffer, 0, stat.size, 0)).toString('utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Writes `value` as JSON to `file` through a temporary file beside it: null, or why it could not.
function writeJson(file, value) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
    return null;
  } catch (error) {
    rmSync(temporary, { force: true });
    return `${file} cannot be written (${error.code ?? 'no code'})`;
  }
}

// Whether the allowed domain `pattern`, a host or `*.` and a host, covers `host`.
const covers = (pattern, host) => (pattern.startsWith('*.') ? host === pattern.slice(2) || host.endsWith(pattern.slice(1)) : pattern === host);

// A host outside every one of `domains`, the session's allowed domains, and every registry's host, whatever the team
// lists, or null when none is.
export function unlistedHost(domains) {
  const listed = [...(Array.isArray(domains) ? domains : []), ...registryHosts(REGISTRY_NAMES)].map((each) => String(each).toLowerCase());
  return UNLISTED.find((host) => !listed.some((pattern) => covers(pattern, host))) ?? null;
}

// The paths of each probe of the plan `plan`, which the proof tries and the start checks are gone after it.
export function probePaths(plan) {
  const name = `confine-probe-${plan.nonce}`;
  return {
    // A file made where no write may land: each mark folder (a dot keeps it apart from a mark), the attempt's folder,
    // which holds the plan and the shell environment, and the home folder.
    creates: [...plan.marks.map((dir) => path.join(dir, `.${name}`)), path.join(plan.folder, name), path.join(plan.home, name)],
    // Files the session may not change, opened for writing, with nothing written.
    opens: [path.join(plan.git, 'config'), path.join(plan.work, '.claude', 'settings.json')],
    // The keep files, whose removal would let `cache` or `drop` be emptied and removed.
    keeps: KEPT_FOLDERS.map((each) => path.join(plan.folder, each, ATTEMPT_KEEP)),
    // Each kept folder moved away, a link put in its place, or, where the move is refused, beside it.
    moves: KEPT_FOLDERS.map((each) => ({ from: path.join(plan.folder, each), to: path.join(plan.folder, `${each}-moved-${plan.nonce}`), link: path.join(plan.folder, `${each}-link-${plan.nonce}`) })),
    name,
  };
}

// Starts the localhost listener outside the sandbox, its files in the attempt's folder `folder`: { port, stop, hits }, or
// { problem }. It ends itself after `life`, should the start that runs it die. `pause` is a test's.
export function startListener(folder, { life = LISTENER_LIFE, pause = pauseSync } = {}) {
  const portFile = path.join(folder, LISTENER_FILE);
  const hits = path.join(folder, HITS_FILE);
  let child;
  try {
    child = spawn(process.execPath, ['-e', LISTENER, hits, portFile, String(life)], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch (error) {
    return { problem: `the localhost listener of the sandbox proof could not be started (${error.code ?? 'no code'})` };
  }
  const stop = () => {
    try {
      process.kill(child.pid);
    } catch {
      // Gone already.
    }
  };
  for (let waited = 0; waited <= LISTENER_START; waited += 50) {
    const read = readSmallJson(portFile);
    if (Number.isInteger(read?.port) && read.port > 0 && read.pid === child.pid) return { port: read.port, stop, hits };
    pause(50);
  }
  stop();
  return { problem: 'the localhost listener of the sandbox proof did not start within 5 seconds' };
}

// Makes the proof's plan for an attempt before its launch: starts the listener and writes CONFINE_PLAN in the attempt's
// folder `folder`, whose clone is `work`, git folder `git`, and drop and cache folders `drop` and `cache`, for issue
// `key` attempt `attempt` of run `run`. `domains` are the session's allowed domains, `reads` the credential stores the
// host's sandbox denies reading (capabilities.projectStart.confineReads), `main` the main checkout, and `env` and `home`
// the environment and home folder the mark folders are named under. { plan, listener } or { problem }, with the
// listener stopped.
export function prepareConfine({ folder, run, key, attempt, work, git, drop, cache, domains, reads = [], main = null, env = process.env, home, listen = startListener }) {
  const unlisted = unlistedHost(domains);
  if (!unlisted) return { problem: 'every host the sandbox proof could name as unlisted is an allowed domain' };
  const marks = markFolders({ env, home }).filter((dir) => {
    try {
      return lstatSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
  if (!marks.length) return { problem: 'no unattended mark folder exists for the sandbox proof to probe' };
  const stores = [...new Set([...(main ? [main] : []), ...(Array.isArray(reads) ? reads : []).filter((each) => typeof each === 'string' && path.isAbsolute(each) && exists(each)).slice(0, READ_CAP)])];
  const listener = listen(folder);
  if (listener.problem) return { problem: listener.problem };
  const plan = {
    version: 1, run, key, attempt, nonce: randomBytes(8).toString('hex'), folder, work, git, drop, cache, marks,
    home: home ?? homedir(), reads: stores, unlisted: { host: unlisted, port: 443 }, local: { host: '127.0.0.1', port: listener.port },
  };
  const written = writeJson(path.join(folder, CONFINE_PLAN), plan);
  if (written) {
    listener.stop();
    return { problem: `the sandbox proof's plan: ${written}` };
  }
  return { plan, listener };
}

// The outcome of a file system probe that threw `error`: `absent` when its target is not there, else `refused`.
const refusal = (error) => (error.code === 'ENOENT' ? 'absent' : 'refused');

function createProbe(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, 0o600);
  } catch (error) {
    return error.code === 'EEXIST' ? 'refused' : refusal(error);
  }
  closeSync(fd);
  rmSync(file, { force: true });
  return 'succeeded';
}

function openProbe(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | NO_FOLLOW);
  } catch (error) {
    return refusal(error);
  }
  closeSync(fd);
  return 'succeeded';
}

function keepProbe(file) {
  try {
    unlinkSync(file);
  } catch (error) {
    return refusal(error);
  }
  try {
    writeFileSync(file, '', { flag: 'wx', mode: 0o400 });
  } catch {
    // The proof fails anyway.
  }
  return 'succeeded';
}

// A move of `from` to `to`, then a link to `target` in its place, and a write through it, each undone when it
// succeeded; where the move is refused, a link at `link`, beside it. The outcomes, by name.
function moveProbe({ from, to, link }, target, name) {
  const outcomes = {};
  try {
    renameSync(from, to);
    outcomes.move = 'succeeded';
  } catch (error) {
    outcomes.move = refusal(error);
  }
  const place = outcomes.move === 'succeeded' ? from : link;
  try {
    symlinkSync(target, place);
    outcomes.link = 'succeeded';
    try {
      writeFileSync(path.join(place, name), '', { flag: 'wx', mode: 0o600 });
      outcomes.through = 'succeeded';
      rmSync(path.join(place, name), { force: true });
    } catch (error) {
      outcomes.through = refusal(error);
    }
    unlinkSync(place);
  } catch (error) {
    outcomes.link = refusal(error);
  }
  if (outcomes.move === 'succeeded') {
    try {
      renameSync(to, from);
    } catch {
      // The proof fails anyway.
    }
  }
  return outcomes;
}

function readProbe(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    if (fstatSync(fd).isDirectory()) readdirSync(file);
    else readSync(fd, Buffer.alloc(1), 0, 1, 0);
    return 'succeeded';
  } catch (error) {
    return refusal(error);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// A connection to `host`:`port`: `succeeded` once it connects, else `refused`, also when no answer comes in time.
function connectProbe(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (outcome) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(() => done('refused'), NET_TIMEOUT);
    socket.once('connect', () => done('succeeded'));
    socket.once('error', () => done('refused'));
  });
}

// A CONNECT to `host`:`port` through the HTTP proxy at `proxy`: `succeeded` when the proxy answers 2xx, else `refused`.
function proxyProbe(proxy, host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: proxy.hostname.replace(/^\[|\]$/gu, ''), port: Number(proxy.port || 80) });
    let answer = '';
    const done = (outcome) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(() => done('refused'), NET_TIMEOUT);
    socket.once('connect', () => socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`));
    socket.on('data', (chunk) => {
      answer += chunk.toString('latin1');
      if (answer.includes('\r\n')) done(/^HTTP\/\d(?:\.\d)? 2\d\d\b/u.test(answer) ? 'succeeded' : 'refused');
    });
    socket.once('error', () => done('refused'));
    socket.once('end', () => done('refused'));
  });
}

// The HTTP proxies `env` names, once each.
function proxies(env) {
  const seen = new Map();
  for (const name of PROXY_VARS) {
    try {
      const url = new URL(env[name]);
      if (url.protocol === 'http:' && !seen.has(url.host)) seen.set(url.host, url);
    } catch {
      // Not set, or not a URL.
    }
  }
  return [...seen.values()];
}

// Every probe of `plan`, from the session's sandboxed shell, whose environment is `env`: [{ probe, target, outcome }].
export async function probeAll(plan, env) {
  const paths = probePaths(plan);
  const results = [];
  const note = (probe, target, outcome) => results.push({ probe, target, outcome });
  for (const file of paths.creates) note('write', file, createProbe(file));
  for (const file of paths.opens) note('write', file, openProbe(file));
  for (const file of paths.keeps) note('remove', file, keepProbe(file));
  for (const each of paths.moves) {
    const outcomes = moveProbe(each, plan.home, paths.name);
    note('move', each.from, outcomes.move);
    note('link', outcomes.move === 'succeeded' ? each.from : each.link, outcomes.link);
    if (outcomes.through) note('write through a link', outcomes.move === 'succeeded' ? each.from : each.link, outcomes.through);
  }
  for (const file of plan.reads) note('read', file, readProbe(file));
  const network = [
    connectProbe(plan.unlisted.host, plan.unlisted.port).then((outcome) => note('reach', `${plan.unlisted.host}:${plan.unlisted.port}`, outcome)),
    connectProbe(plan.local.host, plan.local.port).then((outcome) => note('reach', `${plan.local.host}:${plan.local.port}, a localhost listener outside the sandbox`, outcome)),
    ...proxies(env).map((proxy) => proxyProbe(proxy, plan.unlisted.host, plan.unlisted.port).then((outcome) => note('reach', `${plan.unlisted.host}:${plan.unlisted.port} through the proxy ${proxy.host}`, outcome))),
  ];
  await Promise.all(network);
  return results;
}

// Why the cache variables the gate wrote for the attempt in `folder` are not in force in the shell environment `env`,
// or null: the file cannot be read, or a variable is missing or has another value.
export function shellVarsProblem(folder, env) {
  const expected = readSmallJson(path.join(folder, SHELL_VARS));
  if (!expected) return `the shell environment the start wrote, ${path.join(folder, SHELL_VARS)}, cannot be read`;
  const off = Object.entries(expected).filter(([name, value]) => env[name] !== value).map(([name]) => name);
  return off.length ? `the cache variables ${off.join(', ')} are not in force in the session's shell` : null;
}

// Why the cache variables of the attempt in `folder` reach `env`, the host process's environment as a hook gets it, or
// null: a variable whose value names the attempt's cache folder, which only the session's sandboxed commands may get.
export function hostVarsProblem(folder, env) {
  const expected = readSmallJson(path.join(folder, SHELL_VARS));
  if (!expected) return null;
  const cache = path.join(folder, 'cache');
  const leaked = Object.entries(expected).filter(([name, value]) => typeof value === 'string' && value.includes(cache) && env[name] === value).map(([name]) => name);
  return leaked.length ? `the host process's own environment holds the cache variables ${leaked.join(', ')}, which only the session's sandboxed commands may get` : null;
}

// `aidrian project confine RUN ISSUE`, from the session's sandboxed shell in its clone `cwd`, with `env` its
// environment: every probe, then the verdict in the drop folder. { exitCode, out, err }: 0 when every probe was refused
// and the cache variables are in force, else 1, with each probe that succeeded.
export async function runConfine({ run, key, cwd = process.cwd(), env = process.env }) {
  const refuse = (why) => ({ exitCode: 1, out: [], err: [`aidrian project confine: ${why}`] });
  const attempt = attemptOf(cwd);
  if (!attempt || attempt.run !== run || attempt.key !== key) return refuse(`this folder is not a clone of the run ${run}'s issue ${key}; run it in the clone the session started in`);
  const plan = readSmallJson(path.join(attempt.folder, CONFINE_PLAN));
  if (!plan || plan.run !== run || plan.key !== key || plan.attempt !== attempt.attempt || !NONCE.test(plan.nonce ?? '')) return refuse(`the start wrote no plan for the sandbox proof of ${key} attempt ${attempt.attempt}`);
  const results = await probeAll({ ...plan, folder: attempt.folder }, env);
  const failed = results.filter((each) => each.outcome === 'succeeded').map((each) => `${each.probe} ${each.target}`);
  const absent = results.filter((each) => each.outcome === 'absent' && each.probe !== 'read').map((each) => `${each.probe} ${each.target}, which is not there`);
  const vars = shellVarsProblem(attempt.folder, env);
  const problems = [...failed, ...absent, ...(vars ? [vars] : [])];
  const verdict = {
    version: 1, run, key, attempt: attempt.attempt, nonce: plan.nonce, session: sessionIdentity(env).session ?? null,
    pass: problems.length === 0, failed: problems.slice(0, 50), probes: results.length, at: new Date().toISOString(),
  };
  const written = writeJson(path.join(attempt.drop, CONFINE_VERDICT), verdict);
  if (written) return { exitCode: 1, out: [], err: [`aidrian project confine: the verdict could not be handed over: ${written}`] };
  if (verdict.pass) return { exitCode: 0, out: [`confined ${run} ${key}: the sandbox refused all ${results.length} probes, and the cache variables are in force`], err: [] };
  return { exitCode: 1, out: [`halt the sandbox does not hold for this session: ${problems.join('; ')}`], err: ['aidrian project confine: the start stops this session and halts the run; nothing more runs here'] };
}

// The proof of the start of the attempt in `folder`, as the start reads it outside the sandbox for `session`, the
// session it started: null while no verdict is there; { pass: true }; or { pass: false, problem }. A pass needs the
// verdict of this plan, naming no other session, every probe refused, no connection to the listener, no probe path
// left, and `cache` and `drop` plain folders with their keep files.
export function confineCheck({ folder, session }) {
  const plan = readSmallJson(path.join(folder, CONFINE_PLAN));
  if (!plan || !NONCE.test(plan.nonce ?? '')) return { pass: false, problem: `the sandbox proof's plan in ${folder} cannot be read` };
  const verdict = readSmallJson(path.join(folder, 'drop', CONFINE_VERDICT));
  if (!verdict) return null;
  const listed = (each) => (Array.isArray(each) ? each.filter((one) => typeof one === 'string').slice(0, 10).join('; ') : '');
  if (verdict.pass !== true) return { pass: false, problem: listed(verdict.failed) || 'the proof failed' };
  if (verdict.nonce !== plan.nonce || verdict.run !== plan.run || verdict.key !== plan.key || verdict.attempt !== plan.attempt) return { pass: false, problem: 'the verdict in the drop folder is not this start\'s' };
  if (verdict.session !== null && verdict.session !== undefined && verdict.session !== session) return { pass: false, problem: `the verdict names the session ${String(verdict.session).slice(0, 64)}, not ${session}` };
  try {
    if (lstatSync(path.join(folder, HITS_FILE)).size > 0) return { pass: false, problem: 'a connection reached the localhost listener outside the sandbox' };
  } catch {
    // No hit.
  }
  const paths = probePaths({ ...plan, folder });
  const left = [...paths.creates, ...paths.moves.flatMap((each) => [each.to, each.link])].find(exists);
  if (left) return { pass: false, problem: `a probe left ${left}, so a write the sandbox should refuse landed` };
  for (const name of KEPT_FOLDERS) {
    let stat;
    try {
      stat = lstatSync(path.join(folder, name));
    } catch {
      stat = null;
    }
    if (!stat?.isDirectory() || !exists(path.join(folder, name, ATTEMPT_KEEP))) return { pass: false, problem: `the attempt's ${name} folder or its keep file is no longer as the start made it` };
  }
  return { pass: true };
}

// What holds the session of `input`, by its unattended mark `mark`, to its sandbox proof: { attempt, state } with
// `state` the mark's confine state (true while owed), or null when no proof holds it. A pending mark holds a session
// whose call runs in the clone it starts, when the start wrote a plan there; a mark with no confine state holds one whose
// clone's attempt has a plan.
function proofHold(input, mark) {
  if (!mark || typeof mark !== 'object') return null;
  if (mark.pending) {
    const clone = typeof mark.cwd === 'string' ? real(mark.cwd) : null;
    const at = typeof input.cwd === 'string' ? real(input.cwd) : null;
    if (!clone || !at || !within(clone, at)) return null;
    const attempt = attemptOf(clone);
    return attempt && attempt.work === clone && exists(path.join(attempt.folder, CONFINE_PLAN)) ? { attempt, state: true } : null;
  }
  const attempt = typeof mark.cwd === 'string' ? attemptOf(mark.cwd) : null;
  if (mark.confine !== undefined) return { attempt, state: CONFINE_STATES.includes(mark.confine) ? mark.confine : 'failed' };
  if (!mark.issue || !attempt) return null;
  return exists(path.join(attempt.folder, CONFINE_PLAN)) ? { attempt, state: true } : null;
}

// The program words `aidrian project confine` may run under: `aidrian` on PATH, or this plugin's own command by its path.
const BIN = path.resolve(import.meta.dirname, '../bin/aidrian');
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

// Whether the call in `input` is exactly `aidrian project confine <run> <issue>` for `attempt`, alone.
export function isConfineCall(input, attempt) {
  if (!bashCall(input) || typeof input.tool_input?.command !== 'string') return false;
  const program = `(?:aidrian|${escaped(BIN)}|'${escaped(BIN)}')`;
  return new RegExp(`^\\s*${program}\\s+project\\s+confine\\s+${escaped(attempt.run)}\\s+${escaped(attempt.key)}\\s*$`, 'u').test(input.tool_input.command);
}

// Why the agent gate hook refuses the call in `input`, for the session whose unattended mark is `mark`, as { match,
// reason }, or null. While the session's sandbox proof is owed, only the exact confine command runs, and only while the
// host process's environment, `env`, the hook's own, holds none of the session's cache variables: one that does fails
// the proof, in a verdict the hook writes. Once the proof failed, nothing runs. Once it passed but the start has not
// confirmed it in the mark yet, the call waits. A proof that holds the session but cannot be read refuses the call.
export function confineDenial(input, { mark, env = process.env } = {}) {
  let held;
  try {
    held = proofHold(input, mark);
  } catch {
    held = mark?.confine !== undefined ? { attempt: null, state: true } : null;
  }
  if (!held || held.state === 'passed') return null;
  const deny = (match, why) => ({ match, reason: `aidrian: this call is blocked: ${why}.` });
  const command = (attempt) => `\`aidrian project confine ${attempt.run} ${attempt.key}\``;
  const stopped = 'the start stops it and halts the run, and the agent gate hook refuses every later call of this session; nothing more runs here';
  const failed = `its sandbox proof failed, so ${stopped}`;
  if (held.state === 'failed') return deny('sandbox proof failed', `this session no Human attends ${failed}`);
  if (!held.attempt) return deny('sandbox proof owed', 'this session no Human attends must prove its sandbox first, and the hook cannot find the attempt it works');
  try {
    const verdict = readSmallJson(path.join(held.attempt.drop, CONFINE_VERDICT));
    if (verdict && verdict.pass !== true) return deny('sandbox proof failed', `this session no Human attends ${failed}`);
    if (isConfineCall(input, held.attempt)) {
      const leaked = hostVarsProblem(held.attempt.folder, env);
      if (!leaked) return null;
      const plan = readSmallJson(path.join(held.attempt.folder, CONFINE_PLAN));
      writeJson(path.join(held.attempt.drop, CONFINE_VERDICT), {
        version: 1, run: held.attempt.run, key: held.attempt.key, attempt: held.attempt.attempt, nonce: plan?.nonce ?? null,
        session: typeof input.session_id === 'string' ? input.session_id : null, pass: false, failed: [leaked], by: 'hook', at: new Date().toISOString(),
      });
      return deny('sandbox proof failed', `${leaked}, so this session's sandbox proof failed: ${stopped}`);
    }
    if (verdict?.pass === true) return deny('sandbox proof unconfirmed', `the sandbox proof of this session passed, and the start that runs it confirms it within seconds; run this call again in a few seconds`);
    return deny('sandbox proof owed', `this session no Human attends runs nothing before it proves its sandbox: its first call must be exactly ${command(held.attempt)}, alone, with the Bash tool, run in its clone`);
  } catch {
    return deny('sandbox proof owed', 'this session no Human attends must prove its sandbox first, and its proof cannot be read');
  }
}
