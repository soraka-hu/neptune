import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CircleDollarSign,
  Clock3,
  Cpu,
  Download,
  FileText,
  Gauge,
  Layers3,
  Minus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  TrendingDown,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";

import { FloatingNotice, type NoticeTone } from "../../components/FloatingNotice";
import { ProjectRecord, listProjects } from "../../services/assetService";
import {
  DashboardV1Response,
  RunDetailReport,
  SuiteAnalyticsReport,
  exportDashboardV1Markdown,
  getDashboardV1,
  getRunDetailReport,
  getSuiteAnalyticsReport,
} from "../../services/reportService";
import { buildExportFileName, downloadMarkdownFile, exportElementAsPng } from "./reportExport";
import { fmtPercent, fmtScore, parseMaybeNumber, scoreToPercent } from "./reportShared";

import "./ProjectDashboardPage.css";

type ReportTypeFilter = "all" | "api" | "benchmark";
type TimeRange = "7d" | "30d" | "all";
const PROJECT_API_TREND_PROJECT_LIMIT = 6;

type TrendPoint = {
  label: string;
  value: number;
  display: string;
  raw?: string;
};

type BenchmarkSuiteTrendRun = {
  runId: number;
  createdAt?: string;
  value: number;
  display: string;
  raw: string;
  status?: string;
};

type BenchmarkSuiteTrendSeries = {
  suiteId: number;
  suiteName: string;
  runs: BenchmarkSuiteTrendRun[];
  latestRunId: number;
  latestScore: number;
  latestDisplay: string;
};

type KpiCardItem = {
  label: string;
  value: string;
  hint: string;
  icon: LucideIcon;
  delta: number | null;
  deltaUnit: string;
  betterDirection: "up" | "down";
  detail: string;
};

type InsightItem = {
  title: string;
  content: string;
  level: "good" | "risk" | "neutral";
};

type DimensionMetric = {
  name: string;
  value: number;
  sampleCount: number;
};

type TooltipPayload = {
  title: string;
  lines?: string[];
  accent?: "blue" | "green" | "pink" | "amber";
};

type TooltipState = TooltipPayload & {
  x: number;
  y: number;
};

type TooltipHandlers = {
  onEnter: (event: ReactMouseEvent<HTMLElement | SVGElement>, payload: TooltipPayload) => void;
  onMove: (event: ReactMouseEvent<HTMLElement | SVGElement>) => void;
  onLeave: () => void;
};

