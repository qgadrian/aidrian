#!/usr/bin/env node
// Copies the aidrian Codex agent roles into Codex's agent folder.
//
//   node install-agents.mjs                 into ${CODEX_HOME:-~/.codex}/agents
//   node install-agents.mjs --target DIR    into DIR, for example a project's .codex/agents
//
// Codex plugins cannot ship agents, so this step installs them. It writes only aidrian-*.toml files,
// removes aidrian-*.toml files this version no longer ships, and leaves every other file alone.
// Into a folder inside a project, each role also gets the project's `models.codex` choice (docs/config.md#models).
// Run it again after each plugin update and each change to that choice. New roles take effect in the next Codex session.

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { codexRole } from '../lib/agent-models.mjs';
import { loadConfig } from '../lib/config.mjs';
import { findProject } from '../lib/project.mjs';

const PREFIX = 'aidrian-';
const source = path.join(import.meta.dirname, 'agents');
// Any other argument fails: a mistyped flag must not fall back to the default folder and remove roles there.
// An option's value never starts with "-": `--target --force` is a missing folder, not a folder named --force.
const [flag, targetDir, ...extra] = process.argv.slice(2);
if (flag !== undefined && flag !== '--target') fail(`unknown argument: ${flag}`);
if (flag && (!targetDir || targetDir.startsWith('-'))) fail('--target needs a folder.');
if (extra.length) fail(`unknown argument: ${extra[0]}`);
const target = targetDir
  ? path.resolve(targetDir)
  : path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'agents');

const ours = (dir) => readdirSync(dir).filter((file) => file.startsWith(PREFIX) && file.endsWith('.toml'));
const agentName = (file) => file.slice(PREFIX.length, -'.toml'.length);
const shipped = ours(source);
const models = codexModels(findProject(target));
mkdirSync(target, { recursive: true });

const changes = { added: [], updated: [], removed: [] };
const installed = new Set(ours(target));
for (const file of shipped) {
  const to = path.join(target, file);
  const role = codexRole(readFileSync(path.join(source, file), 'utf8'), models[agentName(file)]);
  if (installed.has(file) && readFileSync(to, 'utf8') === role) continue;
  // Write a temporary file and rename it, so a Codex session starting meanwhile never reads half a role.
  const tmp = path.join(target, `.${file}.${process.pid}`);
  writeFileSync(tmp, role);
  renameSync(tmp, to);
  changes[installed.has(file) ? 'updated' : 'added'].push(file);
}
for (const file of installed) {
  if (shipped.includes(file)) continue;
  rmSync(path.join(target, file));
  changes.removed.push(file);
}

const summary = Object.entries(changes)
  .filter(([, files]) => files.length)
  .map(([kind, files]) => `${kind} ${files.map((file) => file.replace(/\.toml$/, '')).join(', ')}`);
console.log(summary.length
  ? `aidrian Codex agents in ${target}: ${summary.join('; ')}. They take effect in the next Codex session.`
  : `aidrian Codex agents in ${target} are up to date (${shipped.length}).`);
const chosen = shipped.map(agentName).filter((name) => Object.hasOwn(models, name));
const shown = (name) => `${name} (${Object.entries(models[name]).map((pair) => pair.join(' ')).join(', ')})`;
if (chosen.length) {
  console.log(`From the project's models.codex: ${chosen.map(shown).join('; ')}.`);
} else if (!targetDir) {
  // The user folder serves every project, so one project's choice cannot go there.
  const here = findProject(process.cwd());
  if (here && Object.keys(codexModels(here)).length) {
    const projectTarget = path.relative(process.cwd(), path.join(here.root, '.codex/agents'));
    console.log(`This project sets models.codex, which only a project install applies: --target ${projectTarget}`);
  }
}

// The project's model and effort per agent, or none outside a project.
function codexModels(project) {
  return project ? loadConfig(project).config.models.codex.agents : {};
}

function fail(problem) {
  console.error(`usage: node install-agents.mjs [--target DIR]\n${problem}`);
  process.exit(1);
}
