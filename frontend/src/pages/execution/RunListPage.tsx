import { FormEvent, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { FloatingNotice, type NoticeTone } from "../../components/FloatingNotice";
import { ProjectRecord, SuiteRecord, getSuite, listProjects, listSuites } from "../../services/assetService";
import { RunRecord, deleteRun, listRunsPaged } from "../../services/runService";
import {
  displayStatus,
  formatDate,
  panelStyle,
  parseMaybeNumber,
  resolveRunSummary,
  runTypeLabel,
  statusPillStyle,
  terminalStatuses,
  toNumber,
} from "./executionShared";

type TimeRange = "all" | "24h" | "7d" | "30d";
const RUN_PAGE_SIZE = 9;

function formatTriggerSource(run: RunRecord): string {
  if (run.trigger_type === "scheduled") {
    return typeof run.source_id === "number" ? `定时任务 #${run.source_id}` : "定时任务";
  }
  if (run.trigger_type === "manual") {
    return "手动触发";
  }
  return run.trigger_type || "-";
}

function displayReportDeliveryStatus(run: RunRecord): string {
  const status = String(run.report_delivery_status || "").trim().toLowerCase();
  if (!status || status === "disabled") {
    return "-";
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

export function ExecutionRunListPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [suites, setSuites] = useState<SuiteRecord[]>([]);
  const [runSuiteNameMap, setRunSuiteNameMap] = useState<Record<number, string>>({});
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [runPage, setRunPage] = useState(() => parseMaybeNumber(searchParams.get("page")) ?? 1);
  const [runTotal, setRunTotal] = useState(0);
  const [runTotalPages, setRunTotalPages] = useState(1);

  const [filters, setFilters] = useState({
    projectId: searchParams.get("projectId") ?? "",
    suiteId: searchParams.get("suiteId") ?? "",
    runType: searchParams.get("runType") ?? "all",
    status: searchParams.get("status") ?? "all",
    timeRange: (searchParams.get("timeRange") as TimeRange) || "all",
  });
  const [focusRunId, setFocusRunId] = useState<number | null>(() => parseMaybeNumber(searchParams.get("runId")));

  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<{ tone: NoticeTone; text: string } | null>(null);

  const activeRun = useMemo(() => runs.find((run) => !terminalStatuses.has(run.status)) ?? null, [runs]);

  const activeProgress = useMemo(() => {
    if (!activeRun) {
      return 0;
    }
    const progress = toNumber(activeRun.progress);
    return Math.max(0, Math.min(100, progress));
  }, [activeRun]);

  async function refreshCatalog() {
    const projectItems = await listProjects();
    setProjects(projectItems);
    const targetProjectId = filters.projectId ? Number(filters.projectId) : projectItems[0]?.id;
    if (targetProjectId) {
      const suiteItems = await listSuites(targetProjectId);
      setSuites(suiteItems);
    } else {
      setSuites([]);
    }
  }

  async function refreshRunList(page = runPage) {
    const data = await listRunsPaged({
      projectId: filters.projectId ? Number(filters.projectId) : undefined,
      suiteId: filters.suiteId ? Number(filters.suiteId) : undefined,
      runType: filters.runType === "all" ? undefined : filters.runType === "benchmark" ? "agent_eval" : filters.runType,
      status: filters.status === "all" ? undefined : filters.status,
      timeRange: filters.timeRange,
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

  async function hydrateRunSuiteNames(runItems: RunRecord[]) {
    const suiteIds = Array.from(
      new Set(runItems.map((run) => run.suite_id).filter((suiteId): suiteId is number => typeof suiteId === "number" && suiteId > 0))
    );
    const missingIds = suiteIds.filter((suiteId) => !runSuiteNameMap[suiteId]);
    if (missingIds.length === 0) {
      return;
    }
    const fetched = await Promise.all(
      missingIds.map(async (suiteId) => {
        try {
          const suite = await getSuite(suiteId);
          const name = typeof suite.name === "string" ? suite.name.trim() : "";
          return name ? ([suiteId, name] as const) : null;
        } catch {
          return null;
        }
      })
    );
    setRunSuiteNameMap((prev) => {
      const next = { ...prev };
      for (const pair of fetched) {
        if (pair) {
          const [suiteId, suiteName] = pair;
          next[suiteId] = suiteName;
        }
      }
      return next;
    });
  }

  async function refreshAll() {
    setLoading(true);
    try {
      await refreshCatalog();
      await refreshRunList();
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

  useEffect(() => {
    void refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!filters.projectId) {
      setSuites([]);
      return;
    }
    void listSuites(Number(filters.projectId))
      .then((items) => setSuites(items))
      .catch(() => setSuites([]));
  }, [filters.projectId]);

  useEffect(() => {
    const next = new URLSearchParams();
    if (filters.projectId) {
      next.set("projectId", filters.projectId);
    }
    if (filters.suiteId) {
      next.set("suiteId", filters.suiteId);
    }
    if (filters.runType !== "all") {
      next.set("runType", filters.runType);
    }
    if (filters.status !== "all") {
      next.set("status", filters.status);
    }
    if (filters.timeRange !== "all") {
      next.set("timeRange", filters.timeRange);
    }
    if (focusRunId) {
      next.set("runId", String(focusRunId));
    }
    if (runPage > 1) {
      next.set("page", String(runPage));
    }
    setSearchParams(next, { replace: true });
  }, [filters, focusRunId, runPage, setSearchParams]);

  useEffect(() => {
    if (!activeRun) {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshRunList().catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRun?.id, activeRun?.status, filters.projectId, filters.suiteId, filters.runType, filters.status, filters.timeRange, runPage]);

  useEffect(() => {
    void hydrateRunSuiteNames(runs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs]);

  async function onQuery(event?: FormEvent<HTMLFormElement>, targetPage = 1) {
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
        text: error instanceof Error ? error.message : "查询运行列表失败",
      });
    } finally {
      setLoading(false);
    }
  }

  async function onDeleteRun(run: RunRecord) {
    if (!window.confirm(`确认删除 Run #${run.id} 吗？`)) {
      return;
    }
    setLoading(true);
    try {
      await deleteRun(run.id);
      if (focusRunId === run.id) {
        setFocusRunId(null);
      }
      await refreshRunList();
      setNotice({ tone: "success", text: `Run #${run.id} 已删除` });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : `删除 Run #${run.id} 失败`,
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="execution-page grid gap-4">
      <FloatingNotice notice={notice} onClose={() => setNotice(null)} />
      <header className="grid gap-2">
        <h2 className="page-title m-0">运行列表</h2>
      </header>

      {activeRun ? (
        <section style={panelStyle} className="console-panel grid gap-2">
          <strong className="text-base font-semibold">当前运行状态</strong>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <div className="font-extrabold">Run #{activeRun.id}</div>
              <span
                className="status-pill"
                style={{
                  ...statusPillStyle(activeRun.status),
                  padding: "3px 10px",
                  fontSize: 12,
                }}
              >
                {displayStatus(activeRun.status)}
              </span>
              <span className="text-sm text-muted-foreground">{runTypeLabel(activeRun.run_type)}</span>
            </div>
            <button
              type="button"
              onClick={() => navigate(`/results/detail?runId=${activeRun.id}`)}
              className="console-btn-secondary"
            >
              查看
            </button>
          </div>
          <div className="h-2.5 overflow-hidden rounded-lg bg-muted">
            <div
              style={{
                width: `${activeProgress}%`,
                background: "linear-gradient(90deg, #3a7ec2, #52a0dc)",
                height: "100%",
              }}
            />
          </div>
          <div className="text-[13px] text-muted-foreground">{resolveRunSummary(activeRun)}</div>
        </section>
      ) : null}

      <section style={panelStyle} className="console-panel grid gap-2.5">
        <strong className="section-title">Run 列表</strong>
        <form onSubmit={(event) => void onQuery(event)} className="grid gap-2 xl:grid-cols-[repeat(5,minmax(0,1fr))_auto]">
          <select
            value={filters.projectId}
            onChange={(event) => setFilters((prev) => ({ ...prev, projectId: event.target.value, suiteId: "" }))}
          >
            <option value="">全部项目</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <select
            value={filters.suiteId}
            onChange={(event) => setFilters((prev) => ({ ...prev, suiteId: event.target.value }))}
          >
            <option value="">全部 Suite</option>
            {suites.map((suite) => (
              <option key={suite.id} value={suite.id}>
                {suite.name}
              </option>
            ))}
          </select>
          <select
            value={filters.runType}
            onChange={(event) => setFilters((prev) => ({ ...prev, runType: event.target.value }))}
          >
            <option value="all">全部类型</option>
            <option value="api_test">api_test</option>
            <option value="benchmark">benchmark</option>
          </select>
          <select
            value={filters.status}
            onChange={(event) => setFilters((prev) => ({ ...prev, status: event.target.value }))}
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
          <select
            value={filters.timeRange}
            onChange={(event) => setFilters((prev) => ({ ...prev, timeRange: event.target.value as TimeRange }))}
          >
            <option value="all">全部时间</option>
            <option value="24h">最近24小时</option>
            <option value="7d">最近7天</option>
            <option value="30d">最近30天</option>
          </select>
          <button
            type="submit"
            disabled={loading}
            className="console-btn-primary disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? "查询中..." : "查询"}
          </button>
        </form>

        <div className="overflow-x-auto">
          <table className="data-table min-w-[1320px]">
            <thead>
              <tr>
                <th>run_id</th>
                <th>类型</th>
                <th>项目</th>
                <th>suite</th>
                <th className="min-w-[140px] whitespace-nowrap">触发来源</th>
                <th className="min-w-[130px] whitespace-nowrap">发送状态</th>
                <th>状态</th>
                <th>结果摘要</th>
                <th>时间</th>
                <th>操作</th>
              </tr>
            </thead>
                <tbody>
              {runs.length === 0 ? (
                <tr>
                  <td colSpan={10} className="py-3 text-muted-foreground">
                    暂无运行记录
                  </td>
                </tr>
              ) : (
                runs.map((run) => (
                  <tr
                    key={run.id}
                    style={{
                      background: run.id === focusRunId ? "rgba(191,93,54,0.13)" : "transparent",
                    }}
                  >
                    <td className="font-bold">{run.id}</td>
                    <td>{runTypeLabel(run.run_type)}</td>
                    <td>
                      {projects.find((project) => project.id === run.project_id)?.name ?? `P${run.project_id}`}
                    </td>
                    <td>
                      {typeof run.suite_id === "number"
                        ? (runSuiteNameMap[run.suite_id] ?? suites.find((suite) => suite.id === run.suite_id)?.name ?? String(run.suite_id))
                        : "全部 Suite"}
                    </td>
                    <td className="whitespace-nowrap">
                      <span className="status-pill" style={{ padding: "2px 9px", fontSize: 12 }}>
                        {formatTriggerSource(run)}
                      </span>
                    </td>
                    <td className="whitespace-nowrap">
                      {(() => {
                        const deliveryStatus = displayReportDeliveryStatus(run);
                        return (
                          <span className="status-pill" style={{ ...reportDeliveryPillStyle(deliveryStatus), padding: "2px 9px", fontSize: 12 }}>
                            {deliveryStatus}
                          </span>
                        );
                      })()}
                    </td>
                    <td>
                      <span
                        className="status-pill"
                        style={{
                          ...statusPillStyle(run.status),
                          padding: "2px 9px",
                          fontSize: 12,
                        }}
                      >
                        {displayStatus(run.status)}
                      </span>
                    </td>
                    <td>{resolveRunSummary(run)}</td>
                    <td>{formatDate(run.created_at)}</td>
                    <td>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => navigate(`/results/detail?runId=${run.id}`)}
                          className="console-btn-secondary"
                        >
                          查看详情
                        </button>
                        {terminalStatuses.has(run.status) ? (
                          <button
                            type="button"
                            onClick={() => void onDeleteRun(run)}
                            disabled={loading}
                            className="console-btn-danger disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            删除
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            第 {runPage} / {runTotalPages} 页 · 共 {runTotal} 条 · 每页 {RUN_PAGE_SIZE} 条
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                const nextPage = Math.max(1, runPage - 1);
                if (nextPage === runPage) {
                  return;
                }
                void onQuery(undefined, nextPage);
              }}
              disabled={loading || runPage <= 1}
              className="console-btn-secondary min-h-[28px] px-2 text-[11px] disabled:cursor-not-allowed disabled:opacity-60"
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
                void onQuery(undefined, nextPage);
              }}
              disabled={loading || runPage >= runTotalPages}
              className="console-btn-secondary min-h-[28px] px-2 text-[11px] disabled:cursor-not-allowed disabled:opacity-60"
            >
              下一页
            </button>
          </div>
        </div>
      </section>
    </section>
  );
}
