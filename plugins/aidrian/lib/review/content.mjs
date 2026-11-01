// Whole-file content selection for review flows: a changed file joins a flow by what its head text holds, not only
// by its path or the lines the change adds. A flow takes part when it has a `content` key:
//   content.roots    the folders whose source files are read (a path prefix; the trailing `/` is implied).
//   content.exclude  path entries (a glob, or `re:<regex>`) never read, such as tests: they run nothing in production.
//   content.probes   regular expressions a head line may match besides the flow's own `added` ones. They name what
//                    only a whole-file read ties to the flow, so they stay out of `added`, where every line naming
//                    them in a test or a doc would trip it.
//   content.trace    optional: follow the flow's privileged value from a caller into a changed callee.
//     variables  the names the privileged value is held under (a dotted one, such as `ctx.client`, too).
//     factories  regular expression sources of the calls that make it: an inline call counts as handing it on, and
//                `const x = factory(...)` makes `x` privileged.
//     params     the parameter names a callee receives it under, read in hop 2.
//     aliases    import specifier prefix -> path prefix, such as { "~/": "src/" }.
//     hops       1 or 2 (default 1).
//
// A changed file is read when it is under a root, is a source file of the language module (./trace-js.mjs), is not
// excluded, and is not deleted. A file the built-in plan already puts in the flow (a `files` match, or an added line
// an `added` pattern matches) is left out.
//   Content: a head line matches an `added` pattern or a probe.
//   Hop 1: a privileged importer (`files` names it, or its content matches a probe) calls a name it imports from the
//     file, directly or through one barrel that re-exports it, and the call's arguments, read with balanced
//     parentheses and quoted strings left out, hold a privileged variable or an inline factory call.
//   Hop 2: a hop-1 callee, or a callee `files` names, calls the file the same way with one of `params` among the
//     arguments.
// One batched `git grep` of the candidates' import words finds the importers, a second only when a barrel re-exports
// one, and hop 2 repeats that once. Every read goes through git at the head commit, in one cache per call; a git run
// that fails throws, so a failure is never read as "nothing selected".

import { spawnSync } from 'node:child_process';

import { isolate } from './env.mjs';
import { pathPattern } from './plan.mjs';
import { acquiredVars, callsWith, EXTENSIONS_RE, importWord, parse } from './trace-js.mjs';

// The most reasons a flow lists.
const MAX_REASONS = 25;
const MAX_BUFFER = 256 * 1024 * 1024;

const regexes = (sources) => (sources ?? []).map((source) => new RegExp(source, 'u'));
const rootsOf = (content) => (content.roots ?? []).map((root) => root.replace(/\/+$/u, '')).filter(Boolean);

// A git run that did not finish with one of the `ok` exit codes: a spawn error, a signal, or another status.
const gitFailed = (out, ok = [0]) => Boolean(out.error || out.signal || !ok.includes(out.status));
const gitProblem = (out) => out.error?.message ?? (out.signal ? `killed by ${out.signal}` : `exit ${out.status}: ${String(out.stderr ?? '').trim()}`);

