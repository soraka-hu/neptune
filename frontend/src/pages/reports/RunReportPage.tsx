import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { FloatingNotice, type NoticeTone } from "../../components/FloatingNotice";
import { ProjectRecord, listProjects } from "../../services/assetService";
import { RunDetailReport, RunItemReport, RunReport, compareReports, exportRunHtml, getRunDetailReport, getRunReport } from "../../services/reportService";
import { RunRecord, getRun, listRuns } from "../../services/runService";
import { fmtPercent, fmtScore, isRecord, panelStyle, parseMaybeNumber, runTypeLabel, scoreToPercent, toNumber, toPretty } from "./reportShared";

const primaryButtonClass =
  "rounded-lg border border-primary/60 bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60";
const secondaryButtonClass =
  "rounded-lg border border-border/80 bg-white px-3 py-2 text-sm font-semibold text-foreground hover:bg-white/85 disabled:cursor-not-allowed disabled:opacity-60";
const panelSubtleClass = "rounded-xl border border-border/70 bg-white/55 p-3";

function normalizeItemName(item: RunItemReport): string {
  if (typeof item.case_display_name === "string" && item.case_display_name.trim()) {
    return item.case_display_name;
  }
  if (typeof item.case_name === "string" && item.case_name.trim()) {
    return item.case_name;
  }
  if (typeof item.case_id === "number") {
    return `case#${item.case_id}`;
  }
  return `item#${item.id}`;
}

