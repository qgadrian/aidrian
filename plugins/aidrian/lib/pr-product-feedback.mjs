// `aidrian pr product-feedback <status|record|answer|recheck|post|items|diff>`: what a pull request's product feedback holds, and
// whether any of it is still owed. One record per pull request lives in the state folder, at
// `product-feedback/<owner>/<name>/pr-<n>/record.json`; feedback-record.mjs reads it. docs/config.md#product-feedback
// describes the commands.
//
// An item is sorted into a kind, taking the first that fits: `choice`, what the docs do not settle or any finding a
// product manager owns; `minor`, polish, an opinion, or a consideration; `defect`, an observed blocker or friction, or a
// product manager's gap the docs do settle. A persona item keeps its decision in triage.json under its `audit_key`, the
// one store, so the Audit inbox and `status` read the same decision; a product-manager item has no audit key, so its
// decision is its `answer` here. What counts as answered is applied when it is read (itemState), whoever recorded it.
//
// `status` takes the team's values only from GitHub, at the default branch and at the base (pr-auto-merge branchConfig),
// so a branch cannot raise or lower them, and the machine's choice only from the main checkout's local file
// (project.localFeedbackAuto). Before any gh call it reads git alone (localFeedback): when that says off, it is clear
// with no gh call, so a project without the feature pays none; anything else goes to GitHub, which decides. `record` and `recheck` take the repository, the number, and the head only from gh, and
// `record` stores `limited` by `aidrian pr resolve`'s reads and rule, which the post rule reads.
// `post` is the one path that posts: it refuses a body holding anything local, and nothing is ever read back from a
// comment into the record.
//
// `items` lists where each item stands, whatever `auto` says, and `diff` writes the diff beside the record for the
// product-manager read.
//
// Exit codes: `status` 0 clear, 2 owed, 3 error; every other action 0 done, 3 refused or failed, with the record untouched.

import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { decisionProblem, readTriage, recordDecision, reportName, sidecarName, sidecarProblems, today } from './audits.mjs';
import { commandConfig, DEFAULTS, loadConfig, strictConfigFromText } from './config.mjs';
import { AUDIT_KEY, cleanTitle, decisionFields, decisionOf, heldFor, itemState, openDecisions, KINDS, PERSONA, PRODUCT_MANAGER, readRecord, RECORD_VERSION, recordPath } from './feedback-record.mjs';
import { isDirectory, isFile, isObject, isWithin } from './fs.mjs';
import { runGh } from './gh.mjs';
import { runGit } from './git.mjs';
import { withLocks } from './jsonl.mjs';
import { loadKnowledge } from './knowledge.mjs';
import { ACCESS_DOC, parsePersona, personaDocs, previewPatterns } from './personas.mjs';
import { branchConfig, defaultBranch, ghError, notFound, readView, VIEW_FIELDS } from './pr-auto-merge.mjs';
import { checkoutRemotes } from './pr-checks.mjs';
import { fromOutside, parseTarget } from './pr-resolve.mjs';
import { committedConfigFile, repoRoot, stateDir, strictConfigPathIn } from './project.mjs';
import { FEEDBACK_NO_LIST } from './review/config.mjs';
import { pathPattern } from './review/plan.mjs';

const ITEM_ID = /^PF([1-9]\d*)$/u;
const RECHECKS = ['confirmed', 'reopened'];
const USAGE = [
  'usage: aidrian pr product-feedback status PR [--json]',
  '       aidrian pr product-feedback record PR [--report FILE] [--items FILE] [--none-found --read-by product-manager]',
  '       aidrian pr product-feedback answer PR ITEM DECISION [--by WHO] [--reason T] [--issue K] [--url U] [--doc D]',
  '       aidrian pr product-feedback recheck PR ITEM confirmed|reopened [--note T]',
  '       aidrian pr product-feedback post PR --body-file FILE',
  '       aidrian pr product-feedback items PR [--json]',
  '       aidrian pr product-feedback diff PR',
].join('\n');
// What a pull request with nothing recorded needs: the read itself, never a record of no read.
const notRun = (number) => `nothing has read #${number}: run the persona-audit skill on it, or the product-manager read of its diff, then record what that run found`;

// The kind of a persona finding, from its sidecar entry.
export function deriveKind({ owner, severity, label }) {
  if (owner === PRODUCT_MANAGER) return 'choice';
  if (severity === 'polish' || label === 'opinion') return 'minor';
  return 'defect';
}

// Why this decision may not be given for this kind by this answerer, or null: the table of itemState, at the door.
function tableProblem({ kind }, { decision, by, reason }) {
  const human = by === 'human';
  const ask = 'it counts only as the Human\'s, with --by human';
  if (decision === 'decided') return human ? null : `decided is the Human's product decision: ${ask}`;
  if (kind === 'choice') return human ? null : `this item is a product choice: ${ask}`;
  if (kind === 'minor') {
    if (decision === 'defer') return reason?.trim() ? null : 'defer on a minor item needs --reason';
    return human ? null : `a minor item takes defer with a reason from a session; ${decision} ${ask}`;
  }
  return decision === 'fix-now' || human ? null : `this item is a defect, which takes fix-now from a session; ${decision} ${ask}`;
}

function writeAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, file);
}
const writeRecord = (file, record) => writeAtomic(file, `${JSON.stringify(record, null, 2)}\n`);

// Reads, changes, and writes the record under its lock. Throws when it cannot be read or is not this pull request's.
function updateRecord(file, pr, change) {
  mkdirSync(path.dirname(file), { recursive: true });
  return withLocks([file], () => {
    const record = readRecord(file, pr);
    if (!record) throw new Error(notRun(pr.number));
    change(record);
    writeRecord(file, record);
    return record;
  });
}

