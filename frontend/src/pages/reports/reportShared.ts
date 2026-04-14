import { type CSSProperties } from "react";

export const panelStyle: CSSProperties = {
  borderRadius: 12,
  padding: 16,
  background: "#ffffff",
  border: "1px solid #E5E7EB",
  boxShadow: "none",
};

export function parseMaybeNumber(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const next = Number(value);
  return Number.isInteger(next) && next > 0 ? next : null;
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

export function fmtPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

export function fmtScore(value: number | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "-";
  }
  return value.toFixed(3);
}

export function scoreToPercent(score: number): number {
  if (!Number.isFinite(score)) {
    return 0;
  }
  const normalized = score <= 1 ? score * 100 : score;
  return Math.max(0, Math.min(100, normalized));
}

export function formatDate(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }
  return value.replace("T", " ").slice(0, 19);
}

export function withinRange(value: string | undefined, range: "7d" | "30d" | "all"): boolean {
  if (range === "all" || !value) {
    return true;
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return true;
  }
  const days = range === "7d" ? 7 : 30;
  return Date.now() - timestamp <= days * 24 * 60 * 60 * 1000;
}
