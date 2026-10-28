import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  evaluateApproval,
  normalizeRepository,
  parseApprovalBytes,
  parseConfigBytes,
  projectDigest,
  providerConfigDigest,
  resolveGitHubRepository,
  semanticDigest,
} from "../../plugins/aidrian-cockpit/src/config.ts";

const digest = (character) => character.repeat(64);

test("closed config schema accepts arbitrary provider identities and produces a semantic digest", () => {
  const compact = parseConfigBytes(
    '{"schemaVersion":1,"github":{"repository":"Octo-Org/Widget"},"linear":{"server":"linear-main_2","teamKeys":["OPS","ENG2"]}}',
  );
  const formatted = parseConfigBytes(`{
    "linear": { "teamKeys": ["ENG2", "OPS"], "server": "linear-main_2" },
    "github": { "repository": "octo-org/widget" },
    "schemaVersion": 1
  }`);
  assert.equal(compact.ok, true);
  assert.equal(formatted.ok, true);
  assert.deepEqual(compact, formatted);
  assert.equal(compact.config.github.repository, "octo-org/widget");
  assert.deepEqual(compact.config.linear.teamKeys, ["ENG2", "OPS"]);
  assert.notEqual(compact.configDigest, semanticDigest({ schemaVersion: 1 }));
  assert.notEqual(
    providerConfigDigest(compact.config, "github"),
    providerConfigDigest(compact.config, "linear"),
  );
  assert.equal(
    providerConfigDigest(compact.config, "linear"),
    providerConfigDigest(formatted.config, "linear"),
  );
});

test("config rejects unknown, credential-like, duplicate, control, and over-limit inputs", () => {
  const invalid = [
    '{"schemaVersion":1,"token":"secret"}',
    '{"schemaVersion":1,"github":{"repository":"https://github.com/a/b"}}',
    '{"schemaVersion":1,"github":{"repository":"-owner/repo"}}',
    '{"schemaVersion":1,"github":{"repository":"./repo"}}',
    '{"schemaVersion":1,"github":{"repository":"../repo"}}',
    '{"schemaVersion":1,"github":{"repository":"owner/."}}',
    '{"schemaVersion":1,"github":{"repository":"owner/.."}}',
    '{"schemaVersion":1,"linear":{"server":"linear main","teamKeys":["OPS"]}}',
    '{"schemaVersion":1,"linear":{"server":"-linear","teamKeys":["OPS"]}}',
    '{"schemaVersion":1,"linear":{"server":"linear","teamKeys":["OPS","OPS"]}}',
    '{"schemaVersion":1,"linear":{"server":"linear","teamKeys":["TBL"]},"extra":{}}',
  ];
  for (const source of invalid) assert.equal(parseConfigBytes(source).ok, false, source);
  assert.deepEqual(parseConfigBytes(`{"schemaVersion":1,"pad":"${"x".repeat(17_000)}"}`), {
    ok: false,
    error: "too_large",
  });
});

test("GitHub identity resolution is canonical and fails on ambiguity or disagreement", () => {
  assert.equal(normalizeRepository("Owner/Repo"), "owner/repo");
  assert.deepEqual(resolveGitHubRepository(undefined, "git@github.com:Owner/Repo.git"), {
    state: "resolved",
    repository: "owner/repo",
  });
  assert.deepEqual(resolveGitHubRepository("owner/repo", "https://github.com/OWNER/REPO.git"), {
    state: "resolved",
    repository: "owner/repo",
  });
  assert.equal(resolveGitHubRepository("owner/other", "https://github.com/owner/repo").state, "unavailable");
  assert.equal(resolveGitHubRepository("owner/repo", "https://user:secret@github.com/owner/repo").state, "unavailable");
  assert.equal(resolveGitHubRepository(undefined, "https://github.com/a/b\nhttps://github.com/c/d").state, "unavailable");
  assert.equal(resolveGitHubRepository(undefined, "https://gitlab.com/a/b").state, "unavailable");
});

test("approval comparison fails closed for missing and every changed tuple member", () => {
  const tuple = {
    projectDigest: digest("a"),
    configDigest: digest("b"),
    capabilityManifestDigest: digest("c"),
    pluginVersion: "1.0.0",
    pluginArtifactDigest: digest("d"),
    moduleDigest: digest("e"),
    controllerDigest: digest("f"),
    hostVersion: "2.1.310",
    hostBinaryDigest: digest("1"),
    declarationDigest: digest("2"),
  };
  const source = JSON.stringify({ schemaVersion: 1, ...tuple, approvedAt: "2026-10-28T12:00:00.000Z" });
  assert.deepEqual(evaluateApproval(tuple, undefined), {
    access: { mode: "local_only", reason: "approval_missing" },
    approval: null,
  });
  assert.equal(evaluateApproval(tuple, source).access.mode, "approved");
  for (const key of Object.keys(tuple)) {
    const changed = { ...tuple, [key]: key.includes("Version") ? "9.9.9" : digest("9") };
    assert.deepEqual(evaluateApproval(changed, source).access, {
      mode: "local_only",
      reason: "reapproval_required",
    }, key);
    const incomplete = { ...tuple };
    delete incomplete[key];
    assert.deepEqual(evaluateApproval(incomplete, source), {
      access: { mode: "local_only", reason: "reapproval_required" },
      approval: null,
    }, `missing ${key}`);
  }
  for (const malformed of [
    {},
    { ...tuple, extra: digest("3") },
    { ...tuple, hostVersion: "latest" },
    { ...tuple, configDigest: "not-a-digest" },
  ]) assert.deepEqual(evaluateApproval(malformed, source), {
    access: { mode: "local_only", reason: "reapproval_required" },
    approval: null,
  });
  assert.equal(parseApprovalBytes(source).ok, true);
  assert.equal(parseApprovalBytes(source.replace('"approvedAt"', '"unknown":1,"approvedAt"')).ok, false);
});

test("project namespace digest binds the canonical root and repository without exposing either", () => {
  const first = projectDigest("/private/tmp/project-a", "owner/repo");
  const second = projectDigest("/private/tmp/project-b", "owner/repo");
  assert.match(first, /^[a-f0-9]{64}$/u);
  assert.notEqual(first, second);
  assert.equal(projectDigest("relative/path", "owner/repo"), null);
});

test("checked-in schemas are closed and enumerate the full approval tuple", async () => {
  const configSchema = JSON.parse(
    await readFile(new URL("../../plugins/aidrian-cockpit/schemas/config.schema.json", import.meta.url), "utf8"),
  );
  const approvalSchema = JSON.parse(
    await readFile(new URL("../../plugins/aidrian-cockpit/schemas/approval.schema.json", import.meta.url), "utf8"),
  );
  assert.equal(configSchema.additionalProperties, false);
  assert.equal(configSchema.properties.github.additionalProperties, false);
  assert.equal(configSchema.properties.linear.additionalProperties, false);
  const repositoryPattern = new RegExp(configSchema.properties.github.properties.repository.pattern, "u");
  for (const repository of ["./repo", "../repo", "owner/.", "owner/.."]) {
    assert.equal(repositoryPattern.test(repository), false, repository);
    assert.equal(normalizeRepository(repository), null, repository);
  }
  assert.equal(approvalSchema.additionalProperties, false);
  assert.deepEqual(new Set(approvalSchema.required), new Set(Object.keys(approvalSchema.properties)));
});
