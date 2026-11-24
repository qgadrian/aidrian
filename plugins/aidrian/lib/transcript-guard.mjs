// The host transcripts a project run reads custody from: a host records in the old session's transcript that it went on
// as another session (`capabilities.continuedIn`), and under the team's projectRun.fullAuto that row alone lets the session
// it names take the run's custody with no person (lib/project-run-gate.mjs resumeRun). No session needs to write a
// transcript, so while the project has a run under way the agent gate hook refuses every session and subagent a write
// that reaches one (scripts/hook-agent-gates.mjs): a host's transcript folder, a project folder in it, or a `.jsonl`
// file in one of those. Deeper entries, such as a host's memory folder inside a project folder, stay writable.
// Accepted residual: a script that writes the file, which the hooks never see, as for a forged typed turn.

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

// Whether the real path `target` is a transcript place of the real transcript folder `folder`: the folder itself, a
// project folder in it, or a `.jsonl` file in one of those.
function transcriptPlace(folder, target) {
  if (!isWithin(folder, target)) return false;
  const parts = path.relative(folder, target).split(path.sep).filter(Boolean);
  return parts.length <= 1 || (parts.length === 2 && parts[1].toLowerCase().endsWith('.jsonl'));
}

// Whether a glob write from a known folder, { prefix, rest } (handoff-guard.mjs globPaths), may reach a transcript place
// of `folder`: it starts at or above the folder, or in the folder or one of its project folders.
function globReachesTranscript(folder, { prefix }) {
  if (isWithin(prefix, folder)) return true;
  if (!isWithin(folder, prefix)) return false;
  return path.relative(folder, prefix).split(path.sep).filter(Boolean).length <= 1;
}

// Why the call in `input` may not run because it writes a host's session transcript while `runSession()` says the
// call's project has a project run under way (project-run-guard.mjs projectRunActive), or null: { match, reason }. It
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
    || guarded.some((folder) => placed.some((target) => transcriptPlace(folder, target))
      || globs.filter((glob) => !glob.unsure).flatMap(globPaths).some((each) => globReachesTranscript(folder, each)));
  if (!hit || !runSession()) return null;
  const why = 'it may change a host\'s session transcript, which a project run reads its driver\'s continuation from, and no session or subagent writes one while a project run is under way';
  return { match: 'may change a host\'s session transcript', reason: projectRuleReason(input, why, human) };
}
