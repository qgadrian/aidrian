import type {
  AbovePromptViewModel,
  ApprovalAccess,
  GitHubSummary,
  LinearSummary,
  PaneRowViewModel,
  PaneViewModel,
  ProviderSnapshot,
} from "./model.ts";

export interface CockpitRenderInput {
  readonly repository: string | null;
  readonly branch: string | null;
  readonly dirty: boolean;
  readonly contextPercent: number | null;
  readonly ratePercent: number | null;
  readonly activeAgents: number;
  readonly totalAgents: number;
  readonly github: ProviderSnapshot;
  readonly linear: ProviderSnapshot;
  readonly approval: ApprovalAccess;
  readonly nowMs: number;
}

type Tone = AbovePromptViewModel["tone"];

const ROW_MAX_SCALARS = 512;
const PANE_MAX_BYTES = 8 * 1024;
const UNSAFE_CODE_POINT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function escapeCharacter(character: string): string {
  switch (character) {
    case "&":
      return "&amp;";
    case "<":
      return "&lt;";
    case ">":
      return "&gt;";
    case '"':
      return "&quot;";
    case "'":
      return "&#39;";
    default:
      return !character.isWellFormed() || UNSAFE_CODE_POINT.test(character) ? "�" : character;
  }
}

export function escapeTerminalText(
  value: string,
  maximumScalars: number,
): { readonly text: string; readonly truncated: boolean } {
  if (!Number.isSafeInteger(maximumScalars) || maximumScalars < 1) {
    return { text: "", truncated: value.length > 0 };
  }
  const output: string[] = [];
  let used = 0;
  let truncated = false;
  for (const character of value) {
    const escaped = escapeCharacter(character);
    const width = [...escaped].length;
    if (used + width > maximumScalars) {
      truncated = true;
      break;
    }
    output.push(escaped);
    used += width;
  }
  if (!truncated) return { text: output.join(""), truncated: false };
  while (output.length > 0 && used >= maximumScalars) {
    const removed = output.pop();
    used -= removed === undefined ? 0 : [...removed].length;
  }
  output.push("…");
  return { text: output.join(""), truncated: true };
}

function boundedPercent(value: number | null): string {
  return value !== null && Number.isFinite(value) && value >= 0 && value <= 100
    ? `${Math.round(value)}%`
    : "unknown";
}

function boundedCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000 ? value : 0;
}

function ageLabel(observedAt: number | null, nowMs: number): string {
  if (
    observedAt === null ||
    !Number.isSafeInteger(observedAt) ||
    !Number.isSafeInteger(nowMs) ||
    observedAt < 0 ||
    nowMs < observedAt
  ) {
    return "age unknown";
  }
  const seconds = Math.floor((nowMs - observedAt) / 1000);
  if (seconds < 60) return `${seconds}s old`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m old`;
  return `${Math.floor(minutes / 60)}h old`;
}

function githubValue(snapshot: ProviderSnapshot): GitHubSummary | null {
  return snapshot.value?.provider === "github" ? snapshot.value : null;
}

function linearValue(snapshot: ProviderSnapshot): LinearSummary | null {
  return snapshot.value?.provider === "linear" ? snapshot.value : null;
}

function providerTone(snapshot: ProviderSnapshot): Tone {
  if (snapshot.state === "fresh") return "good";
  if (snapshot.state === "disabled") return "muted";
  if (snapshot.state === "error" || snapshot.state === "unauthorized") return "bad";
  return "warn";
}

function worstTone(tones: readonly Tone[]): Tone {
  const rank: Readonly<Record<Tone, number>> = {
    neutral: 0,
    muted: 1,
    good: 0,
    warn: 2,
    bad: 3,
  };
  return tones.reduce((worst, tone) => (rank[tone] > rank[worst] ? tone : worst), "neutral");
}

function githubLabel(snapshot: ProviderSnapshot): string {
  const value = githubValue(snapshot);
  const reason = snapshot.reason === null ? "" : ` (${snapshot.reason})`;
  if (value === null) return `GitHub ${snapshot.state}${reason}`;
  const checks = value.checks;
  return `GitHub PR #${value.pullRequestNumber} ${value.pullRequestState}; checks ${checks.passing} pass, ${checks.failing} fail, ${checks.pending} pending, ${checks.skipped} skipped, ${checks.missing} missing; ${snapshot.state}${reason}`;
}