// The pull request as gh describes it: readView's fields, with `repo` as gh's URL spells it, and `crossRepository` when
// `fields` asks gh for it. As `aidrian pr resolve` holds it, the argument is checked first, and gh's answer, like a URL's
// repository, must be a remote of this checkout.
// `viewed` is gh's answer to that same view when the caller already has it, as the ready hold does: it is held to the same checks.
function pullRequest(value, { gh, remotes }, fields = VIEW_FIELDS, viewed = null) {
  const target = parseTarget(value);
  if (target.refusal) throw new Error(target.refusal);
  const spelled = ({ host, owner, name }) => `${host}/${owner}/${name}`;
  const notRemote = (where) => new Error(`not a remote: ${spelled(where)} is not a remote of this checkout`);
  const isRemote = (where) => remotes().includes(spelled(where).toLowerCase());
  if (target.host && !isRemote(target)) throw notRemote(target);
  let view = viewed;
  try {
    view ??= JSON.parse(gh(['pr', 'view', String(target.number), ...(target.host ? ['--repo', spelled(target)] : []), '--json', fields]));
  } catch (error) {
    throw new Error(`could not read pull request ${target.number} with gh (${ghError(error)})`);
  }
  const pr = readView(view);
  if (typeof pr === 'string') throw new Error(pr);
  const answered = parseTarget(pr.number === target.number ? view.url : '');
  if (!answered.host || answered.number !== target.number) throw new Error(`gh answered for no pull request ${target.number}`);
  if (!isRemote(answered)) throw notRemote(answered);
  return { ...pr, repo: `${answered.owner}/${answered.name}`, crossRepository: view.isCrossRepository };
}

// Whether the pull request comes from outside the team, by the reads and the rule of `aidrian pr resolve` (fromOutside).
// `record` stores it, so the post rule (rules/product-feedback-post.mjs), which runs no gh, can hold a post to the Human.
function readLimited(gh, pr) {
  let pull;
  try {
    pull = JSON.parse(gh(['api', '--hostname', pr.host, `repos/${pr.repo}/pulls/${pr.number}`]));
  } catch (error) {
    throw new Error(`could not read who opened #${pr.number} with gh (${ghError(error)}), so nothing was recorded`);
  }
  const limited = fromOutside(pr.crossRepository, pull);
  if (limited === null) throw new Error(`gh did not say whether #${pr.number} comes from outside the team, so nothing was recorded`);
  return limited;
}

const unionOf = (lists) => [...new Set(lists.flat())];
const feedbackOf = (config) => config.review.productFeedback;
const targetFilesOf = (config) => (config.review.visual?.targets ?? []).flatMap((target) => target.files);
// The errors that leave a branch's feedback settings unreadable. Auto with no file list is read, as clear.
const unreadableFeedback = (error) => /"review(?:"|\.productFeedback)/u.test(error) && !error.endsWith(FEEDBACK_NO_LIST);
// A branch's config by the rules of a reader that must not take a broken file for the defaults. A file gh does not have is
// no config. `visualBroken` says the file sets a `review.visual` that its checks dropped, whose files are then unknown.
function readBranch(gh, pr, branch, prefix) {
  let visualBroken = false;
  const config = branchConfig(gh, pr, branch, prefix, {
    locate: (read) => {
      try {
        return strictConfigPathIn(read);
      } catch (error) {
        throw new Error(`${error.message}, on ${branch}`);
      }
    },
    parse: (text, file) => {
      const parsed = strictConfigFromText(text, `${file} on ${branch}`, unreadableFeedback);
      if (typeof text === 'string') visualBroken = (JSON.parse(text)?.review?.visual ?? null) !== null && parsed.review.visual === null;
      return parsed;
    },
  });
  return { branch, config, visualBroken };
}

const CLEAR_WORDS = {
  off: 'the team has not turned product feedback on',
  opted_out: 'this machine opted out',
  no_file_lists: 'no file list says what is user-facing',
  not_user_facing: 'no changed file is user-facing',
  nothing_open: 'nothing is open',
};
const LOCAL_OFF_WORDS = 'git\'s origin refs say product feedback is off; a fetch reads the team\'s current choice';

// `review.productFeedback.auto` as `ref` commits it, found as committedConfig finds the file at that commit: true, false, or
// undefined when it cannot be read: a folder override at the ref that cannot be read (committedConfigFile null), a config
// file missing at the ref, or text that is no JSON.
function committedAuto(project, ref) {
  let file;
  try {
    file = committedConfigFile(project, ref);
  } catch {
    return undefined;
  }
  if (file === null) return undefined;
  const shown = runGit(['show', `${ref}:./${file}`], project.root);
  if (shown.status !== 0) return undefined;
  try {
    return JSON.parse(shown.stdout)?.review?.productFeedback?.auto === true;
  } catch {
    return undefined;
  }
}

// What git alone says of whether `project` may run product feedback, before any gh call, as { state, team }. A session can
// rewrite every ref it reads, so this read only ever sends the decision to GitHub, and off needs every source off:
//   - `on`: the main checkout's local `auto` is true, a ref commits `auto: true`, or the state folder holds `product-feedback/`;
//   - `maybe`: no source says on, and a ref's config cannot be read (committedAuto undefined): GitHub decides;
//   - `off`: the local `auto` is false, or every ref says off, and git names the default branch on origin;
//   - `unknown`: no source says on, and git names no default branch on origin, so only GitHub can say off.
// The default branch is origin/HEAD, origin/<git.defaultBranch> of the working copy, or origin/main. HEAD, the branch itself,
// can only raise: it never says off alone. `team` says an origin ref commits `auto: true`, for the reason `status` gives
// a machine that opted out.
export function localFeedback(project) {
  if (project.localFeedbackAuto === true) return { state: 'on', team: false };
  let config = DEFAULTS;
  try {
    config = loadConfig(project).config;
  } catch {}
  const origin = [...new Set(['refs/remotes/origin/HEAD', `refs/remotes/origin/${config.git.defaultBranch}`, `refs/remotes/origin/${DEFAULTS.git.defaultBranch}`])];
  const exists = (ref) => runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], project.root).status === 0;
  const onOrigin = origin.filter(exists).map((ref) => committedAuto(project, ref));
  const onHead = exists('HEAD') ? committedAuto(project, 'HEAD') : false;
  const team = onOrigin.includes(true);
  if (project.localFeedbackAuto === false) return { state: onOrigin.length ? 'off' : 'unknown', team };
  let kept = false;
  try {
    kept = isDirectory(path.join(stateDir(project, { config }), 'product-feedback'));
  } catch {}
  if (team || onHead === true || kept) return { state: 'on', team };
  if (!onOrigin.length) return { state: 'unknown', team };
  if (onOrigin.includes(undefined) || onHead === undefined) return { state: 'maybe', team };
  return { state: 'off', team };
}

