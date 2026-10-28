import assert from "node:assert/strict";
import test from "node:test";

import {
  createLinearRequest,
  parseIssueKey,
  reduceLinearResult,
} from "../../plugins/aidrian-cockpit/src/providers/linear.ts";

test("issue parsing requires exactly one boundary-delimited allowlisted positive key", () => {
  assert.deepEqual(parseIssueKey("work on OPS-42 now", ["OPS", "ENG2"]), { ok: true, issueKey: "OPS-42" });
  for (const source of [
    "OPS-0",
    "XOPS-42",
    "OPS-42X",
    "OPS-2147483648",
    "ops-42",
    "OPS-1 and OPS-2",
    "OTHER-42",
    "OPS-1\u202e",
  ]) assert.equal(parseIssueKey(source, ["OPS"]).ok, false, source);
  assert.equal(parseIssueKey("OPS-1", ["OPS", "OPS"]).ok, false);
});

test("Linear descriptor fixes the operation, tool, request shape, timeout, and server", () => {
  const request = createLinearRequest("linear-main", "OPS-42", ["OPS"]);
  assert.deepEqual(request, {
    operation: "LINEAR_GET_ISSUE",
    server: "linear-main",
    tool: "get_issue",
    arguments: { id: "OPS-42" },
    timeoutMs: 10_000,
    responseLimitBytes: 65_536,
  });
  assert.equal(Object.isFrozen(request), true);
  assert.equal(Object.isFrozen(request.arguments), true);
  assert.equal(createLinearRequest("linear main", "OPS-42", ["OPS"]), null);
  assert.equal(createLinearRequest("linear", "OPS-42", ["ENG"]), null);
  assert.equal("fallback" in request, false);
  assert.equal("mutation" in request, false);
});

test("Linear reduction accepts only its bounded display schema", () => {
  assert.deepEqual(reduceLinearResult({ identifier: "OPS-42", state: "In Progress" }, "OPS-42", ["OPS"]), {
    ok: true,
    value: { provider: "linear", issueKey: "OPS-42", issueState: "In Progress" },
  });
  for (const value of [
    { identifier: "OPS-42", state: "Done", title: "must not cross boundary" },
    { identifier: "OPS-41", state: "Done" },
    { identifier: "OPS-42", state: "Done\u001b[31m" },
    { identifier: "OPS-42", state: "x".repeat(257) },
    { identifier: "OPS-42" },
    [{ identifier: "OPS-42", state: "Done" }],
  ]) assert.equal(reduceLinearResult(value, "OPS-42", ["OPS"]).ok, false);
  assert.deepEqual(reduceLinearResult({ identifier: "OPS-42", state: "x".repeat(70_000) }, "OPS-42", ["OPS"]), {
    ok: false,
    error: "response_too_large",
  });
});
