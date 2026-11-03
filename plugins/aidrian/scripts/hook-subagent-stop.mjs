// SubagentStop hook (Claude Code): one `stop` row in the dispatch log, then two checks that can send the subagent back
// once. The delivery check: every .md or .json path the subagent's last message names must exist; when one does not, it
// writes it or corrects its report, and the send-back is recorded as a lesson for that agent type (lib/lesson-signals.mjs).
// The background check: no background shell or agent it started may still run (runningChildren), because a subagent that
// ends its turn goes idle and the task's completion never wakes it; it is told to wait in the foreground. A second stop
// with one still running is recorded as a lesson for the plugin.
// `stop_hook_active` marks that second stop, which always ends; a payload without that field (another host) is never
// sent back, so no host can loop on it (sendsBack). The row's `sent_back` records the same decision. config.json
// `telemetry.enabled: false` drops the row, never the checks or the lessons.

import { loadConfig } from '../lib/config.mjs';
import { appendEvent } from '../lib/dispatch-log.mjs';
import { checkDelivery, runningChildren, sendsBack, stopAgent, stopRow } from '../lib/dispatch-rows.mjs';
import { deny, runHook } from '../lib/hook-io.mjs';
import { deliverySignal, idleChildrenSignal, recordSignal } from '../lib/lesson-signals.mjs';
import { findProject } from '../lib/project.mjs';

// What the subagent is told when a background task it started still runs.
const childrenReason = (children) =>
  `You started background work that is still running: ${children
    .map((child) => `\`${child.id}\` (${child.type}${child.description ? `: ${child.description}` : ''})`)
    .join(', ')}. ` +
  'Ending your turn now leaves you idle, and its end will not wake you. Wait for it in the foreground before you end the turn: ' +
  'poll it with a foreground command and a timeout, such as an until-loop on its output file or process, and repeat the call ' +
  'until it finishes. If it should not outlive this turn, stop it with TaskStop. ' +
  'Next time, run a long push or CI wait as a foreground command with a timeout, and a reviewer agent in the foreground.';

await runHook((input) => {
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (!project) return;
  const { config } = loadConfig(project);
  const delivery = checkDelivery(input, project);
  const children = runningChildren(input);
  if (config.telemetry.enabled) {
    appendEvent(project, config, stopRow(input, project, { delivery, children, docReads: config.telemetry.docReads }));
  }
  const agent = stopAgent(input);
  // The lesson's evidence names the agent's dispatch log row, which only telemetry writes.
  const agentId = config.telemetry.enabled ? agent.agent_id : null;
  if (children.length && input.stop_hook_active === true) {
    recordSignal(project, idleChildrenSignal({ agentType: agent.agent_type, agentId, session: agent.session_id, children }), { config });
  }
  if (!sendsBack(input, delivery, children)) return;
  const { missing } = delivery;
  const reasons = [];
  if (missing.length) {
    recordSignal(project, deliverySignal({ agentType: agent.agent_type, agentId, session: agent.session_id, missing }), { config });
    reasons.push(
      `Your report names ${missing.map((file) => `\`${file}\``).join(', ')}, which does not exist. ` +
        'If you meant to write it, write it now; if the path is wrong, correct your report; if you removed it on purpose, say so.',
    );
  }
  if (children.length) reasons.push(childrenReason(children));
  deny(reasons.join('\n\n'));
});