// What `status` says of pull request `value`, as { exit, result }: exit 0 clear, 2 owed, and an error thrown. Everything it
// reads of the team, it reads from GitHub, once localFeedback has not said off. It prints nothing, so the ready hold
// (rules/github/ready-hold.mjs) runs it in its own process, at the project root it found, with the gh seam it bounds.
// The hold's seams: `view`, gh's answer to the pull request's view, so it is viewed once; `local`, localFeedback's answer
// it already read; and `mainBranch(pr)`, the default branch's name when git already names it, or null to ask GitHub.
export function feedbackStatus(value, project, { gh, remotes = () => checkoutRemotes(project.root), view = null, local = localFeedback(project), mainBranch = () => null }) {
  if (local.state === 'off') {
    const target = parseTarget(value);
    if (target.refusal) throw new Error(target.refusal);
    const reason = project.localFeedbackAuto === false && local.team ? 'opted_out' : 'off';
    const repo = target.host ? `${target.owner}/${target.name}` : null;
    // Read from git alone, which may lag GitHub until a fetch: say what was read, not what the team chose. A local `auto` of
    // false says off whatever the refs say, so its words name the machine's opt-out.
    const why = reason === 'off' && project.localFeedbackAuto !== false ? LOCAL_OFF_WORDS : CLEAR_WORDS.opted_out;
    return { exit: 0, result: { state: 'clear', reason, why, pr: target.number, repo, head: null, owed: [] } };
  }
  const pr = pullRequest(value, { gh, remotes }, VIEW_FIELDS, view);
  const shown = runGit(['rev-parse', '--show-prefix'], project.root);
  if (shown.status !== 0) throw new Error('git could not give the project\'s folder in the repository');
  const prefix = shown.stdout.trim();
  const main = mainBranch(pr) ?? defaultBranch(gh, pr);
  const onMain = readBranch(gh, pr, main, prefix);
  const onBase = pr.base === main ? onMain : readBranch(gh, pr, pr.base, prefix);
  const read = [onMain, onBase];
  const branches = read.map(({ config }) => config);
  const say = (exit, state, reason, why, owed = []) => ({ exit, result: { state, reason, why, pr: pr.number, repo: pr.repo, head: pr.head, owed } });
  const clear = (reason) => say(0, 'clear', reason, CLEAR_WORDS[reason]);

  const team = branches.some((config) => feedbackOf(config).auto === true);
  const machine = project.localFeedbackAuto;
  if (!(machine ?? team)) return clear(machine === false && team ? 'opted_out' : 'off');
  const unlisted = read.find(({ config, visualBroken }) => feedbackOf(config).files === null && visualBroken);
  if (unlisted) throw new Error(`review.visual on ${unlisted.branch} has errors, and its targets are that branch's file list`);
  const lists = unionOf(branches.map((config) => feedbackOf(config).files ?? targetFilesOf(config)));
  if (!lists.length) return clear('no_file_lists');
  const patterns = lists.map(pathPattern);
  const hidden = pr.files.length !== pr.changedFiles || pr.files.some(({ changeType }) => changeType === 'RENAMED' || !changeType);
  const matches = pr.files.some((file) => file.path.startsWith(prefix) && patterns.some((pattern) => pattern.test(file.path.slice(prefix.length))));
  if (!hidden && !matches) return clear('not_user_facing');

  const working = loadConfig(project).config;
  if (working.state.dir !== onMain.config.state.dir) return say(2, 'owed', 'state_dir', `the working copy's state.dir differs from the default branch's, and the record is read from it`);
  const state = stateDir(project, { config: working });
  const record = readRecord(recordPath(state, pr.repo, pr.number), pr);
  // An empty record counts only when a run stands behind it: a report, or a read that named itself.
  if (!record || (!record.items.length && !record.report && record.read_by !== PRODUCT_MANAGER)) return say(2, 'owed', 'not_run', notRun(pr.number));
  const triage = record.items.some((item) => item.source === PERSONA) ? readTriage(path.join(state, 'audits')) : null;
  const owed = record.items.map((item) => ({ item, entry: decisionOf(item, triage) })).map((each) => ({ ...each, state: itemState(each.item, each.entry) })).filter((each) => each.state !== 'answered')
    .map((each) => ({ id: each.item.id, title: each.item.title, kind: each.item.kind, state: each.state, command: commandFor(pr.number, each.item, each.state, each.entry) }));
  if (!owed.length) return clear('nothing_open');
  const reason = owed.some((each) => each.state === 'unanswered') ? 'unanswered' : 'not_rechecked';
  const count = `${owed.length} item${owed.length === 1 ? '' : 's'}`;
  return say(2, 'owed', reason, reason === 'unanswered' ? `${count} still owed an answer or a re-check` : `${count} waiting for a re-check of the fix`, owed);
}

// `status`: prints what feedbackStatus says, and exits with it.
function status({ argv: [value], values, project, gh, remotes }) {
  const { exit, result } = feedbackStatus(value, project, { gh, remotes });
  if (values.json) console.log(JSON.stringify(result));
  else {
    console.log(`product feedback ${result.state} for #${result.pr}: ${result.why}`);
    for (const each of result.owed) console.log(`- ${JSON.stringify(each.title)}: ${each.command}`);
  }
  return exit;
}

// The command that answers an owed item, for what it counts to be given. A held item takes the Human's decision first.
function commandFor(number, item, state, entry) {
  const { id, kind } = item;
  const base = 'aidrian pr product-feedback';
  if (state === 'not_rechecked') return `${base} recheck ${number} ${id} confirmed|reopened`;
  if (heldFor(item, entry)) return `${base} answer ${number} ${id} decided --by human --reason '<the decision>'`;
  if (kind === 'choice') return `${base} answer ${number} ${id} <decision> --by human`;
  if (kind === 'minor') return `${base} answer ${number} ${id} defer --reason '<why>'`;
  return `${base} answer ${number} ${id} fix-now`;
}

