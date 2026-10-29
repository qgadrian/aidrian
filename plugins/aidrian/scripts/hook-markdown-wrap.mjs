// PostToolUse hook for Edit and Write: reports the Markdown lines the write made longer than config.json
// `docs.wrapLimit`. It reads the whole file, so fences and frontmatter are right, and reports only the lines the write
// touched. The write already happened, so exit 2 is feedback: the agent fixes the lines with a follow-up edit.
// Silent outside a project folder, for other files, and when the limit is 0.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../lib/config.mjs';
import { deny, runHook } from '../lib/hook-io.mjs';
import { affectedLines, findWrapViolations } from '../lib/markdown-wrap.mjs';
import { findProject } from '../lib/project.mjs';

const MARKDOWN = /\.(md|markdown|mdx)$/i;
const MAX_REPORTED = 10;

await runHook((input) => {
  const { file_path: file, content, new_string: newString } = input.tool_input ?? {};
  const introduced = input.tool_name === 'Write' ? content : input.tool_name === 'Edit' ? newString : undefined;
  if (typeof file !== 'string' || !MARKDOWN.test(file) || typeof introduced !== 'string' || introduced === '') return;
  const absolute = path.resolve(typeof input.cwd === 'string' ? input.cwd : process.cwd(), file);
  const project = findProject(path.dirname(absolute));
  const limit = project ? loadConfig(project).config.docs.wrapLimit : 0;
  if (limit === 0) return;
  const text = readFileSync(absolute, 'utf8');
  const touched = input.tool_name === 'Write' ? null : affectedLines(text, introduced);
  // An edit whose text is gone from the file cannot be mapped to lines; say nothing rather than name the wrong ones.
  if (input.tool_name === 'Edit' && touched === null) return;
  const violations = findWrapViolations(text, limit).filter((hit) => touched === null || touched.has(hit.line));
  if (!violations.length) return;
  const lines = [`The write to ${file} succeeded; do not repeat it. ${violations.length} line(s) you wrote exceed ${limit} characters:`];
  for (const hit of violations.slice(0, MAX_REPORTED)) lines.push(`  ${file}:${hit.line}: ${hit.length} characters`);
  if (violations.length > MAX_REPORTED) lines.push(`  ... and ${violations.length - MAX_REPORTED} more`);
  lines.push('Fix those lines with a follow-up edit: break at sentence boundaries, one sentence per line, never inside a backtick span or a link.');
  deny(lines.join('\n'));
});
