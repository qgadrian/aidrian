// SubagentStop hook (Claude Code): one `stop` row in the dispatch log, then the delivery check. Every .md or .json path
// the subagent's last message names must exist; when one does not, the subagent is sent back once to write it or
// correct its report, and the send-back is recorded as a lesson for that agent type (lib/lesson-signals.mjs).
// `stop_hook_active` marks that second stop, which always ends; a payload without that field (another host) is never
// sent back, so no host can loop on it. config.json `telemetry.enabled: false` drops the row, never the check or the lesson.

import { loadConfig } from '../lib/config.mjs';
import { appendEvent, checkDelivery, stopAgent, stopRow } from '../lib/dispatch-log.mjs';
import { deny, runHook } from '../lib/hook-io.mjs';
import { deliverySignal, recordSignal } from '../lib/lesson-signals.mjs';
import { findProject } from '../lib/project.mjs';

await runHook((input) => {
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (!project) return;
  const { config } = loadConfig(project);
  const delivery = checkDelivery(input, project);
  if (config.telemetry.enabled) appendEvent(project, config, stopRow(input, project, { delivery, docReads: config.telemetry.docReads }));
  const { missing } = delivery;
  if (!missing.length || input.stop_hook_active !== false) return;
  const agent = stopAgent(input);
  // The lesson's evidence names the agent's dispatch log row, which only telemetry writes.
  const agentId = config.telemetry.enabled ? agent.agent_id : null;
  recordSignal(project, deliverySignal({ agentType: agent.agent_type, agentId, session: agent.session_id, missing }), { config });
  deny(
    `Your report names ${missing.map((file) => `\`${file}\``).join(', ')}, which does not exist. ` +
      'If you meant to write it, write it now; if the path is wrong, correct your report; if you removed it on purpose, say so.',
  );
});
