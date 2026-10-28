import { normalizeRepository } from "../config.ts";
import { containsUnsafeDisplayText } from "../model.ts";
import type { GitHubCheckCounts } from "../model.ts";
import type { ProcessRequestDescriptor, ProcessResponse } from "./local-git.ts";

export const GITHUB_OPERATIONS = ["GH_CURRENT_PR", "GH_PR_CHECKS"] as const;
export type GitHubOperation = (typeof GITHUB_OPERATIONS)[number];

export interface PullRequestIdentity {
  readonly pullRequestNumber: number;
  readonly pullRequestState: "open" | "closed" | "merged" | "unknown";
  readonly headBranch: string;
}

export type GitHubResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error:
        | "aborted"
        | "timeout"
        | "unauthorized"
        | "command_failed"
        | "response_too_large"
        | "malformed_response";
    };

const PROCESS_ENV = Object.freeze({
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  GH_PROMPT_DISABLED: "1",
  GH_PAGER: "cat",
  PAGER: "cat",
  EDITOR: "true",
  VISUAL: "true",
  NO_COLOR: "1",
});
const INHERITED_ENV = Object.freeze(["PATH"] as const);
const LIMIT = 65_536;
const MAX_PR_NUMBER = 2_147_483_647;
function validRoot(value: string): boolean {
  return value.startsWith("/") && !containsUnsafeDisplayText(value) && value.length <= 4096;
}

