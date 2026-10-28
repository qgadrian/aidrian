import { containsUnsafeDisplayText } from "./model.ts";
import type { GitHubSummary, LinearSummary, ProviderName, ProviderValue } from "./model.ts";

export const CACHE_SCHEMA_VERSION = 1 as const;
export const CACHE_MAX_RECORD_BYTES = 16 * 1024;
export const CACHE_MAX_RECORDS = 32;
export const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

export interface CacheNamespace {
  readonly projectDigest: string;
  readonly provider: ProviderName;
  readonly providerConfigDigest: string;
}

export interface CacheRecord extends CacheNamespace {
  readonly schemaVersion: typeof CACHE_SCHEMA_VERSION;
  readonly observedAt: number;
  readonly refreshedAt: number;
  readonly expiresAt: number;
  readonly value: ProviderValue;
}

export type CacheEncodeResult =
  | { readonly ok: true; readonly encoded: string }
  | { readonly ok: false; readonly error: "invalid_record" | "too_large" };

export type CacheDecodeResult =
  | { readonly ok: true; readonly record: CacheRecord }
  | {
      readonly ok: false;
      readonly error:
        | "too_large"
        | "malformed"
        | "unsupported_schema"
        | "namespace_mismatch"
        | "expired"
        | "invalid_record";
    };

export interface CacheRecordMetadata {
  readonly key: string;
  readonly expiresAt: number;
  readonly refreshedAt: number;
}

export interface CachePurgeDecision {
  readonly deleteKeys: readonly string[];
  readonly canWrite: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validCount(value: unknown): value is number {
  return validTimestamp(value) && value <= 1_000_000;
}

function validSafeText(value: unknown, maximumScalars: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    [...value].length <= maximumScalars &&
    !containsUnsafeDisplayText(value)
  );
}

function isGitHubSummary(value: unknown): value is GitHubSummary {
  if (!isRecord(value) || !exactKeys(value, ["provider", "pullRequestNumber", "pullRequestState", "checks"])) {
    return false;
  }
  const checks = value.checks;
  if (
    value.provider !== "github" ||
    !validCount(value.pullRequestNumber) ||
    value.pullRequestNumber < 1 ||
    (value.pullRequestState !== "open" &&
      value.pullRequestState !== "closed" &&
      value.pullRequestState !== "merged" &&
      value.pullRequestState !== "unknown") ||
    !isRecord(checks) ||
    !exactKeys(checks, ["passing", "failing", "pending", "skipped", "missing"])
  ) {
    return false;
  }
  return ["passing", "failing", "pending", "skipped", "missing"].every((key) =>
    validCount(checks[key]),
  );
}

function isLinearSummary(value: unknown): value is LinearSummary {
  return (
    isRecord(value) &&
    exactKeys(value, ["provider", "issueKey", "issueState"]) &&
    value.provider === "linear" &&
    validSafeText(value.issueKey, 24) &&
    /^[A-Z][A-Z0-9]{1,11}-[1-9][0-9]{0,9}$/u.test(value.issueKey) &&
    validSafeText(value.issueState, 64)
  );
}

function isProviderValue(value: unknown, provider: ProviderName): value is ProviderValue {
  return provider === "github" ? isGitHubSummary(value) : isLinearSummary(value);
}

function validNamespace(value: CacheNamespace): boolean {
  return (
    DIGEST_PATTERN.test(value.projectDigest) &&
    (value.provider === "github" || value.provider === "linear") &&
    DIGEST_PATTERN.test(value.providerConfigDigest)
  );
}

export function createCacheNamespace(
  projectDigest: string,
  provider: ProviderName,
  providerConfigDigest: string,
): CacheNamespace | null {
  const namespace = { projectDigest, provider, providerConfigDigest };
  return validNamespace(namespace) ? namespace : null;
}

export function cacheKey(namespace: CacheNamespace): string | null {
  return validNamespace(namespace)
    ? `cockpit:v1:${namespace.projectDigest}:${namespace.provider}:${namespace.providerConfigDigest}`
    : null;
}

