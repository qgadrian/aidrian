// The committed OpenCode fixtures (test/fixtures/hosts/opencode/) hold nothing of the machine they were recorded or built
// on: no home path, no field the bridge does not send, no message text, no environment beyond the adapter's own session
// variables, and nothing the public-text guard refuses (lib/review/publish.mjs refusedKind: a local path, a private
// host, an email address, or a secret). No check can tell conversation text from tool output inside a recorded result:
// such text is bounded by the fixture's `live` flag, its provenance line, and the pull request's review.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import opencode from '../plugins/aidrian/lib/hosts/opencode.mjs';
import { refusedKind } from '../plugins/aidrian/lib/review/publish.mjs';

const DIR = path.join(import.meta.dirname, 'fixtures/hosts/opencode');

// A fixture's own keys, as test/adapters.test.mjs reads recorded calls: its provenance, the hook's environment, the
// values a test compares, and its payloads.
const FIXTURE = new Set(['live', 'provenance', 'env', 'number', 'output_path', 'pre', 'post']);
// The fields of a payload the bridge sends (opencode/bridge.mjs toolPayload and stopPayload, opencode/session-hooks.mjs,
// and SessionEnd's), each read by the adapter or a hook script (docs/providers/opencode.md#payload-fields).
const PAYLOAD = new Set(['hook_event_name', 'opencode', 'session_id', 'agent_id', 'cwd', 'tool_name', 'tool_input',
  'tool_response', 'tool_use_id', 'stop_hook_active', 'last_assistant_message', 'prompt']);
