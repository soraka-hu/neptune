import { type CSSProperties } from "react";

import { RunRecord } from "../../services/runService";

export const panelStyle: CSSProperties = {
  borderRadius: 12,
  padding: 16,
  background: "#ffffff",
  border: "1px solid #E5E7EB",
  boxShadow: "none",
};

export const terminalStatuses = new Set(["success", "failed", "partially_success", "canceled", "timeout"]);
export const terminalItemStatuses = new Set(["success", "failed", "skipped", "canceled"]);

export function parseMaybeNumber(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const next = Number(value);
  return Number.isInteger(next) && next > 0 ? next : null;
}

export function makeIdempotencyKey(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function toNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toPretty(value: unknown): string {
  if (value === null || value === undefined) {
    return "-";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function runTypeLabel(value: string | undefined): string {
  if (value === "agent_eval") {
    return "benchmark";
  }
  return "api_test";
}

export function displayStatus(status: string): string {
  return status === "success" ? "done" : status;
}

export function statusPillStyle(status: string): CSSProperties {
  const normalized = displayStatus(status);
  if (normalized === "running") {
    return { background: "rgba(28,107,168,0.15)", color: "#164f79" };
  }
  if (normalized === "queued" || normalized === "pending") {
    return { background: "rgba(110,121,125,0.14)", color: "#4d5658" };
  }
  if (normalized === "failed" || normalized === "timeout") {
    return { background: "rgba(169,52,38,0.16)", color: "#802b23" };
  }
  if (normalized === "partially_success") {
    return { background: "rgba(188,128,37,0.16)", color: "#895e1f" };
  }
  return { background: "rgba(38,129,79,0.16)", color: "#1f6a43" };
}

export function resolveRunSummary(run: RunRecord): string {
  const summary = (run.summary || {}) as Record<string, unknown>;
  const total = toNumber(summary.total);
  const passed = toNumber(summary.passed);
  const failed = toNumber(summary.failed);
  if (run.run_type === "agent_eval") {
    const avgScore = typeof summary.avg_score === "number" ? summary.avg_score.toFixed(3) : "-";
    const passRate = total > 0 ? ((passed / total) * 100).toFixed(1) : "0.0";
    return `avg_score ${avgScore} ｜ pass_rate ${passRate}%`;
  }
  const passRate = total > 0 ? ((passed / total) * 100).toFixed(1) : "0.0";
  return `通过率 ${passRate}%（${passed}/${total}）`;
}

export function normalizeItemName(item: Record<string, unknown>): string {
  const display = item.case_display_name;
  if (typeof display === "string" && display.trim()) {
    return display;
  }
  const name = item.case_name;
  if (typeof name === "string" && name.trim()) {
    return name;
  }
  const caseId = item.case_id;
  if (typeof caseId === "number") {
    return `case#${caseId}`;
  }
  return `item#${item.id}`;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }
  const raw = value.trim();
  if (!raw) {
    return "-";
  }

  const normalized = normalizeAsUtcIso(raw);
  if (!normalized) {
    return raw.replace("T", " ").slice(0, 19);
  }

  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return raw.replace("T", " ").slice(0, 19);
  }

  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(parsed);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
}

function normalizeAsUtcIso(raw: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return `${raw}T00:00:00Z`;
  }
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)) {
    return raw.replace(" ", "T") + "Z";
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)) {
    return `${raw}Z`;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    return raw;
  }
  return null;
}

export function scoreToBarPercent(score: number): number {
  if (!Number.isFinite(score)) {
    return 0;
  }
  const normalized = score <= 1 ? score * 100 : score;
  return Math.max(0, Math.min(100, normalized));
}
