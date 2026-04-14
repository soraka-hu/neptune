import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { FloatingNotice, type NoticeTone } from "../../components/FloatingNotice";
import { RunDetailReport, RunItemReport, getRunDetailReport } from "../../services/reportService";
import { RunRecord, getRun } from "../../services/runService";
import {
  displayStatus,
  formatDate,
  isRecord,
  normalizeItemName,
  panelStyle,
  parseMaybeNumber,
  runTypeLabel,
  statusPillStyle,
  terminalStatuses,
  toNumber,
  toPretty,
} from "./executionShared";

function readJsonPath(payload: unknown, path: string): unknown {
  if (!isRecord(payload)) {
    return null;
  }
  let normalized = path.trim();
  if (normalized.startsWith("$.")) {
    normalized = normalized.slice(2);
  } else if (normalized.startsWith("$")) {
    normalized = normalized.slice(1);
  }
  if (!normalized) {
    return payload;
  }
  let cursor: unknown = payload;
  for (const segment of normalized.split(".")) {
    if (!isRecord(cursor)) {
      return null;
    }
    cursor = cursor[segment];
  }
  return cursor ?? null;
}

function collectAssertionPaths(assertionResult: unknown): string[] {
  if (!isRecord(assertionResult)) {
    return [];
  }
  const allChecks = Array.isArray(assertionResult.effective_checks)
    ? assertionResult.effective_checks
    : isRecord(assertionResult.case_assertion) && Array.isArray(assertionResult.case_assertion.item_checks)
      ? assertionResult.case_assertion.item_checks
      : [];
  const paths: string[] = [];
  for (const item of allChecks) {
    if (!isRecord(item) || typeof item.path !== "string" || !item.path.trim()) {
      continue;
    }
    if (!paths.includes(item.path)) {
      paths.push(item.path);
    }
  }
  return paths;
}

function summarizeApiRequest(requestData: unknown): Record<string, unknown> {
  if (!isRecord(requestData)) {
    return {};
  }
  const retryCount = typeof requestData.retry_count === "number" ? requestData.retry_count : null;
  const retryIntervalSeconds =
    typeof requestData.retry_interval_seconds === "number" ? requestData.retry_interval_seconds : null;
  const timeoutSeconds = typeof requestData.timeout_seconds === "number" ? requestData.timeout_seconds : null;
  const hasExplicitExecutionPolicy = isRecord(requestData.case_execution_policy) || isRecord(requestData.execution_policy);
  const attempts = Array.isArray(requestData.attempts)
    ? requestData.attempts
        .filter(isRecord)
        .map((item) => ({
          attempt: typeof item.attempt === "number" ? item.attempt : null,
          status_code: typeof item.status_code === "number" ? item.status_code : null,
          assertion_passed: typeof item.assertion_passed === "boolean" ? item.assertion_passed : null,
          error_type: typeof item.error_type === "string" ? item.error_type : null,
          checks: Array.isArray(item.checks)
            ? item.checks
                .filter(isRecord)
                .map((check) => ({
                  path: typeof check.path === "string" ? check.path : null,
                  op: typeof check.op === "string" ? check.op : null,
                  expected: check.expected ?? null,
                  actual: check.actual ?? null,
                  passed: typeof check.passed === "boolean" ? check.passed : null,
                }))
            : [],
        }))
    : [];
  const summary: Record<string, unknown> = {
    method: typeof requestData.method === "string" ? requestData.method : null,
    path: typeof requestData.path === "string" ? requestData.path : null,
    headers: isRecord(requestData.headers) ? requestData.headers : requestData.headers ?? {},
    query: isRecord(requestData.query) ? requestData.query : requestData.query ?? {},
    body: requestData.body ?? null,
    attempt_count: typeof requestData.attempt_count === "number" ? requestData.attempt_count : null,
    attempts,
  };
  if (hasExplicitExecutionPolicy || (typeof retryCount === "number" && retryCount > 0)) {
    summary.retry_policy = {
      retry_count: retryCount,
      retry_interval_seconds: retryIntervalSeconds,
      timeout_seconds: timeoutSeconds,
    };
  }
  return summary;
}

