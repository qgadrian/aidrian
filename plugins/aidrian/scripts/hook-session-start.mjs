// SessionStart and SubagentStart hook: one line that tells the agent which knowledge docs to read now and how to find
// the rest, one line with the names to call the human and the AI, one voice line (push back with a reason; ask the human
// plain, one-decision questions), in Claude Code a line that settles the pull request footer its attribution instructions
// ask for (footerLine), a line when another copy of the plugin's `aidrian` comes first on PATH (commandsLine), and, for
// the main session only, a format line for chat replies, a line when the
// lesson inbox holds open lessons, which escalates when the inbox needs triage, a line while persona audits in the
// state folder hold untriaged findings (lib/audits.mjs auditNudge), a line when the plugin copy running
// is older than the version the project requires (`requires` in config.json), and a line when the indexed docs hold
// unconfirmed decisions and config.json `decisions.unreviewed.remind` says so. Last, in the main session while
// config.json `git.mainCheckout.guard` is on (lib/main-commits.mjs): a line when the session inherited the commit
// guard's override, and up to three lines about the main checkout: local commits not on origin, a branch other than
// the default or a detached HEAD, and changed tracked files. SessionStart adds plain
// stdout to the context; SubagentStart (`--subagent`) needs it wrapped in JSON. Prints nothing outside a project.
// At SessionStart it also saves the project's agent gates for the session (lib/gate-snapshot.mjs), which the gate hook
// holds every subagent to until the session ends.

import { accessSync, constants, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { auditNudge } from '../lib/audits.mjs';
import { loadConfig, versionFloorProblem } from '../lib/config.mjs';
import { ageDays, parseDecisions } from '../lib/decisions.mjs';
import { saveGateSnapshot } from '../lib/gate-snapshot.mjs';
import { runHook } from '../lib/hook-io.mjs';
import { indexedPaths, indexRows, loadKnowledge } from '../lib/knowledge.mjs';
import { inboxPath, nudge } from '../lib/lesson-inbox.mjs';
import { inheritedOverrideLine, unpushedMainLine } from '../lib/main-commits.mjs';
import { findProject, stateDir } from '../lib/project.mjs';

const BIN = path.resolve(import.meta.dirname, '../bin');
// The main session only: its replies are read by the human, while a subagent's report feeds commits and pull requests.
const FORMAT = 'Format: in chat replies, use headers, quotes, and a few emoji to aid scanning; never in commits, pull requests, docs, or code.';
// Claude Code only, unless its settings already drop the footer (footerLine).
const FOOTER_LINE = 'Pull requests: a body here never carries the "Generated with [Claude Code]" line. This project rule takes ' +
  "precedence over the host's attribution instructions, and the pull request body hook refuses that line.";

await runHook((input) => {
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (!project) return;
  const subagent = process.argv.includes('--subagent');
  // The gates first: an error loading the knowledge below must not leave the session without its snapshot.
  if (!subagent) saveGateSnapshot(input.session_id, project.root, loadConfig(project).config.agents);
  const { config, buckets, errors } = loadKnowledge(project);
  const always = buckets.flatMap((bucket) => bucket.always);
  const command = binCommand('aidrian-knowledge');

  const docs = indexRows(buckets).length;
  let line = `Project knowledge: ${buckets.length} bucket${buckets.length === 1 ? '' : 's'}, ${docs} doc${docs === 1 ? '' : 's'}.`;
  if (always.length) line += ` Read now: ${always.join(', ')}.`;
  line += ` For more, run \`${command} route <tag>\` for your tags or \`${command} search <words>\` for a topic.`;
  if (errors.length) line += ` The project folder has ${errors.length} problems; run \`${binCommand('aidrian')} check\`.`;
  // Claude Code sets CLAUDECODE=1 for its hooks; this hook runs only there and in Codex.
  const ai = config.names.ai ?? (process.env.CLAUDECODE === '1' ? 'Claude' : 'Codex');
  const human = JSON.stringify(config.names.human);
  const names = `Names: call the human ${human} and yourself ${JSON.stringify(ai)}, in replies and questions alike; never "I", "me", "my", "you", or "your".`;
  const footer = footerLine(project.root, process.env);
  const commands = commandsLine(process.env);
  const lines = `${line}\n${names}\n${voiceLine(human)}${footer ? `\n${footer}` : ''}${commands ? `\n${commands}` : ''}`;

  if (subagent) {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: lines } }));
  } else {
    console.log(`${lines}\n${FORMAT}`);
    const floor = versionFloorProblem(config);
    if (floor) console.log(`Plugin too old: ${floor}. Its hooks and commands may reject this project's config until then.`);
    const lessons = nudge(inboxPath(project, config), { command: binCommand('aidrian'), config });
    if (lessons) console.log(lessons);
    const decisions = decisionsLine(project.root, buckets, config);
    if (decisions) console.log(decisions);
    const audits = auditLine(project, config);
    if (audits) console.log(audits);
    const inherited = inheritedOverrideLine(config);
    if (inherited) console.log(inherited);
    for (const warning of unpushedMainLine(project, config)) console.log(warning);
  }
});