// The head commit through git in `root`: the files tracked under `roots`, a cached `contentOf`, a one-call `prefetch`,
// and a fixed-string `grep`. Any git run that fails throws an Error that names the git command.
function headRepo({ root, head, roots, spawn }) {
  const options = { cwd: root, env: isolate({ ...process.env }), maxBuffer: MAX_BUFFER };
  const cache = new Map();
  const listed = spawn('git', ['ls-tree', '-r', '--name-only', '-z', head, '--', ...roots], { ...options, encoding: 'utf8' });
  if (gitFailed(listed)) throw new Error(`git ls-tree at ${head} failed: ${gitProblem(listed)}`);
  const tracked = new Set(listed.stdout.split('\0').filter(Boolean));
  const prefetch = (files) => {
    const missing = [...new Set(files)].filter((file) => !cache.has(file));
    if (!missing.length) return;
    const input = `${missing.map((file) => `${head}:${file}`).join('\n')}\n`;
    const out = spawn('git', ['cat-file', '--batch'], { ...options, input });
    if (gitFailed(out)) throw new Error(`git cat-file --batch at ${head} failed: ${gitProblem(out)}`);
    const buffer = Buffer.from(out.stdout);
    let at = 0;
    for (const file of missing) {
      const end = buffer.indexOf(10, at);
      if (end === -1) {
        cache.set(file, null);
        continue;
      }
      const header = buffer.subarray(at, end).toString('utf8');
      at = end + 1;
      // `<object> missing` for a path the head lacks; `<sha> <type> <size>` and the content otherwise.
      const [, type, size] = /^\S+ (\w+) (\d+)$/u.exec(header) ?? [];
      if (size === undefined) {
        cache.set(file, null);
        continue;
      }
      cache.set(file, type === 'blob' ? buffer.subarray(at, at + Number(size)).toString('utf8') : null);
      at += Number(size) + 1;
    }
  };
  const contentOf = (file) => {
    if (!cache.has(file)) prefetch([file]);
    return cache.get(file) ?? null;
  };
  // The head files under `grepRoots` that contain any of `words`; the ones `keep` accepts are prefetched.
  const grep = (words, grepRoots, keep) => {
    if (!words.length) return [];
    const patterns = words.flatMap((word) => ['-e', word]);
    const out = spawn('git', ['grep', '-l', '-F', ...patterns, head, '--', ...grepRoots], { ...options, encoding: 'utf8' });
    // Exit 1 is "no match"; a spawn error, a signal, or any other status is a grep that did not run.
    if (gitFailed(out, [0, 1])) throw new Error(`git grep at ${head} failed: ${gitProblem(out)}`);
    const files = out.stdout.split('\n').filter(Boolean).map((each) => each.slice(head.length + 1));
    prefetch(files.filter(keep));
    return files;
  };
  return { tracked, prefetch, contentOf, grep };
}

// What one flow's content selection needs, read once from its config.
function flowSpec(id, flow) {
  const { content } = flow;
  const roots = rootsOf(content);
  const exclude = (content.exclude ?? []).map(pathPattern);
  const paths = (flow.files ?? []).map(pathPattern);
  const added = regexes(flow.added);
  const probes = [...added, ...regexes(content.probes)];
  const trace = content.trace ?? null;
  const factorySource = trace?.factories?.length ? trace.factories.map((source) => `(?:${source})`).join('|') : null;
  const named = (file) => paths.some((pattern) => pattern.test(file));
  const matches = (text) => text.split('\n').some((line) => probes.some((probe) => probe.test(line)));
  return {
    id,
    roots,
    probes,
    trace,
    named,
    scanned: (file) => roots.some((root) => file.startsWith(`${root}/`)) && EXTENSIONS_RE.test(file) && !exclude.some((pattern) => pattern.test(file)),
    // Whether the built-in plan already puts the file in the flow.
    builtIn: (file, lines) => named(file) || lines.some((line) => added.some((probe) => probe.test(line))),
    privileged: (file, text) => named(file) || matches(text),
    aliases: trace?.aliases ?? {},
    factorySource,
    inlineFactory: factorySource ? new RegExp(String.raw`\b(?:${factorySource})`, 'u') : null,
    variables: trace?.variables ?? [],
    params: trace?.params ?? [],
    hops: trace?.hops ?? 1,
  };
}

// For each of `targets`: the importers that reach it and the local names they use, directly or through one barrel
// that re-exports it. Only files the flow reads count as importers.
function importersOf(targets, spec, repo, parsed) {
  const wanted = new Set(targets);
  const links = new Map(targets.map((target) => [target, new Map()]));
  const link = (target, importer, local) => {
    const names = links.get(target).get(importer) ?? new Set();
    links.get(target).set(importer, names.add(local));
  };
  const first = repo.grep([...new Set(targets.map(importWord))], spec.roots, spec.scanned).filter(spec.scanned);
  const barrels = new Map();
  for (const file of first) {
    const reExports = parsed(file).reExports.filter((each) => wanted.has(each.target));
    if (reExports.length) barrels.set(file, reExports);
  }
  const second = barrels.size ? repo.grep([...new Set([...barrels.keys()].map(importWord))], spec.roots, spec.scanned).filter(spec.scanned) : [];
  for (const importer of new Set([...first, ...second])) {
    for (const [local, { target, imported }] of parsed(importer).imports) {
      if (wanted.has(target)) link(target, importer, local);
      for (const each of barrels.get(target) ?? []) {
        if (imported === '*' || each.names.has(imported)) link(each.target, importer, local);
      }
    }
  }
  return links;
}