function summarizeApiResponse(responseData: unknown, assertionResult: unknown): Record<string, unknown> {
  if (!isRecord(responseData)) {
    return {};
  }
  const responseJson = responseData.json;
  const requiredPaths = collectAssertionPaths(assertionResult);
  const jsonFields: Record<string, unknown> = {};
  requiredPaths.forEach((path) => {
    jsonFields[path] = readJsonPath(responseJson, path);
  });
  return {
    status_code: responseData.status_code ?? null,
    content_type: isRecord(responseData.headers) ? responseData.headers["Content-Type"] ?? null : null,
    checked_fields: jsonFields,
  };
}

function summarizeApiAssertion(assertionResult: unknown): Record<string, unknown> {
  if (!isRecord(assertionResult)) {
    return {};
  }
  const statusChecks = Array.isArray(assertionResult.status_checks)
    ? assertionResult.status_checks.filter((item) => isRecord(item))
    : [];
  const allChecks = Array.isArray(assertionResult.effective_checks)
    ? assertionResult.effective_checks.filter((item) => isRecord(item))
    : [];
  const failedChecks = allChecks.filter((item) => item.passed === false);
  return {
    source_mode: typeof assertionResult.source_mode === "string" ? assertionResult.source_mode : "unknown",
    passed: assertionResult.passed === true,
    status_checks: statusChecks,
    failed_checks: failedChecks.slice(0, 12),
  };
}

function summarizeBenchmarkApiRequest(item: RunItemReport): unknown {
  const row = item as unknown as Record<string, unknown>;
  if (isRecord(row.benchmark_api_request_case)) {
    return row.benchmark_api_request_case;
  }
  if (isRecord(item.request_data) && isRecord(item.request_data.benchmark_api_request_case)) {
    return item.request_data.benchmark_api_request_case;
  }
  if (!isRecord(item.request_data)) {
    return {};
  }
  return {
    schema_version: "1.0",
    method: typeof item.request_data.method === "string" ? item.request_data.method : null,
    path: typeof item.request_data.path === "string" ? item.request_data.path : null,
    headers: isRecord(item.request_data.headers) ? item.request_data.headers : {},
    query: isRecord(item.request_data.query) ? item.request_data.query : item.request_data.query ?? {},
    body: item.request_data.body ?? null,
  };
}

function summarizeBenchmarkOutput(item: RunItemReport): unknown {
  if (item.parsed_output !== null && item.parsed_output !== undefined) {
    return item.parsed_output;
  }
  if (isRecord(item.response_data)) {
    if (isRecord(item.response_data.json) && isRecord(item.response_data.json.data) && typeof item.response_data.json.data.text === "string") {
      return item.response_data.json.data.text;
    }
    if (typeof item.response_data.text === "string" && item.response_data.text.trim()) {
      return item.response_data.text;
    }
    return {
      url: item.response_data.url ?? null,
      status_code: item.response_data.status_code ?? null,
      headers: isRecord(item.response_data.headers) ? item.response_data.headers : {},
      json: item.response_data.json ?? null,
      text: item.response_data.text ?? null,
    };
  }
  return null;
}

function summarizeBenchmarkScore(scoreResult: unknown): unknown {
  if (!isRecord(scoreResult)) {
    return null;
  }
  const dimensions = Array.isArray(scoreResult.dimensions)
    ? scoreResult.dimensions
        .filter(isRecord)
        .map((dimension) => ({
          name: typeof dimension.name === "string" ? dimension.name : "dimension",
          score: typeof dimension.score === "number" ? dimension.score : null,
        }))
    : [];
  return {
    total_score: typeof scoreResult.total_score === "number" ? scoreResult.total_score : null,
    passed: typeof scoreResult.passed === "boolean" ? scoreResult.passed : null,
    dimensions,
  };
}

function summarizeBenchmarkJudgeReason(item: RunItemReport): unknown {
  const row = item as unknown as Record<string, unknown>;
  if (Array.isArray(row.judge_reason)) {
    const normalized = row.judge_reason
      .filter(isRecord)
      .map((reason) => ({
        name: typeof reason.name === "string" ? reason.name : "dimension",
        reason: typeof reason.reason === "string" ? reason.reason : "",
      }))
      .filter((reason) => reason.reason.trim());
    if (normalized.length > 0) {
      return normalized;
    }
  }
  if (typeof row.judge_reason === "string" && row.judge_reason.trim()) {
    return row.judge_reason.trim();
  }
  if (isRecord(item.score_result) && Array.isArray(item.score_result.dimensions)) {
    const normalized = item.score_result.dimensions
      .filter(isRecord)
      .map((dimension) => ({
        name: typeof dimension.name === "string" ? dimension.name : "dimension",
        reason: typeof dimension.reason === "string" ? dimension.reason : "",
      }))
      .filter((dimension) => dimension.reason.trim());
    if (normalized.length > 0) {
      return normalized;
    }
  }
  return item.error_info ?? null;
}

