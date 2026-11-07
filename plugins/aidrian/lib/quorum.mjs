// `aidrian quorum`: the deterministic part of the expert quorum. In plan mode, two adversaries attack a plan with cited
// objections and an architect rules on each one; in decide mode, two to four positions argue a question with cited
// cases and cross-examination, and an architect rules on the question.
//   codex   runs Codex as adversary B or as a position, held to OBJECTIONS_SCHEMA (`--mode object`, the default), to
//           CASE_SCHEMA (`--mode case`), to CROSS_SCHEMA and a decide ledger (`--mode cross`), or, to answer the
//           architect's rulings in a ledger, to REBUTTALS_SCHEMA or DECIDE_REBUTTAL_SCHEMA by that ledger's mode
//           (`--mode rebut`), and prints one { status, reason } line
//   premise checks the citations of a product framer's open: false answer, which ends a run before any ledger.
//   check   checks every citation of a ledger against the repository and the plan (the question file in decide mode),
//           relabels a `pending` objection or cross point by whether a citation passes, removes a note with none, and
//           names each ruling or rebuttal with no passing citation; on a ledger that carries `mode`, also the judge's
//           verdicts and, in plan mode, the moderation lines and, on an open ledger, the objection cap from
//           config.json `quorum.plan.maxObjections`
//   roles   prints the roles, judge, and caps of one mode from config.json `quorum`, as one JSON line
//   route   says what happens to one product decision, from the base branch's `quorum.product` and `decisions resolve`'s
//           answer, or, with `--ledger`, what happens after a product ruling, as one JSON line; docs/config.md has the table
//   provisional records that work continues on a product ruling, only on a ledger that passes `check` with no exemption
// The schemas in quorum/*-schema.mjs are the one source of truth for these files. For its callers, this file re-exports
// every name it exported before the split; the modules' other exports are shared only among themselves. `check` runs no
// command but `git ls-files`, and never executes what a citation names.

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { commandConfig } from './config.mjs';
import { isObject } from './fs.mjs';
import { projectAt } from './project.mjs';
import { passing, reader, shown } from './quorum/citations.mjs';
import { codexAnswer, LEDGER_MODES, MODE_NAMES, MODES } from './quorum/codex.mjs';
import { checkDecideLedger, decideCompleteProblems, decideIdProblems } from './quorum/decide-check.mjs';
import { POSITION_IDS } from './quorum/decide-schema.mjs';
import { carriesMode, modeOf, sameModelProblems, schemaOf, schemaProblems } from './quorum/ledger.mjs';
import { answerProblems, checkLedger, completeProblems, idProblems, mergeProblems, modeProblems } from './quorum/plan-check.mjs';
import { MAX_MODE_OBJECTIONS } from './quorum/plan-schema.mjs';
import { checkProductLedger, productStops } from './quorum/product-check.mjs';
import { PRODUCT_DISPATCHES, PRODUCT_LEDGER_SCHEMA, PRODUCT_LOOP_DISPATCHES } from './quorum/product-schema.mjs';
import { fail, PROVISIONAL_USAGE, provisionalCommand, ROUTE_USAGE, routeCommand } from './quorum/route-cli.mjs';
import { markerOnRecord } from './quorum/route.mjs';
import { isolate } from './review/env.mjs';

export { citationProblem, collapse } from './quorum/citations.mjs';
export { CODEX_TIMEOUT_SEC, codexAnswer, crossProblems, decideRebuttalProblems, rebuttalProblems } from './quorum/codex.mjs';
export { checkDecideLedger, decideCompleteProblems, decideIdProblems, governingWinner } from './quorum/decide-check.mjs';
export { CASE_SCHEMA, CROSS_ID, CROSS_SCHEMA, CROSS_STATUSES, DECIDE_LEDGER_SCHEMA, DECIDE_REBUTTAL_SCHEMA, MAX_CROSS, POSITION_IDS } from './quorum/decide-schema.mjs';
export { LEDGER_SCHEMAS, modeOf, sameModelProblems, schemaProblems } from './quorum/ledger.mjs';
export { answerProblems, checkLedger, completeProblems, idProblems, mergeProblems, modeProblems, OBJECTION_ID } from './quorum/plan-check.mjs';
export { CITATION_KINDS, GROUNDS, LEDGER_SCHEMA, MAX_MODE_OBJECTIONS, MAX_NOTES, MAX_OBJECTIONS, MAX_QUOTE, OBJECTION_STATUSES, OBJECTIONS_SCHEMA, REBUTTALS_SCHEMA, SEVERITIES, VERDICTS } from './quorum/plan-schema.mjs';
export { checkProductLedger, productProblems } from './quorum/product-check.mjs';
export { MAX_PRODUCT_POSITIONS, PRODUCT_CROSS_ID, PRODUCT_DISPATCHES, PRODUCT_LEDGER_SCHEMA, PRODUCT_LOOP_DISPATCHES } from './quorum/product-schema.mjs';
export { isClearCall, ROUTED_DOMAINS, routeAfterRuling, routeFor } from './quorum/route.mjs';
export { inferenceProblems } from './quorum/verdicts.mjs';

