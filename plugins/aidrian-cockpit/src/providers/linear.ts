import { isValidLinearServer, isValidTeamKey } from "../config.ts";
import { containsUnsafeDisplayText } from "../model.ts";
import type { LinearSummary } from "../model.ts";

export const LINEAR_OPERATION = "LINEAR_GET_ISSUE" as const;
const MAX_ISSUE_NUMBER = 2_147_483_647;
const RESPONSE_LIMIT = 65_536;

export interface LinearRequestDescriptor {
  readonly operation: typeof LINEAR_OPERATION;
  readonly server: string;
  readonly tool: "get_issue";
  readonly arguments: Readonly<{ id: string }>;
  readonly timeoutMs: 10_000;
  readonly responseLimitBytes: 65_536;
}

export type IssueKeyResult =
  | { readonly ok: true; readonly issueKey: string }
  | { readonly ok: false; readonly reason: "missing" | "multiple" | "malformed" };

export type LinearResult =
  | { readonly ok: true; readonly value: LinearSummary }
  | {
      readonly ok: false;
      readonly error: "response_too_large" | "malformed_response" | "unsafe_text";
    };

function validIssueKey(value: string, allowed: ReadonlySet<string>): boolean {
  const match = /^([A-Z][A-Z0-9]{1,11})-([0-9]{1,10})$/u.exec(value);
  if (match?.[1] === undefined || match[2] === undefined || !allowed.has(match[1])) return false;
  const number = Number(match[2]);
  return Number.isSafeInteger(number) && number >= 1 && number <= MAX_ISSUE_NUMBER;
}

export function parseIssueKey(source: string, configuredTeamKeys: readonly string[]): IssueKeyResult {
  if (containsUnsafeDisplayText(source) || [...source].length > 256) {
    return { ok: false, reason: "malformed" };
  }
  if (
    configuredTeamKeys.length < 1 ||
    configuredTeamKeys.length > 16 ||
    !configuredTeamKeys.every(isValidTeamKey) ||
    new Set(configuredTeamKeys).size !== configuredTeamKeys.length
  ) {
    return { ok: false, reason: "malformed" };
  }
  const allowed = new Set(configuredTeamKeys);
  const matches: string[] = [];
  const pattern = /(?<![A-Z0-9])([A-Z][A-Z0-9]{1,11}-[0-9]{1,10})(?![A-Z0-9])/gu;
  for (const match of source.matchAll(pattern)) {
    const candidate = match[1];
    if (candidate !== undefined && validIssueKey(candidate, allowed)) matches.push(candidate);
  }
  if (matches.length === 0) return { ok: false, reason: "missing" };
  if (matches.length !== 1) return { ok: false, reason: "multiple" };
  const issueKey = matches[0];
  return issueKey === undefined
    ? { ok: false, reason: "missing" }
    : { ok: true, issueKey };
}

export function createLinearRequest(
  server: string,
  issueKey: string,
  configuredTeamKeys: readonly string[],
): LinearRequestDescriptor | null {
  const parsed = parseIssueKey(issueKey, configuredTeamKeys);
  if (!isValidLinearServer(server) || !parsed.ok || parsed.issueKey !== issueKey) return null;
  return Object.freeze({
    operation: LINEAR_OPERATION,
    server,
    tool: "get_issue",
    arguments: Object.freeze({ id: issueKey }),
    timeoutMs: 10_000,
    responseLimitBytes: RESPONSE_LIMIT,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validateBounds(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): "ok" | "too_large" | "malformed" | "unsafe" {
  if (depth > 8) return "too_large";
  if (typeof value === "string") {
    if ([...value].length > 256) return "too_large";
    return containsUnsafeDisplayText(value) ? "unsafe" : "ok";
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return "ok";
  if (typeof value !== "object") return "malformed";
  if (seen.has(value)) return "malformed";
  seen.add(value);
  const entries = Array.isArray(value) ? value : Object.values(value);
  if (entries.length > 128) return "too_large";
  for (const child of entries) {
    const result = validateBounds(child, depth + 1, seen);
    if (result !== "ok") return result;
  }
  return "ok";
}

export function reduceLinearResult(
  value: unknown,
  requestedIssueKey: string,
  configuredTeamKeys: readonly string[],
): LinearResult {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return { ok: false, error: "malformed_response" };
  }
  if (new TextEncoder().encode(encoded).byteLength > RESPONSE_LIMIT) {
    return { ok: false, error: "response_too_large" };
  }
  const bounds = validateBounds(value, 0, new WeakSet());
  if (bounds === "too_large") return { ok: false, error: "response_too_large" };
  if (bounds === "unsafe") return { ok: false, error: "unsafe_text" };
  if (bounds === "malformed") return { ok: false, error: "malformed_response" };
  if (
    !isRecord(value) ||
    !exactKeys(value, ["identifier", "state"]) ||
    typeof value.identifier !== "string" ||
    value.identifier !== requestedIssueKey ||
    !parseIssueKey(value.identifier, configuredTeamKeys).ok ||
    typeof value.state !== "string" ||
    value.state.length < 1 ||
    [...value.state].length > 64 ||
    containsUnsafeDisplayText(value.state)
  ) {
    return { ok: false, error: "malformed_response" };
  }
  return {
    ok: true,
    value: { provider: "linear", issueKey: value.identifier, issueState: value.state },
  };
}