function cn(...classes: Array<string | undefined | false>): string {
  return classes.filter(Boolean).join(" ");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeDimensionScore(value: number): number {
  return clamp(value <= 1 ? value * 100 : value, 0, 100);
}

function normalizeRunType(value: string | undefined): string {
  return value === "benchmark" ? "agent_eval" : value ?? "api_test";
}

function buildSuiteBenchmarkSeries(
  report: SuiteAnalyticsReport,
  suiteNameFallback?: string,
  recentLimit = 8
): BenchmarkSuiteTrendSeries | null {
  const benchmarkRuns = [...report.runHistory]
    .filter(
      (item) =>
        normalizeRunType(item.runType) === "agent_eval" && typeof item.avgScore === "number" && Number.isFinite(item.avgScore)
    )
    .sort((a, b) => b.runId - a.runId)
    .slice(0, recentLimit)
    .sort((a, b) => a.runId - b.runId);

  if (benchmarkRuns.length === 0) {
    return null;
  }

  const latestRun = benchmarkRuns[benchmarkRuns.length - 1];
  if (!latestRun || typeof latestRun.avgScore !== "number") {
    return null;
  }

  const suiteName = suiteNameFallback || report.suiteName || `Suite #${report.suiteId}`;
  const runs: BenchmarkSuiteTrendRun[] = benchmarkRuns.map((run) => ({
    runId: run.runId,
    createdAt: run.createdAt,
    value: clamp(scoreToPercent(run.avgScore ?? 0), 0, 100),
    display: fmtScore(run.avgScore ?? 0),
    raw: `${suiteName} · Run #${run.runId}${run.status ? ` · ${run.status}` : ""}`,
    status: run.status,
  }));

  return {
    suiteId: report.suiteId,
    suiteName,
    runs,
    latestRunId: latestRun.runId,
    latestScore: latestRun.avgScore,
    latestDisplay: fmtScore(latestRun.avgScore),
  };
}

function buildSuiteApiSeries(report: SuiteAnalyticsReport, suiteNameFallback?: string, recentLimit = 10): BenchmarkSuiteTrendSeries | null {
  const apiRuns = [...report.runHistory]
    .filter(
      (item) =>
        normalizeRunType(item.runType) === "api_test" && typeof item.passRate === "number" && Number.isFinite(item.passRate)
    )
    .sort((a, b) => b.runId - a.runId)
    .slice(0, recentLimit)
    .sort((a, b) => a.runId - b.runId);

  if (apiRuns.length === 0) {
    return null;
  }

  const latestRun = apiRuns[apiRuns.length - 1];
  if (!latestRun || typeof latestRun.passRate !== "number") {
    return null;
  }

  const suiteName = suiteNameFallback || report.suiteName || `Suite #${report.suiteId}`;
  const runs: BenchmarkSuiteTrendRun[] = apiRuns.map((run) => ({
    runId: run.runId,
    createdAt: run.createdAt,
    value: clamp(run.passRate ?? 0, 0, 100),
    display: fmtPercent(run.passRate ?? 0),
    raw: `${suiteName} · Run #${run.runId}${run.status ? ` · ${run.status}` : ""}`,
    status: run.status,
  }));

  return {
    suiteId: report.suiteId,
    suiteName,
    runs,
    latestRunId: latestRun.runId,
    latestScore: latestRun.passRate,
    latestDisplay: fmtPercent(latestRun.passRate),
  };
}

function buildProjectApiSeries(
  report: DashboardV1Response,
  projectNameFallback?: string,
  recentLimit = 10
): BenchmarkSuiteTrendSeries | null {
  const apiRuns = [...(report.trends.apiPassRate ?? [])]
    .sort((a, b) => b.runId - a.runId)
    .slice(0, recentLimit)
    .sort((a, b) => a.runId - b.runId);

  if (apiRuns.length === 0) {
    return null;
  }

  const latestRun = apiRuns[apiRuns.length - 1];
  const latestValue = latestRun?.value ?? 0;
  const projectId = typeof report.projectId === "number" ? report.projectId : -1;
  const projectName = projectNameFallback || report.projectName || `项目 #${projectId > 0 ? projectId : "unknown"}`;

  return {
    suiteId: projectId > 0 ? projectId : 0,
    suiteName: projectName,
    runs: apiRuns.map((run) => ({
      runId: run.runId,
      createdAt: run.createdAt,
      value: clamp(run.value, 0, 100),
      display: fmtPercent(run.value),
      raw: `${projectName} · Run #${run.runId}`,
    })),
    latestRunId: latestRun?.runId ?? 0,
    latestScore: latestValue,
    latestDisplay: fmtPercent(latestValue),
  };
}

function buildProjectBenchmarkSeries(
  report: DashboardV1Response,
  projectNameFallback?: string,
  recentLimit = 10
): BenchmarkSuiteTrendSeries | null {
  const benchmarkRuns = [...(report.trends.benchmarkScore ?? [])]
    .sort((a, b) => b.runId - a.runId)
    .slice(0, recentLimit)
    .sort((a, b) => a.runId - b.runId);

  if (benchmarkRuns.length === 0) {
    return null;
  }

  const latestRun = benchmarkRuns[benchmarkRuns.length - 1];
  const latestValue = latestRun?.value ?? 0;
  const projectId = typeof report.projectId === "number" ? report.projectId : -1;
  const projectName = projectNameFallback || report.projectName || `项目 #${projectId > 0 ? projectId : "unknown"}`;

  return {
    suiteId: projectId > 0 ? projectId : 0,
    suiteName: projectName,
    runs: benchmarkRuns.map((run) => ({
      runId: run.runId,
      createdAt: run.createdAt,
      value: clamp(scoreToPercent(run.value), 0, 100),
      display: fmtScore(run.value),
      raw: `${projectName} · Run #${run.runId}`,
    })),
    latestRunId: latestRun?.runId ?? 0,
    latestScore: latestValue,
    latestDisplay: fmtScore(latestValue),
  };
}

function extractLatestDimensionMetrics(detail: RunDetailReport): DimensionMetric[] {
  type ItemDimension = { name: string; value: number };
  type Candidate = { itemId: number; finishedAt: number; dimensions: ItemDimension[] };

  const candidates: Candidate[] = [];

  detail.items.forEach((item) => {
    const scoreResult = item.score_result;
    if (!scoreResult || typeof scoreResult !== "object" || Array.isArray(scoreResult)) {
      return;
    }

    const dimensions = (scoreResult as Record<string, unknown>).dimensions;
    if (!Array.isArray(dimensions)) {
      return;
    }

    const parsedDimensions: ItemDimension[] = [];

    dimensions.forEach((dimension) => {
      if (!dimension || typeof dimension !== "object" || Array.isArray(dimension)) {
        return;
      }
      const row = dimension as Record<string, unknown>;
      const name = typeof row.name === "string" ? row.name.trim() : "";
      const rawScore = toFiniteNumber(row.score);
      if (!name || rawScore === null) {
        return;
      }

      parsedDimensions.push({
        name,
        value: normalizeDimensionScore(rawScore),
      });
    });

    if (parsedDimensions.length === 0) {
      return;
    }

    const finishedAtText = item.finished_at ?? item.started_at ?? "";
    const finishedAt = finishedAtText ? Date.parse(finishedAtText) : 0;
    candidates.push({
      itemId: item.id,
      finishedAt: Number.isFinite(finishedAt) ? finishedAt : 0,
      dimensions: parsedDimensions,
    });
  });

  if (candidates.length === 0) {
    return [];
  }

  candidates.sort((a, b) => b.finishedAt - a.finishedAt || b.itemId - a.itemId);
  const latestItem = candidates[0];

  return latestItem.dimensions
    .map((dimension) => ({
      name: dimension.name,
      value: dimension.value,
      sampleCount: 1,
    }))
    .sort((a, b) => b.value - a.value);
}

function formatTrendValue(value: number | null, unit: string): string {
  if (value === null || Number.isNaN(value)) {
    return "-";
  }
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(1)}${unit}`;
}

function calculateDelta(values: number[]): number | null {
  if (values.length < 2) {
    return null;
  }
  const end = values[values.length - 1];
  const start = values[Math.max(0, values.length - 4)];
  if (!Number.isFinite(end) || !Number.isFinite(start)) {
    return null;
  }
  return end - start;
}

function formatTrendLabel(createdAt: string | undefined, runId: number): string {
  if (!createdAt) {
    return `Run#${runId}`;
  }
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) {
    return `Run#${runId}`;
  }
  return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`;
}

function buildSmoothPath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) {
    return "";
  }
  if (points.length === 1) {
    return `M ${points[0].x} ${points[0].y}`;
  }
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = points[Math.max(0, index - 1)];
    const p1 = points[index];
    const p2 = points[index + 1];
    const p3 = points[Math.min(points.length - 1, index + 2)];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    path += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
  }
  return path;
}

function mapTrendPath(values: number[], width: number, height: number, padX: number, padY: number, smooth = false) {
  if (values.length === 0) {
    return null;
  }

  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = Math.max(max - min, 1);
  const chartWidth = width - padX * 2;
  const chartHeight = height - padY * 2;

  const points = values.map((value, index) => {
    const x = values.length === 1 ? width / 2 : padX + (index / (values.length - 1)) * chartWidth;
    const normalized = (value - min) / range;
    const y = padY + (1 - normalized) * chartHeight;
    return { x, y };
  });

  const line = smooth ? buildSmoothPath(points) : points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
  const area = `${line} L ${points[points.length - 1].x} ${height - padY} L ${points[0].x} ${height - padY} Z`;

  return { points, line, area };
}

function buildRadarPolygon(values: Array<{ name: string; value: number }>, level: number, radius: number, cx: number, cy: number): string {
  return values
    .map((item, index) => {
      const angle = -Math.PI / 2 + (index * 2 * Math.PI) / values.length;
      const r = clamp(item.value, 0, 100) * (radius / 100) * level;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      return `${x},${y}`;
    })
    .join(" ");
}

function KpiDeltaBadge({ value, unit, betterDirection }: { value: number | null; unit: string; betterDirection: "up" | "down" }) {
  if (value === null || Number.isNaN(value)) {
    return (
      <span className="project-kpi-delta neutral">
        <Minus size={14} /> 无趋势
      </span>
    );
  }

  const isNeutral = Math.abs(value) < 0.05;
  const isGood = betterDirection === "up" ? value > 0 : value < 0;
  const trendClass = isNeutral ? "neutral" : isGood ? "good" : "bad";
  const TrendIcon = isNeutral ? Minus : value > 0 ? TrendingUp : TrendingDown;

  return (
    <span className={`project-kpi-delta ${trendClass}`}>
      <TrendIcon size={14} /> {formatTrendValue(value, unit)}
    </span>
  );
}

function TrendChartCard({
  id,
  title,
  subtitle,
  points,
  unit,
  lineStart,
  lineEnd,
  areaStart,
  areaEnd,
  areaTopOpacity = 0.22,
  areaBottomOpacity = 0.03,
  dotColor,
  smooth = false,
  className,
  headerExtra,
  tooltip,
}: {
  id: string;
  title: string;
  subtitle: string;
  points: TrendPoint[];
  unit: string;
  lineStart: string;
  lineEnd: string;
  areaStart: string;
  areaEnd: string;
  areaTopOpacity?: number;
  areaBottomOpacity?: number;
  dotColor?: string;
  smooth?: boolean;
  className?: string;
  headerExtra?: ReactNode;
  tooltip?: TooltipHandlers;
}) {
  const width = 640;
  const height = 220;
  const padX = 34;
  const padY = 22;
  const geometry = mapTrendPath(
    points.map((point) => point.value),
    width,
    height,
    padX,
    padY,
    smooth
  );

  const latestPoint = points.length > 0 ? points[points.length - 1] : null;
  const latestGeometryPoint = geometry?.points[geometry.points.length - 1];

  return (
    <article className={cn("project-report-card project-chart-card", className)}>
      <header className="project-card-header">
        <div>
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </div>
        <div className="project-card-actions">
          {headerExtra}
          <span
            className="project-card-badge"
            onMouseEnter={(event) =>
              tooltip?.onEnter(event, {
                title: `${title} / ${unit}`,
                lines: [latestPoint ? `最新值：${latestPoint.display}` : "暂无最新值"],
                accent: "blue",
              })
            }
            onMouseMove={tooltip?.onMove}
            onMouseLeave={tooltip?.onLeave}
          >
            {unit}
          </span>
        </div>
      </header>

      {!geometry || points.length === 0 ? (
        <div className="project-empty">暂无趋势数据</div>
      ) : (
        <>
          <svg viewBox={`0 0 ${width} ${height}`} className="project-trend-svg" role="img" aria-label={title}>
            <defs>
              <linearGradient id={`${id}-line`} x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor={lineStart} />
                <stop offset="100%" stopColor={lineEnd} />
              </linearGradient>
              <linearGradient id={`${id}-area`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={areaStart} stopOpacity={String(areaTopOpacity)} />
                <stop offset="100%" stopColor={areaEnd} stopOpacity={String(areaBottomOpacity)} />
              </linearGradient>
            </defs>

            {[0, 1, 2, 3, 4].map((tick) => {
              const y = padY + (tick / 4) * (height - padY * 2);
              return <line key={`grid-${tick}`} x1={padX} y1={y} x2={width - padX} y2={y} className="project-grid-line" />;
            })}

            <path d={geometry.area} fill={`url(#${id}-area)`} className="project-trend-area" />
            <path
              d={geometry.line}
              stroke={`url(#${id}-line)`}
              strokeWidth={3}
              fill="none"
              strokeLinecap="round"
              className="project-trend-line"
            />

            {geometry.points.map((point, index) => {
              const tip = points[index];
              return (
                <circle
                  key={`dot-${index}`}
                  cx={point.x}
                  cy={point.y}
                  r={4}
                  fill="var(--app-surface)"
                  stroke={dotColor ?? lineEnd}
                  strokeWidth={3}
                  className="project-trend-dot"
                  style={{ animationDelay: `${index * 70}ms` }}
                  onMouseEnter={(event) =>
                    tooltip?.onEnter(event, {
                      title: `${title} · ${tip.label}`,
                      lines: [`值：${tip.display}`, tip.raw ? `运行：${tip.raw}` : ""].filter(Boolean),
                      accent: "blue",
                    })
                  }
                  onMouseMove={tooltip?.onMove}
                  onMouseLeave={tooltip?.onLeave}
                >
                  <title>{`${tip.label} | ${tip.display}`}</title>
                </circle>
              );
            })}

            {latestGeometryPoint ? (
              <circle
                cx={latestGeometryPoint.x}
                cy={latestGeometryPoint.y}
                r={7}
                fill="none"
                stroke={dotColor ?? lineEnd}
                strokeWidth={2}
                className="project-trend-focus"
              />
            ) : null}
          </svg>

          <div className="project-trend-legend">
            {points.slice(-8).map((point) => (
              <div
                key={`${title}-${point.label}-${point.display}`}
                onMouseEnter={(event) =>
                  tooltip?.onEnter(event, {
                    title: `${title} · ${point.label}`,
                    lines: [`值：${point.display}`, point.raw ? `运行：${point.raw}` : ""].filter(Boolean),
                    accent: "blue",
                  })
                }
                onMouseMove={tooltip?.onMove}
                onMouseLeave={tooltip?.onLeave}
              >
                <span>{point.label}</span>
                <strong>{point.display}</strong>
              </div>
            ))}
          </div>
        </>
      )}
    </article>
  );
}

