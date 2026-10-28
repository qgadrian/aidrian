import assert from "node:assert/strict";
import test from "node:test";

import {
  CACHE_MAX_AGE_MS,
  cacheKey,
  createCacheNamespace,
  decodeCacheRecord,
  encodeCacheRecord,
  selectCachePurge,
} from "../../plugins/aidrian-cockpit/src/cache.ts";

const a = "a".repeat(64);
const b = "b".repeat(64);
const c = "c".repeat(64);
const now = 2_000_000_000_000;

test("cache keys isolate project, provider, and semantic provider config", () => {
  const github = createCacheNamespace(a, "github", b);
  const changedProject = createCacheNamespace(c, "github", b);
  const changedProvider = createCacheNamespace(a, "linear", b);
  const changedConfig = createCacheNamespace(a, "github", c);
  assert.equal(cacheKey(github), `cockpit:v1:${a}:github:${b}`);
  assert.equal(new Set([github, changedProject, changedProvider, changedConfig].map(cacheKey)).size, 4);
  assert.equal(createCacheNamespace("not-a-digest", "github", b), null);
});

test("cache round-trip retains only minimized identifiers, statuses, counts, and timestamps", () => {
  const namespace = createCacheNamespace(a, "github", b);
  const record = {
    schemaVersion: 1,
    ...namespace,
    observedAt: now - 1_000,
    refreshedAt: now,
    expiresAt: now + 60_000,
    value: {
      provider: "github",
      pullRequestNumber: 42,
      pullRequestState: "open",
      checks: { passing: 3, failing: 1, pending: 0, skipped: 1, missing: 0 },
    },
  };
  const encoded = encodeCacheRecord(record, now);
  assert.equal(encoded.ok, true);
  assert.deepEqual(decodeCacheRecord(encoded.encoded, namespace, now), { ok: true, record });
  for (const forbidden of ["title", "body", "path", "credential", "prompt", "error"]) {
    assert.equal(encoded.encoded.includes(forbidden), false);
  }
});

test("cache refuses expiry, downgrade, corruption, namespace mismatch, and non-minimized values", () => {
  const namespace = createCacheNamespace(a, "linear", b);
  const base = {
    schemaVersion: 1,
    ...namespace,
    observedAt: now - 1_000,
    refreshedAt: now,
    expiresAt: now + CACHE_MAX_AGE_MS,
    value: { provider: "linear", issueKey: "OPS-7", issueState: "Done" },
  };
  assert.equal(encodeCacheRecord({ ...base, expiresAt: now + CACHE_MAX_AGE_MS + 1 }, now).ok, false);
  assert.equal(encodeCacheRecord({
    ...base,
    refreshedAt: now - CACHE_MAX_AGE_MS,
    expiresAt: now + 1,
  }, now).ok, false);
  assert.equal(encodeCacheRecord({ ...base, value: { ...base.value, title: "secret" } }, now).ok, false);
  assert.deepEqual(decodeCacheRecord("{", namespace, now), { ok: false, error: "malformed" });
  assert.deepEqual(decodeCacheRecord(JSON.stringify({ ...base, schemaVersion: 0 }), namespace, now), {
    ok: false,
    error: "unsupported_schema",
  });
  assert.deepEqual(decodeCacheRecord(JSON.stringify(base), createCacheNamespace(c, "linear", b), now), {
    ok: false,
    error: "namespace_mismatch",
  });
  assert.deepEqual(decodeCacheRecord(JSON.stringify({ ...base, expiresAt: now }), namespace, now), {
    ok: false,
    error: "expired",
  });
  for (const control of ["\u0007", "\u061c", "\u2060", "\u2028", "\u2029"]) {
    assert.equal(encodeCacheRecord({
      ...base,
      value: { ...base.value, issueState: `Done${control}` },
    }, now).ok, false, control.codePointAt(0));
  }
});

test("purge selects expired records oldest-first and refuses eviction of live records", () => {
  const records = [
    { key: "cockpit:v1:expired-new", expiresAt: now - 1, refreshedAt: now - 5 },
    { key: "cockpit:v1:expired-old", expiresAt: now - 2, refreshedAt: now - 10 },
    ...Array.from({ length: 32 }, (_, index) => ({
      key: `cockpit:v1:live-${index}`,
      expiresAt: now + 10_000,
      refreshedAt: now - index,
    })),
  ];
  assert.deepEqual(selectCachePurge(records, "cockpit:v1:incoming", now), {
    deleteKeys: ["cockpit:v1:expired-old", "cockpit:v1:expired-new"],
    canWrite: false,
  });
  assert.equal(selectCachePurge(records, "cockpit:v1:live-3", now).canWrite, true);
});
