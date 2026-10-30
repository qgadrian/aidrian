// SubagentStop hook (Claude Code): one `stop` row in the dispatch log, then the delivery check. Every .md or .json path
// the subagent's last message names must exist; when one does not, the subagent is sent back once to write it or
// correct its report. `stop_hook_active` marks that second stop, which always ends; a payload without that field
// (another host) is never sent back, so no host can loop on it. config.json `telemetry.enabled: false` drops the row,
// never the check.

import { loadConfig } from '../lib/config.mjs';
import { appendEvent, checkDelivery, stopRow } from '../lib/dispatch-log.mjs';
import { deny, runHook } from '../lib/hook-io.mjs';
import { findProject } from '../lib/project.mjs';

await runHook((input) => {
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (!project) return;
  const { config } = loadConfig(project);
  const delivery = checkDelivery(input, project);
  if (config.telemetry.enabled) appendEvent(project, config, stopRow(input, project, { delivery, docReads: config.telemetry.doc_reads }));
  const { missing } = delivery;
  if (!missing.length || input.stop_hook_active !== false) return;
  deny(
    `Your report names ${missing.map((file) => `\`${file}\``).join(', ')}, which does not exist. ` +
      'If you meant to write it, write it now; if the path is wrong, correct your report; if you removed it on purpose, say so.',
  );
});
