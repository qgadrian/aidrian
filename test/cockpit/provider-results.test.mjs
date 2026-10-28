import assert from "node:assert/strict";
import test from "node:test";

import {
  parseChecksResponse,
  parsePullRequestResponse,
} from "../../plugins/aidrian-cockpit/src/providers/github.ts";
import { reduceLinearResult } from "../../plugins/aidrian-cockpit/src/providers/linear.ts";

const response = (value, extras = {}) => ({
  exitCode: 0,
  stdout: typeof value === "string" ? value : JSON.stringify(value),
  stderr: "",
  ...extras,
});

test("GitHub PR parser returns identifiers and closed state only", () => {
  assert.deepEqual(parsePullRequestResponse(response({ number: 17, state: "OPEN", headRefName: "feature/ops-17" })), {
    ok: true,
    value: { pullRequestNumber: 17, pullRequestState: "open", headBranch: "feature/ops-17" },
  });
  for (const value of [
    { number: 17, state: "OPEN", headRefName: "feature/ops", title: "raw title" },
    { number: 0, state: "OPEN", headRefName: "main" },
    { number: 17, state: "OPEN", headRefName: "main\u001b[2J" },
    { number: 17, state: "OPEN", headRefName: "main\u202e" },
    { number: 17, state: "FUTURE_STATE", headRefName: "main" },
  ]) assert.equal(parsePullRequestResponse(response(value)).ok, false);
});

test("GitHub checks preserve pass, fail, pending, skipped, and missing without authority verdicts", () => {
  const result = parseChecksResponse(response([
    { state: "SUCCESS", bucket: "pass" },
    { state: "FAILURE", bucket: "fail" },
    { state: "PENDING", bucket: "pending" },
    { state: "SKIPPED", bucket: "skipping" },
  ]));
  assert.deepEqual(result, {
    ok: true,
    value: { passing: 1, failing: 1, pending: 1, skipped: 1, missing: 0 },
  });
  assert.equal("mergeable" in result.value, false);
  assert.deepEqual(parseChecksResponse({
    exitCode: 1,
    stdout: "",
    stderr: "no checks reported on the 'feature/ops-17' branch\n",
  }), {
    ok: true,
    value: { passing: 0, failing: 0, pending: 0, skipped: 0, missing: 1 },
  });
  assert.deepEqual(parseChecksResponse({
    exitCode: 1,
    stdout: "",
    stderr: "no checks reported on the 'feature/o'neil' branch\n",
  }), {
    ok: true,
    value: { passing: 0, failing: 0, pending: 0, skipped: 0, missing: 1 },
  });
  assert.deepEqual(parseChecksResponse(response([])), { ok: false, error: "malformed_response" });
  assert.deepEqual(parseChecksResponse({
    exitCode: 1,
    stdout: "",
    stderr: "no required checks reported on the 'feature/ops-17' branch\n",
  }), { ok: false, error: "command_failed" });
  assert.deepEqual(parseChecksResponse({
    exitCode: 8,
    stdout: '[{"state":"PENDING","bucket":"pending"}]',
    stderr: "",
  }), { ok: false, error: "command_failed" });
  for (const stderr of [
    "no checks reported on the 'feature/o\u2060neil' branch\n",
    `no checks reported on the '${"a".repeat(480)}' branch\n`,
    "no checks reported on the 'feature/ops-17' branch\n\n",
  ]) assert.deepEqual(parseChecksResponse({ exitCode: 1, stdout: "", stderr }), {
    ok: false,
    error: "command_failed",
  });
  assert.equal(parseChecksResponse(response([{ state: "SUCCESS", bucket: "pass", name: "secret" }])).ok, false);
});

test("provider responses fail closed on timeout, auth, truncation, schema drift, ANSI, bidi, and depth", () => {
  assert.deepEqual(parsePullRequestResponse(response("", { timedOut: true })), { ok: false, error: "timeout" });
  assert.deepEqual(parsePullRequestResponse({ exitCode: 4, stdout: "", stderr: "auth details" }), {
    ok: false,
    error: "unauthorized",
  });
  assert.deepEqual(parseChecksResponse(response("x".repeat(65_537))), { ok: false, error: "response_too_large" });
  let nested = { identifier: "OPS-1", state: "Done" };
  for (let depth = 0; depth < 10; depth += 1) nested = { nested };
  assert.equal(reduceLinearResult(nested, "OPS-1", ["OPS"]).ok, false);
  let nestedGitHub = { number: 1, state: "OPEN", headRefName: "main" };
  for (let depth = 0; depth < 10; depth += 1) nestedGitHub = { nested: nestedGitHub };
  assert.equal(parsePullRequestResponse(response(nestedGitHub)).ok, false);
  assert.equal(reduceLinearResult({ identifier: "OPS-1", state: "Done\u001b]0;pwn\u0007" }, "OPS-1", ["OPS"]).ok, false);
  assert.equal(reduceLinearResult({ identifier: "OPS-1", state: "Done\u2066" }, "OPS-1", ["OPS"]).ok, false);
});

test("GitHub and Linear reducers reject every terminal control category", () => {
  for (const control of ["\u0007", "\u061c", "\u2060", "\u2028", "\u2029"]) {
    assert.equal(parsePullRequestResponse(response({
      number: 17,
      state: "OPEN",
      headRefName: `main${control}`,
    })).ok, false, control.codePointAt(0));
    assert.equal(reduceLinearResult({
      identifier: "OPS-1",
      state: `Done${control}`,
    }, "OPS-1", ["OPS"]).ok, false, control.codePointAt(0));
  }
});
