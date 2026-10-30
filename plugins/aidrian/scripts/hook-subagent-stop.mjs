// SubagentStop hook (Claude Code): one `stop` row in the dispatch log, then the delivery check. Every .md or .json path
// the subagent's last message names must exist; when one does not, the subagent is sent back once to write it or
// correct its report, and the send-back is recorded as a lesson for that agent type (lib/lesson-signals.mjs).
// `stop_hook_active` marks that second stop, which always ends; a payload without that field (another host) is never
// sent back, so no host can loop on it.

import { deny, runHook } from '../lib/hook-io.mjs';
import { logPath, stopRow } from '../lib/dispatch-log.mjs';
import { appendRow } from '../lib/jsonl.mjs';
import { deliverySignal, recordSignal } from '../lib/lesson-signals.mjs';
import { findProject } from '../lib/project.mjs';

await runHook((input) => {
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (!project) return;
  const { row, missing } = stopRow(input, project);
  appendRow(logPath(project), row);
  if (!missing.length || input.stop_hook_active !== false) return;
  recordSignal(project, deliverySignal({ agentType: row.agent_type, agentId: row.agent_id, session: row.session_id, missing }));
  deny(
    `Your report names ${missing.map((file) => `\`${file}\``).join(', ')}, which does not exist. ` +
      'If you meant to write it, write it now; if the path is wrong, correct your report; if you removed it on purpose, say so.',
  );
});
