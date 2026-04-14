import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { FloatingNotice, type NoticeTone } from "../../components/FloatingNotice";
import { RunDetailReport, RunSummaryReport, compareReports, exportRunReport, getRunDetailReport, getRunReport } from "../../services/reportService";
import { RunRecord, getRun, listRuns } from "../../services/runService";

const panelStyle: CSSProperties = {
  borderRadius: 12,
  padding: 16,
  background: "#ffffff",
  border: "1px solid #E5E7EB",
  boxShadow: "none",
};

function toPretty(value: unknown) {
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

export function RunDetailPage() {
  const navigate = useNavigate();
  const params = useParams();
  const runId = Number(params.runId);
  const validRunId = Number.isInteger(runId) && runId > 0;

  const [run, setRun] = useState<RunRecord | null>(null);
  const [summary, setSummary] = useState<RunSummaryReport | null>(null);
  const [detail, setDetail] = useState<RunDetailReport | null>(null);
  const [peerRuns, setPeerRuns] = useState<RunRecord[]>([]);
  const [compareRunId, setCompareRunId] = useState<number | null>(null);
  const [compareResult, setCompareResult] = useState<Record<string, unknown> | null>(null);
  const [exportUrl, setExportUrl] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: NoticeTone; text: string } | null>(null);

  const summaryMetrics = useMemo(() => {
    const base = summary?.summary ?? { total: 0, passed: 0, failed: 0 };
    return {
      total: Number(base.total ?? 0),
      passed: Number(base.passed ?? 0),
      failed: Number(base.failed ?? 0),
    };
  }, [summary]);

  const boundRules = useMemo(() => {
    if (!run?.request_snapshot || !Array.isArray(run.request_snapshot.bound_rules)) {
      return [];
    }
    return run.request_snapshot.bound_rules
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        id: typeof item.id === "number" ? item.id : -1,
        name: typeof item.name === "string" ? item.name : "未命名规则",
        ruleType: typeof item.rule_type === "string" ? item.rule_type : "unknown",
      }));
  }, [run]);

  async function refresh() {
    if (!validRunId) {
      setNotice({ tone: "error", text: "runId 不合法" });
      return;
    }
    setLoading(true);
    try {
      const [runRecord, summaryReport, detailReport] = await Promise.all([
        getRun(runId),
        getRunReport(runId),
        getRunDetailReport(runId),
      ]);
      setRun(runRecord);
      setSummary(summaryReport);
      setDetail(detailReport);
      if (runRecord.project_id) {
        const allRuns = await listRuns({ projectId: runRecord.project_id });
        const peers = allRuns.filter((item) => item.id !== runId).slice().reverse().slice(0, 20);
        setPeerRuns(peers);
        setCompareRunId((prev) => (prev && peers.some((item) => item.id === prev) ? prev : peers[0]?.id ?? null));
      } else {
        setPeerRuns([]);
        setCompareRunId(null);
      }
      setNotice(null);
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "加载 run 详情失败",
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  async function onCompare() {
    if (!compareRunId) {
      setNotice({ tone: "error", text: "请选择对比 run" });
      return;
    }
    setBusy(true);
    try {
      const result = await compareReports(runId, compareRunId);
      setCompareResult(result);
      setNotice({ tone: "success", text: `已完成 run ${runId} 与 run ${compareRunId} 对比` });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "对比失败",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onExport() {
    setBusy(true);
    try {
      const result = await exportRunReport(runId);
      setExportUrl(result.fileUrl);
      setNotice({ tone: "success", text: `报告导出成功：${result.fileUrl}` });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "导出失败",
      });
    } finally {
      setBusy(false);
    }
  }

  if (!validRunId) {
    return (
      <section>
        <h2 style={{ marginTop: 0 }}>Run 详情</h2>
        <p>runId 不合法。</p>
      </section>
    );
  }

  return (
    <section style={{ display: "grid", gap: 14 }}>
      <FloatingNotice notice={notice} onClose={() => setNotice(null)} />
      <header style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ display: "grid", gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 36 }}>Run 详情页</h2>
          <div style={{ color: "#5f6a6c", lineHeight: 1.7 }}>
            查看 run 详情、run_item 明细、错误原因、断言结果与分数，并可返回上层继续操作。
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <Link to="/reports" style={{ color: "#8a3f1f", fontWeight: 700 }}>
            返回 run 列表
          </Link>
          <button
            type="button"
            onClick={() => navigate(-1)}
            style={{ border: "1px solid rgba(31,37,39,0.2)", borderRadius: 8, padding: "6px 10px", background: "#fff", cursor: "pointer" }}
          >
            返回上一层
          </button>
        </div>
      </header>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          style={{
            border: "1px solid rgba(31,37,39,0.2)",
            borderRadius: 10,
            padding: "8px 12px",
            background: "#fff",
            cursor: "pointer",
            fontWeight: 700,
          }}
        >
          {loading ? "刷新中..." : "刷新详情"}
        </button>
        <button
          type="button"
          onClick={() => void onExport()}
          disabled={busy}
          style={{
            border: "1px solid rgba(31,37,39,0.2)",
            borderRadius: 10,
            padding: "8px 12px",
            background: "#fff",
            cursor: "pointer",
            fontWeight: 700,
          }}
        >
          导出报告
        </button>
        {exportUrl ? <span style={{ color: "#6b7578" }}>file: {exportUrl}</span> : null}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div style={{ ...panelStyle, display: "grid", gap: 8 }}>
          <strong>Run 概览</strong>
          {!run ? (
            <div style={{ color: "#667173" }}>暂无 run 数据</div>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 8 }}>
                {[
                  { label: "runId", value: run.id },
                  { label: "status", value: run.status },
                  { label: "runType", value: run.run_type },
                ].map((item) => (
                  <div key={item.label} style={{ borderRadius: 10, background: "rgba(31,37,39,0.05)", padding: "8px 10px" }}>
                    <div style={{ fontSize: 12, color: "#677173" }}>{item.label}</div>
                    <div style={{ marginTop: 3, fontWeight: 700 }}>{String(item.value)}</div>
                  </div>
                ))}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 8 }}>
                {[
                  { label: "total", value: summaryMetrics.total },
                  { label: "passed", value: summaryMetrics.passed },
                  { label: "failed", value: summaryMetrics.failed },
                ].map((item) => (
                  <div key={item.label} style={{ borderRadius: 10, background: "rgba(31,37,39,0.05)", padding: "8px 10px" }}>
                    <div style={{ fontSize: 12, color: "#677173" }}>{item.label}</div>
                    <div style={{ marginTop: 3, fontWeight: 700 }}>{String(item.value)}</div>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 12, color: "#677173" }}>
                runNo: {run.run_no} · project: {run.project_id} · suite: {run.suite_id ?? "-"} · environment: {run.environment_id ?? "-"}
              </div>
              <div style={{ borderTop: "1px solid rgba(31,37,39,0.08)", paddingTop: 8, display: "grid", gap: 6 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>本次执行加载规则</div>
                {boundRules.length === 0 ? (
                  <div style={{ color: "#677173", fontSize: 12 }}>未加载绑定规则</div>
                ) : (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {boundRules.map((rule) => (
                      <span
                        key={`${rule.id}-${rule.ruleType}`}
                        style={{
                          borderRadius: 999,
                          padding: "4px 9px",
                          background: "rgba(191,93,54,0.12)",
                          border: "1px solid rgba(191,93,54,0.25)",
                          fontSize: 12,
                        }}
                      >
                        #{rule.id > 0 ? rule.id : "?"} {rule.name} · {rule.ruleType}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <div style={{ ...panelStyle, display: "grid", gap: 8 }}>
          <strong>对比分析</strong>
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}>
            <select
              value={compareRunId ?? ""}
              onChange={(event) => setCompareRunId(event.target.value ? Number(event.target.value) : null)}
              disabled={busy || peerRuns.length === 0}
              style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "8px 10px" }}
            >
              {peerRuns.length === 0 ? <option value="">无可对比 run</option> : null}
              {peerRuns.map((item) => (
                <option key={item.id} value={item.id}>
                  #{item.id} · {item.status} · {item.run_type}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void onCompare()}
              disabled={busy || !compareRunId}
              style={{
                border: "1px solid rgba(31,37,39,0.2)",
                borderRadius: 10,
                padding: "8px 10px",
                background: "#fff",
                cursor: "pointer",
                fontWeight: 700,
              }}
            >
              对比
            </button>
          </div>
          <pre
            style={{
              margin: 0,
              borderRadius: 10,
              border: "1px solid rgba(31,37,39,0.08)",
              padding: 10,
              minHeight: 180,
              maxHeight: 220,
              overflow: "auto",
              background: "rgba(31,37,39,0.03)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontFamily: "monospace",
              fontSize: 12,
            }}
          >
            {compareResult ? toPretty(compareResult) : "暂无对比结果"}
          </pre>
        </div>
      </div>

      <div style={{ ...panelStyle, display: "grid", gap: 8 }}>
        <strong>run_item 明细</strong>
        {!detail ? (
          <div style={{ color: "#667173" }}>暂无详情数据</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1280 }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid rgba(31,37,39,0.12)" }}>
                  <th style={{ padding: "9px 8px" }}>itemId</th>
                  <th style={{ padding: "9px 8px" }}>status</th>
                  <th style={{ padding: "9px 8px" }}>caseId</th>
                  <th style={{ padding: "9px 8px" }}>request</th>
                  <th style={{ padding: "9px 8px" }}>response</th>
                  <th style={{ padding: "9px 8px" }}>assertion</th>
                  <th style={{ padding: "9px 8px" }}>score</th>
                  <th style={{ padding: "9px 8px" }}>error</th>
                </tr>
              </thead>
              <tbody>
                {detail.items.length === 0 ? (
                  <tr>
                    <td colSpan={8} style={{ padding: "12px 8px", color: "#667173" }}>
                      run_item 暂为空
                    </td>
                  </tr>
                ) : (
                  detail.items.map((item) => (
                    <tr key={item.id} style={{ borderBottom: "1px solid rgba(31,37,39,0.08)", verticalAlign: "top" }}>
                      <td style={{ padding: "9px 8px", fontWeight: 700 }}>{item.id}</td>
                      <td style={{ padding: "9px 8px" }}>{item.status}</td>
                      <td style={{ padding: "9px 8px" }}>{item.case_id ?? "-"}</td>
                      <td style={{ padding: "9px 8px", whiteSpace: "pre-wrap", maxWidth: 220, fontFamily: "monospace", fontSize: 12 }}>
                        {toPretty(item.request_data)}
                      </td>
                      <td style={{ padding: "9px 8px", whiteSpace: "pre-wrap", maxWidth: 220, fontFamily: "monospace", fontSize: 12 }}>
                        {toPretty(item.response_data)}
                      </td>
                      <td style={{ padding: "9px 8px", whiteSpace: "pre-wrap", maxWidth: 180, fontFamily: "monospace", fontSize: 12 }}>
                        {toPretty(item.assertion_result)}
                      </td>
                      <td style={{ padding: "9px 8px", whiteSpace: "pre-wrap", maxWidth: 180, fontFamily: "monospace", fontSize: 12 }}>
                        {toPretty(item.score_result)}
                      </td>
                      <td style={{ padding: "9px 8px", color: "#7b4330", whiteSpace: "pre-wrap", maxWidth: 180, fontFamily: "monospace", fontSize: 12 }}>
                        {toPretty(item.error_info)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
