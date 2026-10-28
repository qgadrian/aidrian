export const PROVIDER_STATES = [
  "disabled",
  "loading",
  "fresh",
  "stale",
  "unauthorized",
  "unavailable",
  "error",
] as const;

export type ProviderState = (typeof PROVIDER_STATES)[number];
export type ProviderName = "github" | "linear";

export const PROVIDER_REASONS = [
  "not_configured",
  "invalid_config",
  "approval_missing",
  "reapproval_required",
  "refresh_cancelled",
  "timeout",
  "unauthorized",
  "provider_unavailable",
  "malformed_response",
  "response_too_large",
  "unsupported_host",
  "untrusted_workspace",
  "cache_invalid",
  "backoff",
] as const;

export type ProviderReason = (typeof PROVIDER_REASONS)[number];

export interface GitHubCheckCounts {
  readonly passing: number;
  readonly failing: number;
  readonly pending: number;
  readonly skipped: number;
  readonly missing: number;
}

export interface GitHubSummary {
  readonly provider: "github";
  readonly pullRequestNumber: number;
  readonly pullRequestState: "open" | "closed" | "merged" | "unknown";
  readonly checks: GitHubCheckCounts;
}

export interface LinearSummary {
  readonly provider: "linear";
  readonly issueKey: string;
  readonly issueState: string;
}

export type ProviderValue = GitHubSummary | LinearSummary;

export interface ProviderSnapshot {
  readonly state: ProviderState;
  readonly observedAt: number | null;
  readonly refreshedAt: number | null;
  readonly reason: ProviderReason | null;
  readonly value: ProviderValue | null;
}

export type ProviderEvent =
  | { readonly type: "disable" }
  | { readonly type: "enable" }
  | { readonly type: "refresh_started"; readonly at: number }
  | { readonly type: "refresh_succeeded"; readonly at: number; readonly value: ProviderValue }
  | {
      readonly type: "refresh_failed";
      readonly at: number;
      readonly state: "unauthorized" | "unavailable" | "error";
      readonly reason: ProviderReason;
    }
  | { readonly type: "refresh_aborted"; readonly at: number }
  | { readonly type: "mark_stale"; readonly at: number; readonly reason: ProviderReason };

export interface RefreshControl {
  readonly inFlightGeneration: number | null;
  readonly nextGeneration: number;
  readonly lastStartedAt: number | null;
  readonly consecutiveFailures: number;
  readonly nextAllowedAt: number;
}

export type RefreshStart =
  | { readonly started: true; readonly generation: number; readonly control: RefreshControl }
  | {
      readonly started: false;
      readonly reason: "already_in_flight" | "minimum_interval" | "backoff";
      readonly control: RefreshControl;
    };

export type RefreshCompletion =
  | { readonly accepted: true; readonly control: RefreshControl }
  | { readonly accepted: false; readonly reason: "stale_completion"; readonly control: RefreshControl };

export type ApprovalAccess =
  | { readonly mode: "approved" }
  | { readonly mode: "local_only"; readonly reason: "approval_missing" | "reapproval_required" };

export interface RuntimeApproval {
  readonly schemaVersion: 1;
  readonly projectDigest: string;
  readonly configDigest: string;
  readonly capabilityManifestDigest: string;
  readonly pluginVersion: string;
  readonly pluginArtifactDigest: string;
  readonly moduleDigest: string;
  readonly controllerDigest: string;
  readonly hostVersion: string;
  readonly hostBinaryDigest: string;
  readonly declarationDigest: string;
  readonly approvedAt: string;
}

export type ApprovalTuple = Omit<RuntimeApproval, "schemaVersion" | "approvedAt">;

export interface AbovePromptViewModel {
  readonly surface: "above_prompt";
  readonly text: string;
  readonly tone: "neutral" | "muted" | "good" | "warn" | "bad";
  readonly truncated: boolean;
}

export interface PaneRowViewModel {
  readonly label: string;
  readonly value: string;
  readonly tone: "neutral" | "muted" | "good" | "warn" | "bad";
}

export interface PaneViewModel {
  readonly surface: "pane";
  readonly title: "Cockpit";
  readonly rows: readonly PaneRowViewModel[];
  readonly actions: readonly [{ readonly id: "refresh"; readonly label: "Refresh" }];
  readonly truncated: boolean;
}

