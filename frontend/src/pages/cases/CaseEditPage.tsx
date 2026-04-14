import { FormEvent, type CSSProperties, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";

import { FloatingNotice, type NoticeTone } from "../../components/FloatingNotice";
import {
  CaseRecord,
  SuiteRecord,
  changeCaseStatus,
  deleteCase,
  getCase,
  listSuites,
  updateCase,
} from "../../services/assetService";

type EditForm = {
  name: string;
  description: string;
  status: string;
  priority: string;
  suiteId: number | null;
  inputPayloadText: string;
  expectedOutputText: string;
  assertionConfigText: string;
  evalConfigText: string;
};

const panelStyle: CSSProperties = {
  borderRadius: 12,
  padding: 16,
  background: "#ffffff",
  border: "1px solid #E5E7EB",
  boxShadow: "none",
};

function parseOptionalObject(text: string, fieldName: string): Record<string, unknown> | undefined {
  const raw = text.trim();
  if (!raw) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${fieldName} 不是合法 JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${fieldName} 必须是 JSON 对象`);
  }
  return parsed as Record<string, unknown>;
}

function formatJson(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "";
  }
}

export function CaseEditPage() {
  const navigate = useNavigate();
  const params = useParams();
  const [searchParams] = useSearchParams();
  const caseId = Number(params.caseId);

  const [record, setRecord] = useState<CaseRecord | null>(null);
  const [suites, setSuites] = useState<SuiteRecord[]>([]);
  const [form, setForm] = useState<EditForm | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: NoticeTone; text: string } | null>(null);

  const isValidCaseId = Number.isInteger(caseId) && caseId > 0;

  const caseListHref = useMemo(() => {
    const queryTab = searchParams.get("returnTab");
    const tab =
      queryTab === "agent_benchmark_cases" || queryTab === "api_suite_cases"
        ? queryTab
        : record?.case_type === "agent"
          ? "agent_benchmark_cases"
          : "api_suite_cases";

    const queryProjectId = searchParams.get("projectId");
    const querySuiteId = searchParams.get("suiteId");
    const projectId = queryProjectId ?? (record ? String(record.project_id) : null);
    const suiteId = querySuiteId ?? (record?.suite_id ? String(record.suite_id) : null);

    const next = new URLSearchParams();
    next.set("tab", tab);
    if (projectId) {
      next.set("projectId", projectId);
    }
    if (suiteId) {
      next.set("suiteId", suiteId);
    }
    return `/assets?${next.toString()}`;
  }, [record, searchParams]);

  async function loadCase() {
    if (!isValidCaseId) {
      setNotice({ tone: "error", text: "caseId 不合法" });
      return;
    }
    setLoading(true);
    try {
      const caseRecord = await getCase(caseId);
      setRecord(caseRecord);
      const suiteData = await listSuites(caseRecord.project_id);
      setSuites(suiteData);
      setForm({
        name: caseRecord.name ?? "",
        description: caseRecord.description ?? "",
        status: caseRecord.status ?? "draft",
        priority: caseRecord.priority ?? "P2",
        suiteId: caseRecord.suite_id ?? null,
        inputPayloadText: formatJson(caseRecord.input_payload),
        expectedOutputText: formatJson(caseRecord.expected_output),
        assertionConfigText: formatJson(caseRecord.assertion_config),
        evalConfigText: formatJson(caseRecord.eval_config),
      });
      setNotice(null);
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "加载 case 失败",
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadCase();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!record || !form) {
      return;
    }
    if (!form.name.trim()) {
      setNotice({ tone: "error", text: "case 名称不能为空" });
      return;
    }

    setBusy(true);
    try {
      const inputPayload = parseOptionalObject(form.inputPayloadText, "input_payload");
      if (!inputPayload) {
        throw new Error("input_payload 不能为空");
      }

      const expectedOutput = parseOptionalObject(form.expectedOutputText, "expected_output");
      const assertionConfig = parseOptionalObject(form.assertionConfigText, "assertion_config");
      const evalConfig = parseOptionalObject(form.evalConfigText, "eval_config");

      const payload: {
        suiteId?: number | null;
        name: string;
        description?: string;
        status: string;
        priority: string;
        caseType: string;
        inputPayload: Record<string, unknown>;
        expectedOutput?: Record<string, unknown>;
        assertionConfig?: Record<string, unknown>;
        evalConfig?: Record<string, unknown>;
      } = {
        suiteId: form.suiteId,
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        status: form.status,
        priority: form.priority,
        caseType: record.case_type,
        inputPayload,
      };

      if (expectedOutput) {
        payload.expectedOutput = expectedOutput;
      }
      if (assertionConfig) {
        payload.assertionConfig = assertionConfig;
      }
      if (evalConfig) {
        payload.evalConfig = evalConfig;
      }

      const updated = await updateCase(caseId, payload);
      setRecord(updated);
      setForm({
        name: updated.name ?? "",
        description: updated.description ?? "",
        status: updated.status ?? "draft",
        priority: updated.priority ?? "P2",
        suiteId: updated.suite_id ?? null,
        inputPayloadText: formatJson(updated.input_payload),
        expectedOutputText: formatJson(updated.expected_output),
        assertionConfigText: formatJson(updated.assertion_config),
        evalConfigText: formatJson(updated.eval_config),
      });
      setNotice({ tone: "success", text: `case ${caseId} 已保存` });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "保存失败",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onArchive() {
    if (!record) {
      return;
    }
    setBusy(true);
    try {
      const updated = await changeCaseStatus(record.id, "archived");
      setRecord(updated);
      setForm((prev) => (prev ? { ...prev, status: "archived" } : prev));
      setNotice({ tone: "success", text: `case ${record.id} 已归档` });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "归档失败",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!record) {
      return;
    }
    setBusy(true);
    try {
      await deleteCase(record.id);
      setNotice({ tone: "success", text: `case ${record.id} 已删除/归档` });
      navigate(caseListHref);
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "删除失败",
      });
    } finally {
      setBusy(false);
    }
  }

  const currentSuiteName = useMemo(() => {
    if (!record?.suite_id) {
      return "-";
    }
    return suites.find((item) => item.id === record.suite_id)?.name ?? String(record.suite_id);
  }, [record, suites]);

  if (!isValidCaseId) {
    return (
      <section className="case-edit-page grid gap-3">
        <h2 className="page-title m-0">Case 编辑</h2>
        <p>caseId 不合法。</p>
      </section>
    );
  }

  return (
    <section className="case-edit-page grid gap-4">
      <FloatingNotice notice={notice} onClose={() => setNotice(null)} />
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="page-title m-0">Case 编辑页</h2>
        </div>
        <Link to={caseListHref} className="text-sm font-semibold text-primary hover:text-primary/80">
          返回 case 列表
        </Link>
      </header>

      {loading || !record || !form ? (
        <div style={{ ...panelStyle, color: "#667173" }}>{loading ? "加载中..." : "暂无数据"}</div>
      ) : (
        <form onSubmit={(event) => void onSubmit(event)} style={{ display: "grid", gap: 12 }}>
          <div style={{ ...panelStyle, display: "grid", gap: 8 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
              <label style={{ display: "grid", gap: 5 }}>
                <span style={{ fontSize: 12, color: "#667173" }}>caseId</span>
                <input value={String(record.id)} disabled style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }} />
              </label>
              <label style={{ display: "grid", gap: 5 }}>
                <span style={{ fontSize: 12, color: "#667173" }}>caseType</span>
                <input value={record.case_type} disabled style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }} />
              </label>
              <label style={{ display: "grid", gap: 5 }}>
                <span style={{ fontSize: 12, color: "#667173" }}>当前 Suite</span>
                <input value={currentSuiteName} disabled style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }} />
              </label>
              <label style={{ display: "grid", gap: 5 }}>
                <span style={{ fontSize: 12, color: "#667173" }}>更新于</span>
                <input
                  value={(record as { updated_at?: string }).updated_at ?? "-"}
                  disabled
                  style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
                />
              </label>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr 1fr", gap: 8 }}>
              <input
                value={form.name}
                onChange={(event) => setForm((prev) => (prev ? { ...prev, name: event.target.value } : prev))}
                placeholder="case 名称"
                disabled={busy}
                style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
              />
              <select
                value={form.suiteId ?? ""}
                onChange={(event) =>
                  setForm((prev) => (prev ? { ...prev, suiteId: event.target.value ? Number(event.target.value) : null } : prev))
                }
                disabled={busy}
                style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
              >
                <option value="">无 suite</option>
                {suites.map((suite) => (
                  <option key={suite.id} value={suite.id}>
                    {suite.name}
                  </option>
                ))}
              </select>
              <select
                value={form.status}
                onChange={(event) => setForm((prev) => (prev ? { ...prev, status: event.target.value } : prev))}
                disabled={busy}
                style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
              >
                <option value="draft">draft</option>
                <option value="active">active</option>
                <option value="archived">archived</option>
              </select>
              <select
                value={form.priority}
                onChange={(event) => setForm((prev) => (prev ? { ...prev, priority: event.target.value } : prev))}
                disabled={busy}
                style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
              >
                <option value="P0">P0</option>
                <option value="P1">P1</option>
                <option value="P2">P2</option>
                <option value="P3">P3</option>
              </select>
            </div>

            <textarea
              value={form.description}
              onChange={(event) => setForm((prev) => (prev ? { ...prev, description: event.target.value } : prev))}
              placeholder="描述（可选）"
              rows={2}
              disabled={busy}
              style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px", fontFamily: "inherit" }}
            />
          </div>

          <div style={{ ...panelStyle, display: "grid", gap: 8 }}>
            <strong>input_payload</strong>
            <textarea
              value={form.inputPayloadText}
              onChange={(event) => setForm((prev) => (prev ? { ...prev, inputPayloadText: event.target.value } : prev))}
              rows={10}
              disabled={busy}
              style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px", fontFamily: "monospace" }}
            />
          </div>

          <div style={{ ...panelStyle, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div style={{ display: "grid", gap: 8 }}>
              <strong>expected_output</strong>
              <textarea
                value={form.expectedOutputText}
                onChange={(event) => setForm((prev) => (prev ? { ...prev, expectedOutputText: event.target.value } : prev))}
                rows={8}
                disabled={busy}
                style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px", fontFamily: "monospace" }}
              />
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              <strong>assertion_config</strong>
              <textarea
                value={form.assertionConfigText}
                onChange={(event) => setForm((prev) => (prev ? { ...prev, assertionConfigText: event.target.value } : prev))}
                rows={8}
                disabled={busy}
                style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px", fontFamily: "monospace" }}
              />
            </div>
          </div>

          <div style={{ ...panelStyle, display: "grid", gap: 8 }}>
            <strong>eval_config</strong>
            <textarea
              value={form.evalConfigText}
              onChange={(event) => setForm((prev) => (prev ? { ...prev, evalConfigText: event.target.value } : prev))}
              rows={8}
              disabled={busy}
              style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px", fontFamily: "monospace" }}
            />
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
              {busy ? "保存中..." : "保存变更"}
            </button>
            <button
              type="button"
              onClick={() => void onArchive()}
              disabled={busy}
              style={{
                border: "1px solid rgba(31,37,39,0.2)",
                borderRadius: 10,
                padding: "10px 14px",
                background: "#fff",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              归档 case
            </button>
            <button
              type="button"
              onClick={() => void onDelete()}
              disabled={busy}
              style={{
                border: "1px solid rgba(191,93,54,0.38)",
                borderRadius: 10,
                padding: "10px 14px",
                background: "rgba(191,93,54,0.08)",
                color: "#8f3a1a",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              删除（归档）
            </button>
            <button
              type="button"
              onClick={() => navigate(-1)}
              disabled={busy}
              style={{
                border: "1px solid rgba(31,37,39,0.2)",
                borderRadius: 10,
                padding: "10px 14px",
                background: "#fff",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              返回上一层
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
