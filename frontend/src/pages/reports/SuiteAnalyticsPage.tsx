import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AlertTriangle, Download, Gauge, Layers3, RefreshCw, ShieldCheck, Sparkles, TrendingDown, TrendingUp, type LucideIcon } from "lucide-react";

import { FloatingNotice, type NoticeTone } from "../../components/FloatingNotice";
import { ProjectRecord, SuiteRecord, listProjects, listSuites } from "../../services/assetService";
import { RunDetailReport, SuiteAnalyticsReport, getRunDetailReport, getSuiteAnalyticsReport } from "../../services/reportService";
import { RunRecord, listRuns } from "../../services/runService";
import { buildExportFileName, exportElementAsPng } from "./reportExport";
import { formatDate, fmtPercent, fmtScore, parseMaybeNumber, scoreToPercent } from "./reportShared";

import "./ProjectDashboardPage.css";
import "./SuiteAnalyticsPage.css";

type TrendPoint = {
  label: string;
  value: number;
  display: string;
  runId: number;
};

type SuiteKpiCard = {
  label: string;
  hint: string;
  value: string;
  detail: string;
  icon: LucideIcon;
  delta: number | null;
  betterDirection: "up" | "down";
  accent: "blue" | "green" | "pink" | "amber";
};

type BenchmarkDimensionMetric = {
  name: string;
  value: number;
  sampleCount: number;
};