function BenchmarkTrendMultiLineCard({
  title,
  subtitle,
  series,
  unit,
  className,
  tooltip,
}: {
  title: string;
  subtitle: string;
  series: BenchmarkSuiteTrendSeries[];
  unit: string;
  className?: string;
  tooltip?: TooltipHandlers;
}) {
  const width = 640;
  const height = 220;
  const padX = 34;
  const padY = 22;
  const chartWidth = width - padX * 2;
  const chartHeight = height - padY * 2;
  const maxRuns = series.reduce((max, item) => Math.max(max, item.runs.length), 0);
  const palette = [
    "var(--chart-blue-end)",
    "var(--chart-blue-mid)",
    "var(--chart-blue-start)",
    "var(--chart-violet-end)",
    "var(--chart-amber-end)",
    "var(--chart-violet-start)",
  ];

  const valueToY = (value: number) => padY + (1 - clamp(value, 0, 100) / 100) * chartHeight;

  const geometries = series.map((item, index) => {
    const color = palette[index % palette.length];
    const offset = Math.max(0, maxRuns - item.runs.length);
    const points = item.runs.map((run, runIndex) => {
      const normalizedIndex = offset + runIndex;
      const x = maxRuns <= 1 ? width / 2 : padX + (normalizedIndex / (maxRuns - 1)) * chartWidth;
      const y = valueToY(run.value);
      return { x, y, run };
    });
    const line =
      points.length < 2
        ? points.length === 1
          ? `M ${points[0].x} ${points[0].y}`
          : ""
        : buildSmoothPath(points.map((point) => ({ x: point.x, y: point.y })));
    return {
      ...item,
      color,
      points,
      line,
      latestPoint: points[points.length - 1],
    };
  });

  return (
    <article className={cn("project-report-card project-chart-card", className)}>
      <header className="project-card-header">
        <div>
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </div>
        <div className="project-card-actions">
          <span
            className="project-card-badge"
            onMouseEnter={(event) =>
              tooltip?.onEnter(event, {
                title: `${title} / ${unit}`,
                lines: [`Suite 数：${series.length}`, "每个 Suite 显示最近 8 次运行分数"],
                accent: "green",
              })
            }
            onMouseMove={tooltip?.onMove}
            onMouseLeave={tooltip?.onLeave}
          >
            {unit}
          </span>
        </div>
      </header>

      {geometries.length === 0 ? (
        <div className="project-empty">暂无趋势数据</div>
      ) : (
        <>
          <svg viewBox={`0 0 ${width} ${height}`} className="project-trend-svg" role="img" aria-label={title}>
            {[0, 1, 2, 3, 4].map((tick) => {
              const y = padY + (tick / 4) * chartHeight;
              return <line key={`multi-grid-${tick}`} x1={padX} y1={y} x2={width - padX} y2={y} className="project-grid-line" />;
            })}

            {geometries.map((item, seriesIndex) => (
              <g key={`suite-line-${item.suiteId}`}>
                <path
                  d={item.line}
                  stroke={item.color}
                  strokeWidth={2.5}
                  fill="none"
                  strokeLinecap="round"
                  className="project-trend-line project-multi-trend-line"
                  style={{ animationDelay: `${seriesIndex * 80}ms` }}
                  onMouseEnter={(event) =>
                    tooltip?.onEnter(event, {
                      title: `${item.suiteName} 趋势`,
                      lines: [`最近 ${item.runs.length} 次`, `最新：Run #${item.latestRunId} · ${item.latestDisplay}`],
                      accent: "green",
                    })
                  }
                  onMouseMove={tooltip?.onMove}
                  onMouseLeave={tooltip?.onLeave}
                />
                {item.points.map((point, pointIndex) => (
                  <circle
                    key={`suite-dot-${item.suiteId}-${point.run.runId}-${pointIndex}`}
                    cx={point.x}
                    cy={point.y}
                    r={3}
                    fill="var(--app-surface)"
                    stroke={item.color}
                    strokeWidth={1.8}
                    className="project-trend-dot"
                    style={{ animationDelay: `${pointIndex * 70}ms` }}
                    onMouseEnter={(event) =>
                      tooltip?.onEnter(event, {
                        title: `${item.suiteName} · Run #${point.run.runId}`,
                        lines: [`分数：${point.run.display}`, point.run.status ? `状态：${point.run.status}` : ""].filter(Boolean),
                        accent: "green",
                      })
                    }
                    onMouseMove={tooltip?.onMove}
                    onMouseLeave={tooltip?.onLeave}
                  >
                    <title>{`${item.suiteName} / Run #${point.run.runId} / ${point.run.display}`}</title>
                  </circle>
                ))}
                {item.latestPoint ? (
                  <circle
                    cx={item.latestPoint.x}
                    cy={item.latestPoint.y}
                    r={6}
                    fill="none"
                    stroke={item.color}
                    strokeWidth={1.8}
                    className="project-trend-focus"
                  />
                ) : null}
              </g>
            ))}
          </svg>

          <div className="project-trend-legend project-trend-suite-legend">
            {geometries.map((item) => (
              <div
                key={`suite-legend-${item.suiteId}`}
                onMouseEnter={(event) =>
                  tooltip?.onEnter(event, {
                    title: item.suiteName,
                    lines: [`最新：Run #${item.latestRunId} · ${item.latestDisplay}`, `已展示 ${item.runs.length} 次`],
                    accent: "green",
                  })
                }
                onMouseMove={tooltip?.onMove}
                onMouseLeave={tooltip?.onLeave}
              >
                <span className="project-suite-trend-label">
                  <i style={{ background: item.color }} />
                  {item.suiteName}
                </span>
                <strong>{item.latestDisplay}</strong>
                <small>{`最近 ${item.runs.length} 次 · Run #${item.latestRunId}`}</small>
              </div>
            ))}
          </div>
        </>
      )}
    </article>
  );
}

