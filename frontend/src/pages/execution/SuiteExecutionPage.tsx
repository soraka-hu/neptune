import { FormEvent, type CSSProperties, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { FloatingNotice, type NoticeTone } from "../../components/FloatingNotice";
import {
  DatasetRecord,
  EnvironmentRecord,
  ProjectRecord,
  SuiteRecord,
  listDatasets,
  listEnvironments,
  listProjects,
  listSuites,
} from "../../services/assetService";
import { RunDetailReport, RunItemReport, getRunDetailReport } from "../../services/reportService";
import { RuleRecord, listRules } from "../../services/ruleService";
import { RunRecord, compareRun, createRun, getRun, listRunsPaged } from "../../services/runService";

type RunMode = "api_test" | "benchmark";
type StrategyMode = "rule" | "custom";

const panelStyle: CSSProperties = {
  borderRadius: 12,
  padding: 16,
  background: "#ffffff",
  border: "1px solid #E5E7EB",
  boxShadow: "none",
};
const RUN_PAGE_SIZE = 9;

const terminalStatuses = new Set(["success", "failed", "partially_success", "canceled", "timeout"]);
const terminalItemStatuses = new Set(["success", "failed", "skipped", "canceled"]);

function parseMaybeNumber(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const next = Number(value);
  return Number.isInteger(next) && next > 0 ? next : null;
}

function makeIdempotencyKey(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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

function displayStatus(status: string): string {
  return status === "success" ? "done" : status;
}

function statusPillStyle(status: string): CSSProperties {
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

function resolveRunSummary(run: RunRecord): string {
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

function normalizeItemName(item: Record<string, unknown>): string {
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

function parseDimensions(raw: unknown): Array<{ name: string; score: number }> {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter(isRecord)
    .map((item) => ({
      name: typeof item.name === "string" ? item.name : "dimension",
      score: toNumber(item.score),
    }));
}

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

function scoreToBarPercent(score: number): number {
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

function runProgressSnapshot(run: RunRecord, detail: RunDetailReport | null): { completed: number; total: number; percent: number } {
  const summary = (run.summary || {}) as Record<string, unknown>;
  const total = Math.max(0, toNumber(summary.total));
  const runPercent = Math.max(0, Math.min(100, toNumber(run.progress)));
  if (detail && detail.runId === run.id) {
    const completed = detail.items.filter((item) => terminalItemStatuses.has(item.status)).length;
    const percent = total > 0 ? Math.max(runPercent, (completed / total) * 100) : runPercent;
    return { completed, total, percent };
  }
  const completed = total > 0 ? Math.round((runPercent / 100) * total) : 0;
  return { completed, total, percent: runPercent };
}

export function SuiteExecutionPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialRunId = parseMaybeNumber(searchParams.get("runId"));

  const [runMode, setRunMode] = useState<RunMode>("api_test");
  const [strategyMode, setStrategyMode] = useState<StrategyMode>("rule");

  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [suites, setSuites] = useState<SuiteRecord[]>([]);
  const [environments, setEnvironments] = useState<EnvironmentRecord[]>([]);
  const [datasets, setDatasets] = useState<DatasetRecord[]>([]);
  const [executionRules, setExecutionRules] = useState<RuleRecord[]>([]);
  const [scoringRules, setScoringRules] = useState<RuleRecord[]>([]);

  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(() => parseMaybeNumber(searchParams.get("projectId")));
  const [selectedSuiteId, setSelectedSuiteId] = useState<number | null>(() => parseMaybeNumber(searchParams.get("suiteId")));
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<number | null>(null);
  const [selectedDatasetId, setSelectedDatasetId] = useState<number | null>(null);
  const selectedSuite = useMemo(
    () => (selectedSuiteId ? suites.find((suite) => suite.id === selectedSuiteId) ?? null : null),
    [selectedSuiteId, suites]
  );

  const filteredDatasets = useMemo(() => {
    if (!selectedSuite) {
      return datasets;
    }
    const prefix = `${selectedSuite.name}-agent-dataset`;
    return datasets.filter((dataset) => dataset.name.startsWith(prefix));
  }, [datasets, selectedSuite]);

  useEffect(() => {
    if (runMode !== "benchmark") {
      return;
    }
    setSelectedDatasetId((prev) =>
      prev && filteredDatasets.some((item) => item.id === prev) ? prev : filteredDatasets[0]?.id ?? null
    );
  }, [runMode, filteredDatasets]);

  const [selectedScoringRuleId, setSelectedScoringRuleId] = useState<number | null>(null);
  const [selectedExecutionRuleId, setSelectedExecutionRuleId] = useState<number | null>(null);

  const [customExecutionConfig, setCustomExecutionConfig] = useState({
    timeoutMs: "8000",
    retryCount: "0",
    retryIntervalMs: "300",
  });

  const [runFilters, setRunFilters] = useState({
    projectId: "",
    suiteId: "",
    runType: "all",
    status: "all",
  });
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [runPage, setRunPage] = useState(1);
  const [runTotal, setRunTotal] = useState(0);
  const [runTotalPages, setRunTotalPages] = useState(1);

  const [activeRunId, setActiveRunId] = useState<number | null>(initialRunId);
  const [activeRun, setActiveRun] = useState<RunRecord | null>(null);
  const [activeRunDetail, setActiveRunDetail] = useState<RunDetailReport | null>(null);
  const [compareTargetRunId, setCompareTargetRunId] = useState<number | null>(null);
  const [compareResult, setCompareResult] = useState<Record<string, unknown> | null>(null);
  const [expandedItemId, setExpandedItemId] = useState<number | null>(null);

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: NoticeTone; text: string } | null>(null);

  const runItems = activeRunDetail?.items ?? [];
  const runLogs = activeRunDetail?.logs ?? [];

  const currentRunType = runTypeLabel(activeRun?.run_type);

  const runMetrics = useMemo(() => {
    if (!activeRun) {
      return null;
    }
    const summary = activeRun.summary || {};
    const total = toNumber(summary.total);
    const passed = toNumber(summary.passed);
    const failed = toNumber(summary.failed);
    const passRate = total > 0 ? (passed / total) * 100 : 0;
    if (activeRun.run_type === "agent_eval") {
      const scores = runItems
        .map((item) => (isRecord(item.score_result) ? item.score_result.total_score : null))
        .filter((value): value is number => typeof value === "number");
      const avgScore = scores.length > 0 ? scores.reduce((sum, value) => sum + value, 0) / scores.length : toNumber(summary.avg_score);
      const minScore = scores.length > 0 ? Math.min(...scores) : toNumber(summary.min_score);
      const maxScore = scores.length > 0 ? Math.max(...scores) : toNumber(summary.max_score);
      return {
        runType: "benchmark",
        total,
        avgScore,
        passRate,
        minScore,
        maxScore,
      };
    }
    return {
      runType: "api_test",
      total,
      passed,
      failed,
      passRate,
    };
  }, [activeRun, runItems]);

  const activeRunBanner = useMemo(() => {
    const runningFromList = runs.find((run) => !terminalStatuses.has(run.status));
    if (activeRun && !terminalStatuses.has(activeRun.status)) {
      return activeRun;
    }
    return runningFromList ?? null;
  }, [activeRun, runs]);

  const activeBannerProgress = useMemo(() => {
    if (!activeRunBanner) {
      return null;
    }
    return runProgressSnapshot(activeRunBanner, activeRunDetail);
  }, [activeRunBanner, activeRunDetail]);

  const compareModel = useMemo(() => {
    if (!compareResult || !isRecord(compareResult)) {
      return null;
    }
    const metrics = isRecord(compareResult.metrics) ? compareResult.metrics : {};
    const summary1 = isRecord(compareResult.summary1) ? compareResult.summary1 : {};
    const summary2 = isRecord(compareResult.summary2) ? compareResult.summary2 : {};
    const runType = typeof compareResult.runType === "string" ? compareResult.runType : activeRun?.run_type ?? "api_test";
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
      failed1: toNumber(metrics.failed1),
      failed2: toNumber(metrics.failed2),
      avgScore1: toNumber(metrics.avgScore1),
      avgScore2: toNumber(metrics.avgScore2),
      dimensions1: parseDimensions(metrics.dimensions1),
      dimensions2: parseDimensions(metrics.dimensions2),
      newFailures: Array.isArray(compareResult.newFailures) ? compareResult.newFailures.length : 0,
      fixedCases: Array.isArray(compareResult.fixedCases) ? compareResult.fixedCases.length : 0,
    };
  }, [activeRun?.run_type, compareResult]);

  const dimensionCompareRows = useMemo(() => {
    if (!compareModel || compareModel.runType !== "agent_eval") {
      return [];
    }
    const bucket = new Map<string, { left: number; right: number }>();
    compareModel.dimensions1.forEach((item) => {
      const current = bucket.get(item.name) ?? { left: 0, right: 0 };
      current.left = item.score;
      bucket.set(item.name, current);
    });
    compareModel.dimensions2.forEach((item) => {
      const current = bucket.get(item.name) ?? { left: 0, right: 0 };
      current.right = item.score;
      bucket.set(item.name, current);
    });
    return Array.from(bucket.entries())
      .map(([name, value]) => ({
        name,
        left: value.left,
        right: value.right,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }, [compareModel]);

  async function refreshBaseData(preferredProjectId?: number | null) {
    const [projectItems, executionRuleItems, scoringRuleItems] = await Promise.all([
      listProjects(),
      listRules("execution"),
      listRules("scoring"),
    ]);
    const activeExecutionRules = executionRuleItems.filter((item) => item.status === "active");
    const activeScoringRules = scoringRuleItems.filter((item) => item.status === "active");

    setProjects(projectItems);
    setExecutionRules(activeExecutionRules);
    setScoringRules(activeScoringRules);

    const nextProjectId =
      preferredProjectId && projectItems.some((item) => item.id === preferredProjectId) ? preferredProjectId : projectItems[0]?.id ?? null;
    setSelectedProjectId(nextProjectId);
    setRunFilters((prev) => ({ ...prev, projectId: nextProjectId ? String(nextProjectId) : "" }));

    return { nextProjectId, activeExecutionRules, activeScoringRules };
  }

  async function refreshProjectData(projectId: number, localRules?: { execution: RuleRecord[]; scoring: RuleRecord[] }) {
    const [suiteItems, environmentItems, datasetItems] = await Promise.all([
      listSuites(projectId),
      listEnvironments(projectId),
      listDatasets(projectId),
    ]);
    setSuites(suiteItems);
    setEnvironments(environmentItems);
    setDatasets(datasetItems);

    const executionList = localRules?.execution ?? executionRules;
    const scoringList = localRules?.scoring ?? scoringRules;

    setSelectedSuiteId((prev) => (prev && suiteItems.some((item) => item.id === prev) ? prev : suiteItems[0]?.id ?? null));
    setSelectedEnvironmentId((prev) =>
      prev && environmentItems.some((item) => item.id === prev) ? prev : environmentItems[0]?.id ?? null
    );
    setSelectedDatasetId((prev) => (prev && datasetItems.some((item) => item.id === prev) ? prev : null));
    setSelectedScoringRuleId((prev) => (prev && scoringList.some((item) => item.id === prev) ? prev : scoringList[0]?.id ?? null));
    setSelectedExecutionRuleId((prev) =>
      prev && executionList.some((item) => item.id === prev) ? prev : executionList[0]?.id ?? null
    );
  }

  async function refreshRunList(page = runPage) {
    const data = await listRunsPaged({
      projectId: runFilters.projectId ? Number(runFilters.projectId) : undefined,
      suiteId: runFilters.suiteId ? Number(runFilters.suiteId) : undefined,
      runType: runFilters.runType === "all" ? undefined : runFilters.runType === "benchmark" ? "agent_eval" : runFilters.runType,
      status: runFilters.status === "all" ? undefined : runFilters.status,
      page,
      pageSize: RUN_PAGE_SIZE,
      order: "desc",
    });
    const totalPages = data.totalPages ?? Math.max(1, Math.ceil(data.total / RUN_PAGE_SIZE));
    if (page > totalPages) {
      setRunPage(totalPages);
      if (totalPages !== page) {
        await refreshRunList(totalPages);
      }
      return;
    }
    setRuns(data.items);
    setRunTotal(data.total);
    setRunTotalPages(totalPages);
  }

  async function refreshAll() {
    setLoading(true);
    try {
      const base = await refreshBaseData(selectedProjectId);
      if (base.nextProjectId) {
        await refreshProjectData(base.nextProjectId, {
          execution: base.activeExecutionRules,
          scoring: base.activeScoringRules,
        });
      } else {
        setSuites([]);
        setEnvironments([]);
        setDatasets([]);
      }
      await refreshRunList();
      setNotice(null);
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "加载执行中心资源失败",
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
    if (!selectedProjectId) {
      setSuites([]);
      setEnvironments([]);
      setDatasets([]);
      return;
    }
    setLoading(true);
    void refreshProjectData(selectedProjectId)
      .catch((error: unknown) => {
        setNotice({
          tone: "error",
          text: error instanceof Error ? error.message : "加载项目资源失败",
        });
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId]);

  useEffect(() => {
    const next = new URLSearchParams();
    if (selectedProjectId) {
      next.set("projectId", String(selectedProjectId));
    }
    if (selectedSuiteId) {
      next.set("suiteId", String(selectedSuiteId));
    }
    if (activeRunId) {
      next.set("runId", String(activeRunId));
    }
    setSearchParams(next, { replace: true });
  }, [selectedProjectId, selectedSuiteId, activeRunId, setSearchParams]);

  useEffect(() => {
    const currentRunId = activeRunId;
    if (currentRunId === null) {
      setActiveRun(null);
      setActiveRunDetail(null);
      return;
    }
    const runId = currentRunId;
    let stopped = false;
    async function tick() {
      try {
        const [runRecord, detail] = await Promise.all([getRun(runId), getRunDetailReport(runId)]);
        if (stopped) {
          return;
        }
        setActiveRun(runRecord);
        setActiveRunDetail(detail);
      } catch (error) {
        if (!stopped) {
          setNotice({
            tone: "error",
            text: error instanceof Error ? error.message : "刷新 run 详情失败",
          });
        }
      }
    }
    void tick();
    const timer = window.setInterval(() => {
      void tick();
    }, 2000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [activeRunId]);

  useEffect(() => {
    if (!activeRun || terminalStatuses.has(activeRun.status)) {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshRunList(runPage).catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRun?.id, activeRun?.status, runFilters.projectId, runFilters.runType, runFilters.status, runFilters.suiteId, runPage]);

  async function onCreateRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProjectId || !selectedSuiteId || !selectedEnvironmentId) {
      setNotice({ tone: "error", text: "请先选择执行类型、项目、Suite、环境" });
      return;
    }
    if (runMode === "benchmark" && !selectedDatasetId) {
      setNotice({ tone: "error", text: "Benchmark 评测必须选择数据集" });
      return;
    }
    if (runMode === "benchmark" && !selectedScoringRuleId) {
      setNotice({ tone: "error", text: "Benchmark 评测必须选择评分规则" });
      return;
    }
    if (strategyMode === "rule" && !selectedExecutionRuleId && runMode === "api_test") {
      setNotice({ tone: "error", text: "规则模式下请选择 execution 规则" });
      return;
    }
    const timeoutMs = Number(customExecutionConfig.timeoutMs);
    const retryCount = Number(customExecutionConfig.retryCount);
    const retryIntervalMs = Number(customExecutionConfig.retryIntervalMs);
    if (strategyMode === "custom" && (!Number.isFinite(timeoutMs) || !Number.isFinite(retryCount) || !Number.isFinite(retryIntervalMs))) {
      setNotice({ tone: "error", text: "自定义执行配置必须为数字" });
      return;
    }

    setBusy(true);
    try {
      const created = await createRun(
        {
          runType: runMode,
          projectId: selectedProjectId,
          suiteId: selectedSuiteId,
          environmentId: selectedEnvironmentId,
          datasetId: runMode === "benchmark" ? selectedDatasetId ?? undefined : undefined,
          scoringRuleId: runMode === "benchmark" ? selectedScoringRuleId ?? undefined : undefined,
          executionRuleId: strategyMode === "rule" ? selectedExecutionRuleId ?? undefined : undefined,
          executionConfig:
            strategyMode === "custom"
              ? {
                  timeout_ms: Math.max(1, Math.trunc(timeoutMs)),
                  retry_count: Math.max(0, Math.trunc(retryCount)),
                  retry_interval_ms: Math.max(0, Math.trunc(retryIntervalMs)),
                }
              : undefined,
          evaluationMode: runMode === "benchmark" ? "with_reference" : undefined,
        },
        makeIdempotencyKey(runMode)
      );
      setActiveRunId(created.id);
      setExpandedItemId(null);
      setCompareResult(null);
      setCompareTargetRunId(null);
      setRunPage(1);
      await refreshRunList(1);
      setNotice({ tone: "success", text: `Run 创建成功：#${created.id}` });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "创建 run 失败",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onRefreshRunList(event?: FormEvent<HTMLFormElement>, targetPage = 1) {
    if (event) {
      event.preventDefault();
    }
    setLoading(true);
    try {
      setRunPage(targetPage);
      await refreshRunList(targetPage);
      setNotice(null);
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "加载运行列表失败",
      });
    } finally {
      setLoading(false);
    }
  }

  async function onCompareRun() {
    if (!activeRunId) {
      setNotice({ tone: "error", text: "请先选择 run" });
      return;
    }
    setBusy(true);
    try {
      const result = await compareRun(activeRunId, compareTargetRunId ?? undefined);
      setCompareResult(result);
      setNotice({ tone: "success", text: "Run 对比完成" });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Run 对比失败",
      });
    } finally {
      setBusy(false);
    }
  }

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
    <section style={{ display: "grid", gap: 14 }}>
      <FloatingNotice notice={notice} onClose={() => setNotice(null)} />
      <header style={{ display: "grid", gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 36 }}>执行中心</h2>
      </header>

      <section style={{ ...panelStyle, display: "grid", gap: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <strong style={{ fontSize: 18 }}>当前运行状态（Active Run）</strong>
          {activeRunId ? (
            <Link to={`/reports?runId=${activeRunId}`} style={{ color: "#8a3f1f", fontWeight: 700 }}>
              在报告中心查看 Run #{activeRunId}
            </Link>
          ) : null}
        </div>

        {!activeRunBanner ? (
          <div style={{ color: "#667173" }}>暂无运行中的任务，可在左侧发起新的执行。</div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <div style={{ fontWeight: 800 }}>Run #{activeRunBanner.id}</div>
                <span
                  style={{
                    ...statusPillStyle(activeRunBanner.status),
                    borderRadius: 999,
                    padding: "3px 10px",
                    fontSize: 12,
                    fontWeight: 700,
                  }}
                >
                  {displayStatus(activeRunBanner.status)}
                </span>
                <span style={{ color: "#5f6a6c" }}>{runTypeLabel(activeRunBanner.run_type)}</span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setActiveRunId(activeRunBanner.id);
                  setCompareResult(null);
                  setExpandedItemId(null);
                }}
                style={{
                  border: "1px solid rgba(31,37,39,0.2)",
                  borderRadius: 10,
                  padding: "7px 12px",
                  background: "#fff",
                  cursor: "pointer",
                  fontWeight: 700,
                }}
              >
                查看详情
              </button>
            </div>
            <div style={{ borderRadius: 8, background: "rgba(31,37,39,0.08)", height: 10, overflow: "hidden" }}>
              <div
                style={{
                  width: `${activeBannerProgress?.percent ?? 0}%`,
                  background: "linear-gradient(90deg, #3a7ec2, #52a0dc)",
                  height: "100%",
                }}
              />
            </div>
            <div style={{ color: "#5f6a6c", fontSize: 13 }}>
              进度：{activeBannerProgress?.total ? `${activeBannerProgress.completed}/${activeBannerProgress.total}` : `${Math.round(activeBannerProgress?.percent ?? 0)}%`}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 8 }}>
              {runTypeLabel(activeRunBanner.run_type) === "benchmark" ? (
                <>
                  <div style={{ borderRadius: 10, background: "rgba(31,37,39,0.05)", padding: "8px 10px" }}>
                    平均分：{toNumber((activeRunBanner.summary || {}).avg_score).toFixed(3)}
                  </div>
                  <div style={{ borderRadius: 10, background: "rgba(31,37,39,0.05)", padding: "8px 10px" }}>
                    通过率：
                    {toNumber((activeRunBanner.summary || {}).total) > 0
                      ? `${((toNumber((activeRunBanner.summary || {}).passed) / toNumber((activeRunBanner.summary || {}).total)) * 100).toFixed(1)}%`
                      : "0.0%"}
                  </div>
                  <div style={{ borderRadius: 10, background: "rgba(31,37,39,0.05)", padding: "8px 10px" }}>
                    最低分：{toNumber((activeRunBanner.summary || {}).min_score).toFixed(3)}
                  </div>
                  <div style={{ borderRadius: 10, background: "rgba(31,37,39,0.05)", padding: "8px 10px" }}>
                    最高分：{toNumber((activeRunBanner.summary || {}).max_score).toFixed(3)}
                  </div>
                </>
              ) : (
                <>
                  <div style={{ borderRadius: 10, background: "rgba(31,37,39,0.05)", padding: "8px 10px" }}>
                    通过：{toNumber((activeRunBanner.summary || {}).passed)}
                  </div>
                  <div style={{ borderRadius: 10, background: "rgba(31,37,39,0.05)", padding: "8px 10px" }}>
                    失败：{toNumber((activeRunBanner.summary || {}).failed)}
                  </div>
                  <div style={{ borderRadius: 10, background: "rgba(31,37,39,0.05)", padding: "8px 10px" }}>
                    成功率：
                    {toNumber((activeRunBanner.summary || {}).total) > 0
                      ? `${((toNumber((activeRunBanner.summary || {}).passed) / toNumber((activeRunBanner.summary || {}).total)) * 100).toFixed(1)}%`
                      : "0.0%"}
                  </div>
                  <div style={{ borderRadius: 10, background: "rgba(31,37,39,0.05)", padding: "8px 10px" }}>
                    总数：{toNumber((activeRunBanner.summary || {}).total)}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "minmax(360px, 0.9fr) minmax(0, 1.1fr)", gap: 12, alignItems: "start" }}>
        <form onSubmit={(event) => void onCreateRun(event)} style={{ ...panelStyle, display: "grid", gap: 12 }}>
          <strong style={{ fontSize: 18 }}>执行发起（Run Builder）</strong>
          <div style={{ color: "#5f6a6c" }}>选择 Suite + 环境，发起一次运行任务。</div>

          <div style={{ display: "grid", gap: 10 }}>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              <label style={{ display: "inline-flex", gap: 8, alignItems: "center", fontWeight: 600 }}>
                <input type="radio" checked={runMode === "api_test"} onChange={() => setRunMode("api_test")} disabled={busy} />
                API测试
              </label>
              <label style={{ display: "inline-flex", gap: 8, alignItems: "center", fontWeight: 600 }}>
                <input type="radio" checked={runMode === "benchmark"} onChange={() => setRunMode("benchmark")} disabled={busy} />
                Benchmark评测
              </label>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 8 }}>
              <select
                value={selectedProjectId ?? ""}
                onChange={(event) => setSelectedProjectId(event.target.value ? Number(event.target.value) : null)}
                disabled={busy || projects.length === 0}
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
                disabled={busy || suites.length === 0}
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
                value={selectedEnvironmentId ?? ""}
                onChange={(event) => setSelectedEnvironmentId(event.target.value ? Number(event.target.value) : null)}
                disabled={busy || environments.length === 0}
                style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
              >
                <option value="">环境</option>
                {environments.map((environment) => (
                  <option key={environment.id} value={environment.id}>
                    {environment.name}
                  </option>
                ))}
              </select>
              <Link
                to={selectedProjectId ? `/config/environment?projectId=${selectedProjectId}&tab=environment` : "/config/environment"}
                style={{
                  border: "1px solid rgba(31,37,39,0.2)",
                  borderRadius: 10,
                  padding: "9px 11px",
                  background: "#fff",
                  textAlign: "center",
                  color: "#1f2527",
                  fontWeight: 700,
                }}
              >
                环境信息配置
              </Link>
            </div>

            {runMode === "benchmark" ? (
              <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 8 }}>
                <select
                  value={selectedDatasetId ?? ""}
                  onChange={(event) => setSelectedDatasetId(event.target.value ? Number(event.target.value) : null)}
                  disabled={busy || filteredDatasets.length === 0}
                  style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
                >
                  <option value="">数据集</option>
                  {filteredDatasets.map((dataset) => (
                    <option key={dataset.id} value={dataset.id}>
                      {dataset.name}
                    </option>
                  ))}
                </select>
                <select
                  value={selectedScoringRuleId ?? ""}
                  onChange={(event) => setSelectedScoringRuleId(event.target.value ? Number(event.target.value) : null)}
                  disabled={busy || scoringRules.length === 0}
                  style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
                >
                  <option value="">评分规则</option>
                  {scoringRules.map((rule) => (
                    <option key={rule.id} value={rule.id}>
                      {rule.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <div style={{ border: "1px solid rgba(31,37,39,0.08)", borderRadius: 12, padding: 10, display: "grid", gap: 8 }}>
              <strong style={{ fontSize: 14 }}>执行策略（Execution Config）</strong>
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                <label style={{ display: "inline-flex", gap: 8, alignItems: "center", fontWeight: 600 }}>
                  <input type="radio" checked={strategyMode === "rule"} onChange={() => setStrategyMode("rule")} />
                  使用规则
                </label>
                <label style={{ display: "inline-flex", gap: 8, alignItems: "center", fontWeight: 600 }}>
                  <input type="radio" checked={strategyMode === "custom"} onChange={() => setStrategyMode("custom")} />
                  自定义
                </label>
              </div>
              {strategyMode === "rule" ? (
                <select
                  value={selectedExecutionRuleId ?? ""}
                  onChange={(event) => setSelectedExecutionRuleId(event.target.value ? Number(event.target.value) : null)}
                  disabled={busy || executionRules.length === 0}
                  style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
                >
                  <option value="">execution_rule_id</option>
                  {executionRules.map((rule) => (
                    <option key={rule.id} value={rule.id}>
                      {rule.name} (#{rule.id})
                    </option>
                  ))}
                </select>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 8 }}>
                  <input
                    value={customExecutionConfig.timeoutMs}
                    onChange={(event) => setCustomExecutionConfig((prev) => ({ ...prev, timeoutMs: event.target.value }))}
                    placeholder="timeout_ms"
                    style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
                  />
                  <input
                    value={customExecutionConfig.retryCount}
                    onChange={(event) => setCustomExecutionConfig((prev) => ({ ...prev, retryCount: event.target.value }))}
                    placeholder="retry_count"
                    style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
                  />
                  <input
                    value={customExecutionConfig.retryIntervalMs}
                    onChange={(event) =>
                      setCustomExecutionConfig((prev) => ({ ...prev, retryIntervalMs: event.target.value }))
                    }
                    placeholder="retry_interval_ms"
                    style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
                  />
                </div>
              )}
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="submit"
                disabled={busy}
                style={{
                  border: "none",
                  borderRadius: 10,
                  padding: "10px 14px",
                  background: "#bf5d36",
                  color: "#fff8eb",
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                {busy ? "创建中..." : "🚀 发起执行"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setRunMode("api_test");
                  setStrategyMode("rule");
                  setSelectedDatasetId(datasets[0]?.id ?? null);
                  setSelectedScoringRuleId(scoringRules[0]?.id ?? null);
                  setSelectedExecutionRuleId(executionRules[0]?.id ?? null);
                  setCustomExecutionConfig({ timeoutMs: "8000", retryCount: "0", retryIntervalMs: "300" });
                  setNotice({ tone: "info", text: "执行配置已重置" });
                }}
                disabled={busy}
                style={{
                  border: "1px solid rgba(31,37,39,0.2)",
                  borderRadius: 10,
                  padding: "10px 14px",
                  background: "#fff",
                  cursor: "pointer",
                  fontWeight: 700,
                }}
              >
                重置配置
              </button>
            </div>
          </div>
        </form>

        <div style={{ display: "grid", gap: 12 }}>
          <section style={{ ...panelStyle, display: "grid", gap: 10 }}>
            <strong style={{ fontSize: 18 }}>运行列表（Run List）</strong>
            <form onSubmit={(event) => void onRefreshRunList(event)} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr auto", gap: 8 }}>
              <select
                value={runFilters.projectId}
                onChange={(event) => setRunFilters((prev) => ({ ...prev, projectId: event.target.value }))}
                style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
              >
                <option value="">全部项目</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
              <select
                value={runFilters.suiteId}
                onChange={(event) => setRunFilters((prev) => ({ ...prev, suiteId: event.target.value }))}
                style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
              >
                <option value="">全部 Suite</option>
                {suites.map((suite) => (
                  <option key={suite.id} value={suite.id}>
                    {suite.name}
                  </option>
                ))}
              </select>
              <select
                value={runFilters.runType}
                onChange={(event) => setRunFilters((prev) => ({ ...prev, runType: event.target.value }))}
                style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
              >
                <option value="all">全部类型</option>
                <option value="api_test">api_test</option>
                <option value="benchmark">benchmark</option>
              </select>
              <select
                value={runFilters.status}
                onChange={(event) => setRunFilters((prev) => ({ ...prev, status: event.target.value }))}
                style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
              >
                <option value="all">全部状态</option>
                <option value="pending">pending</option>
                <option value="queued">queued</option>
                <option value="running">running</option>
                <option value="success">done</option>
                <option value="failed">failed</option>
                <option value="partially_success">partially_success</option>
                <option value="timeout">timeout</option>
              </select>
              <button
                type="submit"
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
                {loading ? "查询中..." : "查询"}
              </button>
            </form>

            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1120 }}>
                <thead>
                  <tr style={{ textAlign: "left", borderBottom: "1px solid rgba(31,37,39,0.12)" }}>
                    <th style={{ padding: "9px 8px" }}>run_id</th>
                    <th style={{ padding: "9px 8px" }}>run_type</th>
                    <th style={{ padding: "9px 8px" }}>项目</th>
                    <th style={{ padding: "9px 8px" }}>suite</th>
                    <th style={{ padding: "9px 8px" }}>状态</th>
                    <th style={{ padding: "9px 8px" }}>结果摘要</th>
                    <th style={{ padding: "9px 8px" }}>创建时间</th>
                    <th style={{ padding: "9px 8px" }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.length === 0 ? (
                    <tr>
                      <td colSpan={8} style={{ padding: "12px 8px", color: "#667173" }}>
                        暂无运行记录
                      </td>
                    </tr>
                  ) : (
                    runs.map((run) => (
                      <tr
                        key={run.id}
                        style={{
                          borderBottom: "1px solid rgba(31,37,39,0.08)",
                          background: run.id === activeRunId ? "rgba(191,93,54,0.13)" : "transparent",
                        }}
                      >
                        <td style={{ padding: "9px 8px", fontWeight: 700 }}>{run.id}</td>
                        <td style={{ padding: "9px 8px" }}>{runTypeLabel(run.run_type)}</td>
                        <td style={{ padding: "9px 8px" }}>
                          {projects.find((project) => project.id === run.project_id)?.name ?? `P${run.project_id}`}
                        </td>
                        <td style={{ padding: "9px 8px" }}>
                          {suites.find((suite) => suite.id === run.suite_id)?.name ?? `S${run.suite_id ?? "-"}`}
                        </td>
                        <td style={{ padding: "9px 8px" }}>
                          <span
                            style={{
                              ...statusPillStyle(run.status),
                              borderRadius: 999,
                              padding: "2px 9px",
                              fontSize: 12,
                              fontWeight: 700,
                            }}
                          >
                            {displayStatus(run.status)}
                          </span>
                        </td>
                        <td style={{ padding: "9px 8px" }}>{resolveRunSummary(run)}</td>
                        <td style={{ padding: "9px 8px" }}>{formatDate(run.created_at)}</td>
                        <td style={{ padding: "9px 8px" }}>
                          <button
                            type="button"
                            onClick={() => {
                              setActiveRunId(run.id);
                              setExpandedItemId(null);
                              setCompareResult(null);
                            }}
                            style={{
                              border: "1px solid rgba(31,37,39,0.2)",
                              borderRadius: 8,
                              padding: "4px 10px",
                              background: "#fff",
                              cursor: "pointer",
                            }}
                          >
                            查看详情
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontSize: 12, color: "#667173" }}>
              <span>
                第 {runPage} / {runTotalPages} 页 · 共 {runTotal} 条 · 每页 {RUN_PAGE_SIZE} 条
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  onClick={() => {
                    const nextPage = Math.max(1, runPage - 1);
                    if (nextPage === runPage) {
                      return;
                    }
                    void onRefreshRunList(undefined, nextPage);
                  }}
                  disabled={loading || runPage <= 1}
                  style={{
                    border: "1px solid rgba(31,37,39,0.2)",
                    borderRadius: 8,
                    padding: "6px 10px",
                    background: "#fff",
                    cursor: "pointer",
                    opacity: loading || runPage <= 1 ? 0.55 : 1,
                  }}
                >
                  上一页
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const nextPage = Math.min(runTotalPages, runPage + 1);
                    if (nextPage === runPage) {
                      return;
                    }
                    void onRefreshRunList(undefined, nextPage);
                  }}
                  disabled={loading || runPage >= runTotalPages}
                  style={{
                    border: "1px solid rgba(31,37,39,0.2)",
                    borderRadius: 8,
                    padding: "6px 10px",
                    background: "#fff",
                    cursor: "pointer",
                    opacity: loading || runPage >= runTotalPages ? 0.55 : 1,
                  }}
                >
                  下一页
                </button>
              </div>
            </div>
          </section>

          <section style={{ ...panelStyle, display: "grid", gap: 12 }}>
            <strong style={{ fontSize: 18 }}>Run详情（Run Detail）</strong>
            {!activeRun ? (
              <div style={{ color: "#667173" }}>请先从运行列表选择一条 run。</div>
            ) : (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0,1fr))", gap: 8 }}>
                  <div style={{ borderRadius: 10, background: "rgba(31,37,39,0.05)", padding: "8px 10px" }}>
                    <div style={{ fontSize: 12, color: "#677173" }}>run_id</div>
                    <div style={{ marginTop: 3, fontWeight: 700 }}>#{activeRun.id}</div>
                  </div>
                  <div style={{ borderRadius: 10, background: "rgba(31,37,39,0.05)", padding: "8px 10px" }}>
                    <div style={{ fontSize: 12, color: "#677173" }}>run_type</div>
                    <div style={{ marginTop: 3, fontWeight: 700 }}>{currentRunType}</div>
                  </div>
                  <div style={{ borderRadius: 10, background: "rgba(31,37,39,0.05)", padding: "8px 10px" }}>
                    <div style={{ fontSize: 12, color: "#677173" }}>status</div>
                    <div style={{ marginTop: 3, fontWeight: 700 }}>{displayStatus(activeRun.status)}</div>
                  </div>
                  <div style={{ borderRadius: 10, background: "rgba(31,37,39,0.05)", padding: "8px 10px" }}>
                    <div style={{ fontSize: 12, color: "#677173" }}>project</div>
                    <div style={{ marginTop: 3, fontWeight: 700 }}>
                      {projects.find((project) => project.id === activeRun.project_id)?.name ?? activeRun.project_id}
                    </div>
                  </div>
                  <div style={{ borderRadius: 10, background: "rgba(31,37,39,0.05)", padding: "8px 10px" }}>
                    <div style={{ fontSize: 12, color: "#677173" }}>suite</div>
                    <div style={{ marginTop: 3, fontWeight: 700 }}>
                      {suites.find((suite) => suite.id === activeRun.suite_id)?.name ?? activeRun.suite_id ?? "-"}
                    </div>
                  </div>
                  <div style={{ borderRadius: 10, background: "rgba(31,37,39,0.05)", padding: "8px 10px" }}>
                    <div style={{ fontSize: 12, color: "#677173" }}>created_at</div>
                    <div style={{ marginTop: 3, fontWeight: 700 }}>{formatDate(activeRun.created_at)}</div>
                  </div>
                </div>

                <div style={{ borderTop: "1px solid rgba(31,37,39,0.08)", paddingTop: 10, display: "grid", gap: 8 }}>
                  <strong style={{ fontSize: 14 }}>概览区</strong>
                  {runMetrics?.runType === "api_test" ? (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 8 }}>
                      <div style={{ borderRadius: 10, background: "rgba(31,37,39,0.05)", padding: "8px 10px" }}>total: {runMetrics.total}</div>
                      <div style={{ borderRadius: 10, background: "rgba(31,37,39,0.05)", padding: "8px 10px" }}>passed: {runMetrics.passed}</div>
                      <div style={{ borderRadius: 10, background: "rgba(31,37,39,0.05)", padding: "8px 10px" }}>failed: {runMetrics.failed}</div>
                      <div style={{ borderRadius: 10, background: "rgba(31,37,39,0.05)", padding: "8px 10px" }}>
                        pass_rate: {runMetrics.passRate.toFixed(1)}%
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0,1fr))", gap: 8 }}>
                      <div style={{ borderRadius: 10, background: "rgba(31,37,39,0.05)", padding: "8px 10px" }}>total: {runMetrics?.total ?? 0}</div>
                      <div style={{ borderRadius: 10, background: "rgba(31,37,39,0.05)", padding: "8px 10px" }}>
                        avg_score: {(runMetrics?.avgScore ?? 0).toFixed(3)}
                      </div>
                      <div style={{ borderRadius: 10, background: "rgba(31,37,39,0.05)", padding: "8px 10px" }}>
                        pass_rate: {(runMetrics?.passRate ?? 0).toFixed(1)}%
                      </div>
                      <div style={{ borderRadius: 10, background: "rgba(31,37,39,0.05)", padding: "8px 10px" }}>
                        min_score: {(runMetrics?.minScore ?? 0).toFixed(3)}
                      </div>
                      <div style={{ borderRadius: 10, background: "rgba(31,37,39,0.05)", padding: "8px 10px" }}>
                        max_score: {(runMetrics?.maxScore ?? 0).toFixed(3)}
                      </div>
                    </div>
                  )}
                </div>

                <div style={{ borderTop: "1px solid rgba(31,37,39,0.08)", paddingTop: 10, display: "grid", gap: 8 }}>
                  <strong style={{ fontSize: 14 }}>对比分析</strong>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}>
                    <select
                      value={compareTargetRunId ?? ""}
                      onChange={(event) => setCompareTargetRunId(event.target.value ? Number(event.target.value) : null)}
                      style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "8px 10px" }}
                    >
                      <option value="">自动选择历史 run</option>
                      {runs
                        .filter((run) => run.id !== activeRun.id)
                        .map((run) => (
                          <option key={run.id} value={run.id}>
                            #{run.id} · {runTypeLabel(run.run_type)} · {run.status}
                          </option>
                        ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => void onCompareRun()}
                      disabled={busy}
                      style={{
                        border: "1px solid rgba(31,37,39,0.2)",
                        borderRadius: 10,
                        padding: "8px 12px",
                        background: "#fff",
                        cursor: "pointer",
                      }}
                    >
                      对比
                    </button>
                  </div>
                  {!compareModel ? (
                    <div style={{ color: "#667173" }}>暂无对比结果</div>
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
                                  <div
                                    style={{
                                      width: `${scoreToBarPercent(entry.value)}%`,
                                      height: "100%",
                                      background: "linear-gradient(90deg, #3a7ec2, #52a0dc)",
                                    }}
                                  />
                                </div>
                              </div>
                            ))}
                          </div>
                          <div style={{ display: "grid", gap: 6 }}>
                            {dimensionCompareRows.length === 0 ? (
                              <span style={{ color: "#667173" }}>暂无维度对比</span>
                            ) : (
                              dimensionCompareRows.map((row) => (
                                <div key={row.name} style={{ display: "grid", gap: 2 }}>
                                  <div style={{ fontSize: 12, color: "#5f6a6c" }}>
                                    {row.name}：{row.left.toFixed(3)} → {row.right.toFixed(3)}
                                  </div>
                                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                                    <div style={{ borderRadius: 8, background: "rgba(31,37,39,0.08)", height: 6, overflow: "hidden" }}>
                                      <div style={{ width: `${scoreToBarPercent(row.left)}%`, height: "100%", background: "#9fb4cc" }} />
                                    </div>
                                    <div style={{ borderRadius: 8, background: "rgba(31,37,39,0.08)", height: 6, overflow: "hidden" }}>
                                      <div style={{ width: `${scoreToBarPercent(row.right)}%`, height: "100%", background: "#3a7ec2" }} />
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
                                  <div
                                    style={{
                                      width: `${Math.max(0, Math.min(100, entry.value))}%`,
                                      height: "100%",
                                      background: "linear-gradient(90deg, #3a7ec2, #52a0dc)",
                                    }}
                                  />
                                </div>
                              </div>
                            ))}
                          </div>
                          <div style={{ color: "#5f6a6c" }}>
                            失败数：{compareModel.failed1} → {compareModel.failed2} ｜ 新失败 {compareModel.newFailures} ｜ 已修复 {compareModel.fixedCases}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>

                <div style={{ borderTop: "1px solid rgba(31,37,39,0.08)", paddingTop: 10, display: "grid", gap: 8 }}>
                  <strong style={{ fontSize: 14 }}>执行日志</strong>
                  <div
                    style={{
                      borderRadius: 10,
                      border: "1px solid rgba(31,37,39,0.08)",
                      background: "rgba(31,37,39,0.03)",
                      maxHeight: 220,
                      overflow: "auto",
                      padding: "10px 12px",
                      fontFamily: "monospace",
                      fontSize: 12,
                      whiteSpace: "pre-wrap",
                    }}
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
                </div>

                <div style={{ borderTop: "1px solid rgba(31,37,39,0.08)", paddingTop: 10, display: "grid", gap: 8 }}>
                  <strong style={{ fontSize: 14 }}>run_item明细</strong>
                  {runItems.length === 0 ? (
                    <div style={{ color: "#667173" }}>暂无 run_item 明细</div>
                  ) : (
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1160 }}>
                        <thead>
                          <tr style={{ textAlign: "left", borderBottom: "1px solid rgba(31,37,39,0.12)" }}>
                            <th style={{ padding: "9px 8px" }}>case_name</th>
                            <th style={{ padding: "9px 8px" }}>status</th>
                            {currentRunType === "api_test" ? (
                              <>
                                <th style={{ padding: "9px 8px" }}>assertion</th>
                                <th style={{ padding: "9px 8px" }}>latency</th>
                              </>
                            ) : (
                              <>
                                <th style={{ padding: "9px 8px" }}>score</th>
                                <th style={{ padding: "9px 8px" }}>dimensions</th>
                              </>
                            )}
                            <th style={{ padding: "9px 8px" }}>error</th>
                            <th style={{ padding: "9px 8px" }}>详情</th>
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

                            const rows = [
                              <tr key={item.id} style={{ borderBottom: "1px solid rgba(31,37,39,0.08)", verticalAlign: "top" }}>
                                <td style={{ padding: "9px 8px", minWidth: 220 }}>{normalizeItemName(item as unknown as Record<string, unknown>)}</td>
                                <td style={{ padding: "9px 8px" }}>{item.status}</td>
                                {currentRunType === "api_test" ? (
                                  <>
                                    <td style={{ padding: "9px 8px" }}>{assertionSummary}</td>
                                    <td style={{ padding: "9px 8px" }}>{typeof item.duration_ms === "number" ? `${item.duration_ms}ms` : "-"}</td>
                                  </>
                                ) : (
                                  <>
                                    <td style={{ padding: "9px 8px" }}>{scoreValue}</td>
                                    <td style={{ padding: "9px 8px", maxWidth: 360 }}>{renderBenchmarkDimensions(item)}</td>
                                  </>
                                )}
                                <td
                                  style={{
                                    padding: "9px 8px",
                                    color: "#7b4330",
                                    maxWidth: 320,
                                    whiteSpace: "pre-wrap",
                                    wordBreak: "break-word",
                                    overflowWrap: "anywhere",
                                    lineHeight: 1.45,
                                  }}
                                >
                                  {errorMessage}
                                </td>
                                <td style={{ padding: "9px 8px" }}>
                                  <button
                                    type="button"
                                    onClick={() => setExpandedItemId((prev) => (prev === item.id ? null : item.id))}
                                    style={{
                                      border: "1px solid rgba(31,37,39,0.2)",
                                      borderRadius: 8,
                                      padding: "4px 10px",
                                      background: "#fff",
                                      cursor: "pointer",
                                    }}
                                  >
                                    {expanded ? "收起" : "展开"}
                                  </button>
                                </td>
                              </tr>,
                            ];

                            if (expanded) {
                              rows.push(
                                <tr key={`detail-${item.id}`} style={{ borderBottom: "1px solid rgba(31,37,39,0.08)" }}>
                                  <td colSpan={6} style={{ padding: "9px 8px" }}>
                                    {currentRunType === "api_test" ? (
                                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                                        <pre
                                          style={{
                                            margin: 0,
                                            borderRadius: 8,
                                            padding: 8,
                                            background: "rgba(31,37,39,0.03)",
                                            fontFamily: "monospace",
                                            fontSize: 12,
                                            whiteSpace: "pre-wrap",
                                            wordBreak: "break-word",
                                            overflowWrap: "anywhere",
                                          }}
                                        >{`request\n${toPretty(summarizeApiRequest(item.request_data))}`}</pre>
                                        <pre
                                          style={{
                                            margin: 0,
                                            borderRadius: 8,
                                            padding: 8,
                                            background: "rgba(31,37,39,0.03)",
                                            fontFamily: "monospace",
                                            fontSize: 12,
                                            whiteSpace: "pre-wrap",
                                            wordBreak: "break-word",
                                            overflowWrap: "anywhere",
                                          }}
                                        >{`response\n${toPretty(summarizeApiResponse(item.response_data, item.assertion_result))}`}</pre>
                                        <pre
                                          style={{
                                            margin: 0,
                                            borderRadius: 8,
                                            padding: 8,
                                            background: "rgba(31,37,39,0.03)",
                                            fontFamily: "monospace",
                                            fontSize: 12,
                                            whiteSpace: "pre-wrap",
                                            wordBreak: "break-word",
                                            overflowWrap: "anywhere",
                                          }}
                                        >{`assertion detail\n${toPretty(summarizeApiAssertion(item.assertion_result))}`}</pre>
                                      </div>
                                    ) : (
                                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
                                        <pre
                                          style={{ margin: 0, borderRadius: 8, padding: 8, background: "rgba(31,37,39,0.03)", fontFamily: "monospace", fontSize: 12 }}
                                        >{`input\n${toPretty(item.request_data)}`}</pre>
                                        <pre
                                          style={{ margin: 0, borderRadius: 8, padding: 8, background: "rgba(31,37,39,0.03)", fontFamily: "monospace", fontSize: 12 }}
                                        >{`output\n${toPretty(item.response_data ?? item.parsed_output)}`}</pre>
                                        <pre
                                          style={{ margin: 0, borderRadius: 8, padding: 8, background: "rgba(31,37,39,0.03)", fontFamily: "monospace", fontSize: 12 }}
                                        >{`score breakdown\n${toPretty(item.score_result)}`}</pre>
                                        <pre
                                          style={{ margin: 0, borderRadius: 8, padding: 8, background: "rgba(31,37,39,0.03)", fontFamily: "monospace", fontSize: 12 }}
                                        >{`judge reason\n${toPretty(item.error_info)}`}</pre>
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
                </div>
              </>
            )}
          </section>
        </div>
      </section>
    </section>
  );
}