function cn(...classes: Array<string | undefined | null | false>): string {
  return classes.filter(Boolean).join(" ");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeRunType(value: string | undefined): string {
  return value === "benchmark" ? "agent_eval" : value ?? "api_test";
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeDimensionScore(value: number): number {
  if (value > 1 && value <= 100) {
    return value / 100;
  }
  return clamp(value, 0, 1);
}

function fmtRate(value: number | null | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "--";
  }
  return `${value.toFixed(1)}%`;
}

function fmtMs(value: number | null | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
    return "--";
  }
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`;
}

function pickLatestSuiteIdFromRuns(runs: RunRecord[], validSuiteIds: Set<number>): number | null {
  let latestSuiteId: number | null = null;
  let latestRunId = -1;

  runs.forEach((run) => {
    const suiteId = typeof run.suite_id === "number" && Number.isFinite(run.suite_id) ? run.suite_id : null;
    if (!suiteId || !validSuiteIds.has(suiteId)) {
      return;
    }
    if (run.id > latestRunId) {
      latestRunId = run.id;
      latestSuiteId = suiteId;
    }
  });

  return latestSuiteId;
}

function extractBenchmarkDimensionMetrics(detail: RunDetailReport): BenchmarkDimensionMetric[] {
  const aggregate = new Map<string, { sum: number; count: number }>();

  detail.items.forEach((item) => {
    const scoreResult = item.score_result;
    if (!scoreResult || typeof scoreResult !== "object" || Array.isArray(scoreResult)) {
      return;
    }
    const dimensions = (scoreResult as Record<string, unknown>).dimensions;
    if (!Array.isArray(dimensions)) {
      return;
    }

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

      const normalizedScore = normalizeDimensionScore(rawScore);
      const existing = aggregate.get(name) ?? { sum: 0, count: 0 };
      existing.sum += normalizedScore;
      existing.count += 1;
      aggregate.set(name, existing);
    });
  });

  return Array.from(aggregate.entries())
    .map(([name, value]) => ({
      name,
      value: value.count > 0 ? value.sum / value.count : 0,
      sampleCount: value.count,
    }))
    .sort((a, b) => b.value - a.value);
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

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, item) => sum + item, 0) / values.length;
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

function KpiDeltaBadge({ value, betterDirection }: { value: number | null; betterDirection: "up" | "down" }) {
  if (value === null || Number.isNaN(value)) {
    return (
      <span className="project-kpi-delta neutral">
        <span>无趋势</span>
      </span>
    );
  }

  const isNeutral = Math.abs(value) < 0.05;
  const isGood = betterDirection === "up" ? value > 0 : value < 0;
  const trendClass = isNeutral ? "neutral" : isGood ? "good" : "bad";
  const TrendIcon = isNeutral ? Layers3 : value > 0 ? TrendingUp : TrendingDown;
  const prefix = value > 0 ? "+" : "";
  return (
    <span className={`project-kpi-delta ${trendClass}`}>
      <TrendIcon size={14} />
      <span>{`${prefix}${value.toFixed(1)}pp`}</span>
    </span>
  );
}

function TrendChartCard({
  title,
  subtitle,
  points,
  lineStart,
  lineEnd,
  areaStart,
  areaEnd,
  areaTopOpacity = 0.22,
  areaBottomOpacity = 0.03,
  dotColor,
  smooth = false,
  className,
  emptyText,
}: {
  title: string;
  subtitle: string;
  points: TrendPoint[];
  lineStart: string;
  lineEnd: string;
  areaStart: string;
  areaEnd: string;
  areaTopOpacity?: number;
  areaBottomOpacity?: number;
  dotColor?: string;
  smooth?: boolean;
  className?: string;
  emptyText: string;
}) {
  const width = 720;
  const height = 260;
  const padX = 28;
  const padY = 26;

  const values = points.map((point) => point.value);
  const path = mapTrendPath(values, width, height, padX, padY, smooth);

  return (
    <article className={cn("project-report-card project-chart-card", className)}>
      <header className="project-card-header">
        <div>
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </div>
      </header>

      {points.length === 0 || !path ? (
        <div className="project-empty">{emptyText}</div>
      ) : (
        <>
          <svg className="project-trend-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
            {[0, 1, 2, 3, 4].map((index) => {
              const y = padY + (index / 4) * (height - padY * 2);
              return <line key={`grid-${index}`} x1={padX} y1={y} x2={width - padX} y2={y} className="project-grid-line" />;
            })}
            <defs>
              <linearGradient id={`suite-trend-line-${title.replace(/\s+/g, "-")}`} x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor={lineStart} />
                <stop offset="100%" stopColor={lineEnd} />
              </linearGradient>
              <linearGradient id={`suite-trend-gradient-${title.replace(/\s+/g, "-")}`} x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor={areaStart} stopOpacity={String(areaTopOpacity)} />
                <stop offset="100%" stopColor={areaEnd} stopOpacity={String(areaBottomOpacity)} />
              </linearGradient>
            </defs>
            <path d={path.area} className="project-trend-area" fill={`url(#suite-trend-gradient-${title.replace(/\s+/g, "-")})`} />
            <path
              d={path.line}
              className="project-trend-line"
              stroke={`url(#suite-trend-line-${title.replace(/\s+/g, "-")})`}
              strokeWidth={3}
              fill="none"
              strokeLinecap="round"
            />
            {path.points.map((point, index) => {
              const item = points[index];
              return (
                <g key={`dot-${item.runId}`}>
                  <circle
                    cx={point.x}
                    cy={point.y}
                    r={4}
                    fill="var(--app-surface)"
                    stroke={dotColor ?? lineEnd}
                    strokeWidth={3}
                    className="project-trend-dot"
                  >
                    <title>{`${item.label} · ${item.display}`}</title>
                  </circle>
                  {index === path.points.length - 1 ? (
                    <circle cx={point.x} cy={point.y} r={8} fill={dotColor ?? lineEnd} opacity={0.2} className="project-trend-focus" />
                  ) : null}
                </g>
              );
            })}
          </svg>
          <div className="project-trend-legend">
            {points.slice(-6).map((point) => (
              <div key={`legend-${point.runId}`}>
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

export function SuiteAnalyticsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const pageRef = useRef<HTMLElement | null>(null);

  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [suites, setSuites] = useState<SuiteRecord[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(() => parseMaybeNumber(searchParams.get("projectId")));
  const [selectedSuiteId, setSelectedSuiteId] = useState<number | null>(() => parseMaybeNumber(searchParams.get("suiteId")));

  const [report, setReport] = useState<SuiteAnalyticsReport | null>(null);
  const [benchmarkDimensions, setBenchmarkDimensions] = useState<BenchmarkDimensionMetric[]>([]);
  const [benchmarkDimensionLoading, setBenchmarkDimensionLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [exportingImage, setExportingImage] = useState(false);
  const [notice, setNotice] = useState<{ tone: NoticeTone; text: string } | null>(null);

  const selectedProject = useMemo(() => projects.find((item) => item.id === selectedProjectId) ?? null, [projects, selectedProjectId]);
  const selectedSuite = useMemo(() => suites.find((item) => item.id === selectedSuiteId) ?? null, [suites, selectedSuiteId]);

  const orderedRunHistory = useMemo(() => [...(report?.runHistory ?? [])].sort((a, b) => b.runId - a.runId), [report?.runHistory]);

  const apiRunHistory = useMemo(
    () =>
      orderedRunHistory.filter((item) => {
        const normalized = normalizeRunType(item.runType);
        return normalized !== "agent_eval";
      }),
    [orderedRunHistory]
  );
  const benchmarkRunHistory = useMemo(
    () =>
      orderedRunHistory.filter((item) => {
        const normalized = normalizeRunType(item.runType);
        return normalized === "agent_eval";
      }),
    [orderedRunHistory]
  );
  const hasApiHistory = apiRunHistory.length > 0;
  const hasBenchmarkHistory = benchmarkRunHistory.length > 0;
  const latestBenchmarkRunId = benchmarkRunHistory[0]?.runId ?? null;

  const apiTrendPoints = useMemo<TrendPoint[]>(
    () =>
      [...apiRunHistory]
        .sort((a, b) => a.runId - b.runId)
        .slice(-10)
        .map((run) => ({
          label: `Run#${run.runId}`,
          value: clamp(run.passRate ?? 0, 0, 100),
          display: fmtPercent(run.passRate ?? 0),
          runId: run.runId,
        })),
    [apiRunHistory]
  );

  const benchmarkTrendPoints = useMemo<TrendPoint[]>(
    () =>
      [...benchmarkRunHistory]
        .sort((a, b) => a.runId - b.runId)
        .slice(-10)
        .map((run) => ({
          label: `Run#${run.runId}`,
          value: scoreToPercent(run.avgScore ?? 0),
          display: fmtScore(run.avgScore),
          runId: run.runId,
        })),
    [benchmarkRunHistory]
  );

  const apiDelta = useMemo(() => calculateDelta(apiTrendPoints.map((item) => item.value)), [apiTrendPoints]);
  const benchmarkDelta = useMemo(() => calculateDelta(benchmarkTrendPoints.map((item) => item.value)), [benchmarkTrendPoints]);

  const avgApiPassRate = useMemo(() => average(apiRunHistory.map((item) => item.passRate ?? 0)), [apiRunHistory]);
  const avgBenchmarkScore = useMemo(() => average(benchmarkRunHistory.map((item) => item.avgScore ?? 0)), [benchmarkRunHistory]);
  const avgBenchmarkDimensionScore = useMemo(() => average(benchmarkDimensions.map((item) => item.value)), [benchmarkDimensions]);
  const apiErrorDistributionTotal = useMemo(
    () => (report?.api.errorTypeDistribution ?? []).reduce((sum, item) => sum + item.value, 0),
    [report?.api.errorTypeDistribution]
  );
  const topApiError = useMemo(
    () => [...(report?.api.errorTypeDistribution ?? [])].sort((a, b) => b.value - a.value)[0] ?? null,
    [report?.api.errorTypeDistribution]
  );
  const apiQualitySummary = report?.api.qualitySummary ?? null;
  const latestApiRunInsight = report?.api.latestRunInsight ?? null;
  const apiStatusCodeDistribution = report?.api.statusCodeDistribution ?? [];
  const apiTopSlowCases = report?.api.topSlowCases ?? [];
  const apiFlakyCases = report?.api.flakyCases ?? [];
  const failedSampleTotal = apiQualitySummary?.failedItemCount ?? apiErrorDistributionTotal;
  const strongestBenchmarkDimension = benchmarkDimensions[0] ?? null;
  const weakestBenchmarkDimension = benchmarkDimensions[benchmarkDimensions.length - 1] ?? null;
  const latestRun = orderedRunHistory[0] ?? null;
  const suiteSelectValue = useMemo(() => {
    if (selectedSuiteId && suites.some((suite) => suite.id === selectedSuiteId)) {
      return selectedSuiteId;
    }
    return suites[0]?.id ?? "";
  }, [selectedSuiteId, suites]);

  const kpiCards = useMemo<SuiteKpiCard[]>(
    () => {
      const runTotalCard: SuiteKpiCard = {
        label: "Run 总数",
        hint: "当前 Suite 历史",
        value: String(orderedRunHistory.length),
        detail: latestRun ? `最新 Run #${latestRun.runId}` : "暂无运行记录",
        icon: Layers3,
        delta: null,
        betterDirection: "up",
        accent: "amber",
      };

      const riskSignalCard: SuiteKpiCard = {
        label: "风险信号",
        hint: "失败 + 低分聚合",
        value: String((report?.api.topFailedCases.length ?? 0) + (report?.benchmark.lowScoreCases.length ?? 0)),
        detail: `错误类型 ${(report?.api.errorTypeDistribution.length ?? 0)} 项`,
        icon: AlertTriangle,
        delta: null,
        betterDirection: "down",
        accent: "pink",
      };

      if (hasApiHistory && hasBenchmarkHistory) {
        return [
          {
            label: "API 平均通过率",
            hint: "最近运行样本",
            value: fmtPercent(avgApiPassRate),
            detail: `${apiRunHistory.length} 次 API Run`,
            icon: ShieldCheck,
            delta: apiDelta,
            betterDirection: "up",
            accent: "blue",
          },
          {
            label: "Benchmark 平均分",
            hint: "score 趋势核心指标",
            value: fmtScore(avgBenchmarkScore),
            detail: `${benchmarkRunHistory.length} 次 Benchmark Run`,
            icon: Sparkles,
            delta: benchmarkDelta,
            betterDirection: "up",
            accent: "green",
          },
          runTotalCard,
          riskSignalCard,
        ];
      }

      if (hasApiHistory) {
        return [
          {
            label: "API 平均通过率",
            hint: "最近运行样本",
            value: fmtPercent(avgApiPassRate),
            detail: `${apiRunHistory.length} 次 API Run`,
            icon: ShieldCheck,
            delta: apiDelta,
            betterDirection: "up",
            accent: "blue",
          },
          {
            label: "API 错误类型数",
            hint: "最近失败分布",
            value: String(report?.api.errorTypeDistribution.length ?? 0),
            detail: topApiError ? `${topApiError.name} ${topApiError.value} 次` : "暂无错误样本",
            icon: Gauge,
            delta: null,
            betterDirection: "down",
            accent: "green",
          },
          runTotalCard,
          riskSignalCard,
        ];
      }

      if (hasBenchmarkHistory) {
        return [
          {
            label: "Benchmark 平均分",
            hint: "score 趋势核心指标",
            value: fmtScore(avgBenchmarkScore),
            detail: `${benchmarkRunHistory.length} 次 Benchmark Run`,
            icon: Sparkles,
            delta: benchmarkDelta,
            betterDirection: "up",
            accent: "green",
          },
          {
            label: "维度覆盖",
            hint: "最新 Benchmark Run",
            value: String(benchmarkDimensions.length),
            detail: latestBenchmarkRunId ? `Run #${latestBenchmarkRunId}` : "暂无维度",
            icon: Gauge,
            delta: null,
            betterDirection: "up",
            accent: "blue",
          },
          runTotalCard,
          riskSignalCard,
        ];
      }

      return [
        {
          label: "API 错误类型数",
          hint: "最近失败分布",
          value: "0",
          detail: "暂无错误样本",
          icon: Gauge,
          delta: null,
          betterDirection: "down",
          accent: "blue",
        },
        {
          label: "维度覆盖",
          hint: "最新 Benchmark Run",
          value: "0",
          detail: "暂无维度",
          icon: Sparkles,
          delta: null,
          betterDirection: "up",
          accent: "green",
        },
        runTotalCard,
        riskSignalCard,
      ];
    },
    [
      hasApiHistory,
      hasBenchmarkHistory,
      benchmarkDimensions.length,
      latestBenchmarkRunId,
      avgApiPassRate,
      apiRunHistory.length,
      apiDelta,
      avgBenchmarkScore,
      benchmarkRunHistory.length,
      benchmarkDelta,
      orderedRunHistory.length,
      latestRun,
      report,
      topApiError,
    ]
  );

  async function refreshProjectCatalog(preferredProjectId?: number | null) {
    const projectItems = await listProjects();
    setProjects(projectItems);
    const nextProjectId =
      preferredProjectId && projectItems.some((item) => item.id === preferredProjectId) ? preferredProjectId : projectItems[0]?.id ?? null;
    setSelectedProjectId(nextProjectId);
    return nextProjectId;
  }

  async function refreshSuiteCatalog(projectId: number, preferredSuiteId?: number | null) {
    const suiteItems = await listSuites(projectId);
    setSuites(suiteItems);
    if (suiteItems.length === 0) {
      setSelectedSuiteId(null);
      return null;
    }

    const validSuiteIds = new Set(suiteItems.map((item) => item.id));
    let nextSuiteId = preferredSuiteId && validSuiteIds.has(preferredSuiteId) ? preferredSuiteId : null;

    if (!nextSuiteId) {
      try {
        const runs = await listRuns({ projectId });
        nextSuiteId = pickLatestSuiteIdFromRuns(runs, validSuiteIds);
      } catch {
        nextSuiteId = null;
      }
    }

    if (!nextSuiteId) {
      nextSuiteId = suiteItems[0].id;
    }

    setSelectedSuiteId(nextSuiteId);
    return nextSuiteId;
  }

  async function refreshReport(suiteId: number) {
    const data = await getSuiteAnalyticsReport(suiteId);
    setReport(data);
  }

  async function initialize() {
    setLoading(true);
    try {
      const projectId = await refreshProjectCatalog(selectedProjectId);
      if (!projectId) {
        setSuites([]);
        setReport(null);
        return;
      }
      const suiteId = await refreshSuiteCatalog(projectId, selectedSuiteId);
      if (!suiteId) {
        setReport(null);
        return;
      }
      await refreshReport(suiteId);
      setNotice(null);
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "加载 Suite 分析失败",
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void initialize();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedProjectId) {
      setSuites([]);
      setSelectedSuiteId(null);
      setReport(null);
      return;
    }
    setLoading(true);
    void refreshSuiteCatalog(selectedProjectId, selectedSuiteId)
      .then((suiteId) => {
        if (!suiteId) {
          setReport(null);
          return;
        }
        return refreshReport(suiteId);
      })
      .then(() => setNotice(null))
      .catch((error: unknown) =>
        setNotice({
          tone: "error",
          text: error instanceof Error ? error.message : "刷新 Suite 分析失败",
        })
      )
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedSuiteId) {
      setReport(null);
      return;
    }
    setLoading(true);
    void refreshReport(selectedSuiteId)
      .then(() => setNotice(null))
      .catch((error: unknown) =>
        setNotice({
          tone: "error",
          text: error instanceof Error ? error.message : "刷新 Suite 报告失败",
        })
      )
      .finally(() => setLoading(false));
  }, [selectedSuiteId]);

  useEffect(() => {
    const next = new URLSearchParams();
    if (selectedProjectId) {
      next.set("projectId", String(selectedProjectId));
    }
    if (selectedSuiteId) {
      next.set("suiteId", String(selectedSuiteId));
    }
    setSearchParams(next, { replace: true });
  }, [selectedProjectId, selectedSuiteId, setSearchParams]);

  useEffect(() => {
    if (!latestBenchmarkRunId) {
      setBenchmarkDimensions([]);
      setBenchmarkDimensionLoading(false);
      return;
    }

    let cancelled = false;
    setBenchmarkDimensionLoading(true);

    void getRunDetailReport(latestBenchmarkRunId)
      .then((detail) => {
        if (cancelled) {
          return;
        }
        setBenchmarkDimensions(extractBenchmarkDimensionMetrics(detail));
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setBenchmarkDimensions([]);
      })
      .finally(() => {
        if (cancelled) {
          return;
        }
        setBenchmarkDimensionLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [latestBenchmarkRunId]);

  async function onExportPageImage() {
    const pageElement = pageRef.current;
    if (!pageElement) {
      setNotice({ tone: "error", text: "页面未准备就绪，暂时无法导出图片" });
      return;
    }
    setExportingImage(true);
    try {
      const fileName = buildExportFileName(
        "suite-analytics",
        [selectedProjectId ? `project-${selectedProjectId}` : "project-unknown", selectedSuiteId ? `suite-${selectedSuiteId}` : "suite-unknown"],
        "png"
      );
      await exportElementAsPng(pageElement, fileName);
      setNotice({ tone: "success", text: "Suite 分析整页图片导出成功" });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "导出 Suite 分析图片失败",
      });
    } finally {
      setExportingImage(false);
    }
  }

  return (
    <section ref={pageRef} className="reports-page suite-analytics-v3">
      <FloatingNotice notice={notice} onClose={() => setNotice(null)} />

      <header className="grid gap-1">
        <h2 className="page-title m-0">Suite分析</h2>
      </header>

      <section className="project-dashboard-toolbar suite-toolbar">
        <select
          value={selectedProjectId ?? ""}
          onChange={(event) => setSelectedProjectId(event.target.value ? Number(event.target.value) : null)}
          aria-label="选择项目"
        >
          <option value="">选择项目</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <select
          value={suiteSelectValue}
          onChange={(event) => setSelectedSuiteId(Number(event.target.value))}
          aria-label="选择 Suite"
          disabled={suites.length === 0}
        >
          {suites.map((suite) => (
            <option key={suite.id} value={suite.id}>
              {suite.name}
            </option>
          ))}
        </select>
        <div className="suite-toolbar-actions">
          <button
            type="button"
            onClick={() => void initialize()}
            disabled={loading}
            className="project-refresh-btn"
          >
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
        </div>
      </section>

      <section className="project-kpi-grid suite-kpi-grid">
        {kpiCards.map((item) => {
          const Icon = item.icon;
          return (
            <article key={item.label} className={cn("project-kpi-card suite-kpi-card", `suite-kpi-${item.accent}`)}>
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
              <div className="suite-kpi-foot">
                <span className="suite-kpi-detail">{item.detail}</span>
                <KpiDeltaBadge value={item.delta} betterDirection={item.betterDirection} />
              </div>
            </article>
          );
        })}
      </section>

      {hasApiHistory || hasBenchmarkHistory ? (
        <section className="project-board-grid suite-board-grid">
          {hasApiHistory ? (
            <>
              <TrendChartCard
                title="API 通过率趋势"
                subtitle="近 10 次 API Run"
                points={apiTrendPoints}
                lineStart="var(--chart-blue-start)"
                lineEnd="var(--chart-blue-end)"
                areaStart="var(--chart-blue-mid)"
                areaEnd="var(--chart-blue-end)"
                areaTopOpacity={0.22}
                areaBottomOpacity={0.03}
                dotColor="var(--chart-blue-end)"
                smooth
                className="project-span-8"
                emptyText="暂无 API 趋势"
              />

              <article className="project-report-card project-compact-card project-span-4 suite-api-analysis-card">
                <header className="project-card-header">
                  <div>
                    <h3>API 问题分析</h3>
                    <p>失败、性能、重试与波动综合洞察</p>
                  </div>
                </header>

                <div className="suite-analysis-stack suite-api-stack">
                  <div className="suite-api-overview-grid">
                    <div className="suite-api-kpi">
                      <span>失败样本</span>
                      <strong>{apiQualitySummary?.failedItemCount ?? apiErrorDistributionTotal}</strong>
                    </div>
                    <div className="suite-api-kpi">
                      <span>重试命中率</span>
                      <strong>{fmtRate(apiQualitySummary?.retryRate)}</strong>
                    </div>
                    <div className="suite-api-kpi">
                      <span>超时占比</span>
                      <strong>{fmtRate(apiQualitySummary?.timeoutRate)}</strong>
                    </div>
                    <div className="suite-api-kpi">
                      <span>慢请求占比</span>
                      <strong>{fmtRate(apiQualitySummary?.slowRequestRate)}</strong>
                    </div>
                  </div>

                  <div className="suite-api-highlights">
                    <div className="suite-api-highlight">
                      <span>最近 API Run</span>
                      <strong>
                        {latestApiRunInsight?.runId ? `#${latestApiRunInsight.runId}` : "--"}
                        {latestApiRunInsight?.runId ? ` · ${fmtPercent(latestApiRunInsight.passRate)}` : ""}
                      </strong>
                    </div>
                    <div className="suite-api-highlight">
                      <span>平均 / P95 耗时</span>
                      <strong>{`${fmtMs(apiQualitySummary?.avgDurationMs)} / ${fmtMs(apiQualitySummary?.p95DurationMs)}`}</strong>
                    </div>
                    <div className="suite-api-highlight">
                      <span>高频状态码</span>
                      <strong>
                        {apiStatusCodeDistribution.length > 0
                          ? `${apiStatusCodeDistribution[0].name} (${apiStatusCodeDistribution[0].value})`
                          : "--"}
                      </strong>
                    </div>
                  </div>

                  <div>
                    <div className="suite-section-label">错误类型分布</div>
                    {(report?.api.errorTypeDistribution ?? []).length === 0 ? (
                      <div className="project-empty suite-compact-empty">暂无错误分布</div>
                    ) : (
                      <div className="project-distribution-list suite-api-distribution-list">
                        {(report?.api.errorTypeDistribution ?? []).slice(0, 5).map((item) => {
                          const max = Math.max(...(report?.api.errorTypeDistribution ?? []).map((row) => row.value), 1);
                          const width = clamp((item.value / max) * 100, 8, 100);
                          const percent = failedSampleTotal > 0 ? (item.value / failedSampleTotal) * 100 : 0;
                          return (
                            <div key={item.name} className="project-distribution-item">
                              <div className="project-distribution-meta">
                                <strong>{item.name}</strong>
                                <span>{`${item.value} · ${percent.toFixed(1)}%`}</span>
                              </div>
                              <div className="project-distribution-track">
                                <div className="suite-error-fill" style={{ width: `${width}%` }} />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div>
                    <div className="suite-section-label">Top 失败 case</div>
                    {(report?.api.topFailedCases ?? []).length === 0 ? (
                      <div className="project-empty suite-compact-empty">暂无失败样本</div>
                    ) : (
                      <div className="suite-list suite-api-case-list">
                        {(report?.api.topFailedCases ?? []).slice(0, 4).map((item) => {
                          const caseShare = failedSampleTotal > 0 ? (item.failedCount / failedSampleTotal) * 100 : 0;
                          return (
                            <div key={`${item.caseId}-${item.caseName}`} className="suite-list-item suite-list-item-rich">
                              <div className="suite-list-rich-main">
                                <span>{item.caseName}</span>
                                <small>{`${caseShare.toFixed(1)}%`}</small>
                              </div>
                              <strong>{item.failedCount}</strong>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div className="suite-api-tags">
                    <div className="suite-api-tag">
                      <span>Top 慢请求</span>
                      <strong>
                        {apiTopSlowCases.length > 0
                          ? `${apiTopSlowCases[0].caseName} · ${fmtMs(apiTopSlowCases[0].avgDurationMs)}`
                          : "--"}
                      </strong>
                    </div>
                    <div className="suite-api-tag">
                      <span>高波动 case</span>
                      <strong>
                        {apiFlakyCases.length > 0
                          ? `${apiFlakyCases[0].caseName} · ${apiFlakyCases[0].flakyIndex.toFixed(1)}`
                          : "--"}
                      </strong>
                    </div>
                  </div>
                </div>
              </article>
            </>
          ) : null}

          {hasBenchmarkHistory ? (
            <>
            <TrendChartCard
              title="Benchmark score 趋势"
              subtitle="近 10 次 Benchmark Run"
              points={benchmarkTrendPoints}
              lineStart="var(--chart-green-start)"
              lineEnd="var(--chart-green-end)"
              areaStart="var(--chart-green-mid)"
              areaEnd="var(--chart-green-end)"
              areaTopOpacity={0.2}
              areaBottomOpacity={0.04}
              dotColor="var(--chart-green-end)"
              className="project-span-8"
              emptyText="暂无 Benchmark 趋势"
            />

            <article className="project-report-card project-compact-card project-span-4 suite-benchmark-dimension-card">
              <header className="project-card-header">
                <div>
                  <h3>Benchmark 维度评分</h3>
                  <p>最新 Benchmark Run 的细粒度维度</p>
                </div>
              </header>

              <div className="suite-analysis-stack suite-dimension-stack">
                <div className="suite-dimension-overview">
                  <div className="suite-dimension-kpi">
                    <span>覆盖维度</span>
                    <strong>{benchmarkDimensions.length}</strong>
                  </div>
                  <div className="suite-dimension-kpi">
                    <span>维度均分</span>
                    <strong>{benchmarkDimensions.length > 0 ? avgBenchmarkDimensionScore.toFixed(3) : "--"}</strong>
                  </div>
                </div>

                <div>
                  <div className="suite-section-label">维度得分排行</div>
                  {benchmarkDimensionLoading ? (
                    <div className="project-empty suite-compact-empty">维度加载中...</div>
                  ) : benchmarkDimensions.length === 0 ? (
                    <div className="project-empty suite-compact-empty">暂无维度数据</div>
                  ) : (
                    <div className="suite-dimension-bars">
                      {benchmarkDimensions.slice(0, 8).map((dimension) => (
                        <div key={dimension.name} className="suite-dimension-bar">
                          <div className="suite-dimension-bar-meta">
                            <span>{dimension.name}</span>
                            <strong>{dimension.value.toFixed(3)}</strong>
                          </div>
                          <div className="suite-dimension-track">
                            <div className="suite-dimension-fill" style={{ width: `${clamp(dimension.value * 100, 8, 100)}%` }} />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {benchmarkDimensions.length > 0 ? (
                  <div className="suite-dimension-summary">
                    <div>
                      <span>最佳维度</span>
                      <strong>{strongestBenchmarkDimension?.name ?? "--"}</strong>
                    </div>
                    <div>
                      <span>待提升</span>
                      <strong>{weakestBenchmarkDimension?.name ?? "--"}</strong>
                    </div>
                  </div>
                ) : null}
              </div>
            </article>
            </>
          ) : null}
        </section>
      ) : null}

      <section className="project-report-card suite-run-history-card">
        <header className="project-card-header">
          <div>
            <h3>Run 历史</h3>
            <p>按最新 run_id 排序 · 快速跳转 Run 报告</p>
          </div>
        </header>

        {!report || orderedRunHistory.length === 0 ? (
          <div className="project-empty">暂无 Run 历史</div>
        ) : (
          <div className="project-suite-table-wrap">
            <table className="project-suite-table">
              <thead>
                <tr>
                  <th>run_id</th>
                  <th>type</th>
                  <th>status</th>
                  <th>pass_rate</th>
                  <th>avg_score</th>
                  <th>时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {orderedRunHistory.map((run) => (
                  <tr key={run.runId}>
                    <td className="font-semibold">#{run.runId}</td>
                    <td>{normalizeRunType(run.runType) === "agent_eval" ? "benchmark" : "api_test"}</td>
                    <td>{run.status}</td>
                    <td>{typeof run.passRate === "number" ? fmtPercent(run.passRate) : "-"}</td>
                    <td>{fmtScore(run.avgScore)}</td>
                    <td>{formatDate(run.createdAt)}</td>
                    <td>
                      <Link to={`/reports/run?runId=${run.runId}`} className="suite-run-link">
                        查看 Run 报告
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  );
}