// The top folder of the checkout `cwd` is in: the nearest folder above it that holds `.git`, a folder in a main
// checkout and a file in a linked worktree. Found without running git, so `check` runs no command but `git ls-files`.
export function checkoutTop(cwd) {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, '.git'))) return realpathSync(dir);
    if (path.dirname(dir) === dir) return null;
  }
}

// The modes `aidrian quorum roles` resolves.
export const ROLE_MODES = Object.freeze(['plan', 'decide', 'product']);

// One configured role as the coordinator runs it: on `agent`, its agent and no fallback; on `codex`, no agent and the
// agent that takes over, with the same brief, when Codex cannot run.
const resolved = ({ provider, agent }) => (provider === 'codex' ? { provider, agent: null, fallback: agent } : { provider, agent, fallback: null });

// What `aidrian quorum roles <mode>` prints, from config.json `quorum` (its DEFAULTS when unset). Plan: adversaries A,
// always a host agent, and B, and the caps. Decide: the odd runner (positions A and C) and the even one (B and D),
// whether a claim's odd hash swaps A's and B's, and the dispatch cap for each position count N from 2 to 4,
// 3N + 2 + C, where C counts the first N positions whose runner is Codex, one fallback each. A swap exchanges one
// Codex and one agent runner, or two alike, so it never changes C.
export function quorumRoles(mode, quorum) {
  const judge = { agent: quorum.judge.agent };
  if (mode === 'plan') {
    const { a, b, maxObjections, maxDispatches } = quorum.plan;
    return { mode, roles: { A: resolved({ provider: 'agent', agent: a.agent }), B: resolved(b) }, judge, caps: { maxObjections, maxDispatches } };
  }
  if (mode === 'product') {
    const { owner, witness, ux, engineer, maxLoops } = quorum.product;
    const agent = (name) => resolved({ provider: 'agent', agent: name });
    return { mode, roles: { tracer: agent('code-reviewer'), owner: agent(owner.agent), witness: agent(witness.agent), ux: agent(ux.agent), engineer: agent(engineer.agent) }, judge: { agent: owner.agent }, caps: { maxLoops, maxDispatches: PRODUCT_DISPATCHES + maxLoops * PRODUCT_LOOP_DISPATCHES } };
  }
  const { odd, even, swap } = quorum.decide;
  const runnerOf = (i) => (i % 2 === 0 ? odd : even);
  const caps = {};
  for (let n = 2; n <= POSITION_IDS.length; n += 1) {
    caps[n] = 3 * n + 2 + POSITION_IDS.slice(0, n).filter((_, i) => runnerOf(i).provider === 'codex').length;
  }
  const positions = (parity) => POSITION_IDS.filter((_, i) => i % 2 === parity);
  return { mode, roles: { odd: { positions: positions(0), ...resolved(odd) }, even: { positions: positions(1), ...resolved(even) } }, swap, judge, caps };
}

const USAGE = 'codex --plan PLAN --brief BRIEF --out FILE [--mode object|case] | codex --mode rebut|cross --ledger LEDGER --plan PLAN --brief BRIEF --out FILE | check LEDGER --plan PLAN | roles plan|decide|product | premise FILE';