// The changed `targets` a privileged importer hands the privileged value to (hop 1), or, with two hops, a privileged
// callee hands it on to as a client-like parameter (hop 2): target -> reason.
function calleeReasons(targets, spec, repo) {
  const cache = new Map();
  const parsed = (file) => {
    if (!cache.has(file)) cache.set(file, parse(file, repo.contentOf(file) ?? '', { tracked: repo.tracked, aliases: spec.aliases }));
    return cache.get(file);
  };
  const privilegedVars = (text) => new Set([...spec.variables, ...acquiredVars(text, spec.factorySource)]);
  const privilegedCall = (importer, names) => {
    const text = repo.contentOf(importer) ?? '';
    return spec.privileged(importer, text) ? callsWith(text, names, privilegedVars(text), spec.inlineFactory)[0] : undefined;
  };
  const reasons = new Map();
  const handedOn = new Map();
  for (const [target, importers] of importersOf(targets, spec, repo, parsed)) {
    for (const [importer, names] of importers) {
      const call = privilegedCall(importer, names);
      if (call) {
        reasons.set(target, `${target} receives the ${spec.id} value: ${importer}:${call.line} calls ${call.name}(... ${call.variable} ...)`);
        break;
      }
      if (spec.hops < 2) continue;
      const passed = callsWith(repo.contentOf(importer) ?? '', names, spec.params, spec.inlineFactory)[0];
      if (passed) handedOn.set(target, [...(handedOn.get(target) ?? []), { importer, call: passed }]);
    }
  }
  const pending = [...handedOn].filter(([target]) => !reasons.has(target));
  if (!pending.length) return reasons;
  const via = new Map();
  const middles = [...new Set(pending.flatMap(([, list]) => list.map((each) => each.importer)))];
  for (const middle of middles) if (spec.named(middle)) via.set(middle, `${middle} is a named ${spec.id} callee`);
  const unknown = middles.filter((middle) => !via.has(middle));
  if (unknown.length) {
    for (const [middle, importers] of importersOf(unknown, spec, repo, parsed)) {
      for (const [importer, names] of importers) {
        const call = privilegedCall(importer, names);
        if (call) {
          via.set(middle, `${importer}:${call.line} hands it ${call.variable}`);
          break;
        }
      }
    }
  }
  for (const [target, list] of pending) {
    const hit = list.find((each) => via.has(each.importer));
    if (hit) {
      const call = `${hit.importer}:${hit.call.line} calls ${hit.call.name}(... ${hit.call.variable} ...)`;
      reasons.set(target, `${target} receives the ${spec.id} value: ${call}, and ${via.get(hit.importer)}`);
    }
  }
  return reasons;
}

// One flow's entry for its candidate `files`, or null when none is selected.
function flowEntry(spec, files, repo) {
  const content = [];
  const contentReasons = [];
  const candidates = [];
  for (const file of files) {
    const lines = repo.contentOf(file)?.split('\n') ?? [];
    const hit = spec.probes.find((probe) => lines.some((line) => probe.test(line)));
    if (hit) {
      content.push(file);
      contentReasons.push(`head content matches /${hit.source}/ in ${file}`);
    } else candidates.push(file);
  }
  const callees = spec.trace && candidates.length ? calleeReasons(candidates, spec, repo) : new Map();
  const selected = [...content, ...callees.keys()].sort();
  if (!selected.length) return null;
  return { id: spec.id, files: selected, reasons: [...contentReasons, ...callees.values()].slice(0, MAX_REASONS) };
}

// The flows `changes` join by content: [{ id, files, reasons }]. `flows` is the review.flows object in force; only
// the flows with a `content` key take part. `changes` is [{ file, status, added, removed }], `addedLines` maps a file
// to the lines the change adds, and `head` is read through git in `root`. `spawn` is spawnSync, replaceable in tests.
export function contentFlows({ root, head, changes, addedLines = {}, flows, spawn = spawnSync }) {
  const specs = Object.entries(flows ?? {})
    .filter(([, flow]) => flow?.content)
    .map(([id, flow]) => flowSpec(id, flow));
  const pending = specs
    .map((spec) => [spec, changes.filter(({ file, status }) => status !== 'D' && spec.scanned(file) && !spec.builtIn(file, addedLines[file] ?? [])).map(({ file }) => file)])
    .filter(([, files]) => files.length);
  if (!pending.length) return [];
  const roots = [...new Set(pending.flatMap(([spec]) => spec.roots))];
  const repo = headRepo({ root, head, roots, spawn });
  repo.prefetch(pending.flatMap(([, files]) => files));
  return pending.map(([spec, files]) => flowEntry(spec, files, repo)).filter(Boolean);
}
