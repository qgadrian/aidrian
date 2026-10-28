import { createHash } from "node:crypto";

import type {
  ApprovalAccess,
  ApprovalTuple,
  RuntimeApproval,
} from "./model.ts";

export const CONFIG_MAX_BYTES = 16 * 1024;
export const APPROVAL_MAX_BYTES = 8 * 1024;

const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const REPOSITORY_PART_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/u;
const SERVER_PATTERN = /^(?!-)[A-Za-z0-9._-]{1,128}$/u;
const TEAM_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,11}$/u;
const APPROVAL_TUPLE_KEYS = [
  "projectDigest",
  "configDigest",
  "capabilityManifestDigest",
  "pluginVersion",
  "pluginArtifactDigest",
  "moduleDigest",
  "controllerDigest",
  "hostVersion",
  "hostBinaryDigest",
  "declarationDigest",
] as const;

export interface CockpitConfig {
  readonly schemaVersion: 1;
  readonly github?: { readonly repository?: string };
  readonly linear?: { readonly server: string; readonly teamKeys: readonly string[] };
}

export type ConfigErrorCode =
  | "too_large"
  | "malformed_json"
  | "invalid_shape"
  | "unknown_key"
  | "invalid_repository"
  | "invalid_linear_server"
  | "invalid_team_keys";

export type ApprovalErrorCode =
  | "too_large"
  | "malformed_json"
  | "invalid_shape"
  | "unknown_key"
  | "invalid_digest"
  | "invalid_version"
  | "invalid_timestamp";

export type ConfigParseResult =
  | { readonly ok: true; readonly config: CockpitConfig; readonly configDigest: string }
  | { readonly ok: false; readonly error: ConfigErrorCode };

export type ApprovalParseResult =
  | { readonly ok: true; readonly approval: RuntimeApproval; readonly approvalDigest: string }
  | { readonly ok: false; readonly error: ApprovalErrorCode };

export type GitHubResolution =
  | { readonly state: "resolved"; readonly repository: string }
  | {
      readonly state: "unavailable";
      readonly reason:
        | "missing_origin"
        | "ambiguous_origin"
        | "invalid_origin"
        | "repository_mismatch";
    };

export interface ApprovalEvaluation {
  readonly access: ApprovalAccess;
  readonly approval: RuntimeApproval | null;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError("Unsupported semantic value");
  }
  return encoded;
}

export function semanticDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function normalizeRepository(value: string): string | null {
  const parts = value.split("/");
  if (parts.length !== 2) return null;
  const [owner, repository] = parts;
  if (
    owner === undefined ||
    repository === undefined ||
    !REPOSITORY_PART_PATTERN.test(owner) ||
    !REPOSITORY_PART_PATTERN.test(repository) ||
    owner === "." ||
    owner === ".." ||
    repository === "." ||
    repository === ".." ||
    owner.startsWith("-") ||
    repository.startsWith("-")
  ) {
    return null;
  }
  return `${owner.toLowerCase()}/${repository.toLowerCase()}`;
}

