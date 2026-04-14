import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { FloatingNotice, type NoticeTone } from "../../components/FloatingNotice";
import { ProjectRecord, SuiteRecord, listProjects, listSuites } from "../../services/assetService";
import {
  ProjectDashboardReport,
  RunReport,
  SuiteAnalyticsReport,
  compareReports,
  exportRunHtml,
  getProjectDashboardReport,
  getRunReport,
  getSuiteAnalyticsReport,
} from "../../services/reportService";
import { RunRecord, listRuns } from "../../services/runService";

const panelStyle: CSSProperties = {
  borderRadius: 12,
  padding: 16,
  background: "#ffffff",
  border: "1px solid #E5E7EB",
  boxShadow: "none",
};

function parseMaybeNumber(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const next = Number(value);
  return Number.isInteger(next) && next > 0 ? next : null;
}

function toNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPretty(value: unknown): string {
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

function runTypeLabel(value: string | undefined): string {
  if (value === "agent_eval") {
    return "benchmark";
  }
  return "api_test";
}

function fmtPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function fmtScore(value: number | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "-";
  }
  return value.toFixed(3);
}

function scoreToPercent(score: number): number {
  if (!Number.isFinite(score)) {
    return 0;
  }
  const normalized = score <= 1 ? score * 100 : score;
  return Math.max(0, Math.min(100, normalized));
}

function formatDate(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }
  return value.replace("T", " ").slice(0, 19);
}