// A sidecar this pull request's record may name: valid, of this pull request, and of the head gh reports now.
function loadSidecar(audits, given, pr) {
  const report = reportName(path.basename(given));
  const file = path.join(audits, sidecarName(report));
  if (!isFile(file)) throw new Error(`no sidecar for that report in the audits folder: ${file}`);
  let value;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file}: invalid JSON (${error.message})`);
  }
  const [problem] = sidecarProblems(value, { report });
  if (problem) throw new Error(`the sidecar of that report: ${problem}`);
  const expected = `${pr.repo}#${pr.number}`;
  if (typeof value.pr !== 'string') throw new Error(`that report names no pull request, and this record is of ${expected}`);
  if (value.pr.toLowerCase() !== expected.toLowerCase()) throw new Error(`that report is of ${value.pr}, and this record is of ${expected}`);
  if (value.head !== pr.head) throw new Error(`the head moved: that report walked ${value.head.slice(0, 7)}, and gh reports ${pr.head.slice(0, 7)} now, so walk the new head`);
  return { report, value };
}

// What the session gives `record`: { persona: [{ key, from }], manager: [{ title, kind }] }.
function readInputs(file) {
  if (!file) return { persona: [], manager: [] };
  let value;
  try {
    value = JSON.parse(readFileSync(path.resolve(file), 'utf8'));
  } catch (error) {
    throw new Error(`--items: ${error.message}`);
  }
  const list = Array.isArray(value) ? value : value?.items;
  if (!Array.isArray(list)) throw new Error('--items: must be a JSON list of items');
  const inputs = { persona: [], manager: [] };
  for (const each of list) {
    if (isObject(each) && typeof each.audit_key === 'string') {
      if (each.kind !== undefined) throw new Error('--items: a persona item\'s kind comes from its sidecar, so it names only its audit_key, and carried_from when it carries an earlier item');
      inputs.persona.push({ key: each.audit_key, from: each.carried_from });
    } else if (isObject(each) && each.source === PRODUCT_MANAGER && typeof each.title === 'string' && each.title.trim() && KINDS.includes(each.kind)) {
      inputs.manager.push({ title: cleanTitle(each.title), kind: each.kind });
    } else throw new Error(`--items: an item is { audit_key } or { source: "${PRODUCT_MANAGER}", title, kind }, with kind one of ${KINDS.join(', ')}`);
  }
  return inputs;
}

const higherKind = (a, b) => (KINDS.indexOf(a) <= KINDS.indexOf(b) ? a : b);

// Merges a run into the earlier items. Mutates its own copies, and returns the items and each decision to copy under a
// new key. Every earlier item stays, a product-manager item left out of this run included; none drops or lowers its kind.
// A `by: human` entry already under a key this run takes, which it did not copy there, is kept in the item, which stays owed.
// An item that takes a key notes when (`adopted_at`, `at`): a verdict's settle written before then still holds (heldFor),
// whoever's decision stands under the key now. A carry that copies the item's own decision keeps the item's time, since
// the copy is its decision; one that finds a decision under the new key takes the time of the carry.
function mergeItems(earlier, inputs, sidecar, pr, triage, at) {
  const items = structuredClone(earlier);
  const added = [];
  const copies = [];
  let last = Math.max(0, ...items.map((item) => Number(ITEM_ID.exec(item.id)?.[1] ?? 0)));
  const nextId = () => `PF${(last += 1)}`;
  const entryAt = (key) => {
    const [, report, id] = AUDIT_KEY.exec(key);
    return triage?.reports?.[report]?.[id] ?? null;
  };
  const unasked = (key) => {
    const entry = entryAt(key);
    return entry?.decision && entry.by === 'human' ? decisionFields(entry) : null;
  };
  if (sidecar) {
    const { report, value } = sidecar;
    const findings = new Map(value.findings.map((finding) => [`${report}#${finding.id}`, finding]));
    const given = inputs.persona.map(({ key }) => key);
    const unknown = given.filter((key) => !findings.has(key));
    if (unknown.length) throw new Error(`${unknown.join(', ')}: no finding of that report's sidecar has this key`);
    if (new Set(given).size !== given.length) throw new Error('--items lists one finding twice');
    const missing = [...findings].filter(([key]) => !given.includes(key)).map(([, finding]) => JSON.stringify(cleanTitle(finding.title)));
    if (missing.length) throw new Error(`the sidecar's findings left out: ${missing.join(', ')}`);
    const carried = new Set(value.carried_forward.map((key) => (key.includes('#') ? key : `${value.supersedes}#${key}`)));
    const candidates = items.filter((item) => item.source === PERSONA && carried.has(item.audit_key) && itemState(item, decisionOf(item, triage)) !== 'answered');
    const taken = new Set();
    for (const { key, from } of inputs.persona) {
      const finding = findings.get(key);
      const title = cleanTitle(finding.title);
      const kept = items.find((item) => item.source === PERSONA && item.audit_key === key);
      if (kept) {
        Object.assign(kept, { title, owner: finding.owner, kind: higherKind(kept.kind, deriveKind(finding)) });
        continue;
      }
      if (from !== undefined && !candidates.some((item) => item.audit_key === from)) throw new Error(`carried_from ${from}: no open item of this record that the sidecar's carried_forward lists has this key`);
      const match = candidates.find((item) => !taken.has(item) && (from === undefined ? item.title === title : item.audit_key === from));
      if (!match) {
        const found = unasked(key);
        added.push({ id: null, source: PERSONA, audit_key: key, title, kind: deriveKind(finding), owner: finding.owner, head: pr.head, rechecked: null, adopted_at: at, ...(found ? { unasked_decision: found } : {}) });
        continue;
      }
      taken.add(match);
      const entry = decisionOf(match, triage);
      // A decision the new key holds already is never overwritten. A copy keeps `unasked_decision`: it copies the same word.
      const copied = Boolean(entry) && !entryAt(key)?.decision;
      if (copied) copies.push({ key, entry });
      const found = unasked(key);
      Object.assign(match, { audit_key: key, title, owner: finding.owner, head: pr.head, kind: higherKind(match.kind, deriveKind(finding)), rechecked: null }, copied ? {} : { adopted_at: at }, found ? { unasked_decision: found } : {});
    }
    const lost = candidates.filter((item) => !taken.has(item));
    if (lost.length) throw new Error(`the sidecar carries forward ${lost.map((item) => JSON.stringify(item.title)).join(', ')}, and no finding names it: add carried_from with its key to the finding that covers it`);
  } else if (inputs.persona.length) throw new Error('--items names an audit_key, and no --report names its sidecar');
  for (const { title, kind } of inputs.manager) {
    const kept = items.find((item) => item.source === PRODUCT_MANAGER && item.title === title);
    // A new read that finds the gap again needs a new confirmation, as a persona carry does.
    if (kept) Object.assign(kept, { kind: higherKind(kept.kind, kind), head: pr.head, rechecked: null });
    else added.push({ id: null, source: PRODUCT_MANAGER, title, kind, owner: PRODUCT_MANAGER, head: pr.head, rechecked: null, answer: null });
  }
  for (const item of added) item.id = nextId();
  return { items: [...items, ...added], copies };
}

