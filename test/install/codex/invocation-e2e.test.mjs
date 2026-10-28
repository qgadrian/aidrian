import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn as spawnChild } from 'node:child_process';
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assemblePrivateDistribution } from '../../../src/project-bundle/assemble.mjs';
import {
  applyManagedPlan,
  planManagedInstall,
} from '../../../src/project-bundle/managed-projection.mjs';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const CODEX = '/opt/homebrew/Caskroom/codex/0.164.0/bin/codex';
const CODEX_SHA256 = 'd8990e3ee7acfbc26f91265b12a1a83f0fee40d0e0f8f1f40a37d4ec21f499cf';
const GRILL_ME_SHA256 = '60b6a50ff6d1760553771937fc11d1543ba79c6c0cebcdeb0164da0ec79e1db8';
const PATH = '/Users/adrian/.local/share/mise/installs/node/26.12.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
const MAX_BUFFER = 1 * 1024 * 1024;
const APP_SERVER_TIMEOUT_MS = 10_000;
const ROLE_TURN_TIMEOUT_MS = 240_000;
const EXPLORER_MODEL = 'gpt-5.6-terra';
const FIXTURE_PLUGIN_ID = 'aidrian-codex-hook-fixture@aidrian-hook-fixture';
const FIXTURE_VERSION = '0.0.1';

const runNonInteractiveCommand = (executable, argv, { cwd, env, timeout }) => {
  if (!Number.isFinite(timeout) || !Number.isInteger(timeout) || timeout <= 0) {
    throw new TypeError('timeout must be a positive finite integer');
  }
  return new Promise((resolve, reject) => {
    const child = execFile(executable, argv, {
      cwd,
      encoding: 'utf8',
      env,
      maxBuffer: MAX_BUFFER,
      shell: false,
      timeout,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.end();
  });
};

const buildProjectTrustOverride = (projectRoot) => (
  `projects={${JSON.stringify(projectRoot)}={trust_level="trusted"}}`
);

const assertCanonicalDirectory = async (candidate, label) => {
  const info = await lstat(candidate);
  assert.equal(info.isSymbolicLink(), false, `${label} must not be a symbolic link`);
  assert.equal(info.isDirectory(), true, `${label} must be a directory`);
  assert.equal(await realpath(candidate), candidate, `${label} must be canonical`);
  assert.equal(info.mode & 0o777, 0o700, `${label} must use mode 0700`);
};

const assertStrictDescendant = (parent, candidate, label) => {
  const relative = path.relative(parent, candidate);
  assert.equal(
    relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative),
    true,
    `${label} must be strictly contained by ${parent}`,
  );
};

const assertOwnedFixtureRoots = async ({ root, home, codexHome, projectRoot }) => {
  for (const [label, candidate] of Object.entries({ root, home, codexHome, projectRoot })) {
    await assertCanonicalDirectory(candidate, label);
  }
  for (const [label, candidate] of Object.entries({ home, codexHome, projectRoot })) {
    assertStrictDescendant(root, candidate, label);
  }
  assert.equal(
    new Set([root, home, codexHome, projectRoot]).size,
    4,
    'fixture roots must not alias each other',
  );
};

const createExactDirectoryCleanup = ({ parent, target, prefix }) => {
  let removed = false;
  return async () => {
    if (removed) return;
    await assertCanonicalDirectory(parent, 'cleanup parent');
    assertStrictDescendant(parent, target, 'cleanup target');
    assert.equal(path.dirname(target), parent, 'cleanup target must be an immediate child');
    assert.equal(path.basename(target).startsWith(prefix), true, 'cleanup target prefix mismatch');
    await assertCanonicalDirectory(target, 'cleanup target');
    await rm(target, { recursive: true });
    removed = true;
  };
};

const registerExactDirectoryCleanup = (t, options) => {
  const cleanup = createExactDirectoryCleanup(options);
  t.after(cleanup);
  return cleanup;
};

const classifyAppServerMessage = (message, pendingIds) => {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new Error('Codex app-server emitted an unknown JSON-RPC shape');
  }
  const hasId = Object.hasOwn(message, 'id');
  const hasMethod = Object.hasOwn(message, 'method');
  if (hasId && hasMethod) {
    const method = typeof message.method === 'string' ? message.method : '<unknown>';
    throw new Error(`Codex app-server sent an unsolicited request: method=${method}`);
  }
  if (hasId) {
    if (!pendingIds.has(message.id)) {
      throw new Error('Codex app-server sent a response with an unknown request id');
    }
    const hasResult = Object.hasOwn(message, 'result');
    const hasError = Object.hasOwn(message, 'error');
    if (hasResult === hasError) {
      throw new Error('Codex app-server response must contain exactly one result or error');
    }
    return { kind: 'response', id: message.id };
  }
  if (hasMethod && typeof message.method === 'string' && message.params && typeof message.params === 'object') {
    return { kind: 'notification', method: message.method };
  }
  throw new Error('Codex app-server emitted an unknown JSON-RPC shape');
};

const createNotificationInbox = () => {
  const notifications = [];
  const waiters = new Set();
  const settle = (waiter, notification) => {
    clearTimeout(waiter.timer);
    waiters.delete(waiter);
    waiter.resolve(notification);
  };
  return {
    notifications,
    waitingCount: () => waiters.size,
    push(notification) {
      notifications.push(notification);
      for (const waiter of [...waiters]) {
        if (waiter.predicate(notification)) settle(waiter, notification);
      }
    },
    fail(error) {
      for (const waiter of [...waiters]) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.reject(error);
      }
    },
    waitFor(predicate, { label, timeout }) {
      const existing = notifications.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, reject, resolve, timer: undefined };
        waiter.timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`${label} timed out`));
        }, timeout);
        waiters.add(waiter);
      });
    },
  };
};

const textMatches = (actual, expected) => (
  typeof actual === 'string'
  && createHash('sha256').update(actual).digest('hex')
    === createHash('sha256').update(expected).digest('hex')
);

const isIdleThreadStatus = (status) => (
  status
  && typeof status === 'object'
  && !Array.isArray(status)
  && Object.keys(status).length === 1
  && status.type === 'idle'
);

const ROLE_PROOF_CODES = new Set([
  'ROLE_PROOF_START_INVALID',
  'ROLE_PROOF_TURN_INVALID',
  'ROLE_PROOF_ROOT_HISTORY_INVALID',
  'ROLE_PROOF_CHILD_HISTORY_INVALID',
  'ROLE_PROOF_RPC_FAILED',
  'ROLE_PROOF_CLEANUP_FAILED',
]);

const roleProofFailure = (code) => {
  assert.equal(ROLE_PROOF_CODES.has(code), true, 'role proof code must be fixed');
  const error = new Error(code);
  error.code = code;
  return error;
};

const requirePersistedRoleEvidence = (condition, code) => {
  if (!condition) throw roleProofFailure(code);
};

const persistedThreadStartParams = (projectRoot) => ({
  cwd: projectRoot,
  ephemeral: false,
  approvalPolicy: 'never',
  sandbox: 'read-only',
});

const persistedThreadReadParams = (threadId, includeTurns) => ({ threadId, includeTurns });
const persistedThreadDeleteParams = (threadId) => ({ threadId });

const unwrapRoleResponse = (response, code) => {
  requirePersistedRoleEvidence(
    response
      && typeof response === 'object'
      && !Array.isArray(response)
      && !Object.hasOwn(response, 'error')
      && response.result
      && typeof response.result === 'object'
      && !Array.isArray(response.result),
    code,
  );
  return response.result;
};

const assertPersistedTextUserMessage = (items, expectedText, code) => {
  requirePersistedRoleEvidence(Array.isArray(items), code);
  const userMessages = items.filter(({ type }) => type === 'userMessage');
  requirePersistedRoleEvidence(userMessages.length === 1, code);
  const [message] = userMessages;
  requirePersistedRoleEvidence(message.content?.length === 1, code);
  requirePersistedRoleEvidence(message.content[0]?.type === 'text', code);
  requirePersistedRoleEvidence(textMatches(message.content[0]?.text, expectedText), code);
  requirePersistedRoleEvidence(
    Array.isArray(message.content[0]?.textElements) && message.content[0].textElements.length === 0,
    code,
  );
};

const assertPersistedCompletedTurn = (turn, expectedId, code) => {
  requirePersistedRoleEvidence(turn?.id === expectedId, code);
  requirePersistedRoleEvidence(turn.status === 'completed', code);
  requirePersistedRoleEvidence(turn.error == null, code);
  requirePersistedRoleEvidence(Array.isArray(turn.items), code);
};

