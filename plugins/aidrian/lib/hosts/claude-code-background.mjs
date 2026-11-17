// Claude Code's side of the background route of session.handoff.continue (docs/providers/claude-code.md#the-background-route).
// `claude --bg` starts a session under the background-session supervisor and prints its short id; `claude agents --json`,
// the listing its docs name as the stable interface, gives each session's `id`, `sessionId`, and `name`. `--bg` ignores
// `--session-id`, so the new session's id is read back from that listing.
// Every call goes through `run`, spawnSync's shape, which a test replaces, so no test starts a real session.

import { spawnSync } from 'node:child_process';

// `claude --bg` may first start the supervisor, which takes a few seconds.
const START_TIMEOUT = 60_000;
const LIST_TIMEOUT = 15_000;
// Its output: `backgrounded · <short id> · <name>`, then the commands that manage the session.
const STARTED = /\bbackgrounded\s*·\s*([0-9A-Za-z][0-9A-Za-z-]{3,63})\b/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
// A session name the command passes on: plain text that cannot read as a flag.
const NAME = /^[^\s-][^\u0000-\u001f\u007f-\u009f\u2028\u2029]{0,99}$/u;
// An agent name the command passes on: a word, or `<plugin>:<agent>`.
const AGENT = /^[A-Za-z0-9][\w.:-]{0,127}$/u;

export const runCommand = (command, args, { cwd, timeout }) => spawnSync(command, args, { cwd, timeout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// The first line of a command's message, on one line and at most 200 characters, for a fallback line.
const firstLine = (text) => String(text ?? '').trim().split('\n')[0].replace(new RegExp(CONTROL, 'gu'), ' ').slice(0, 200);

// The sessions `claude agents --json` lists, or [] when it cannot answer.
function listed(run, cwd) {
  const result = run('claude', ['agents', '--json'], { cwd, timeout: LIST_TIMEOUT });
  if (result.error || result.status !== 0) return [];
  try {
    const list = JSON.parse(result.stdout);
    return Array.isArray(list) ? list.filter((each) => each !== null && typeof each === 'object') : [];
  } catch {
    return [];
  }
}

// Starts the session that resumes a brief, in the background: { id, session, name, look }, or { problem } when it did
// not start. `session` is the handing-off session's id, whose name the new one takes, else `slug`; `agent` and `effort`
// are its own, passed on when known. `id` is the short id, or null when the output names none; `session` the new
// session's id, or null when the listing does not name it yet; `look` says how the Human looks at it.
export function startBackground({ cwd, session, slug, agent, effort, efforts, prompt, run = runCommand }) {
  const own = listed(run, cwd).find((each) => each.sessionId === session)?.name;
  const name = typeof own === 'string' && NAME.test(own) ? own : slug;
  const args = ['--bg', '--name', name];
  if (typeof agent === 'string' && AGENT.test(agent)) args.push('--agent', agent);
  if (efforts.includes(effort)) args.push('--effort', effort);
  const result = run('claude', [...args, prompt], { cwd, timeout: START_TIMEOUT });
  if (result.error?.code === 'ENOENT') return { problem: '`claude` is not on PATH' };
  if (result.error) return { problem: `\`claude --bg\` did not finish (${result.error.code ?? 'no code'})` };
  if (result.status !== 0) return { problem: `\`claude --bg\` exited ${result.status}: ${firstLine(result.stderr || result.stdout) || 'no message'}` };
  const id = STARTED.exec(String(result.stdout))?.[1] ?? null;
  const entry = id ? listed(run, cwd).find((each) => each.id === id) : null;
  // `claude attach` takes part of a running session's name; a name with a space goes in quotes.
  const byName = /\s/u.test(name) ? JSON.stringify(name) : name;
  const byId = id ? `, or \`claude attach ${id}\` by its id` : '';
  const look = `\`claude attach ${byName}\` opens it${byId}, and \`claude agents\` lists it`;
  return { id, session: typeof entry?.sessionId === 'string' ? entry.sessionId : null, name, look };
}