export function RunReportPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(() => parseMaybeNumber(searchParams.get("runId")));
  const [selectedCompareRunId, setSelectedCompareRunId] = useState<number | null>(null);

  const [runReport, setRunReport] = useState<RunReport | null>(null);
  const [runDetail, setRunDetail] = useState<RunDetailReport | null>(null);
  const [compareResult, setCompareResult] = useState<Record<string, unknown> | null>(null);
  const [exportUrl, setExportUrl] = useState("");

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: NoticeTone; text: string } | null>(null);

  const runType = runTypeLabel(runReport?.runType);
  const compareModel = useMemo(() => {
    if (!compareResult || !isRecord(compareResult)) {
      return null;
    }
    const metrics = isRecord(compareResult.metrics) ? compareResult.metrics : {};
    return {
      runType: typeof compareResult.runType === "string" ? compareResult.runType : "api_test",
      runId1: toNumber(compareResult.runId1),
      runId2: toNumber(compareResult.runId2),
      passRate1: toNumber(metrics.passRate1),
      passRate2: toNumber(metrics.passRate2),
      failed1: toNumber(metrics.failed1),
      failed2: toNumber(metrics.failed2),
      avgScore1: toNumber(metrics.avgScore1),
      avgScore2: toNumber(metrics.avgScore2),
      dimensions1: Array.isArray(metrics.dimensions1) ? metrics.dimensions1 : [],
      dimensions2: Array.isArray(metrics.dimensions2) ? metrics.dimensions2 : [],
      newFailures: Array.isArray(compareResult.newFailures) ? compareResult.newFailures.length : 0,
      fixedCases: Array.isArray(compareResult.fixedCases) ? compareResult.fixedCases.length : 0,
    };
  }, [compareResult]);

  async function refreshProjects() {
    const projectItems = await listProjects();
    setProjects(projectItems);
    return projectItems;
  }

  async function refreshRuns(projectId: number) {
    const runItems = await listRuns({ projectId });
    const ordered = runItems.slice().sort((a, b) => b.id - a.id);
    setRuns(ordered);
    return ordered;
  }

  async function refreshRunReport(runId: number) {
    const [summary, detail] = await Promise.all([getRunReport(runId), getRunDetailReport(runId)]);
    setRunReport(summary);
    setRunDetail(detail);
  }

  async function initialize() {
    setLoading(true);
    try {
      const projectItems = await refreshProjects();
      const runIdFromQuery = parseMaybeNumber(searchParams.get("runId"));
      if (runIdFromQuery) {
        const run = await getRun(runIdFromQuery);
        setSelectedProjectId(run.project_id);
        const runItems = await refreshRuns(run.project_id);
        setSelectedRunId(runIdFromQuery);
        setSelectedCompareRunId(runItems.find((item) => item.id !== runIdFromQuery)?.id ?? null);
        await refreshRunReport(runIdFromQuery);
      } else {
        const projectId = projectItems[0]?.id ?? null;
        setSelectedProjectId(projectId);
        if (projectId) {
          const runItems = await refreshRuns(projectId);
          const targetRunId = runItems[0]?.id ?? null;
          setSelectedRunId(targetRunId);
          setSelectedCompareRunId(runItems[1]?.id ?? null);
          if (targetRunId) {
            await refreshRunReport(targetRunId);
          } else {
            setRunReport(null);
            setRunDetail(null);
          }
        } else {
          setRunReport(null);
          setRunDetail(null);
        }
      }
      setNotice(null);
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "加载 Run 报告失败",
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
      setSelectedRunId(null);
      setSelectedCompareRunId(null);
      setRunReport(null);
      setRunDetail(null);
      return;
    }
    setLoading(true);
    void refreshRuns(selectedProjectId)
      .then((runItems) => {
        setSelectedRunId((prev) => (prev && runItems.some((item) => item.id === prev) ? prev : runItems[0]?.id ?? null));
      })
      .catch((error: unknown) =>
        setNotice({
          tone: "error",
          text: error instanceof Error ? error.message : "刷新 Run 列表失败",
        })
      )
      .finally(() => setLoading(false));
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedRunId) {
      setRunReport(null);
      setRunDetail(null);
      return;
    }
    setLoading(true);
    void refreshRunReport(selectedRunId)
      .then(() => setNotice(null))
      .catch((error: unknown) =>
        setNotice({
          tone: "error",
          text: error instanceof Error ? error.message : "刷新 Run 报告失败",
        })
      )
      .finally(() => setLoading(false));
  }, [selectedRunId]);

  useEffect(() => {
    const next = new URLSearchParams();
    if (selectedRunId) {
      next.set("runId", String(selectedRunId));
    }
    setSearchParams(next, { replace: true });
  }, [selectedRunId, setSearchParams]);

  async function onCompare() {
    if (!selectedRunId || !selectedCompareRunId) {
      setNotice({ tone: "error", text: "请选择对比 Run" });
      return;
    }
    setBusy(true);
    try {
      const result = await compareReports(selectedRunId, selectedCompareRunId);
      setCompareResult(result);
      setNotice({ tone: "success", text: "Run 报告对比已完成" });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Run 报告对比失败",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onExportHtml() {
    if (!selectedRunId) {
      setNotice({ tone: "error", text: "请选择 Run" });
      return;
    }
    setBusy(true);
    try {
      const result = await exportRunHtml(selectedRunId);
      setExportUrl(result.fileUrl);
      setNotice({ tone: "success", text: "HTML 报告导出成功" });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "导出 HTML 报告失败",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="reports-page grid gap-4">
      <FloatingNotice notice={notice} onClose={() => setNotice(null)} />

      <header className="grid gap-2">
        <h2 className="page-title m-0">Run报告</h2>
      </header>

      <section style={panelStyle} className="console-panel grid gap-2 xl:grid-cols-[1fr_1fr_1fr_auto]">
        <select
          value={selectedProjectId ?? ""}
          onChange={(event) => setSelectedProjectId(event.target.value ? Number(event.target.value) : null)}
        >
          <option value="">选择项目</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <select
          value={selectedRunId ?? ""}
          onChange={(event) => setSelectedRunId(parseMaybeNumber(event.target.value))}
        >
          <option value="">选择 Run</option>
          {runs.map((run) => (
            <option key={run.id} value={run.id}>
              #{run.id} · {run.run_type} · {run.status}
            </option>
          ))}
        </select>
        <select
          value={selectedCompareRunId ?? ""}
          onChange={(event) => setSelectedCompareRunId(parseMaybeNumber(event.target.value))}
        >
          <option value="">选择对比 Run</option>
          {runs
            .filter((run) => run.id !== selectedRunId)
            .map((run) => (
              <option key={`compare-${run.id}`} value={run.id}>
                #{run.id} · {run.run_type} · {run.status}
              </option>
            ))}
        </select>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void onCompare()}
            disabled={busy || loading}
            className={secondaryButtonClass}
          >
            对比
          </button>
          <button
            type="button"
            onClick={() => void onExportHtml()}
            disabled={busy || loading || !selectedRunId}
            className={primaryButtonClass}
          >
            导出HTML
          </button>
        </div>
      </section>

      {selectedRunId ? (
        <section style={panelStyle} className="console-panel flex flex-wrap items-center justify-between gap-2">
          <Link to={`/results/detail?runId=${selectedRunId}`} className="text-sm font-semibold text-primary">
            返回运行结果查看 Run #{selectedRunId}
          </Link>
          {exportUrl ? <span className="text-sm text-muted-foreground">HTML: {exportUrl}</span> : null}
        </section>
      ) : null}

      {!runReport ? (
        <section style={panelStyle} className="console-panel text-sm text-muted-foreground">请选择 Run 查看报告。</section>
      ) : (
        <>
          <section style={{ ...panelStyle, display: "grid", gap: 8 }} className="console-panel">
            <strong style={{ fontSize: 18 }}>概览</strong>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 8 }}>
              <div className={panelSubtleClass}>run: #{runReport.runId}</div>
              <div className={panelSubtleClass}>type: {runType}</div>
              <div className={panelSubtleClass}>status: {runReport.status}</div>
              <div className={panelSubtleClass}>
                total/passed/failed: {runReport.summary.total}/{runReport.summary.passed}/{runReport.summary.failed}
              </div>
            </div>
            {runType === "benchmark" ? (
              <div style={{ color: "#5f6a6c" }}>
                avg_score: {fmtScore(runReport.overview && isRecord(runReport.overview) ? toNumber(runReport.overview.avgScore) : undefined)} ｜ pass_rate:{" "}
                {fmtPercent(runReport.summary.total > 0 ? (runReport.summary.passed / runReport.summary.total) * 100 : 0)}
              </div>
            ) : (
              <div style={{ color: "#5f6a6c" }}>
                pass_rate: {fmtPercent(runReport.summary.total > 0 ? (runReport.summary.passed / runReport.summary.total) * 100 : 0)} ｜ failed:{" "}
                {runReport.summary.failed}
              </div>
            )}
          </section>

          <section style={{ ...panelStyle, display: "grid", gap: 8 }} className="console-panel">
            <strong style={{ fontSize: 18 }}>对比分析</strong>
            {!compareModel ? (
              <div style={{ color: "#667173" }}>尚未生成对比结果。</div>
            ) : compareModel.runType === "agent_eval" ? (
              <div style={{ display: "grid", gap: 8 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <div className={panelSubtleClass}>
                    Run#{compareModel.runId1} avg_score: {compareModel.avgScore1.toFixed(3)}
                  </div>
                  <div className={panelSubtleClass}>
                    Run#{compareModel.runId2} avg_score: {compareModel.avgScore2.toFixed(3)}
                  </div>
                </div>
                <div style={{ display: "grid", gap: 6 }}>
                  {[
                    { label: `Run#${compareModel.runId1}`, value: compareModel.avgScore1 },
                    { label: `Run#${compareModel.runId2}`, value: compareModel.avgScore2 },
                  ].map((entry) => (
                    <div key={entry.label} style={{ display: "grid", gap: 4 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                        <span>{entry.label}</span>
                        <span>{entry.value.toFixed(3)}</span>
                      </div>
                      <div style={{ borderRadius: 8, background: "rgba(31,37,39,0.08)", height: 8, overflow: "hidden" }}>
                        <div style={{ width: `${scoreToPercent(entry.value)}%`, height: "100%", background: "linear-gradient(90deg, #3a7ec2, #52a0dc)" }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div style={{ color: "#5f6a6c" }}>
                通过率变化：{compareModel.passRate1.toFixed(1)}% → {compareModel.passRate2.toFixed(1)}% ｜ 新增失败case：{compareModel.newFailures} ｜ 已修复case：
                {compareModel.fixedCases}
              </div>
            )}
          </section>

          <section style={{ ...panelStyle, display: "grid", gap: 8 }} className="console-panel">
            <strong style={{ fontSize: 18 }}>结果明细</strong>
            {!runDetail || runDetail.items.length === 0 ? (
              <div style={{ color: "#667173" }}>暂无明细</div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="data-table" style={{ minWidth: 1120 }}>
                  <thead>
                    <tr style={{ textAlign: "left", borderBottom: "1px solid rgba(31,37,39,0.12)" }}>
                      <th style={{ padding: "9px 8px" }}>case_name</th>
                      <th style={{ padding: "9px 8px" }}>status</th>
                      {runType === "benchmark" ? (
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
                    {runDetail.items.map((item) => (
                      <tr key={item.id} style={{ borderBottom: "1px solid rgba(31,37,39,0.08)", verticalAlign: "top" }}>
                        <td style={{ padding: "9px 8px" }}>{normalizeItemName(item)}</td>
                        <td style={{ padding: "9px 8px" }}>{item.status}</td>
                        {runType === "benchmark" ? (
                          <>
                            <td style={{ padding: "9px 8px" }}>
                              {isRecord(item.score_result) && typeof item.score_result.total_score === "number"
                                ? item.score_result.total_score.toFixed(3)
                                : "-"}
                            </td>
                            <td style={{ padding: "9px 8px" }}>
                              {isRecord(item.score_result) && Array.isArray(item.score_result.dimensions)
                                ? item.score_result.dimensions
                                    .filter(isRecord)
                                    .map((dim) => `${dim.name}:${typeof dim.score === "number" ? dim.score.toFixed(2) : "-"}`)
                                    .join(" | ")
                                : "-"}
                            </td>
                          </>
                        ) : (
                          <>
                            <td style={{ padding: "9px 8px" }}>
                              {isRecord(item.assertion_result) && typeof item.assertion_result.passed === "boolean"
                                ? item.assertion_result.passed
                                  ? "pass"
                                  : "failed"
                                : "-"}
                            </td>
                            <td style={{ padding: "9px 8px" }}>{typeof item.duration_ms === "number" ? `${item.duration_ms}ms` : "-"}</td>
                          </>
                        )}
                        <td style={{ padding: "9px 8px", maxWidth: 320, whiteSpace: "pre-wrap" }}>
                          {isRecord(item.error_info) && typeof item.error_info.message === "string" ? item.error_info.message : toPretty(item.error_info)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </section>
  );
}