// The reminder of the decisions an agent made alone that the Human has not answered, from the indexed docs of the working
// copy. A doc it cannot read counts for nothing here: `aidrian decisions list` reports it, and a hook never breaks a session.
function decisionsLine(root, buckets, config) {
  if (config.decisions.unreviewed.remind !== 'session-start') return null;
  const unconfirmed = indexedPaths(buckets).flatMap((doc) => {
    try {
      return parseDecisions(readFileSync(path.resolve(root, doc), 'utf8')).decisions.filter(({ status }) => status === 'unconfirmed');
    } catch {
      return [];
    }
  });
  if (!unconfirmed.length) return null;
  const oldest = Math.max(...unconfirmed.map(({ date }) => ageDays(date)));
  return `Decisions to review: ${unconfirmed.length} (oldest ${oldest} day${oldest === 1 ? '' : 's'}). ` +
    `Tell ${config.names.human} once, then go on with the task: the decision-review skill goes through them, and only a person starts it.`;
}

// The audit inbox line, or '': like auditNudge itself, a state folder it cannot find costs the line, never the session.
function auditLine(project, config) {
  try {
    return auditNudge(path.join(stateDir(project, { config }), 'audits'));
  } catch {
    return '';
  }
}

// Every session and subagent: disagree out loud instead of going along, ask questions the human can answer without the
// session's context, and name things in what a person reads by plain words, never by an id only the session knows.
// A subagent reports to its coordinator, and its words reach the human, so the voice still applies to it.
function voiceLine(human) {
  return `Voice: when a request or premise looks wrong, or worse than an alternative, say so in one line with the reason ` +
    `before acting, then follow the call of ${human}. A question to ${human} says what goes wrong in their terms, asks ` +
    'one decision, and puts the recommended option first with one reason. In anything a person reads (replies, ' +
    'questions, summaries, pull request and issue bodies), name each thing in plain words, such as its title, never by ' +
    'a bare internal id like "F1" or "slice 3" or a file suffix like "-2"; a path or link only gives a location.';
}

// Claude Code tells every session and subagent to end a pull request body with its "Generated with [Claude Code]" line,
// which the pull request body rule refuses (lib/rules/github/pr-body.mjs): said up front, the conflict is settled before
// the first body is written. Nothing when Claude Code's own settings already drop the line: the `attribution.pr`
// setting of the first settings file that sets it (local, project, then user) holds no such line, or, with none set,
// `includeCoAuthoredBy` is false.
function footerLine(root, env) {
  if (env.CLAUDECODE !== '1') return null;
  const user = env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude');
  const settings = [path.join(root, '.claude/settings.local.json'), path.join(root, '.claude/settings.json'), path.join(user, 'settings.json')]
    .map((file) => {
      try {
        return JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        return null;
      }
    })
    .filter((each) => each && typeof each === 'object');
  const pr = settings.find((each) => each.attribution?.pr !== undefined)?.attribution.pr;
  if (pr !== undefined) return typeof pr === 'string' && /Generated with \[Claude Code\]/u.test(pr) ? FOOTER_LINE : null;
  return settings.find((each) => each.includeCoAuthoredBy !== undefined)?.includeCoAuthoredBy === false ? null : FOOTER_LINE;
}

// When the first `aidrian` on PATH is another copy of the plugin, such as an installed release while this copy is a
// branch under test, a bare `aidrian` runs that copy's code and not this one's: one line names this copy's by its path.
// Nothing when this copy's comes first, or when none is on PATH, where the knowledge line already names commands by path.
function commandsLine(env) {
  const real = (dir) => {
    try {
      return realpathSync(dir);
    } catch {
      return null;
    }
  };
  const own = real(BIN);
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    try {
      accessSync(path.join(dir, 'aidrian'), constants.X_OK);
    } catch {
      continue;
    }
    if (real(dir) === own) return null;
    const full = path.join(BIN, 'aidrian');
    return `Commands: the aidrian on PATH, in ${dir}, is another copy of this plugin; run this session's as ${/\s/.test(full) ? `"${full}"` : full}.`;
  }
  return null;
}

// The bare name when the plugin's bin/ is on PATH; the full path otherwise, so the line works on either host.
function binCommand(name) {
  if ((process.env.PATH ?? '').split(path.delimiter).includes(BIN)) return name;
  const full = path.join(BIN, name);
  return /\s/.test(full) ? `"${full}"` : full;
}