function validRecord(record: CacheRecord, nowMs: number): boolean {
  return (
    validNamespace(record) &&
    record.schemaVersion === CACHE_SCHEMA_VERSION &&
    validTimestamp(nowMs) &&
    validTimestamp(record.observedAt) &&
    validTimestamp(record.refreshedAt) &&
    validTimestamp(record.expiresAt) &&
    record.observedAt <= record.refreshedAt &&
    record.refreshedAt <= nowMs &&
    record.expiresAt > record.refreshedAt &&
    record.expiresAt > nowMs &&
    record.expiresAt <= record.refreshedAt + CACHE_MAX_AGE_MS &&
    isProviderValue(record.value, record.provider)
  );
}

export function encodeCacheRecord(record: CacheRecord, nowMs: number): CacheEncodeResult {
  if (!validRecord(record, nowMs)) return { ok: false, error: "invalid_record" };
  const encoded = JSON.stringify(record);
  return new TextEncoder().encode(encoded).byteLength <= CACHE_MAX_RECORD_BYTES
    ? { ok: true, encoded }
    : { ok: false, error: "too_large" };
}

export function decodeCacheRecord(
  encoded: string,
  expected: CacheNamespace,
  nowMs: number,
): CacheDecodeResult {
  if (new TextEncoder().encode(encoded).byteLength > CACHE_MAX_RECORD_BYTES) {
    return { ok: false, error: "too_large" };
  }
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    return { ok: false, error: "malformed" };
  }
  if (!isRecord(value)) return { ok: false, error: "malformed" };
  if (value.schemaVersion !== CACHE_SCHEMA_VERSION) {
    return { ok: false, error: "unsupported_schema" };
  }
  if (
    !validNamespace(expected) ||
    value.projectDigest !== expected.projectDigest ||
    value.provider !== expected.provider ||
    value.providerConfigDigest !== expected.providerConfigDigest
  ) {
    return { ok: false, error: "namespace_mismatch" };
  }
  if (!validTimestamp(value.expiresAt) || value.expiresAt <= nowMs) {
    return { ok: false, error: "expired" };
  }
  if (
    !exactKeys(value, [
      "schemaVersion",
      "projectDigest",
      "provider",
      "providerConfigDigest",
      "observedAt",
      "refreshedAt",
      "expiresAt",
      "value",
    ]) ||
    !validTimestamp(value.observedAt) ||
    !validTimestamp(value.refreshedAt) ||
    value.observedAt > value.refreshedAt ||
    value.refreshedAt > nowMs ||
    value.expiresAt <= value.refreshedAt ||
    value.expiresAt > value.refreshedAt + CACHE_MAX_AGE_MS ||
    !isProviderValue(value.value, expected.provider)
  ) {
    return { ok: false, error: "invalid_record" };
  }
  const record: CacheRecord = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    projectDigest: expected.projectDigest,
    provider: expected.provider,
    providerConfigDigest: expected.providerConfigDigest,
    observedAt: value.observedAt,
    refreshedAt: value.refreshedAt,
    expiresAt: value.expiresAt,
    value: value.value,
  };
  return { ok: true, record };
}

export function selectCachePurge(
  records: readonly CacheRecordMetadata[],
  incomingKey: string,
  nowMs: number,
): CachePurgeDecision {
  if (!validTimestamp(nowMs) || records.length > 1_024 || incomingKey.length > 256) {
    return { deleteKeys: [], canWrite: false };
  }
  const valid = records.filter(
    (record) =>
      record.key.startsWith("cockpit:v1:") &&
      record.key.length <= 256 &&
      validTimestamp(record.expiresAt) &&
      validTimestamp(record.refreshedAt),
  );
  const expired = valid
    .filter((record) => record.expiresAt <= nowMs)
    .sort((left, right) => left.expiresAt - right.expiresAt || left.refreshedAt - right.refreshedAt);
  const deleted = new Set(expired.map((record) => record.key));
  const retained = valid.filter((record) => !deleted.has(record.key));
  const replacesExisting = retained.some((record) => record.key === incomingKey);
  return {
    deleteKeys: [...deleted],
    canWrite: replacesExisting || retained.length < CACHE_MAX_RECORDS,
  };
}