function displayReportDeliveryStatus(statusRaw: string | undefined): string {
  const status = String(statusRaw || "").trim().toLowerCase();
  if (!status || status === "disabled") {
    return "未配置";
  }
  if (status === "pending") {
    return "待发送";
  }
  if (status === "success") {
    return "发送成功";
  }
  if (status === "failed") {
    return "发送失败";
  }
  return status;
}

function reportDeliveryPillStyle(status: string) {
  if (status === "发送成功") {
    return { background: "rgba(38,129,79,0.16)", color: "#1f6a43" };
  }
  if (status === "发送失败") {
    return { background: "rgba(169,52,38,0.16)", color: "#802b23" };
  }
  if (status === "待发送") {
    return { background: "rgba(188,128,37,0.16)", color: "#895e1f" };
  }
  return { background: "rgba(110,121,125,0.14)", color: "#4d5658" };
}

type ExecutionRunDetailPageProps = {
  embedded?: boolean;
  runId?: number | null;
  onBackToList?: () => void;
};

export function ExecutionRunDetailPage({ embedded = false, runId: externalRunId = null, onBackToList }: ExecutionRunDetailPageProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const initialRunId = embedded ? externalRunId : parseMaybeNumber(searchParams.get("runId"));

  const [runId, setRunId] = useState<number | null>(initialRunId);
  const [run, setRun] = useState<RunRecord | null>(null);
  const [detail, setDetail] = useState<RunDetailReport | null>(null);
  const [expandedItemId, setExpandedItemId] = useState<number | null>(null);

  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<{ tone: NoticeTone; text: string } | null>(null);

  const runItems = detail?.items ?? [];
  const runLogs = detail?.logs ?? [];
  const currentRunType = runTypeLabel(run?.run_type);
  const secondaryButtonClass = "console-btn-secondary";
  const listPath = runId ? `/results/list?runId=${runId}` : "/results/list";

  const deliverySnapshot = useMemo(() => {
    if (!run || !isRecord(run.request_snapshot)) {
      return null;
    }
    const reportDelivery = run.request_snapshot.report_delivery;
    return isRecord(reportDelivery) ? reportDelivery : null;
  }, [run]);

  const reportDeliveryStatusLabel = displayReportDeliveryStatus(run?.report_delivery_status);
  const reportDeliveryFailedReason = (() => {
    const fromSnapshot = deliverySnapshot?.error;
    if (typeof fromSnapshot === "string" && fromSnapshot.trim()) {
      return fromSnapshot.trim();
    }
    if (typeof run?.report_delivery_error === "string" && run.report_delivery_error.trim()) {
      return run.report_delivery_error.trim();
    }
    return "";
  })();

  const reportDeliveryAttemptedAt = (() => {
    const fromSnapshot = deliverySnapshot?.attempted_at;
    if (typeof fromSnapshot === "string" && fromSnapshot.trim()) {
      return fromSnapshot;
    }
    if (typeof run?.report_delivery_attempted_at === "string" && run.report_delivery_attempted_at.trim()) {
      return run.report_delivery_attempted_at;
    }
    return null;
  })();

  const runMetrics = useMemo(() => {
    if (!run) {
      return null;
    }
    const summary = run.summary || {};
    const total = toNumber(summary.total);
    const passed = toNumber(summary.passed);
    const failed = toNumber(summary.failed);
    const passRate = total > 0 ? (passed / total) * 100 : 0;

    if (currentRunType === "benchmark") {
      const scoreValues = runItems
        .map((item) => {
          if (!isRecord(item.score_result) || typeof item.score_result.total_score !== "number") {
            return null;
          }
          return item.score_result.total_score;
        })
        .filter((score): score is number => typeof score === "number" && Number.isFinite(score));
      const avgScore =
        typeof summary.avg_score === "number"
          ? summary.avg_score
          : scoreValues.length > 0
            ? scoreValues.reduce((acc, score) => acc + score, 0) / scoreValues.length
            : 0;
      const minScore =
        typeof summary.min_score === "number"
          ? summary.min_score
          : scoreValues.length > 0
            ? Math.min(...scoreValues)
            : 0;
      const maxScore =
        typeof summary.max_score === "number"
          ? summary.max_score
          : scoreValues.length > 0
            ? Math.max(...scoreValues)
            : 0;

      return {
        runType: "benchmark" as const,
        total,
        avgScore,
        passRate,
        minScore,
        maxScore,
      };
    }

    return {
      runType: "api_test" as const,
      total,
      passed,
      failed,
      passRate,
    };
  }, [currentRunType, run, runItems]);

  async function refreshRunDetail(targetRunId: number) {
    const [runRecord, detailReport] = await Promise.all([getRun(targetRunId), getRunDetailReport(targetRunId)]);
    setRun(runRecord);
    setDetail(detailReport);
  }

  async function refreshAll(targetRunId: number) {
    setLoading(true);
    try {
      await refreshRunDetail(targetRunId);
      setNotice(null);
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "加载 Run 详情失败",
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (embedded) {
      return;
    }
    const runIdFromQuery = parseMaybeNumber(searchParams.get("runId"));
    setRunId(runIdFromQuery);
  }, [embedded, searchParams]);

  useEffect(() => {
    if (!embedded) {
      return;
    }
    setRunId(externalRunId ?? null);
  }, [embedded, externalRunId]);

  useEffect(() => {
    if (!runId) {
      setRun(null);
      setDetail(null);
      return;
    }
    void refreshAll(runId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  useEffect(() => {
    if (embedded) {
      return;
    }
    if (!runId) {
      return;
    }
    const next = new URLSearchParams();
    next.set("runId", String(runId));
    setSearchParams(next, { replace: true });
  }, [embedded, runId, setSearchParams]);

  useEffect(() => {
    if (!runId || !run || terminalStatuses.has(run.status)) {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshRunDetail(runId).catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [runId, run]);

  function renderBenchmarkDimensions(item: RunItemReport): string {
    if (!isRecord(item.score_result) || !Array.isArray(item.score_result.dimensions)) {
      return "-";
    }
    const dimensions = item.score_result.dimensions
      .filter(isRecord)
      .map((dimension) => `${dimension.name}:${typeof dimension.score === "number" ? dimension.score.toFixed(2) : "-"}`);
    return dimensions.length > 0 ? dimensions.join(" | ") : "-";
  }

  return (
    <section className="execution-page grid gap-4">
      <FloatingNotice notice={notice} onClose={() => setNotice(null)} />

      {!embedded ? (
        <header className="grid gap-2">
          <h2 className="page-title m-0">RUN详情</h2>
        </header>
      ) : null}

      {!embedded || runId ? (
        <section
          style={{ ...panelStyle, display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}
          className="console-panel"
        >
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                if (onBackToList) {
                  onBackToList();
                  return;
                }
                navigate(listPath);
              }}
              className={secondaryButtonClass}
            >
              返回运行列表
            </button>
            <span className="text-sm text-muted-foreground">{runId ? `当前 Run #${runId}` : "未选择 Run"}</span>
          </div>
          {runId ? (
            <div className="flex flex-wrap items-center gap-2">
              <Link to={`/reports/run?runId=${runId}`} className={secondaryButtonClass}>
                查看报告
              </Link>
              <button
                type="button"
                onClick={() => void refreshAll(runId)}
                disabled={loading}
                className={secondaryButtonClass}
              >
                {loading ? "刷新中..." : "刷新详情"}
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      {!runId ? (
        <section style={{ ...panelStyle, display: "grid", gap: 8 }} className="console-panel">
          <strong className="section-title">请选择 Run</strong>
          <div className="section-caption">请先从运行列表进入详情页，或直接打开指定 runId 的链接。</div>
          {onBackToList ? (
            <button
              type="button"
              onClick={onBackToList}
              className={secondaryButtonClass}
              style={{ width: "fit-content" }}
            >
              返回运行列表
            </button>
          ) : (
            <Link to={listPath} className="w-fit text-sm font-semibold text-primary">
              前往运行列表
            </Link>
          )}
        </section>
      ) : null}

      {runId && run ? (
        <section style={{ ...panelStyle, display: "grid", gap: 12 }} className="console-panel">
          <strong className="section-title">概览</strong>
          <div className="grid gap-2 xl:grid-cols-6">
            <div className="console-muted-card">
              <div className="text-xs text-muted-foreground">run_id</div>
              <div className="mt-1 font-semibold">#{run.id}</div>
            </div>
            <div className="console-muted-card">
              <div className="text-xs text-muted-foreground">run_type</div>
              <div className="mt-1 font-semibold">{currentRunType}</div>
            </div>
            <div className="console-muted-card">
              <div className="text-xs text-muted-foreground">status</div>
              <div className="mt-1 font-semibold">
                <span className="status-pill" style={{ ...statusPillStyle(run.status), padding: "2px 9px", fontSize: 12 }}>
                  {displayStatus(run.status)}
                </span>
              </div>
            </div>
            <div className="console-muted-card">
              <div className="text-xs text-muted-foreground">project</div>
              <div className="mt-1 font-semibold">{run.project_id}</div>
            </div>
            <div className="console-muted-card">
              <div className="text-xs text-muted-foreground">suite</div>
              <div className="mt-1 font-semibold">{run.suite_id ?? "-"}</div>
            </div>
            <div className="console-muted-card">
              <div className="text-xs text-muted-foreground">created_at</div>
              <div className="mt-1 font-semibold">{formatDate(run.created_at)}</div>
            </div>
          </div>

          {runMetrics?.runType === "api_test" ? (
            <div className="grid gap-2 md:grid-cols-4">
              <div className="console-muted-card">total: {runMetrics.total}</div>
              <div className="console-muted-card">passed: {runMetrics.passed}</div>
              <div className="console-muted-card">failed: {runMetrics.failed}</div>
              <div className="console-muted-card">
                pass_rate: {runMetrics.passRate.toFixed(1)}%
              </div>
            </div>
          ) : (
            <div className="grid gap-2 md:grid-cols-5">
              <div className="console-muted-card">total: {runMetrics?.total ?? 0}</div>
              <div className="console-muted-card">
                avg_score: {(runMetrics?.avgScore ?? 0).toFixed(3)}
              </div>
              <div className="console-muted-card">
                pass_rate: {(runMetrics?.passRate ?? 0).toFixed(1)}%
              </div>
              <div className="console-muted-card">
                min_score: {(runMetrics?.minScore ?? 0).toFixed(3)}
              </div>
              <div className="console-muted-card">
                max_score: {(runMetrics?.maxScore ?? 0).toFixed(3)}
              </div>
            </div>
          )}

          <div className="grid gap-2 md:grid-cols-3">
            <div className="console-muted-card">
              <div className="text-xs text-muted-foreground">报告发送状态</div>
              <div className="mt-1 font-semibold">
                <span className="status-pill" style={{ ...reportDeliveryPillStyle(reportDeliveryStatusLabel), padding: "2px 9px", fontSize: 12 }}>
                  {reportDeliveryStatusLabel}
                </span>
              </div>
            </div>
            <div className="console-muted-card md:col-span-2">
              <div className="text-xs text-muted-foreground">发送结果</div>
              <div className="mt-1 text-sm">
                {reportDeliveryStatusLabel === "发送失败"
                  ? `失败原因：${reportDeliveryFailedReason || "未知错误"}`
                  : reportDeliveryAttemptedAt
                    ? `最近尝试：${formatDate(reportDeliveryAttemptedAt)}`
                    : "暂无发送记录"}
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {runId && run ? (
        <section style={{ ...panelStyle, display: "grid", gap: 8 }} className="console-panel">
          <strong className="section-title">执行日志</strong>
          <div
            className="console-scroll max-h-[220px] overflow-auto p-3 font-mono text-xs whitespace-pre-wrap"
          >
            {runLogs.length === 0
              ? "暂无日志"
              : runLogs
                  .map((log) => {
                    const time = typeof log.created_at === "string" ? log.created_at.slice(11, 19) : "--:--:--";
                    return `[${time}] [${log.log_level}] ${log.content}`;
                  })
                  .join("\n")}
          </div>
        </section>
      ) : null}

      {runId && run ? (
        <section style={{ ...panelStyle, display: "grid", gap: 8 }} className="console-panel">
          <strong className="section-title">run_item明细</strong>
          {runItems.length === 0 ? (
            <div className="section-caption">暂无 run_item 明细</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="data-table min-w-[1160px]">
                <thead>
                  <tr>
                    <th>case_name</th>
                    <th>status</th>
                    {currentRunType === "api_test" ? (
                      <>
                        <th>assertion</th>
                        <th>latency</th>
                      </>
                    ) : (
                      <>
                        <th>score</th>
                        <th>dimensions</th>
                      </>
                    )}
                    <th>error</th>
                    <th>详情</th>
                  </tr>
                </thead>
                <tbody>
                  {runItems.flatMap((item) => {
                    const expanded = expandedItemId === item.id;
                    const assertionSummary =
                      isRecord(item.assertion_result) && typeof item.assertion_result.passed === "boolean"
                        ? item.assertion_result.passed
                          ? "pass"
                          : "failed"
                        : "-";
                    const scoreValue =
                      isRecord(item.score_result) && typeof item.score_result.total_score === "number"
                        ? item.score_result.total_score.toFixed(3)
                        : "-";
                    const errorMessage = isRecord(item.error_info) && typeof item.error_info.message === "string" ? item.error_info.message : "-";
                    const detailColumns = currentRunType === "api_test" ? 6 : 7;

                    const rows = [
                      <tr key={item.id} className="align-top">
                        <td className="min-w-[220px]">{normalizeItemName(item as unknown as Record<string, unknown>)}</td>
                        <td>{item.status}</td>
                        {currentRunType === "api_test" ? (
                          <>
                            <td>{assertionSummary}</td>
                            <td>{typeof item.duration_ms === "number" ? `${item.duration_ms}ms` : "-"}</td>
                          </>
                        ) : (
                          <>
                            <td>{scoreValue}</td>
                            <td className="max-w-[360px]">{renderBenchmarkDimensions(item)}</td>
                          </>
                        )}
                        <td className="max-w-[320px] whitespace-pre-wrap break-words text-danger">
                          {errorMessage}
                        </td>
                        <td>
                          <button
                            type="button"
                            onClick={() => setExpandedItemId((prev) => (prev === item.id ? null : item.id))}
                            className={secondaryButtonClass}
                          >
                            {expanded ? "收起" : "展开"}
                          </button>
                        </td>
                      </tr>,
                    ];

                    if (expanded) {
                      rows.push(
                        <tr key={`detail-${item.id}`}>
                          <td colSpan={detailColumns}>
                            {currentRunType === "api_test" ? (
                              <div className="grid gap-2 lg:grid-cols-3">
                                <pre className="m-0 overflow-x-auto p-2 font-mono text-xs whitespace-pre-wrap break-words">{`api request\n${toPretty(
                                  summarizeApiRequest(item.request_data)
                                )}`}</pre>
                                <pre className="m-0 overflow-x-auto p-2 font-mono text-xs whitespace-pre-wrap break-words">{`output\n${toPretty(
                                  summarizeApiResponse(item.response_data, item.assertion_result)
                                )}`}</pre>
                                <pre className="m-0 overflow-x-auto p-2 font-mono text-xs whitespace-pre-wrap break-words">{`assertion\n${toPretty(
                                  summarizeApiAssertion(item.assertion_result)
                                )}`}</pre>
                              </div>
                            ) : (
                              <div className="grid gap-2 lg:grid-cols-4">
                                <pre className="m-0 overflow-x-auto p-2 font-mono text-xs whitespace-pre-wrap break-words">{`api request\n${toPretty(
                                  summarizeBenchmarkApiRequest(item)
                                )}`}</pre>
                                <pre className="m-0 overflow-x-auto p-2 font-mono text-xs whitespace-pre-wrap break-words">{`output\n${toPretty(
                                  summarizeBenchmarkOutput(item)
                                )}`}</pre>
                                <pre className="m-0 overflow-x-auto p-2 font-mono text-xs whitespace-pre-wrap break-words">{`score\n${toPretty(
                                  summarizeBenchmarkScore(item.score_result)
                                )}`}</pre>
                                <pre className="m-0 overflow-x-auto p-2 font-mono text-xs whitespace-pre-wrap break-words">{`judge reason\n${toPretty(
                                  summarizeBenchmarkJudgeReason(item)
                                )}`}</pre>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    }
                    return rows;
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
    </section>
  );
}
