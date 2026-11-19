// The per-start proof that a confined session's sandbox is in force, run from inside that session
// (docs/providers/claude-code.md#the-sandbox-proof). A beacon proves only that the plugin's hooks run; a host that drops
// an invalid sandbox setting silently would start a session whose shell writes and reaches anything. So, for a host
// that declares `capabilities.projectStart.confineProof`, each start runs four parts:
//   - prepareConfine, the start gate, before the launch: a localhost listener outside the sandbox (startListener), and
//     CONFINE_PLAN in the attempt's folder, which no confined session writes: what to probe, the listener's port and
//     process, a host outside every allowed domain, and a nonce that names every probe path. What each read target
//     holds, its fingerprint, stays in the start's memory, never in the plan.
//   - confineDenial (lib/confine-guard.mjs), the agent gate hook, on every call of that session: until the start
//     confirms the proof in the session's own mark, only the exact `aidrian project confine <run> <issue>` runs, once.
//   - runConfine, `aidrian project confine`, inside the sandbox: tries each probe, and writes the verdict,
//     CONFINE_VERDICT, in the drop folder. Any write, removal, move, link, or connection that succeeds fails the proof;
//     what each read saw goes to the verdict, salted, for the start to judge.
//   - confineCheck, the start, outside the sandbox: reads the verdict, judges each read against its fingerprints, and
//     checks the listener is the one it started, alive, with no connection, and that no probe left a path.
// The probes: create a file in each unattended mark folder, the attempt's folder, and the home folder; open the clone's
// git config and its `.claude/settings.json` for writing; remove the keep file of `cache` and `drop`; move each away,
// put a link in its place, and write through it; read each credential store and the main checkout; connect to a host
// outside every allowed domain, directly and through the sandbox's proxy; and connect to the listener. And the cache
// variables (project-registries.mjs cacheVars) must be in force in the shell, each with the value the gate wrote.
// A read the sandbox hides may still open: on Linux the host masks a denied folder with an empty one and a denied file
// with an empty one. So a read counts as landed only when what it saw matches what the start saw outside the sandbox: an
// entry of the folder the sandbox does not open again, or the first bytes of the file. Empty targets are not probed.

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import net from 'node:net';
import path from 'node:path';

import { ATTEMPT_KEEP, attemptOf, KEPT_FOLDERS } from './attempt-clone.mjs';
import { CONFINE_LOCK, CONFINE_PLAN, CONFINE_VERDICT, exists, SHELL_VARS, VERDICT_CAP, writeJson } from './confine-guard.mjs';
import { pauseSync, readSmallJson } from './fs.mjs';
import { sessionIdentity } from './hosts/index.mjs';
import { REGISTRY_NAMES, registryHosts } from './project-registries.mjs';
import { markFolders } from './unattended-mark.mjs';

export { CONFINE_LOCK, CONFINE_PLAN, CONFINE_VERDICT, SHELL_VARS };
export { confineDenial, hostVarsProblem, isConfineCall } from './confine-guard.mjs';
// The listener's port file and the file it notes each connection in, both in the attempt's folder.
const LISTENER_FILE = 'confine-listener.json';
const HITS_FILE = 'confine-hits';
// How long the listener lives at most, should the start that runs it die, and how long the start waits for its port.
export const LISTENER_LIFE = 15 * 60 * 1000;
export const LISTENER_START = 5000;
// How long a network probe waits for an answer; one with none counts as refused, while the listener is alive.
const NET_TIMEOUT = 3000;
// The most credential stores read, besides the main checkout; the first bytes of a file a read compares; the most entries
// of a folder a read reports.
const READ_CAP = 16;
const FIRST_BYTES = 512;
const SEEN_CAP = 500;
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

// What a read saw, salted with the plan's nonce, so the verdict names no entry and holds no byte of a store.
const salted = (nonce, bytes) => createHash('sha256').update(`${nonce}\0`).update(bytes).digest('hex');

// Whether the allowed domain `pattern`, a host, `*.` and a host, or `*`, covers `host`.
const covers = (pattern, host) => pattern === '*' || (pattern.startsWith('*.') ? host === pattern.slice(2) || host.endsWith(pattern.slice(1)) : pattern === host);

// A host outside every one of `domains`, the session's allowed domains and the user's and the organization's, and every
// registry's host, whatever the team lists, or null when none is.
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

