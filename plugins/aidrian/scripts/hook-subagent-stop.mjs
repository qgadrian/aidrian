// SubagentStop hook (Claude Code): one `stop` row in the dispatch log, then the checks that can send the subagent back,
// for five causes the row's `sent_back_for` names (lib/dispatch-log.mjs SEND_BACK_CAUSES):
// - `background`: a background task it started still runs (the background check);
// - `missing_file`: its last message names a file as written that does not exist (the delivery check);
// - `handoff`: a handoff file its brief asked for is not written, with no report to write there (the delivery check);
// - `marker`: its brief's `Handoff file:` marker names a path the hook cannot fill (the marker check);
// - `evidence`: its report claims a test run passed with no finished run of its own to show it (the evidence check).
// The delivery check: every .md or .json path the subagent's last message names must exist; when one does not, it is sent
// back once, on the first stop of its turn, to write it or correct its report, and the send-back is recorded as a lesson
// for that agent type (lib/lesson-signals.mjs). A handoff file its brief asked it to write and it did not (unwrittenHandoffs)
// is the record its dispatcher reads, since a handback can reach another session or none: the hook writes the agent's
// final report there (deliverHandoffs), and sends it back for the file only when it has no report to write. While a
// background task of its own still runs and a later stop is sure, the file is not due: the host wakes the agent when that
// task ends (wakingChildren: on Claude Code a shell's end notice or an agent's report), or the background check sends it
// back, and the delivery check neither sends it back for the file nor records a lesson. A stop let end with only tasks the
// host does not wake it for may be its last, so the file is written then. It writes only on a stop it lets end: a stop
// sent back, as for another missing file, has a report the agent will correct, and the corrected one is what the file
// must hold.
// The background check: no background shell or agent it started may still run (runningChildren). A subagent that ends its
// turn goes idle: a shell task's end notice wakes it, but on a host that refuses a subagent task's handback to an idle
// agent, the work it waits on stalls until something else wakes it. A host that delivers that report and wakes the agent
// declares it (capabilities.wakesOnChildReport), and such a task is left out (blockingChildren); Claude Code does.
// So it is told to wait in the foreground, and sent back again at
// each stop while such a task runs, up to CHILD_SEND_BACKS in a row (lib/child-send-backs.mjs): one send-back did not hold,
// since a foreground wait that outlives its timeout is moved to the background, and a watch armed instead is another task.
// The stop the cap lets end with a task still running is recorded as a lesson for the plugin. The count is stored before
// each send-back past the first, and a count that cannot be stored ends the stop, so no host can loop on it; a payload
// without `stop_hook_active` (another host) is never sent back (sendsBack). The row's `sent_back` records the decision.
// The marker check: a `Handoff file:` marker the hook cannot fill, such as one whose path is not absolute, sends the subagent back once,
// on the first stop of its turn, to hand back its report with the mistake named, and never to write that path itself.
// The evidence check: a final report that says a test command passed, with no run of it on the session's check-run
// record that passed (lib/check-runs.mjs), is sent back once, on the first stop of its turn, to quote a run a tool
// returned or call the run "not finished". A report once claimed a full suite passed after its runs were stopped.
// What the report quotes from another source, such as a pull request body or another agent's claim, is not its own.
// config.json `telemetry.enabled: false` drops the row, never the checks or the lessons.

import { CHILD_SEND_BACKS, childSendBacks, forgetChildSendBacks, storeChildSendBacks } from '../lib/child-send-backs.mjs';
import { loadConfig } from '../lib/config.mjs';
import { appendEvent } from '../lib/dispatch-log.mjs';
import { blockingChildren, checkDelivery, runningChildren, sendsBack, stopAgent, stopRow, undelivered, wakingChildren } from '../lib/dispatch-rows.mjs';
import { deliverHandoffs, finalReport } from '../lib/delivery-check.mjs';
import { claimProblem, passClaims, readCheckRuns, unsupportedClaims } from '../lib/check-runs.mjs';
import { deny, isMain, runHook } from '../lib/hook-io.mjs';
import { deliverySignal, idleChildrenSignal, recordSignal } from '../lib/lesson-signals.mjs';
import { findProject, projectCheckouts, stateDir } from '../lib/project.mjs';
import { sessionFolder } from '../lib/session-folder.mjs';
import { readText } from '../lib/transcript.mjs';

