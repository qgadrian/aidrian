import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const sourceUrl = new URL("../../plugins/aidrian-cockpit/src/render.tsx", import.meta.url);
const source = await readFile(sourceUrl, "utf8");
const compiled = stripTypeScriptTypes(source, { mode: "strip", sourceUrl: sourceUrl.href });
const render = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

const github = {
  state: "fresh",
  observedAt: 1_000,
  refreshedAt: 1_000,
  reason: null,
  value: {
    provider: "github",
    pullRequestNumber: 7,
    pullRequestState: "open",
    checks: { passing: 2, failing: 1, pending: 1, skipped: 1, missing: 0 },
  },
};
const linear = {
  state: "stale",
  observedAt: 1_000,
  refreshedAt: 2_000,
  reason: "backoff",
  value: { provider: "linear", issueKey: "OPS-7", issueState: "In Progress" },
};
const input = {
  repository: "owner/repo",
  branch: "feature/ops-7",
  dirty: true,
  contextPercent: 51,
  ratePercent: 12,
  activeAgents: 2,
  totalAgents: 4,
  github,
  linear,
  approval: { mode: "approved" },
  nowMs: 61_000,
};

test("plain row preserves advisory provider states and never emits merge authority", () => {
  const row = render.buildAbovePromptView(input);
  assert.equal(row.surface, "above_prompt");
  assert.match(row.text, /PR #7 open/u);
  assert.match(row.text, /1 fail/u);
  assert.match(row.text, /OPS-7 In Progress; stale/u);
  assert.doesNotMatch(row.text, /mergeable|approved to merge|deploy/u);
  assert.equal(row.tone, "warn");
  assert.equal(row.truncated, false);
});

test("rendering escapes HTML metacharacters and every terminal control category before bounding", () => {
  const unsafe = render.buildAbovePromptView({
    ...input,
    repository: `<owner>&\u001b[2J\u202erepo`,
    branch: "x".repeat(700),
  });
  assert.doesNotMatch(unsafe.text, /\u001b|\u202e|<owner>/u);
  assert.match(unsafe.text, /&lt;owner&gt;&amp;�/u);
  assert.equal([...unsafe.text].length <= 512, true);
  assert.equal(unsafe.truncated, true);
  assert.equal(unsafe.tone, "warn");
  for (const control of ["\u0007", "\u061c", "\u2060", "\u2028", "\u2029"]) {
    const protectedView = render.buildAbovePromptView({
      ...input,
      repository: `owner${control}/repo`,
    });
    assert.equal(protectedView.text.includes(control), false, control.codePointAt(0));
    assert.match(protectedView.text, /owner�\/repo/u);
  }
});

test("pane includes observation and refresh ages as bounded plain data", () => {
  const pane = render.buildPaneView({
    ...input,
    approval: { mode: "local_only", reason: "reapproval_required" },
  });
  assert.equal(pane.surface, "pane");
  assert.deepEqual(pane.actions, [{ id: "refresh", label: "Refresh" }]);
  assert.equal(typeof pane.actions[0].onClick, "undefined");
  assert.match(pane.rows.find((row) => row.label === "Linear").value, /observation 1m old · last refresh 59s old/u);
  assert.match(pane.rows.find((row) => row.label === "Linear").value, /backoff/u);
  assert.match(pane.rows.find((row) => row.label === "External refresh").value, /local only/u);
  assert.equal(Buffer.byteLength(JSON.stringify(pane)) <= 8 * 1024, true);
});

test("pane propagates escaped row truncation and bounds the complete serialized model", () => {
  const pane = render.buildPaneView({ ...input, branch: "&".repeat(255) });
  assert.equal(pane.truncated, true);
  assert.equal(pane.rows.find((row) => row.label === "Repository").tone, "warn");
  assert.match(pane.rows.find((row) => row.label === "Repository").value, /…$/u);
  assert.equal(Buffer.byteLength(JSON.stringify(pane)) <= 8 * 1024, true);
});

test("pane replaces a complete candidate that crosses the serialized 8 KiB boundary", () => {
  const pane = render.buildPaneView({
    ...input,
    repository: "😀".repeat(1_000),
    branch: "😀".repeat(1_000),
    github: {
      ...github,
      value: { ...github.value, pullRequestState: "😀".repeat(1_000) },
    },
    linear: {
      ...linear,
      value: { ...linear.value, issueState: "😀".repeat(1_000) },
    },
  });
  assert.equal(pane.truncated, true);
  assert.deepEqual(pane.rows, [{
    label: "Cockpit",
    value: "Pane content exceeded its safe display bound",
    tone: "bad",
  }]);
  assert.equal(Buffer.byteLength(JSON.stringify(pane)) <= 8 * 1024, true);
});

test("invalid config reason remains visible in row and Pane", () => {
  const invalidConfig = {
    state: "unavailable",
    observedAt: null,
    refreshedAt: 5_000,
    reason: "invalid_config",
    value: null,
  };
  const invalidInput = { ...input, github: invalidConfig };
  assert.match(render.buildAbovePromptView(invalidInput).text, /invalid_config/u);
  assert.match(
    render.buildPaneView(invalidInput).rows.find((row) => row.label === "GitHub").value,
    /invalid_config/u,
  );
});

test("render source contains no JSX or host/runtime imports", () => {
  assert.doesNotMatch(source, /from\s+["'](?:@anthropic|claude|react)|\$\.(?:ui|session|agent|process|mcp|store|clock)/u);
  assert.doesNotMatch(source, /<\/?[A-Z][A-Za-z0-9]*(?:\s|>)/u);
  assert.doesNotMatch(compiled, /jsx|createElement/u);
});