// `record`: writes the record of this run, under its lock. A run names itself: a report, items, or a read that found
// nothing. A decision is copied before the record is written, so a failure between them leaves a record that a second
// run copies again.
function record({ argv: [value], values, project, gh, remotes, now }) {
  const inputs = readInputs(values.items);
  const noneFound = values['none-found'] === true;
  const ran = Boolean(values.report) || inputs.persona.length > 0 || inputs.manager.length > 0;
  if (noneFound && values['read-by'] !== PRODUCT_MANAGER) throw new Error(`--none-found names the read: --read-by ${PRODUCT_MANAGER}`);
  if (noneFound && ran) throw new Error('--none-found says a read found nothing, so it takes no --report and no items');
  if (!noneFound && values['read-by'] !== undefined) throw new Error('--read-by goes with --none-found');
  const pr = pullRequest(value, { gh, remotes }, `${VIEW_FIELDS},isCrossRepository`);
  if (!noneFound && !ran) throw new Error(notRun(pr.number));
  const limited = readLimited(gh, pr);
  const state = stateDir(project, { config: commandConfig(project, { exitCode: 3 }) });
  const audits = path.join(state, 'audits');
  const sidecar = values.report ? loadSidecar(audits, values.report, pr) : null;
  const file = recordPath(state, pr.repo, pr.number);
  mkdirSync(path.dirname(file), { recursive: true });
  const written = withLocks([file], () => {
    const earlier = readRecord(file, pr);
    const needsTriage = sidecar || earlier?.items.some((item) => item.source === PERSONA);
    const triage = needsTriage ? readTriage(audits) : null;
    const at = now().toISOString();
    const { items, copies } = mergeItems(earlier?.items ?? [], inputs, sidecar, pr, triage, at);
    for (const { key, entry } of copies) {
      const [, report, id] = AUDIT_KEY.exec(key);
      recordDecision(audits, [{ report, id }], entry);
    }
    const next = {
      version: RECORD_VERSION, pr: pr.number, repo: pr.repo, head: pr.head, limited, report: sidecar?.report ?? earlier?.report ?? null, read_by: noneFound ? PRODUCT_MANAGER : earlier?.read_by ?? null, comment_id: earlier?.comment_id ?? null, recorded_at: at, items,
    };
    writeRecord(file, next);
    return next;
  });
  console.log(`recorded ${written.items.length} item${written.items.length === 1 ? '' : 's'} for #${pr.number} at ${pr.head.slice(0, 7)}: ${file}`);
  return 0;
}

function findItem(found, id, pr) {
  if (!found) throw new Error(notRun(pr.number));
  const item = found.items.find((each) => each.id === id);
  if (!item) throw new Error(`no item ${id} in the record of #${pr.number}`);
  return item;
}

// Why `decision` is not open for this item, or null: openDecisions, with `covered` apart, which no finding takes. A
// verdict an unasked word settled still holds there.
function openProblem(item, decision, entry) {
  if (openDecisions(item, entry).includes(decision)) return null;
  if (decision === 'covered') return `covered is for a Not reached line that restates findings not re-checked, and ${JSON.stringify(item.title)} is a finding`;
  return `${decision} is not open for ${JSON.stringify(item.title)} yet: the Human decides first, with decided --by human`;
}

// `answer`: the table, decisionProblem, and allowedDecisions, then, for a persona item, one decision in triage.json. Its
// time sets it apart from a decision the record found under the key, so the item can count again: it is after the item's
// `adopted_at`, by a millisecond when the clock reads the same or earlier.
function answer({ argv: [value, id, decision], values, project, gh, remotes, now }) {
  const pr = pullRequest(value, { gh, remotes });
  const state = stateDir(project, { config: commandConfig(project, { exitCode: 3 }) });
  const audits = path.join(state, 'audits');
  const file = recordPath(state, pr.repo, pr.number);
  const item = findItem(readRecord(file, pr), id, pr);
  const triage = item.source === PERSONA ? readTriage(audits) : null;
  const adopted = Date.parse(item.adopted_at ?? '');
  const at = new Date(Math.max(now().getTime(), Number.isNaN(adopted) ? 0 : adopted + 1)).toISOString();
  const entry = { decision, issue: values.issue ?? null, url: values.url ?? null, reason: values.reason ?? null, doc: values.doc ?? null, by: values.by ?? null, date: today(), at };
  const problem = decisionProblem(entry) ?? openProblem(item, decision, decisionOf(item, triage)) ?? tableProblem(item, entry);
  if (problem) throw new Error(`nothing was recorded: ${problem}`);
  if (item.source === PERSONA) {
    const [, report, findingId] = AUDIT_KEY.exec(item.audit_key);
    recordDecision(audits, [{ report, id: findingId }], entry);
  } else {
    updateRecord(file, pr, (found) => {
      findItem(found, id, pr).answer = entry;
    });
  }
  console.log(`recorded ${JSON.stringify(item.title)}: ${decision}`);
  return 0;
}

