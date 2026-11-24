// The host transcripts a project run reads custody from: a host records in the old session's transcript that it went on
// as another session (`capabilities.continuedIn`), and under the team's projectRun.fullAuto that row alone lets the session
// it names take the run's custody with no person (lib/project-run-gate.mjs resumeRun). No session needs to write a
// transcript, so until the project's run records its end the agent gate hook refuses every session and subagent a write
// under a host's transcript folder (scripts/hook-agent-gates.mjs), but in a project folder's `memory` folder, where a
// host keeps its memory, and a write to the folder or a folder above it, as a removal or a move of the host's config
// folder or the home folder is. One rule, failing closed, for a literal path and a glob alike, which counts by its
// literal prefix alone.
// Accepted residuals: a script that writes the file, which the hooks never see, as for a forged typed turn; a link
// already on disk that a write passes through, since the guard is for cooperating agents (docs/hooks.md); and a glob
// that starts above the transcript folder, such as one beside a host's config folder, is refused though it may reach none.

import { userInfo } from 'node:os';
import path from 'node:path';

import { projectRuleReason } from './agent-gates.mjs';
import { writeTargets } from './config-guard.mjs';
import { foldCase, isWithin } from './fs.mjs';
import { globPaths } from './handoff-guard.mjs';
import { transcriptFolders } from './hosts/index.mjs';
import { canonical } from './rules/main-checkout.mjs';

const real = (file) => foldCase(canonical(file));
// A transcript as a text from a folder no path gives spells it: `projects/<folder>/<session>.jsonl`.
const SPELLED = /(?:^|[\\/])projects[\\/][^\\/\s'"]+[\\/][^\\/\s'"]+\.jsonl(?![\w.-])/iu;

// Whether the real path `target` lies under the real transcript folder `folder`, the folder itself included, and outside
// the `memory` folder of a project folder in it.
function underTranscripts(folder, target) {
  if (!isWithin(folder, target)) return false;
  const parts = path.relative(folder, target).split(path.sep).filter(Boolean);
  return !(parts.length >= 2 && parts[1] === foldCase('memory'));
}

// Whether a write to the real path `target`, a literal one or a glob's literal prefix, the parts before its first
// wildcard (handoff-guard.mjs globPaths), may change a transcript of `folder`: it lies under the folder as
// underTranscripts reads it, or is the folder or a folder above it, which a removal or a move takes along.
const reaches = (folder, target) => isWithin(target, folder) || underTranscripts(folder, target);

// Why the call in `input` may not run because it writes a host's session transcript while `runSession()` says the
// call's project has a project run whose ledger records no end (project-run-guard.mjs projectRunActive with
// `untilEnd`, the runs whose custody may still move), or null: { match, reason }. It
// holds for every session and subagent, attended or not, and asks `runSession()` only for a call that reaches one.
// `folders` are the host's transcript folders (hosts/index.mjs transcriptFolders), under this user's home and where the
// hook's environment moves a host's config folder.
export function transcriptWriteDenial(input, { names: { human } }, { runSession = () => false, folders = transcriptFolders(userInfo().homedir) } = {}) {
  const { files, names, globs } = writeTargets(input);
  if (files.length === 0 && names.length === 0 && globs.length === 0) return null;
  const guarded = folders.map(real);
  const placed = files.map(real);
  const hit = names.some((text) => SPELLED.test(text))
    || globs.some((glob) => (glob.unsure || glob.opaque) && SPELLED.test(glob.text))
    || guarded.some((folder) => placed.some((target) => reaches(folder, target))
      || globs.filter((glob) => !glob.unsure).flatMap(globPaths).some(({ prefix }) => reaches(folder, prefix)));
  if (!hit || !runSession()) return null;
  const why = 'it may change a host\'s session transcript, which a project run reads its driver\'s continuation from, and no session or subagent writes one while a project run is under way';
  return { match: 'may change a host\'s session transcript', reason: projectRuleReason(input, why, human) };
}