const extractPersistedRoleChild = ({ rootThread, rootThreadId, rootTurnId, rolePrompt, childTask }) => {
  const code = 'ROLE_PROOF_ROOT_HISTORY_INVALID';
  requirePersistedRoleEvidence(rootThread?.id === rootThreadId, code);
  requirePersistedRoleEvidence(rootThread.parentThreadId == null, code);
  requirePersistedRoleEvidence(isIdleThreadStatus(rootThread.status), code);
  requirePersistedRoleEvidence(Array.isArray(rootThread.turns) && rootThread.turns.length === 1, code);
  const [rootTurn] = rootThread.turns;
  assertPersistedCompletedTurn(rootTurn, rootTurnId, code);
  const allowedTypes = new Set([
    'userMessage',
    'reasoning',
    'agentMessage',
    'collabAgentToolCall',
    'subAgentActivity',
  ]);
  requirePersistedRoleEvidence(rootTurn.items.every((item) => allowedTypes.has(item?.type)), code);
  assertPersistedTextUserMessage(rootTurn.items, rolePrompt, code);

  const v1Spawns = rootTurn.items.filter(({ type }) => type === 'collabAgentToolCall');
  requirePersistedRoleEvidence(v1Spawns.every(({ tool }) => tool === 'spawnAgent'), code);
  requirePersistedRoleEvidence(v1Spawns.length <= 1, code);
  let v1ChildId;
  if (v1Spawns.length === 1) {
    const [spawn] = v1Spawns;
    requirePersistedRoleEvidence(typeof spawn.id === 'string' && spawn.id.length > 0, code);
    requirePersistedRoleEvidence(spawn.status === 'completed', code);
    requirePersistedRoleEvidence(spawn.senderThreadId === rootThreadId, code);
    requirePersistedRoleEvidence(Array.isArray(spawn.receiverThreadIds), code);
    requirePersistedRoleEvidence(spawn.receiverThreadIds.length === 1, code);
    requirePersistedRoleEvidence(textMatches(spawn.prompt, childTask), code);
    requirePersistedRoleEvidence(spawn.model === EXPLORER_MODEL, code);
    [v1ChildId] = spawn.receiverThreadIds;
    requirePersistedRoleEvidence(
      typeof v1ChildId === 'string' && v1ChildId.length > 0,
      code,
    );
  }

  const v2Activities = rootTurn.items.filter(({ type }) => type === 'subAgentActivity');
  requirePersistedRoleEvidence(v2Activities.every(({ kind }) => (
    ['started', 'interacted', 'completed'].includes(kind)
  )), code);
  const v2Started = v2Activities.filter(({ kind }) => kind === 'started');
  requirePersistedRoleEvidence(v2Started.length <= 1, code);
  requirePersistedRoleEvidence(v2Activities.length === 0 || v2Started.length === 1, code);
  let v2ChildId;
  if (v2Started.length === 1) {
    const [started] = v2Started;
    requirePersistedRoleEvidence(typeof started.id === 'string' && started.id.length > 0, code);
    requirePersistedRoleEvidence(
      typeof started.agentThreadId === 'string' && started.agentThreadId.length > 0,
      code,
    );
    requirePersistedRoleEvidence(typeof started.agentPath === 'string' && started.agentPath.length > 0, code);
    requirePersistedRoleEvidence(started.model === EXPLORER_MODEL, code);
    requirePersistedRoleEvidence(v2Activities.every(({ agentThreadId, agentPath }) => (
      agentThreadId === started.agentThreadId && agentPath === started.agentPath
    )), code);
    v2ChildId = started.agentThreadId;
  }

  const representedChildIds = [];
  if (v1Spawns.length === 1) representedChildIds.push(v1ChildId);
  if (v2Started.length === 1) representedChildIds.push(v2ChildId);
  requirePersistedRoleEvidence(representedChildIds.length > 0, code);
  requirePersistedRoleEvidence(new Set(representedChildIds).size === 1, code);
  return {
    childId: representedChildIds[0],
    rootItemCount: Math.min(MAX_BUFFER, rootTurn.items.length),
    spawnRepresentations: representedChildIds.length,
  };
};

const validatePersistedRoleChild = ({
  childThread,
  childId,
  rootThreadId,
  rolePrompt,
  childTask,
  roleSentinel,
}) => {
  const code = 'ROLE_PROOF_CHILD_HISTORY_INVALID';
  requirePersistedRoleEvidence(childThread?.id === childId, code);
  requirePersistedRoleEvidence(childThread.parentThreadId === rootThreadId, code);
  requirePersistedRoleEvidence(childThread.agentRole === 'explorer', code);
  requirePersistedRoleEvidence(childThread.model === EXPLORER_MODEL, code);
  requirePersistedRoleEvidence(isIdleThreadStatus(childThread.status), code);
  requirePersistedRoleEvidence(Array.isArray(childThread.turns) && childThread.turns.length === 1, code);
  const [childTurn] = childThread.turns;
  requirePersistedRoleEvidence(
    typeof childTurn?.id === 'string' && childTurn.id.length > 0,
    code,
  );
  assertPersistedCompletedTurn(childTurn, childTurn.id, code);
  const allowedTypes = new Set(['userMessage', 'reasoning', 'agentMessage']);
  requirePersistedRoleEvidence(childTurn.items.every((item) => allowedTypes.has(item?.type)), code);
  assertPersistedTextUserMessage(childTurn.items, childTask, code);
  requirePersistedRoleEvidence(childTurn.items.every((item) => (
    item.type !== 'userMessage' || !textMatches(item.content?.[0]?.text, rolePrompt)
  )), code);
  requirePersistedRoleEvidence(!childTask.includes(roleSentinel), code);
  const terminalMessages = childTurn.items.filter(({ type }) => type === 'agentMessage');
  requirePersistedRoleEvidence(terminalMessages.length === 1, code);
  requirePersistedRoleEvidence(textMatches(terminalMessages[0].text?.trim(), roleSentinel), code);
  return { childItemCount: Math.min(MAX_BUFFER, childTurn.items.length) };
};

const assertPostDeleteReadRejected = (response) => {
  const code = 'ROLE_PROOF_CLEANUP_FAILED';
  requirePersistedRoleEvidence(
    response
      && typeof response === 'object'
      && !Array.isArray(response)
      && !Object.hasOwn(response, 'result')
      && response.error
      && response.error.code === -32600,
    code,
  );
};

const deletePersistedRoleSubtree = async ({
  request,
  notificationInbox,
  rootThreadId,
  childId,
}) => {
  const notificationStart = notificationInbox.notifications.length;
  let deleted;
  try {
    deleted = unwrapRoleResponse(
      await request('thread/delete', persistedThreadDeleteParams(rootThreadId)),
      'ROLE_PROOF_CLEANUP_FAILED',
    );
  } catch {
    throw roleProofFailure('ROLE_PROOF_CLEANUP_FAILED');
  }
  requirePersistedRoleEvidence(Object.keys(deleted).length === 0, 'ROLE_PROOF_CLEANUP_FAILED');
  if (!childId) return;

  try {
    await notificationInbox.waitFor((notification) => (
      notification.method === 'thread/deleted'
      && notification.params?.threadId === rootThreadId
    ), { label: 'root thread deletion', timeout: APP_SERVER_TIMEOUT_MS });
  } catch {
    throw roleProofFailure('ROLE_PROOF_CLEANUP_FAILED');
  }
  const deletionNotifications = notificationInbox.notifications
    .slice(notificationStart)
    .filter(({ method }) => method === 'thread/deleted');
  requirePersistedRoleEvidence(deletionNotifications.length === 2, 'ROLE_PROOF_CLEANUP_FAILED');
  requirePersistedRoleEvidence(
    deletionNotifications[0].params?.threadId === childId,
    'ROLE_PROOF_CLEANUP_FAILED',
  );
  requirePersistedRoleEvidence(
    deletionNotifications[1].params?.threadId === rootThreadId,
    'ROLE_PROOF_CLEANUP_FAILED',
  );
  try {
    assertPostDeleteReadRejected(
      await request('thread/read', persistedThreadReadParams(childId, false)),
    );
    assertPostDeleteReadRejected(
      await request('thread/read', persistedThreadReadParams(rootThreadId, false)),
    );
  } catch {
    throw roleProofFailure('ROLE_PROOF_CLEANUP_FAILED');
  }
};