// Starts the localhost listener outside the sandbox, its files in the attempt's folder `folder`: { port, pid, stop }, or
// { problem }. It ends itself after `life`, should the start that runs it die. `pause` and `run` (spawn's shape) are a
// test's.
export function startListener(folder, { life = LISTENER_LIFE, pause = pauseSync, run = spawn } = {}) {
  const portFile = path.join(folder, LISTENER_FILE);
  const hits = path.join(folder, HITS_FILE);
  let child;
  try {
    child = run(process.execPath, ['-e', LISTENER, hits, portFile, String(life)], { detached: true, stdio: 'ignore' });
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
    if (Number.isInteger(read?.port) && read.port > 0 && read.pid === child.pid) return { port: read.port, pid: child.pid, stop };
    pause(50);
  }
  stop();
  return { problem: `the localhost listener of the sandbox proof did not start within ${LISTENER_START / 1000} seconds` };
}

// What the start sees of the read target `file` outside the sandbox, with `reopened` the entries of a folder the sandbox
// opens again (the main checkout's git folder), for the nonce `nonce`: { target, print }, where `target` goes in the plan
// and `print`, its salted fingerprint, stays in the start's memory; or null for a target that is empty or cannot be read.
function fingerprint(file, nonce, reopened = []) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (stat.isDirectory()) {
      const entry = readdirSync(file).filter((name) => !reopened.includes(name)).sort()[0];
      return entry === undefined ? null : { target: { path: file, folder: true }, print: salted(nonce, entry) };
    }
    if (!stat.isFile() || stat.size === 0) return null;
    const bytes = Math.min(stat.size, FIRST_BYTES);
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return read === bytes ? { target: { path: file, bytes }, print: salted(nonce, buffer) } : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Makes the proof's plan for an attempt before its launch: starts the listener and writes CONFINE_PLAN in the attempt's
// folder `folder`, whose clone is `work`, git folder `git`, and drop and cache folders `drop` and `cache`, for issue
// `key` attempt `attempt` of run `run`. `domains` are the allowed domains, the session's and those the user's or the
// organization's settings add (capabilities.projectStart.confineDomains); `reads` the credential stores the host's
// sandbox denies reading (capabilities.projectStart.confineReads); `main` the main checkout and `mainGit` its git
// folder, which the sandbox opens again; `env` and `home` the environment and home folder the mark folders are named
// under. { plan, listener, prints } or { problem }, with the listener stopped; `prints` maps each read target to its
// fingerprint, for confineCheck.
export function prepareConfine({ folder, run, key, attempt, work, git, drop, cache, domains, reads = [], main = null, mainGit = null, env = process.env, home, listen = startListener }) {
  const unlisted = unlistedHost(domains);
  if (!unlisted) return { problem: `every host the proof names as unlisted (${UNLISTED.join(', ')}) is an allowed domain of the session, the user's settings, or the organization's, so no probe can show an unlisted host refused; remove "*" or the example domains from sandbox.network.allowedDomains` };
  const marks = markFolders({ env, home }).filter((dir) => {
    try {
      return lstatSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
  if (!marks.length) return { problem: 'no unattended mark folder exists for the sandbox proof to probe; start the run again, whose init files one' };
  const nonce = randomBytes(8).toString('hex');
  const stores = (Array.isArray(reads) ? reads : []).filter((each) => typeof each === 'string' && path.isAbsolute(each));
  const reopened = main && mainGit && path.dirname(mainGit) === main ? [path.basename(mainGit)] : [];
  const seen = [...(main ? [fingerprint(main, nonce, reopened)] : []), ...stores.filter(exists).map((each) => fingerprint(each, nonce))].filter(Boolean).slice(0, READ_CAP + 1);
  const listener = listen(folder);
  if (listener.problem) return { problem: listener.problem };
  const plan = {
    version: 1, run, key, attempt, nonce, folder, work, git, drop, cache, marks, home: home ?? homedir(),
    reads: seen.map((each) => each.target), unreadable: [...new Set([...(main ? [main] : []), ...stores])],
    unlisted: { host: unlisted, port: 443 }, local: { host: '127.0.0.1', port: listener.port, pid: listener.pid ?? null },
  };
  const written = writeJson(path.join(folder, CONFINE_PLAN), plan);
  if (written) {
    listener.stop();
    return { problem: `the sandbox proof's plan: ${written}` };
  }
  return { plan, listener, prints: Object.fromEntries(seen.map((each) => [each.target.path, each.print])) };
}

// The outcome of a file system probe that threw `error`: `absent` when its target is not there, else `refused`.
const refusal = (error) => (error.code === 'ENOENT' ? 'absent' : 'refused');

// A file made at `file`: one there already counts as a write that landed, as a session that planted it would leave it.
function createProbe(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, 0o600);
  } catch (error) {
    return error.code === 'EEXIST' ? 'succeeded' : refusal(error);
  }
  closeSync(fd);
  rmSync(file, { force: true });
  return 'succeeded';
}

function openProbe(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | NO_FOLLOW | (constants.O_NONBLOCK ?? 0));
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
  } catch (error) {
    outcomes.link = refusal(error);
  }
  if (outcomes.link === 'succeeded') {
    try {
      writeFileSync(path.join(place, name), '', { flag: 'wx', mode: 0o600 });
      outcomes.through = 'succeeded';
      rmSync(path.join(place, name), { force: true });
    } catch (error) {
      outcomes.through = refusal(error);
    }
    try {
      unlinkSync(place);
    } catch {
      // The start finds the link left, and fails the proof on it.
    }
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

// A read of the plan's read target `target`: { outcome, seen }, where `seen` is what it read, salted: each entry of a
// folder, or the first `bytes` of a file. Opening is not landing: the start judges what was seen.
function readProbe(target, nonce) {
  let fd;
  try {
    fd = openSync(target.path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    if (fstatSync(fd).isDirectory()) return { outcome: 'opened', seen: readdirSync(target.path).slice(0, SEEN_CAP).map((name) => salted(nonce, name)) };
    const bytes = Number.isInteger(target.bytes) && target.bytes > 0 ? Math.min(target.bytes, FIRST_BYTES) : FIRST_BYTES;
    const buffer = Buffer.alloc(bytes);
    return { outcome: 'opened', seen: [salted(nonce, buffer.subarray(0, readSync(fd, buffer, 0, bytes, 0)))] };
  } catch (error) {
    return { outcome: refusal(error), seen: [] };
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

// Every probe of `plan`, from the session's sandboxed shell, whose environment is `env`: [{ probe, target, outcome }],
// a read with what it saw (`seen`).
export async function probeAll(plan, env) {
  const paths = probePaths(plan);
  const results = [];
  const note = (probe, target, outcome, more = {}) => results.push({ probe, target, outcome, ...more });
  for (const file of paths.creates) note('write', file, createProbe(file));
  for (const file of paths.opens) note('write', file, openProbe(file));
  for (const file of paths.keeps) note('remove', file, keepProbe(file));
  for (const each of paths.moves) {
    const outcomes = moveProbe(each, plan.home, paths.name);
    note('move', each.from, outcomes.move);
    note('link', outcomes.move === 'succeeded' ? each.from : each.link, outcomes.link);
    if (outcomes.through) note('write through a link', outcomes.move === 'succeeded' ? each.from : each.link, outcomes.through);
  }
  for (const target of plan.reads) {
    const read = readProbe(target, plan.nonce);
    note('read', target.path, read.outcome, { seen: read.seen });
  }
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

// `aidrian project confine RUN ISSUE`, from the session's sandboxed shell in its clone `cwd`, with `env` its
// environment: every probe, then the verdict in the drop folder, once a start (CONFINE_LOCK). { exitCode, out, err }: 0
// when every probe but the reads was refused and the cache variables are in force, else 1, with each that succeeded.
// The start judges the reads.
export async function runConfine({ run, key, cwd = process.cwd(), env = process.env }) {
  const refuse = (why) => ({ exitCode: 1, out: [], err: [`aidrian project confine: ${why}`] });
  const attempt = attemptOf(cwd);
  if (!attempt || attempt.run !== run || attempt.key !== key) return refuse(`this folder is not a clone of the run ${run}'s issue ${key}; run it in the clone the session started in`);
  const plan = readSmallJson(path.join(attempt.folder, CONFINE_PLAN));
  if (!plan || plan.run !== run || plan.key !== key || plan.attempt !== attempt.attempt || !NONCE.test(plan.nonce ?? '')) return refuse(`the start wrote no plan for the sandbox proof of ${key} attempt ${attempt.attempt}`);
  try {
    closeSync(openSync(path.join(attempt.drop, CONFINE_LOCK), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, 0o600));
  } catch (error) {
    return refuse(error.code === 'EEXIST' ? 'the sandbox proof of this start ran already, and runs once' : `the proof's lock in the drop folder cannot be made (${error.code ?? 'no code'})`);
  }
  const results = await probeAll({ ...plan, folder: attempt.folder }, env);
  const failed = results.filter((each) => each.outcome === 'succeeded').map((each) => `${each.probe} ${each.target}`);
  const absent = results.filter((each) => each.outcome === 'absent' && each.probe !== 'read').map((each) => `${each.probe} ${each.target}, which is not there`);
  const vars = shellVarsProblem(attempt.folder, env);
  const problems = [...failed, ...absent, ...(vars ? [vars] : [])];
  const verdict = {
    version: 1, run, key, attempt: attempt.attempt, nonce: plan.nonce, session: sessionIdentity(env).session ?? null,
    pass: problems.length === 0, failed: problems.slice(0, 50), probes: results.length,
    reads: results.filter((each) => each.probe === 'read' && each.seen.length).map((each) => ({ target: each.target, seen: each.seen })),
    at: new Date().toISOString(),
  };
  const written = writeJson(path.join(attempt.drop, CONFINE_VERDICT), verdict);
  if (written) return { exitCode: 1, out: [], err: [`aidrian project confine: the verdict could not be handed over: ${written}`] };
  if (verdict.pass) return { exitCode: 0, out: [`confined ${run} ${key}: the sandbox refused all ${results.length - verdict.reads.length} other probes, the cache variables are in force, and the start judges the ${plan.reads.length} reads`], err: [] };
  return { exitCode: 1, out: [`halt the sandbox does not hold for this session: ${problems.join('; ')}`], err: ['aidrian project confine: the start stops this session and halts the run; nothing more runs here'] };
}

// Whether the process `pid` is alive and no zombie, as `ps` lists it; `run` is spawnSync's shape, a test's.
function alive(pid, run = spawnSync) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code !== 'EPERM') return false;
  }
  const listed = run('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
  const stat = String(listed.stdout ?? '').trim();
  return listed.status === 0 && stat !== '' && !stat.startsWith('Z');
}

// The proof of the start of the attempt in `folder`, as the start reads it outside the sandbox for `session`, the
// session it started, with `prints` the fingerprints prepareConfine kept: null while no verdict is there; { pass: true };
// or { pass: false, problem }. A pass needs the verdict of this plan, naming no other session, every probe but the reads
// refused, no read whose sight matches its fingerprint, the listener the start runs alive on its port with no
// connection, no probe path left, and `cache` and `drop` plain folders with their keep files.
export function confineCheck({ folder, session, prints = {}, isAlive = alive }) {
  const plan = readSmallJson(path.join(folder, CONFINE_PLAN));
  if (!plan || !NONCE.test(plan.nonce ?? '')) return { pass: false, problem: `the sandbox proof's plan in ${folder} cannot be read` };
  const verdict = readSmallJson(path.join(folder, 'drop', CONFINE_VERDICT), VERDICT_CAP);
  if (!verdict) return null;
  const listed = (each) => (Array.isArray(each) ? each.filter((one) => typeof one === 'string').slice(0, 10).join('; ') : '');
  if (verdict.pass !== true) return { pass: false, problem: listed(verdict.failed) || 'the proof failed' };
  if (verdict.nonce !== plan.nonce || verdict.run !== plan.run || verdict.key !== plan.key || verdict.attempt !== plan.attempt) return { pass: false, problem: 'the verdict in the drop folder is not this start\'s' };
  if (verdict.session !== null && verdict.session !== undefined && verdict.session !== session) return { pass: false, problem: `the verdict names the session ${String(verdict.session).slice(0, 64)}, not ${session}` };
  const reads = Array.isArray(verdict.reads) ? verdict.reads : [];
  const landed = Object.entries(prints).find(([target, print]) => reads.some((each) => each?.target === target && Array.isArray(each.seen) && each.seen.includes(print)));
  if (landed) return { pass: false, problem: `read ${landed[0]}, which the sandbox should hide` };
  const listener = readSmallJson(path.join(folder, LISTENER_FILE));
  if (!listener || listener.port !== plan.local?.port || listener.pid !== plan.local?.pid || !isAlive(plan.local?.pid)) return { pass: false, problem: 'the localhost listener outside the sandbox is not the one the start ran, alive on its port, so a refused connection to it proves nothing' };
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