const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000] as const;
const MINIMUM_REFRESH_INTERVAL_MS = 60_000;
const UNSAFE_DISPLAY_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export function containsUnsafeDisplayText(value: string): boolean {
  return !value.isWellFormed() || UNSAFE_DISPLAY_PATTERN.test(value);
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function initialProviderSnapshot(configured: boolean): ProviderSnapshot {
  return {
    state: configured ? "stale" : "disabled",
    observedAt: null,
    refreshedAt: null,
    reason: configured ? "provider_unavailable" : "not_configured",
    value: null,
  };
}

export function reduceProviderSnapshot(
  current: ProviderSnapshot,
  event: ProviderEvent,
): ProviderSnapshot {
  if (event.type === "disable") {
    return initialProviderSnapshot(false);
  }
  if (event.type === "enable") {
    return current.state === "disabled" ? initialProviderSnapshot(true) : current;
  }
  if (!validTimestamp(event.at) || current.state === "disabled") {
    return current;
  }
  switch (event.type) {
    case "refresh_started":
      return { ...current, state: "loading", refreshedAt: event.at, reason: null };
    case "refresh_succeeded":
      return {
        state: "fresh",
        observedAt: event.at,
        refreshedAt: event.at,
        reason: null,
        value: event.value,
      };
    case "refresh_failed":
      return {
        ...current,
        state: event.state,
        refreshedAt: event.at,
        reason: event.reason,
      };
    case "refresh_aborted":
      return {
        ...current,
        state: current.value === null ? "unavailable" : "stale",
        refreshedAt: event.at,
        reason: "refresh_cancelled",
      };
    case "mark_stale":
      return { ...current, state: "stale", refreshedAt: event.at, reason: event.reason };
  }
}

export function initialRefreshControl(): RefreshControl {
  return {
    inFlightGeneration: null,
    nextGeneration: 1,
    lastStartedAt: null,
    consecutiveFailures: 0,
    nextAllowedAt: 0,
  };
}

export function refreshControlKey(projectDigest: string, provider: ProviderName): string | null {
  return /^[a-f0-9]{64}$/u.test(projectDigest)
    ? `cockpit:v1:${projectDigest}:${provider}:refresh`
    : null;
}

export function beginRefresh(control: RefreshControl, nowMs: number): RefreshStart {
  if (!validTimestamp(nowMs)) {
    return { started: false, reason: "backoff", control };
  }
  if (control.inFlightGeneration !== null) {
    return { started: false, reason: "already_in_flight", control };
  }
  if (nowMs < control.nextAllowedAt) {
    return { started: false, reason: "backoff", control };
  }
  if (
    control.lastStartedAt !== null &&
    nowMs - control.lastStartedAt < MINIMUM_REFRESH_INTERVAL_MS
  ) {
    return { started: false, reason: "minimum_interval", control };
  }
  const generation = control.nextGeneration;
  return {
    started: true,
    generation,
    control: {
      ...control,
      inFlightGeneration: generation,
      nextGeneration: generation + 1,
      lastStartedAt: nowMs,
    },
  };
}

export function completeRefresh(
  control: RefreshControl,
  generation: number,
  outcome: "success" | "failure" | "aborted",
  nowMs: number,
): RefreshCompletion {
  if (control.inFlightGeneration !== generation || !validTimestamp(nowMs)) {
    return { accepted: false, reason: "stale_completion", control };
  }
  if (outcome === "success") {
    return {
      accepted: true,
      control: {
        ...control,
        inFlightGeneration: null,
        consecutiveFailures: 0,
        nextAllowedAt: nowMs,
      },
    };
  }
  if (outcome === "aborted") {
    return {
      accepted: true,
      control: { ...control, inFlightGeneration: null, nextAllowedAt: nowMs },
    };
  }
  const failures = Math.min(control.consecutiveFailures + 1, BACKOFF_MS.length);
  const delay = BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)] ?? BACKOFF_MS[3];
  return {
    accepted: true,
    control: {
      ...control,
      inFlightGeneration: null,
      consecutiveFailures: failures,
      nextAllowedAt: nowMs + delay,
    },
  };
}