const runPersistedRoleProof = async ({
  projectRoot,
  roleRequest,
  request,
  notificationInbox,
}) => {
  let rootThreadId;
  let childId;
  let proofError;
  let proofResult;
  try {
    const started = unwrapRoleResponse(
      await request('thread/start', persistedThreadStartParams(projectRoot)),
      'ROLE_PROOF_RPC_FAILED',
    );
    rootThreadId = started.thread?.id;
    requirePersistedRoleEvidence(
      typeof rootThreadId === 'string' && rootThreadId.length > 0,
      'ROLE_PROOF_START_INVALID',
    );
    requirePersistedRoleEvidence(started.cwd === projectRoot, 'ROLE_PROOF_START_INVALID');
    requirePersistedRoleEvidence(started.thread.cwd === projectRoot, 'ROLE_PROOF_START_INVALID');
    requirePersistedRoleEvidence(started.approvalPolicy === 'never', 'ROLE_PROOF_START_INVALID');
    requirePersistedRoleEvidence(started.sandbox?.type === 'readOnly', 'ROLE_PROOF_START_INVALID');
    requirePersistedRoleEvidence(
      started.sandbox?.networkAccess === false,
      'ROLE_PROOF_START_INVALID',
    );
    requirePersistedRoleEvidence(
      roleRequest.rolePrompt.includes('`fork_turns` is `none`'),
      'ROLE_PROOF_START_INVALID',
    );
    requirePersistedRoleEvidence(
      !roleRequest.rolePrompt.includes(roleRequest.roleSentinel),
      'ROLE_PROOF_START_INVALID',
    );
    requirePersistedRoleEvidence(
      !roleRequest.childTask.includes(roleRequest.roleSentinel),
      'ROLE_PROOF_START_INVALID',
    );

    const startedTurn = unwrapRoleResponse(await request('turn/start', {
      threadId: rootThreadId,
      input: [{ type: 'text', text: roleRequest.rolePrompt, textElements: [] }],
    }), 'ROLE_PROOF_RPC_FAILED');
    const rootTurnId = startedTurn.turn?.id;
    requirePersistedRoleEvidence(
      typeof rootTurnId === 'string' && rootTurnId.length > 0,
      'ROLE_PROOF_TURN_INVALID',
    );
    requirePersistedRoleEvidence(startedTurn.turn.status === 'inProgress', 'ROLE_PROOF_TURN_INVALID');
    const deadline = Date.now() + ROLE_TURN_TIMEOUT_MS;
    await notificationInbox.waitFor((notification) => (
      notification.method === 'turn/completed'
      && notification.params?.threadId === rootThreadId
      && notification.params?.turn?.id === rootTurnId
    ), {
      label: 'root role turn completion',
      timeout: Math.max(1, deadline - Date.now()),
    });
    const rootThread = unwrapRoleResponse(
      await request('thread/read', persistedThreadReadParams(rootThreadId, true)),
      'ROLE_PROOF_RPC_FAILED',
    ).thread;
    const rootProof = extractPersistedRoleChild({
      rootThread,
      rootThreadId,
      rootTurnId,
      rolePrompt: roleRequest.rolePrompt,
      childTask: roleRequest.childTask,
    });
    childId = rootProof.childId;
    const childThread = unwrapRoleResponse(
      await request('thread/read', persistedThreadReadParams(childId, true)),
      'ROLE_PROOF_RPC_FAILED',
    ).thread;
    const childProof = validatePersistedRoleChild({
      childThread,
      childId,
      rootThreadId,
      rolePrompt: roleRequest.rolePrompt,
      childTask: roleRequest.childTask,
      roleSentinel: roleRequest.roleSentinel,
    });
    proofResult = {
      persistedHistoryVerified: true,
      rootItemCount: rootProof.rootItemCount,
      childItemCount: childProof.childItemCount,
      spawnRepresentations: rootProof.spawnRepresentations,
    };
  } catch (error) {
    proofError = ROLE_PROOF_CODES.has(error?.code)
      ? error
      : roleProofFailure('ROLE_PROOF_RPC_FAILED');
  } finally {
    if (rootThreadId) {
      await deletePersistedRoleSubtree({
        request,
        notificationInbox,
        rootThreadId,
        childId,
      });
    }
  }
  if (proofError) throw proofError;
  return { ...proofResult, cleanupVerified: true };
};

const closeOwnedChild = async (child, closed) => {
  if (!child.stdin.destroyed) child.stdin.end();
  let result = await Promise.race([
    closed,
    new Promise((resolve) => setTimeout(() => resolve(null), 2_000)),
  ]);
  if (!result) {
    child.kill('SIGTERM');
    result = await Promise.race([
      closed,
      new Promise((resolve) => setTimeout(() => resolve(null), 1_000)),
    ]);
  }
  if (!result) {
    child.kill('SIGKILL');
    result = await closed;
  }
  return result;
};

const observeCodexAppServer = async ({ projectRoot, env, includeHooks, roleRequest }) => {
  const child = spawnChild(CODEX, [
    'app-server',
    '--listen',
    'stdio://',
    '--strict-config',
    '--config',
    buildProjectTrustOverride(projectRoot),
  ], {
    cwd: projectRoot,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let aggregateBytes = 0;
  let lineBuffer = '';
  let stderr = '';
  let fatalError;
  let nextId = 1;
  const pending = new Map();
  const notificationInbox = createNotificationInbox();
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const rejectPending = (error) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
    notificationInbox.fail(error);
  };
  const recordBytes = (chunk) => {
    aggregateBytes += chunk.length;
    if (aggregateBytes > MAX_BUFFER && !fatalError) {
      fatalError = new Error('Codex app-server aggregate output exceeded one MiB');
      rejectPending(fatalError);
      child.kill('SIGTERM');
    }
  };
  child.once('error', (error) => {
    fatalError = error;
    rejectPending(error);
  });
  child.once('close', (code, signal) => {
    resolveClosed({ code, signal });
    const closeError = new Error(`Codex app-server closed: code=${code} signal=${signal}`);
    notificationInbox.fail(closeError);
    if (pending.size > 0) {
      rejectPending(new Error(`Codex app-server closed before response: code=${code} signal=${signal}`));
    }
  });
  child.stderr.on('data', (chunk) => {
    recordBytes(chunk);
    if (!fatalError) stderr += chunk.toString('utf8');
  });
  child.stdout.on('data', (chunk) => {
    recordBytes(chunk);
    if (fatalError) return;
    lineBuffer += chunk.toString('utf8');
    for (;;) {
      const newline = lineBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = lineBuffer.slice(0, newline).trim();
      lineBuffer = lineBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        fatalError = new Error(`Codex app-server emitted invalid JSON (${Buffer.byteLength(line)} bytes)`);
        rejectPending(fatalError);
        child.kill('SIGTERM');
        continue;
      }
      let classification;
      try {
        classification = classifyAppServerMessage(message, new Set(pending.keys()));
      } catch (error) {
        fatalError = error;
        rejectPending(error);
        child.kill('SIGTERM');
        continue;
      }
      if (classification.kind === 'notification') {
        notificationInbox.push(message);
        continue;
      }
      const pendingRequest = pending.get(classification.id);
      pending.delete(classification.id);
      clearTimeout(pendingRequest.timer);
      pendingRequest.resolve(message);
    }
  });
  const send = (method, params, id) => {
    child.stdin.write(`${JSON.stringify(id === undefined ? { method, params } : { id, method, params })}\n`);
  };
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId;
    nextId += 1;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
      child.kill('SIGTERM');
    }, APP_SERVER_TIMEOUT_MS);
    pending.set(id, { reject, resolve, timer });
    send(method, params, id);
  });
  const unwrap = (method, response) => {
    if (response.error) {
      const errorCode = typeof response.error.code === 'number' ? response.error.code : 'unknown';
      throw new Error(`${method} failed with RPC code ${errorCode}`);
    }
    assert.ok(response.result && typeof response.result === 'object', `${method} result must be an object`);
    return response.result;
  };
  let observation;
  try {
    unwrap('initialize', await request('initialize', {
      clientInfo: {
        name: 'aidrian-s5-native-proof',
        title: 'Aidrian S5 Native Proof',
        version: '0.0.0',
      },
    }));
    send('initialized', {});
    const configResult = unwrap('config/read', await request('config/read', {
      cwd: projectRoot,
      includeLayers: true,
    }));
    let roleResult;
    if (roleRequest) {
      roleResult = await runPersistedRoleProof({
        projectRoot,
        roleRequest,
        request,
        notificationInbox,
      });
    }
    const hooksResult = includeHooks
      ? unwrap('hooks/list', await request('hooks/list', { cwds: [projectRoot] }))
      : undefined;
    observation = { configResult, hooksResult, roleResult };
  } finally {
    await closeOwnedChild(child, closed);
  }
  if (fatalError) throw fatalError;
  assert.equal(
    stderr.split(/\r?\n/).some((line) => /warning|error|unrecognized/i.test(line)),
    false,
    'Codex app-server must not emit warnings or errors',
  );
  return observation;
};

const collectNamedValues = (value, key, found = [], seen = new Set()) => {
  if (!value || typeof value !== 'object' || seen.has(value)) return found;
  seen.add(value);
  if (!Array.isArray(value) && Object.hasOwn(value, key)) found.push(value[key]);
  for (const nested of Object.values(value)) collectNamedValues(nested, key, found, seen);
  return found;
};

const assertProjectConfiguration = async ({ configResult, projectRoot }) => {
  assert.ok(Array.isArray(configResult.layers), 'config/read layers must be an array');
  const layerName = (layer) => (
    typeof layer.name === 'string' ? layer.name : JSON.stringify(layer.name ?? layer.source ?? '')
  );
  const sessionLayers = configResult.layers.filter((layer) => (
    layer?.config?.projects && typeof layer.config.projects === 'object'
  ));
  assert.equal(sessionLayers.length, 1, 'exactly one sessionFlags projects map is required');
  const sessionLayer = sessionLayers[0];
  assert.match(layerName(sessionLayer), /session.?flags/i);
  assert.equal(sessionLayer.disabledReason ?? null, null, 'sessionFlags layer must be enabled');
  assert.deepEqual(Object.keys(sessionLayer.config.projects), [projectRoot]);
  const trustEntry = sessionLayer.config.projects[projectRoot];
  assert.equal(trustEntry?.trust_level ?? trustEntry?.trustLevel, 'trusted');

  const projectLayers = configResult.layers.filter((layer) => (
    layer?.config?.agents?.explorer
    && /project/i.test(layerName(layer))
    && JSON.stringify(layer).includes(projectRoot)
  ));
  assert.equal(projectLayers.length, 1, 'exactly one project layer with explorer mapping is required');
  const projectLayer = projectLayers[0];
  assert.equal(projectLayer.disabledReason ?? null, null, 'project layer must be enabled');
  const expectedDotCodex = path.join(projectRoot, '.codex');
  assert.equal(await realpath(expectedDotCodex), expectedDotCodex);
  assert.deepEqual(
    [...new Set(collectNamedValues(projectLayer, 'dotCodexFolder'))],
    [expectedDotCodex],
  );
  const explorerConfig = projectLayer.config.agents.explorer;
  const explorerConfigFile = explorerConfig.config_file ?? explorerConfig.configFile;
  const expectedExplorer = path.join(expectedDotCodex, 'agents/explorer.toml');
  assert.equal(path.resolve(explorerConfigFile), expectedExplorer);
  assert.equal(await realpath(expectedExplorer), expectedExplorer);
};