function validBranch(value: string): boolean {
  return (
    value.length > 0 &&
    !containsUnsafeDisplayText(value) &&
    [...value].length <= 255 &&
    !value.startsWith("-") &&
    !/^#?[+-]?[0-9]+$/u.test(value) &&
    !/\s|\\|\.\.|@\{|[~^:?*[\]]/u.test(value)
  );
}

function validPrNumber(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_PR_NUMBER;
}

export function createGitHubRequest(input: {
  readonly operation: GitHubOperation;
  readonly canonicalRoot: string;
  readonly repository: string;
  readonly branch?: string;
  readonly pullRequestNumber?: number;
}): ProcessRequestDescriptor | null {
  const repository = normalizeRepository(input.repository);
  if (repository === null || !validRoot(input.canonicalRoot)) return null;
  let argv: readonly string[];
  if (input.operation === "GH_CURRENT_PR") {
    if (input.branch === undefined || !validBranch(input.branch)) return null;
    argv = [
      "pr",
      "view",
      input.branch,
      "--repo",
      repository,
      "--json",
      "number,state,headRefName",
    ];
  } else if (input.operation === "GH_PR_CHECKS") {
    if (input.pullRequestNumber === undefined || !validPrNumber(input.pullRequestNumber)) return null;
    argv = [
      "pr",
      "checks",
      String(input.pullRequestNumber),
      "--repo",
      repository,
      "--json",
      "state,bucket",
    ];
  } else {
    return null;
  }
  return Object.freeze({
    operation: input.operation,
    executable: "gh",
    argv: Object.freeze([...argv]),
    cwd: input.canonicalRoot,
    env: PROCESS_ENV,
    inheritEnv: INHERITED_ENV,
    stdin: "closed",
    timeoutMs: 10_000,
    stdoutLimitBytes: LIMIT,
    stderrLimitBytes: LIMIT,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function withinProviderBounds(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (typeof value === "string") {
    return !containsUnsafeDisplayText(value) && [...value].length <= 256;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) {
    return value.length <= 128 && value.every((item) => withinProviderBounds(item, depth + 1));
  }
  if (!isRecord(value) || Object.keys(value).length > 128) return false;
  return Object.entries(value).every(
    ([key, item]) =>
      !containsUnsafeDisplayText(key) &&
      [...key].length <= 256 &&
      withinProviderBounds(item, depth + 1),
  );
}

function responseError(response: ProcessResponse): GitHubResult<never> | null {
  if (response.aborted === true) return { ok: false, error: "aborted" };
  if (response.timedOut === true) return { ok: false, error: "timeout" };
  if (
    response.stdoutTruncated === true ||
    response.stderrTruncated === true ||
    new TextEncoder().encode(response.stdout).byteLength > LIMIT ||
    new TextEncoder().encode(response.stderr).byteLength > LIMIT
  ) {
    return { ok: false, error: "response_too_large" };
  }
  if (!Number.isSafeInteger(response.exitCode) || response.exitCode !== 0) {
    return {
      ok: false,
      error: response.exitCode === 4 ? "unauthorized" : "command_failed",
    };
  }
  return null;
}

function parseJson(response: ProcessResponse): GitHubResult<unknown> {
  const error = responseError(response);
  if (error !== null) return error;
  try {
    const value: unknown = JSON.parse(response.stdout);
    return withinProviderBounds(value)
      ? { ok: true, value }
      : { ok: false, error: "malformed_response" };
  } catch {
    return { ok: false, error: "malformed_response" };
  }
}

export function parsePullRequestResponse(
  response: ProcessResponse,
): GitHubResult<PullRequestIdentity> {
  const parsed = parseJson(response);
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  if (
    !isRecord(value) ||
    !exactKeys(value, ["number", "state", "headRefName"]) ||
    typeof value.number !== "number" ||
    !validPrNumber(value.number) ||
    typeof value.state !== "string" ||
    typeof value.headRefName !== "string" ||
    !validBranch(value.headRefName)
  ) {
    return { ok: false, error: "malformed_response" };
  }
  const state = value.state.toLowerCase();
  if (state !== "open" && state !== "closed" && state !== "merged") {
    return { ok: false, error: "malformed_response" };
  }
  return {
    ok: true,
    value: {
      pullRequestNumber: value.number,
      pullRequestState: state,
      headBranch: value.headRefName,
    },
  };
}

export function parseChecksResponse(response: ProcessResponse): GitHubResult<GitHubCheckCounts> {
  if (isPinnedNoChecksResponse(response)) {
    return {
      ok: true,
      value: { passing: 0, failing: 0, pending: 0, skipped: 0, missing: 1 },
    };
  }
  const parsed = parseJson(response);
  if (!parsed.ok) return parsed;
  if (!Array.isArray(parsed.value) || parsed.value.length < 1 || parsed.value.length > 128) {
    return { ok: false, error: "malformed_response" };
  }
  const counts: GitHubCheckCounts = {
    passing: 0,
    failing: 0,
    pending: 0,
    skipped: 0,
    missing: 0,
  };
  const mutable = { ...counts };
  for (const item of parsed.value) {
    if (
      !isRecord(item) ||
      !exactKeys(item, ["state", "bucket"]) ||
      typeof item.state !== "string" ||
      typeof item.bucket !== "string" ||
      containsUnsafeDisplayText(item.state) ||
      containsUnsafeDisplayText(item.bucket) ||
      [...item.state].length > 64 ||
      [...item.bucket].length > 64
    ) {
      return { ok: false, error: "malformed_response" };
    }
    const state = item.state.toUpperCase();
    const bucket = item.bucket.toLowerCase();
    if (bucket === "pass" && state === "SUCCESS") mutable.passing += 1;
    else if (
      (bucket === "fail" || bucket === "cancel") &&
      ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(state)
    ) mutable.failing += 1;
    else if (
      bucket === "pending" &&
      ["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", "EXPECTED"].includes(state)
    ) mutable.pending += 1;
    else if (
      bucket === "skipping" &&
      ["SKIPPED", "NEUTRAL", "STALE"].includes(state)
    ) mutable.skipped += 1;
    else return { ok: false, error: "malformed_response" };
  }
  return { ok: true, value: mutable };
}

function isPinnedNoChecksResponse(response: ProcessResponse): boolean {
  const prefix = "no checks reported on the '";
  const suffix = "' branch";
  if (
    response.exitCode !== 1 ||
    response.stdout !== "" ||
    response.aborted === true ||
    response.timedOut === true ||
    response.stdoutTruncated === true ||
    response.stderrTruncated === true ||
    new TextEncoder().encode(response.stderr).byteLength > 512 ||
    containsUnsafeDisplayText(response.stderr.replace(/\n$/u, ""))
  ) {
    return false;
  }
  const stderr = response.stderr.endsWith("\n")
    ? response.stderr.slice(0, -1)
    : response.stderr;
  if (!stderr.startsWith(prefix) || !stderr.endsWith(suffix)) return false;
  const branch = stderr.slice(prefix.length, -suffix.length);
  return validBranch(branch);
}
