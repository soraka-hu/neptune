import { useEffect, useMemo, useState } from "react";

import { FloatingNotice, type NoticeTone } from "../../components/FloatingNotice";
import { ProjectRecord, listProjects } from "../../services/assetService";
import { compareReports } from "../../services/reportService";
import { RunRecord, listRuns } from "../../services/runService";
import { formatDate, isRecord, parseMaybeNumber, toNumber, toPretty } from "./reportShared";

import "./CompareReportPage.css";

type RunKind = "agent_eval" | "api_test" | "unknown";

type SummaryStats = {
  total: number;
  passed: number;
  failed: number;
};

type CompareModel = {
  runId1: number;
  runId2: number;
  runType: RunKind;
  summary1: SummaryStats;
  summary2: SummaryStats;
  delta: {
    passedDelta: number;
    failedDelta: number;
    totalDelta: number;
  };
  passRate1: number;
  passRate2: number;
  failed1: number;
  failed2: number;
  avgScore1: number;
  avgScore2: number;
  dimensions1: Array<{ dimension: string; avgScore: number }>;
  dimensions2: Array<{ dimension: string; avgScore: number }>;
  newFailureIds: number[];
  fixedCaseIds: number[];
  rawPayload: Record<string, unknown>;
};

type MetricScale = {
  min: number;
  max: number;
  toPercent: (value: number) => number;
};

const primaryButtonClass =
  "compare-submit-btn rounded-lg border border-primary/60 bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60";

function normalizeRunType(value: string | undefined): RunKind {
  if (!value) {
    return "unknown";
  }
  if (value === "agent_eval" || value === "benchmark") {
    return "agent_eval";
  }
  if (value === "api_test" || value === "api") {
    return "api_test";
  }
  return "unknown";
}

function runKindText(kind: RunKind): string {
  if (kind === "agent_eval") {
    return "agent_eval";
  }
  if (kind === "api_test") {
    return "api_test";
  }
  return "unknown";
}

function buildScale(
  values: number[],
  options: {
    floor?: number;
    ceil?: number;
    minSpan?: number;
    minPercent?: number;
  } = {}
): MetricScale {
  const finiteValues = values.filter((value) => Number.isFinite(value));
  const minSpan = options.minSpan ?? 1;
  const minPercent = options.minPercent ?? 3;

  let min = finiteValues.length > 0 ? Math.min(...finiteValues) : 0;
  let max = finiteValues.length > 0 ? Math.max(...finiteValues) : minSpan;

  if (min === max) {
    min -= minSpan / 2;
    max += minSpan / 2;
  }

  const padding = (max - min) * 0.18;
  min -= padding;
  max += padding;

  if (max - min < minSpan) {
    const center = (max + min) / 2;
    min = center - minSpan / 2;
    max = center + minSpan / 2;
  }

  if (typeof options.floor === "number") {
    min = Math.max(options.floor, min);
  }
  if (typeof options.ceil === "number") {
    max = Math.min(options.ceil, max);
  }
  if (max <= min) {
    max = min + minSpan;
  }

  return {
    min,
    max,
    toPercent: (value: number) => {
      const ratio = ((value - min) / (max - min)) * 100;
      return Math.max(minPercent, Math.min(100, ratio));
    },
  };
}

function parseCaseIds(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const ids = value
    .map((item) => (typeof item === "number" && Number.isInteger(item) ? item : Number(item)))
    .filter((item) => Number.isInteger(item) && item > 0);
  return Array.from(new Set(ids));
}

function parseSummary(value: unknown): SummaryStats {
  const row = isRecord(value) ? value : {};
  return {
    total: toNumber(row.total),
    passed: toNumber(row.passed),
    failed: toNumber(row.failed),
  };
}