const assertFixtureHookState = ({ hooksResult, projectRoot, expectedStatus }) => {
  assert.ok(Array.isArray(hooksResult?.data), 'hooks/list result.data must be an array');
  assert.equal(hooksResult.data.length, 1, 'hooks/list must return exactly one cwd entry');
  const [entry] = hooksResult.data;
  assert.equal(entry.cwd, projectRoot);
  assert.deepEqual(entry.warnings, []);
  assert.deepEqual(entry.errors, []);
  assert.ok(Array.isArray(entry.hooks));
  const matches = entry.hooks.filter((hook) => (
    hook.pluginId === FIXTURE_PLUGIN_ID && hook.eventName === 'SessionStart'
  ));
  assert.equal(matches.length, 1, 'exactly one fixture SessionStart hook is required');
  const [hook] = matches;
  assert.equal(hook.source, 'plugin');
  assert.equal(hook.enabled, true);
  assert.equal(hook.isManaged, false);
  const expectedStatuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  assert.equal(
    expectedStatuses.includes(hook.trustStatus),
    true,
    `fixture trust status must be one of: ${expectedStatuses.join(', ')}`,
  );
  assert.equal(typeof hook.key, 'string');
  assert.ok(hook.key.length > 0);
  assert.equal(typeof hook.currentHash, 'string');
  assert.ok(hook.currentHash.length > 0);
  return { currentHash: hook.currentHash, hookKey: hook.key };
};

test('runNonInteractiveCommand sends immediate EOF to child stdin', async () => {
  const marker = 'AIDRIAN_CODEX_STDIN_EOF';
  const result = await runNonInteractiveCommand(process.execPath, [
    '--input-type=module',
    '-e',
    `process.stdin.resume(); process.stdin.once('end', () => process.stdout.write('${marker}'));`,
  ], { cwd: ROOT, env: process.env, timeout: 10_000 });
  assert.equal(result.stdout, marker);
  assert.equal(result.stderr, '');
});