// What the subagent is told when a background task it started still runs, on send-back `round` of CHILD_SEND_BACKS.
const childrenReason = (children, round) =>
  `You started background work that is still running: ${children
    .map((child) => `\`${child.id}\` (${child.type}${child.description ? `: ${child.description}` : ''})`)
    .join(', ')}. ` +
  'Ending your turn now leaves you idle, and a subagent task cannot hand its result back to an idle agent. ' +
  'Wait for it in the foreground before you end the turn: poll it with a foreground command whose loop ends on its own ' +
  'before the command\'s timeout, such as at most two minutes of an until-loop on its output file or process, and repeat ' +
  'the call until it finishes. A command that outlives its timeout is moved to the background and counts as one more task, ' +
  'and a Monitor or another background command is one too, so neither is a wait. ' +
  'If a task should not outlive this turn, such as a wait loop of yours that the host moved to the background, stop it with TaskStop. ' +
  `This is send-back ${round} of ${CHILD_SEND_BACKS}. ` +
  'Next time, run a long push or CI wait as a foreground command with a timeout, and a reviewer agent in the foreground.';

// What the subagent is told when its brief asked for a handoff file it has not written.
const handoffReason = (files) =>
  `Your brief asks you to write your machine handoff to ${files.map((file) => `\`${file}\``).join(', ')}, which does not exist. ` +
  'Write the handoff JSON there now, then end your turn with a short summary. The file is the record your dispatcher reads: ' +
  'a handback can reach another session than the one that dispatched you, or none once it has ended. ' +
  'An agent with neither a file tool nor a shell ends its turn with the handoff as its last message, and this hook writes it there; ' +
  'if the path belongs to another agent, say so.';

// What the subagent is told when its brief's `Handoff file:` markers name a file the hook cannot fill, each `rejected`
// as { value, problem } (lib/delivery-check.mjs briefHandoffs): told once, so its report carries the mistake back. It is
// never told to write the rejected path: the brief's text would become the hook's write instruction to any folder.
const rejectedReason = (rejected) =>
  `Your brief's \`Handoff file:\` marker ${rejected.map(({ value, problem }) => (value ? `\`${value}\` ${problem}` : problem)).join('; ')}, ` +
  'so this hook cannot write your handoff there for you. Write no file at that path, which may lie outside the dispatch ' +
  'folder: end your turn with the machine handoff as your last message, and say in it that the brief\'s handoff path ' +
  'was rejected and why, so your dispatcher corrects its briefs.';

// When the subagent's run started, in milliseconds: its transcript's first timestamp, or null when it cannot be read.
function startedAt(input) {
  const text = typeof input.agent_transcript_path === 'string' ? readText(input.agent_transcript_path) : null;
  for (const line of (text ?? '').split('\n', 20)) {
    try {
      const at = Date.parse(JSON.parse(line)?.timestamp);
      if (Number.isFinite(at)) return at;
    } catch {
      // Not a JSON line: read the next.
    }
  }
  return null;
}

// The claims of a passing test run in the subagent's final report that its own rows on the session's check-run record do
// not support: rows its own calls wrote (`agentId`), since it started. Another agent's run, the parent's included, is
// that agent's to report. Checked only on the first stop of a turn: [] on any later stop, a report with none, or a
// record it cannot read.
function unsupportedReport(input, project, config) {
  if (input.stop_hook_active !== false) return [];
  const report = finalReport(input);
  if (typeof report !== 'string' || !report.trim()) return [];
  const claims = passClaims(report, { section: null, testing: config.testing, ownOnly: true });
  if (!claims.length) return [];
  const folder = sessionFolder(stateDir(project, { config }), input.session_id, { checkouts: projectCheckouts(project) });
  const all = folder ? readCheckRuns(folder) : null;
  if (all === null) return [];
  const since = startedAt(input);
  const runs = all.filter((run) => run.agentId === input.agent_id && (since === null || !(Date.parse(run.at) < since)));
  return unsupportedClaims(claims, runs).map((claim) => ({ ...claim, runs }));
}

// Whether the background check sends the subagent back on this stop, given `made` send-backs so far: the count is stored
// first, and a stop past the first of its turn whose count cannot be stored is let end.
function childrenSendBack(input, children, made) {
  if (!children.length || !sendsBack(input, { missing: [] }, children, made)) return false;
  return storeChildSendBacks(input, made + 1) || input.stop_hook_active === false;
}