function parseCompareModel(result: Record<string, unknown>): CompareModel {
  const metrics = isRecord(result.metrics) ? result.metrics : {};
  const dimensions1 = Array.isArray(metrics.dimensions1)
    ? metrics.dimensions1
        .filter(isRecord)
        .map((item) => ({
          dimension: typeof item.dimension === "string" ? item.dimension : "dimension",
          avgScore: toNumber(item.avgScore),
        }))
    : [];
  const dimensions2 = Array.isArray(metrics.dimensions2)
    ? metrics.dimensions2
        .filter(isRecord)
        .map((item) => ({
          dimension: typeof item.dimension === "string" ? item.dimension : "dimension",
          avgScore: toNumber(item.avgScore),
        }))
    : [];
  const delta = isRecord(result.delta) ? result.delta : {};

  return {
    runId1: toNumber(result.runId1),
    runId2: toNumber(result.runId2),
    runType: normalizeRunType(typeof result.runType === "string" ? result.runType : undefined),
    summary1: parseSummary(result.summary1),
    summary2: parseSummary(result.summary2),
    delta: {
      passedDelta: toNumber(delta.passedDelta),
      failedDelta: toNumber(delta.failedDelta),
      totalDelta: toNumber(delta.totalDelta),
    },
    passRate1: toNumber(metrics.passRate1),
    passRate2: toNumber(metrics.passRate2),
    failed1: toNumber(metrics.failed1),
    failed2: toNumber(metrics.failed2),
    avgScore1: toNumber(metrics.avgScore1),
    avgScore2: toNumber(metrics.avgScore2),
    dimensions1,
    dimensions2,
    newFailureIds: parseCaseIds(result.newFailures),
    fixedCaseIds: parseCaseIds(result.fixedCases),
    rawPayload: result,
  };
}

function pickDefaultPair(orderedRuns: RunRecord[]): { left: number | null; right: number | null } {
  for (let index = 0; index < orderedRuns.length; index += 1) {
    const newer = orderedRuns[index];
    const kind = normalizeRunType(newer.run_type);
    if (kind === "unknown") {
      continue;
    }
    const older = orderedRuns.slice(index + 1).find((item) => normalizeRunType(item.run_type) === kind);
    if (older) {
      return { left: older.id, right: newer.id };
    }
  }
  if (orderedRuns.length >= 2) {
    return { left: orderedRuns[1].id, right: orderedRuns[0].id };
  }
  if (orderedRuns.length === 1) {
    return { left: orderedRuns[0].id, right: null };
  }
  return { left: null, right: null };
}

function calcPassRate(summary: SummaryStats, fallback: number): number {
  if (summary.total > 0) {
    return (summary.passed / summary.total) * 100;
  }
  return fallback;
}

function formatSigned(value: number, digits = 1): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}`;
}

function formatCaseList(ids: number[], limit = 16): string {
  if (ids.length === 0) {
    return "无";
  }
  const text = ids.slice(0, limit).map((id) => `#${id}`).join(", ");
  if (ids.length <= limit) {
    return text;
  }
  return `${text} ... 共 ${ids.length} 条`;
}

function normalizeDimensionKey(name: string): string {
  return name.trim().toLowerCase();
}

function formatMetricValue(value: number, digits: number, unit: string): string {
  return `${value.toFixed(digits)}${unit}`;
}

function scaleToAxisPercent(value: number, scale: MetricScale): number {
  const denominator = scale.max - scale.min;
  if (!Number.isFinite(value) || denominator <= 0) {
    return 0;
  }
  const ratio = ((value - scale.min) / denominator) * 100;
  return Math.max(0, Math.min(100, ratio));
}

function buildAxisTicks(scale: MetricScale, count = 5): Array<{ value: number; percent: number }> {
  const safeCount = Math.max(2, count);
  const step = (scale.max - scale.min) / (safeCount - 1);
  return Array.from({ length: safeCount }, (_, index) => {
    const value = scale.min + index * step;
    return {
      value,
      percent: (index / (safeCount - 1)) * 100,
    };
  });
}