// Payload fields of message text: a placeholder alone, until a prompt or stop fixture exists.
const TEXT = new Set(['prompt', 'last_assistant_message']);
// The `opencode` mark (opencode/call.mjs markOf), its `info` as the name table reads it, and a completed call's result,
// OpenCode's `Tool.Result`, which the bridge sends as it came.
const MARK = new Set(['version', 'info', 'background']);
const INFO = new Set(['name', 'namespace']);
const RESULT = new Set(['output', 'content', 'metadata']);
// Keys of a session's messages or system text, which no field the bridge sends holds at any depth.
const MESSAGE_KEYS = new Set(['system', 'messages', 'message', 'parts', 'transcript', 'instructions']);
const ENV_KEYS = new Set(['env', 'environment']);
// A folder in a person's home, on macOS, Linux, or Windows: the name ends at a separator, a quote, whitespace, or the end.
const HOME_PATH = /(?:^|[^\w.-])(?:\/Users\/|\/home\/|[A-Za-z]:[\\/]Users[\\/])[^/\\\s"'<>]+(?=[/\\\s"'<>]|$)/u;
const SESSION = /^ses_[A-Za-z0-9]+$/u;
const PLACEHOLDER = /^<[a-z_]+>$/u;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const NO_TERMS = { hosts: [], accounts: [], variables: [] };

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

// The problems of one fixture, as text, [] when none. `vars` is the variables its `env` may name; `homes` the running
// user's home folder and its real path, each matched where a separator, whitespace, a quote, or the end follows it.
function fixtureProblems(fixture, { vars, homes }) {
  const problems = [];
  const home = homes.length ? new RegExp(`(?:${homes.map(escaped).join('|')})(?=[/\\\\\\s"']|$)`, 'u') : null;
  const text = (value, at) => {
    if (HOME_PATH.test(value) || home?.test(value)) problems.push(`${at} holds a home path`);
    const kind = refusedKind(value, { terms: NO_TERMS });
    if (kind !== null) problems.push(`${at} holds ${kind}`);
  };
  const walk = (value, at) => {
    if (typeof value === 'string') return text(value, at);
    if (Array.isArray(value)) {
      if (value.some((each) => typeof each === 'string' && VARIABLE.test(each))) problems.push(`${at} is an environment list`);
      return value.forEach((each, index) => walk(each, `${at}[${index}]`));
    }
    if (!isObject(value)) return;
    for (const [key, each] of Object.entries(value)) {
      text(key, `${at} key`);
      if (MESSAGE_KEYS.has(key)) problems.push(`${at}.${key} carries message or system text`);
      if (ENV_KEYS.has(key) && at !== '') problems.push(`${at}.${key} is an environment map`);
      walk(each, `${at}.${key}`);
    }
  };
  walk(fixture, '');
  const unsent = (set, map, where) => Object.keys(map).filter((name) => !set.has(name)).forEach((name) => problems.push(`${where}.${name} is no field it may hold`));
  const session = (value, where) => {
    if (value !== undefined && !(typeof value === 'string' && (SESSION.test(value) || PLACEHOLDER.test(value)))) problems.push(`${where} is no session id`);
  };
  unsent(FIXTURE, fixture, '');
  if (fixture.env !== undefined) {
    if (!isObject(fixture.env)) problems.push('.env is no map of variables');
    else {
      for (const name of Object.keys(fixture.env)) if (!vars.has(name)) problems.push(`.env names ${name}, no session variable of the adapter`);
      session(fixture.env.OPENCODE_SESSION_ID, '.env.OPENCODE_SESSION_ID');
    }
  }
  for (const key of ['pre', 'post']) {
    const payload = fixture[key];
    if (!isObject(payload)) continue;
    unsent(PAYLOAD, payload, `.${key}`);
    for (const field of TEXT) if (field in payload && !(typeof payload[field] === 'string' && PLACEHOLDER.test(payload[field]))) problems.push(`.${key}.${field} is message text`);
    session(payload.session_id, `.${key}.session_id`);
    session(payload.agent_id, `.${key}.agent_id`);
    if (isObject(payload.opencode)) {
      unsent(MARK, payload.opencode, `.${key}.opencode`);
      if (isObject(payload.opencode.info)) unsent(INFO, payload.opencode.info, `.${key}.opencode.info`);
    }
    if (isObject(payload.tool_response)) unsent(RESULT, payload.tool_response, `.${key}.tool_response`);
  }
  return problems;
}

const homes = (() => {
  const home = os.homedir();
  if (!path.isAbsolute(home) || path.dirname(home) === home) return [];
  let real = home;
  try {
    real = realpathSync(home);
  } catch {
    // A home folder that is not there is matched as written.
  }
  return [...new Set([home, real])];
})();
const settings = { vars: new Set([...opencode.identityVars, ...opencode.detectVars]), homes };

test('every committed OpenCode fixture holds no home path, unsent field, message text, environment, or public-text refusal', () => {
  const files = readdirSync(DIR).filter((file) => file.endsWith('.json'));
  assert.ok(files.includes('bash-post.json'), 'the shell fixture is read');
  for (const file of files) {
    const fixture = JSON.parse(readFileSync(path.join(DIR, file), 'utf8'));
    assert.deepEqual(fixtureProblems(fixture, settings), [], file);
  }
});

test('the fixture check fails on each planted home path, unsent field, message text, environment, and refused text', () => {
  const fixture = JSON.parse(readFileSync(path.join(DIR, 'bash-post.json'), 'utf8'));
  const post = (fields) => (each) => ({ ...each, post: { ...each.post, ...fields } });
  // Home paths, emails, and secrets are joined here, so this file names none (`aidrian lint paths`).
  const mac = ['', 'Users', 'someone'].join('/');
  const linux = ['', 'home', 'someone', 'work'].join('/');
  const windows = ['C:', 'Users', 'someone', 'x'].join('\\');
  const email = ['someone', 'example.org'].join('@');
  const secret = ['ghp', 'a1B2c3D4e5F6g7H8'].join('_');
  const cases = [
    [post({ cwd: mac }), /^\.post\.cwd holds a home path$/u],
    [post({ cwd: linux }), /^\.post\.cwd holds a home path$/u],
    [post({ tool_input: { command: `cat ${windows}` } }), /^\.post\.tool_input\.command holds a home path$/u],
    [post({ system: ['You are a coding agent.'] }), /^\.post\.system carries message or system text$/u],
    [post({ tool_response: { ...fixture.post.tool_response, metadata: { messages: [] } } }), /\.metadata\.messages carries message or system text$/u],
    [post({ model: 'x' }), /^\.post\.model is no field it may hold$/u],
    [post({ opencode: { ...fixture.post.opencode, directory: 'x' } }), /^\.post\.opencode\.directory is no field it may hold$/u],
    [(each) => ({ ...each, raw: { tool_name: 'shell' } }), /^\.raw is no field it may hold$/u],
    [post({ prompt: 'fix the login page' }), /^\.post\.prompt is message text$/u],
    [post({ last_assistant_message: 'Done.' }), /^\.post\.last_assistant_message is message text$/u],
    [(each) => ({ ...each, env: { ...each.env, PATH: '/usr/bin' } }), /^\.env names PATH, no session variable of the adapter$/u],
    [post({ tool_input: { ...fixture.post.tool_input, env: { TOKEN: 'x' } } }), /^\.post\.tool_input\.env is an environment map$/u],
    [post({ tool_input: { ...fixture.post.tool_input, vars: ['TOKEN=x'] } }), /^\.post\.tool_input\.vars is an environment list$/u],
    [(each) => ({ ...each, env: ['OPENCODE=1'] }), /^\.env is an environment list$/u],
    [post({ session_id: 'session one' }), /^\.post\.session_id is no session id$/u],
    [post({ agent_id: '../x' }), /^\.post\.agent_id is no session id$/u],
    [(each) => ({ ...each, env: { ...each.env, OPENCODE_SESSION_ID: 'x y' } }), /^\.env\.OPENCODE_SESSION_ID is no session id$/u],
    [post({ tool_response: { ...fixture.post.tool_response, output: { output: `mail ${email}` } } }), /\.output\.output holds an email address$/u],
    [post({ tool_input: { command: `gh auth login --with-token ${secret}` } }), /^\.post\.tool_input\.command holds a secret$/u],
  ];
  for (const [change, expected] of cases) {
    const problems = fixtureProblems(change(structuredClone(fixture)), settings);
    assert.ok(problems.some((problem) => expected.test(problem)), `${expected}: ${JSON.stringify(problems)}`);
  }
  // A placeholder stands in for a session id or a message, and the running user's home is matched exactly too.
  assert.deepEqual(fixtureProblems(post({ agent_id: '<agent>', prompt: '<prompt>' })(structuredClone(fixture)), settings), []);
  for (const home of homes) {
    for (const cwd of [home, path.join(home, 'project')]) {
      const problems = fixtureProblems(post({ cwd })(structuredClone(fixture)), settings);
      assert.ok(problems.includes('.post.cwd holds a home path'), JSON.stringify(problems));
    }
  }
});