function linearLabel(snapshot: ProviderSnapshot): string {
  const value = linearValue(snapshot);
  const reason = snapshot.reason === null ? "" : ` (${snapshot.reason})`;
  return value === null
    ? `Linear ${snapshot.state}${reason}`
    : `Linear ${value.issueKey} ${value.issueState}; ${snapshot.state}${reason}`;
}

export function buildAbovePromptView(input: CockpitRenderInput): AbovePromptViewModel {
  const repository = input.repository ?? "local";
  const branch = input.branch ?? "detached";
  const external = input.approval.mode === "approved" ? "external approved" : input.approval.reason;
  const unbounded = [
    `${repository}@${branch}${input.dirty ? " dirty" : " clean"}`,
    `context ${boundedPercent(input.contextPercent)} rate ${boundedPercent(input.ratePercent)}`,
    `agents ${boundedCount(input.activeAgents)}/${boundedCount(input.totalAgents)}`,
    githubLabel(input.github),
    linearLabel(input.linear),
    external,
  ].join(" | ");
  const bounded = escapeTerminalText(unbounded, ROW_MAX_SCALARS);
  const tone = bounded.truncated
    ? "warn"
    : worstTone([providerTone(input.github), providerTone(input.linear)]);
  return { surface: "above_prompt", text: bounded.text, tone, truncated: bounded.truncated };
}

function paneRow(
  label: string,
  value: string,
  tone: Tone,
): { readonly row: PaneRowViewModel; readonly truncated: boolean } {
  const safeLabel = escapeTerminalText(label, 64);
  const safeValue = escapeTerminalText(value, 768);
  const truncated = safeLabel.truncated || safeValue.truncated;
  return {
    row: {
      label: safeLabel.text,
      value: safeValue.text,
      tone: truncated ? "warn" : tone,
    },
    truncated,
  };
}

export function buildPaneView(input: CockpitRenderInput): PaneViewModel {
  const github = githubLabel(input.github);
  const linear = linearLabel(input.linear);
  const rowResults = [
    paneRow(
      "Repository",
      `${input.repository ?? "local"} · ${input.branch ?? "detached"} · ${input.dirty ? "dirty" : "clean"}`,
      input.dirty ? "warn" : "neutral",
    ),
    paneRow(
      "Session",
      `context ${boundedPercent(input.contextPercent)} · rate ${boundedPercent(input.ratePercent)} · agents ${boundedCount(input.activeAgents)}/${boundedCount(input.totalAgents)}`,
      "neutral",
    ),
    paneRow(
      "GitHub",
      `${github} · observation ${ageLabel(input.github.observedAt, input.nowMs)} · last refresh ${ageLabel(input.github.refreshedAt, input.nowMs)}`,
      providerTone(input.github),
    ),
    paneRow(
      "Linear",
      `${linear} · observation ${ageLabel(input.linear.observedAt, input.nowMs)} · last refresh ${ageLabel(input.linear.refreshedAt, input.nowMs)}`,
      providerTone(input.linear),
    ),
    paneRow(
      "External refresh",
      input.approval.mode === "approved" ? "approved" : `local only · ${input.approval.reason}`,
      input.approval.mode === "approved" ? "good" : "warn",
    ),
  ];
  const rows = rowResults.map((result) => result.row);
  const candidate: PaneViewModel = {
    surface: "pane",
    title: "Cockpit",
    rows,
    actions: [{ id: "refresh", label: "Refresh" }],
    truncated: rowResults.some((result) => result.truncated),
  };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(candidate)).byteLength;
  if (payloadBytes <= PANE_MAX_BYTES) {
    return candidate;
  }
  const fallback = paneRow("Cockpit", "Pane content exceeded its safe display bound", "bad");
  return {
    surface: "pane",
    title: "Cockpit",
    rows: [fallback.row],
    actions: [{ id: "refresh", label: "Refresh" }],
    truncated: true,
  };
}
