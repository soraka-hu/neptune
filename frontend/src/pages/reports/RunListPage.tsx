import { FormEvent, type CSSProperties, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { FloatingNotice, type NoticeTone } from "../../components/FloatingNotice";
import { ProjectRecord, listProjects } from "../../services/assetService";
import { RunRecord, listRunsPaged } from "../../services/runService";

const panelStyle: CSSProperties = {
  borderRadius: 12,
  padding: 16,
  background: "#ffffff",
  border: "1px solid #E5E7EB",
  boxShadow: "none",
};
const RUN_PAGE_SIZE = 9;

export function RunListPage() {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [runPage, setRunPage] = useState(1);
  const [runTotal, setRunTotal] = useState(0);
  const [runTotalPages, setRunTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<{ tone: NoticeTone; text: string } | null>(null);
  const [filters, setFilters] = useState({
    projectId: "",
    status: "all",
    runType: "all",
  });

  async function refreshData(page = runPage) {
    setLoading(true);
    try {
      const [projectData, runData] = await Promise.all([
        listProjects(),
        listRunsPaged({
          projectId: filters.projectId ? Number(filters.projectId) : undefined,
          status: filters.status === "all" ? undefined : filters.status,
          runType: filters.runType === "all" ? undefined : filters.runType,
          page,
          pageSize: RUN_PAGE_SIZE,
          order: "desc",
        }),
      ]);
      setProjects(projectData);
      const totalPages = runData.totalPages ?? Math.max(1, Math.ceil(runData.total / RUN_PAGE_SIZE));
      if (page > totalPages) {
        setRunPage(totalPages);
        if (totalPages !== page) {
          await refreshData(totalPages);
        }
        return;
      }
      setRuns(runData.items);
      setRunTotal(runData.total);
      setRunTotalPages(totalPages);
      setNotice(null);
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "加载 run 列表失败",
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRunPage(1);
    await refreshData(1);
  }

  return (
    <section style={{ display: "grid", gap: 14 }}>
      <FloatingNotice notice={notice} onClose={() => setNotice(null)} />
      <header style={{ display: "grid", gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 36 }}>Run 列表页</h2>
      </header>

      <form onSubmit={(event) => void onSubmit(event)} style={{ ...panelStyle, display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 8 }}>
        <select
          value={filters.projectId}
          onChange={(event) => setFilters((prev) => ({ ...prev, projectId: event.target.value }))}
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
          value={filters.status}
          onChange={(event) => setFilters((prev) => ({ ...prev, status: event.target.value }))}
          style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
        >
          <option value="all">全部状态</option>
          <option value="pending">pending</option>
          <option value="queued">queued</option>
          <option value="running">running</option>
          <option value="partially_success">partially_success</option>
          <option value="success">success</option>
          <option value="failed">failed</option>
          <option value="canceled">canceled</option>
          <option value="timeout">timeout</option>
        </select>
        <select
          value={filters.runType}
          onChange={(event) => setFilters((prev) => ({ ...prev, runType: event.target.value }))}
          style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
        >
          <option value="all">全部类型</option>
          <option value="api_test">api_test</option>
          <option value="agent_eval">agent_eval</option>
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
          {loading ? "加载中..." : "查询"}
        </button>
      </form>

      <div style={{ ...panelStyle, display: "grid", gap: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <strong>Run 列表 ({runs.length})</strong>
          <button
            type="button"
            onClick={() => void refreshData(runPage)}
            disabled={loading}
            style={{
              border: "1px solid rgba(31,37,39,0.2)",
              borderRadius: 8,
              padding: "6px 10px",
              background: "#fff",
              cursor: "pointer",
            }}
          >
            刷新
          </button>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 980 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid rgba(31,37,39,0.12)" }}>
                <th style={{ padding: "9px 8px" }}>Run ID</th>
                <th style={{ padding: "9px 8px" }}>Run No</th>
                <th style={{ padding: "9px 8px" }}>Type</th>
                <th style={{ padding: "9px 8px" }}>Status</th>
                <th style={{ padding: "9px 8px" }}>Project/Suite</th>
                <th style={{ padding: "9px 8px" }}>Summary</th>
                <th style={{ padding: "9px 8px" }}>Updated</th>
                <th style={{ padding: "9px 8px" }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {runs.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ padding: "12px 8px", color: "#667173" }}>
                    暂无 run 数据
                  </td>
                </tr>
              ) : (
                runs.map((run) => (
                  <tr key={run.id} style={{ borderBottom: "1px solid rgba(31,37,39,0.08)" }}>
                    <td style={{ padding: "9px 8px", fontWeight: 700 }}>{run.id}</td>
                    <td style={{ padding: "9px 8px" }}>{run.run_no}</td>
                    <td style={{ padding: "9px 8px" }}>{run.run_type}</td>
                    <td style={{ padding: "9px 8px" }}>{run.status}</td>
                    <td style={{ padding: "9px 8px" }}>
                      P{run.project_id} / S{run.suite_id ?? "-"}
                    </td>
                    <td style={{ padding: "9px 8px" }}>
                      {run.summary
                        ? `${run.summary.passed ?? 0}/${run.summary.total ?? 0} passed, failed ${run.summary.failed ?? 0}`
                        : "-"}
                    </td>
                    <td style={{ padding: "9px 8px" }}>{run.updated_at ?? "-"}</td>
                    <td style={{ padding: "9px 8px" }}>
                      <Link to={`/reports/runs/${run.id}`} style={{ color: "#8a3f1f", fontWeight: 700 }}>
                        查看详情
                      </Link>
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
                setRunPage(nextPage);
                void refreshData(nextPage);
              }}
              disabled={loading || runPage <= 1}
              className="console-btn-secondary disabled:cursor-not-allowed disabled:opacity-60"
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
                setRunPage(nextPage);
                void refreshData(nextPage);
              }}
              disabled={loading || runPage >= runTotalPages}
              className="console-btn-secondary disabled:cursor-not-allowed disabled:opacity-60"
            >
              下一页
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
