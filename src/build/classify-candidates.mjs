import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { readJsonFile } from './safe-files.mjs';
import { parseStrictOptions } from './strict-args.mjs';

const parseArgs = (args) => parseStrictOptions(args, {
  '--inventory': { name: 'inventory', required: true },
  '--allowlist': { name: 'allowlist', required: true },
  '--dispositions': { name: 'dispositions', required: true },
  '--out': { name: 'output', required: true },
});

const unique = (items) => [...new Set(items)].sort();

const assertSelectionIdentity = (kind, selection, entry) => {
  if (!selection) return;
  if (!/^[a-f0-9]{64}$/.test(selection.sourceSha256 ?? '')) throw new Error(`${selection.id}: invalid selected ${kind} sourceSha256`);
  if (!entry) throw new Error(`${selection.id}: selected ${kind} is missing from the candidate inventory`);
  if (selection.sourceSha256 !== entry.sourceSha256) throw new Error(`${selection.id}: selected ${kind} sourceSha256 does not match the candidate inventory`);
};

export const classifyCandidates = (inventory, allowlist, dispositions) => {
  const selectedAgents = new Map(allowlist.agents.map((entry) => [entry.id, entry.disposition ?? 'shared']));
  const selectedSkills = new Map(allowlist.skills.map((entry) => [entry.id, entry.disposition ?? 'shared']));
  const agents = inventory.entries
    .filter((entry) => entry.path.match(/^\.claude\/agents\/[^/]+\.md$/))
    .map((entry) => {
      const id = path.posix.basename(entry.path, '.md');
      const selection = allowlist.agents.find((item) => item.id === id) ?? null;
      assertSelectionIdentity('agent', selection, entry);
      const disposition = selectedAgents.get(id) ?? 'project-owned';
      if (disposition === 'composed' && !dispositions.agents[id]) throw new Error(`${id}: composed agent is missing a content-based disposition`);
      return {
        id,
        disposition,
        reason: disposition === 'shared'
          ? 'positive private allowlist with a reviewed neutral base and typed project-slot seam'
          : disposition === 'composed'
            ? dispositions.agents[id]
          : dispositions.agents[id] ?? (entry.proposedDisposition === 'shared-candidate'
            ? 'Project-owned pending a reviewed semantic extraction; the source remains authoritative because no bounded provider-neutral contract exists.'
            : 'source inventory classifies the role outside the shared harness boundary'),
        metadata: {
          sourcePath: entry.sourcePath,
          sourceSha256: entry.sourceSha256,
          proposedDisposition: entry.proposedDisposition,
          internalUseAuthority: entry.internalUseAuthority,
          publicEligibility: entry.publicEligibility,
          selection,
        },
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const groupedSkills = new Map();
  for (const entry of inventory.entries.filter((item) => item.path.startsWith('.agents/skills/'))) {
    const id = entry.path.slice('.agents/skills/'.length).split('/')[0];
    const group = groupedSkills.get(id) ?? [];
    group.push(entry);
    groupedSkills.set(id, group);
  }
  const skills = [...groupedSkills]
    .filter(([, entries]) => entries.some((entry) => entry.path.endsWith('/SKILL.md')))
    .map(([id, entries]) => {
      const selection = allowlist.skills.find((item) => item.id === id) ?? null;
      const entrypoint = entries.find((entry) => entry.path === `.agents/skills/${id}/SKILL.md`);
      assertSelectionIdentity('skill', selection, entrypoint);
      const candidate = entries.every((entry) => entry.proposedDisposition === 'shared-candidate');
      const disposition = selectedSkills.get(id) ?? 'project-owned';
      if (disposition === 'composed' && !dispositions.skills[id]) throw new Error(`${id}: composed skill is missing a content-based disposition`);
      return {
        id,
        disposition,
        reason: disposition === 'shared'
          ? 'positive private allowlist with an Agent Skills-compatible semantic source'
          : disposition === 'composed'
            ? dispositions.skills[id]
          : dispositions.skills[id] ?? (candidate
            ? 'Project-owned pending a reviewed semantic extraction; its repository-side workflow contract remains authoritative.'
            : 'source inventory classifies the skill outside the shared harness boundary'),
        metadata: {
          sourcePaths: entries.map((entry) => entry.sourcePath).sort(),
          sourceSha256: entries.map((entry) => entry.sourceSha256).sort(),
          proposedDispositions: unique(entries.map((entry) => entry.proposedDisposition)),
          internalUseAuthorities: entries.map((entry) => entry.internalUseAuthority),
          publicEligibility: entries.map((entry) => entry.publicEligibility),
          selection,
        },
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const actualSharedAgents = unique(agents.filter((entry) => entry.disposition === 'shared').map((entry) => entry.id));
  const actualSharedSkills = unique(skills.filter((entry) => entry.disposition === 'shared').map((entry) => entry.id));
  const actualComposedAgents = unique(agents.filter((entry) => entry.disposition === 'composed').map((entry) => entry.id));
  const actualComposedSkills = unique(skills.filter((entry) => entry.disposition === 'composed').map((entry) => entry.id));
  const actualSelectedAgents = unique([...actualSharedAgents, ...actualComposedAgents]);
  const actualSelectedSkills = unique([...actualSharedSkills, ...actualComposedSkills]);
  if (JSON.stringify(actualSelectedAgents) !== JSON.stringify([...selectedAgents.keys()].sort())) throw new Error('agent allowlist contains an ID absent from the candidate inventory');
  if (JSON.stringify(actualSelectedSkills) !== JSON.stringify([...selectedSkills.keys()].sort())) throw new Error('skill allowlist contains an ID absent from the candidate inventory');
  return { schemaVersion: 1, sourceCommit: inventory.source.commit, agents, skills, summary: { agents: agents.length, skills: skills.length, sharedAgents: actualSharedAgents.length, sharedSkills: actualSharedSkills.length, composedAgents: actualComposedAgents.length, composedSkills: actualComposedSkills.length, implicitIncludes: 0 } };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const inventory = await readJsonFile(path.dirname(args.inventory), args.inventory, { label: 'candidate inventory' });
  const allowlist = await readJsonFile(path.dirname(args.allowlist), args.allowlist, { label: 'private allowlist' });
  const dispositions = await readJsonFile(path.dirname(args.dispositions), args.dispositions, { label: 'candidate dispositions' });
  const report = classifyCandidates(inventory, allowlist, dispositions);
  await writeFile(args.output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report.summary)}\n`);
}
