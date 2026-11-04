// Reads a persona-audit report written before sidecars, best effort, into a draft sidecar (audits.mjs): its findings,
// Not reached lines, doc gaps, and the report it replaces. The draft is for the Human to check before it is written:
// `warnings` names what the prose could not settle, such as the findings of the replaced report this run did not
// re-check, which only a reader can judge, and evidence written as a suffix (`-24.jpg`) that matched no single file.
// Warnings name each finding by its title: a person reads them. A heading with no id, `### friction: <title>`, gets the
// key of its place in the report, F1 for the first.

import { readdirSync } from 'node:fs';
import path from 'node:path';

// A heading `### friction: the title`, or `### F3. friction: the title` in a report written before sidecars.
const FINDING = /^### (?:(F[1-9]\d*)\.\s+)?(blocker|friction|polish):\s*(.+?)\s*$/u;
// The first line of a finding: `- Persona: <ids>. Task: <tasks>. Evidence: <level>. Label: <label>.`, singular or plural.
// A finding about every task says `All tasks.` in place of the Task field.
const META = /Personas?:\s*(.+?)\.\s+(?:Tasks?:\s*(.+?)|(All tasks))\.\s+Evidence:\s*(walked|seen|read)\.\s+Label:\s*(observed|opinion)\b/u;
const IMAGE = /\.(?:png|jpe?g|gif|webp)$/iu;
const FILE_LINE = /^[\w./-]+:\d+(?:-\d+)?$/u;
// Words a finding uses when its cause was not found: such a finding gets `needs_trace`.
const UNTRACED = /\b(?:not traced|untraced|was not found|cause (?:is )?unknown)\b/iu;
const REPLACES = /This run replaces\b[^`\n]*`([^`]+\.md)`/u;
// A Not reached line about the replaced run, such as "its findings stand unverified": the not re-checked findings
// already carry it, so the triage offers it with them (audits.mjs pendingGroups).
const ABOUT_REPLACED = /\b(?:read-only|earlier|replaced|previous) (?:report|run)\b|\bnot re-?checked\b|\bstand unverified\b/iu;

// { version, report, personas, date, supersedes, carried_forward, not_rechecked, findings, not_reached, doc_gaps,
// warnings }. `report` is the file name; `dir`, the audits folder, lets a suffix such as `-24.jpg` become the one file
// in the report's folder whose name ends with it.
export function parseReport(text, { report, dir = null, ownerWords = {} } = {}) {
  const warnings = [];
  const name = /^(.+)-(\d{4}-\d{2}-\d{2})(?:-\d+)?\.md$/u.exec(report ?? '');
  const sections = splitSections(text);
  const findings = [];
  for (const [heading, lines] of sections.findings) {
    const [, id, severity, title] = FINDING.exec(heading);
    findings.push(readFinding({ id: id ?? `F${findings.length + 1}`, severity, title, lines, report, dir, ownerWords, warnings }));
  }
  const supersedes = REPLACES.exec(text)?.[1] ?? null;
  return {
    version: 1,
    report,
    personas: name ? name[1].split('+') : [],
    date: name ? name[2] : null,
    supersedes,
    carried_forward: [],
    not_rechecked: [],
    findings,
    not_reached: bullets(sections.not_reached).map((text, index) => ({ id: `N${index + 1}`, text, ...(supersedes && ABOUT_REPLACED.test(text) ? { covered_by: 'not_rechecked' } : {}) })),
    doc_gaps: bullets(sections.doc_gaps).map((text, index) => ({ id: `D${index + 1}`, text })),
    warnings,
  };
}

// The `### F<n>.` blocks of `## Findings`, and the lines of `## Not reached` and `## Persona doc gaps`.
function splitSections(text) {
  const out = { findings: [], not_reached: [], doc_gaps: [] };
  let section = null;
  let finding = null;
  for (const line of text.split('\n')) {
    const h2 = /^## (.+?)\s*$/u.exec(line);
    if (h2) {
      section = { Findings: 'findings', 'Not reached': 'not_reached', 'Persona doc gaps': 'doc_gaps' }[h2[1]] ?? null;
      finding = null;
      continue;
    }
    if (section === 'findings') {
      if (FINDING.test(line)) {
        finding = [line, []];
        out.findings.push(finding);
      } else if (finding) finding[1].push(line);
    } else if (section) out[section].push(line);
  }
  return out;
}

// Top-level `- ` items, each with its indented continuation lines joined.
function bullets(lines) {
  const items = [];
  for (const line of lines) {
    if (/^- /u.test(line)) items.push(line.slice(2).trim());
    else if (/^\s+\S/u.test(line) && items.length) items[items.length - 1] += ` ${line.trim()}`;
  }
  return items;
}

function readFinding({ id, severity, title, lines, report, dir, ownerWords, warnings }) {
  const body = bullets(lines);
  const meta = body.map((line) => META.exec(line)).find(Boolean);
  const field = (label) => body.find((line) => line.startsWith(`${label}:`))?.slice(label.length + 1).trim() ?? null;
  const ownerLine = field('Owner') ?? '';
  const roles = [...ownerLine.matchAll(/`([a-z0-9-]+)`/gu)].map((match) => match[1]);
  const spans = body.flatMap((line) => [...line.matchAll(/`([^`]+)`/gu)].map((match) => match[1]));
  const evidence = [];
  for (const span of spans.filter((each) => IMAGE.test(each))) {
    const full = span.startsWith('-') ? expandShorthand(span, report, dir) : span;
    if (full) {
      if (!evidence.includes(full)) evidence.push(full);
    } else warnings.push(`"${title}": the screenshot "${span}" matched no single file in the report's folder, so it is left out`);
  }
  const cited = spans.filter((each) => FILE_LINE.test(each));
  const seen = field('Seen') ?? field('Cited');
  if (!evidence.length && !cited.length && seen) cited.push(seen);
  const owner = roles[0] ?? null;
  if (!meta) warnings.push(`"${title}": no "Persona: ... Task: ... Evidence: ... Label: ..." line`);
  if (!owner) warnings.push(`"${title}": no owner in backticks on its Owner line`);
  const words = ownerWords[owner];
  if (owner && !words) warnings.push(`"${title}": write owner_description, in plain words, for ${owner}`);
  const finding = {
    id,
    title,
    severity,
    label: meta?.[5] ?? 'opinion',
    evidence_level: meta?.[4] ?? 'read',
    personas: meta ? meta[1].split(/,\s*/u) : [],
    tasks: meta ? (meta[2]?.split(/;\s*/u) ?? [meta[3]]) : [],
    owner,
    owner_description: words ?? owner ?? '',
    ...(roles.length > 1 ? { other_owners: [...new Set(roles.slice(1))] } : {}),
    evidence,
    ...(cited.length ? { cited } : {}),
    needs_trace: UNTRACED.test(body.join(' ')),
  };
  return finding;
}

// `-24.jpg` in the report `<name>.md`: the one file in `<dir>/<name>/` whose name ends with `-24.jpg`, as
// `<name>/<file>`; null when there is no folder or not exactly one match.
function expandShorthand(span, report, dir) {
  if (!dir || !report) return null;
  const folder = report.replace(/\.md$/u, '');
  let files;
  try {
    files = readdirSync(path.join(dir, folder));
  } catch {
    return null;
  }
  const matches = files.filter((file) => file.endsWith(span));
  return matches.length === 1 ? `${folder}/${matches[0]}` : null;
}
