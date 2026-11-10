// SubagentStop hook (Claude Code): one `stop` row in the dispatch log, then two checks that can send the subagent back.
// The delivery check: every .md or .json path the subagent's last message names must exist; when one does not, it is sent
// back once, on the first stop of its turn, to write it or correct its report, and the send-back is recorded as a lesson
// for that agent type (lib/lesson-signals.mjs).
// The background check: no background shell or agent it started may still run (runningChildren). A subagent that ends its
// turn goes idle: a shell task's end notice wakes it, but a subagent task's handback to an idle agent is refused, and the
// work it waits on stalls until something else wakes it. So it is told to wait in the foreground, and sent back again at
// each stop while such a task runs, up to CHILD_SEND_BACKS in a row (lib/child-send-backs.mjs): one send-back did not hold,
// since a foreground wait that outlives its timeout is moved to the background, and a watch armed instead is another task.
// The stop the cap lets end with a task still running is recorded as a lesson for the plugin. The count is stored before
// each send-back past the first, and a count that cannot be stored ends the stop, so no host can loop on it; a payload
// without `stop_hook_active` (another host) is never sent back (sendsBack). The row's `sent_back` records the decision.
// config.json `telemetry.enabled: false` drops the row, never the checks or the lessons.

import { CHILD_SEND_BACKS, childSendBacks, forgetChildSendBacks, storeChildSendBacks } from '../lib/child-send-backs.mjs';
import { loadConfig } from '../lib/config.mjs';
import { appendEvent } from '../lib/dispatch-log.mjs';
import { checkDelivery, runningChildren, sendsBack, stopAgent, stopRow } from '../lib/dispatch-rows.mjs';
import { deny, runHook } from '../lib/hook-io.mjs';
import { deliverySignal, idleChildrenSignal, recordSignal } from '../lib/lesson-signals.mjs';
import { findProject } from '../lib/project.mjs';

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

// Whether the background check sends the subagent back on this stop, given `made` send-backs so far: the count is stored
// first, and a stop past the first of its turn whose count cannot be stored is let end.
function childrenSendBack(input, children, made) {
  if (!children.length || !sendsBack(input, { missing: [] }, children, made)) return false;
  return storeChildSendBacks(input, made + 1) || input.stop_hook_active === false;
}

await runHook((input) => {
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (!project) return;
  const { config } = loadConfig(project);
  const delivery = checkDelivery(input, project);
  const children = runningChildren(input);
  const made = children.length ? childSendBacks(input) : 0;
  if (!children.length) forgetChildSendBacks(input);
  const forChildren = childrenSendBack(input, children, made);
  const forDelivery = delivery.missing.length > 0 && sendsBack(input, delivery);
  if (config.telemetry.enabled) {
    appendEvent(project, config, stopRow(input, project, { delivery, children, sentBack: forChildren || forDelivery, docReads: config.telemetry.docReads }));
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
    const { missing } = delivery;
    recordSignal(project, deliverySignal({ agentType: agent.agent_type, agentId, session: agent.session_id, missing }), { config });
    reasons.push(
      `Your report names ${missing.map((file) => `\`${file}\``).join(', ')}, which does not exist. ` +
        'If you meant to write it, write it now; if the path is wrong, correct your report; if you removed it on purpose, say so.',
    );
  }
  if (forChildren) reasons.push(childrenReason(children, made + 1));
  if (reasons.length) deny(reasons.join('\n\n'));
});
