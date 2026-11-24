// What a hooks.json host (Claude Code) does with a hook script's answer, written once so a bridge host never re-derives it.
// readHookResult turns one script's exit, signal, stdout, and stderr into its verdict for the event it ran on:
//
//   exit 2  PreToolUse, UserPromptSubmit, Stop, SubagentStop, PreCompact: a block, with stderr as the reason.
//           PostToolUse: no block, since the call already ran; stderr is context for the model.
//           Any other event: nothing, since the host shows that stderr to the user only.
//   exit 0  stdout a JSON object: hookSpecificOutput.additionalContext as context, hookSpecificOutput.updatedInput
//           on PreToolUse only, and the top-level systemMessage. hookSpecificOutput counts only when its hookEventName
//           is the event the script ran on; with none or another, only systemMessage does. Plain text: context on
//           SessionStart, UserPromptSubmit, and PreCompact, where it is the instructions for the compaction summary,
//           and nothing elsewhere; SubagentStart takes its context from additionalContext only.
//
// Any other exit, a signal, or input it cannot read is the empty verdict, so a hook that crashed or hung lets the action
// run (docs/working-agreement.md). Output past the bridge's byte bound carries no text and never turns an exit 2 into an
// allow: on an event that blocks on exit 2 it blocks with OVERFLOW_REASON, and anywhere else it is the empty verdict. It reads no other field, such as a decision
// or continue: no script here prints one. Out of scope, because no script here prints them: JSON on stdout with exit 2
// or exit 1, text that starts like a JSON object but does not parse, and additionalContext or systemMessage on an event
// whose host ignores them. combineHookResults merges the verdicts of the hooks that matched one call.
// Node built-ins only, and no other lib file, so any host's bridge can load it.

import { isDeepStrictEqual } from 'node:util';

const EMPTY = Object.freeze({ block: false, reason: null, context: null, systemMessage: null, updatedInput: null });

const BLOCKS_ON_EXIT_2 = new Set(['PreToolUse', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'PreCompact']);
const PLAIN_TEXT_CONTEXT = new Set(['SessionStart', 'UserPromptSubmit', 'PreCompact']);

// The reason of an exit 2 block whose script wrote nothing on stderr.
export const NO_REASON = 'A hook blocked this call and gave no reason.';
// The reason of an exit 2 block whose output passed the bridge's byte bound: the refusal stands, its text is not shown.
export const OVERFLOW_REASON = 'A hook refused this call, and its message was too long to show.';
// The reason when two hooks that matched one call rewrote its input differently: neither rewrite can win, so it fails closed.
export const REWRITE_CONFLICT = 'Two hooks rewrote this call differently, so it does not run.';

const isPlainObject = (value) => Object.prototype.toString.call(value) === '[object Object]';
// A stream's text: '' when absent, null when it is not text, which makes the input malformed.
const streamText = (value) => (value === undefined || value === null ? '' : typeof value === 'string' ? value : null);
const nonBlank = (value) => (typeof value === 'string' && value.trim() !== '' ? value : null);

function verdict(fields) {
  return Object.freeze({ ...EMPTY, ...fields });
}

function parseObject(text) {
  try {
    const value = JSON.parse(text);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

function fromJson(event, output) {
  const nested = output.hookSpecificOutput;
  const specific = isPlainObject(nested) && nested.hookEventName === event ? nested : {};
  return verdict({
    context: nonBlank(specific.additionalContext),
    systemMessage: nonBlank(output.systemMessage),
    updatedInput: event === 'PreToolUse' && isPlainObject(specific.updatedInput) ? specific.updatedInput : null,
  });
}

// The verdict of one hook script, frozen: { block, reason, context, systemMessage, updatedInput }. Never throws.
export function readHookResult(result) {
  try {
    if (!isPlainObject(result)) return EMPTY;
    const { event, exit, signal, overflow } = result;
    const stdout = streamText(result.stdout);
    const stderr = streamText(result.stderr);
    if (typeof event !== 'string' || stdout === null || stderr === null) return EMPTY;
    if (signal || (exit !== 0 && exit !== 2)) return EMPTY;
    // A guard's refusal stands at any length, as the host blocks on exit 2 whatever it printed.
    if (exit === 2 && BLOCKS_ON_EXIT_2.has(event)) {
      return verdict({ block: true, reason: overflow === true ? OVERFLOW_REASON : stderr.trim() || NO_REASON });
    }
    if (overflow === true) return EMPTY;
    if (exit === 2) {
      if (event === 'PostToolUse') return verdict({ context: nonBlank(stderr.trim()) });
      return EMPTY;
    }
    const text = stdout.trim();
    if (text === '') return EMPTY;
    const output = parseObject(text);
    if (output) return fromJson(event, output);
    return PLAIN_TEXT_CONTEXT.has(event) ? verdict({ context: text }) : EMPTY;
  } catch {
    return EMPTY;
  }
}

const joined = (values) => (values.length > 0 ? values.join('\n\n') : null);

// The verdict of several hooks that matched one call and ran in parallel, given in hooks.json order. Any block wins and
// drops a rewrite; rewrites that differ block the call.
export function combineHookResults(results) {
  if (!Array.isArray(results)) return EMPTY;
  const verdicts = results.filter(isPlainObject);
  const pick = (field) => verdicts.map((one) => nonBlank(one[field])).filter((value) => value !== null);
  const reasons = verdicts.filter((one) => one.block === true).map((one) => nonBlank(one.reason) ?? NO_REASON);
  const rewrites = verdicts.map((one) => one.updatedInput).filter(isPlainObject);
  const conflict = rewrites.some((rewrite) => !isDeepStrictEqual(rewrite, rewrites[0]));
  if (conflict) reasons.push(REWRITE_CONFLICT);
  const block = reasons.length > 0;
  return verdict({
    block,
    reason: joined(reasons),
    context: joined(pick('context')),
    systemMessage: joined(pick('systemMessage')),
    updatedInput: block || rewrites.length === 0 ? null : rewrites[0],
  });
}
