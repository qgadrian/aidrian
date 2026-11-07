// The `route` and `provisional` actions of `aidrian quorum`: their arguments, their output, and their exit codes.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { commandConfig } from '../config.mjs';
import { answers as reversibleAnswers, resolveQuestion, reversibleProblem } from '../decisions-cli.mjs';
import { projectAt } from '../project.mjs';
import { reader, shown } from './citations.mjs';
import { modeOf } from './ledger.mjs';
import { checkProductLedger, productStops } from './product-check.mjs';
import { isClearCall, ledgerRoute, productInForce, routeFor, secondLookGap } from './route.mjs';

const ROUTE_EXIT_BAD = 3;
const LEDGER_TAKES_NO = ['class', 'reversible', 'hard', 'doc', 'runs'];
// Each printed on a bad argument and beside USAGE. USAGE holds exactly the flags the quorum skill's text names, a test says so,
// and these belong to knowledge/references/decisions.md, so they stay out of it.
const ROUTE_USAGE = 'route --domain D --class C [--reversible A,B,C,D] [--hard A,B,C,D,E] [--doc PATH]... [--runs N] | route --ledger LEDGER --domain D';
const PROVISIONAL_USAGE = 'provisional LEDGER --plan PLAN --marker ID';

// `aidrian quorum route`: one JSON line, and exit 0; a bad argument exits 3 with nothing on stdout, and an invalid
// config.json stops it on every path, as it stops every command.
function routeCommand(args, { cwd, print }) {
  const project = projectAt(cwd);
  commandConfig(project);
  const bad = (problem) => {
    console.error(`usage: aidrian quorum ${ROUTE_USAGE}\n\naidrian quorum route: ${problem}`);
    return ROUTE_EXIT_BAD;
  };
  const word = { type: 'string' };
  let values;
  try {
    ({ values } = parseArgs({ args, options: { domain: word, class: word, reversible: word, hard: word, doc: { type: 'string', multiple: true }, runs: word, ledger: word } }));
  } catch (error) {
    if (!error.code?.startsWith('ERR_PARSE_ARGS')) throw error;
    return bad(error.message);
  }
  if (values.ledger !== undefined) {
    const extra = LEDGER_TAKES_NO.find((key) => values[key] !== undefined);
    if (extra) return bad(`--ledger takes no --${extra}: the ledger holds the Ruling's answers`);
    if (!values.domain) return bad('--ledger needs --domain: a ruling resolves under its own domain\'s answer');
    let ledger;
    try {
      // Read as JSON and never checked: `quorum check` holds a ledger to the schema, and this reads only what it names.
      ledger = JSON.parse(readFileSync(path.resolve(cwd, values.ledger), 'utf8'));
    } catch (error) {
      return bad(`cannot read ${values.ledger}: ${error.message}`);
    }
    const { route, wait, reason, resolve, settle, listed } = ledgerRoute(project, ledger, values.domain);
    print(JSON.stringify({ route, wait, reason, resolve, settle, listed }));
    return 0;
  }
  if (!values.domain || !values.class) return bad('route needs --domain and --class, or --ledger');
  const reversible = reversibleAnswers(values.reversible);
  if (!reversible) return bad(reversibleProblem());
  if (values.runs !== undefined && !/^\d+$/u.test(values.runs)) return bad(`--runs takes a whole number, 0 or more, not "${shown(values.runs)}"`);
  const answer = resolveQuestion(project, { domain: values.domain, class: values.class, reversible, docs: values.doc ?? [] });
  const call = { hard: !isClearCall(values.hard), runs: Number(values.runs ?? 0), domain: values.domain };
  const { route, wait, reason } = routeFor(productInForce(project, answer.base), call, answer);
  print(JSON.stringify({ route, wait, reason, resolve: answer }));
  return 0;
}

const fail = (problem) => {
  console.error(`aidrian quorum: ${problem}`);
  return 1;
};

// `aidrian quorum provisional`, the one writer of `provisional`: it holds the ledger to `check` with the field left out, so
// no exemption applies, to the field's own rules, to what `route --ledger` says under the ruling's domain, the base branch's
// settings, and resolve's answer, and to the second look resolve asks for, and writes only when every one passes. Any refusal exits 1, unwritten.
function provisionalCommand(args, { cwd, root, env, print }) {
  const bad = (problem) => {
    console.error(`usage: aidrian quorum ${PROVISIONAL_USAGE}\n\naidrian quorum provisional: ${problem}`);
    return 1;
  };
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: { plan: { type: 'string' }, marker: { type: 'string' } } });
  } catch (error) {
    if (!error.code?.startsWith('ERR_PARSE_ARGS')) throw error;
    return bad(error.message);
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1 || !values.plan || values.marker === undefined) return bad('it needs one LEDGER, --plan, and --marker');
  if (!root) return fail('run it inside a git repository');
  const project = projectAt(cwd);
  commandConfig(project);
  const [file] = positionals;
  let ledger;
  let plan;
  try {
    ledger = JSON.parse(readFileSync(file, 'utf8'));
    plan = readFileSync(values.plan, 'utf8');
  } catch (error) {
    return fail(error.message);
  }
  const refuse = (lines) => {
    for (const line of lines) console.error(`${file}: ${line}`);
    return 1;
  };
  if (modeOf(ledger) !== 'product') return refuse(['only a product ledger takes provisional']);
  const { provisional: held, ...bare } = ledger;
  if (held !== undefined && held?.marker !== values.marker) return refuse([`the ledger already records ${shown(String(held?.marker))}`]);
  const marked = { ...bare, provisional: { marker: values.marker } };
  const stops = productStops(marked);
  if (stops.length) return refuse(stops);
  if (bare.human_answer !== null) return refuse(['the Human has answered, so that answer governs and no work continues provisionally']);
  const { problems, escapes, stale } = checkProductLedger(bare, { root, plan, env, read: reader(root) });
  for (const escape of escapes) console.error(`${file}: warning: ${escape}`);
  if (stale.length) return refuse(stale.map((line) => `${line} in a complete ledger`));
  // The stops above hold the Ruling's fields, so its question is there to ask, and this adds resolve's row with resolve's key.
  const { route, wait, reason, settle, resolve } = ledgerRoute(project, marked, bare.ruling.domain, { writing: true });
  if (route !== 'quorum' || (wait && !settle.length)) return refuse([`the route is ${route}, with wait ${wait}, so no work continues: ${reason}`]);
  const look = secondLookGap(bare, resolve.secondLook);
  if (look) return refuse([look]);
  for (const problem of problems) print(problem);
  writeFileSync(file, `${JSON.stringify(marked, null, 2)}\n`);
  print(`provisional: marker ${values.marker}`);
  return 0;
}

export { fail, PROVISIONAL_USAGE, provisionalCommand, ROUTE_USAGE, routeCommand };