export const commands = {
  quorum: {
    usage: USAGE,
    about: 'run Codex as a quorum adversary or position, to object, argue a case, cross-examine, or rebut, and print one {status, reason} line; check a ledger\'s citations against the repository and the plan; print one mode\'s roles and caps from config.json; with route, say what happens to one product decision, before a quorum or after its ruling; or, with provisional, record that work continues on a product ruling',
    async run(args, deps = {}) {
      const [action, ...rest] = args;
      // Git and Codex run without the variables a git hook sets, so they act on the repository of this folder.
      const env = isolate({ ...process.env });
      const cwd = deps.cwd ?? process.cwd();
      const root = checkoutTop(cwd);
      // The project's `quorum` config. commandConfig throws on an invalid config.json, which cli.mjs prints, naming each
      // key, and exits 1: a run never goes on with defaults the project did not choose.
      const quorum = () => commandConfig(projectAt(cwd)).quorum;
      if (action === 'roles') {
        if (rest.length !== 1 || !ROLE_MODES.includes(rest[0])) return fail(`roles takes one mode, plan, decide, or product${rest.length ? `, not "${shown(rest.join(' '))}"` : ''}`);
        (deps.print ?? console.log)(JSON.stringify(quorumRoles(rest[0], quorum())));
        return 0;
      }
      if (action === 'route') return routeCommand(rest, { cwd, print: deps.print ?? console.log });
      if (action === 'provisional') return provisionalCommand(rest, { cwd, root, env, print: deps.print ?? console.log });
      if (action === 'codex') {
        const { values } = parseArgs({ args: rest, options: { plan: { type: 'string' }, brief: { type: 'string' }, out: { type: 'string' }, mode: { type: 'string', default: 'object' }, ledger: { type: 'string' } } });
        if (!values.plan || !values.brief || !values.out) return fail('codex needs --plan, --brief, and --out');
        if (!Object.hasOwn(MODES, values.mode)) return fail(`codex --mode is ${MODE_NAMES}, not "${values.mode}"`);
        if (MODES[values.mode].ledger && !values.ledger) return fail(`codex --mode ${values.mode} needs --ledger`);
        if (!MODES[values.mode].ledger && values.ledger !== undefined) return fail(`codex --ledger is only for --mode ${LEDGER_MODES}`);
        if (!root) return fail('run it inside a git repository');
        const result = await codexAnswer({ ...values, root }, deps);
        (deps.print ?? console.log)(JSON.stringify({ status: result.status, reason: result.reason }));
        return result.status === 'done' ? 0 : result.status === 'unavailable' ? 3 : 1;
      }
      if (action === 'premise') {
        // Checks a framer's `open: false` answer, which ends a product run before any ledger exists.
        if (rest.length !== 1) return fail('premise needs one FILE');
        if (!root) return fail('run it inside a git repository');
        const print = deps.print ?? console.log;
        let answer;
        try {
          answer = JSON.parse(readFileSync(rest[0], 'utf8'));
        } catch (error) {
          return fail(error.message);
        }
        const shape = isObject(answer) && answer.open === false ? schemaProblems(answer.premise, PRODUCT_LEDGER_SCHEMA.properties.premise) : ['premise: only an answer with open: false ends a run'];
        if (shape.length) {
          for (const problem of shape) print(problem.startsWith('premise') ? problem : `premise: ${problem}`);
          return 1;
        }
        const problems = [];
        const held = passing(answer.premise.citations, 'premise', { root, plan: '', env, read: reader(root) }, problems, []);
        for (const problem of problems) print(problem);
        print(`checked: premise, ${held.length} citations pass, ${problems.length} problems`);
        return held.length && !problems.length ? 0 : 1;
      }
      if (action === 'check') {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { plan: { type: 'string' } } });
        if (positionals.length !== 1 || !values.plan) return fail('check needs one LEDGER and --plan');
        if (!root) return fail('run it inside a git repository');
        const [file] = positionals;
        let ledger;
        let plan;
        try {
          ledger = JSON.parse(readFileSync(file, 'utf8'));
          plan = readFileSync(values.plan, 'utf8');
        } catch (error) {
          return fail(error.message);
        }
        // A schema error (by the ledger's mode), an id that does not fit, a same-model record that disagrees with itself
        // or with the runners, a Human answer that fits no objection, a merge that does not fit, a mode rule broken, or a
        // complete ledger left unfinished stops the check before it writes anything. The ids are checked before any line
        // that prints one. A decide ledger is held to the decide rules only.
        const product = modeOf(ledger) === 'product';
        const decide = modeOf(ledger) === 'decide';
        const invalid = product ? productStops(ledger, () => (ledger.status === 'open' ? quorum().product.maxLoops : undefined)) : schemaProblems(ledger, schemaOf(ledger));
        if (!invalid.length && !product) invalid.push(...(decide ? decideIdProblems(ledger) : idProblems(ledger)));
        if (!invalid.length && !product) {
          // An open plan ledger that carries `mode` is held to the configured objection cap, so only it reads config.json.
          // A complete one keeps the ceiling: a lower cap set after it finished never voids it and the Human's answers.
          const cap = !decide && carriesMode(ledger) && ledger.status === 'open' ? quorum().plan.maxObjections : MAX_MODE_OBJECTIONS;
          const rest = decide ? decideCompleteProblems(ledger) : [...answerProblems(ledger), ...mergeProblems(ledger), ...modeProblems(ledger, cap), ...completeProblems(ledger)];
          invalid.push(...sameModelProblems(ledger), ...rest);
        }
        if (invalid.length) {
          for (const problem of invalid) console.error(`${file}: ${problem}`);
          return 1;
        }
        const markerStatus = product && ledger.provisional !== undefined ? markerOnRecord(projectAt(cwd), ledger.provisional.marker) : null;
        const { problems, escapes, stale } = (product ? checkProductLedger : decide ? checkDecideLedger : checkLedger)(ledger, { root, plan, env, read: reader(root), markerStatus });
        for (const escape of escapes) console.error(`${file}: warning: ${escape}`);
        // A complete ledger whose rulings lost their evidence is not settled any more: exit 1, unwritten, so it is not reused.
        if (stale.length) {
          for (const line of stale) console.error(`${file}: ${line} in a complete ledger`);
          return 1;
        }
        const print = deps.print ?? console.log;
        for (const problem of problems) print(problem);
        writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`);
        if (decide || product) {
          const opinions = ledger.cross.filter((point) => point.status === 'opinion').length;
          print(`checked: mode ${ledger.mode}, ${ledger.cases.length} cases, ${ledger.cross.length} cross points, ${opinions} opinion, ${problems.length} problems`);
          return 0;
        }
        const opinions = ledger.objections.filter((objection) => objection.status === 'opinion').length;
        print(`checked: mode ${modeOf(ledger)}, ${ledger.objections.length} objections, ${opinions} opinion, ${problems.length} problems`);
        return 0;
      }
      return fail(`usage: aidrian quorum ${USAGE} | ${ROUTE_USAGE} | ${PROVISIONAL_USAGE}`);
    },
  },
};
