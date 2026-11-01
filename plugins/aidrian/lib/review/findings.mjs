// A pass's findings one by one, for `aidrian pr attest --pass <id> --findings-file <file>`: each finding carries its
// axes (severity, likelihood, affects, cost) and its state (open, fixed, accepted), and finding-disposition.json
// decides which still block. Counts alone let a reviewer call anything accepted; per-finding axes let the table
// decide. docs/review.md#findings describes the file.

import { isObject } from '../fs.mjs';
import { decideDisposition } from '../finding-disposition.mjs';

export const FINDING_STATES = Object.freeze(['open', 'fixed', 'accepted']);
// The dispositions an accepted finding may close with. fix_now never closes until it is fixed, and a finding with
// no axes, or words the table does not know, stays open until it is classified.
const ACCEPTABLE = new Set(['accepted_residual', 'acceptable_as_is', 'drop_unless_cited']);
export const MAX_FINDINGS = 200;

// Whether one classified finding still blocks its pass: open and not acceptable as-is, or accepted with a disposition
// that cannot be accepted.
export function blocks(finding) {
  if (finding.state === 'fixed') return false;
  if (!ACCEPTABLE.has(finding.disposition)) return true;
  return finding.state === 'open' && finding.disposition !== 'acceptable_as_is';
}

const text = (value, max) => (typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null);

// { list, findings, fixed, accepted, open } from the file's text, or throws on a malformed file. The list keeps each
// finding with its disposition, so `fix_required` shows the reviewer's words and the table's decision together.
export function parseFindings(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('--findings-file must be a JSON file');
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.findings;
  if (!Array.isArray(list)) throw new Error('--findings-file must hold a list of findings, or { "findings": [...] }');
  if (list.length > MAX_FINDINGS) throw new Error(`--findings-file holds ${list.length} findings, past ${MAX_FINDINGS}`);
  const out = list.map((finding, i) => {
    const at = `--findings-file[${i}]`;
    if (!isObject(finding)) throw new Error(`${at} must be an object`);
    const title = text(finding.title, 200);
    if (!title) throw new Error(`${at} needs a title`);
    if (!FINDING_STATES.includes(finding.state)) throw new Error(`${at}.state must be ${FINDING_STATES.join(', ')}`);
    if (finding.line !== undefined && !(Number.isInteger(finding.line) && finding.line >= 1)) throw new Error(`${at}.line must be a line number`);
    const axes = { severity: finding.severity, likelihood: finding.likelihood, affects: finding.affects, cost: finding.cost };
    const decided = decideDisposition(Object.fromEntries(Object.entries(axes).filter(([, value]) => value !== undefined)));
    if (decided.disposition === 'invalid') throw new Error(`${at}: ${decided.reason} (\`aidrian pr disposition --vocab\` lists the words)`);
    return {
      title,
      ...(text(finding.file, 300) ? { file: text(finding.file, 300) } : {}),
      ...(finding.line ? { line: finding.line } : {}),
      ...(text(finding.body, 2000) ? { body: text(finding.body, 2000) } : {}),
      ...Object.fromEntries(Object.entries(axes).filter(([, value]) => typeof value === 'string')),
      ...(text(finding.evidence, 300) ? { evidence: text(finding.evidence, 300) } : {}),
      state: finding.state,
      disposition: decided.disposition,
    };
  });
  const fixed = out.filter((finding) => finding.state === 'fixed').length;
  const open = out.filter(blocks).length;
  return { list: out, findings: out.length, fixed, accepted: out.length - fixed - open, open };
}
