import assert from "node:assert/strict";
import test from "node:test";

import {
  createGitRequest,
  GIT_OPERATIONS,
  parseGitResponse,
} from "../../plugins/aidrian-cockpit/src/providers/local-git.ts";
import {
  createGitHubRequest,
  GITHUB_OPERATIONS,
} from "../../plugins/aidrian-cockpit/src/providers/github.ts";

const root = "/private/tmp/cockpit-fixture";
const expectedGitArgv = {
  GIT_TOP_LEVEL: ["-c", "core.fsmonitor=false", "rev-parse", "--show-toplevel"],
  GIT_HEAD: ["-c", "core.fsmonitor=false", "rev-parse", "--verify", "HEAD"],
  GIT_BRANCH: ["-c", "core.fsmonitor=false", "rev-parse", "--abbrev-ref", "HEAD"],
  GIT_STATUS: ["-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"],
  GIT_ORIGIN: ["-c", "core.fsmonitor=false", "remote", "get-url", "origin"],
};

test("git operation descriptors own immutable complete argv and noninteractive execution policy", () => {
  for (const operation of GIT_OPERATIONS) {
    const request = createGitRequest(operation, root);
    assert.deepEqual(request.argv, expectedGitArgv[operation]);
    assert.equal(request.executable, "git");
    assert.equal(request.cwd, root);
    assert.equal(request.stdin, "closed");
    assert.equal(request.timeoutMs, 2_000);
    assert.deepEqual(request.inheritEnv, ["PATH"]);
    assert.deepEqual(Object.keys(request.env).sort(), [
      "EDITOR",
      "GH_PAGER",
      "GH_PROMPT_DISABLED",
      "GIT_PAGER",
      "GIT_TERMINAL_PROMPT",
      "NO_COLOR",
      "PAGER",
      "VISUAL",
    ]);
    assert.equal(Object.isFrozen(request), true);
    assert.equal(Object.isFrozen(request.argv), true);
    assert.throws(() => request.argv.push("--delete"), TypeError);
  }
  assert.equal(createGitRequest("GIT_PUSH", root), null);
  assert.equal(createGitRequest("GIT_STATUS", "relative"), null);
  assert.equal(createGitRequest("GIT_STATUS", "/tmp/ok\n--work-tree=/etc"), null);
});

test("GitHub descriptors accept only separately validated branch or decimal PR selectors", () => {
  const current = createGitHubRequest({
    operation: GITHUB_OPERATIONS[0],
    canonicalRoot: root,
    repository: "Owner/Repo",
    branch: "feature/safe-branch",
  });
  assert.deepEqual(current.argv, [
    "pr", "view", "feature/safe-branch", "--repo", "owner/repo", "--json", "number,state,headRefName",
  ]);
  const apostrophe = createGitHubRequest({
    operation: GITHUB_OPERATIONS[0],
    canonicalRoot: root,
    repository: "Owner/Repo",
    branch: "feature/o'neil",
  });
  assert.deepEqual(apostrophe.argv, [
    "pr", "view", "feature/o'neil", "--repo", "owner/repo", "--json", "number,state,headRefName",
  ]);
  const checks = createGitHubRequest({
    operation: GITHUB_OPERATIONS[1],
    canonicalRoot: root,
    repository: "owner/repo",
    pullRequestNumber: 42,
  });
  assert.deepEqual(checks.argv, [
    "pr", "checks", "42", "--repo", "owner/repo", "--json", "state,bucket",
  ]);
  for (const branch of [
    "--repo=evil/repo",
    "main\n--web",
    "a..b",
    "main@{push}",
    "bad branch",
    "123",
    "+123",
    "-123",
    "#123",
    "#+123",
    "#-123",
    "0",
    "+0",
    "#0",
    "#+0",
    "#-0",
  ])
    assert.equal(createGitHubRequest({ operation: "GH_CURRENT_PR", canonicalRoot: root, repository: "owner/repo", branch }), null);
  assert.equal(createGitHubRequest({ operation: "GH_PR_CHECKS", canonicalRoot: root, repository: "owner/repo", pullRequestNumber: 0 }), null);
  assert.equal(createGitHubRequest({ operation: "GH_PR_CHECKS", canonicalRoot: root, repository: "evil.example/owner/repo", pullRequestNumber: 1 }), null);
});

test("git parsers reduce bounded output and never return raw output", () => {
  const status = parseGitResponse("GIT_STATUS", {
    exitCode: 0,
    stdout: `# branch.oid ${"a".repeat(40)}\n# branch.head main\n1 .M N... 100644 100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} file.ts\n`,
    stderr: "",
  });
  assert.deepEqual(status, {
    ok: true,
    operation: "GIT_STATUS",
    branch: "main",
    head: "a".repeat(40),
    dirty: true,
  });
  assert.equal("stdout" in status, false);
  assert.deepEqual(parseGitResponse("GIT_ORIGIN", {
    exitCode: 0,
    stdout: "git@github.com:Owner/Repo.git\n",
    stderr: "",
  }), { ok: true, operation: "GIT_ORIGIN", repository: "owner/repo" });
  assert.equal(parseGitResponse("GIT_ORIGIN", { exitCode: 0, stdout: "https://gitlab.com/a/b\n", stderr: "" }).ok, false);
  assert.deepEqual(parseGitResponse("GIT_HEAD", {
    exitCode: 0,
    stdout: "x".repeat(65_537),
    stderr: "",
  }), { ok: false, operation: "GIT_HEAD", error: "response_too_large" });
});

test("git reduction distinguishes detached HEAD and rejects incomplete porcelain branch data", () => {
  assert.deepEqual(parseGitResponse("GIT_BRANCH", {
    exitCode: 0,
    stdout: "HEAD\n",
    stderr: "",
  }), { ok: true, operation: "GIT_BRANCH", branch: null });
  assert.deepEqual(parseGitResponse("GIT_STATUS", {
    exitCode: 0,
    stdout: `# branch.oid ${"a".repeat(40)}\n# branch.head (detached)\n`,
    stderr: "",
  }), {
    ok: true,
    operation: "GIT_STATUS",
    branch: null,
    head: "a".repeat(40),
    dirty: false,
  });
  for (const stdout of [
    "",
    "# branch.head main\n",
    `# branch.oid ${"a".repeat(40)}\n`,
    `# branch.oid ${"a".repeat(40)}\n# branch.oid ${"b".repeat(40)}\n# branch.head main\n`,
    `# branch.oid ${"a".repeat(40)}\n# branch.head main\n# branch.head other\n`,
  ]) assert.deepEqual(parseGitResponse("GIT_STATUS", { exitCode: 0, stdout, stderr: "" }), {
    ok: false,
    operation: "GIT_STATUS",
    error: "malformed_response",
  });
});

test("git and GitHub branch parsers reject every terminal control category", () => {
  for (const control of ["\u0007", "\u061c", "\u2060", "\u2028", "\u2029"]) {
    assert.equal(parseGitResponse("GIT_BRANCH", {
      exitCode: 0,
      stdout: `main${control}\n`,
      stderr: "",
    }).ok, false, control.codePointAt(0));
    assert.equal(createGitHubRequest({
      operation: "GH_CURRENT_PR",
      canonicalRoot: root,
      repository: "owner/repo",
      branch: `main${control}`,
    }), null, control.codePointAt(0));
  }
});
