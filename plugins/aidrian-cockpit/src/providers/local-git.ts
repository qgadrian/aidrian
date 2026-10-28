import { resolveGitHubRepository } from "../config.ts";
import { containsUnsafeDisplayText } from "../model.ts";

export const GIT_OPERATIONS = [
  "GIT_TOP_LEVEL",
  "GIT_HEAD",
  "GIT_BRANCH",
  "GIT_STATUS",
  "GIT_ORIGIN",
] as const;

export type GitOperation = (typeof GIT_OPERATIONS)[number];

export interface ProcessRequestDescriptor {
  readonly operation: GitOperation | "GH_CURRENT_PR" | "GH_PR_CHECKS";
  readonly executable: "git" | "gh";
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly inheritEnv: readonly ["PATH"];
  readonly stdin: "closed";
  readonly timeoutMs: 2_000 | 10_000;
  readonly stdoutLimitBytes: 65_536;
  readonly stderrLimitBytes: 65_536;
}

export interface ProcessResponse {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut?: boolean;
  readonly aborted?: boolean;
  readonly stdoutTruncated?: boolean;
  readonly stderrTruncated?: boolean;
}

export type ProcessParseError =
  | "aborted"
  | "timeout"
  | "command_failed"
  | "response_too_large"
  | "malformed_response";

export type LocalGitResult =
  | { readonly ok: true; readonly operation: "GIT_TOP_LEVEL"; readonly canonicalRoot: string }
  | { readonly ok: true; readonly operation: "GIT_HEAD"; readonly head: string }
  | { readonly ok: true; readonly operation: "GIT_BRANCH"; readonly branch: string | null }
  | {
      readonly ok: true;
      readonly operation: "GIT_STATUS";
      readonly branch: string | null;
      readonly head: string | null;
      readonly dirty: boolean;
    }
  | { readonly ok: true; readonly operation: "GIT_ORIGIN"; readonly repository: string }
  | { readonly ok: false; readonly operation: GitOperation; readonly error: ProcessParseError };

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
const OUTPUT_LIMIT_BYTES = 65_536;

function validCanonicalRoot(value: string): boolean {
  return (
    value.startsWith("/") &&
    !containsUnsafeDisplayText(value) &&
    new TextEncoder().encode(value).byteLength <= 4096
  );
}

function fixedArgv(operation: GitOperation): readonly string[] {
  switch (operation) {
    case "GIT_TOP_LEVEL":
      return ["-c", "core.fsmonitor=false", "rev-parse", "--show-toplevel"];
    case "GIT_HEAD":
      return ["-c", "core.fsmonitor=false", "rev-parse", "--verify", "HEAD"];
    case "GIT_BRANCH":
      return ["-c", "core.fsmonitor=false", "rev-parse", "--abbrev-ref", "HEAD"];
    case "GIT_STATUS":
      return ["-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"];
    case "GIT_ORIGIN":
      return ["-c", "core.fsmonitor=false", "remote", "get-url", "origin"];
  }
}

export function createGitRequest(
  operation: GitOperation,
  canonicalRoot: string,
): ProcessRequestDescriptor | null {
  if (!GIT_OPERATIONS.includes(operation) || !validCanonicalRoot(canonicalRoot)) return null;
  return Object.freeze({
    operation,
    executable: "git",
    argv: Object.freeze([...fixedArgv(operation)]),
    cwd: canonicalRoot,
    env: PROCESS_ENV,
    inheritEnv: INHERITED_ENV,
    stdin: "closed",
    timeoutMs: 2_000,
    stdoutLimitBytes: OUTPUT_LIMIT_BYTES,
    stderrLimitBytes: OUTPUT_LIMIT_BYTES,
  });
}

function responseFailure(response: ProcessResponse): ProcessParseError | null {
  if (response.aborted === true) return "aborted";
  if (response.timedOut === true) return "timeout";
  if (
    response.stdoutTruncated === true ||
    response.stderrTruncated === true ||
    new TextEncoder().encode(response.stdout).byteLength > OUTPUT_LIMIT_BYTES ||
    new TextEncoder().encode(response.stderr).byteLength > OUTPUT_LIMIT_BYTES
  ) {
    return "response_too_large";
  }
  if (!Number.isSafeInteger(response.exitCode) || response.exitCode !== 0) return "command_failed";
  return null;
}

function singleLine(value: string, maximumScalars: number): string | null {
  const trimmed = value.endsWith("\n") ? value.slice(0, -1) : value;
  if (
    trimmed.length === 0 ||
    containsUnsafeDisplayText(trimmed) ||
    [...trimmed].length > maximumScalars
  ) {
    return null;
  }
  return trimmed;
}

function parseStatus(stdout: string): Extract<LocalGitResult, { operation: "GIT_STATUS" }> | null {
  const lines = stdout.split("\n");
  let branch: string | null = null;
  let head: string | null = null;
  let sawBranch = false;
  let sawHead = false;
  let dirty = false;
  for (const line of lines) {
    if (line === "") continue;
    if (line.startsWith("# branch.head ")) {
      if (sawBranch) return null;
      const candidate = singleLine(line.slice("# branch.head ".length), 255);
      if (candidate === null) return null;
      branch = candidate === "(detached)" ? null : candidate;
      sawBranch = true;
      continue;
    }
    if (line.startsWith("# branch.oid ")) {
      if (sawHead) return null;
      const candidate = line.slice("# branch.oid ".length);
      if (candidate !== "(initial)" && !/^[a-f0-9]{40,64}$/u.test(candidate)) return null;
      head = candidate === "(initial)" ? null : candidate;
      sawHead = true;
      continue;
    }
    if (line.startsWith("# ")) continue;
    if (!/^[12u?!] /u.test(line)) return null;
    dirty = true;
  }
  return sawBranch && sawHead
    ? { ok: true, operation: "GIT_STATUS", branch, head, dirty }
    : null;
}

export function parseGitResponse(
  operation: GitOperation,
  response: ProcessResponse,
): LocalGitResult {
  const failure = responseFailure(response);
  if (failure !== null) return { ok: false, operation, error: failure };
  switch (operation) {
    case "GIT_TOP_LEVEL": {
      const canonicalRoot = singleLine(response.stdout, 4096);
      return canonicalRoot !== null && validCanonicalRoot(canonicalRoot)
        ? { ok: true, operation, canonicalRoot }
        : { ok: false, operation, error: "malformed_response" };
    }
    case "GIT_HEAD": {
      const head = singleLine(response.stdout, 64);
      return head !== null && /^[a-f0-9]{40,64}$/u.test(head)
        ? { ok: true, operation, head }
        : { ok: false, operation, error: "malformed_response" };
    }
    case "GIT_BRANCH": {
      const branch = singleLine(response.stdout, 255);
      return branch !== null && branch !== "--" && !branch.startsWith("-")
        ? { ok: true, operation, branch: branch === "HEAD" ? null : branch }
        : { ok: false, operation, error: "malformed_response" };
    }
    case "GIT_STATUS":
      return parseStatus(response.stdout) ?? { ok: false, operation, error: "malformed_response" };
    case "GIT_ORIGIN": {
      const origin = singleLine(response.stdout, 512);
      const resolution = origin === null ? null : resolveGitHubRepository(undefined, origin);
      return resolution?.state === "resolved"
        ? { ok: true, operation, repository: resolution.repository }
        : { ok: false, operation, error: "malformed_response" };
    }
  }
}