test('runNonInteractiveCommand rejects output above one MiB', async () => {
  await assert.rejects(
    runNonInteractiveCommand(process.execPath, [
      '--input-type=module',
      '-e',
      `process.stdout.write('x'.repeat(${MAX_BUFFER + 1}));`,
    ], { cwd: ROOT, env: process.env, timeout: 10_000 }),
    (error) => {
      assert.equal(error.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
      assert.equal(Buffer.byteLength(error.stdout, 'utf8') <= MAX_BUFFER, true);
      assert.equal(Buffer.byteLength(error.stderr, 'utf8') <= MAX_BUFFER, true);
      return true;
    },
  );
});

test('app-server transport rejects unsolicited server requests without answering them', () => {
  assert.throws(
    () => classifyAppServerMessage(
      { id: 7, method: 'item/commandExecution/requestApproval', params: {} },
      new Set([7]),
    ),
    /unsolicited request: method=item\/commandExecution\/requestApproval/,
  );
  assert.throws(
    () => classifyAppServerMessage({ id: 8, result: {} }, new Set([7])),
    /unknown request id/,
  );
});

test('notification inbox times out waits without retaining a waiter', async () => {
  const inbox = createNotificationInbox();
  await assert.rejects(
    inbox.waitFor(() => false, { label: 'fixture notification', timeout: 5 }),
    /fixture notification timed out/,
  );
  assert.equal(inbox.waitingCount(), 0);
});

test('closeOwnedChild closes owned app-server stdin after observation', async () => {
  let ended = 0;
  let killed = 0;
  const child = {
    stdin: { destroyed: false, end: () => { ended += 1; } },
    kill: () => { killed += 1; },
  };
  assert.deepEqual(await closeOwnedChild(child, Promise.resolve({ code: 0, signal: null })), {
    code: 0,
    signal: null,
  });
  assert.equal(ended, 1);
  assert.equal(killed, 0);
});

const buildPersistedRoleFixture = (representation = 'dual') => {
  const rootThreadId = 'root-thread';
  const rootTurnId = 'root-turn';
  const childId = 'child-thread';
  const childTurnId = 'child-turn';
  const childTask = 'Inspect only the immutable role instructions and return the requested qualifier.';
  const roleSentinel = 'role-only-qualifier';
  const rolePrompt = [
    'Use the collaboration spawn operation exactly once with these exact arguments:',
    '`agent_type` is `explorer`,',
    '`task_name` is `persisted_role_fixture`,',
    '`fork_turns` is `none`,',
    `and \`message\` is exactly ${JSON.stringify(childTask)}.`,
    'Wait for that child to complete, then relay only its result verbatim.',
  ].join(' ');
  const userMessage = (id, text) => ({
    type: 'userMessage',
    id,
    content: [{ type: 'text', text, textElements: [] }],
  });
  const v1Spawn = {
    type: 'collabAgentToolCall',
    id: 'spawn-v1',
    tool: 'spawnAgent',
    status: 'completed',
    senderThreadId: rootThreadId,
    receiverThreadIds: [childId],
    prompt: childTask,
    model: EXPLORER_MODEL,
    reasoningEffort: null,
    agentsStates: {},
  };
  const v2Spawn = {
    type: 'subAgentActivity',
    id: 'spawn-v2',
    kind: 'started',
    agentThreadId: childId,
    agentPath: 'explorer-canary',
    model: EXPLORER_MODEL,
    reasoningEffort: null,
  };
  const representationItems = representation === 'v1'
    ? [v1Spawn]
    : representation === 'v2'
      ? [v2Spawn]
      : [v1Spawn, v2Spawn];
  const rootThread = {
    id: rootThreadId,
    cwd: '/fixture/project',
    parentThreadId: null,
    status: { type: 'idle' },
    turns: [{
      id: rootTurnId,
      status: 'completed',
      error: null,
      items: [
        userMessage('root-user', rolePrompt),
        ...representationItems,
        { type: 'agentMessage', id: 'root-result', text: roleSentinel },
      ],
    }],
  };
  const childThread = {
    id: childId,
    parentThreadId: rootThreadId,
    agentRole: 'explorer',
    model: EXPLORER_MODEL,
    status: { type: 'idle' },
    turns: [{
      id: childTurnId,
      status: 'completed',
      error: null,
      items: [
        userMessage('child-user', childTask),
        { type: 'agentMessage', id: 'child-result', text: roleSentinel },
      ],
    }],
  };
  return {
    childId,
    childTask,
    childThread,
    childTurnId,
    rolePrompt,
    roleRequest: { rolePrompt, childTask, roleSentinel },
    roleSentinel,
    rootThread,
    rootThreadId,
    rootTurnId,
    v1Spawn,
    v2Spawn,
  };
};

const createPersistedRoleTransport = (fixture, overrides = {}) => {
  const calls = [];
  const notificationInbox = createNotificationInbox();
  notificationInbox.push({
    method: 'turn/completed',
    params: {
      threadId: fixture.rootThreadId,
      turn: { id: fixture.rootTurnId, status: 'completed', error: null },
    },
  });
  let deleted = false;
  const request = async (method, params) => {
    calls.push({ method, params: structuredClone(params) });
    if (method === 'thread/start') {
      return overrides.startResponse ?? {
        result: {
          cwd: fixture.rootThread.cwd,
          approvalPolicy: 'never',
          sandbox: { type: 'readOnly', networkAccess: false },
          thread: { id: fixture.rootThreadId, cwd: fixture.rootThread.cwd },
        },
      };
    }
    if (method === 'turn/start') {
      return overrides.turnResponse ?? {
        result: { turn: { id: fixture.rootTurnId, status: 'inProgress' } },
      };
    }
    if (method === 'thread/delete') {
      if (overrides.deleteResponse) return overrides.deleteResponse;
      deleted = true;
      notificationInbox.push({
        method: 'thread/deleted',
        params: { threadId: fixture.childId },
      });
      notificationInbox.push({
        method: 'thread/deleted',
        params: { threadId: fixture.rootThreadId },
      });
      return { result: {} };
    }
    if (method === 'thread/read' && deleted) {
      return overrides.postDeleteReadResponse ?? { error: { code: -32600 } };
    }
    if (method === 'thread/read' && params.threadId === fixture.rootThreadId) {
      return overrides.rootReadResponse
        ?? { result: { thread: structuredClone(fixture.rootThread) } };
    }
    if (method === 'thread/read' && params.threadId === fixture.childId) {
      return overrides.childReadResponse
        ?? { result: { thread: structuredClone(fixture.childThread) } };
    }
    return { error: { code: -32600 } };
  };
  return { calls, notificationInbox, request };
};

test('persisted role proof validates full histories without transcript disclosure', async (t) => {
  await t.test('uses persisted read-only start and exact-id read/delete parameters', () => {
    assert.deepEqual(persistedThreadStartParams('/fixture/project'), {
      cwd: '/fixture/project',
      ephemeral: false,
      approvalPolicy: 'never',
      sandbox: 'read-only',
    });
    assert.deepEqual(persistedThreadReadParams('fixture-thread', true), {
      threadId: 'fixture-thread',
      includeTurns: true,
    });
    assert.deepEqual(persistedThreadDeleteParams('fixture-thread'), {
      threadId: 'fixture-thread',
    });
  });

  for (const representation of ['v1', 'v2', 'dual']) {
    await t.test(`accepts ${representation} persisted spawn representation`, () => {
      const fixture = buildPersistedRoleFixture(representation);
      if (representation === 'v2') {
        fixture.rootThread.turns[0].items.push({
          ...structuredClone(fixture.v2Spawn),
          id: 'spawn-v2-completed',
          kind: 'completed',
        });
      }
      const rootProof = extractPersistedRoleChild({
        rootThread: fixture.rootThread,
        rootThreadId: fixture.rootThreadId,
        rootTurnId: fixture.rootTurnId,
        rolePrompt: fixture.rolePrompt,
        childTask: fixture.childTask,
      });
      assert.equal(rootProof.childId, fixture.childId);
      assert.equal(rootProof.spawnRepresentations, representation === 'dual' ? 2 : 1);
      assert.deepEqual(validatePersistedRoleChild({
        childThread: fixture.childThread,
        childId: fixture.childId,
        rootThreadId: fixture.rootThreadId,
        rolePrompt: fixture.rolePrompt,
        childTask: fixture.childTask,
        roleSentinel: fixture.roleSentinel,
      }), { childItemCount: 2 });
    });
  }

  const rootFailures = [
    ['absent spawn', (fixture) => {
      fixture.rootThread.turns[0].items = fixture.rootThread.turns[0].items.filter((item) => ![
        'collabAgentToolCall',
        'subAgentActivity',
      ].includes(item.type));
    }],
    ['conflicting spawn representations', (fixture) => {
      fixture.v2Spawn.agentThreadId = 'conflicting-child';
    }],
    ['multiple spawn items', (fixture) => {
      fixture.rootThread.turns[0].items.push({
        ...structuredClone(fixture.v1Spawn),
        id: 'spawn-v1-duplicate',
      });
    }],
    ['forbidden root item', (fixture) => {
      fixture.rootThread.turns[0].items.push({ type: 'commandExecution', id: 'forbidden-root' });
    }],
    ['failed root turn', (fixture) => { fixture.rootThread.turns[0].status = 'failed'; }],
    ['interrupted root turn', (fixture) => { fixture.rootThread.turns[0].status = 'interrupted'; }],
  ];
  for (const [label, mutate] of rootFailures) {
    await t.test(`rejects ${label}`, () => {
      const fixture = buildPersistedRoleFixture();
      mutate(fixture);
      assert.throws(() => extractPersistedRoleChild({
        rootThread: fixture.rootThread,
        rootThreadId: fixture.rootThreadId,
        rootTurnId: fixture.rootTurnId,
        rolePrompt: fixture.rolePrompt,
        childTask: fixture.childTask,
      }), { code: 'ROLE_PROOF_ROOT_HISTORY_INVALID' });
    });
  }

  for (const [label, malformedReceiver] of [
    ['empty string', ''],
    ['null', null],
    ['zero', 0],
    ['false', false],
    ['undefined', undefined],
  ]) {
    await t.test(`rejects ${label} V1 receiver beside valid V2 evidence`, () => {
      const fixture = buildPersistedRoleFixture('dual');
      fixture.v1Spawn.receiverThreadIds[0] = malformedReceiver;
      assert.throws(() => extractPersistedRoleChild({
        rootThread: fixture.rootThread,
        rootThreadId: fixture.rootThreadId,
        rootTurnId: fixture.rootTurnId,
        rolePrompt: fixture.rolePrompt,
        childTask: fixture.childTask,
      }), { code: 'ROLE_PROOF_ROOT_HISTORY_INVALID' });
    });
  }

  const childFailures = [
    ['wrong parent', (fixture) => { fixture.childThread.parentThreadId = 'wrong-parent'; }],
    ['wrong role', (fixture) => { fixture.childThread.agentRole = 'default'; }],
    ['wrong model', (fixture) => { fixture.childThread.model = 'wrong-model'; }],
    ['wrong task', (fixture) => {
      fixture.childThread.turns[0].items[0].content[0].text = 'wrong-task';
    }],
    ['inherited root prompt', (fixture) => {
      fixture.childThread.turns[0].items[0].content[0].text = fixture.rolePrompt;
    }],
    ['wrong terminal result', (fixture) => {
      fixture.childThread.turns[0].items[1].text = 'wrong-result';
    }],
    ['multiple terminal results', (fixture) => {
      fixture.childThread.turns[0].items.push({
        type: 'agentMessage',
        id: 'second-result',
        text: fixture.roleSentinel,
      });
    }],
    ['forbidden child item', (fixture) => {
      fixture.childThread.turns[0].items.push({ type: 'fileChange', id: 'forbidden-child' });
    }],
    ['failed child turn', (fixture) => { fixture.childThread.turns[0].status = 'failed'; }],
    ['interrupted child turn', (fixture) => { fixture.childThread.turns[0].status = 'interrupted'; }],
  ];
  for (const [label, mutate] of childFailures) {
    await t.test(`rejects ${label}`, () => {
      const fixture = buildPersistedRoleFixture();
      mutate(fixture);
      assert.throws(() => validatePersistedRoleChild({
        childThread: fixture.childThread,
        childId: fixture.childId,
        rootThreadId: fixture.rootThreadId,
        rolePrompt: fixture.rolePrompt,
        childTask: fixture.childTask,
        roleSentinel: fixture.roleSentinel,
      }), { code: 'ROLE_PROOF_CHILD_HISTORY_INVALID' });
    });
  }

  for (const [label, mutate, validate] of [
    ['root task', (fixture, marker) => {
      fixture.rootThread.turns[0].items[0].content[0].text = marker;
    }, (fixture) => extractPersistedRoleChild({
      rootThread: fixture.rootThread,
      rootThreadId: fixture.rootThreadId,
      rootTurnId: fixture.rootTurnId,
      rolePrompt: fixture.rolePrompt,
      childTask: fixture.childTask,
    })],
    ['child result', (fixture, marker) => {
      fixture.childThread.turns[0].items[1].text = marker;
    }, (fixture) => validatePersistedRoleChild({
      childThread: fixture.childThread,
      childId: fixture.childId,
      rootThreadId: fixture.rootThreadId,
      rolePrompt: fixture.rolePrompt,
      childTask: fixture.childTask,
      roleSentinel: fixture.roleSentinel,
    })],
  ]) {
    await t.test(`sanitizes ${label} transcript mismatch failures`, () => {
      const fixture = buildPersistedRoleFixture();
      const privateMarker = 'PRIVATE_TRANSCRIPT_MARKER_88e5';
      mutate(fixture, privateMarker);
      let failure;
      try {
        validate(fixture);
      } catch (error) {
        failure = error;
      }
      assert.ok(failure);
      assert.equal(JSON.stringify({
        code: failure.code,
        message: failure.message,
        stack: failure.stack,
        actual: failure.actual,
        expected: failure.expected,
        cause: failure.cause,
      }).includes(privateMarker), false);
      assert.deepEqual(
        Object.keys(failure).sort(),
        ['code'],
        'role history failures must carry only a fixed code',
      );
    });
  }
});

test('persisted role cleanup deletes the exact root subtree once on success and failure', async (t) => {
  await t.test('proves history then observes child-before-root deletion and read rejection', async () => {
    const fixture = buildPersistedRoleFixture();
    const transport = createPersistedRoleTransport(fixture);
    const result = await runPersistedRoleProof({
      projectRoot: fixture.rootThread.cwd,
      roleRequest: fixture.roleRequest,
      request: transport.request,
      notificationInbox: transport.notificationInbox,
    });
    assert.deepEqual(result, {
      persistedHistoryVerified: true,
      rootItemCount: 4,
      childItemCount: 2,
      spawnRepresentations: 2,
      cleanupVerified: true,
    });
    assert.deepEqual(transport.calls[0], {
      method: 'thread/start',
      params: persistedThreadStartParams(fixture.rootThread.cwd),
    });
    assert.deepEqual(transport.calls[1], {
      method: 'turn/start',
      params: {
        threadId: fixture.rootThreadId,
        input: [{ type: 'text', text: fixture.rolePrompt, textElements: [] }],
      },
    });
    assert.deepEqual(transport.calls.map(({ method }) => method), [
      'thread/start',
      'turn/start',
      'thread/read',
      'thread/read',
      'thread/delete',
      'thread/read',
      'thread/read',
    ]);
    const deleteCalls = transport.calls.filter(({ method }) => method === 'thread/delete');
    assert.deepEqual(deleteCalls, [{
      method: 'thread/delete',
      params: { threadId: fixture.rootThreadId },
    }]);
    assert.deepEqual(
      transport.notificationInbox.notifications
        .filter(({ method }) => method === 'thread/deleted')
        .map(({ params }) => params.threadId),
      [fixture.childId, fixture.rootThreadId],
    );
    assert.deepEqual(transport.calls.slice(-2).map(({ params }) => params), [
      { threadId: fixture.childId, includeTurns: false },
      { threadId: fixture.rootThreadId, includeTurns: false },
    ]);
  });

  const proofFailures = [
    ['invalid start policy', (fixture, overrides) => {
      overrides.startResponse = {
        result: {
          cwd: fixture.rootThread.cwd,
          approvalPolicy: 'on-request',
          sandbox: { type: 'readOnly', networkAccess: false },
          thread: { id: fixture.rootThreadId, cwd: fixture.rootThread.cwd },
        },
      };
    }, 'ROLE_PROOF_START_INVALID'],
    ['missing networkAccess evidence', (fixture, overrides) => {
      overrides.startResponse = {
        result: {
          cwd: fixture.rootThread.cwd,
          approvalPolicy: 'never',
          sandbox: { type: 'readOnly' },
          thread: { id: fixture.rootThreadId, cwd: fixture.rootThread.cwd },
        },
      };
    }, 'ROLE_PROOF_START_INVALID'],
    ['enabled networkAccess evidence', (fixture, overrides) => {
      overrides.startResponse = {
        result: {
          cwd: fixture.rootThread.cwd,
          approvalPolicy: 'never',
          sandbox: { type: 'readOnly', networkAccess: true },
          thread: { id: fixture.rootThreadId, cwd: fixture.rootThread.cwd },
        },
      };
    }, 'ROLE_PROOF_START_INVALID'],
    ['invalid turn start', (_fixture, overrides) => {
      overrides.turnResponse = { result: { turn: { id: 'root-turn', status: 'completed' } } };
    }, 'ROLE_PROOF_TURN_INVALID'],
    ['invalid root history', (fixture) => {
      fixture.rootThread.turns[0].status = 'failed';
    }, 'ROLE_PROOF_ROOT_HISTORY_INVALID'],
    ['root history read rejection', (_fixture, overrides) => {
      overrides.rootReadResponse = { error: { code: -32600 } };
    }, 'ROLE_PROOF_RPC_FAILED'],
    ['invalid child history', (fixture) => {
      fixture.childThread.agentRole = 'default';
    }, 'ROLE_PROOF_CHILD_HISTORY_INVALID'],
    ['child history read rejection', (_fixture, overrides) => {
      overrides.childReadResponse = { error: { code: -32600 } };
    }, 'ROLE_PROOF_RPC_FAILED'],
  ];
  for (const [label, mutate, expectedCode] of proofFailures) {
    await t.test(`runs cleanup after ${label}`, async () => {
      const fixture = buildPersistedRoleFixture();
      const overrides = {};
      mutate(fixture, overrides);
      const transport = createPersistedRoleTransport(fixture, overrides);
      await assert.rejects(runPersistedRoleProof({
        projectRoot: fixture.rootThread.cwd,
        roleRequest: fixture.roleRequest,
        request: transport.request,
        notificationInbox: transport.notificationInbox,
      }), { code: expectedCode });
      assert.deepEqual(
        transport.calls.filter(({ method }) => method === 'thread/delete'),
        [{ method: 'thread/delete', params: { threadId: fixture.rootThreadId } }],
      );
    });
  }

  for (const [label, overrides] of [
    ['delete rejection', { deleteResponse: { error: { code: -32600 } } }],
    ['post-delete readable child', { postDeleteReadResponse: { result: { thread: {} } } }],
  ]) {
    await t.test(`fails closed on ${label} without retry`, async () => {
      const fixture = buildPersistedRoleFixture();
      const transport = createPersistedRoleTransport(fixture, overrides);
      await assert.rejects(runPersistedRoleProof({
        projectRoot: fixture.rootThread.cwd,
        roleRequest: fixture.roleRequest,
        request: transport.request,
        notificationInbox: transport.notificationInbox,
      }), { code: 'ROLE_PROOF_CLEANUP_FAILED' });
      assert.equal(
        transport.calls.filter(({ method }) => method === 'thread/delete').length,
        1,
      );
    });
  }
});

const bundlePinsFromBundle = (bundle) => ({
  schemaVersion: bundle.schemaVersion,
  sourceCommit: bundle.sourceCommit,
  builder: bundle.builder,
  plugin: bundle.plugin,
  manifestDigest: bundle.manifestDigest,
  bundleDigest: bundle.bundleDigest,
  provenanceManifestDigest: bundle.provenanceManifestDigest,
  providerManifestDigests: bundle.providerManifestDigests,
  capabilityManifestDigest: bundle.capabilityManifestDigest,
});

const allocateIsolatedFixture = async (t, {
  root,
  projectKind = 'fresh-component',
}) => {
  assert.equal(
    ['fresh-component', 'persistent-hook'].includes(projectKind),
    true,
    'projectKind must select a supported isolation policy',
  );
  await assertCanonicalDirectory(root, 'fixture root');
  const home = path.join(root, 'home');
  const codexHome = path.join(root, 'codex-home');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await assertCanonicalDirectory(home, 'home');
  await assertCanonicalDirectory(codexHome, 'codexHome');
  let projectRoot;
  let cleanupProject = async () => {};
  if (projectKind === 'fresh-component') {
    const componentWorkspaces = path.join(root, 'component-workspaces');
    await mkdir(componentWorkspaces, { recursive: true, mode: 0o700 });
    await assertCanonicalDirectory(componentWorkspaces, 'component workspaces');
    assertStrictDescendant(root, componentWorkspaces, 'component workspaces');
    assert.equal(
      new Set([root, home, codexHome, componentWorkspaces]).size,
      4,
      'component workspace parent must not alias provider state',
    );
    projectRoot = await realpath(await mkdtemp(path.join(componentWorkspaces, 'project-')));
    assert.equal(path.dirname(projectRoot), componentWorkspaces);
    assert.equal(path.basename(projectRoot).startsWith('project-'), true);
    cleanupProject = registerExactDirectoryCleanup(t, {
      parent: componentWorkspaces,
      target: projectRoot,
      prefix: 'project-',
    });
  } else {
    projectRoot = path.join(root, 'hook-project-v1');
    await mkdir(projectRoot, { recursive: true, mode: 0o700 });
  }
  await assertOwnedFixtureRoots({ root, home, codexHome, projectRoot });
  return {
    root,
    projectRoot,
    cleanupProject,
    env: { ...process.env, PATH, HOME: home, CODEX_HOME: codexHome },
  };
};

const isolated = async (t, {
  rootEnvironmentVariable = 'AIDRIAN_CODEX_CANARY_ROOT',
  projectKind = 'fresh-component',
} = {}) => {
  const configuredRoot = process.env[rootEnvironmentVariable];
  const canonicalTmp = await realpath(tmpdir());
  const root = configuredRoot
    ? await realpath(path.resolve(configuredRoot))
    : await realpath(await mkdtemp(path.join(canonicalTmp, 'aidrian-codex-native-')));
  assert.equal(
    root.startsWith('/private/tmp/') || root.startsWith(`${canonicalTmp}${path.sep}`),
    true,
    `${rootEnvironmentVariable} must resolve inside an approved temporary root`,
  );
  const fixture = await allocateIsolatedFixture(t, { root, projectKind });
  if (!configuredRoot) {
    const cleanupRoot = createExactDirectoryCleanup({
      parent: canonicalTmp,
      target: root,
      prefix: 'aidrian-codex-native-',
    });
    t.after(async () => {
      await fixture.cleanupProject();
      await cleanupRoot();
    });
  }
  return fixture;
};

test('isolated workspace allocator separates fresh components from persistent provider state', async (t) => {
  const canonicalTmp = await realpath(tmpdir());
  const root = await realpath(await mkdtemp(path.join(canonicalTmp, 'aidrian-codex-allocation-')));
  const cleanupRoot = createExactDirectoryCleanup({
    parent: canonicalTmp,
    target: root,
    prefix: 'aidrian-codex-allocation-',
  });
  const cleanupProjects = [];
  t.after(async () => {
    for (const cleanup of cleanupProjects) await cleanup();
    await cleanupRoot();
  });

  const hook = await allocateIsolatedFixture(t, { root, projectKind: 'persistent-hook' });
  const componentA = await allocateIsolatedFixture(t, { root, projectKind: 'fresh-component' });
  cleanupProjects.push(componentA.cleanupProject);
  const componentMarker = path.join(componentA.projectRoot, 'managed-ledger-sentinel');
  await writeFile(componentMarker, 'component-a\n');
  const homeSentinel = path.join(hook.env.HOME, 'home-state-sentinel');
  const providerSentinel = path.join(hook.env.CODEX_HOME, 'provider-state-sentinel');
  const hookSentinel = path.join(hook.projectRoot, 'hook-state-sentinel');
  const legacyProject = path.join(root, 'project');
  const legacySentinel = path.join(legacyProject, 'legacy-project-sentinel');
  await mkdir(legacyProject, { recursive: true, mode: 0o700 });
  await writeFile(homeSentinel, 'home-state\n');
  await writeFile(providerSentinel, 'provider-state\n');
  await writeFile(hookSentinel, 'hook-state\n');
  await writeFile(legacySentinel, 'legacy-project\n');

  const componentB = await allocateIsolatedFixture(t, { root, projectKind: 'fresh-component' });
  cleanupProjects.push(componentB.cleanupProject);
  const componentWorkspaces = path.join(root, 'component-workspaces');
  assert.notEqual(componentA.projectRoot, componentB.projectRoot);
  assertStrictDescendant(componentWorkspaces, componentA.projectRoot, 'component A');
  assertStrictDescendant(componentWorkspaces, componentB.projectRoot, 'component B');
  assert.equal(path.dirname(componentA.projectRoot), componentWorkspaces);
  assert.equal(path.dirname(componentB.projectRoot), componentWorkspaces);
  await assert.rejects(readFile(path.join(componentB.projectRoot, path.basename(componentMarker))), {
    code: 'ENOENT',
  });
  for (const component of [componentA, componentB]) {
    assert.equal(
      [component.env.HOME, component.env.CODEX_HOME, hook.projectRoot].includes(component.projectRoot),
      false,
    );
  }

  await componentA.cleanupProject();
  await componentB.cleanupProject();
  await assert.rejects(lstat(componentA.projectRoot), { code: 'ENOENT' });
  await assert.rejects(lstat(componentB.projectRoot), { code: 'ENOENT' });
  assert.equal(await readFile(homeSentinel, 'utf8'), 'home-state\n');
  assert.equal(await readFile(providerSentinel, 'utf8'), 'provider-state\n');
  assert.equal(await readFile(hookSentinel, 'utf8'), 'hook-state\n');
  assert.equal(await readFile(legacySentinel, 'utf8'), 'legacy-project\n');
});

test('Codex 0.164.0 invokes a real packaged skill and projected GPT-5.6 custom agent without downgrade', async (t) => {
  assert.equal(createHash('sha256').update(await readFile(CODEX)).digest('hex'), CODEX_SHA256);
  const fixture = await isolated(t);
  const options = { cwd: fixture.projectRoot, env: fixture.env, timeout: 240_000 };
  assert.match((await runNonInteractiveCommand(CODEX, ['--version'], options)).stdout, /0\.164\.0/);
  await assert.doesNotReject(
    runNonInteractiveCommand(CODEX, ['login', 'status'], options),
    'native Codex E2E requires fresh authentication in the isolated CODEX_HOME',
  );
  await runNonInteractiveCommand(CODEX, ['plugin', 'marketplace', 'add', ROOT, '--json'], options);
  const added = JSON.parse((await runNonInteractiveCommand(
    CODEX,
    ['plugin', 'add', 'aidrian@aidrian-private', '--json'],
    options,
  )).stdout);
  const packagedSkill = await readFile(path.join(ROOT, 'plugins/aidrian/skills/grill-me/SKILL.md'));
  assert.equal(createHash('sha256').update(packagedSkill).digest('hex'), GRILL_ME_SHA256);
  const installedPlugins = JSON.parse((await runNonInteractiveCommand(
    CODEX,
    ['plugin', 'list', '--json'],
    options,
  )).stdout);
  const installedAidrian = installedPlugins.installed.find(
    ({ pluginId }) => pluginId === 'aidrian@aidrian-private',
  );
  assert.ok(installedAidrian, 'Codex must report the exact installed Aidrian package');
  assert.deepEqual(
    { pluginId: installedAidrian.pluginId, version: installedAidrian.version },
    { pluginId: 'aidrian@aidrian-private', version: '0.0.0' },
  );
  const installedSkill = await readFile(path.join(added.installedPath, 'skills/grill-me/SKILL.md'));
  assert.equal(createHash('sha256').update(installedSkill).digest('hex'), GRILL_ME_SHA256);
  const { bundle } = await assemblePrivateDistribution({ root: ROOT });
  await applyManagedPlan(await planManagedInstall({
    projectRoot: fixture.projectRoot,
    bundle,
    activationMode: 'marketplace-companion',
    expectedBundlePins: bundlePinsFromBundle(bundle),
    expectedPriorProjection: null,
  }));
  const projectedConfig = await readFile(path.join(fixture.projectRoot, '.codex/config.toml'), 'utf8');
  assert.equal(
    createHash('sha256').update(bundle.codexConfigBlock).digest('hex'),
    bundle.codexConfigBlockDigest,
  );
  assert.equal(projectedConfig.includes(bundle.codexConfigBlock), true);
  const registryEntry = bundle.codexConfigBlock.match(
    /\[agents\.explorer\]\ndescription = "[^"]+"\nconfig_file = "([^"]+)"/,
  );
  assert.ok(registryEntry, 'generated registry must contain exactly parseable explorer mapping');
  assert.equal(registryEntry[1], 'agents/explorer.toml');
  assert.equal((bundle.codexConfigBlock.match(/\[agents\.explorer\]/g) ?? []).length, 1);
  const explorerPath = '.codex/agents/explorer.toml';
  const explorerBytes = await readFile(path.join(fixture.projectRoot, explorerPath));
  const explorerBundleFile = bundle.files.find(({ path: relative }) => relative === explorerPath);
  assert.ok(explorerBundleFile);
  assert.equal(createHash('sha256').update(explorerBytes).digest('hex'), explorerBundleFile.sha256);
  assert.deepEqual(explorerBytes, Buffer.from(explorerBundleFile.contentBase64, 'base64'));
  const explorerText = explorerBytes.toString('utf8');
  assert.equal((explorerText.match(/^model = "gpt-5\.6-terra"$/gm) ?? []).length, 1);
  const sentinelMatch = explorerText.match(/^Enumeration completeness \(([^)]+)\):$/m);
  assert.ok(sentinelMatch, 'explorer projection must carry the immutable role-only heading qualifier');
  const roleSentinel = sentinelMatch[1];
  assert.equal(roleSentinel, 'mandatory for enumeration tasks');
  for (const file of bundle.files.filter(({ path: relative }) => (
    relative.startsWith('.codex/agents/') && relative !== explorerPath
  ))) {
    assert.equal(
      Buffer.from(file.contentBase64, 'base64').includes(Buffer.from(roleSentinel)),
      false,
      `${roleSentinel} must remain explorer-only`,
    );
  }
  const projectTrustOverride = buildProjectTrustOverride(fixture.projectRoot);
  const { configResult } = await observeCodexAppServer({
    projectRoot: fixture.projectRoot,
    env: fixture.env,
    includeHooks: false,
  });
  await assertProjectConfiguration({ configResult, projectRoot: fixture.projectRoot });
  await mkdir(path.join(fixture.projectRoot, 'ui'), { recursive: true });
  await writeFile(path.join(fixture.projectRoot, 'button-plan.md'), [
    '# Button rename plan',
    '',
    'Rename the label declared in ui/button.txt.',
    'The only Human decision is whether to preserve the old label as an alias for one release.',
    '',
  ].join('\n'));
  await writeFile(path.join(fixture.projectRoot, 'ui/button.txt'), 'label=Save\n');
  const skillPrompt = '$aidrian:grill-me Stress-test button-plan.md and follow the skill workflow.';
  const skill = await runNonInteractiveCommand(CODEX, [
    'exec',
    '--strict-config',
    '--ephemeral',
    '--skip-git-repo-check',
    '--config',
    projectTrustOverride,
    '-C',
    fixture.projectRoot,
    skillPrompt,
  ], options);
  assert.match(skill.stdout, /Save/);
  assert.match(skill.stdout, /recommend/i);
  assert.equal((skill.stdout.match(/\?/g) ?? []).length, 1, 'grill-me must ask one question at a time');
  const childTask = [
    'Inspect only your immutable role instructions.',
    'Return only the text inside parentheses in the heading whose prefix is `Enumeration completeness`.',
  ].join(' ');
  const taskName = `aidrian_explorer_${path.basename(fixture.projectRoot)}`
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_');
  const rolePrompt = [
    'Use the collaboration spawn operation exactly once with these exact arguments:',
    '`agent_type` is `explorer`,',
    `\`task_name\` is \`${taskName}\`,`,
    '`fork_turns` is `none`,',
    `and \`message\` is exactly ${JSON.stringify(childTask)}.`,
    'Do not read files, run commands, use another tool, perform the extraction yourself, or spawn another agent.',
    'Wait for that child to complete, then relay only its result verbatim.',
  ].join(' ');
  assert.equal(rolePrompt.includes(roleSentinel), false);
  assert.equal(childTask.includes(roleSentinel), false);
  const roleObservation = await observeCodexAppServer({
    projectRoot: fixture.projectRoot,
    env: fixture.env,
    includeHooks: false,
    roleRequest: { rolePrompt, childTask, roleSentinel },
  });
  await assertProjectConfiguration({
    configResult: roleObservation.configResult,
    projectRoot: fixture.projectRoot,
  });
  assert.equal(roleObservation.roleResult.persistedHistoryVerified, true);
  assert.equal(roleObservation.roleResult.cleanupVerified, true);
  assert.equal(roleObservation.roleResult.spawnRepresentations >= 1, true);
  assert.equal(roleObservation.roleResult.spawnRepresentations <= 2, true);
  assert.equal(roleObservation.roleResult.rootItemCount > 0, true);
  assert.equal(roleObservation.roleResult.childItemCount > 0, true);
});

test('Codex provider-owned trust runs unchanged fixture once and skips a definition mutation', async (t) => {
  const canaryRoot = process.env.AIDRIAN_CODEX_TRUST_CANARY_ROOT;
  assert.ok(canaryRoot, 'set AIDRIAN_CODEX_TRUST_CANARY_ROOT only after the supported isolated /hooks UI writes provider-owned trust');
  const fixture = await isolated(t, {
    rootEnvironmentVariable: 'AIDRIAN_CODEX_TRUST_CANARY_ROOT',
    projectKind: 'persistent-hook',
  });
  const { root: resolvedRoot, projectRoot } = fixture;
  const codexHome = fixture.env.CODEX_HOME;
  const home = fixture.env.HOME;
  const hookAttempts = path.join(resolvedRoot, 'hook-attempts');
  await mkdir(hookAttempts, { recursive: true, mode: 0o700 });
  await assertCanonicalDirectory(hookAttempts, 'hook attempts');
  assertStrictDescendant(resolvedRoot, hookAttempts, 'hook attempts');
  const hookAttempt = await realpath(await mkdtemp(path.join(hookAttempts, 'attempt-')));
  await assertCanonicalDirectory(hookAttempt, 'hook attempt');
  assertStrictDescendant(hookAttempts, hookAttempt, 'hook attempt');
  assert.equal(
    new Set([resolvedRoot, home, codexHome, projectRoot, hookAttempts, hookAttempt]).size,
    6,
    'hook attempt state must not alias persistent provider state',
  );
  registerExactDirectoryCleanup(t, {
    parent: hookAttempts,
    target: hookAttempt,
    prefix: 'attempt-',
  });
  const canary = path.join(hookAttempt, 'codex-hook-canary.log');
  const env = { ...fixture.env, AIDRIAN_FIXTURE_CANARY: canary };
  await assert.doesNotReject(
    runNonInteractiveCommand(CODEX, ['login', 'status'], { cwd: projectRoot, env, timeout: 60_000 }),
    'native Codex hook trust canary requires fresh authentication in the isolated CODEX_HOME',
  );
  const installedPlugin = path.join(
    codexHome,
    `plugins/cache/aidrian-hook-fixture/aidrian-codex-hook-fixture/${FIXTURE_VERSION}`,
  );
  const definitionPath = path.join(installedPlugin, 'hooks/hooks.json');
  const legacyPlugin = path.join(
    codexHome,
    'plugins/cache/aidrian-hook-fixture/aidrian-codex-hook-fixture/0.0.0',
  );
  const legacyPaths = [
    path.join(legacyPlugin, 'plugin.json'),
    path.join(legacyPlugin, 'hooks/hooks.json'),
    path.join(legacyPlugin, 'hooks/canary.mjs'),
  ];
  const readIfPresent = (candidate) => readFile(candidate).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const legacyBytes = await Promise.all(legacyPaths.map(readIfPresent));
  const fixtureMarketplace = path.join(import.meta.dirname, 'fixtures');
  const definitionExists = await readFile(definitionPath).then(() => true).catch((error) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (!definitionExists) {
    await runNonInteractiveCommand(CODEX, ['plugin', 'marketplace', 'add', fixtureMarketplace, '--json'], {
      cwd: projectRoot,
      env,
      timeout: 60_000,
    });
    const installed = await runNonInteractiveCommand(CODEX, ['plugin', 'add', 'aidrian-codex-hook-fixture@aidrian-hook-fixture', '--json'], {
      cwd: projectRoot,
      env,
      timeout: 60_000,
    });
    assert.equal(path.resolve(JSON.parse(installed.stdout).installedPath), installedPlugin);
  }
  assert.deepEqual(
    await Promise.all(legacyPaths.map(readIfPresent)),
    legacyBytes,
    'installing fixture 0.0.1 must not rewrite or delete the existing 0.0.0 cache',
  );
  const definition = await readFile(definitionPath);
  const definitionSha256 = createHash('sha256').update(definition).digest('hex');
  assert.equal(definitionSha256, 'bdc550fd8a5b90c1803e655651c0d5cd856b05ce8152614803522e062f9c7c22');
  const canaryCount = async () => readFile(canary, 'utf8')
    .then((text) => text.split('\n').filter(Boolean).length)
    .catch((error) => error.code === 'ENOENT' ? 0 : Promise.reject(error));
  const projectTrustOverride = buildProjectTrustOverride(projectRoot);
  const argumentsList = [
    'exec',
    '--strict-config',
    '--ephemeral',
    '--skip-git-repo-check',
    '--config',
    projectTrustOverride,
    '-C',
    projectRoot,
    'Reply with exactly AIDRIAN_CODEX_HOOK_OK.',
  ];
  const preTrustProof = path.join(resolvedRoot, 'aidrian-untrusted-hook-proof-v2.json');
  const proof = await readFile(preTrustProof, 'utf8')
    .then((text) => JSON.parse(text))
    .catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!proof) {
    assert.equal(await canaryCount(), 0, 'the isolated hook canary must start empty');
    const baseline = await observeCodexAppServer({
      projectRoot,
      env,
      includeHooks: true,
    });
    await assertProjectConfiguration({ configResult: baseline.configResult, projectRoot });
    const baselineHook = assertFixtureHookState({
      hooksResult: baseline.hooksResult,
      projectRoot,
      expectedStatus: 'untrusted',
    });
    assert.equal(await canaryCount(), 0, 'observing the untrusted hook must not execute the canary');
    await writeFile(preTrustProof, `${JSON.stringify({
      schemaVersion: 2,
      projectRoot,
      definitionSha256,
      hookKey: baselineHook.hookKey,
      currentHash: baselineHook.currentHash,
    }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    assert.fail([
      'untrusted hook baseline captured; start the supported pinned Codex TUI with a real PTY:',
      `cd ${JSON.stringify(projectRoot)} && HOME=${JSON.stringify(home)} CODEX_HOME=${JSON.stringify(codexHome)}`,
      `${JSON.stringify(CODEX)} --no-alt-screen --config ${JSON.stringify(projectTrustOverride)}`,
      `enter only /hooks, approve only ${FIXTURE_PLUGIN_ID} SessionStart matching the captured baseline, then exit and rerun this test`,
    ].join(' '));
  }
  assert.deepEqual(
    Object.keys(proof).sort(),
    ['currentHash', 'definitionSha256', 'hookKey', 'projectRoot', 'schemaVersion'],
  );
  assert.equal(proof.schemaVersion, 2);
  assert.equal(proof.projectRoot, projectRoot, 'hook proof must bind the exact canonical project');
  assert.equal(proof.definitionSha256, definitionSha256);
  assert.equal(typeof proof.hookKey, 'string');
  assert.ok(proof.hookKey.length > 0);
  assert.equal(typeof proof.currentHash, 'string');
  assert.ok(proof.currentHash.length > 0);
  const approved = await observeCodexAppServer({
    projectRoot,
    env,
    includeHooks: true,
  });
  await assertProjectConfiguration({ configResult: approved.configResult, projectRoot });
  const approvedHook = assertFixtureHookState({
    hooksResult: approved.hooksResult,
    projectRoot,
    expectedStatus: 'trusted',
  });
  assert.equal(approvedHook.hookKey, proof.hookKey, 'approved hook identity must match the baseline');
  assert.equal(approvedHook.currentHash, proof.currentHash, 'approved definition hash must match the baseline');
  assert.equal(await canaryCount(), 0, 'provider-owned trust must not execute the fixture before a fresh session');
  await runNonInteractiveCommand(CODEX, argumentsList, { cwd: projectRoot, env, timeout: 240_000 });
  assert.equal(await canaryCount(), 1, 'fresh trusted session must execute the unchanged fixture exactly once');
  const mutated = JSON.parse(definition);
  mutated.hooks.SessionStart[0].hooks[0].statusMessage = 'mutated fixture definition';
  t.after(() => writeFile(definitionPath, definition));
  await writeFile(definitionPath, `${JSON.stringify(mutated, null, 2)}\n`);
  const changed = await observeCodexAppServer({
    projectRoot,
    env,
    includeHooks: true,
  });
  await assertProjectConfiguration({ configResult: changed.configResult, projectRoot });
  const changedHook = assertFixtureHookState({
    hooksResult: changed.hooksResult,
    projectRoot,
    expectedStatus: ['modified', 'untrusted'],
  });
  assert.equal(changedHook.hookKey, proof.hookKey, 'definition mutation must preserve hook identity');
  assert.notEqual(changedHook.currentHash, proof.currentHash, 'definition mutation must change currentHash');
  await runNonInteractiveCommand(CODEX, argumentsList, { cwd: projectRoot, env, timeout: 240_000 });
  assert.equal(await canaryCount(), 1, 'definition mutation must skip without executing the canary again');
  assert.deepEqual(
    await Promise.all(legacyPaths.map(readIfPresent)),
    legacyBytes,
    'the native trust lifecycle must leave the existing 0.0.0 cache unchanged',
  );
});
