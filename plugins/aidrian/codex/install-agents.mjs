#!/usr/bin/env node
// Copies the aidrian Codex agent roles into Codex's agent folder.
//
//   node install-agents.mjs                 into ${CODEX_HOME:-~/.codex}/agents
//   node install-agents.mjs --target DIR    into DIR, for example a project's .codex/agents
//
// Codex plugins cannot ship agents, so this step installs them. It writes only aidrian-*.toml files,
// removes aidrian-*.toml files this version no longer ships, and leaves every other file alone.
// Run it again after each plugin update. New roles take effect in the next Codex session.

import { copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const PREFIX = 'aidrian-';
const source = path.join(import.meta.dirname, 'agents');
const args = process.argv.slice(2);
const targetFlag = args.indexOf('--target');
const target = targetFlag >= 0
  ? path.resolve(args[targetFlag + 1] ?? '')
  : path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'agents');

const ours = (dir) => readdirSync(dir).filter((file) => file.startsWith(PREFIX) && file.endsWith('.toml'));
const shipped = ours(source);
mkdirSync(target, { recursive: true });

const changes = { added: [], updated: [], removed: [] };
const installed = new Set(ours(target));
for (const file of shipped) {
  const to = path.join(target, file);
  if (installed.has(file) && readFileSync(to, 'utf8') === readFileSync(path.join(source, file), 'utf8')) continue;
  // Write a temporary file and rename it, so a Codex session starting meanwhile never reads half a role.
  const tmp = path.join(target, `.${file}.${process.pid}`);
  copyFileSync(path.join(source, file), tmp);
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
