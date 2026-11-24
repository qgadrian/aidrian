// The guard that keeps every session, attended or not, and its subagents from writing an override into a host settings
// file: an `AIDRIAN_ALLOW_*` name in a settings file's `env` reaches every later session's hooks there, so it turns a
// guard off for each of them, unseen. An override is the Human's, set in their own shell before a session
// (docs/hooks.md#overrides). scripts/hook-agent-gates.mjs asks it before every tool call.
//
// It reads the targets as the config guard does (config-guard.mjs writeTargets): a file tool's by the path it names, and
// a Bash command's by the paths it writes and the names an interpreter or an unreadable shell gives. A call whose own
// text names no override passes: like every guard of the command text it stops accidents, not someone set on getting
// around it, so a name built at run time, and a copy or move of a file that already holds one, pass.

import path from 'node:path';

import { projectRuleReason } from './agent-gates.mjs';
import { writeTargets } from './config-guard.mjs';
import { foldCase } from './fs.mjs';
import { envSettingsFiles } from './hosts/index.mjs';
import { canonical } from './rules/main-checkout.mjs';

// An override's name, as a text spells it once each JSON escape, such as `\u0041`, is read as its letter, since a
// settings file reads a name so spelled the same.
const OVERRIDE_NAME = /AIDRIAN_ALLOW_/u;
const unescaped = (text) => text.replace(/\\u([0-9a-fA-F]{4})/gu, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));

// Every text in a tool's input, at any depth, as the tool takes it.
const texts = (value) => {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(texts);
  return [];
};

// Why the call in `input` may not run because it writes an override into one of the host settings files of `project`'s
// checkouts or the user's (hosts/index.mjs envSettingsFiles), or null: { match, reason }. `project` is null outside a
// project, where only the user's settings count. The call's whole input is read for the name, so a write tool's
// content and an edit's replacement text count alike; an edit that only removes one is refused too, since the Human
// sets and lifts overrides.
export function overrideSettingsDenial(input, project, { names: { human } }, { env = process.env } = {}) {
  if (!texts(input.tool_input).some((text) => OVERRIDE_NAME.test(unescaped(text)))) return null;
  const settings = envSettingsFiles(project?.checkouts ?? [], env);
  if (!settings.length) return null;
  const real = (file) => foldCase(canonical(file));
  const files = new Map(settings.map((file) => [real(file), file]));
  const { files: targets, names } = writeTargets(input);
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const hit = [...targets, ...names.map((name) => path.resolve(cwd, name))].map((each) => files.get(real(each))).find(Boolean);
  if (!hit) return null;
  const why = `it writes an AIDRIAN_ALLOW_* override into ${hit}, whose env reaches every later session's hooks and turns a guard off for each of them unseen; an override is ${human}'s alone, set in their own shell before a session starts`;
  return { match: `override in ${hit}`, reason: projectRuleReason(input, why, human, 'whether to set the override in their own shell') };
}
