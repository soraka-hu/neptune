import { FormEvent, type CSSProperties, useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { useSearchParams } from "react-router-dom";

import { FloatingNotice, type NoticeTone } from "../../components/FloatingNotice";
import { cn } from "../../lib/utils";
import {
  EnvironmentRecord,
  ModelConfigRecord,
  ProjectRecord,
  createEnvironment,
  createModelConfig,
  deleteEnvironment,
  deleteModelConfig,
  listEnvironmentsPaged,
  listModelConfigs,
  listProjects,
  updateEnvironment,
  updateModelConfig,
} from "../../services/assetService";

type ConfigTab = "environment" | "model";

type KeyValueEntry = {
  id: string;
  key: string;
  value: string;
};

type EnvironmentFormState = {
  projectId: number | null;
  name: string;
  envType: string;
  status: string;
  baseUrl: string;
  headersEntries: KeyValueEntry[];
  variablesEntries: KeyValueEntry[];
  secretsRefEntries: KeyValueEntry[];
};

type ModelFormState = {
  projectIds: number[];
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  status: string;
};

const panelStyle: CSSProperties = {
  borderRadius: 12,
  padding: 16,
  background: "#ffffff",
  border: "1px solid #E5E7EB",
  boxShadow: "none",
};

const secondaryButtonClass = "console-btn-secondary disabled:cursor-not-allowed disabled:opacity-60";
const primaryButtonClass = "console-btn-primary disabled:cursor-not-allowed disabled:opacity-60";
const dangerButtonClass = "console-btn-danger disabled:cursor-not-allowed disabled:opacity-60";
const tabButtonClass = "console-tab";
const tabButtonActiveClass = "console-tab console-tab-active";
const ENV_PAGE_SIZE = 9;

function parseMaybeNumber(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const next = Number(value);
  return Number.isInteger(next) && next > 0 ? next : null;
}

function parseConfigTab(value: string | null): ConfigTab {
  if (value === "model") {
    return "model";
  }
  return "environment";
}

let keyValueEntrySeed = 0;

function newKeyValueEntry(key = "", value = ""): KeyValueEntry {
  keyValueEntrySeed += 1;
  return { id: `kv_${keyValueEntrySeed}`, key, value };
}

function ensureEntryList(entries: KeyValueEntry[]): KeyValueEntry[] {
  return entries.length > 0 ? entries : [newKeyValueEntry()];
}

function stringifyValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function objectToEntries(value: unknown): KeyValueEntry[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [newKeyValueEntry()];
  }
  const entries = Object.entries(value as Record<string, unknown>).map(([key, itemValue]) =>
    newKeyValueEntry(key, stringifyValue(itemValue))
  );
  return ensureEntryList(entries);
}

function parseEntryValue(
  rawValue: string,
  fieldLabel: string,
  key: string,
  options?: { coercePrimitive?: boolean }
): unknown {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return "";
  }
  if (options?.coercePrimitive === false) {
    return rawValue;
  }
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (trimmed === "null") {
    return null;
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      throw new Error(`${fieldLabel} 中键 ${key} 的值不是合法 JSON`);
    }
  }
  return rawValue;
}