export function parseConfigBytes(source: string): ConfigParseResult {
  if (byteLength(source) > CONFIG_MAX_BYTES) return { ok: false, error: "too_large" };
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return { ok: false, error: "malformed_json" };
  }
  if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion"], ["github", "linear"])) {
    return { ok: false, error: isRecord(value) ? "unknown_key" : "invalid_shape" };
  }
  if (value.schemaVersion !== 1) return { ok: false, error: "invalid_shape" };

  let github: CockpitConfig["github"];
  if (value.github !== undefined) {
    if (!isRecord(value.github) || !hasExactKeys(value.github, [], ["repository"])) {
      return { ok: false, error: "unknown_key" };
    }
    if (value.github.repository === undefined) {
      github = {};
    } else if (typeof value.github.repository === "string") {
      const repository = normalizeRepository(value.github.repository);
      if (repository === null) return { ok: false, error: "invalid_repository" };
      github = { repository };
    } else {
      return { ok: false, error: "invalid_repository" };
    }
  }

  let linear: CockpitConfig["linear"];
  if (value.linear !== undefined) {
    if (!isRecord(value.linear) || !hasExactKeys(value.linear, ["server", "teamKeys"])) {
      return { ok: false, error: "unknown_key" };
    }
    if (typeof value.linear.server !== "string" || !SERVER_PATTERN.test(value.linear.server)) {
      return { ok: false, error: "invalid_linear_server" };
    }
    if (
      !Array.isArray(value.linear.teamKeys) ||
      value.linear.teamKeys.length < 1 ||
      value.linear.teamKeys.length > 16 ||
      !value.linear.teamKeys.every(
        (key): key is string => typeof key === "string" && TEAM_KEY_PATTERN.test(key),
      ) ||
      new Set(value.linear.teamKeys).size !== value.linear.teamKeys.length
    ) {
      return { ok: false, error: "invalid_team_keys" };
    }
    linear = { server: value.linear.server, teamKeys: [...value.linear.teamKeys].sort() };
  }

  const config: CockpitConfig = {
    schemaVersion: 1,
    ...(github === undefined ? {} : { github }),
    ...(linear === undefined ? {} : { linear }),
  };
  return { ok: true, config, configDigest: semanticDigest(config) };
}

function parseGitHubOrigin(value: string): string | null {
  if (byteLength(value) > 512 || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  const patterns = [
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/u,
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/u,
    /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/u,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(value);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      return normalizeRepository(`${match[1]}/${match[2]}`);
    }
  }
  return null;
}

export function resolveGitHubRepository(
  explicitRepository: string | undefined,
  originOutput: string | undefined,
): GitHubResolution {
  const explicit = explicitRepository === undefined ? null : normalizeRepository(explicitRepository);
  if (explicitRepository !== undefined && explicit === null) {
    return { state: "unavailable", reason: "invalid_origin" };
  }
  if (originOutput === undefined || originOutput === "") {
    return explicit === null
      ? { state: "unavailable", reason: "missing_origin" }
      : { state: "resolved", repository: explicit };
  }
  const lines = originOutput.split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length !== 1) return { state: "unavailable", reason: "ambiguous_origin" };
  const origin = parseGitHubOrigin(lines[0] ?? "");
  if (origin === null) return { state: "unavailable", reason: "invalid_origin" };
  if (explicit !== null && explicit !== origin) {
    return { state: "unavailable", reason: "repository_mismatch" };
  }
  return { state: "resolved", repository: explicit ?? origin };
}

export function projectDigest(canonicalRoot: string, repository: string): string | null {
  const normalizedRepository = normalizeRepository(repository);
  if (
    normalizedRepository === null ||
    !canonicalRoot.startsWith("/") ||
    /[\u0000\r\n]/u.test(canonicalRoot) ||
    byteLength(canonicalRoot) > 4096
  ) {
    return null;
  }
  return semanticDigest({ canonicalRoot, repository: normalizedRepository });
}

export function providerConfigDigest(config: CockpitConfig, provider: "github" | "linear"): string {
  return semanticDigest(
    provider === "github"
      ? { provider, config: config.github ?? null }
      : { provider, config: config.linear ?? null },
  );
}