export function ReportsCenter() {
  const [searchParams, setSearchParams] = useSearchParams();

  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [suites, setSuites] = useState<SuiteRecord[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);

  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(() => parseMaybeNumber(searchParams.get("projectId")));
  const [selectedSuiteId, setSelectedSuiteId] = useState<number | null>(() => parseMaybeNumber(searchParams.get("suiteId")));
  const [selectedRunId, setSelectedRunId] = useState<number | null>(() => parseMaybeNumber(searchParams.get("runId")));
  const [selectedTimeRange, setSelectedTimeRange] = useState("7d");

  const [compareRunId1, setCompareRunId1] = useState<number | null>(null);
  const [compareRunId2, setCompareRunId2] = useState<number | null>(null);

  const [projectReport, setProjectReport] = useState<ProjectDashboardReport | null>(null);
  const [suiteReport, setSuiteReport] = useState<SuiteAnalyticsReport | null>(null);
  const [runReport, setRunReport] = useState<RunReport | null>(null);
  const [compareResult, setCompareResult] = useState<Record<string, unknown> | null>(null);
  const [lastExportUrl, setLastExportUrl] = useState<string>("");

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: NoticeTone; text: string } | null>(null);

  const selectedRun = useMemo(() => runs.find((run) => run.id === selectedRunId) ?? null, [runs, selectedRunId]);

  const projectKpis = useMemo(() => {
    if (!projectReport) {
      return {
        runCount: 0,
        avgPassRate: 0,
        avgScore: 0,
      };
    }
    const runCount = projectReport.api.passRateTrend.length + projectReport.benchmark.avgScoreTrend.length;
    const avgPassRate =
      projectReport.api.passRateTrend.length > 0
        ? projectReport.api.passRateTrend.reduce((sum, point) => sum + point.passRate, 0) / projectReport.api.passRateTrend.length
        : 0;
    const avgScore =
      projectReport.benchmark.avgScoreTrend.length > 0
        ? projectReport.benchmark.avgScoreTrend.reduce((sum, point) => sum + point.avgScore, 0) /
          projectReport.benchmark.avgScoreTrend.length
        : 0;
    return {
      runCount,
      avgPassRate,
      avgScore,
    };
  }, [projectReport]);

  const compareModel = useMemo(() => {
    if (!compareResult || !isRecord(compareResult)) {
      return null;
    }
    const metrics = isRecord(compareResult.metrics) ? compareResult.metrics : {};
    const summary1 = isRecord(compareResult.summary1) ? compareResult.summary1 : {};
    const summary2 = isRecord(compareResult.summary2) ? compareResult.summary2 : {};
    const runType = typeof compareResult.runType === "string" ? compareResult.runType : "api_test";
    return {
      runId1: toNumber(compareResult.runId1),
      runId2: toNumber(compareResult.runId2),
      runType,
      summary1: {
        total: toNumber(summary1.total),
        passed: toNumber(summary1.passed),
        failed: toNumber(summary1.failed),
      },
      summary2: {
        total: toNumber(summary2.total),
        passed: toNumber(summary2.passed),
        failed: toNumber(summary2.failed),
      },
      passRate1: toNumber(metrics.passRate1),
      passRate2: toNumber(metrics.passRate2),
      avgScore1: toNumber(metrics.avgScore1),
      avgScore2: toNumber(metrics.avgScore2),
      failed1: toNumber(metrics.failed1),
      failed2: toNumber(metrics.failed2),
      dimensions1: Array.isArray(metrics.dimensions1) ? metrics.dimensions1 : [],
      dimensions2: Array.isArray(metrics.dimensions2) ? metrics.dimensions2 : [],
      newFailures: Array.isArray(compareResult.newFailures) ? compareResult.newFailures.length : 0,
      fixedCases: Array.isArray(compareResult.fixedCases) ? compareResult.fixedCases.length : 0,
    };
  }, [compareResult]);

  const compareDimensionRows = useMemo(() => {
    if (!compareModel || compareModel.runType !== "agent_eval") {
      return [];
    }
    const byName = new Map<string, { left: number; right: number }>();
    compareModel.dimensions1
      .filter(isRecord)
      .forEach((dim) => {
        const name = typeof dim.dimension === "string" ? dim.dimension : "dimension";
        const current = byName.get(name) ?? { left: 0, right: 0 };
        current.left = toNumber(dim.avgScore);
        byName.set(name, current);
      });
    compareModel.dimensions2
      .filter(isRecord)
      .forEach((dim) => {
        const name = typeof dim.dimension === "string" ? dim.dimension : "dimension";
        const current = byName.get(name) ?? { left: 0, right: 0 };
        current.right = toNumber(dim.avgScore);
        byName.set(name, current);
      });
    return Array.from(byName.entries())
      .map(([name, value]) => ({ name, left: value.left, right: value.right }))
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }, [compareModel]);

  async function refreshProjectCatalog(preferredProjectId?: number | null) {
    const projectItems = await listProjects();
    setProjects(projectItems);
    const nextProjectId =
      preferredProjectId && projectItems.some((item) => item.id === preferredProjectId) ? preferredProjectId : projectItems[0]?.id ?? null;
    setSelectedProjectId(nextProjectId);
    return nextProjectId;
  }

  async function refreshProjectContext(projectId: number) {
    const [suiteItems, runItems] = await Promise.all([listSuites(projectId), listRuns({ projectId })]);
    const orderedRuns = runItems.slice().sort((a, b) => b.id - a.id);
    setSuites(suiteItems);
    setRuns(orderedRuns);

    setSelectedSuiteId((prev) => (prev && suiteItems.some((item) => item.id === prev) ? prev : suiteItems[0]?.id ?? null));
    setSelectedRunId((prev) => {
      if (prev && orderedRuns.some((item) => item.id === prev)) {
        return prev;
      }
      return orderedRuns[0]?.id ?? null;
    });

    if (orderedRuns.length >= 2) {
      setCompareRunId1((prev) => (prev && orderedRuns.some((item) => item.id === prev) ? prev : orderedRuns[1].id));
      setCompareRunId2((prev) => (prev && orderedRuns.some((item) => item.id === prev) ? prev : orderedRuns[0].id));
    } else if (orderedRuns.length === 1) {
      setCompareRunId1(orderedRuns[0].id);
      setCompareRunId2(null);
    } else {
      setCompareRunId1(null);
      setCompareRunId2(null);
    }
  }

  async function refreshProjectReport(projectId: number) {
    const data = await getProjectDashboardReport(projectId);
    setProjectReport(data);
  }

  async function refreshSuiteReport(suiteId: number) {
    const data = await getSuiteAnalyticsReport(suiteId);
    setSuiteReport(data);
  }

  async function refreshRunReport(runId: number) {
    const data = await getRunReport(runId);
    setRunReport(data);
  }

  async function refreshCompareReport(runId1: number, runId2: number) {
    const data = await compareReports(runId1, runId2);
    setCompareResult(data);
  }

  async function initialize() {
    setLoading(true);
    try {
      const projectId = await refreshProjectCatalog(selectedProjectId);
      if (!projectId) {
        setSuites([]);
        setRuns([]);
        setProjectReport(null);
        setSuiteReport(null);
        setRunReport(null);
        setCompareResult(null);
        return;
      }
      await refreshProjectContext(projectId);
      await refreshProjectReport(projectId);
      setNotice(null);
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "加载报告中心资源失败",
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
      setRuns([]);
      setProjectReport(null);
      setSuiteReport(null);
      setRunReport(null);
      setCompareResult(null);
      return;
    }
    setLoading(true);
    Promise.all([refreshProjectContext(selectedProjectId), refreshProjectReport(selectedProjectId)])
      .catch((error: unknown) => {
        setNotice({
          tone: "error",
          text: error instanceof Error ? error.message : "刷新项目报告失败",
        });
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedSuiteId) {
      setSuiteReport(null);
      return;
    }
    setLoading(true);
    void refreshSuiteReport(selectedSuiteId)
      .catch((error: unknown) => {
        setNotice({
          tone: "error",
          text: error instanceof Error ? error.message : "刷新 Suite 报告失败",
        });
      })
      .finally(() => setLoading(false));
  }, [selectedSuiteId]);

  useEffect(() => {
    if (!selectedRunId) {
      setRunReport(null);
      return;
    }
    setLoading(true);
    void refreshRunReport(selectedRunId)
      .catch((error: unknown) => {
        setNotice({
          tone: "error",
          text: error instanceof Error ? error.message : "刷新 Run 报告失败",
        });
      })
      .finally(() => setLoading(false));
  }, [selectedRunId]);

  useEffect(() => {
    const next = new URLSearchParams();
    if (selectedProjectId) {
      next.set("projectId", String(selectedProjectId));
    }
    if (selectedSuiteId) {
      next.set("suiteId", String(selectedSuiteId));
    }
    if (selectedRunId) {
      next.set("runId", String(selectedRunId));
    }
    setSearchParams(next, { replace: true });
  }, [selectedProjectId, selectedSuiteId, selectedRunId, setSearchParams]);

  async function onRefresh() {
    await initialize();
  }

  async function onCompare() {
    if (!compareRunId1 || !compareRunId2) {
      setNotice({ tone: "error", text: "请先选择两条 run 进行对比" });
      return;
    }
    setBusy(true);
    try {
      await refreshCompareReport(compareRunId1, compareRunId2);
      setNotice({ tone: "success", text: `对比完成：#${compareRunId1} vs #${compareRunId2}` });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "生成对比报告失败",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onExportRunHtml() {
    if (!selectedRunId) {
      setNotice({ tone: "error", text: "请先选择 Run" });
      return;
    }
    setBusy(true);
    try {
      const data = await exportRunHtml(selectedRunId);
      setLastExportUrl(data.fileUrl);
      setNotice({ tone: "success", text: `HTML 报告导出成功：${data.fileUrl}` });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "导出 HTML 失败",
      });
    } finally {
      setBusy(false);
    }
  }

  const runType =
    typeof runReport?.runType === "string"
      ? runReport.runType
      : typeof runReport?.overview?.runType === "string"
        ? runReport.overview.runType
        : undefined;

  const runDetailItems = runReport?.detail?.items ?? [];

  return (
    <section style={{ display: "grid", gap: 14 }}>
      <FloatingNotice notice={notice} onClose={() => setNotice(null)} />
      <header style={{ display: "grid", gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 36 }}>报告中心</h2>
      </header>

      <section style={{ ...panelStyle, display: "grid", gap: 10 }}>
        <strong style={{ fontSize: 18 }}>筛选上下文</strong>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr auto", gap: 8 }}>
          <select
            value={selectedProjectId ?? ""}
            onChange={(event) => setSelectedProjectId(event.target.value ? Number(event.target.value) : null)}
            disabled={projects.length === 0}
            style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
          >
            <option value="">项目</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <select
            value={selectedSuiteId ?? ""}
            onChange={(event) => setSelectedSuiteId(event.target.value ? Number(event.target.value) : null)}
            disabled={suites.length === 0}
            style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
          >
            <option value="">Suite</option>
            {suites.map((suite) => (
              <option key={suite.id} value={suite.id}>
                {suite.name}
              </option>
            ))}
          </select>
          <select
            value={selectedRunId ?? ""}
            onChange={(event) => setSelectedRunId(event.target.value ? Number(event.target.value) : null)}
            disabled={runs.length === 0}
            style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
          >
            <option value="">Run</option>
            {runs.map((run) => (
              <option key={run.id} value={run.id}>
                #{run.id} · {runTypeLabel(run.run_type)} · {run.status}
              </option>
            ))}
          </select>
          <select
            value={selectedTimeRange}
            onChange={(event) => setSelectedTimeRange(event.target.value)}
            style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
          >
            <option value="7d">最近7天</option>
            <option value="14d">最近14天</option>
            <option value="30d">最近30天</option>
          </select>
          <button
            type="button"
            onClick={() => void onRefresh()}
            disabled={loading}
            style={{
              border: "none",
              borderRadius: 10,
              padding: "9px 14px",
              background: "#1f2527",
              color: "#fff8eb",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {loading ? "刷新中..." : "刷新"}
          </button>
        </div>
      </section>

      <section style={{ ...panelStyle, display: "grid", gap: 12 }}>
        <strong style={{ fontSize: 18 }}>项目报告（Project Dashboard）</strong>
        {!projectReport ? (
          <div style={{ color: "#667173" }}>暂无项目报告数据</div>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 8 }}>
              <div style={{ borderRadius: 10, background: "rgba(31,37,39,0.05)", padding: "10px 12px" }}>运行次数：{projectKpis.runCount}</div>
              <div style={{ borderRadius: 10, background: "rgba(31,37,39,0.05)", padding: "10px 12px" }}>
                平均通过率：{fmtPercent(projectKpis.avgPassRate)}
              </div>
              <div style={{ borderRadius: 10, background: "rgba(31,37,39,0.05)", padding: "10px 12px" }}>
                平均分：{projectKpis.avgScore.toFixed(3)}
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div style={{ borderRadius: 12, border: "1px solid rgba(31,37,39,0.1)", padding: 10, display: "grid", gap: 8 }}>
                <div style={{ fontWeight: 700 }}>API 通过率趋势</div>
                {projectReport.api.passRateTrend.length === 0 ? (
                  <span style={{ color: "#667173" }}>暂无 API 趋势</span>
                ) : (
                  projectReport.api.passRateTrend.slice(-8).map((point) => (
                    <div key={point.runId} style={{ display: "grid", gap: 3 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#5f6a6c" }}>
                        <span>Run #{point.runId}</span>
                        <span>{fmtPercent(point.passRate)}</span>
                      </div>
                      <div style={{ borderRadius: 8, background: "rgba(31,37,39,0.08)", height: 8, overflow: "hidden" }}>
                        <div style={{ width: `${Math.max(0, Math.min(100, point.passRate))}%`, height: "100%", background: "#3a7ec2" }} />
                      </div>
                    </div>
                  ))
                )}
              </div>

              <div style={{ borderRadius: 12, border: "1px solid rgba(31,37,39,0.1)", padding: 10, display: "grid", gap: 8 }}>
                <div style={{ fontWeight: 700 }}>Benchmark 平均分趋势</div>
                {projectReport.benchmark.avgScoreTrend.length === 0 ? (
                  <span style={{ color: "#667173" }}>暂无 Benchmark 趋势</span>
                ) : (
                  projectReport.benchmark.avgScoreTrend.slice(-8).map((point) => (
                    <div key={point.runId} style={{ display: "grid", gap: 3 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#5f6a6c" }}>
                        <span>Run #{point.runId}</span>
                        <span>{point.avgScore.toFixed(3)}</span>
                      </div>
                      <div style={{ borderRadius: 8, background: "rgba(31,37,39,0.08)", height: 8, overflow: "hidden" }}>
                        <div style={{ width: `${scoreToPercent(point.avgScore)}%`, height: "100%", background: "#3a7ec2" }} />
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div style={{ borderRadius: 12, border: "1px solid rgba(31,37,39,0.1)", padding: 10 }}>
              <div style={{ fontWeight: 700 }}>Suite 列表</div>
              <div style={{ marginTop: 8, overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 680 }}>
                  <thead>
                    <tr style={{ textAlign: "left", borderBottom: "1px solid rgba(31,37,39,0.12)" }}>
                      <th style={{ padding: "7px 6px" }}>suite</th>
                      <th style={{ padding: "7px 6px" }}>pass_rate</th>
                      <th style={{ padding: "7px 6px" }}>avg_score</th>
                      <th style={{ padding: "7px 6px" }}>趋势</th>
                    </tr>
                  </thead>
                  <tbody>
                    {projectReport.suites.length === 0 ? (
                      <tr>
                        <td colSpan={4} style={{ padding: "9px 6px", color: "#667173" }}>
                          暂无 Suite 汇总
                        </td>
                      </tr>
                    ) : (
                      projectReport.suites.map((suite) => (
                        <tr key={suite.suiteId} style={{ borderBottom: "1px solid rgba(31,37,39,0.08)" }}>
                          <td style={{ padding: "7px 6px" }}>
                            {suite.suiteName} (#{suite.suiteId})
                          </td>
                          <td style={{ padding: "7px 6px" }}>{fmtPercent(suite.passRate)}</td>
                          <td style={{ padding: "7px 6px" }}>{fmtScore(suite.avgScore)}</td>
                          <td style={{ padding: "7px 6px" }}>{suite.trend}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </section>

      <section style={{ ...panelStyle, display: "grid", gap: 12 }}>
        <strong style={{ fontSize: 18 }}>Suite 报告（Suite Analytics）</strong>
        {!suiteReport ? (
          <div style={{ color: "#667173" }}>请选择 Suite 查看分析数据</div>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 10 }}>
              <div style={{ borderRadius: 12, border: "1px solid rgba(31,37,39,0.1)", padding: 10 }}>
                <div style={{ fontWeight: 700 }}>Run 历史</div>
                <div style={{ marginTop: 8, overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
                    <thead>
                      <tr style={{ textAlign: "left", borderBottom: "1px solid rgba(31,37,39,0.12)" }}>
                        <th style={{ padding: "7px 6px" }}>run</th>
                        <th style={{ padding: "7px 6px" }}>type</th>
                        <th style={{ padding: "7px 6px" }}>status</th>
                        <th style={{ padding: "7px 6px" }}>pass_rate</th>
                        <th style={{ padding: "7px 6px" }}>avg_score</th>
                      </tr>
                    </thead>
                    <tbody>
                      {suiteReport.runHistory.length === 0 ? (
                        <tr>
                          <td colSpan={5} style={{ padding: "9px 6px", color: "#667173" }}>
                            暂无 Run 历史
                          </td>
                        </tr>
                      ) : (
                        suiteReport.runHistory.map((run) => (
                          <tr key={run.runId} style={{ borderBottom: "1px solid rgba(31,37,39,0.08)" }}>
                            <td style={{ padding: "7px 6px" }}>#{run.runId}</td>
                            <td style={{ padding: "7px 6px" }}>{runTypeLabel(run.runType)}</td>
                            <td style={{ padding: "7px 6px" }}>{run.status}</td>
                            <td style={{ padding: "7px 6px" }}>{typeof run.passRate === "number" ? fmtPercent(run.passRate) : "-"}</td>
                            <td style={{ padding: "7px 6px" }}>{fmtScore(run.avgScore)}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div style={{ borderRadius: 12, border: "1px solid rgba(31,37,39,0.1)", padding: 10, display: "grid", gap: 10 }}>
                <div>
                  <div style={{ fontWeight: 700 }}>Top 失败 Case</div>
                  <div style={{ marginTop: 6, color: "#5f6a6c" }}>
                    {suiteReport.api.topFailedCases.length === 0
                      ? "暂无失败 case"
                      : suiteReport.api.topFailedCases.map((item) => `${item.caseName}(${item.failedCount})`).join("，")}
                  </div>
                </div>
                <div>
                  <div style={{ fontWeight: 700 }}>错误类型分布</div>
                  <div style={{ marginTop: 6, color: "#5f6a6c" }}>
                    {suiteReport.api.errorTypeDistribution.length === 0
                      ? "暂无错误类型"
                      : suiteReport.api.errorTypeDistribution.map((item) => `${item.name}:${item.value}`).join("，")}
                  </div>
                </div>
                <div>
                  <div style={{ fontWeight: 700 }}>低分 Case</div>
                  <div style={{ marginTop: 6, color: "#5f6a6c" }}>
                    {suiteReport.benchmark.lowScoreCases.length === 0
                      ? "暂无低分 case"
                      : suiteReport.benchmark.lowScoreCases
                          .slice(0, 6)
                          .map((item) => `${item.caseName}(${item.score.toFixed(2)})`)
                          .join("，")}
                  </div>
                </div>
              </div>
            </div>

            <div style={{ borderRadius: 12, border: "1px solid rgba(31,37,39,0.1)", padding: 10 }}>
              <div style={{ fontWeight: 700 }}>Benchmark 维度趋势</div>
              <div style={{ marginTop: 8, overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
                  <thead>
                    <tr style={{ textAlign: "left", borderBottom: "1px solid rgba(31,37,39,0.12)" }}>
                      <th style={{ padding: "7px 6px" }}>run</th>
                      <th style={{ padding: "7px 6px" }}>维度评分</th>
                    </tr>
                  </thead>
                  <tbody>
                    {suiteReport.benchmark.dimensionTrend.length === 0 ? (
                      <tr>
                        <td colSpan={2} style={{ padding: "9px 6px", color: "#667173" }}>
                          暂无维度趋势
                        </td>
                      </tr>
                    ) : (
                      suiteReport.benchmark.dimensionTrend.map((point) => (
                        <tr key={point.runId} style={{ borderBottom: "1px solid rgba(31,37,39,0.08)" }}>
                          <td style={{ padding: "7px 6px" }}>#{point.runId}</td>
                          <td style={{ padding: "7px 6px" }}>
                            {point.dimensions.length === 0
                              ? "-"
                              : point.dimensions.map((dim) => `${dim.dimension}:${fmtScore(dim.avgScore)}`).join(" | ")}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </section>

      <section style={{ ...panelStyle, display: "grid", gap: 12 }}>
        <strong style={{ fontSize: 18 }}>Run 报告（Run Report）</strong>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => selectedRunId && void refreshRunReport(selectedRunId)}
            disabled={!selectedRunId || busy}
            style={{
              border: "1px solid rgba(31,37,39,0.2)",
              borderRadius: 10,
              padding: "8px 12px",
              background: "#fff",
              cursor: "pointer",
              fontWeight: 700,
            }}
          >
            刷新 Run 报告
          </button>
          <button
            type="button"
            onClick={() => void onExportRunHtml()}
            disabled={!selectedRunId || busy}
            style={{
              border: "none",
              borderRadius: 10,
              padding: "8px 12px",
              background: "#bf5d36",
              color: "#fff8eb",
              cursor: "pointer",
              fontWeight: 700,
            }}
          >
            导出 HTML 报告
          </button>
          {lastExportUrl ? <span style={{ color: "#5f6a6c" }}>导出地址：{lastExportUrl}</span> : null}
          {selectedRun ? (
            <Link to={`/results/detail?runId=${selectedRun.id}`} style={{ color: "#8a3f1f", fontWeight: 700 }}>
              前往运行结果查看 Run #{selectedRun.id}
            </Link>
          ) : null}
        </div>

        {!runReport ? (
          <div style={{ color: "#667173" }}>请选择 Run 查看报告。</div>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0,1fr))", gap: 8 }}>
              <div style={{ borderRadius: 10, background: "rgba(31,37,39,0.05)", padding: "8px 10px" }}>run: #{runReport.runId}</div>
              <div style={{ borderRadius: 10, background: "rgba(31,37,39,0.05)", padding: "8px 10px" }}>
                type: {runTypeLabel(runType)}
              </div>
              <div style={{ borderRadius: 10, background: "rgba(31,37,39,0.05)", padding: "8px 10px" }}>status: {runReport.status}</div>
              <div style={{ borderRadius: 10, background: "rgba(31,37,39,0.05)", padding: "8px 10px" }}>
                total/passed/failed: {runReport.summary.total}/{runReport.summary.passed}/{runReport.summary.failed}
              </div>
              <div style={{ borderRadius: 10, background: "rgba(31,37,39,0.05)", padding: "8px 10px" }}>
                pass_rate: {runReport.summary.total > 0 ? fmtPercent((runReport.summary.passed / runReport.summary.total) * 100) : "0.0%"}
              </div>
            </div>

            <div style={{ borderRadius: 12, border: "1px solid rgba(31,37,39,0.1)", padding: 10 }}>
              <div style={{ fontWeight: 700 }}>对比信息摘要</div>
              <div style={{ marginTop: 8, color: "#5f6a6c" }}>
                {!runReport.comparison || !isRecord(runReport.comparison)
                  ? "暂无对比信息"
                  : `run#${toNumber(runReport.comparison.runId1)} vs run#${toNumber(runReport.comparison.runId2)}，new_failures ${
                      Array.isArray(runReport.comparison.newFailures) ? runReport.comparison.newFailures.length : 0
                    }，fixed_cases ${Array.isArray(runReport.comparison.fixedCases) ? runReport.comparison.fixedCases.length : 0}`}
              </div>
            </div>

            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1120 }}>
                <thead>
                  <tr style={{ textAlign: "left", borderBottom: "1px solid rgba(31,37,39,0.12)" }}>
                    <th style={{ padding: "9px 8px" }}>case_name</th>
                    <th style={{ padding: "9px 8px" }}>status</th>
                    {runType === "agent_eval" ? (
                      <>
                        <th style={{ padding: "9px 8px" }}>score</th>
                        <th style={{ padding: "9px 8px" }}>dimensions</th>
                      </>
                    ) : (
                      <>
                        <th style={{ padding: "9px 8px" }}>assertion</th>
                        <th style={{ padding: "9px 8px" }}>latency</th>
                      </>
                    )}
                    <th style={{ padding: "9px 8px" }}>error</th>
                  </tr>
                </thead>
                <tbody>
                  {runDetailItems.length === 0 ? (
                    <tr>
                      <td colSpan={5} style={{ padding: "12px 8px", color: "#667173" }}>
                        暂无 run_item 数据
                      </td>
                    </tr>
                  ) : (
                    runDetailItems.map((item) => {
                      const score = isRecord(item.score_result) && typeof item.score_result.total_score === "number" ? item.score_result.total_score : null;
                      const dimensions =
                        isRecord(item.score_result) && Array.isArray(item.score_result.dimensions)
                          ? item.score_result.dimensions
                              .filter(isRecord)
                              .map((dim) => `${dim.name}:${typeof dim.score === "number" ? dim.score.toFixed(2) : "-"}`)
                              .join(" | ")
                          : "-";
                      const assertion =
                        isRecord(item.assertion_result) && typeof item.assertion_result.passed === "boolean"
                          ? item.assertion_result.passed
                            ? "pass"
                            : "failed"
                          : "-";
                      const errorText = isRecord(item.error_info) && typeof item.error_info.message === "string" ? item.error_info.message : "-";
                      return (
                        <tr key={item.id} style={{ borderBottom: "1px solid rgba(31,37,39,0.08)" }}>
                          <td style={{ padding: "9px 8px" }}>{item.case_display_name || item.case_name || `item#${item.id}`}</td>
                          <td style={{ padding: "9px 8px" }}>{item.status}</td>
                          {runType === "agent_eval" ? (
                            <>
                              <td style={{ padding: "9px 8px" }}>{score === null ? "-" : score.toFixed(3)}</td>
                              <td style={{ padding: "9px 8px" }}>{dimensions}</td>
                            </>
                          ) : (
                            <>
                              <td style={{ padding: "9px 8px" }}>{assertion}</td>
                              <td style={{ padding: "9px 8px" }}>{typeof item.duration_ms === "number" ? `${item.duration_ms}ms` : "-"}</td>
                            </>
                          )}
                          <td style={{ padding: "9px 8px", color: "#7b4330" }}>{errorText}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section style={{ ...panelStyle, display: "grid", gap: 12 }}>
        <strong style={{ fontSize: 18 }}>对比报告（Compare Report）</strong>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 8 }}>
          <select
            value={compareRunId1 ?? ""}
            onChange={(event) => setCompareRunId1(event.target.value ? Number(event.target.value) : null)}
            disabled={runs.length === 0}
            style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
          >
            <option value="">run_id_1</option>
            {runs.map((run) => (
              <option key={run.id} value={run.id}>
                #{run.id} · {runTypeLabel(run.run_type)} · {run.status}
              </option>
            ))}
          </select>
          <select
            value={compareRunId2 ?? ""}
            onChange={(event) => setCompareRunId2(event.target.value ? Number(event.target.value) : null)}
            disabled={runs.length === 0}
            style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
          >
            <option value="">run_id_2</option>
            {runs.map((run) => (
              <option key={run.id} value={run.id}>
                #{run.id} · {runTypeLabel(run.run_type)} · {run.status}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void onCompare()}
            disabled={busy}
            style={{
              border: "none",
              borderRadius: 10,
              padding: "9px 14px",
              background: "#1f2527",
              color: "#fff8eb",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {busy ? "生成中..." : "生成对比"}
          </button>
        </div>

        {!compareModel ? (
          <div style={{ color: "#667173" }}>请选择两条 run 生成对比报告</div>
        ) : (
          <div style={{ display: "grid", gap: 8, border: "1px solid rgba(31,37,39,0.08)", borderRadius: 10, padding: 10 }}>
            <div style={{ fontWeight: 700 }}>
              Run #{compareModel.runId1} vs Run #{compareModel.runId2}
            </div>
            {compareModel.runType === "agent_eval" ? (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <div style={{ borderRadius: 8, background: "rgba(31,37,39,0.04)", padding: "8px 10px" }}>
                    avg_score(run#{compareModel.runId1}): {compareModel.avgScore1.toFixed(3)}
                  </div>
                  <div style={{ borderRadius: 8, background: "rgba(31,37,39,0.04)", padding: "8px 10px" }}>
                    avg_score(run#{compareModel.runId2}): {compareModel.avgScore2.toFixed(3)}
                  </div>
                </div>
                <div style={{ display: "grid", gap: 6 }}>
                  {[
                    { label: `Run#${compareModel.runId1}`, value: compareModel.avgScore1 },
                    { label: `Run#${compareModel.runId2}`, value: compareModel.avgScore2 },
                  ].map((entry) => (
                    <div key={entry.label} style={{ display: "grid", gap: 4 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#5f6a6c" }}>
                        <span>{entry.label}</span>
                        <span>{entry.value.toFixed(3)}</span>
                      </div>
                      <div style={{ borderRadius: 8, background: "rgba(31,37,39,0.08)", height: 8, overflow: "hidden" }}>
                        <div style={{ width: `${scoreToPercent(entry.value)}%`, height: "100%", background: "#3a7ec2" }} />
                      </div>
                    </div>
                  ))}
                </div>
                <div style={{ display: "grid", gap: 6 }}>
                  {compareDimensionRows.length === 0 ? (
                    <span style={{ color: "#667173" }}>暂无维度对比</span>
                  ) : (
                    compareDimensionRows.map((row) => (
                      <div key={row.name} style={{ display: "grid", gap: 2 }}>
                        <div style={{ fontSize: 12, color: "#5f6a6c" }}>
                          {row.name}：{row.left.toFixed(3)} → {row.right.toFixed(3)}
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                          <div style={{ borderRadius: 8, background: "rgba(31,37,39,0.08)", height: 6, overflow: "hidden" }}>
                            <div style={{ width: `${scoreToPercent(row.left)}%`, height: "100%", background: "#9fb4cc" }} />
                          </div>
                          <div style={{ borderRadius: 8, background: "rgba(31,37,39,0.08)", height: 6, overflow: "hidden" }}>
                            <div style={{ width: `${scoreToPercent(row.right)}%`, height: "100%", background: "#3a7ec2" }} />
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </>
            ) : (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <div style={{ borderRadius: 8, background: "rgba(31,37,39,0.04)", padding: "8px 10px" }}>
                    pass_rate(run#{compareModel.runId1}): {compareModel.passRate1.toFixed(1)}%
                  </div>
                  <div style={{ borderRadius: 8, background: "rgba(31,37,39,0.04)", padding: "8px 10px" }}>
                    pass_rate(run#{compareModel.runId2}): {compareModel.passRate2.toFixed(1)}%
                  </div>
                </div>
                <div style={{ display: "grid", gap: 6 }}>
                  {[
                    { label: `Run#${compareModel.runId1}`, value: compareModel.passRate1 },
                    { label: `Run#${compareModel.runId2}`, value: compareModel.passRate2 },
                  ].map((entry) => (
                    <div key={entry.label} style={{ display: "grid", gap: 4 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#5f6a6c" }}>
                        <span>{entry.label}</span>
                        <span>{entry.value.toFixed(1)}%</span>
                      </div>
                      <div style={{ borderRadius: 8, background: "rgba(31,37,39,0.08)", height: 8, overflow: "hidden" }}>
                        <div style={{ width: `${Math.max(0, Math.min(100, entry.value))}%`, height: "100%", background: "#3a7ec2" }} />
                      </div>
                    </div>
                  ))}
                </div>
                <div style={{ color: "#5f6a6c" }}>
                  失败数：{compareModel.failed1} → {compareModel.failed2} ｜ 新失败 {compareModel.newFailures} ｜ 已修复 {compareModel.fixedCases}
                </div>
              </>
            )}
            <details>
              <summary style={{ cursor: "pointer", color: "#5f6a6c" }}>查看原始对比 JSON</summary>
              <pre
                style={{
                  margin: "8px 0 0",
                  borderRadius: 8,
                  border: "1px solid rgba(31,37,39,0.08)",
                  padding: 10,
                  background: "rgba(31,37,39,0.03)",
                  overflow: "auto",
                  maxHeight: 260,
                  fontFamily: "monospace",
                  fontSize: 12,
                }}
              >
                {toPretty(compareResult)}
              </pre>
            </details>
          </div>
        )}
      </section>

      <section style={{ ...panelStyle, display: "grid", gap: 8 }}>
        <strong style={{ fontSize: 16 }}>失败分布 / 维度分布（项目级）</strong>
        {!projectReport ? (
          <span style={{ color: "#667173" }}>暂无数据</span>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div style={{ borderRadius: 10, background: "rgba(31,37,39,0.04)", padding: "8px 10px" }}>
              <div style={{ fontWeight: 700 }}>API 失败分布</div>
              <div style={{ marginTop: 6, color: "#5f6a6c" }}>
                {projectReport.api.failureDistribution.length === 0
                  ? "暂无分布数据"
                  : projectReport.api.failureDistribution.map((item) => `${item.name}:${item.value}`).join("，")}
              </div>
            </div>
            <div style={{ borderRadius: 10, background: "rgba(31,37,39,0.04)", padding: "8px 10px" }}>
              <div style={{ fontWeight: 700 }}>Benchmark 维度分布</div>
              <div style={{ marginTop: 6, color: "#5f6a6c" }}>
                {projectReport.benchmark.dimensionDistribution.length === 0
                  ? "暂无分布数据"
                  : projectReport.benchmark.dimensionDistribution
                      .map((item) => `${item.dimension}:${item.avgScore.toFixed(3)}`)
                      .join("，")}
              </div>
            </div>
          </div>
        )}
      </section>

      <section style={{ ...panelStyle, display: "grid", gap: 8 }}>
        <strong style={{ fontSize: 16 }}>当前筛选信息</strong>
        <div style={{ color: "#5f6a6c", fontSize: 13 }}>
          时间范围：{selectedTimeRange} ｜ 项目：{projects.find((item) => item.id === selectedProjectId)?.name ?? "-"} ｜ Suite：
          {suites.find((item) => item.id === selectedSuiteId)?.name ?? "-"} ｜ Run：{selectedRunId ? `#${selectedRunId}` : "-"}
        </div>
        {selectedRun ? (
          <div style={{ color: "#5f6a6c", fontSize: 13 }}>
            Run 元信息：{runTypeLabel(selectedRun.run_type)} ｜ {selectedRun.status} ｜ 创建于 {formatDate(selectedRun.created_at)}
          </div>
        ) : null}
      </section>
    </section>
  );
}