// `recheck`: whether a fix-now item's fix holds, at the head gh reports now. `confirmed` is the session's word. A fix-now
// on a held verdict (heldFor) has nothing to re-check, so a re-check never outlives it into the Human's own decision.
function recheck({ argv: [value, id, word], values, project, gh, remotes }) {
  if (!RECHECKS.includes(word)) throw new Error(`a re-check is ${RECHECKS.join(' or ')}`);
  const pr = pullRequest(value, { gh, remotes });
  const state = stateDir(project, { config: commandConfig(project, { exitCode: 3 }) });
  const file = recordPath(state, pr.repo, pr.number);
  const found = findItem(readRecord(file, pr), id, pr);
  const triage = found.source === PERSONA ? readTriage(path.join(state, 'audits')) : null;
  const entry = decisionOf(found, triage);
  if (entry?.decision !== 'fix-now') throw new Error(`${JSON.stringify(found.title)} has no fix-now decision to re-check`);
  if (heldFor(found, entry)) throw new Error(`the fix-now of ${JSON.stringify(found.title)} does not count yet: the Human decides first, with decided --by human`);
  if (word === 'confirmed' && found.head === pr.head) throw new Error(`${JSON.stringify(found.title)} was found at this head, so confirming it needs a different head`);
  updateRecord(file, pr, (current) => {
    findItem(current, id, pr).rechecked = { status: word, head: pr.head, date: today(), ...(values.note ? { note: values.note } : {}) };
  });
  console.log(`re-checked ${JSON.stringify(found.title)} at ${pr.head.slice(0, 7)}: ${word}`);
  return 0;
}

