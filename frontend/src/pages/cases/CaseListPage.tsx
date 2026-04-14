import { FormEvent, type CSSProperties, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { FloatingNotice, type NoticeTone } from "../../components/FloatingNotice";
import {
  CaseRecord,
  ProjectRecord,
  SuiteRecord,
  changeCaseStatus,
  createCase,
  createProject,
  createSuite,
  deleteCase,
  listCases,
  listProjects,
  listSuites,
} from "../../services/assetService";
type CaseType = "api" | "agent";

type CaseCreateForm = {
  name: string;
  caseType: CaseType;
  description: string;
  method: string;
  path: string;
  bodyJson: string;
  expectedStatusCode: string;
  expectedJson: string;
  userInput: string;
  referenceAnswer: string;
};

const panelStyle: CSSProperties = {
  borderRadius: 12,
  padding: 16,
  background: "#ffffff",
  border: "1px solid #E5E7EB",
  boxShadow: "none",
};

function parseObjectJson(raw: string, fallback: Record<string, unknown>, fieldName: string) {
  const text = raw.trim();
  if (!text) {
    return fallback;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${fieldName} 不是合法 JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${fieldName} 必须是 JSON 对象`);
  }
  return parsed as Record<string, unknown>;
}

function buildDefaultCaseForm(): CaseCreateForm {
  return {
    name: "",
    caseType: "api",
    description: "",
    method: "POST",
    path: "/api/order/create",
    bodyJson: '{"userId": 1001, "skuId": 2002, "count": 1}',
    expectedStatusCode: "200",
    expectedJson: '{"code": 0, "message": "success"}',
    userInput: "帮我总结这段需求，输出三个要点",
    referenceAnswer: '{"summary_points":["要点1","要点2","要点3"]}',
  };
}

export function CaseListPage() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [suites, setSuites] = useState<SuiteRecord[]>([]);
  const [cases, setCases] = useState<CaseRecord[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [selectedSuiteId, setSelectedSuiteId] = useState<number | null>(null);
  const [queryCaseType, setQueryCaseType] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [keyword, setKeyword] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: NoticeTone; text: string } | null>(null);

  const [projectForm, setProjectForm] = useState({
    name: "",
    projectType: "hybrid",
    description: "",
  });
  const [suiteForm, setSuiteForm] = useState({
    name: "",
    suiteType: "api",
    description: "",
  });
  const [caseForm, setCaseForm] = useState<CaseCreateForm>(buildDefaultCaseForm());

  async function refreshProjects() {
    const projectData = await listProjects();
    setProjects(projectData);
    setSelectedProjectId((prev) =>
      prev && projectData.some((item) => item.id === prev) ? prev : projectData[0]?.id ?? null
    );
  }

  async function refreshSuitesAndCases(projectId: number) {
    const [suiteData, caseData] = await Promise.all([
      listSuites(projectId),
      listCases(projectId, selectedSuiteId ?? undefined, queryCaseType === "all" ? undefined : queryCaseType),
    ]);
    setSuites(suiteData);
    setCases(caseData);
    setSelectedSuiteId((prev) => {
      if (prev === null) {
        return null;
      }
      return suiteData.some((item) => item.id === prev) ? prev : suiteData[0]?.id ?? null;
    });
  }

  async function refreshAll() {
    setLoading(true);
    try {
      await refreshProjects();
      if (selectedProjectId) {
        await refreshSuitesAndCases(selectedProjectId);
      }
      setNotice(null);
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "加载用例资产失败",
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
      setCases([]);
      return;
    }
    setLoading(true);
    void refreshSuitesAndCases(selectedProjectId)
      .catch((error: unknown) => {
        setNotice({
          tone: "error",
          text: error instanceof Error ? error.message : "加载项目用例失败",
        });
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId, selectedSuiteId, queryCaseType]);

  async function onCreateProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectForm.name.trim()) {
      setNotice({ tone: "error", text: "项目名称不能为空" });
      return;
    }
    setBusy(true);
    try {
      const created = await createProject({
        name: projectForm.name.trim(),
        projectType: projectForm.projectType,
        description: projectForm.description.trim() || undefined,
      });
      setProjectForm({ name: "", projectType: "hybrid", description: "" });
      setSelectedProjectId(created.id);
      setNotice({ tone: "success", text: `项目创建成功：${created.name}` });
      await refreshProjects();
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "创建项目失败",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onCreateSuite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProjectId) {
      setNotice({ tone: "error", text: "请先选择项目" });
      return;
    }
    if (!suiteForm.name.trim()) {
      setNotice({ tone: "error", text: "suite 名称不能为空" });
      return;
    }
    setBusy(true);
    try {
      const created = await createSuite({
        projectId: selectedProjectId,
        name: suiteForm.name.trim(),
        suiteType: suiteForm.suiteType,
        description: suiteForm.description.trim() || undefined,
      });
      setSuiteForm({ name: "", suiteType: suiteForm.suiteType, description: "" });
      setSelectedSuiteId(created.id);
      setNotice({ tone: "success", text: `suite 创建成功：${created.name}` });
      await refreshSuitesAndCases(selectedProjectId);
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "创建 suite 失败",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onCreateCase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProjectId) {
      setNotice({ tone: "error", text: "请先选择项目" });
      return;
    }
    if (!selectedSuiteId) {
      setNotice({ tone: "error", text: "请先选择 suite" });
      return;
    }
    if (!caseForm.name.trim()) {
      setNotice({ tone: "error", text: "case 名称不能为空" });
      return;
    }

    setBusy(true);
    try {
      if (caseForm.caseType === "api") {
        const body = parseObjectJson(caseForm.bodyJson, {}, "请求 body");
        const expectedJson = parseObjectJson(caseForm.expectedJson, { code: 0 }, "预期 JSON");
        const statusCode = Number(caseForm.expectedStatusCode);
        if (!Number.isInteger(statusCode) || statusCode < 100) {
          throw new Error("预期状态码不合法");
        }
        await createCase({
          projectId: selectedProjectId,
          suiteId: selectedSuiteId,
          name: caseForm.name.trim(),
          description: caseForm.description.trim() || undefined,
          caseType: "api",
          sourceType: "manual",
          status: "draft",
          priority: "P2",
          inputPayload: {
            schema_version: "1.0",
            method: caseForm.method.trim().toUpperCase() || "POST",
            path: caseForm.path.trim() || "/api/order/create",
            headers: {
              "Content-Type": "application/json",
            },
            query: {},
            body,
          },
          expectedOutput: {
            schema_version: "1.0",
            status_code: statusCode,
            json_fields: expectedJson,
          },
          assertionConfig: {
            mode: "json_fields",
          },
        });
      } else {
        const reference = parseObjectJson(caseForm.referenceAnswer, { answer: "待补充" }, "参考答案");
        await createCase({
          projectId: selectedProjectId,
          suiteId: selectedSuiteId,
          name: caseForm.name.trim(),
          description: caseForm.description.trim() || undefined,
          caseType: "agent",
          sourceType: "manual",
          status: "draft",
          priority: "P2",
          inputPayload: {
            schema_version: "1.0",
            user_input: caseForm.userInput.trim() || "请输出三个要点",
            conversation_history: [],
            tools_context: [],
            constraints: {
              language: "zh",
            },
          },
          expectedOutput: {
            schema_version: "1.0",
            reference_answer: reference,
          },
          evalConfig: {
            schema_version: "1.0",
            evaluation_mode: "with_reference",
            evaluators: [
              { type: "json_match", weight: 0.4 },
              { type: "llm_judge", weight: 0.6 },
            ],
            threshold: 0.8,
          },
        });
      }
      setCaseForm(buildDefaultCaseForm());
      setNotice({ tone: "success", text: "case 创建成功" });
      await refreshSuitesAndCases(selectedProjectId);
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "创建 case 失败",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onArchiveCase(caseId: number) {
    setBusy(true);
    try {
      await changeCaseStatus(caseId, "archived");
      if (selectedProjectId) {
        await refreshSuitesAndCases(selectedProjectId);
      }
      setNotice({ tone: "success", text: `case ${caseId} 已归档` });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "归档 case 失败",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onActivateCase(caseId: number) {
    setBusy(true);
    try {
      await changeCaseStatus(caseId, "active");
      if (selectedProjectId) {
        await refreshSuitesAndCases(selectedProjectId);
      }
      setNotice({ tone: "success", text: `case ${caseId} 已启用` });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "启用 case 失败",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteCase(caseId: number) {
    setBusy(true);
    try {
      await deleteCase(caseId);
      if (selectedProjectId) {
        await refreshSuitesAndCases(selectedProjectId);
      }
      setNotice({ tone: "success", text: `case ${caseId} 已删除/归档` });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "删除 case 失败",
      });
    } finally {
      setBusy(false);
    }
  }

  const filteredCases = useMemo(() => {
    const lowerKeyword = keyword.trim().toLowerCase();
    return cases.filter((item) => {
      const statusOk = statusFilter === "all" || item.status === statusFilter;
      const keywordOk =
        !lowerKeyword ||
        item.name.toLowerCase().includes(lowerKeyword) ||
        String(item.id).includes(lowerKeyword);
      return statusOk && keywordOk;
    });
  }, [cases, keyword, statusFilter]);

  return (
    <section style={{ display: "grid", gap: 16 }}>
      <FloatingNotice notice={notice} onClose={() => setNotice(null)} />
      <header style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ display: "grid", gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 38 }}>Case 列表与编辑入口</h2>
        </div>
        <Link to="/assets/center" style={{ color: "#8a3f1f", fontWeight: 700 }}>
          打开资产上传与生成页
        </Link>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        <form onSubmit={(event) => void onCreateProject(event)} style={{ ...panelStyle, display: "grid", gap: 8 }}>
          <strong>创建项目</strong>
          <input
            value={projectForm.name}
            onChange={(event) => setProjectForm((prev) => ({ ...prev, name: event.target.value }))}
            placeholder="项目名称"
            disabled={busy}
            style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
          />
          <select
            value={projectForm.projectType}
            onChange={(event) => setProjectForm((prev) => ({ ...prev, projectType: event.target.value }))}
            disabled={busy}
            style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
          >
            <option value="hybrid">hybrid</option>
            <option value="api">api</option>
            <option value="agent">agent</option>
          </select>
          <input
            value={projectForm.description}
            onChange={(event) => setProjectForm((prev) => ({ ...prev, description: event.target.value }))}
            placeholder="描述（可选）"
            disabled={busy}
            style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
          />
          <button
            type="submit"
            disabled={busy}
            style={{
              border: "none",
              borderRadius: 10,
              padding: "9px 11px",
              background: "#bf5d36",
              color: "#fff8eb",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {busy ? "处理中..." : "创建项目"}
          </button>
        </form>

        <form onSubmit={(event) => void onCreateSuite(event)} style={{ ...panelStyle, display: "grid", gap: 8 }}>
          <strong>创建 Suite</strong>
          <select
            value={selectedProjectId ?? ""}
            onChange={(event) => setSelectedProjectId(event.target.value ? Number(event.target.value) : null)}
            disabled={busy || projects.length === 0}
            style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
          >
            {projects.length === 0 ? <option value="">暂无项目</option> : null}
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <input
            value={suiteForm.name}
            onChange={(event) => setSuiteForm((prev) => ({ ...prev, name: event.target.value }))}
            placeholder="suite 名称"
            disabled={busy || !selectedProjectId}
            style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
          />
          <select
            value={suiteForm.suiteType}
            onChange={(event) => setSuiteForm((prev) => ({ ...prev, suiteType: event.target.value }))}
            disabled={busy || !selectedProjectId}
            style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
          >
            <option value="api">api</option>
            <option value="agent_eval">agent_eval</option>
            <option value="regression">regression</option>
            <option value="smoke">smoke</option>
            <option value="dataset">dataset</option>
          </select>
          <button
            type="submit"
            disabled={busy || !selectedProjectId}
            style={{
              border: "none",
              borderRadius: 10,
              padding: "9px 11px",
              background: "#1f2527",
              color: "#fff8eb",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {busy ? "处理中..." : "创建 suite"}
          </button>
        </form>

        <div style={{ ...panelStyle, display: "grid", gap: 8 }}>
          <strong>筛选与查询</strong>
          <select
            value={selectedSuiteId ?? ""}
            onChange={(event) => setSelectedSuiteId(event.target.value ? Number(event.target.value) : null)}
            disabled={busy || suites.length === 0}
            style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
          >
            <option value="">全部 suite</option>
            {suites.map((suite) => (
              <option key={suite.id} value={suite.id}>
                {suite.name}
              </option>
            ))}
          </select>
          <select
            value={queryCaseType}
            onChange={(event) => setQueryCaseType(event.target.value)}
            disabled={busy}
            style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
          >
            <option value="all">全部类型</option>
            <option value="api">api</option>
            <option value="agent">agent</option>
          </select>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
            disabled={busy}
            style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
          >
            <option value="all">全部状态</option>
            <option value="draft">draft</option>
            <option value="active">active</option>
            <option value="archived">archived</option>
          </select>
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="按 case 名称或 ID 搜索"
            disabled={busy}
            style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
          />
          <button
            type="button"
            onClick={() => void refreshAll()}
            disabled={loading || busy}
            style={{
              border: "none",
              borderRadius: 10,
              padding: "9px 11px",
              background: "rgba(31,37,39,0.86)",
              color: "#fff8eb",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {loading ? "刷新中..." : "刷新列表"}
          </button>
        </div>
      </div>

      <form onSubmit={(event) => void onCreateCase(event)} style={{ ...panelStyle, display: "grid", gap: 10 }}>
        <div style={{ fontSize: 18, fontWeight: 800 }}>创建 Case</div>
        <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr", gap: 8 }}>
          <input
            value={caseForm.name}
            onChange={(event) => setCaseForm((prev) => ({ ...prev, name: event.target.value }))}
            placeholder="case 名称"
            disabled={busy || !selectedProjectId || !selectedSuiteId}
            style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
          />
          <select
            value={caseForm.caseType}
            onChange={(event) => setCaseForm((prev) => ({ ...prev, caseType: event.target.value as CaseType }))}
            disabled={busy || !selectedProjectId || !selectedSuiteId}
            style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
          >
            <option value="api">api</option>
            <option value="agent">agent</option>
          </select>
          <input
            value={caseForm.description}
            onChange={(event) => setCaseForm((prev) => ({ ...prev, description: event.target.value }))}
            placeholder="描述（可选）"
            disabled={busy || !selectedProjectId || !selectedSuiteId}
            style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
          />
        </div>

        {caseForm.caseType === "api" ? (
          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ display: "grid", gridTemplateColumns: "180px 1fr 180px", gap: 8 }}>
              <input
                value={caseForm.method}
                onChange={(event) => setCaseForm((prev) => ({ ...prev, method: event.target.value }))}
                placeholder="METHOD"
                disabled={busy || !selectedProjectId || !selectedSuiteId}
                style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
              />
              <input
                value={caseForm.path}
                onChange={(event) => setCaseForm((prev) => ({ ...prev, path: event.target.value }))}
                placeholder="/api/xxx"
                disabled={busy || !selectedProjectId || !selectedSuiteId}
                style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
              />
              <input
                value={caseForm.expectedStatusCode}
                onChange={(event) => setCaseForm((prev) => ({ ...prev, expectedStatusCode: event.target.value }))}
                placeholder="状态码"
                disabled={busy || !selectedProjectId || !selectedSuiteId}
                style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
              />
            </div>
            <textarea
              value={caseForm.bodyJson}
              onChange={(event) => setCaseForm((prev) => ({ ...prev, bodyJson: event.target.value }))}
              rows={4}
              placeholder='请求 body JSON，例如 {"userId":1001}'
              disabled={busy || !selectedProjectId || !selectedSuiteId}
              style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px", fontFamily: "monospace" }}
            />
            <textarea
              value={caseForm.expectedJson}
              onChange={(event) => setCaseForm((prev) => ({ ...prev, expectedJson: event.target.value }))}
              rows={3}
              placeholder='预期 json_fields，例如 {"code":0}'
              disabled={busy || !selectedProjectId || !selectedSuiteId}
              style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px", fontFamily: "monospace" }}
            />
          </div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            <textarea
              value={caseForm.userInput}
              onChange={(event) => setCaseForm((prev) => ({ ...prev, userInput: event.target.value }))}
              rows={3}
              placeholder="用户输入"
              disabled={busy || !selectedProjectId || !selectedSuiteId}
              style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
            />
            <textarea
              value={caseForm.referenceAnswer}
              onChange={(event) => setCaseForm((prev) => ({ ...prev, referenceAnswer: event.target.value }))}
              rows={3}
              placeholder='参考答案 JSON，例如 {"summary_points":["要点1","要点2"]}'
              disabled={busy || !selectedProjectId || !selectedSuiteId}
              style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px", fontFamily: "monospace" }}
            />
          </div>
        )}

        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="submit"
            disabled={busy || !selectedProjectId || !selectedSuiteId}
            style={{
              border: "none",
              borderRadius: 10,
              padding: "9px 14px",
              background: "#bf5d36",
              color: "#fff8eb",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {busy ? "处理中..." : "创建 case"}
          </button>
          <button
            type="button"
            onClick={() => setCaseForm(buildDefaultCaseForm())}
            disabled={busy}
            style={{
              border: "1px solid rgba(31,37,39,0.2)",
              borderRadius: 10,
              padding: "9px 14px",
              background: "rgba(255,255,255,0.8)",
              color: "#1f2527",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            重置表单
          </button>
        </div>
      </form>

      <div style={{ ...panelStyle, display: "grid", gap: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <strong>Case 列表 ({filteredCases.length})</strong>
          <span style={{ fontSize: 12, color: "#687274" }}>支持编辑、归档、启用、删除</span>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 940 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid rgba(31,37,39,0.12)" }}>
                <th style={{ padding: "10px 8px" }}>ID</th>
                <th style={{ padding: "10px 8px" }}>Name</th>
                <th style={{ padding: "10px 8px" }}>Type</th>
                <th style={{ padding: "10px 8px" }}>Status</th>
                <th style={{ padding: "10px 8px" }}>Suite</th>
                <th style={{ padding: "10px 8px" }}>Updated</th>
                <th style={{ padding: "10px 8px" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredCases.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ padding: "14px 8px", color: "#677173" }}>
                    暂无符合条件的 case
                  </td>
                </tr>
              ) : (
                filteredCases.map((item) => (
                  <tr key={item.id} style={{ borderBottom: "1px solid rgba(31,37,39,0.08)" }}>
                    <td style={{ padding: "10px 8px", fontWeight: 700 }}>{item.id}</td>
                    <td style={{ padding: "10px 8px" }}>{item.name}</td>
                    <td style={{ padding: "10px 8px" }}>{item.case_type}</td>
                    <td style={{ padding: "10px 8px" }}>{item.status}</td>
                    <td style={{ padding: "10px 8px" }}>{item.suite_id ?? "-"}</td>
                    <td style={{ padding: "10px 8px" }}>{(item as { updated_at?: string }).updated_at ?? "-"}</td>
                    <td style={{ padding: "10px 8px", display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <button
                        type="button"
                        onClick={() => navigate(`/assets/cases/${item.id}/edit`)}
                        disabled={busy}
                        style={{
                          border: "1px solid rgba(31,37,39,0.2)",
                          borderRadius: 8,
                          padding: "6px 10px",
                          background: "#fff",
                          cursor: "pointer",
                        }}
                      >
                        编辑
                      </button>
                      {item.status === "archived" ? (
                        <button
                          type="button"
                          onClick={() => void onActivateCase(item.id)}
                          disabled={busy}
                          style={{
                            border: "1px solid rgba(31,37,39,0.2)",
                            borderRadius: 8,
                            padding: "6px 10px",
                            background: "#fff",
                            cursor: "pointer",
                          }}
                        >
                          启用
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void onArchiveCase(item.id)}
                          disabled={busy}
                          style={{
                            border: "1px solid rgba(31,37,39,0.2)",
                            borderRadius: 8,
                            padding: "6px 10px",
                            background: "#fff",
                            cursor: "pointer",
                          }}
                        >
                          归档
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void onDeleteCase(item.id)}
                        disabled={busy}
                        style={{
                          border: "1px solid rgba(191,93,54,0.38)",
                          borderRadius: 8,
                          padding: "6px 10px",
                          background: "rgba(191,93,54,0.08)",
                          color: "#8f3a1a",
                          cursor: "pointer",
                        }}
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