// The hook's body, for the payload `input` (lib/hook-io.mjs callHook).
export async function handle(input) {
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (!project) return;
  const { config } = loadConfig(project);
  const tasks = runningChildren(input);
  // The tasks the background check counts: a background agent whose report the host delivers to an idle subagent is none.
  const children = blockingChildren(input, tasks);
  const checked = checkDelivery(input, project);
  const made = children.length ? childSendBacks(input) : 0;
  if (!children.length) forgetChildSendBacks(input);
  const forChildren = childrenSendBack(input, children, made);
  // A handoff waits for a later stop only when one is sure to come, decided apart from the background check's filter:
  // a running task whose end wakes the agent (wakingChildren), or this stop sent back for its tasks. With none, as for a
  // task on a host that wakes the agent for none, this stop may be its last: its handoff is written now.
  // Accepted residual: a background shell that never ends, such as a dev server, keeps the handoff pending past the cap,
  // since its end never comes to wake the agent. The stop row records `delivered: pending`, so the case stays measurable.
  const running = wakingChildren(input, tasks).length > 0 || (tasks.length > 0 && forChildren);
  // The send-back is decided on the delivery as it would be once the handoff files are written, and they are written
  // only when the stop ends.
  let delivery = deliverHandoffs(input, checked, { running, write: false });
  let forDelivery = undelivered(delivery).length > 0 && sendsBack(input, delivery);
  let unsupported = [];
  try {
    unsupported = unsupportedReport(input, project, config);
  } catch {
    // A record or report it cannot read sends nothing back.
  }
  const forEvidence = unsupported.length > 0;
  // A marker the hook cannot fill is told once, on the first stop of a turn.
  const forMarker = (checked.rejected ?? []).length > 0 && input.stop_hook_active === false;
  if (!forChildren && !forDelivery && !forEvidence && !forMarker) {
    delivery = deliverHandoffs(input, checked, { running });
    forDelivery = undelivered(delivery).length > 0 && sendsBack(input, delivery);
  }
  if (config.telemetry.enabled) {
    // The causes in the order of dispatch-log.mjs SEND_BACK_CAUSES; the row's `sent_back` is true exactly when one holds.
    const sentBackFor = [
      ...(forChildren ? ['background'] : []),
      ...(forDelivery && delivery.missing.length ? ['missing_file'] : []),
      ...(forDelivery && (delivery.unwritten ?? []).length ? ['handoff'] : []),
      ...(forMarker ? ['marker'] : []),
      ...(forEvidence ? ['evidence'] : []),
    ];
    appendEvent(project, config, stopRow(input, project, { delivery, children: tasks, sentBackFor, docReads: config.telemetry.docReads }));
  }
  const agent = stopAgent(input);
  // The lesson's evidence names the agent's dispatch log row, which only telemetry writes.
  const agentId = config.telemetry.enabled ? agent.agent_id : null;
  // The cap let it end with a task still running: one lesson per run of send-backs, marked by a count past the cap.
  if (children.length && !forChildren && made <= CHILD_SEND_BACKS && typeof input.stop_hook_active === 'boolean') {
    storeChildSendBacks(input, CHILD_SEND_BACKS + 1);
    recordSignal(project, idleChildrenSignal({ agentType: agent.agent_type, agentId, session: agent.session_id, children, sendBacks: made }), { config });
  }
  const reasons = [];
  if (forDelivery) {
    // A path the brief's rejected marker names is never in `missing` (checkDelivery): it is never one to write.
    const { missing, unwritten = [] } = delivery;
    recordSignal(project, deliverySignal({ agentType: agent.agent_type, agentId, session: agent.session_id, missing, unwritten }), { config });
    if (missing.length) {
      reasons.push(
        `Your report names ${missing.map((file) => `\`${file}\``).join(', ')}, which does not exist. ` +
          'If you meant to write it, write it now; if the path is wrong, correct your report; if you removed it on purpose, say so.',
      );
    }
    if (unwritten.length) reasons.push(handoffReason(unwritten));
  }
  if (forMarker) reasons.push(rejectedReason(checked.rejected));
  if (forChildren) reasons.push(childrenReason(children, made + 1));
  if (forEvidence) {
    reasons.push(`${claimProblem(unsupported, unsupported[0].runs, { where: 'Your report' })} ` +
      'Correct the report: quote the output a finished run returned, or say which runs did not finish.');
  }
  if (reasons.length) deny(reasons.join('\n\n'));
}

if (isMain(import.meta.url)) await runHook(handle);