export function parseApprovalBytes(source: string): ApprovalParseResult {
  if (byteLength(source) > APPROVAL_MAX_BYTES) return { ok: false, error: "too_large" };
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return { ok: false, error: "malformed_json" };
  }
  const keys = [
    "schemaVersion",
    "projectDigest",
    "configDigest",
    "capabilityManifestDigest",
    "pluginVersion",
    "pluginArtifactDigest",
    "moduleDigest",
    "controllerDigest",
    "hostVersion",
    "hostBinaryDigest",
    "declarationDigest",
    "approvedAt",
  ] as const;
  if (!isRecord(value) || !hasExactKeys(value, keys)) {
    return { ok: false, error: isRecord(value) ? "unknown_key" : "invalid_shape" };
  }
  if (value.schemaVersion !== 1) return { ok: false, error: "invalid_shape" };
  if (
    !isDigest(value.projectDigest) ||
    !isDigest(value.configDigest) ||
    !isDigest(value.capabilityManifestDigest) ||
    !isDigest(value.pluginArtifactDigest) ||
    !isDigest(value.moduleDigest) ||
    !isDigest(value.controllerDigest) ||
    !isDigest(value.hostBinaryDigest) ||
    !isDigest(value.declarationDigest)
  ) {
    return { ok: false, error: "invalid_digest" };
  }
  if (
    typeof value.pluginVersion !== "string" ||
    !VERSION_PATTERN.test(value.pluginVersion) ||
    typeof value.hostVersion !== "string" ||
    !VERSION_PATTERN.test(value.hostVersion)
  ) {
    return { ok: false, error: "invalid_version" };
  }
  if (typeof value.approvedAt !== "string") return { ok: false, error: "invalid_timestamp" };
  const approvedAtMs = Date.parse(value.approvedAt);
  if (!Number.isFinite(approvedAtMs) || new Date(approvedAtMs).toISOString() !== value.approvedAt) {
    return { ok: false, error: "invalid_timestamp" };
  }
  const approval: RuntimeApproval = {
    schemaVersion: 1,
    projectDigest: value.projectDigest,
    configDigest: value.configDigest,
    capabilityManifestDigest: value.capabilityManifestDigest,
    pluginVersion: value.pluginVersion,
    pluginArtifactDigest: value.pluginArtifactDigest,
    moduleDigest: value.moduleDigest,
    controllerDigest: value.controllerDigest,
    hostVersion: value.hostVersion,
    hostBinaryDigest: value.hostBinaryDigest,
    declarationDigest: value.declarationDigest,
    approvedAt: value.approvedAt,
  };
  return { ok: true, approval, approvalDigest: semanticDigest(approval) };
}

export function evaluateApproval(
  expected: ApprovalTuple,
  source: string | undefined,
): ApprovalEvaluation {
  const validatedExpected = validateExpectedApprovalTuple(expected);
  if (validatedExpected === null) {
    return {
      access: { mode: "local_only", reason: "reapproval_required" },
      approval: null,
    };
  }
  if (source === undefined) {
    return { access: { mode: "local_only", reason: "approval_missing" }, approval: null };
  }
  const parsed = parseApprovalBytes(source);
  if (!parsed.ok) {
    return { access: { mode: "local_only", reason: "reapproval_required" }, approval: null };
  }
  const matches = APPROVAL_TUPLE_KEYS.every(
    (key) => parsed.approval[key] === validatedExpected[key],
  );
  return matches
    ? { access: { mode: "approved" }, approval: parsed.approval }
    : {
        access: { mode: "local_only", reason: "reapproval_required" },
        approval: parsed.approval,
      };
}

function validateExpectedApprovalTuple(value: unknown): ApprovalTuple | null {
  if (!isRecord(value) || !hasExactKeys(value, APPROVAL_TUPLE_KEYS)) return null;
  if (
    !isDigest(value.projectDigest) ||
    !isDigest(value.configDigest) ||
    !isDigest(value.capabilityManifestDigest) ||
    typeof value.pluginVersion !== "string" ||
    !VERSION_PATTERN.test(value.pluginVersion) ||
    !isDigest(value.pluginArtifactDigest) ||
    !isDigest(value.moduleDigest) ||
    !isDigest(value.controllerDigest) ||
    typeof value.hostVersion !== "string" ||
    !VERSION_PATTERN.test(value.hostVersion) ||
    !isDigest(value.hostBinaryDigest) ||
    !isDigest(value.declarationDigest)
  ) {
    return null;
  }
  return {
    projectDigest: value.projectDigest,
    configDigest: value.configDigest,
    capabilityManifestDigest: value.capabilityManifestDigest,
    pluginVersion: value.pluginVersion,
    pluginArtifactDigest: value.pluginArtifactDigest,
    moduleDigest: value.moduleDigest,
    controllerDigest: value.controllerDigest,
    hostVersion: value.hostVersion,
    hostBinaryDigest: value.hostBinaryDigest,
    declarationDigest: value.declarationDigest,
  };
}

export function isValidLinearServer(value: string): boolean {
  return SERVER_PATTERN.test(value);
}

export function isValidTeamKey(value: string): boolean {
  return TEAM_KEY_PATTERN.test(value);
}
