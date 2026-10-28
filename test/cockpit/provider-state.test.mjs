import assert from "node:assert/strict";
import test from "node:test";

import {
  beginRefresh,
  completeRefresh,
  initialProviderSnapshot,
  initialRefreshControl,
  PROVIDER_STATES,
  PROVIDER_REASONS,
  refreshControlKey,
  reduceProviderSnapshot,
} from "../../plugins/aidrian-cockpit/src/model.ts";

const github = {
  provider: "github",
  pullRequestNumber: 4,
  pullRequestState: "open",
  checks: { passing: 1, failing: 0, pending: 0, skipped: 0, missing: 0 },
};

test("provider reducer exposes every closed state and preserves the last valid value", () => {
  let state = initialProviderSnapshot(false);
  const seen = new Set([state.state]);
  state = reduceProviderSnapshot(state, { type: "enable" });
  seen.add(state.state);
  state = reduceProviderSnapshot(state, { type: "refresh_started", at: 1 });
  seen.add(state.state);
  state = reduceProviderSnapshot(state, { type: "refresh_succeeded", at: 2, value: github });
  seen.add(state.state);
  for (const [providerState, reason] of [
    ["stale", "backoff"],
    ["unauthorized", "unauthorized"],
    ["unavailable", "provider_unavailable"],
    ["error", "malformed_response"],
  ]) {
    state = providerState === "stale"
      ? reduceProviderSnapshot(state, { type: "mark_stale", at: 3, reason })
      : reduceProviderSnapshot(state, { type: "refresh_failed", at: 3, state: providerState, reason });
    seen.add(state.state);
    assert.deepEqual(state.value, github);
  }
  state = reduceProviderSnapshot(state, { type: "disable" });
  assert.equal(state.value, null);
  assert.deepEqual(seen, new Set(PROVIDER_STATES));
});

test("provider failures are independent and aborted refreshes never invent success", () => {
  const githubState = reduceProviderSnapshot(
    reduceProviderSnapshot(initialProviderSnapshot(true), { type: "refresh_succeeded", at: 1, value: github }),
    { type: "refresh_failed", at: 2, state: "error", reason: "timeout" },
  );
  const linearState = initialProviderSnapshot(true);
  assert.equal(githubState.state, "error");
  assert.equal(linearState.state, "stale");
  const aborted = reduceProviderSnapshot(
    reduceProviderSnapshot(linearState, { type: "refresh_started", at: 3 }),
    { type: "refresh_aborted", at: 4 },
  );
  assert.equal(aborted.state, "unavailable");
  assert.equal(aborted.reason, "refresh_cancelled");
});

test("invalid config has a closed visible provider reason", () => {
  assert.equal(PROVIDER_REASONS.includes("invalid_config"), true);
  const invalid = reduceProviderSnapshot(initialProviderSnapshot(true), {
    type: "refresh_failed",
    at: 10,
    state: "unavailable",
    reason: "invalid_config",
  });
  assert.equal(invalid.reason, "invalid_config");
});

test("one-flight, minimum interval, cancellation, stale completion, and capped backoff are deterministic", () => {
  let control = initialRefreshControl();
  const first = beginRefresh(control, 100_000);
  assert.equal(first.started, true);
  control = first.control;
  assert.deepEqual(beginRefresh(control, 100_001).reason, "already_in_flight");
  assert.equal(completeRefresh(control, first.generation + 1, "success", 100_002).accepted, false);
  control = completeRefresh(control, first.generation, "aborted", 100_003).control;
  assert.deepEqual(beginRefresh(control, 100_004).reason, "minimum_interval");

  let now = 200_000;
  for (const expectedDelay of [30_000, 60_000, 120_000, 300_000, 300_000]) {
    const started = beginRefresh(control, now);
    assert.equal(started.started, true);
    const completed = completeRefresh(started.control, started.generation, "failure", now + 1);
    assert.equal(completed.control.nextAllowedAt, now + 1 + expectedDelay);
    control = completed.control;
    now = control.nextAllowedAt + 60_000;
  }
});

test("refresh control ownership is isolated by project and provider", () => {
  const first = "a".repeat(64);
  const second = "b".repeat(64);
  assert.notEqual(refreshControlKey(first, "github"), refreshControlKey(second, "github"));
  assert.notEqual(refreshControlKey(first, "github"), refreshControlKey(first, "linear"));
  assert.equal(refreshControlKey("invalid", "github"), null);
});