// What a product-access doc names that a comment never may: its hosts, the leading names of its accounts, and its
// variables, by name.
export function accessTerms(text) {
  const { sections } = parsePersona(text);
  const lowered = (list) => [...new Set(list.map((each) => each.toLowerCase()))];
  const urlHosts = [...text.matchAll(/https?:\/\/([^\s/:`'")\]]+)/giu)].map((match) => match[1]);
  const written = [...(sections.Environments ?? '').matchAll(/`([a-z0-9<>{}*-]+(?:\.[a-z0-9-]+)+)`/giu)].map((match) => match[1]);
  const hosts = lowered([...urlHosts, ...written, ...previewPatterns(text)]).filter((host) => !/^(?:localhost|127\.0\.0\.1|0\.0\.0\.0)$/u.test(host));
  const accounts = (sections.Accounts ?? '').split('\n').map((line) => /^\s*[-*+]\s+`([^`\s]+)`/u.exec(line)?.[1]).filter(Boolean);
  const variables = [...text.matchAll(/`([A-Z][A-Z0-9_]{2,})`|\b([A-Z][A-Z0-9]*_[A-Z0-9_]+)\b/gu)].map((match) => match[1] ?? match[2]);
  return { hosts, accounts: lowered(accounts), variables: [...new Set(variables)] };
}

const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
// A root that holds what is local to a machine or a runner; an ordinary route such as /settings/team is none of them.
const LOCAL_ROOTS = ['Users', 'home', 'root', 'tmp', 'private', 'var', 'etc', 'opt', 'mnt', 'srv', 'usr', 'Volumes', 'Library', 'System', 'Applications', 'workspace', '__w', 'builds', 'nix', 'proc'];
const LOCAL_PATH = new RegExp([
  `(?<![\\w./-])/(?:${LOCAL_ROOTS.join('|')})/`,
  '(?<![\\w./-])/(?:github/workspace|dev/shm|cygdrive|c/Users)(?![\\w-])',
  // The scheme of a URL keeps `https://home` out.
  '(?<![\\w.:/-])//home(?![\\w-])',
  '(?<![\\w./-])[A-Za-z]:[\\\\/]',
  '(?<![\\w-])file:[/\\\\]',
  '(?<![\\w\\\\])\\\\\\\\[\\w.-]+',
  '(?<![\\w\\\\])\\\\Users(?![\\w-])',
].join('|'), 'u');
const HOME = /(?<![\w./-])~[\\/]|\$\{?HOME\b|%USERPROFILE%/iu;
const LOCAL_HOST = new RegExp([
  '(?<![\\w-])localhost(?![\\w-])',
  '(?<![\\w.-])host\\.docker\\.internal(?![\\w-])',
  '(?<![\\w-])[\\w-]+\\.local(?!\\.?[\\w-])',
  '\\[::1\\]',
  '(?<![\\w.])169\\.254\\.',
  '(?<![\\w.])(?:127(?:\\.\\d{1,3}){1,3}|0\\.0\\.0\\.0|10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}|172\\.(?:1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3}|192\\.168\\.\\d{1,3}\\.\\d{1,3})(?!\\d)',
].join('|'), 'iu');
// A named host as a pattern: a leading `*.` is the host itself and its subdomains, and a templated first label, such as
// `<pr>` or `pr-*`, takes any label. The match lets a dot or a template stand before it.
function hostPattern(host) {
  const [first, ...rest] = host.split('.');
  if (first === '*') return escaped(rest.join('.'));
  const label = first.split(/<[^>]*>|\{+[^}]*\}+|\*/u).map(escaped).join('[\\w-]*');
  return [label, ...rest.map(escaped)].join('\\.');
}
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/u;
const REPORT_PATH = /(?<![\w./-])[\w+-]+-\d{4}-\d{2}-\d{2}(?:-\d+)?(?:\.md|\.json|\/\S+)/u;
const SECRETS = [
  /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{4,}/u,
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{4,}/u,
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}/u,
  /(?<![A-Za-z0-9])sk_(?:live|test)_[A-Za-z0-9]{4,}/u,
  /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{12,}/u,
  /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{4,}/u,
  /(?<![A-Za-z0-9])eyJ[\w-]+\.[\w-]+\.[\w-]+/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY/u,
];

// `body` as a reader may come to see it: no format character, and numeric entities and %xx decoded.
function decodedCopy(body) {
  const point = (code) => (code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '');
  return body.replace(/\p{Cf}/gu, '')
    .replace(/&#(\d+);/gu, (_, digits) => point(Number(digits)))
    .replace(/&#x([0-9a-f]+);/giu, (_, digits) => point(Number.parseInt(digits, 16)))
    .replace(/&commat;/giu, '@')
    .replace(/%([0-9a-f]{2})/giu, (_, digits) => String.fromCharCode(Number.parseInt(digits, 16)));
}

// The kind of the first local or secret thing `body` holds, in words safe to print, or null. The value never leaves here.
function kindIn(body, { home, state, roots, terms, env }) {
  if (state && body.includes(state)) return 'a path in the state folder';
  if ((home && body.includes(home)) || HOME.test(body)) return 'a path in the home folder';
  if (roots.some((root) => root && body.includes(root))) return 'a path in the checkout';
  if (LOCAL_PATH.test(body)) return 'an absolute local path';
  if (LOCAL_HOST.test(body)) return 'localhost or a private network address';
  // A named host's subdomains and templated labels match, so only a word character or a dash before it keeps it apart.
  if (terms.hosts.length && new RegExp(`(?<![\\w-])(?:${terms.hosts.map(hostPattern).join('|')})(?![\\w-])`, 'iu').test(body)) return 'a host product-access names';
  if (terms.accounts.length && new RegExp(`(?<![\\w.-])(?:${terms.accounts.map(escaped).join('|')})(?![\\w-])`, 'iu').test(body)) return 'an account product-access names';
  // A value this short would match ordinary text.
  if (terms.variables.some((name) => typeof env[name] === 'string' && env[name].length >= 4 && body.includes(env[name]))) return 'the value of a variable product-access names';
  if (EMAIL.test(body)) return 'an email address';
  if (SECRETS.some((shape) => shape.test(body))) return 'a secret';
  if (REPORT_PATH.test(body)) return 'a report or screenshot path';
  return null;
}

// The kind of what `body` holds, as written or as a reader may come to see it, or null.
export function refusedKind(body, { home = '', state = '', roots = [], terms, env = {} }) {
  const context = { home, state, roots, terms, env };
  return kindIn(body, context) ?? kindIn(decodedCopy(body), context);
}

const IMAGE = '(image removed)';
const AT_ENTITY = /&#0*64;|&#x0*40;|&commat;/giu;
const URL_TOKEN = /^[(<["']*https?:\/\/[^\s<]*$/u;

export function neutralized(body) {
  const out = body.replace(/!\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])?/gu, IMAGE)
    .replace(/<\s*(?:img|image|picture|source|video|svg)\b[^>]*>?/giu, IMAGE)
    .replaceAll('<!--', '&lt;!--')
    .replace(AT_ENTITY, '@');
  // GitHub reads a mention from the rendered text. A URL keeps its /@name.
  return out.replace(/(?<![A-Za-z0-9])@(?=[A-Za-z0-9])/gu, (at, offset, whole) => {
    const inUrl = whole[offset - 1] === '/' && URL_TOKEN.test(whole.slice(0, offset).split(/\s/u).at(-1));
    return inUrl ? at : '@\u200b';
  });
}

// The text of the project's product-access docs. A knowledge error that names an index file throws: the doc it would
// have listed cannot be told apart from no doc, so `post` posts nothing.
function projectAccessDocs(project) {
  const { buckets, errors } = loadKnowledge(project);
  const broken = errors.find((each) => /\bknowledge\/[^\s:"]+\.json/u.test(each));
  if (broken) throw new Error(`a knowledge index cannot be read, and a product-access doc may be behind it, so nothing was posted: ${broken}`);
  return personaDocs(project.root, buckets).filter(({ id }) => id === ACCESS_DOC).map(({ file }) => readFileSync(file, 'utf8'));
}

// The text of --body-file, which must really be inside `<state>/tmp/`, where a skill drafts what it posts, so a post
// never picks up a file from anywhere else on the machine.
function readBody(given, state) {
  const folder = path.join(state, 'tmp');
  const refusal = `refused: --body-file must be a file inside ${folder}. Nothing was posted`;
  let real;
  let root;
  try {
    real = realpathSync(path.resolve(given));
    root = realpathSync(folder);
  } catch {
    throw new Error(refusal);
  }
  if (real === root || !isWithin(root, real)) throw new Error(refusal);
  return readFileSync(real, 'utf8');
}

// The comment `post` edits: the record's when the gh user wrote it and it still opens with the marker, else the gh user's
// last marked comment, else none. Every other author's marker is ignored. A read that fails but for a 404 throws.
function ownComment({ gh, pr, record: found, marker }) {
  const read = (args, what) => {
    try {
      return JSON.parse(gh(['api', '--hostname', pr.host, ...args]));
    } catch (error) {
      throw new Error(`could not read ${what} with gh (${ghError(error)})`);
    }
  };
  const user = read(['user'], 'the gh user')?.login;
  if (typeof user !== 'string' || user === '') throw new Error('gh api user returned no login');
  const own = (comment) => comment?.user?.login?.toLowerCase() === user.toLowerCase() && typeof comment.body === 'string' && comment.body.startsWith(`${marker}\n`) && Number.isSafeInteger(comment.id);
  if (Number.isSafeInteger(found.comment_id)) {
    let current = null;
    try {
      current = JSON.parse(gh(['api', '--hostname', pr.host, `repos/${pr.repo}/issues/comments/${found.comment_id}`]));
    } catch (error) {
      if (!notFound(error)) throw new Error(`could not read the comment with gh (${ghError(error)})`);
    }
    if (own(current)) return current.id;
  }
  const pages = read([`repos/${pr.repo}/issues/${pr.number}/comments`, '--paginate', '--slurp'], 'the comments');
  return (Array.isArray(pages) ? pages.flat() : []).filter(own).at(-1)?.id ?? null;
}

// `post`: refuses first, and writes nothing until it has decided. The record changes only after a post that worked.
function post({ argv: [value], values, project, gh, remotes, env, access }) {
  if (!values['body-file']) throw new Error(USAGE);
  const pr = pullRequest(value, { gh, remotes });
  const state = stateDir(project, { config: commandConfig(project, { exitCode: 3 }) });
  const file = recordPath(state, pr.repo, pr.number);
  const found = readRecord(file, pr);
  if (!found) throw new Error(notRun(pr.number));
  const body = readBody(values['body-file'], state);
  const terms = access(project).map(accessTerms).reduce((all, each) => ({
    hosts: [...all.hosts, ...each.hosts], accounts: [...all.accounts, ...each.accounts], variables: [...all.variables, ...each.variables],
  }), { hosts: [], accounts: [], variables: [] });
  const kind = refusedKind(body, { home: homedir(), state, roots: [project.root, repoRoot(project)], terms, env });
  if (kind) throw new Error(`refused: the body holds ${kind}. Nothing was posted`);
  const marker = `<!-- aidrian-product-feedback: pr=${pr.number} repo=${pr.repo} -->`;
  const comment = `${marker}\n${neutralized(body)}`;
  const target = ownComment({ gh, pr, record: found, marker });
  const route = target === null ? `repos/${pr.repo}/issues/${pr.number}/comments` : `repos/${pr.repo}/issues/comments/${target}`;
  let written;
  try {
    written = JSON.parse(gh(['api', '--hostname', pr.host, route, '--method', target === null ? 'POST' : 'PATCH', '-f', `body=${comment}`]));
  } catch (error) {
    throw new Error(`the post failed, and the record is unchanged (${ghError(error)})`);
  }
  if (!Number.isSafeInteger(written?.id)) throw new Error('gh gave no comment id for the post, and the record is unchanged');
  updateRecord(file, pr, (current) => {
    current.comment_id = written.id;
  });
  console.log(`${target === null ? 'posted' : 'edited'} the product feedback comment on #${pr.number}`);
  return 0;
}

// `items`: every item of the record and where it stands, whatever `auto` says, for the skill that runs the feedback on
// demand: which run it is, what to re-check, and what the comment says. `head` is gh's head now, and `recorded_head` the
// head the record was written at, which the comment names. No record prints `recorded: false`, exit 0.
function items({ argv: [value], values, project, gh, remotes }) {
  const pr = pullRequest(value, { gh, remotes });
  const state = stateDir(project, { config: commandConfig(project, { exitCode: 3 }) });
  const found = readRecord(recordPath(state, pr.repo, pr.number), pr);
  const triage = found?.items.some((item) => item.source === PERSONA) ? readTriage(path.join(state, 'audits')) : null;
  const listed = (found?.items ?? []).map((item) => {
    const entry = decisionOf(item, triage);
    const where = itemState(item, entry);
    return {
      id: item.id, title: item.title, kind: item.kind, source: item.source, audit_key: item.audit_key ?? null, owner: item.owner ?? null, found_at: item.head ?? null, state: where,
      decision: entry?.decision ?? null, by: entry?.decision ? entry.by ?? null : null, rechecked: item.rechecked ?? null,
      command: where === 'answered' ? null : commandFor(pr.number, item, where, entry),
    };
  });
  const result = {
    pr: pr.number, repo: pr.repo, head: pr.head, recorded: Boolean(found), recorded_head: found?.head ?? null, limited: found ? found.limited ?? null : null,
    report: found?.report ?? null, comment_id: found?.comment_id ?? null, items: listed,
  };
  if (values.json) console.log(JSON.stringify(result));
  else if (!found) console.log(`no product feedback recorded for #${pr.number}`);
  else for (const each of listed) console.log(`- ${JSON.stringify(each.title)}, ${each.kind}: ${each.state}`);
  return 0;
}

// `diff`: writes the pull request's diff beside its record, as `diff.patch`, for the product-manager read, and prints its
// path. The diff is data an agent reads; nothing here runs it. gh reads it from the repository the pull request is in.
function diff({ argv: [value], project, gh, remotes }) {
  const pr = pullRequest(value, { gh, remotes });
  const state = stateDir(project, { config: commandConfig(project, { exitCode: 3 }) });
  const file = path.join(path.dirname(recordPath(state, pr.repo, pr.number)), 'diff.patch');
  if (!isWithin(path.join(state, 'product-feedback'), file)) throw new Error(`the diff of ${pr.repo}#${pr.number} would leave the state folder`);
  let text;
  try {
    text = gh(['pr', 'diff', String(pr.number), '--repo', `${pr.host}/${pr.repo}`]);
  } catch (error) {
    throw new Error(`could not read the diff of #${pr.number} with gh (${ghError(error)})`);
  }
  if (typeof text !== 'string') throw new Error(`gh returned no diff for #${pr.number}`);
  writeAtomic(file, text);
  console.log(file);
  return 0;
}

const TEXT = { type: 'string' };
const ACTIONS = {
  status: { options: { json: { type: 'boolean' } }, operands: 1, run: status },
  record: { options: { report: TEXT, items: TEXT, 'none-found': { type: 'boolean' }, 'read-by': TEXT }, operands: 1, run: record },
  answer: { options: { by: TEXT, reason: TEXT, issue: TEXT, url: TEXT, doc: TEXT }, operands: 3, run: answer },
  recheck: { options: { note: TEXT }, operands: 3, run: recheck },
  post: { options: { 'body-file': TEXT }, operands: 1, run: post },
  items: { options: { json: { type: 'boolean' } }, operands: 1, run: items },
  diff: { options: {}, operands: 1, run: diff },
};

// The CLI body. `gh`, `remotes`, `env`, `access`, and `now` are the test seams: (args) → stdout, () → checkoutRemotes,
// the environment, (project) → the product-access docs' text, and () → the time a record says it was written.
export function runProductFeedback(argv, project, {
  gh = (args) => runGh(args, { cwd: project.root }),
  remotes = () => checkoutRemotes(project.root),
  env = process.env,
  access = projectAccessDocs,
  now = () => new Date(),
} = {}) {
  const fail = (message) => {
    console.error(`aidrian pr product-feedback: ${message}`);
    return 3;
  };
  const [name, ...rest] = argv;
  if (!Object.hasOwn(ACTIONS, name ?? '')) return fail(USAGE);
  const { options, operands, run } = ACTIONS[name];
  let parsed;
  try {
    parsed = parseArgs({ args: rest, allowPositionals: true, options });
  } catch (error) {
    return fail(error.message);
  }
  if (parsed.positionals.length !== operands) return fail(USAGE);
  try {
    return run({ argv: parsed.positionals, values: parsed.values, project, gh, remotes, env, access, now });
  } catch (error) {
    return fail(error.message);
  }
}