function entriesToOptionalObject(
  entries: KeyValueEntry[],
  fieldLabel: string,
  options?: { coercePrimitive?: boolean }
): Record<string, unknown> | undefined {
  const result: Record<string, unknown> = {};
  const seen = new Set<string>();

  for (const entry of entries) {
    const key = entry.key.trim();
    const value = entry.value;
    const hasAnyInput = key.length > 0 || value.trim().length > 0;
    if (!hasAnyInput) {
      continue;
    }
    if (!key) {
      throw new Error(`${fieldLabel} 存在空键，请补全 key`);
    }
    if (seen.has(key)) {
      throw new Error(`${fieldLabel} 中键 ${key} 重复，请修改`);
    }
    seen.add(key);
    result[key] = parseEntryValue(value, fieldLabel, key, options);
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function defaultEnvironmentForm(): EnvironmentFormState {
  return {
    projectId: null,
    name: "",
    envType: "test",
    status: "active",
    baseUrl: "",
    headersEntries: [newKeyValueEntry()],
    variablesEntries: [newKeyValueEntry()],
    secretsRefEntries: [newKeyValueEntry()],
  };
}

function defaultModelForm(): ModelFormState {
  return {
    projectIds: [],
    name: "",
    provider: "openai",
    model: "gpt-5.4-mini",
    baseUrl: "",
    apiKey: "",
    status: "active",
  };
}

function maskApiKey(value: string | undefined): string {
  if (!value) {
    return "-";
  }
  if (value.length <= 8) {
    return "********";
  }
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

function projectNameById(projects: ProjectRecord[], projectId: number | null | undefined): string {
  if (!projectId) {
    return "-";
  }
  return projects.find((item) => item.id === projectId)?.name ?? `项目${projectId}`;
}

function projectNamesByIds(projects: ProjectRecord[], projectIds: number[] | undefined): string {
  const ids = Array.from(new Set((projectIds ?? []).filter((item) => Number.isInteger(item) && item > 0)));
  if (ids.length === 0) {
    return "-";
  }
  return ids.map((projectId) => projectNameById(projects, projectId)).join(", ");
}

export function EnvironmentConfigPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [filterProjectId, setFilterProjectId] = useState<number | null>(() => parseMaybeNumber(searchParams.get("projectId")));
  const [filterEnvType, setFilterEnvType] = useState("all");
  const [filterKeyword, setFilterKeyword] = useState("");
  const [activeTab, setActiveTab] = useState<ConfigTab>(() => parseConfigTab(searchParams.get("tab")));
  const [environmentItems, setEnvironmentItems] = useState<EnvironmentRecord[]>([]);
  const [environmentTotal, setEnvironmentTotal] = useState(0);
  const [environmentPage, setEnvironmentPage] = useState(1);
  const [environmentTotalPages, setEnvironmentTotalPages] = useState(1);
  const [modelConfigs, setModelConfigs] = useState<ModelConfigRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: NoticeTone; text: string } | null>(null);

  const [editingEnvironmentId, setEditingEnvironmentId] = useState<number | null>(null);
  const [environmentForm, setEnvironmentForm] = useState<EnvironmentFormState>(() => defaultEnvironmentForm());

  const [editingModelId, setEditingModelId] = useState<number | null>(null);
  const [modelForm, setModelForm] = useState<ModelFormState>(() => defaultModelForm());

  const filteredModelConfigs = useMemo(
    () => (filterProjectId ? modelConfigs.filter((item) => item.project_ids.includes(filterProjectId)) : modelConfigs),
    [modelConfigs, filterProjectId]
  );

  async function refreshEnvironmentList(page = environmentPage) {
    const data = await listEnvironmentsPaged({
      projectId: filterProjectId ?? undefined,
      envType: filterEnvType === "all" ? undefined : filterEnvType,
      keyword: filterKeyword.trim() || undefined,
      page,
      pageSize: ENV_PAGE_SIZE,
      order: "asc",
    });
    const totalPages = data.totalPages ?? Math.max(1, Math.ceil(data.total / ENV_PAGE_SIZE));
    if (page > totalPages) {
      setEnvironmentPage(totalPages);
      return;
    }
    setEnvironmentItems(data.items);
    setEnvironmentTotal(data.total);
    setEnvironmentTotalPages(totalPages);
  }

  async function refreshAll() {
    setLoading(true);
    try {
      const [projectItems, modelItems] = await Promise.all([listProjects(), listModelConfigs()]);
      setProjects(projectItems);
      setModelConfigs(modelItems);
      if (filterProjectId && !projectItems.some((item) => item.id === filterProjectId)) {
        setFilterProjectId(null);
      }
      await refreshEnvironmentList();
      setNotice(null);
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "加载环境配置资源失败",
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
    if (projects.length === 0) {
      return;
    }
    setEnvironmentForm((prev) => (prev.projectId ? prev : { ...prev, projectId: projects[0].id }));
    setModelForm((prev) => {
      const validProjectIds = prev.projectIds.filter((projectId) => projects.some((project) => project.id === projectId));
      if (validProjectIds.length > 0 && validProjectIds.length === prev.projectIds.length) {
        return prev;
      }
      return {
        ...prev,
        projectIds: validProjectIds.length > 0 ? validProjectIds : [projects[0].id],
      };
    });
  }, [projects]);

  useEffect(() => {
    const next = new URLSearchParams();
    if (filterProjectId) {
      next.set("projectId", String(filterProjectId));
    }
    next.set("tab", activeTab);
    setSearchParams(next, { replace: true });
  }, [filterProjectId, activeTab, setSearchParams]);

  useEffect(() => {
    setEnvironmentPage(1);
  }, [filterProjectId, filterEnvType, filterKeyword]);

  useEffect(() => {
    void refreshEnvironmentList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterProjectId, filterEnvType, filterKeyword, environmentPage]);

  function resetEnvironmentForm() {
    setEditingEnvironmentId(null);
    setEnvironmentForm((prev) => ({
      ...defaultEnvironmentForm(),
      projectId: prev.projectId ?? projects[0]?.id ?? null,
    }));
  }

  function resetModelForm() {
    setEditingModelId(null);
    setModelForm((prev) => ({
      ...defaultModelForm(),
      projectIds: prev.projectIds.length > 0 ? prev.projectIds : projects[0]?.id ? [projects[0].id] : [],
    }));
  }

  function updateEnvironmentEntries(
    field: "headersEntries" | "variablesEntries" | "secretsRefEntries",
    entryId: string,
    key: "key" | "value",
    value: string
  ) {
    setEnvironmentForm((prev) => ({
      ...prev,
      [field]: ensureEntryList(
        prev[field].map((entry) => (entry.id === entryId ? { ...entry, [key]: value } : entry))
      ),
    }));
  }

  function addEnvironmentEntry(field: "headersEntries" | "variablesEntries" | "secretsRefEntries") {
    setEnvironmentForm((prev) => ({
      ...prev,
      [field]: [...prev[field], newKeyValueEntry()],
    }));
  }

  function removeEnvironmentEntry(field: "headersEntries" | "variablesEntries" | "secretsRefEntries", entryId: string) {
    setEnvironmentForm((prev) => ({
      ...prev,
      [field]: ensureEntryList(prev[field].filter((entry) => entry.id !== entryId)),
    }));
  }

  async function onSaveEnvironment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!environmentForm.projectId) {
      setNotice({ tone: "error", text: "请选择关联项目" });
      return;
    }
    if (!environmentForm.name.trim()) {
      setNotice({ tone: "error", text: "环境名称不能为空" });
      return;
    }
    let headers: Record<string, unknown> | undefined;
    let variables: Record<string, unknown> | undefined;
    let secretsRef: Record<string, unknown> | undefined;
    try {
      headers = entriesToOptionalObject(environmentForm.headersEntries, "Headers", { coercePrimitive: false });
      variables = entriesToOptionalObject(environmentForm.variablesEntries, "Variables");
      secretsRef = entriesToOptionalObject(environmentForm.secretsRefEntries, "SecretsRef");
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "环境配置解析失败" });
      return;
    }

    setBusy(true);
    try {
      if (editingEnvironmentId) {
        const updated = await updateEnvironment(editingEnvironmentId, {
          projectId: environmentForm.projectId,
          name: environmentForm.name.trim(),
          envType: environmentForm.envType,
          status: environmentForm.status,
          baseUrl: environmentForm.baseUrl.trim() || undefined,
          headers,
          variables,
          secretsRef,
        });
        setNotice({ tone: "success", text: `环境已更新：${updated.name}` });
      } else {
        const created = await createEnvironment({
          projectId: environmentForm.projectId,
          name: environmentForm.name.trim(),
          envType: environmentForm.envType,
          status: environmentForm.status,
          baseUrl: environmentForm.baseUrl.trim() || undefined,
          headers,
          variables,
          secretsRef,
        });
        setNotice({ tone: "success", text: `环境创建成功：${created.name}` });
      }
      resetEnvironmentForm();
      await refreshAll();
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "保存环境配置失败",
      });
    } finally {
      setBusy(false);
    }
  }

  function onEditEnvironment(item: EnvironmentRecord) {
    setEditingEnvironmentId(item.id);
    setEnvironmentForm({
      projectId: item.project_id,
      name: item.name,
      envType: item.env_type,
      status: item.status,
      baseUrl: item.base_url ?? "",
      headersEntries: objectToEntries(item.headers),
      variablesEntries: objectToEntries(item.variables),
      secretsRefEntries: objectToEntries(item.secrets_ref),
    });
    setActiveTab("environment");
  }

  async function onDeleteEnvironment(environmentId: number) {
    const confirmed = window.confirm(`确认删除环境 ${environmentId} 吗？`);
    if (!confirmed) {
      return;
    }
    setBusy(true);
    try {
      await deleteEnvironment(environmentId);
      if (editingEnvironmentId === environmentId) {
        resetEnvironmentForm();
      }
      await refreshAll();
      setNotice({ tone: "success", text: `环境 ${environmentId} 已删除` });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "删除环境失败",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onSaveModelConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (modelForm.projectIds.length === 0) {
      setNotice({ tone: "error", text: "请至少选择一个关联项目" });
      return;
    }
    if (!modelForm.name.trim()) {
      setNotice({ tone: "error", text: "模型配置名称不能为空" });
      return;
    }
    if (!modelForm.model.trim()) {
      setNotice({ tone: "error", text: "模型名称不能为空" });
      return;
    }
    setBusy(true);
    try {
      if (editingModelId) {
        const updated = await updateModelConfig(editingModelId, {
          projectIds: modelForm.projectIds,
          name: modelForm.name.trim(),
          provider: modelForm.provider.trim(),
          model: modelForm.model.trim(),
          baseUrl: modelForm.baseUrl.trim(),
          apiKey: modelForm.apiKey.trim(),
          status: modelForm.status,
        });
        setNotice({ tone: "success", text: `模型配置已更新：${updated.name}` });
      } else {
        const created = await createModelConfig({
          projectIds: modelForm.projectIds,
          name: modelForm.name.trim(),
          provider: modelForm.provider.trim(),
          model: modelForm.model.trim(),
          baseUrl: modelForm.baseUrl.trim(),
          apiKey: modelForm.apiKey.trim(),
          status: modelForm.status,
        });
        setNotice({ tone: "success", text: `模型配置创建成功：${created.name}` });
      }
      resetModelForm();
      await refreshAll();
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "保存模型配置失败",
      });
    } finally {
      setBusy(false);
    }
  }

  function onEditModelConfig(item: ModelConfigRecord) {
    setEditingModelId(item.id);
    setModelForm({
      projectIds: item.project_ids.length > 0 ? item.project_ids : [item.project_id],
      name: item.name,
      provider: item.provider || "openai",
      model: item.model || "",
      baseUrl: item.base_url || "",
      apiKey: item.api_key || "",
      status: item.status || "active",
    });
    setActiveTab("model");
  }

  async function onDeleteModelConfig(configId: number) {
    const confirmed = window.confirm(`确认删除模型配置 ${configId} 吗？`);
    if (!confirmed) {
      return;
    }
    setBusy(true);
    try {
      await deleteModelConfig(configId);
      if (editingModelId === configId) {
        resetModelForm();
      }
      await refreshAll();
      setNotice({ tone: "success", text: `模型配置 ${configId} 已删除` });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "删除模型配置失败",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="environment-page grid gap-5">
      <FloatingNotice notice={notice} onClose={() => setNotice(null)} />
      <header className="grid gap-2">
        <h2 className="page-title m-0">环境配置</h2>
      </header>

      <div style={panelStyle} className="console-panel grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="segmented-group">
            <button
              type="button"
              onClick={() => setActiveTab("environment")}
              className={activeTab === "environment" ? tabButtonActiveClass : tabButtonClass}
            >
              环境配置
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("model")}
              className={activeTab === "model" ? tabButtonActiveClass : tabButtonClass}
            >
              模型配置
            </button>
          </div>
          <button
            type="button"
            onClick={() => void refreshAll()}
            disabled={loading || busy}
            className={secondaryButtonClass}
          >
            {loading ? "刷新中..." : "刷新"}
          </button>
        </div>
      </div>

      {activeTab === "environment" ? (
        <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[1fr_1.25fr]">
          <form
            onSubmit={(event) => void onSaveEnvironment(event)}
            style={{ ...panelStyle, display: "grid", gap: 10 }}
            className="console-panel"
          >
            <strong className="section-title">{editingEnvironmentId ? `编辑环境 #${editingEnvironmentId}` : "新建环境"}</strong>
            <div className="h-px w-full bg-border" />
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">选择项目</span>
              <select
                value={environmentForm.projectId ?? ""}
                onChange={(event) =>
                  setEnvironmentForm((prev) => ({ ...prev, projectId: event.target.value ? Number(event.target.value) : null }))
                }
                disabled={busy || projects.length === 0}
              >
                <option value="">关联项目</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name} (ID {project.id})
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">环境名称</span>
              <input
                value={environmentForm.name}
                onChange={(event) => setEnvironmentForm((prev) => ({ ...prev, name: event.target.value }))}
                placeholder="例如 test_dev"
                disabled={busy}
              />
            </label>
            <div className="grid gap-2 md:grid-cols-2">
              <label className="grid gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">类型</span>
                <select
                  value={environmentForm.envType}
                  onChange={(event) => setEnvironmentForm((prev) => ({ ...prev, envType: event.target.value }))}
                  disabled={busy}
                >
                  <option value="test">test</option>
                  <option value="staging">staging</option>
                  <option value="prod_readonly">prod_readonly</option>
                </select>
              </label>
              <label className="grid gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">状态</span>
                <select
                  value={environmentForm.status}
                  onChange={(event) => setEnvironmentForm((prev) => ({ ...prev, status: event.target.value }))}
                  disabled={busy}
                >
                  <option value="active">active</option>
                  <option value="inactive">inactive</option>
                </select>
              </label>
            </div>
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">base_url</span>
              <input
                value={environmentForm.baseUrl}
                onChange={(event) => setEnvironmentForm((prev) => ({ ...prev, baseUrl: event.target.value }))}
                placeholder="https://dev.neptune.com"
                disabled={busy}
              />
            </label>
            {([
              { field: "headersEntries", label: "Headers（可选）", valueHint: "value，例如 application/json" },
              { field: "variablesEntries", label: "Variables（可选）", valueHint: "value，例如 token" },
              { field: "secretsRefEntries", label: "SecretsRef（可选）", valueHint: "value，例如 vault/path" },
            ] as const).map((config) => (
              <div key={config.field} className="console-scroll grid gap-2 p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <strong className="text-sm font-semibold">{config.label}</strong>
                  <button
                    type="button"
                    onClick={() => addEnvironmentEntry(config.field)}
                    disabled={busy}
                    className={secondaryButtonClass}
                  >
                    + Add
                  </button>
                </div>
                <div className="grid gap-1.5">
                  {environmentForm[config.field].map((entry) => (
                    <div key={entry.id} className="grid gap-1.5 md:grid-cols-[1fr_1.3fr_auto]">
                      <input
                        value={entry.key}
                        onChange={(event) => updateEnvironmentEntries(config.field, entry.id, "key", event.target.value)}
                        placeholder="key"
                        disabled={busy}
                      />
                      <input
                        value={entry.value}
                        onChange={(event) => updateEnvironmentEntries(config.field, entry.id, "value", event.target.value)}
                        placeholder={config.valueHint}
                        disabled={busy}
                      />
                      <button
                        type="button"
                        onClick={() => removeEnvironmentEntry(config.field, entry.id)}
                        disabled={busy || environmentForm[config.field].length <= 1}
                        className={dangerButtonClass}
                      >
                        删除
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <button
                type="submit"
                disabled={busy}
                className={primaryButtonClass}
              >
                {busy ? "保存中..." : editingEnvironmentId ? "保存环境" : "创建环境"}
              </button>
              <button
                type="button"
                onClick={resetEnvironmentForm}
                disabled={busy}
                className={secondaryButtonClass}
              >
                重置
              </button>
            </div>
          </form>

          <div style={{ ...panelStyle, display: "grid", gap: 10 }} className="console-panel">
            <strong className="section-title">环境列表</strong>
            <div className="grid gap-2 md:grid-cols-[180px_160px_minmax(0,1fr)_40px]">
              <select
                value={filterProjectId ?? ""}
                onChange={(event) => setFilterProjectId(event.target.value ? Number(event.target.value) : null)}
              >
                <option value="">全部项目</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
              <select value={filterEnvType} onChange={(event) => setFilterEnvType(event.target.value)}>
                <option value="all">全部类型</option>
                <option value="dev">dev</option>
                <option value="test">test</option>
                <option value="staging">staging</option>
                <option value="prod_readonly">prod_readonly</option>
              </select>
              <input
                value={filterKeyword}
                onChange={(event) => setFilterKeyword(event.target.value)}
                placeholder="搜索名称 / URL"
              />
              <button type="button" className={secondaryButtonClass} onClick={() => setFilterKeyword((prev) => prev.trim())}>
                <Search className="h-3.5 w-3.5" />
              </button>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table className="data-table" style={{ minWidth: 900 }}>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>名称</th>
                    <th>关联项目</th>
                    <th>类型</th>
                    <th>URL</th>
                    <th>状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {environmentItems.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-3 text-muted-foreground">
                        暂无环境配置
                      </td>
                    </tr>
                  ) : (
                    environmentItems.map((item) => (
                      <tr key={item.id}>
                        <td className="font-semibold">{item.id}</td>
                        <td>{item.name}</td>
                        <td>{projectNameById(projects, item.project_id)}</td>
                        <td>{item.env_type}</td>
                        <td>{item.base_url || "-"}</td>
                        <td>
                          <span className={cn(item.status === "active" ? "status-pill-success" : "status-pill-queued")}>
                            {item.status}
                          </span>
                        </td>
                        <td>
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => onEditEnvironment(item)}
                              className={secondaryButtonClass}
                            >
                              编辑
                            </button>
                            <button
                              type="button"
                              onClick={() => void onDeleteEnvironment(item.id)}
                              className={dangerButtonClass}
                            >
                              删除
                            </button>
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
                第 {environmentPage} / {environmentTotalPages} 页 · 共 {environmentTotal} 条 · 每页 {ENV_PAGE_SIZE} 条
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setEnvironmentPage((prev) => Math.max(1, prev - 1))}
                  disabled={loading || busy || environmentPage <= 1}
                  className={`${secondaryButtonClass} min-h-[28px] px-2 text-[11px]`}
                >
                  上一页
                </button>
                <button
                  type="button"
                  onClick={() => setEnvironmentPage((prev) => Math.min(environmentTotalPages, prev + 1))}
                  disabled={loading || busy || environmentPage >= environmentTotalPages}
                  className={`${secondaryButtonClass} min-h-[28px] px-2 text-[11px]`}
                >
                  下一页
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-[1fr_1.35fr]">
          <form onSubmit={(event) => void onSaveModelConfig(event)} style={{ ...panelStyle, display: "grid", gap: 8 }} className="console-panel">
            <strong>{editingModelId ? `编辑模型配置 #${editingModelId}` : "新建模型配置"}</strong>
            <div className="console-scroll grid gap-2 p-2.5">
              <span className="text-xs font-medium text-muted-foreground">关联项目（可多选）</span>
              {projects.length === 0 ? (
                <div className="text-xs text-muted-foreground">暂无可选项目</div>
              ) : (
                <div className="grid gap-1.5 md:grid-cols-2">
                  {projects.map((project) => {
                    const checked = modelForm.projectIds.includes(project.id);
                    return (
                      <label key={project.id} className="inline-flex items-center gap-2 rounded-lg border border-border px-2 py-1.5">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setModelForm((prev) => ({
                              ...prev,
                              projectIds: checked
                                ? prev.projectIds.filter((item) => item !== project.id)
                                : [...prev.projectIds, project.id],
                            }))
                          }
                          disabled={busy}
                        />
                        <span className="text-sm">{project.name} (ID {project.id})</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
            <input
              value={modelForm.name}
              onChange={(event) => setModelForm((prev) => ({ ...prev, name: event.target.value }))}
              placeholder="配置名称"
              disabled={busy}
            />
            <div className="grid gap-2 md:grid-cols-2">
              <input
                value={modelForm.provider}
                onChange={(event) => setModelForm((prev) => ({ ...prev, provider: event.target.value }))}
                placeholder="provider，例如 openai"
                disabled={busy}
              />
              <input
                value={modelForm.model}
                onChange={(event) => setModelForm((prev) => ({ ...prev, model: event.target.value }))}
                placeholder="模型名称，例如 gpt-5.4-mini"
                disabled={busy}
              />
            </div>
            <input
              value={modelForm.baseUrl}
              onChange={(event) => setModelForm((prev) => ({ ...prev, baseUrl: event.target.value }))}
              placeholder="模型网关 base_url"
              disabled={busy}
            />
            <input
              value={modelForm.apiKey}
              onChange={(event) => setModelForm((prev) => ({ ...prev, apiKey: event.target.value }))}
              type="password"
              placeholder="API Key"
              disabled={busy}
            />
            <select
              value={modelForm.status}
              onChange={(event) => setModelForm((prev) => ({ ...prev, status: event.target.value }))}
              disabled={busy}
            >
              <option value="active">active</option>
              <option value="inactive">inactive</option>
            </select>
            <div className="flex flex-wrap gap-2">
              <button
                type="submit"
                disabled={busy}
                className={primaryButtonClass}
              >
                {busy ? "保存中..." : editingModelId ? "保存模型配置" : "创建模型配置"}
              </button>
              <button
                type="button"
                onClick={resetModelForm}
                disabled={busy}
                className={secondaryButtonClass}
              >
                重置
              </button>
            </div>
          </form>

          <div style={{ ...panelStyle, display: "grid", gap: 8 }} className="console-panel">
            <strong>模型配置列表 ({filteredModelConfigs.length})</strong>
            <div style={{ overflowX: "auto" }}>
              <table className="data-table min-w-[1180px]" style={{ minWidth: 1240, tableLayout: "fixed" }}>
                <colgroup>
                  <col style={{ width: 72 }} />
                  <col style={{ width: 160 }} />
                  <col style={{ width: 230 }} />
                  <col style={{ width: 110 }} />
                  <col style={{ width: 150 }} />
                  <col style={{ width: 280 }} />
                  <col style={{ width: 180 }} />
                  <col style={{ width: 92 }} />
                  <col style={{ width: 180 }} />
                  <col style={{ width: 132 }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>名称</th>
                    <th>关联项目</th>
                    <th>Provider</th>
                    <th>Model</th>
                    <th>base_url</th>
                    <th>api_key</th>
                    <th>状态</th>
                    <th>更新时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredModelConfigs.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="py-3 text-muted-foreground">
                        暂无模型配置
                      </td>
                    </tr>
                  ) : (
                    filteredModelConfigs.map((item) => (
                      <tr key={item.id}>
                        <td className="font-semibold">{item.id}</td>
                        <td title={item.name}>
                          <span className="block truncate">{item.name}</span>
                        </td>
                        <td title={projectNamesByIds(projects, item.project_ids)}>
                          <span className="block truncate">{projectNamesByIds(projects, item.project_ids)}</span>
                        </td>
                        <td title={item.provider || "-"}>
                          <span className="block truncate">{item.provider || "-"}</span>
                        </td>
                        <td title={item.model || "-"}>
                          <span className="block truncate">{item.model || "-"}</span>
                        </td>
                        <td title={item.base_url || "-"}>
                          <span className="block whitespace-normal break-all leading-5">{item.base_url || "-"}</span>
                        </td>
                        <td title={maskApiKey(item.api_key)}>
                          <span className="block whitespace-normal break-all leading-5">{maskApiKey(item.api_key)}</span>
                        </td>
                        <td className="whitespace-nowrap">{item.status}</td>
                        <td className="whitespace-nowrap">{item.updated_at || "-"}</td>
                        <td>
                          <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => onEditModelConfig(item)}
                            className={secondaryButtonClass}
                          >
                            编辑
                          </button>
                          <button
                            type="button"
                            onClick={() => void onDeleteModelConfig(item.id)}
                            className={dangerButtonClass}
                          >
                            删除
                          </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