export function CompareReportPage() {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [runId1, setRunId1] = useState<number | null>(null);
  const [runId2, setRunId2] = useState<number | null>(null);
  const [compareModel, setCompareModel] = useState<CompareModel | null>(null);

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: NoticeTone; text: string } | null>(null);

  const runById = useMemo(() => new Map(runs.map((run) => [run.id, run])), [runs]);
  const selectedRun1 = runId1 ? runById.get(runId1) ?? null : null;
  const selectedRun2 = runId2 ? runById.get(runId2) ?? null : null;
  const selectedKind1 = normalizeRunType(selectedRun1?.run_type);
  const selectedKind2 = normalizeRunType(selectedRun2?.run_type);

  const leftConstraintKind = selectedKind2 !== "unknown" ? selectedKind2 : null;
  const rightConstraintKind = selectedKind1 !== "unknown" ? selectedKind1 : null;

  const leftRunOptions = useMemo(
    () =>
      runs.filter((run) => {
        if (!leftConstraintKind) {
          return true;
        }
        return normalizeRunType(run.run_type) === leftConstraintKind;
      }),
    [runs, leftConstraintKind]
  );

  const rightRunOptions = useMemo(
    () =>
      runs.filter((run) => {
        if (!rightConstraintKind) {
          return true;
        }
        return normalizeRunType(run.run_type) === rightConstraintKind;
      }),
    [runs, rightConstraintKind]
  );

  const dimensionComparison = useMemo(() => {
    if (!compareModel || compareModel.runType !== "agent_eval") {
      return {
        rows: [] as Array<{ name: string; left: number; right: number; delta: number }>,
        leftOnly: [] as string[],
        rightOnly: [] as string[],
      };
    }

    const leftMap = new Map<string, { name: string; score: number }>();
    compareModel.dimensions1.forEach((item) => {
      const key = normalizeDimensionKey(item.dimension);
      if (!key) {
        return;
      }
      leftMap.set(key, { name: item.dimension, score: item.avgScore });
    });

    const rightMap = new Map<string, { name: string; score: number }>();
    compareModel.dimensions2.forEach((item) => {
      const key = normalizeDimensionKey(item.dimension);
      if (!key) {
        return;
      }
      rightMap.set(key, { name: item.dimension, score: item.avgScore });
    });

    const rows = Array.from(leftMap.entries())
      .filter(([key]) => rightMap.has(key))
      .map(([key, left]) => {
        const right = rightMap.get(key)!;
        return {
          name: right.name || left.name,
          left: left.score,
          right: right.score,
          delta: right.score - left.score,
        };
      })
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.name.localeCompare(b.name, "zh-CN"));

    const leftOnly = Array.from(leftMap.entries())
      .filter(([key]) => !rightMap.has(key))
      .map(([, item]) => item.name)
      .sort((a, b) => a.localeCompare(b, "zh-CN"));
    const rightOnly = Array.from(rightMap.entries())
      .filter(([key]) => !leftMap.has(key))
      .map(([, item]) => item.name)
      .sort((a, b) => a.localeCompare(b, "zh-CN"));

    return { rows, leftOnly, rightOnly };
  }, [compareModel]);

  const maxDimensionDelta = useMemo(
    () => Math.max(...dimensionComparison.rows.map((row) => Math.abs(row.delta)), 0.0001),
    [dimensionComparison.rows]
  );

  const primaryScale = useMemo(() => {
    if (!compareModel) {
      return buildScale([0, 1], { floor: 0, minSpan: 1 });
    }
    if (compareModel.runType === "agent_eval") {
      const values = [compareModel.avgScore1, compareModel.avgScore2];
      const normalizedToOne = values.every((value) => value <= 1.2);
      const stable = Math.abs(values[0] - values[1]) < 0.000001;
      if (stable) {
        if (normalizedToOne) {
          return buildScale([0, 1], { floor: 0, ceil: 1, minSpan: 1, minPercent: 0 });
        }
        return buildScale([0, Math.max(values[0], values[1], 1)], { floor: 0, minSpan: 1, minPercent: 0 });
      }
      return buildScale(values, {
        floor: 0,
        ceil: normalizedToOne ? 1 : undefined,
        minSpan: normalizedToOne ? 0.04 : 1,
        minPercent: 0,
      });
    }
    const leftPassRate = calcPassRate(compareModel.summary1, compareModel.passRate1);
    const rightPassRate = calcPassRate(compareModel.summary2, compareModel.passRate2);
    const stable = Math.abs(leftPassRate - rightPassRate) < 0.000001;
    if (stable) {
      return buildScale([0, 100], { floor: 0, ceil: 100, minSpan: 100, minPercent: 0 });
    }
    return buildScale([leftPassRate, rightPassRate], { floor: 0, ceil: 100, minSpan: 8, minPercent: 0 });
  }, [compareModel]);

  const failScale = useMemo(() => {
    if (!compareModel) {
      return buildScale([0, 1], { floor: 0, minSpan: 1 });
    }
    const values = [compareModel.failed1, compareModel.failed2, compareModel.newFailureIds.length, compareModel.fixedCaseIds.length];
    return buildScale(values, { floor: 0, minSpan: 1, minPercent: 0 });
  }, [compareModel]);

  const coreMetricData = useMemo(() => {
    if (!compareModel) {
      return null;
    }
    const leftValue =
      compareModel.runType === "agent_eval"
        ? compareModel.avgScore1
        : calcPassRate(compareModel.summary1, compareModel.passRate1);
    const rightValue =
      compareModel.runType === "agent_eval"
        ? compareModel.avgScore2
        : calcPassRate(compareModel.summary2, compareModel.passRate2);
    const unit = compareModel.runType === "agent_eval" ? "" : "%";
    const digits = compareModel.runType === "agent_eval" ? 3 : 1;

    return {
      leftValue,
      rightValue,
      leftAxisPercent: scaleToAxisPercent(leftValue, primaryScale),
      rightAxisPercent: scaleToAxisPercent(rightValue, primaryScale),
      delta: rightValue - leftValue,
      unit,
      digits,
      ticks: buildAxisTicks(primaryScale, 5),
    };
  }, [compareModel, primaryScale]);

  const coreMetricDisplay = useMemo(() => {
    if (!coreMetricData) {
      return null;
    }
    let left = coreMetricData.leftAxisPercent;
    let right = coreMetricData.rightAxisPercent;
    if (Math.abs(left - right) < 1.4) {
      const shift = 0.85;
      left = Math.max(0, left - shift);
      right = Math.min(100, right + shift);
    }
    return {
      leftAxisPercent: left,
      rightAxisPercent: right,
    };
  }, [coreMetricData]);

  async function refreshProjectCatalog(preferredProjectId?: number | null) {
    const projectItems = await listProjects();
    setProjects(projectItems);
    const nextProjectId =
      preferredProjectId && projectItems.some((item) => item.id === preferredProjectId) ? preferredProjectId : projectItems[0]?.id ?? null;
    setSelectedProjectId(nextProjectId);
    return nextProjectId;
  }

  function findCompatibleRun(targetKind: RunKind, excludedRunId: number): number | null {
    const candidate = runs.find((run) => run.id !== excludedRunId && normalizeRunType(run.run_type) === targetKind);
    return candidate?.id ?? null;
  }

  function alignPair(
    nextRunId1: number | null,
    nextRunId2: number | null,
    pivot: "run1" | "run2"
  ): { alignedRun1: number | null; alignedRun2: number | null; adjusted: boolean } {
    if (!nextRunId1 || !nextRunId2) {
      return { alignedRun1: nextRunId1, alignedRun2: nextRunId2, adjusted: false };
    }

    const kind1 = normalizeRunType(runById.get(nextRunId1)?.run_type);
    const kind2 = normalizeRunType(runById.get(nextRunId2)?.run_type);
    if (kind1 === "unknown" || kind2 === "unknown" || kind1 === kind2) {
      return { alignedRun1: nextRunId1, alignedRun2: nextRunId2, adjusted: false };
    }

    if (pivot === "run1") {
      return {
        alignedRun1: nextRunId1,
        alignedRun2: findCompatibleRun(kind1, nextRunId1),
        adjusted: true,
      };
    }
    return {
      alignedRun1: findCompatibleRun(kind2, nextRunId2),
      alignedRun2: nextRunId2,
      adjusted: true,
    };
  }

  async function refreshRuns(projectId: number) {
    const runItems = await listRuns({ projectId });
    const ordered = runItems.slice().sort((a, b) => b.id - a.id);
    setRuns(ordered);
    const orderedById = new Map(ordered.map((run) => [run.id, run]));

    const currentRun1 = runId1 && ordered.some((item) => item.id === runId1) ? runId1 : null;
    const currentRun2 = runId2 && ordered.some((item) => item.id === runId2) ? runId2 : null;

    let nextRunId1 = currentRun1;
    let nextRunId2 = currentRun2;

    if (!nextRunId1 && !nextRunId2) {
      const pair = pickDefaultPair(ordered);
      nextRunId1 = pair.left;
      nextRunId2 = pair.right;
    } else if (nextRunId1 && !nextRunId2) {
      const kind = normalizeRunType(orderedById.get(nextRunId1)?.run_type);
      if (kind !== "unknown") {
        nextRunId2 = ordered.find((run) => run.id !== nextRunId1 && normalizeRunType(run.run_type) === kind)?.id ?? null;
      }
    } else if (!nextRunId1 && nextRunId2) {
      const kind = normalizeRunType(orderedById.get(nextRunId2)?.run_type);
      if (kind !== "unknown") {
        nextRunId1 = ordered.find((run) => run.id !== nextRunId2 && normalizeRunType(run.run_type) === kind)?.id ?? null;
      }
    }

    if (nextRunId1 && nextRunId2) {
      const kind1 = normalizeRunType(orderedById.get(nextRunId1)?.run_type);
      const kind2 = normalizeRunType(orderedById.get(nextRunId2)?.run_type);
      if (kind1 !== "unknown" && kind2 !== "unknown" && kind1 !== kind2) {
        nextRunId2 = ordered.find((run) => run.id !== nextRunId1 && normalizeRunType(run.run_type) === kind1)?.id ?? null;
      }
    }

    setRunId1(nextRunId1);
    setRunId2(nextRunId2);
    setCompareModel(null);
  }

  async function initialize() {
    setLoading(true);
    try {
      const projectId = await refreshProjectCatalog(selectedProjectId);
      if (!projectId) {
        setRuns([]);
        setRunId1(null);
        setRunId2(null);
        setCompareModel(null);
        return;
      }
      await refreshRuns(projectId);
      setNotice(null);
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "加载对比报告资源失败",
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
      setRuns([]);
      setRunId1(null);
      setRunId2(null);
      setCompareModel(null);
      return;
    }
    setLoading(true);
    void refreshRuns(selectedProjectId)
      .then(() => setNotice(null))
      .catch((error: unknown) =>
        setNotice({
          tone: "error",
          text: error instanceof Error ? error.message : "刷新项目 Run 列表失败",
        })
      )
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId]);

  function onRun1Change(value: string) {
    const nextRunId1 = parseMaybeNumber(value);
    const aligned = alignPair(nextRunId1, runId2, "run1");
    setRunId1(aligned.alignedRun1);
    setRunId2(aligned.alignedRun2);
    setCompareModel(null);
    if (aligned.adjusted) {
      setNotice({ tone: "info", text: "仅支持同类型 Run 对比，已自动切换 run2 可选项。" });
    }
  }

  function onRun2Change(value: string) {
    const nextRunId2 = parseMaybeNumber(value);
    const aligned = alignPair(runId1, nextRunId2, "run2");
    setRunId1(aligned.alignedRun1);
    setRunId2(aligned.alignedRun2);
    setCompareModel(null);
    if (aligned.adjusted) {
      setNotice({ tone: "info", text: "仅支持同类型 Run 对比，已自动切换 run1 可选项。" });
    }
  }

  async function onCompare() {
    if (!runId1 || !runId2) {
      setNotice({ tone: "error", text: "请选择两个 Run 进行对比" });
      return;
    }
    if (runId1 === runId2) {
      setNotice({ tone: "error", text: "run1 与 run2 不能相同" });
      return;
    }

    const kind1 = normalizeRunType(runById.get(runId1)?.run_type);
    const kind2 = normalizeRunType(runById.get(runId2)?.run_type);
    if (kind1 !== "unknown" && kind2 !== "unknown" && kind1 !== kind2) {
      setNotice({ tone: "error", text: "仅支持同类型 Run 对比（agent_eval 对 agent_eval，api_test 对 api_test）。" });
      return;
    }

    setBusy(true);
    try {
      const data = await compareReports(runId1, runId2);
      setCompareModel(parseCompareModel(data));
      setNotice({ tone: "success", text: "对比报告已生成" });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "生成对比报告失败",
      });
    } finally {
      setBusy(false);
    }
  }

  const comparedRun1 = compareModel ? runById.get(compareModel.runId1) ?? null : null;
  const comparedRun2 = compareModel ? runById.get(compareModel.runId2) ?? null : null;

  return (
    <section className="reports-page compare-report-v2">
      <FloatingNotice notice={notice} onClose={() => setNotice(null)} />

      <header className="compare-hero">
        <div>
          <h2 className="m-0">对比分析</h2>
          <p>同类型 Run 指标对比与差异定位，支持维度交集过滤和详细变化追踪。</p>
        </div>
        <span className="compare-hero-tag">Compare Board</span>
      </header>

      <section className="console-panel compare-toolbar">
        <div className="compare-select-wrap">
          <select value={selectedProjectId ?? ""} onChange={(event) => setSelectedProjectId(event.target.value ? Number(event.target.value) : null)}>
            <option value="">选择项目</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <p className="compare-field-hint">先选择项目，再选择需要对比的两个 Run。</p>
        </div>

        <div className="compare-select-wrap">
          <select value={runId1 ?? ""} onChange={(event) => onRun1Change(event.target.value)}>
            <option value="">run1</option>
            {leftRunOptions.map((run) => (
              <option key={`left-${run.id}`} value={run.id}>
                #{run.id} · {runKindText(normalizeRunType(run.run_type))} · {run.status}
              </option>
            ))}
          </select>
          <p className="compare-field-hint">run1 类型：{runKindText(selectedKind1)}</p>
        </div>

        <div className="compare-select-wrap">
          <select value={runId2 ?? ""} onChange={(event) => onRun2Change(event.target.value)}>
            <option value="">run2</option>
            {rightRunOptions.map((run) => (
              <option key={`right-${run.id}`} value={run.id}>
                #{run.id} · {runKindText(normalizeRunType(run.run_type))} · {run.status}
              </option>
            ))}
          </select>
          <p className="compare-field-hint">run2 类型：{runKindText(selectedKind2)}</p>
        </div>

        <button type="button" onClick={() => void onCompare()} disabled={busy || loading} className={primaryButtonClass}>
          {busy ? "对比中..." : "生成对比"}
        </button>
      </section>

      {!compareModel ? (
        <section className="console-panel compare-empty-panel">请选择两个同类型 Run 后生成对比结果。</section>
      ) : (
        <>
          <section className="compare-kpi-grid">
            <article className="compare-kpi-card">
              <span className="compare-kpi-label">Run#{compareModel.runId1}</span>
              <strong className="compare-kpi-value">
                {compareModel.runType === "agent_eval"
                  ? compareModel.avgScore1.toFixed(3)
                  : `${calcPassRate(compareModel.summary1, compareModel.passRate1).toFixed(1)}%`}
              </strong>
              <span className="compare-kpi-caption">
                {compareModel.runType === "agent_eval" ? "avg_score" : "pass_rate"} · {comparedRun1?.status ?? "-"}
              </span>
            </article>

            <article className="compare-kpi-card">
              <span className="compare-kpi-label">Run#{compareModel.runId2}</span>
              <strong className="compare-kpi-value">
                {compareModel.runType === "agent_eval"
                  ? compareModel.avgScore2.toFixed(3)
                  : `${calcPassRate(compareModel.summary2, compareModel.passRate2).toFixed(1)}%`}
              </strong>
              <span className="compare-kpi-caption">
                {compareModel.runType === "agent_eval" ? "avg_score" : "pass_rate"} · {comparedRun2?.status ?? "-"}
              </span>
            </article>

            <article className="compare-kpi-card">
              <span className="compare-kpi-label">核心指标变化</span>
              <strong className="compare-kpi-value">
                {compareModel.runType === "agent_eval"
                  ? formatSigned(compareModel.avgScore2 - compareModel.avgScore1, 3)
                  : `${formatSigned(calcPassRate(compareModel.summary2, compareModel.passRate2) - calcPassRate(compareModel.summary1, compareModel.passRate1), 1)}%`}
              </strong>
              <span className="compare-kpi-caption">{compareModel.runType === "agent_eval" ? "avg_score_delta" : "pass_rate_delta"}</span>
            </article>

            <article className="compare-kpi-card">
              <span className="compare-kpi-label">异常变化</span>
              <strong className="compare-kpi-value">{compareModel.newFailureIds.length + compareModel.fixedCaseIds.length}</strong>
              <span className="compare-kpi-caption">
                新增失败 {compareModel.newFailureIds.length} · 已修复 {compareModel.fixedCaseIds.length}
              </span>
            </article>
          </section>

          <section className="compare-board-grid">
            <article className="compare-card">
              <header className="compare-card-header compare-core-header">
                <div>
                  <h3>核心指标对比图</h3>
                  <p>统一量纲下对比两次 Run 的核心指标差距</p>
                </div>
                <span className="compare-range-badge">
                  范围 {primaryScale.min.toFixed(compareModel.runType === "agent_eval" ? 3 : 1)} ~{" "}
                  {primaryScale.max.toFixed(compareModel.runType === "agent_eval" ? 3 : 1)}
                  {compareModel.runType === "agent_eval" ? "" : "%"}
                </span>
              </header>

              {coreMetricData ? (
                <div className="compare-core-chart">
                  <div className="compare-core-axis">
                    {coreMetricData.ticks.map((tick, index) => (
                      <div
                        key={`tick-${index}`}
                        className={`compare-core-axis-tick ${index === 0 ? "first" : ""} ${index === coreMetricData.ticks.length - 1 ? "last" : ""}`}
                        style={{ left: `${tick.percent}%` }}
                      >
                        <span>{formatMetricValue(tick.value, coreMetricData.digits, coreMetricData.unit)}</span>
                      </div>
                    ))}
                  </div>

                  <div className="compare-core-dumbbell">
                    <div className="compare-core-dumbbell-track" />
                    <div
                      className="compare-core-dumbbell-span"
                      style={{
                        left: `${Math.min(coreMetricDisplay?.leftAxisPercent ?? coreMetricData.leftAxisPercent, coreMetricDisplay?.rightAxisPercent ?? coreMetricData.rightAxisPercent)}%`,
                        width: `${Math.max(2, Math.abs((coreMetricDisplay?.leftAxisPercent ?? coreMetricData.leftAxisPercent) - (coreMetricDisplay?.rightAxisPercent ?? coreMetricData.rightAxisPercent)))}%`,
                      }}
                    />
                    <div className="compare-core-point left" style={{ left: `${coreMetricDisplay?.leftAxisPercent ?? coreMetricData.leftAxisPercent}%` }}>
                      <em>Run#{compareModel.runId1}</em>
                      <strong>
                        {formatMetricValue(coreMetricData.leftValue, coreMetricData.digits, coreMetricData.unit)}
                      </strong>
                    </div>
                    <div className="compare-core-point right" style={{ left: `${coreMetricDisplay?.rightAxisPercent ?? coreMetricData.rightAxisPercent}%` }}>
                      <em>Run#{compareModel.runId2}</em>
                      <strong>
                        {formatMetricValue(coreMetricData.rightValue, coreMetricData.digits, coreMetricData.unit)}
                      </strong>
                    </div>
                  </div>

                  <div className="compare-core-delta">
                    <span>差值</span>
                    <strong className={coreMetricData.delta > 0 ? "delta-up" : coreMetricData.delta < 0 ? "delta-down" : "delta-flat"}>
                      {formatSigned(coreMetricData.delta, coreMetricData.digits)}
                      {coreMetricData.unit}
                    </strong>
                  </div>

                  {[
                    {
                      label: `Run#${compareModel.runId1}`,
                      value: coreMetricData.leftValue,
                      text: `${coreMetricData.leftValue.toFixed(coreMetricData.digits)}${coreMetricData.unit}`,
                      tone: "left",
                    },
                    {
                      label: `Run#${compareModel.runId2}`,
                      value: coreMetricData.rightValue,
                      text: `${coreMetricData.rightValue.toFixed(coreMetricData.digits)}${coreMetricData.unit}`,
                      tone: "right",
                    },
                  ].map((entry) => (
                    <div key={entry.label} className="compare-metric-row">
                      <div className="compare-metric-row-head">
                        <span>{entry.label}</span>
                        <strong>{entry.text}</strong>
                      </div>
                      <div className="compare-meter-track">
                        <div className={`compare-meter-fill ${entry.tone}`} style={{ width: `${primaryScale.toPercent(entry.value)}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </article>

            <article className="compare-card">
              <header className="compare-card-header">
                <div>
                  <h3>{compareModel.runType === "agent_eval" ? "维度变化明细" : "失败相关指标"}</h3>
                  <p>{compareModel.runType === "agent_eval" ? "按变化幅度从高到低排序" : "失败规模及修复变化"}</p>
                </div>
              </header>

              {compareModel.runType === "agent_eval" ? (
                <>
                  <div className="compare-dimension-filter-note">
                    仅比较两次 Run 的公共维度：{dimensionComparison.rows.length} 项
                    {dimensionComparison.leftOnly.length > 0 || dimensionComparison.rightOnly.length > 0
                      ? `（已过滤 Run#${compareModel.runId1} 独有 ${dimensionComparison.leftOnly.length} 项，Run#${compareModel.runId2} 独有 ${dimensionComparison.rightOnly.length} 项）`
                      : ""}
                  </div>
                  {dimensionComparison.rows.length === 0 ? (
                    <div className="compare-empty-inline">未找到可对齐的公共维度（请确认两次 Run 的评分规则是否一致）。</div>
                  ) : (
                    <div className="compare-dimension-table">
                      <div className="compare-dimension-row compare-dimension-head">
                        <span>维度</span>
                        <span>Run1</span>
                        <span>Run2</span>
                        <span>Delta</span>
                        <span>趋势</span>
                      </div>
                      {dimensionComparison.rows.map((row) => (
                        <div key={row.name} className="compare-dimension-row">
                          <span>{row.name}</span>
                          <span>{row.left.toFixed(3)}</span>
                          <span>{row.right.toFixed(3)}</span>
                          <span className={row.delta > 0 ? "delta-up" : row.delta < 0 ? "delta-down" : "delta-flat"}>
                            {formatSigned(row.delta, 3)}
                          </span>
                          <div className="compare-delta-track">
                            <div
                              className={`compare-delta-fill ${row.delta >= 0 ? "up" : "down"}`}
                              style={{ width: `${Math.max(2, (Math.abs(row.delta) / maxDimensionDelta) * 100)}%` }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <div className="compare-metric-stack">
                  {[
                    { label: "失败数 Run#1", value: compareModel.failed1 },
                    { label: "失败数 Run#2", value: compareModel.failed2 },
                    { label: "新增失败", value: compareModel.newFailureIds.length },
                    { label: "已修复", value: compareModel.fixedCaseIds.length },
                  ].map((row) => (
                    <div key={row.label} className="compare-metric-row">
                      <div className="compare-metric-row-head">
                        <span>{row.label}</span>
                        <strong>{row.value}</strong>
                      </div>
                      <div className="compare-meter-track">
                        <div className="compare-meter-fill right" style={{ width: `${failScale.toPercent(row.value)}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </article>
          </section>

          <section className="compare-card compare-detail-card">
            <header className="compare-card-header">
              <div>
                <h3>详细信息</h3>
                <p>包含计数变化、case 列表和原始返回，便于排查。</p>
              </div>
            </header>

            <div className="compare-detail-grid">
              <article className="compare-detail-item">
                <strong>Run 元信息</strong>
                <div>Run# {compareModel.runId1} · {comparedRun1?.status ?? "-"} · {formatDate(comparedRun1?.created_at)}</div>
                <div>Run# {compareModel.runId2} · {comparedRun2?.status ?? "-"} · {formatDate(comparedRun2?.created_at)}</div>
                <div>类型：{runKindText(compareModel.runType)}</div>
              </article>

              <article className="compare-detail-item">
                <strong>总览计数变化</strong>
                <div>
                  total: {compareModel.summary1.total} → {compareModel.summary2.total} ({formatSigned(compareModel.delta.totalDelta, 0)})
                </div>
                <div>
                  passed: {compareModel.summary1.passed} → {compareModel.summary2.passed} ({formatSigned(compareModel.delta.passedDelta, 0)})
                </div>
                <div>
                  failed: {compareModel.summary1.failed} → {compareModel.summary2.failed} ({formatSigned(compareModel.delta.failedDelta, 0)})
                </div>
              </article>

              <article className="compare-detail-item compare-case-list">
                <strong>新增失败 case</strong>
                <p>{formatCaseList(compareModel.newFailureIds)}</p>
              </article>

              <article className="compare-detail-item compare-case-list">
                <strong>已修复 case</strong>
                <p>{formatCaseList(compareModel.fixedCaseIds)}</p>
              </article>
            </div>

            <details className="compare-raw-json">
              <summary>查看原始对比 JSON</summary>
              <pre>{toPretty(compareModel.rawPayload)}</pre>
            </details>
          </section>
        </>
      )}
    </section>
  );
}