function RunMixCard({
  apiRuns,
  benchmarkRuns,
  totalRuns,
  className,
  tooltip,
}: {
  apiRuns: number;
  benchmarkRuns: number;
  totalRuns: number;
  className?: string;
  tooltip?: TooltipHandlers;
}) {
  const otherRuns = Math.max(0, totalRuns - apiRuns - benchmarkRuns);
  const segments = [
    {
      label: "API",
      value: apiRuns,
      start: "var(--chart-green-start)",
      end: "var(--chart-green-end)",
    },
    {
      label: "Benchmark",
      value: benchmarkRuns,
      start: "var(--chart-blue-start)",
      end: "var(--chart-blue-end)",
    },
    {
      label: "Others",
      value: otherRuns,
      start: "var(--chart-violet-start)",
      end: "var(--chart-violet-end)",
    },
  ].filter((item) => item.value > 0);

  const total = segments.reduce((sum, item) => sum + item.value, 0);
  const radius = 56;
  const circumference = 2 * Math.PI * radius;

  let offset = 0;

  return (
    <article className={cn("project-report-card project-compact-card", className)}>
      <header className="project-card-header">
        <div>
          <h3>运行结构</h3>
          <p>按运行类型统计</p>
        </div>
      </header>

      {total === 0 ? (
        <div className="project-empty">暂无运行数据</div>
      ) : (
        <div className="project-donut-layout">
          <svg viewBox="0 0 180 180" className="project-donut-svg" role="img" aria-label="运行结构图">
            <defs>
              {segments.map((segment, index) => (
                <linearGradient
                  id={`run-mix-${index}`}
                  key={`run-mix-gradient-${segment.label}`}
                  x1="0%"
                  y1="0%"
                  x2="100%"
                  y2="100%"
                >
                  <stop offset="0%" stopColor={segment.start} />
                  <stop offset="100%" stopColor={segment.end} />
                </linearGradient>
              ))}
            </defs>
            <g transform="rotate(-90 90 90)">
              <circle cx="90" cy="90" r={radius} fill="none" stroke="var(--chart-track)" strokeWidth="20" />
              {segments.map((segment, index) => {
                const share = (segment.value / total) * circumference;
                const node = (
                  <circle
                    key={segment.label}
                    cx="90"
                    cy="90"
                    r={radius}
                    fill="none"
                    stroke={`url(#run-mix-${index})`}
                    strokeWidth="20"
                    strokeDasharray={`${share} ${circumference}`}
                    strokeDashoffset={-offset}
                    strokeLinecap="round"
                    onMouseEnter={(event) =>
                      tooltip?.onEnter(event, {
                        title: `运行结构 · ${segment.label}`,
                        lines: [`数量：${segment.value}`, `占比：${((segment.value / total) * 100).toFixed(1)}%`],
                        accent: "green",
                      })
                    }
                    onMouseMove={tooltip?.onMove}
                    onMouseLeave={tooltip?.onLeave}
                  >
                    <title>{`${segment.label}: ${segment.value} (${((segment.value / total) * 100).toFixed(1)}%)`}</title>
                  </circle>
                );
                offset += share;
                return node;
              })}
            </g>
            <text x="90" y="86" textAnchor="middle" className="project-donut-total">
              {total}
            </text>
            <text x="90" y="106" textAnchor="middle" className="project-donut-caption">
              runs
            </text>
          </svg>

          <div className="project-donut-legend">
            {segments.map((segment) => {
              const ratio = total > 0 ? (segment.value / total) * 100 : 0;
              return (
                <div
                  key={segment.label}
                  onMouseEnter={(event) =>
                    tooltip?.onEnter(event, {
                      title: `运行结构 · ${segment.label}`,
                      lines: [`数量：${segment.value} 次`, `占比：${ratio.toFixed(1)}%`],
                      accent: "green",
                    })
                  }
                  onMouseMove={tooltip?.onMove}
                  onMouseLeave={tooltip?.onLeave}
                >
                  <span>
                    <i style={{ background: `linear-gradient(135deg, ${segment.start}, ${segment.end})` }} />
                    {segment.label}
                  </span>
                  <strong>
                    {segment.value} ({ratio.toFixed(1)}%)
                  </strong>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </article>
  );
}

function FailureDistributionCard({
  items,
  className,
  tooltip,
}: {
  items: Array<{ name: string; value: number }>;
  className?: string;
  tooltip?: TooltipHandlers;
}) {
  const topItems = items.slice(0, 6).filter((item) => item.value > 0);
  const total = topItems.reduce((sum, item) => sum + item.value, 0);
  const dominant = topItems.length > 0 ? [...topItems].sort((a, b) => b.value - a.value)[0] : null;
  const dominantRatio = dominant && total > 0 ? (dominant.value / total) * 100 : 0;
  const colors = [
    ["var(--chart-blue-start)", "var(--chart-blue-end)"],
    ["var(--chart-blue-mid)", "var(--chart-blue-end)"],
    ["var(--chart-violet-start)", "var(--chart-violet-end)"],
    ["var(--chart-blue-start)", "var(--chart-violet-end)"],
    ["var(--chart-amber-start)", "var(--chart-amber-end)"],
    ["var(--chart-blue-start)", "var(--chart-blue-mid)"],
  ];
  const segments = topItems.map((item, index) => ({
    ...item,
    start: colors[index % colors.length][0],
    end: colors[index % colors.length][1],
    ratio: total > 0 ? item.value / total : 0,
  }));

  const radius = 62;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <article className={cn("project-report-card project-compact-card project-failure-card", className)}>
      <header className="project-card-header">
        <div>
          <h3>失败分布</h3>
          <p>高频失败类型 Top 6</p>
        </div>
      </header>

      {topItems.length === 0 ? (
        <div className="project-empty">暂无失败分布</div>
      ) : (
        <div className="project-distribution-layout">
          <div className="project-distribution-viz">
            <div className="project-failure-donut-shell">
              <svg viewBox="0 0 180 180" className="project-failure-donut-svg" role="img" aria-label="失败分布占比图">
                <defs>
                  {segments.map((segment, index) => (
                    <linearGradient
                      id={`failure-segment-${index}`}
                      key={`failure-gradient-${segment.name}-${index}`}
                      x1="0%"
                      y1="0%"
                      x2="100%"
                      y2="100%"
                    >
                      <stop offset="0%" stopColor={segment.start} />
                      <stop offset="100%" stopColor={segment.end} />
                    </linearGradient>
                  ))}
                </defs>
                <g transform="rotate(-90 90 90)">
                  <circle cx="90" cy="90" r={radius} fill="none" stroke="var(--chart-track)" strokeWidth="16" />
                  {segments.map((segment, index) => {
                    const share = Math.max(0, segment.ratio * circumference);
                    const node = (
                      <circle
                        key={`${segment.name}-${index}`}
                        cx="90"
                        cy="90"
                        r={radius}
                        fill="none"
                        stroke={`url(#failure-segment-${index})`}
                        strokeWidth="16"
                        strokeDasharray={`${share} ${circumference}`}
                        strokeDashoffset={-offset}
                        strokeLinecap="round"
                        className="project-failure-donut-segment"
                        style={{ animationDelay: `${index * 80}ms` }}
                        onMouseEnter={(event) =>
                          tooltip?.onEnter(event, {
                            title: `失败分布 · ${segment.name}`,
                            lines: [`次数：${segment.value}`, `占比：${(segment.ratio * 100).toFixed(1)}%`],
                            accent: "pink",
                          })
                        }
                        onMouseMove={tooltip?.onMove}
                        onMouseLeave={tooltip?.onLeave}
                      >
                        <title>{`${segment.name}: ${segment.value} (${(segment.ratio * 100).toFixed(1)}%)`}</title>
                      </circle>
                    );
                    offset += share;
                    return node;
                  })}
                </g>
              </svg>
              <div className="project-failure-donut-center">
                <strong>{total}</strong>
                <span>samples</span>
              </div>
            </div>
          </div>

          <div className="project-distribution-summary">
            <div className="project-distribution-summary-row">
              <span>失败样本总数</span>
              <strong>{total}</strong>
            </div>
            <div
              className="project-distribution-summary-row"
              onMouseEnter={(event) =>
                tooltip?.onEnter(event, {
                  title: "主失败类型",
                  lines: dominant
                    ? [`${dominant.name}：${dominant.value} 次`, `占比：${dominantRatio.toFixed(1)}%`]
                    : ["暂无数据"],
                  accent: "pink",
                })
              }
              onMouseMove={tooltip?.onMove}
              onMouseLeave={tooltip?.onLeave}
            >
              <span>主失败类型</span>
              <strong>{dominant ? `${dominant.name} (${dominantRatio.toFixed(1)}%)` : "-"}</strong>
            </div>
          </div>
        </div>
      )}
    </article>
  );
}

function LatestBenchmarkCard({
  suiteName,
  runId,
  runScore,
  loading,
  items,
  className,
  tooltip,
}: {
  suiteName?: string;
  runId: number | null;
  runScore: number | null;
  loading: boolean;
  items: DimensionMetric[];
  className?: string;
  tooltip?: TooltipHandlers;
}) {
  const topItems = [...items].slice(0, 6);
  const cx = 150;
  const cy = 124;
  const radius = 84;

  return (
    <article className={cn("project-report-card project-compact-card", className)}>
      <header className="project-card-header">
        <div>
          <h3>Benchmark 维度</h3>
          <p>
            {runId
              ? `${suiteName ? `${suiteName} · ` : ""}最新运行 Run #${runId}${runScore !== null ? ` · Score ${runScore.toFixed(3)}` : ""}`
              : "暂无 Benchmark 运行"}
          </p>
        </div>
      </header>

      {loading ? (
        <div className="project-empty">加载最新 Benchmark 维度中...</div>
      ) : topItems.length < 3 ? (
        <div className="project-empty">最新运行维度不足，无法绘制雷达图</div>
      ) : (
        <div className="project-radar-layout">
          <svg viewBox="0 0 300 252" className="project-radar-svg" role="img" aria-label="最新 Benchmark 维度雷达图">
            <defs>
              <linearGradient id="latest-benchmark-radar-fill" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="var(--chart-green-start)" stopOpacity="0.28" />
                <stop offset="100%" stopColor="var(--chart-blue-mid)" stopOpacity="0.14" />
              </linearGradient>
            </defs>
            {[0.25, 0.5, 0.75, 1].map((level, levelIndex) => (
              <polygon
                key={`latest-radar-grid-${level}`}
                points={buildRadarPolygon(topItems, level, radius, cx, cy)}
                fill={levelIndex % 2 === 0 ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.05)"}
                stroke="var(--chart-grid)"
                strokeWidth="1"
              />
            ))}

            {topItems.map((item, index) => {
              const angle = -Math.PI / 2 + (index * 2 * Math.PI) / topItems.length;
              const x = cx + Math.cos(angle) * radius;
              const y = cy + Math.sin(angle) * radius;
              const valueX = cx + Math.cos(angle) * (radius * (item.value / 100));
              const valueY = cy + Math.sin(angle) * (radius * (item.value / 100));
              const labelX = cx + Math.cos(angle) * (radius + 24);
              const labelY = cy + Math.sin(angle) * (radius + 18);

              return (
                <g key={`axis-${item.name}`}>
                  <line x1={cx} y1={cy} x2={x} y2={y} stroke="var(--chart-grid)" strokeWidth="1" />
                  <circle
                    cx={valueX}
                    cy={valueY}
                    r={3}
                    fill="var(--app-surface)"
                    stroke="var(--chart-green-end)"
                    strokeWidth={2}
                    className="project-radar-dot"
                    onMouseEnter={(event) =>
                      tooltip?.onEnter(event, {
                        title: `最新 Benchmark · ${item.name}`,
                        lines: [`分数：${(item.value / 100).toFixed(3)}`, `采样：${item.sampleCount}`],
                        accent: "green",
                      })
                    }
                    onMouseMove={tooltip?.onMove}
                    onMouseLeave={tooltip?.onLeave}
                  >
                    <title>{`${item.name}: ${(item.value / 100).toFixed(3)}（${item.value.toFixed(1)}分）`}</title>
                  </circle>
                  <text x={labelX} y={labelY} textAnchor="middle" className="project-radar-label">
                    {item.name}
                  </text>
                </g>
              );
            })}

            <polygon
              points={buildRadarPolygon(topItems, 1, radius, cx, cy)}
              fill="url(#latest-benchmark-radar-fill)"
              stroke="var(--chart-green-mid)"
              strokeWidth="2"
              className="project-radar-surface"
            />
          </svg>
        </div>
      )}
    </article>
  );
}

export function ProjectDashboardPage() {
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const pageRef = useRef<HTMLElement | null>(null);
  const isCaptureMode = location.pathname === "/reports/project-capture";

  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(() => parseMaybeNumber(searchParams.get("projectId")));
  const [timeRange, setTimeRange] = useState<TimeRange>(() => {
    const value = searchParams.get("timeRange");
    return value === "7d" || value === "30d" || value === "all" ? value : "7d";
  });
  const [typeFilter, setTypeFilter] = useState<ReportTypeFilter>(() => {
    const value = searchParams.get("type");
    return value === "all" || value === "api" || value === "benchmark" ? value : "all";
  });
  const [environment, setEnvironment] = useState<string>(() => searchParams.get("environment") ?? "all");
  const [model, setModel] = useState<string>(() => searchParams.get("model") ?? "all");

  const [dashboard, setDashboard] = useState<DashboardV1Response | null>(null);
  const [apiProjectSeries, setApiProjectSeries] = useState<BenchmarkSuiteTrendSeries[]>([]);
  const [benchmarkProjectSeries, setBenchmarkProjectSeries] = useState<BenchmarkSuiteTrendSeries[]>([]);
  const [apiSuiteSeries, setApiSuiteSeries] = useState<BenchmarkSuiteTrendSeries[]>([]);
  const [benchmarkPanelLoading, setBenchmarkPanelLoading] = useState(false);
  const [benchmarkSuiteSeries, setBenchmarkSuiteSeries] = useState<BenchmarkSuiteTrendSeries[]>([]);
  const [latestBenchmarkSuiteName, setLatestBenchmarkSuiteName] = useState<string | undefined>(undefined);
  const [latestBenchmarkRunId, setLatestBenchmarkRunId] = useState<number | null>(null);
  const [latestBenchmarkRunScore, setLatestBenchmarkRunScore] = useState<number | null>(null);
  const [latestBenchmarkDimensions, setLatestBenchmarkDimensions] = useState<DimensionMetric[]>([]);
  const [latestBenchmarkLoading, setLatestBenchmarkLoading] = useState(false);

  const [loading, setLoading] = useState(false);
  const [exportingImage, setExportingImage] = useState(false);
  const [exportingMarkdown, setExportingMarkdown] = useState(false);
  const [notice, setNotice] = useState<{ tone: NoticeTone; text: string } | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  const apiTrend = dashboard?.trends.apiPassRate ?? [];
  const benchmarkTrend = dashboard?.trends.benchmarkScore ?? [];
  const failureDistribution = dashboard?.distributions.failure ?? [];

  const apiTrendPoints = useMemo<TrendPoint[]>(
    () =>
      apiTrend.slice(-10).map((point) => ({
        label: formatTrendLabel(point.createdAt, point.runId),
        value: clamp(point.value, 0, 100),
        display: fmtPercent(point.value),
        raw: `Run #${point.runId}`,
      })),
    [apiTrend]
  );

  const projectBenchmarkTrendPoints = useMemo<TrendPoint[]>(
    () =>
      benchmarkTrend.slice(-10).map((point) => ({
        label: formatTrendLabel(point.createdAt, point.runId),
        value: clamp(scoreToPercent(point.value), 0, 100),
        display: fmtScore(point.value),
        raw: `Run #${point.runId}`,
      })),
    [benchmarkTrend]
  );

  const benchmarkTrendSubtitle = useMemo(() => {
    if (selectedProjectId) {
      if (benchmarkPanelLoading) {
        return "正在加载最近运行的 Suite Benchmark 数据...";
      }
      if (benchmarkSuiteSeries.length <= 0) {
        return "当前项目暂无可用 Benchmark 数据";
      }
      return `${benchmarkSuiteSeries.length} 个 Suite（每个 Suite 展示最近 8 次 Benchmark 运行分数）`;
    }
    if (benchmarkPanelLoading) {
      return "正在加载各项目最近 Benchmark 运行趋势...";
    }
    if (benchmarkProjectSeries.length <= 0) {
      return "当前筛选范围暂无可用 Benchmark 数据";
    }
    return `${benchmarkProjectSeries.length} 个项目（每个项目展示最近 10 次 Benchmark 运行分数）`;
  }, [benchmarkPanelLoading, benchmarkProjectSeries.length, benchmarkSuiteSeries.length, selectedProjectId]);
  const apiTrendSubtitle = useMemo(() => {
    if (selectedProjectId) {
      if (benchmarkPanelLoading) {
        return "正在加载各 Suite 最近 API 运行趋势...";
      }
      if (apiSuiteSeries.length <= 0) {
        return "当前项目暂无可用 API 数据";
      }
      return `${apiSuiteSeries.length} 个 Suite（每个 Suite 展示最近 10 次 API 运行通过率）`;
    }
    if (benchmarkPanelLoading) {
      return "正在加载各项目最近 API 运行趋势...";
    }
    if (apiProjectSeries.length <= 0) {
      return "当前筛选范围暂无可用 API 数据";
    }
    return `${apiProjectSeries.length} 个项目（最多展示最近 ${PROJECT_API_TREND_PROJECT_LIMIT} 个项目，每个项目展示最近 10 次 API 运行通过率）`;
  }, [apiProjectSeries.length, apiSuiteSeries.length, benchmarkPanelLoading, selectedProjectId]);

  const apiDelta = useMemo(() => calculateDelta(apiTrendPoints.map((point) => point.value)), [apiTrendPoints]);
  const benchmarkDelta = useMemo(
    () => calculateDelta(projectBenchmarkTrendPoints.map((point) => point.value)),
    [projectBenchmarkTrendPoints]
  );

  const kpiCards = useMemo<KpiCardItem[]>(() => {
    const kpis = dashboard?.kpis;
    const runCount = kpis?.runCount ?? 0;
    return [
      {
        label: "总通过率",
        value: fmtPercent(kpis?.avgPassRate ?? 0),
        hint: "整体质量",
        icon: ShieldCheck,
        delta: apiDelta,
        deltaUnit: "pp",
        betterDirection: "up",
        detail: `当前筛选范围内共 ${runCount} 次运行，总通过率 ${(kpis?.avgPassRate ?? 0).toFixed(2)}%。`,
      },
      {
        label: "运行次数",
        value: String(runCount),
        hint: "当前筛选范围",
        icon: Layers3,
        delta: null,
        deltaUnit: "%",
        betterDirection: "up",
        detail: `时间范围 ${timeRange}，类型 ${typeFilter}，运行总数 ${runCount}。`,
      },
      {
        label: "平均分",
        value: fmtScore(kpis?.avgScore ?? 0),
        hint: "Benchmark",
        icon: Sparkles,
        delta: benchmarkDelta,
        deltaUnit: "pp",
        betterDirection: "up",
        detail: `Benchmark 平均分 ${(kpis?.avgScore ?? 0).toFixed(4)}。`,
      },
      {
        label: "API 成功率",
        value: fmtPercent(kpis?.apiSuccessRate ?? 0),
        hint: "API 维度",
        icon: Cpu,
        delta: apiDelta,
        deltaUnit: "pp",
        betterDirection: "up",
        detail: `API 成功率 ${(kpis?.apiSuccessRate ?? 0).toFixed(2)}%，最近趋势 ${formatTrendValue(apiDelta, "pp")}.`,
      },
      {
        label: "错误率",
        value: fmtPercent(kpis?.failRate ?? 0),
        hint: "越低越好",
        icon: AlertTriangle,
        delta: apiDelta === null ? null : -apiDelta,
        deltaUnit: "pp",
        betterDirection: "down",
        detail: `错误率 ${(kpis?.failRate ?? 0).toFixed(2)}%。`,
      },
      {
        label: "P95 延迟",
        value: `${Math.round(kpis?.p95LatencyMs ?? 0)}ms`,
        hint: "性能指标",
        icon: Clock3,
        delta: null,
        deltaUnit: "ms",
        betterDirection: "down",
        detail: `当前 P95 延迟约 ${Math.round(kpis?.p95LatencyMs ?? 0)}ms。`,
      },
      {
        label: "成本估算",
        value: `¥${(kpis?.totalCost ?? 0).toFixed(1)}`,
        hint: "累计成本",
        icon: CircleDollarSign,
        delta: null,
        deltaUnit: "¥",
        betterDirection: "down",
        detail: `当前筛选数据的估算成本为 ¥${(kpis?.totalCost ?? 0).toFixed(2)}。`,
      },
      {
        label: "项目数",
        value: String(kpis?.projectCount ?? 0),
        hint: "当前项目群",
        icon: Activity,
        delta: null,
        deltaUnit: "%",
        betterDirection: "up",
        detail: `当前报告聚焦项目数量 ${kpis?.projectCount ?? 0}。`,
      },
    ];
  }, [dashboard, apiDelta, benchmarkDelta, timeRange, typeFilter]);

  const insightItems = useMemo<InsightItem[]>(() => {
    if (!dashboard) {
      return [
        {
          title: "等待数据",
          content: "正在加载当前筛选范围的质量洞察。",
          level: "neutral",
        },
      ];
    }

    const list: InsightItem[] = [];
    const failTop = failureDistribution[0];

    if (dashboard.kpis.avgPassRate < 70) {
      list.push({
        title: "通过率偏低",
        content: `当前总体通过率为 ${fmtPercent(dashboard.kpis.avgPassRate)}，建议优先处理失败占比高的类型。`,
        level: "risk",
      });
    } else {
      list.push({
        title: "整体稳定",
        content: `当前总体通过率达到 ${fmtPercent(dashboard.kpis.avgPassRate)}，核心流程保持稳定。`,
        level: "good",
      });
    }

    if (failTop) {
      list.push({
        title: "首要失败来源",
        content: `${failTop.name} 失败 ${failTop.value} 次，占当前失败样本的主要部分。`,
        level: "risk",
      });
    }

    if (benchmarkDelta !== null) {
      list.push({
        title: benchmarkDelta >= 0 ? "Benchmark 上升" : "Benchmark 下滑",
        content:
          benchmarkDelta >= 0
            ? `最近阶段 benchmark 指标提升 ${benchmarkDelta.toFixed(1)}pp。`
            : `最近阶段 benchmark 指标下降 ${Math.abs(benchmarkDelta).toFixed(1)}pp，建议回看模型和评测样本。`,
        level: benchmarkDelta >= 0 ? "good" : "risk",
      });
    }

    const downSuites = dashboard.suites.filter((suite) => suite.trend === "down").length;
    list.push({
      title: "Suite 趋势概览",
      content: `共 ${dashboard.suites.length} 个 suite，下降 ${downSuites} 个，上升 ${dashboard.suites.filter((suite) => suite.trend === "up").length} 个。`,
      level: downSuites > 0 ? "neutral" : "good",
    });

    return list.slice(0, 4);
  }, [dashboard, failureDistribution, benchmarkDelta]);

  const sortedSuites = useMemo(
    () => [...(dashboard?.suites ?? [])].sort((a, b) => b.passRate - a.passRate),
    [dashboard?.suites]
  );
  const sortedProjects = useMemo(
    () => [...(dashboard?.projects ?? [])].sort((a, b) => b.apiSuccessRate - a.apiSuccessRate || b.runCount - a.runCount),
    [dashboard?.projects]
  );
  const activeApiSeries = selectedProjectId ? apiSuiteSeries : apiProjectSeries;
  const activeBenchmarkSeries = selectedProjectId ? benchmarkSuiteSeries : benchmarkProjectSeries;
  const hasApiChartData = activeApiSeries.length > 0;
  const hasBenchmarkChartData = activeBenchmarkSeries.length > 0;
  const showApiCharts = typeFilter !== "benchmark" && (benchmarkPanelLoading || hasApiChartData);
  const showBenchmarkCharts = typeFilter !== "api" && (benchmarkPanelLoading || hasBenchmarkChartData);
  const showFailureDistribution = showApiCharts;
  const showLatestBenchmarkCard = Boolean(selectedProjectId) && showBenchmarkCharts;

  const resolveTooltipPosition = useCallback((clientX: number, clientY: number) => {
    if (typeof window === "undefined") {
      return { x: clientX + 14, y: clientY + 14 };
    }
    const width = 250;
    const height = 100;
    const offset = 14;
    const x = clamp(clientX + offset, 8, window.innerWidth - width - 8);
    const y = clamp(clientY + offset, 8, window.innerHeight - height - 8);
    return { x, y };
  }, []);

  const onTooltipEnter = useCallback(
    (event: ReactMouseEvent<HTMLElement | SVGElement>, payload: TooltipPayload) => {
      const position = resolveTooltipPosition(event.clientX, event.clientY);
      setTooltip({ ...payload, x: position.x, y: position.y });
    },
    [resolveTooltipPosition]
  );

  const onTooltipMove = useCallback(
    (event: ReactMouseEvent<HTMLElement | SVGElement>) => {
      setTooltip((previous) => {
        if (!previous) {
          return previous;
        }
        const position = resolveTooltipPosition(event.clientX, event.clientY);
        return { ...previous, x: position.x, y: position.y };
      });
    },
    [resolveTooltipPosition]
  );

  const onTooltipLeave = useCallback(() => {
    setTooltip(null);
  }, []);

  const tooltipHandlers = useMemo<TooltipHandlers>(
    () => ({
      onEnter: onTooltipEnter,
      onMove: onTooltipMove,
      onLeave: onTooltipLeave,
    }),
    [onTooltipEnter, onTooltipMove, onTooltipLeave]
  );

  async function refreshCatalog(preferredProjectId?: number | null) {
    const projectItems = await listProjects();
    setProjects(projectItems);
    const nextProjectId = preferredProjectId && projectItems.some((item) => item.id === preferredProjectId) ? preferredProjectId : null;
    setSelectedProjectId(nextProjectId);
    return nextProjectId;
  }

  function resetBenchmarkPanels() {
    setApiProjectSeries([]);
    setBenchmarkProjectSeries([]);
    setApiSuiteSeries([]);
    setBenchmarkSuiteSeries([]);
    setLatestBenchmarkSuiteName(undefined);
    setLatestBenchmarkRunId(null);
    setLatestBenchmarkRunScore(null);
    setLatestBenchmarkDimensions([]);
    setLatestBenchmarkLoading(false);
  }

  async function refreshDashboard(projectId: number | null) {
    const data = await getDashboardV1({
      projectId,
      timeRange,
      type: typeFilter,
      environment,
      model,
    });
    setDashboard(data);
  }

  async function refreshAll() {
    setLoading(true);
    try {
      const nextProjectId = await refreshCatalog(selectedProjectId);
      await refreshDashboard(nextProjectId);
      setNotice(null);
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "加载项目看板失败",
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setLoading(true);
    void refreshDashboard(selectedProjectId)
      .then(() => setNotice(null))
      .catch((error: unknown) =>
        setNotice({
          tone: "error",
          text: error instanceof Error ? error.message : "刷新项目看板失败",
        })
      )
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId, timeRange, typeFilter, environment, model]);

  useEffect(() => {
    if (!dashboard) {
      setBenchmarkPanelLoading(false);
      resetBenchmarkPanels();
      return;
    }

    let cancelled = false;
    setBenchmarkPanelLoading(true);

    if (selectedProjectId) {
      setApiProjectSeries([]);
      setBenchmarkProjectSeries([]);
      setLatestBenchmarkLoading(true);

      void (async () => {
        if (dashboard.suites.length === 0) {
          setApiSuiteSeries([]);
          setBenchmarkSuiteSeries([]);
          setLatestBenchmarkSuiteName(undefined);
          setLatestBenchmarkRunId(null);
          setLatestBenchmarkRunScore(null);
          setLatestBenchmarkDimensions([]);
          return;
        }

        const candidates = await Promise.allSettled(
          dashboard.suites.map(async (suite) => {
            const suiteReport = await getSuiteAnalyticsReport(suite.suiteId);
            return {
              benchmark: buildSuiteBenchmarkSeries(suiteReport, suite.suiteName, 8),
              api: buildSuiteApiSeries(suiteReport, suite.suiteName, 10),
            };
          })
        );

        if (cancelled) {
          return;
        }

        const benchmarkSeries = candidates
          .map((item) => (item.status === "fulfilled" ? item.value.benchmark : null))
          .filter((series): series is BenchmarkSuiteTrendSeries => series !== null)
          .sort((a, b) => b.latestRunId - a.latestRunId);
        const apiSeries = candidates
          .map((item) => (item.status === "fulfilled" ? item.value.api : null))
          .filter((series): series is BenchmarkSuiteTrendSeries => series !== null)
          .sort((a, b) => b.latestRunId - a.latestRunId);

        setApiSuiteSeries(apiSeries);
        setBenchmarkSuiteSeries(benchmarkSeries);

        if (benchmarkSeries.length === 0) {
          setLatestBenchmarkSuiteName(undefined);
          setLatestBenchmarkRunId(null);
          setLatestBenchmarkRunScore(null);
          setLatestBenchmarkDimensions([]);
          return;
        }

        const latestSuiteSeries = benchmarkSeries[0];
        setLatestBenchmarkSuiteName(latestSuiteSeries.suiteName);
        setLatestBenchmarkRunId(latestSuiteSeries.latestRunId);
        setLatestBenchmarkRunScore(latestSuiteSeries.latestScore);

        try {
          const detail = await getRunDetailReport(latestSuiteSeries.latestRunId);
          if (cancelled) {
            return;
          }
          setLatestBenchmarkDimensions(extractLatestDimensionMetrics(detail));
        } catch {
          if (cancelled) {
            return;
          }
          setLatestBenchmarkDimensions([]);
        }
      })()
        .catch(() => {
          if (!cancelled) {
            setApiSuiteSeries([]);
            setBenchmarkSuiteSeries([]);
            setLatestBenchmarkSuiteName(undefined);
            setLatestBenchmarkRunId(null);
            setLatestBenchmarkRunScore(null);
            setLatestBenchmarkDimensions([]);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setBenchmarkPanelLoading(false);
            setLatestBenchmarkLoading(false);
          }
        });
    } else {
      setApiSuiteSeries([]);
      setBenchmarkSuiteSeries([]);
      setLatestBenchmarkSuiteName(undefined);
      setLatestBenchmarkRunId(null);
      setLatestBenchmarkRunScore(null);
      setLatestBenchmarkDimensions([]);
      setLatestBenchmarkLoading(false);

      void (async () => {
        const projectRows = dashboard.projects ?? [];
        if (projectRows.length === 0) {
          setApiProjectSeries([]);
          setBenchmarkProjectSeries([]);
          return;
        }

        const candidates = await Promise.allSettled(
          projectRows.map(async (project) => {
            const report = await getDashboardV1({
              projectId: project.projectId,
              timeRange,
              type: typeFilter,
              environment,
              model,
            });
            return {
              benchmark: buildProjectBenchmarkSeries(report, project.projectName, 10),
              api: buildProjectApiSeries(report, project.projectName, 10),
            };
          })
        );

        if (cancelled) {
          return;
        }

        const benchmarkSeries = candidates
          .map((item) => (item.status === "fulfilled" ? item.value.benchmark : null))
          .filter((series): series is BenchmarkSuiteTrendSeries => series !== null)
          .sort((a, b) => b.latestRunId - a.latestRunId);
        const apiSeries = candidates
          .map((item) => (item.status === "fulfilled" ? item.value.api : null))
          .filter((series): series is BenchmarkSuiteTrendSeries => series !== null)
          .sort((a, b) => b.latestRunId - a.latestRunId)
          .slice(0, PROJECT_API_TREND_PROJECT_LIMIT);

        setApiProjectSeries(apiSeries);
        setBenchmarkProjectSeries(benchmarkSeries);
      })()
        .catch(() => {
          if (!cancelled) {
            setApiProjectSeries([]);
            setBenchmarkProjectSeries([]);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setBenchmarkPanelLoading(false);
          }
        });
    }

    return () => {
      cancelled = true;
    };
  }, [dashboard, environment, model, selectedProjectId, timeRange, typeFilter]);

  useEffect(() => {
    const next = new URLSearchParams();
    if (selectedProjectId) {
      next.set("projectId", String(selectedProjectId));
    }
    next.set("timeRange", timeRange);
    next.set("type", typeFilter);
    next.set("environment", environment);
    next.set("model", model);
    setSearchParams(next, { replace: true });
  }, [selectedProjectId, timeRange, typeFilter, environment, model, setSearchParams]);

  useEffect(() => {
    const rootElement = document.documentElement;
    let frameId: number | null = null;
    let resizeObserver: ResizeObserver | null = null;

    const updateHeightMarker = () => {
      const pageElement = pageRef.current;
      if (!pageElement) {
        rootElement.removeAttribute("data-report-page-height");
        return;
      }
      const pageRect = pageElement.getBoundingClientRect();
      const pageTop = window.scrollY + pageRect.top;
      const contentAnchors = Array.from(pageElement.querySelectorAll<HTMLElement>(":scope > section, :scope > header")).filter((node) => {
        const style = window.getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden" || style.position === "fixed") {
          return false;
        }
        const rect = node.getBoundingClientRect();
        return rect.height > 0 && rect.width > 0;
      });
      const contentBottom = contentAnchors.reduce((maxBottom, node) => {
        const rect = node.getBoundingClientRect();
        return Math.max(maxBottom, window.scrollY + rect.bottom);
      }, pageTop);
      const contentHeight = Math.max(0, Math.ceil(contentBottom - pageTop));
      const viewportHeight = Math.max(0, Math.ceil(pageRect.height));
      const nextHeight = Math.max(900, isCaptureMode ? contentHeight + 24 : Math.max(contentHeight + 24, viewportHeight));
      rootElement.setAttribute("data-report-page-height", String(nextHeight));
    };

    const scheduleUpdate = () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        updateHeightMarker();
      });
    };

    updateHeightMarker();
    scheduleUpdate();
    const timerId = window.setInterval(updateHeightMarker, 800);
    window.addEventListener("resize", scheduleUpdate);
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => updateHeightMarker());
      if (pageRef.current) {
        resizeObserver.observe(pageRef.current);
      }
    }

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      window.clearInterval(timerId);
      window.removeEventListener("resize", scheduleUpdate);
      resizeObserver?.disconnect();
      rootElement.removeAttribute("data-report-page-height");
    };
  }, [dashboard, isCaptureMode, loading, benchmarkPanelLoading, selectedProjectId, timeRange, typeFilter, environment, model]);

  async function onExportPageImage() {
    const pageElement = pageRef.current;
    if (!pageElement) {
      setNotice({ tone: "error", text: "页面未准备就绪，暂时无法导出图片" });
      return;
    }
    setTooltip(null);
    setExportingImage(true);
    try {
      const fileName = buildExportFileName(
        "project-dashboard",
        [
          selectedProjectId ? `project-${selectedProjectId}` : "all-projects",
          `range-${timeRange}`,
          `type-${typeFilter}`,
          `env-${environment}`,
          `model-${model}`,
        ],
        "png"
      );
      await exportElementAsPng(pageElement, fileName);
      setNotice({ tone: "success", text: "项目看板整页图片导出成功" });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "导出项目看板图片失败",
      });
    } finally {
      setExportingImage(false);
    }
  }

  async function onExportMarkdown() {
    setExportingMarkdown(true);
    try {
      const result = await exportDashboardV1Markdown({
        projectId: selectedProjectId,
        timeRange,
        type: typeFilter,
        environment,
        model,
      });
      const fallbackName = buildExportFileName(
        "project-dashboard-report",
        [
          selectedProjectId ? `project-${selectedProjectId}` : "all-projects",
          `range-${timeRange}`,
          `type-${typeFilter}`,
          `env-${environment}`,
          `model-${model}`,
        ],
        "md"
      );
      downloadMarkdownFile(result.fileName || fallbackName, result.markdownContent);
      setNotice({
        tone: "success",
        text: result.summaryMode === "llm" ? "项目看板 MD 测试报告导出成功" : "项目看板 MD 报告已导出（模型不可用，已兜底）",
      });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "导出项目看板 MD 报告失败",
      });
    } finally {
      setExportingMarkdown(false);
    }
  }

  return (
    <section ref={pageRef} className={cn("reports-page project-dashboard-v2", isCaptureMode && "reports-page-capture")}>
      <FloatingNotice notice={notice} onClose={() => setNotice(null)} />

      <header className="grid gap-1">
        <h2 className="page-title m-0">项目报告</h2>
      </header>

      <section className="project-dashboard-toolbar">
        <select
          value={selectedProjectId ?? ""}
          onChange={(event) => setSelectedProjectId(event.target.value ? Number(event.target.value) : null)}
          aria-label="选择项目"
        >
          <option value="">全部项目</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>

        <select value={timeRange} onChange={(event) => setTimeRange(event.target.value as TimeRange)} aria-label="选择时间范围">
          <option value="7d">最近7天</option>
          <option value="30d">最近30天</option>
          <option value="all">全部</option>
        </select>

        <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as ReportTypeFilter)} aria-label="选择类型">
          <option value="all">全部类型</option>
          <option value="api">API</option>
          <option value="benchmark">Benchmark</option>
        </select>

        <select value={environment} onChange={(event) => setEnvironment(event.target.value)} aria-label="选择环境">
          <option value="all">全部环境</option>
          <option value="test">测试环境</option>
          <option value="prod">生产环境</option>
        </select>

        <select value={model} onChange={(event) => setModel(event.target.value)} aria-label="选择模型">
          <option value="all">全部模型</option>
          <option value="qwen-max">qwen-max</option>
          <option value="gpt-4o">gpt-4o</option>
        </select>

        <div className="project-toolbar-actions">
          <button type="button" onClick={() => void refreshAll()} disabled={loading} className="project-refresh-btn project-refresh-btn-ambient">
            <RefreshCw size={14} className={loading ? "spinning" : ""} />
            {loading ? "刷新中" : "刷新"}
          </button>
          <button
            type="button"
            onClick={() => void onExportPageImage()}
            disabled={loading || exportingImage}
            className="project-refresh-btn project-export-btn"
          >
            <Download size={14} className={exportingImage ? "spinning" : ""} />
            {exportingImage ? "导出中" : "导出整页图片"}
          </button>
          <button
            type="button"
            onClick={() => void onExportMarkdown()}
            disabled={loading || exportingMarkdown}
            className="project-refresh-btn project-export-btn"
          >
            <FileText size={14} className={exportingMarkdown ? "spinning" : ""} />
            {exportingMarkdown ? "生成中" : "导出MD测试报告"}
          </button>
        </div>
      </section>

      <section className="project-kpi-grid">
        {kpiCards.map((item) => {
          const Icon = item.icon;
          return (
            <article
              key={item.label}
              className="project-kpi-card"
              onMouseEnter={(event) =>
                tooltipHandlers.onEnter(event, {
                  title: item.label,
                  lines: [item.value, item.detail],
                  accent: "amber",
                })
              }
              onMouseMove={tooltipHandlers.onMove}
              onMouseLeave={tooltipHandlers.onLeave}
            >
              <header>
                <span className="project-kpi-icon">
                  <Icon size={16} />
                </span>
                <div>
                  <h3>{item.label}</h3>
                  <p>{item.hint}</p>
                </div>
              </header>
              <strong>{item.value}</strong>
              <KpiDeltaBadge value={item.delta} unit={item.deltaUnit} betterDirection={item.betterDirection} />
            </article>
          );
        })}
      </section>

      <section className="project-board-grid">
        {showApiCharts ? (
          <BenchmarkTrendMultiLineCard
            title="API 通过率趋势"
            subtitle={apiTrendSubtitle}
            series={activeApiSeries}
            unit="pass %"
            className={showFailureDistribution ? "project-span-8" : "project-span-12"}
            tooltip={tooltipHandlers}
          />
        ) : null}

        {showFailureDistribution ? <FailureDistributionCard items={failureDistribution} className="project-span-4" tooltip={tooltipHandlers} /> : null}

        {showBenchmarkCharts ? (
          <BenchmarkTrendMultiLineCard
            title="Benchmark 评分趋势"
            subtitle={benchmarkTrendSubtitle}
            series={activeBenchmarkSeries}
            unit="score"
            className={showLatestBenchmarkCard ? "project-span-8" : "project-span-12"}
            tooltip={tooltipHandlers}
          />
        ) : null}

        {showLatestBenchmarkCard ? (
          <LatestBenchmarkCard
            suiteName={latestBenchmarkSuiteName}
            runId={latestBenchmarkRunId}
            runScore={latestBenchmarkRunScore}
            loading={latestBenchmarkLoading}
            items={latestBenchmarkDimensions}
            className="project-span-4"
            tooltip={tooltipHandlers}
          />
        ) : null}

        {!showApiCharts && !showBenchmarkCharts ? <div className="project-empty project-span-12">当前筛选暂无可展示图表</div> : null}
      </section>

      <section className="project-board-grid project-board-secondary">
        <RunMixCard
          apiRuns={apiTrend.length}
          benchmarkRuns={benchmarkTrend.length}
          totalRuns={dashboard?.kpis.runCount ?? 0}
          className="project-span-4"
          tooltip={tooltipHandlers}
        />

        <article className="project-report-card project-insight-card project-span-8">
          <header className="project-card-header">
            <div>
              <h3>报告洞察</h3>
              <p>基于当前筛选自动生成</p>
            </div>
            <Gauge size={16} />
          </header>

          <div className="project-insight-list">
            {insightItems.map((item) => (
              <div
                key={item.title}
                className={`project-insight-item ${item.level}`}
                onMouseEnter={(event) =>
                  tooltipHandlers.onEnter(event, {
                    title: item.title,
                    lines: [item.content],
                    accent: item.level === "risk" ? "pink" : item.level === "good" ? "green" : "blue",
                  })
                }
                onMouseMove={tooltipHandlers.onMove}
                onMouseLeave={tooltipHandlers.onLeave}
              >
                <div>
                  <h4>{item.title}</h4>
                  <p>{item.content}</p>
                </div>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="project-report-card project-suite-card">
        <header className="project-card-header">
          <div>
            <h3>{selectedProjectId ? "Suite 表现排行" : "项目表现排行"}</h3>
            <p>{selectedProjectId ? "通过率、评分与趋势综合视图" : "全项目 API 成功率与质量视图"}</p>
          </div>
          <BarChart3 size={16} />
        </header>

        {selectedProjectId ? (
          sortedSuites.length === 0 ? (
            <div className="project-empty">暂无 Suite 数据</div>
          ) : (
            <div className="project-suite-table-wrap">
              <table className="project-suite-table">
                <thead>
                  <tr>
                    <th>Suite</th>
                    <th>Pass Rate</th>
                    <th>Avg Score</th>
                    <th>趋势</th>
                    <th>健康度</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedSuites.map((suite) => {
                    const health = suite.passRate >= 80 ? "healthy" : suite.passRate >= 60 ? "watch" : "risk";
                    const healthLabel = health === "healthy" ? "健康" : health === "watch" ? "关注" : "风险";
                    const trendClass = suite.trend === "up" ? "up" : suite.trend === "down" ? "down" : "flat";
                    const suiteProjectId = suite.projectId ?? selectedProjectId;
                    return (
                      <tr key={suite.suiteId}>
                        <td
                          onMouseEnter={(event) =>
                            tooltipHandlers.onEnter(event, {
                              title: suite.suiteName,
                              lines: [`Suite ID: ${suite.suiteId}`],
                              accent: "blue",
                            })
                          }
                          onMouseMove={tooltipHandlers.onMove}
                          onMouseLeave={tooltipHandlers.onLeave}
                        >
                          {suite.suiteName}
                        </td>
                        <td>
                          <div
                            className="project-progress-cell"
                            onMouseEnter={(event) =>
                              tooltipHandlers.onEnter(event, {
                                title: `${suite.suiteName} 通过率`,
                                lines: [`通过率：${fmtPercent(suite.passRate)}`],
                                accent: "green",
                              })
                            }
                            onMouseMove={tooltipHandlers.onMove}
                            onMouseLeave={tooltipHandlers.onLeave}
                          >
                            <span>{fmtPercent(suite.passRate)}</span>
                            <div className="project-progress-track">
                              <div className="project-progress-fill" style={{ width: `${clamp(suite.passRate, 0, 100)}%` }} />
                            </div>
                          </div>
                        </td>
                        <td>
                          <div
                            className="project-score-cell"
                            onMouseEnter={(event) =>
                              tooltipHandlers.onEnter(event, {
                                title: `${suite.suiteName} 平均分`,
                                lines: [`评分：${fmtScore(suite.avgScore)}`],
                                accent: "blue",
                              })
                            }
                            onMouseMove={tooltipHandlers.onMove}
                            onMouseLeave={tooltipHandlers.onLeave}
                          >
                            <span>{fmtScore(suite.avgScore)}</span>
                            <div
                              className="project-score-dot"
                              style={{ opacity: clamp(scoreToPercent(suite.avgScore ?? 0), 15, 100) / 100 }}
                            />
                          </div>
                        </td>
                        <td>
                          <span
                            className={`project-trend-badge ${trendClass}`}
                            onMouseEnter={(event) =>
                              tooltipHandlers.onEnter(event, {
                                title: `${suite.suiteName} 趋势`,
                                lines: [`趋势：${suite.trend}`],
                                accent: "blue",
                              })
                            }
                            onMouseMove={tooltipHandlers.onMove}
                            onMouseLeave={tooltipHandlers.onLeave}
                          >
                            {suite.trend === "up" ? (
                              <TrendingUp size={13} />
                            ) : suite.trend === "down" ? (
                              <TrendingDown size={13} />
                            ) : (
                              <Minus size={13} />
                            )}
                            {suite.trend}
                          </span>
                        </td>
                        <td>
                          <span
                            className={`project-health-badge ${health}`}
                            onMouseEnter={(event) =>
                              tooltipHandlers.onEnter(event, {
                                title: `${suite.suiteName} 健康度`,
                                lines: [`状态：${healthLabel}`],
                                accent: health === "risk" ? "pink" : health === "healthy" ? "green" : "amber",
                              })
                            }
                            onMouseMove={tooltipHandlers.onMove}
                            onMouseLeave={tooltipHandlers.onLeave}
                          >
                            {healthLabel}
                          </span>
                        </td>
                        <td>
                          <Link to={`/reports/suite?projectId=${suiteProjectId}&suiteId=${suite.suiteId}`} className="project-suite-link">
                            查看 Suite 分析
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        ) : sortedProjects.length === 0 ? (
          <div className="project-empty">暂无项目运行数据</div>
        ) : (
          <div className="project-suite-table-wrap">
            <table className="project-suite-table">
              <thead>
                <tr>
                  <th>项目</th>
                  <th>API 成功率</th>
                  <th>总通过率</th>
                  <th>Avg Score</th>
                  <th>运行次数</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {sortedProjects.map((project) => {
                  return (
                    <tr key={project.projectId}>
                      <td
                        onMouseEnter={(event) =>
                          tooltipHandlers.onEnter(event, {
                            title: project.projectName,
                            lines: [`项目 ID: ${project.projectId}`],
                            accent: "blue",
                          })
                        }
                        onMouseMove={tooltipHandlers.onMove}
                        onMouseLeave={tooltipHandlers.onLeave}
                      >
                        {project.projectName}
                      </td>
                      <td>
                        <div
                          className="project-progress-cell"
                          onMouseEnter={(event) =>
                            tooltipHandlers.onEnter(event, {
                              title: `${project.projectName} API 成功率`,
                              lines: [`API 成功率：${fmtPercent(project.apiSuccessRate)}`],
                              accent: "green",
                            })
                          }
                          onMouseMove={tooltipHandlers.onMove}
                          onMouseLeave={tooltipHandlers.onLeave}
                        >
                          <span>{fmtPercent(project.apiSuccessRate)}</span>
                          <div className="project-progress-track">
                            <div className="project-progress-fill" style={{ width: `${clamp(project.apiSuccessRate, 0, 100)}%` }} />
                          </div>
                        </div>
                      </td>
                      <td>
                        <div
                          className="project-progress-cell"
                          onMouseEnter={(event) =>
                            tooltipHandlers.onEnter(event, {
                              title: `${project.projectName} 总通过率`,
                              lines: [`总通过率：${fmtPercent(project.avgPassRate)}`],
                              accent: "green",
                            })
                          }
                          onMouseMove={tooltipHandlers.onMove}
                          onMouseLeave={tooltipHandlers.onLeave}
                        >
                          <span>{fmtPercent(project.avgPassRate)}</span>
                          <div className="project-progress-track">
                            <div className="project-progress-fill" style={{ width: `${clamp(project.avgPassRate, 0, 100)}%` }} />
                          </div>
                        </div>
                      </td>
                      <td>
                        <div
                          className="project-score-cell"
                          onMouseEnter={(event) =>
                            tooltipHandlers.onEnter(event, {
                              title: `${project.projectName} 平均分`,
                              lines: [`评分：${fmtScore(project.avgScore)}`],
                              accent: "blue",
                            })
                          }
                          onMouseMove={tooltipHandlers.onMove}
                          onMouseLeave={tooltipHandlers.onLeave}
                        >
                          <span>{fmtScore(project.avgScore)}</span>
                          <div className="project-score-dot" style={{ opacity: clamp(scoreToPercent(project.avgScore ?? 0), 15, 100) / 100 }} />
                        </div>
                      </td>
                      <td>
                        <span
                          className="project-health-badge watch"
                          onMouseEnter={(event) =>
                            tooltipHandlers.onEnter(event, {
                              title: `${project.projectName} 运行次数`,
                              lines: [`运行次数：${project.runCount}`],
                              accent: "amber",
                            })
                          }
                          onMouseMove={tooltipHandlers.onMove}
                          onMouseLeave={tooltipHandlers.onLeave}
                        >
                          {project.runCount}
                        </span>
                      </td>
                      <td>
                        <button type="button" className="project-suite-link" onClick={() => setSelectedProjectId(project.projectId)}>
                          聚焦项目
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {tooltip ? (
        <div
          className={cn("project-hover-tooltip", `accent-${tooltip.accent ?? "blue"}`)}
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          <div className="project-hover-tooltip-title">{tooltip.title}</div>
          {tooltip.lines && tooltip.lines.length > 0 ? (
            <div className="project-hover-tooltip-lines">
              {tooltip.lines.map((line, index) => (
                <div key={`${line}-${index}`}>{line}</div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
