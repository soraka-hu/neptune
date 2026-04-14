import { ChangeEvent, FormEvent, type CSSProperties, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { FloatingNotice, type NoticeTone } from "../../components/FloatingNotice";
import {
  CaseRecord,
  ProjectRecord,
  SuiteAssetOverviewRecord,
  SuiteRecord,
  UserAssetRecord,
  deleteSuite,
  deleteCase,
  deleteUserAsset,
  listCases,
  listProjects,
  listSuiteAssetOverview,
  listSuites,
  listUserAssets,
  updateUserAsset,
  createUserAsset,
} from "../../services/assetService";
type AssetTab = "prd_agent_docs" | "api_docs" | "api_suite_cases" | "agent_benchmark_cases" | "report_channels";
type PrdDocType = "prd" | "agent_info";
type ApiDocFormat = "openapi_json" | "json" | "markdown";
type YesNoAll = "all" | "yes" | "no";

type JsonObject = Record<string, unknown>;
const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const tabOptions: Array<{ key: AssetTab; label: string }> = [
  { key: "prd_agent_docs", label: "PRD / Agent 信息文档" },
  { key: "api_docs", label: "API 文档" },
  { key: "api_suite_cases", label: "API Suite 测试案例" },
  { key: "agent_benchmark_cases", label: "Agent Benchmark 测试案例" },
];

const panelStyle: CSSProperties = {
  borderRadius: 12,
  padding: 16,
  background: "#ffffff",
  border: "1px solid #E5E7EB",
  boxShadow: "none",
};

const actionButtonStyle: CSSProperties = {
  border: "1px solid var(--app-border-strong)",
  borderRadius: 8,
  padding: "5px 9px",
  background: "var(--app-surface-soft)",
  color: "var(--app-text-strong)",
  cursor: "pointer",
};

const actionButtonCompactStyle: CSSProperties = {
  border: "1px solid var(--app-border-strong)",
  borderRadius: 8,
  padding: "4px 8px",
  background: "var(--app-surface-soft)",
  color: "var(--app-text-strong)",
  cursor: "pointer",
  fontSize: 12,
  lineHeight: 1.2,
};

const subtleActionButtonStyle: CSSProperties = {
  border: "1px solid var(--app-border-strong)",
  borderRadius: 8,
  padding: "6px 10px",
  background: "var(--app-surface-soft)",
  color: "var(--app-text-strong)",
  cursor: "pointer",
};

const actionLinkStyle: CSSProperties = {
  border: "1px solid var(--app-border-strong)",
  borderRadius: 8,
  padding: "5px 9px",
  background: "var(--app-surface-soft)",
  color: "var(--app-text-strong)",
  display: "inline-flex",
  alignItems: "center",
  textDecoration: "none",
};

const actionLinkCompactStyle: CSSProperties = {
  border: "1px solid var(--app-border-strong)",
  borderRadius: 8,
  padding: "4px 8px",
  background: "var(--app-surface-soft)",
  color: "var(--app-text-strong)",
  fontSize: 12,
  lineHeight: 1.2,
  display: "inline-flex",
  alignItems: "center",
  textDecoration: "none",
};

const dangerActionButtonStyle: CSSProperties = {
  border: "1px solid color-mix(in srgb, var(--chart-pink-end) 50%, var(--app-border-soft))",
  borderRadius: 8,
  padding: "5px 9px",
  background: "color-mix(in srgb, var(--chart-pink-end) 12%, var(--app-surface))",
  color: "var(--chart-pink-end)",
  cursor: "pointer",
};

const dangerActionButtonCompactStyle: CSSProperties = {
  border: "1px solid color-mix(in srgb, var(--chart-pink-end) 50%, var(--app-border-soft))",
  borderRadius: 8,
  padding: "4px 8px",
  background: "color-mix(in srgb, var(--chart-pink-end) 12%, var(--app-surface))",
  color: "var(--chart-pink-end)",
  cursor: "pointer",
  fontSize: 12,
  lineHeight: 1.2,
};

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTab(value: string | null, fallback: AssetTab = "prd_agent_docs"): AssetTab {
  if (
    value === "prd_agent_docs" ||
    value === "api_docs" ||
    value === "api_suite_cases" ||
    value === "agent_benchmark_cases" ||
    value === "report_channels"
  ) {
    return value;
  }
  return fallback;
}

function parseMaybeNumber(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const next = Number(value);
  return Number.isInteger(next) && next > 0 ? next : null;
}

function suiteNameById(suites: SuiteRecord[], suiteId: number | null | undefined): string {
  if (!suiteId) {
    return "-";
  }
  return suites.find((item) => item.id === suiteId)?.name ?? String(suiteId);
}

function toPretty(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
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

function sanitizeReportChannelContent(content: unknown): JsonObject | null {
  if (!isRecord(content)) {
    return null;
  }
  return {
    ...content,
    app_secret: maskCredential(content.app_secret, 3, 2),
  };
}

function assetPreviewText(asset: UserAssetRecord): string {
  if (asset.content_text) {
    return asset.content_text;
  }
  if (asset.asset_type === "report_channel") {
    return toPretty(sanitizeReportChannelContent(asset.content_json));
  }
  return toPretty(asset.content_json);
}

function safeMeta(asset: UserAssetRecord): JsonObject {
  return isRecord(asset.meta_info) ? asset.meta_info : {};
}

function safeCaseMeta(caseItem: CaseRecord): JsonObject {
  return isRecord(caseItem.meta_info) ? caseItem.meta_info : {};
}

function isDocxFile(file: File): boolean {
  const fileName = file.name.toLowerCase();
  return fileName.endsWith(".docx") || file.type === DOCX_MIME_TYPE;
}

function isLegacyDocFile(file: File): boolean {
  const fileName = file.name.toLowerCase();
  return fileName.endsWith(".doc") && !fileName.endsWith(".docx");
}

function maskCredential(raw: unknown, prefix = 6, suffix = 4): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    return "-";
  }
  if (value.length <= prefix + suffix + 3) {
    return value;
  }
  return `${value.slice(0, prefix)}...${value.slice(-suffix)}`;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  const chunks: string[] = [];
  for (let start = 0; start < bytes.length; start += chunkSize) {
    const chunk = bytes.subarray(start, start + chunkSize);
    chunks.push(String.fromCharCode(...chunk));
  }
  return btoa(chunks.join(""));
}

async function readPrdUploadContent(file: File): Promise<{ contentText?: string; fileBase64?: string }> {
  if (isLegacyDocFile(file)) {
    throw new Error("暂不支持 .doc，请先转换为 .docx 后上传");
  }
  if (isDocxFile(file)) {
    return { fileBase64: arrayBufferToBase64(await file.arrayBuffer()) };
  }
  return { contentText: await file.text() };
}

type AssetsCenterProps = {
  defaultTab?: AssetTab;
  hideTabNavigation?: boolean;
};

export function AssetsCenter({ defaultTab = "prd_agent_docs", hideTabNavigation = false }: AssetsCenterProps) {
  const [searchParams, setSearchParams] = useSearchParams();

  const [tab, setTab] = useState<AssetTab>(() => parseTab(searchParams.get("tab"), defaultTab));
  const currentTab: AssetTab = hideTabNavigation ? "report_channels" : tab;
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [suites, setSuites] = useState<SuiteRecord[]>([]);
  const [cases, setCases] = useState<CaseRecord[]>([]);
  const [apiSuiteOverviews, setApiSuiteOverviews] = useState<SuiteAssetOverviewRecord[]>([]);
  const [agentSuiteOverviews, setAgentSuiteOverviews] = useState<SuiteAssetOverviewRecord[]>([]);
  const [apiActiveSuiteId, setApiActiveSuiteId] = useState<number | null>(null);
  const [agentActiveSuiteId, setAgentActiveSuiteId] = useState<number | null>(null);
  const [prdAgentDocs, setPrdAgentDocs] = useState<UserAssetRecord[]>([]);
  const [apiDocs, setApiDocs] = useState<UserAssetRecord[]>([]);
  const [reportChannels, setReportChannels] = useState<UserAssetRecord[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(() => parseMaybeNumber(searchParams.get("projectId")));
  const [selectedSuiteId, setSelectedSuiteId] = useState<number | null>(() => parseMaybeNumber(searchParams.get("suiteId")));
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: NoticeTone; text: string } | null>(null);

  const [searchKeyword, setSearchKeyword] = useState("");
  const [prdTypeFilter, setPrdTypeFilter] = useState<"all" | PrdDocType>("all");
  const [apiDocFormatFilter, setApiDocFormatFilter] = useState<"all" | ApiDocFormat>("all");
  const [apiCaseSourceFilter, setApiCaseSourceFilter] = useState("all");
  const [agentCaseStatusFilter, setAgentCaseStatusFilter] = useState("all");
  const [agentHasReferenceFilter, setAgentHasReferenceFilter] = useState<YesNoAll>("all");

  const [prdUploadForm, setPrdUploadForm] = useState({
    docType: "prd" as PrdDocType,
    name: "",
    remark: "",
    file: null as File | null,
  });
  const [apiUploadForm, setApiUploadForm] = useState({
    format: "openapi_json" as ApiDocFormat,
    name: "",
    remark: "",
    file: null as File | null,
  });
  const [reportChannelForm, setReportChannelForm] = useState({
    name: "",
    appId: "",
    appSecret: "",
    chatId: "",
    defaultMessage: "",
  });

  const [docDetail, setDocDetail] = useState<UserAssetRecord | null>(null);
  const [docEditTarget, setDocEditTarget] = useState<UserAssetRecord | null>(null);
  const [docEditForm, setDocEditForm] = useState({
    name: "",
    suiteId: "" as "" | number,
    remark: "",
    contentText: "",
    docType: "prd" as PrdDocType,
    docFormat: "openapi_json" as ApiDocFormat,
  });
  const [caseDetail, setCaseDetail] = useState<CaseRecord | null>(null);

  const selectedProject = useMemo(
    () => projects.find((item) => item.id === selectedProjectId) ?? null,
    [projects, selectedProjectId]
  );
  const isStandaloneChannelPage = hideTabNavigation && currentTab === "report_channels";

  const activeApiSuite = useMemo(
    () => apiSuiteOverviews.find((item) => item.id === apiActiveSuiteId) ?? null,
    [apiSuiteOverviews, apiActiveSuiteId]
  );

  const activeAgentSuite = useMemo(
    () => agentSuiteOverviews.find((item) => item.id === agentActiveSuiteId) ?? null,
    [agentSuiteOverviews, agentActiveSuiteId]
  );

  const hasProject = selectedProjectId !== null;

  async function refreshProjectScopedData(projectId: number) {
    const [suiteData, caseData, prdDocData, apiDocData, reportChannelData, apiOverviewData, agentOverviewData] = await Promise.all([
      listSuites(projectId),
      listCases(projectId),
      listUserAssets(projectId, undefined, "prd_agent_doc", "active"),
      listUserAssets(projectId, undefined, "api_doc", "active"),
      listUserAssets(undefined, undefined, "report_channel", "active"),
      listSuiteAssetOverview(projectId, "api"),
      listSuiteAssetOverview(projectId, "agent"),
    ]);
    setSuites(suiteData);
    setCases(caseData);
    setPrdAgentDocs(prdDocData);
    setApiDocs(apiDocData);
    setReportChannels(reportChannelData);
    setApiSuiteOverviews(apiOverviewData);
    setAgentSuiteOverviews(agentOverviewData);
    setSelectedSuiteId((prev) => {
      if (prev === null) {
        return null;
      }
      return suiteData.some((item) => item.id === prev) ? prev : null;
    });
    setApiActiveSuiteId((prev) => (prev !== null && apiOverviewData.some((item) => item.id === prev) ? prev : null));
    setAgentActiveSuiteId((prev) => (prev !== null && agentOverviewData.some((item) => item.id === prev) ? prev : null));
  }

  async function loadInitialData() {
    setLoading(true);
    try {
      const projectData = await listProjects();
      setProjects(projectData);
      const projectIdFromQuery = parseMaybeNumber(searchParams.get("projectId"));
      const resolvedProjectId =
        projectIdFromQuery && projectData.some((item) => item.id === projectIdFromQuery)
          ? projectIdFromQuery
          : selectedProjectId && projectData.some((item) => item.id === selectedProjectId)
            ? selectedProjectId
            : projectData[0]?.id ?? null;
      setSelectedProjectId(resolvedProjectId);
      if (resolvedProjectId) {
        await refreshProjectScopedData(resolvedProjectId);
      } else {
        setSuites([]);
        setCases([]);
        setApiSuiteOverviews([]);
        setAgentSuiteOverviews([]);
        setApiActiveSuiteId(null);
        setAgentActiveSuiteId(null);
        setPrdAgentDocs([]);
        setApiDocs([]);
        setReportChannels([]);
      }
      setNotice(null);
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "加载文档管理失败",
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadInitialData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (hideTabNavigation) {
      setTab("report_channels");
      return;
    }
    setTab(parseTab(searchParams.get("tab"), defaultTab));
  }, [defaultTab, hideTabNavigation, searchParams]);

  useEffect(() => {
    if (!selectedProjectId) {
      setSuites([]);
      setCases([]);
      setApiSuiteOverviews([]);
      setAgentSuiteOverviews([]);
      setApiActiveSuiteId(null);
      setAgentActiveSuiteId(null);
      setPrdAgentDocs([]);
      setApiDocs([]);
      setReportChannels([]);
      return;
    }
    setLoading(true);
    void refreshProjectScopedData(selectedProjectId)
      .catch((error: unknown) => {
        setNotice({
          tone: "error",
          text: error instanceof Error ? error.message : "加载项目资产失败",
        });
      })
      .finally(() => setLoading(false));
  }, [selectedProjectId]);

  useEffect(() => {
    const next = new URLSearchParams();
    next.set("tab", currentTab);
    if (selectedProjectId) {
      next.set("projectId", String(selectedProjectId));
    }
    if (selectedSuiteId) {
      next.set("suiteId", String(selectedSuiteId));
    }
    setSearchParams(next, { replace: true });
  }, [currentTab, selectedProjectId, selectedSuiteId, setSearchParams]);

  useEffect(() => {
    if (!selectedSuiteId) {
      return;
    }
    if (currentTab === "api_suite_cases" && apiSuiteOverviews.some((item) => item.id === selectedSuiteId)) {
      setApiActiveSuiteId(selectedSuiteId);
    }
    if (currentTab === "agent_benchmark_cases" && agentSuiteOverviews.some((item) => item.id === selectedSuiteId)) {
      setAgentActiveSuiteId(selectedSuiteId);
    }
  }, [currentTab, selectedSuiteId, apiSuiteOverviews, agentSuiteOverviews]);

  async function onUploadPrdAgentDoc(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProjectId) {
      setNotice({ tone: "error", text: "请先选择项目" });
      return;
    }
    if (!prdUploadForm.file) {
      setNotice({ tone: "error", text: "请先选择 PRD / Agent 文档文件" });
      return;
    }
    setBusy(true);
    try {
      const uploadPayload = await readPrdUploadContent(prdUploadForm.file);
      const created = await createUserAsset({
        projectId: selectedProjectId,
        assetType: "prd_agent_doc",
        name: prdUploadForm.name.trim() || prdUploadForm.file.name.replace(/\.[^.]+$/, ""),
        fileName: prdUploadForm.file.name,
        contentText: uploadPayload.contentText,
        fileBase64: uploadPayload.fileBase64,
        metaInfo: {
          doc_type: prdUploadForm.docType,
          suite_id: selectedSuiteId,
          remark: prdUploadForm.remark.trim(),
        },
      });
      setPrdUploadForm({
        docType: prdUploadForm.docType,
        name: "",
        remark: "",
        file: null,
      });
      await refreshProjectScopedData(selectedProjectId);
      setNotice({ tone: "success", text: `文档上传成功：${created.name}` });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "上传 PRD / Agent 文档失败",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onUploadApiDoc(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProjectId) {
      setNotice({ tone: "error", text: "请先选择项目" });
      return;
    }
    if (!apiUploadForm.file) {
      setNotice({ tone: "error", text: "请先选择 API 文档文件" });
      return;
    }
    setBusy(true);
    try {
      const text = await apiUploadForm.file.text();
      let contentJson: Record<string, unknown> | undefined;
      if (apiUploadForm.format === "openapi_json" || apiUploadForm.format === "json") {
        const parsed = JSON.parse(text) as unknown;
        if (isRecord(parsed)) {
          contentJson = parsed;
        } else if (Array.isArray(parsed)) {
          contentJson = { items: parsed };
        } else {
          throw new Error("API 文档 JSON 需为对象或数组");
        }
      }
      const created = await createUserAsset({
        projectId: selectedProjectId,
        assetType: "api_doc",
        name: apiUploadForm.name.trim() || apiUploadForm.file.name.replace(/\.[^.]+$/, ""),
        fileName: apiUploadForm.file.name,
        contentText: text,
        contentJson,
        metaInfo: {
          doc_format: apiUploadForm.format,
          suite_id: selectedSuiteId,
          remark: apiUploadForm.remark.trim(),
        },
      });
      setApiUploadForm({
        format: apiUploadForm.format,
        name: "",
        remark: "",
        file: null,
      });
      await refreshProjectScopedData(selectedProjectId);
      setNotice({ tone: "success", text: `API 文档上传成功：${created.name}` });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "上传 API 文档失败",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onCreateReportChannel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProjectId) {
      setNotice({ tone: "error", text: "请先选择项目" });
      return;
    }
    const name = reportChannelForm.name.trim();
    const appId = reportChannelForm.appId.trim();
    const appSecret = reportChannelForm.appSecret.trim();
    const chatId = reportChannelForm.chatId.trim();
    const defaultMessage = reportChannelForm.defaultMessage.trim();
    if (!name || !appId || !appSecret || !chatId) {
      setNotice({ tone: "error", text: "请填写渠道名称、APP_ID、APP_SECRET、CHAT_ID" });
      return;
    }

    setBusy(true);
    try {
      const created = await createUserAsset({
        projectId: selectedProjectId,
        assetType: "report_channel",
        name,
        contentJson: {
          channel_type: "feishu_app",
          app_id: appId,
          app_secret: appSecret,
          chat_id: chatId,
          default_message: defaultMessage || null,
        },
        metaInfo: {
          scope: "global",
        },
      });
      setReportChannelForm({
        name: "",
        appId: "",
        appSecret: "",
        chatId: "",
        defaultMessage: "",
      });
      await refreshProjectScopedData(selectedProjectId);
      setNotice({ tone: "success", text: `发送渠道创建成功：${created.name}` });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "创建发送渠道失败",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteDoc(assetId: number) {
    if (!selectedProjectId) {
      return;
    }
    setBusy(true);
    try {
      await deleteUserAsset(assetId);
      await refreshProjectScopedData(selectedProjectId);
      setNotice({ tone: "success", text: `资产 ${assetId} 已删除` });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "删除资产失败",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteReportChannel(assetId: number) {
    if (!selectedProjectId) {
      return;
    }
    if (!window.confirm(`确认删除发送渠道 ${assetId} 吗？`)) {
      return;
    }
    setBusy(true);
    try {
      await deleteUserAsset(assetId);
      await refreshProjectScopedData(selectedProjectId);
      setNotice({ tone: "success", text: `发送渠道 ${assetId} 已删除` });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "删除发送渠道失败",
      });
    } finally {
      setBusy(false);
    }
  }

  function onOpenEditDoc(asset: UserAssetRecord) {
    const meta = safeMeta(asset);
    setDocEditTarget(asset);
    setDocEditForm({
      name: asset.name,
      suiteId: typeof meta.suite_id === "number" ? meta.suite_id : "",
      remark: typeof meta.remark === "string" ? meta.remark : "",
      contentText: asset.content_text ?? toPretty(asset.content_json),
      docType: meta.doc_type === "agent_info" ? "agent_info" : "prd",
      docFormat:
        meta.doc_format === "json" || meta.doc_format === "markdown" || meta.doc_format === "openapi_json"
          ? meta.doc_format
          : "openapi_json",
    });
  }

  async function onSaveDocEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!docEditTarget || !selectedProjectId) {
      return;
    }
    if (!docEditForm.name.trim()) {
      setNotice({ tone: "error", text: "文档名称不能为空" });
      return;
    }
    setBusy(true);
    try {
      const meta = safeMeta(docEditTarget);
      const nextMeta: JsonObject = {
        ...meta,
        suite_id: docEditForm.suiteId || null,
        remark: docEditForm.remark.trim(),
      };

      let contentJson: Record<string, unknown> | undefined;
      if (docEditTarget.asset_type === "api_doc" && (docEditForm.docFormat === "openapi_json" || docEditForm.docFormat === "json")) {
        const parsed = JSON.parse(docEditForm.contentText) as unknown;
        if (isRecord(parsed)) {
          contentJson = parsed;
        } else if (Array.isArray(parsed)) {
          contentJson = { items: parsed };
        } else {
          throw new Error("API 文档 JSON 内容需为对象或数组");
        }
      }

      if (docEditTarget.asset_type === "prd_agent_doc") {
        nextMeta.doc_type = docEditForm.docType;
      } else if (docEditTarget.asset_type === "api_doc") {
        nextMeta.doc_format = docEditForm.docFormat;
      }

      await updateUserAsset(docEditTarget.id, {
        name: docEditForm.name.trim(),
        contentText: docEditForm.contentText,
        contentJson,
        metaInfo: nextMeta,
      });
      await refreshProjectScopedData(selectedProjectId);
      setDocEditTarget(null);
      setNotice({ tone: "success", text: "文档更新成功" });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "更新文档失败",
      });
    } finally {
      setBusy(false);
    }
  }

  function onDownloadDoc(asset: UserAssetRecord) {
    const content = assetPreviewText(asset);
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = asset.file_name || `${asset.name}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function onOpenApiSuiteCases(suiteId: number) {
    setApiActiveSuiteId(suiteId);
    setSelectedSuiteId(suiteId);
  }

  function onOpenAgentSuiteCases(suiteId: number) {
    setAgentActiveSuiteId(suiteId);
    setSelectedSuiteId(suiteId);
  }

  function onBackToApiSuiteList() {
    setApiActiveSuiteId(null);
  }

  function onBackToAgentSuiteList() {
    setAgentActiveSuiteId(null);
  }

  function onViewApiLinkedDocs(suiteId: number) {
    setSelectedSuiteId(suiteId);
    setTab("api_docs");
  }

  function onViewAgentLinkedDocs(suiteId: number) {
    setSelectedSuiteId(suiteId);
    setTab("prd_agent_docs");
  }

  async function onDeleteSuiteItem(suiteId: number) {
    if (!selectedProjectId) {
      return;
    }
    setBusy(true);
    try {
      await deleteSuite(suiteId);
      await refreshProjectScopedData(selectedProjectId);
      if (apiActiveSuiteId === suiteId) {
        setApiActiveSuiteId(null);
      }
      if (agentActiveSuiteId === suiteId) {
        setAgentActiveSuiteId(null);
      }
      if (selectedSuiteId === suiteId) {
        setSelectedSuiteId(null);
      }
      setNotice({ tone: "success", text: `Suite ${suiteId} 已删除/归档` });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "删除 Suite 失败",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteCaseItem(caseId: number) {
    if (!selectedProjectId) {
      return;
    }
    setBusy(true);
    try {
      await deleteCase(caseId);
      await refreshProjectScopedData(selectedProjectId);
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

  const lowerKeyword = searchKeyword.trim().toLowerCase();

  const filteredPrdDocs = useMemo(() => {
    return prdAgentDocs.filter((asset) => {
      const meta = safeMeta(asset);
      const suiteMatch = !selectedSuiteId || meta.suite_id === selectedSuiteId;
      const typeMatch = prdTypeFilter === "all" || meta.doc_type === prdTypeFilter;
      const keywordMatch =
        !lowerKeyword ||
        asset.name.toLowerCase().includes(lowerKeyword) ||
        (asset.file_name ?? "").toLowerCase().includes(lowerKeyword);
      return suiteMatch && typeMatch && keywordMatch;
    });
  }, [prdAgentDocs, lowerKeyword, selectedSuiteId, prdTypeFilter]);

  const filteredApiDocs = useMemo(() => {
    return apiDocs.filter((asset) => {
      const meta = safeMeta(asset);
      const suiteMatch = !selectedSuiteId || meta.suite_id === selectedSuiteId;
      const formatMatch = apiDocFormatFilter === "all" || meta.doc_format === apiDocFormatFilter;
      const keywordMatch =
        !lowerKeyword ||
        asset.name.toLowerCase().includes(lowerKeyword) ||
        (asset.file_name ?? "").toLowerCase().includes(lowerKeyword);
      return suiteMatch && formatMatch && keywordMatch;
    });
  }, [apiDocs, lowerKeyword, selectedSuiteId, apiDocFormatFilter]);

  const filteredReportChannels = useMemo(() => {
    return reportChannels.filter((asset) => {
      if (asset.status === "archived" || asset.status === "deleted") {
        return false;
      }
      const keywordMatch =
        !lowerKeyword ||
        asset.name.toLowerCase().includes(lowerKeyword) ||
        (asset.file_name ?? "").toLowerCase().includes(lowerKeyword);
      return keywordMatch;
    });
  }, [reportChannels, lowerKeyword]);

  const filteredApiCases = useMemo(() => {
    return cases.filter((caseItem) => {
      if (caseItem.case_type !== "api") {
        return false;
      }
      if (caseItem.status === "archived" || caseItem.status === "deleted") {
        return false;
      }
      const suiteMatch = apiActiveSuiteId !== null && caseItem.suite_id === apiActiveSuiteId;
      const source = caseItem.source_type ?? "manual";
      const sourceMatch = apiCaseSourceFilter === "all" || source === apiCaseSourceFilter;
      const input = isRecord(caseItem.input_payload) ? caseItem.input_payload : {};
      const path = typeof input.path === "string" ? input.path : "";
      const keywordMatch =
        !lowerKeyword ||
        caseItem.name.toLowerCase().includes(lowerKeyword) ||
        path.toLowerCase().includes(lowerKeyword) ||
        String(caseItem.id).includes(lowerKeyword);
      return suiteMatch && sourceMatch && keywordMatch;
    });
  }, [cases, apiActiveSuiteId, apiCaseSourceFilter, lowerKeyword]);

  const filteredAgentCases = useMemo(() => {
    return cases.filter((caseItem) => {
      if (caseItem.case_type !== "agent") {
        return false;
      }
      if (caseItem.status === "archived" || caseItem.status === "deleted") {
        return false;
      }
      const suiteMatch = agentActiveSuiteId !== null && caseItem.suite_id === agentActiveSuiteId;
      const statusMatch = agentCaseStatusFilter === "all" || caseItem.status === agentCaseStatusFilter;
      const expected = isRecord(caseItem.expected_output) ? caseItem.expected_output : {};
      const hasReference = isRecord(expected.reference_answer);
      const refMatch =
        agentHasReferenceFilter === "all" ||
        (agentHasReferenceFilter === "yes" && hasReference) ||
        (agentHasReferenceFilter === "no" && !hasReference);
      const input = isRecord(caseItem.input_payload) ? caseItem.input_payload : {};
      const userInput = typeof input.user_input === "string" ? input.user_input : "";
      const keywordMatch =
        !lowerKeyword ||
        caseItem.name.toLowerCase().includes(lowerKeyword) ||
        userInput.toLowerCase().includes(lowerKeyword) ||
        String(caseItem.id).includes(lowerKeyword);
      return suiteMatch && statusMatch && refMatch && keywordMatch;
    });
  }, [cases, agentActiveSuiteId, agentCaseStatusFilter, agentHasReferenceFilter, lowerKeyword]);

  return (
    <section className="assets-page grid gap-4">
      <FloatingNotice notice={notice} onClose={() => setNotice(null)} />
      <header className="grid gap-2">
        <h2 className="page-title m-0">{hideTabNavigation ? "发送渠道" : "文档管理"}</h2>
      </header>

      {!isStandaloneChannelPage ? (
        <div style={{ ...panelStyle, display: "grid", gap: 10 }} className="console-panel grid gap-3 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <strong>上下文筛选</strong>
            <div className="flex flex-wrap items-center gap-2.5">
              <Link to="/generation" className="text-sm font-semibold text-primary hover:text-primary/80">
                去生成数据集
              </Link>
              <button
                type="button"
                onClick={() => void loadInitialData()}
                disabled={loading || busy}
                className="console-btn px-3 py-1.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loading ? "刷新中..." : "刷新资产"}
              </button>
            </div>
          </div>

          <div className="grid gap-2 md:grid-cols-3">
            <select
              value={selectedProjectId ?? ""}
              onChange={(event) => setSelectedProjectId(event.target.value ? Number(event.target.value) : null)}
              disabled={busy || projects.length === 0}
            >
              {projects.length === 0 ? <option value="">暂无项目</option> : null}
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
            >
              <option value="">全部 Suite</option>
              {suites.map((suite) => (
                <option key={suite.id} value={suite.id}>
                  {suite.name}
                </option>
              ))}
            </select>
            <input
              value={searchKeyword}
              onChange={(event) => setSearchKeyword(event.target.value)}
              placeholder="搜索名称 / 文件名 / case id / path"
            />
          </div>
        </div>
      ) : null}

      <div style={{ ...panelStyle, display: "grid", gap: 10 }} className="console-panel grid gap-3 p-5">
        {!hideTabNavigation ? (
          <div className="flex flex-wrap gap-2">
            {tabOptions.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setTab(item.key)}
                className={
                  item.key === currentTab
                    ? "console-tab console-tab-active rounded-full px-4 py-2 text-sm font-semibold"
                    : "console-tab rounded-full px-4 py-2 text-sm font-semibold hover:bg-muted"
                }
              >
                {item.label}
              </button>
            ))}
          </div>
        ) : null}

        {currentTab === "prd_agent_docs" ? (
          <div style={{ display: "grid", gap: 12 }}>
            <form onSubmit={(event) => void onUploadPrdAgentDoc(event)} style={{ borderRadius: 14, border: "1px solid rgba(31,37,39,0.08)", padding: 12, display: "grid", gap: 8 }}>
              <strong>上传 PRD / Agent 信息文档</strong>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                <select
                  value={prdUploadForm.docType}
                  onChange={(event) => setPrdUploadForm((prev) => ({ ...prev, docType: event.target.value as PrdDocType }))}
                  disabled={busy || !hasProject}
                  style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
                >
                  <option value="prd">PRD</option>
                  <option value="agent_info">Agent 信息文档</option>
                </select>
                <input
                  value={prdUploadForm.name}
                  onChange={(event) => setPrdUploadForm((prev) => ({ ...prev, name: event.target.value }))}
                  placeholder="文档名称（可选，不填则取文件名）"
                  disabled={busy || !hasProject}
                  style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
                />
                <input
                  value={prdUploadForm.remark}
                  onChange={(event) => setPrdUploadForm((prev) => ({ ...prev, remark: event.target.value }))}
                  placeholder="备注"
                  disabled={busy || !hasProject}
                  style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
                />
              </div>
              <input
                type="file"
                accept={`.md,.txt,.docx,text/markdown,text/plain,${DOCX_MIME_TYPE}`}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  setPrdUploadForm((prev) => ({ ...prev, file: event.target.files?.[0] ?? null }))
                }
                disabled={busy || !hasProject}
                style={{ borderRadius: 10, border: "1px solid hsl(var(--input))", padding: 8, background: "var(--input-bg)" }}
              />
              <button
                type="submit"
                disabled={busy || !hasProject}
                style={{
                  border: "1px solid #10a37f",
                  borderRadius: 10,
                  padding: "8px 11px",
                  background: "#10a37f",
                  color: "#ffffff",
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                上传文档
              </button>
            </form>

            <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 8 }}>
              <select
                value={prdTypeFilter}
                onChange={(event) => setPrdTypeFilter(event.target.value as "all" | PrdDocType)}
                style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
              >
                <option value="all">全部文档类型</option>
                <option value="prd">PRD</option>
                <option value="agent_info">Agent 信息文档</option>
              </select>
              <div style={{ color: "#6b7578", fontSize: 12, display: "grid", placeItems: "center start" }}>
                项目：{selectedProject?.name ?? "-"}，Suite：{selectedSuiteId ? suiteNameById(suites, selectedSuiteId) : "全部"}
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="data-table min-w-[1080px]">
                <thead>
                  <tr>
                    <th>文档 ID</th>
                    <th>文档名称</th>
                    <th>文档类型</th>
                    <th>关联项目</th>
                    <th>关联 Suite</th>
                    <th>更新时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPrdDocs.length === 0 ? (
                    <tr>
                      <td colSpan={7} style={{ padding: "12px 8px", color: "#687274" }}>
                        暂无 PRD / Agent 文档资产
                      </td>
                    </tr>
                  ) : (
                    filteredPrdDocs
                      .slice()
                      .reverse()
                      .map((asset) => {
                        const meta = safeMeta(asset);
                        return (
                          <tr key={asset.id} style={{ borderBottom: "1px solid rgba(31,37,39,0.08)" }}>
                            <td style={{ padding: "9px 8px", fontWeight: 700 }}>{asset.id}</td>
                            <td style={{ padding: "9px 8px" }}>{asset.name}</td>
                            <td style={{ padding: "9px 8px" }}>{String(meta.doc_type ?? "-")}</td>
                            <td style={{ padding: "9px 8px" }}>{selectedProject?.name ?? asset.project_id}</td>
                            <td style={{ padding: "9px 8px" }}>{suiteNameById(suites, typeof meta.suite_id === "number" ? meta.suite_id : null)}</td>
                            <td style={{ padding: "9px 8px" }}>{asset.updated_at ?? "-"}</td>
                            <td style={{ padding: "9px 8px", display: "flex", gap: 6, flexWrap: "wrap" }}>
                              <button
                                type="button"
                                onClick={() => setDocDetail(asset)}
                                style={actionButtonStyle}
                              >
                                查看详情
                              </button>
                              <button
                                type="button"
                                onClick={() => onOpenEditDoc(asset)}
                                style={actionButtonStyle}
                              >
                                修改
                              </button>
                              <button
                                type="button"
                                onClick={() => void onDeleteDoc(asset.id)}
                                style={dangerActionButtonStyle}
                              >
                                删除
                              </button>
                            </td>
                          </tr>
                        );
                      })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        {currentTab === "api_docs" ? (
          <div style={{ display: "grid", gap: 12 }}>
            <form onSubmit={(event) => void onUploadApiDoc(event)} style={{ borderRadius: 14, border: "1px solid rgba(31,37,39,0.08)", padding: 12, display: "grid", gap: 8 }}>
              <strong>上传 API 文档</strong>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                <select
                  value={apiUploadForm.format}
                  onChange={(event) => setApiUploadForm((prev) => ({ ...prev, format: event.target.value as ApiDocFormat }))}
                  disabled={busy || !hasProject}
                  style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
                >
                  <option value="openapi_json">OpenAPI / Swagger JSON</option>
                  <option value="json">普通 JSON</option>
                  <option value="markdown">Markdown</option>
                </select>
                <input
                  value={apiUploadForm.name}
                  onChange={(event) => setApiUploadForm((prev) => ({ ...prev, name: event.target.value }))}
                  placeholder="API 文档名称"
                  disabled={busy || !hasProject}
                  style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
                />
                <input
                  value={apiUploadForm.remark}
                  onChange={(event) => setApiUploadForm((prev) => ({ ...prev, remark: event.target.value }))}
                  placeholder="备注"
                  disabled={busy || !hasProject}
                  style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
                />
              </div>
              <input
                type="file"
                accept=".json,.md,.txt,application/json,text/markdown,text/plain"
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  setApiUploadForm((prev) => ({ ...prev, file: event.target.files?.[0] ?? null }))
                }
                disabled={busy || !hasProject}
                style={{ borderRadius: 10, border: "1px solid hsl(var(--input))", padding: 8, background: "var(--input-bg)" }}
              />
              <button
                type="submit"
                disabled={busy || !hasProject}
                style={{
                  border: "1px solid #10a37f",
                  borderRadius: 10,
                  padding: "8px 11px",
                  background: "#10a37f",
                  color: "#ffffff",
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                上传 API 文档
              </button>
            </form>

            <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 8 }}>
              <select
                value={apiDocFormatFilter}
                onChange={(event) => setApiDocFormatFilter(event.target.value as "all" | ApiDocFormat)}
                style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
              >
                <option value="all">全部格式</option>
                <option value="openapi_json">OpenAPI / Swagger JSON</option>
                <option value="json">普通 JSON</option>
                <option value="markdown">Markdown</option>
              </select>
              <div style={{ color: "#6b7578", fontSize: 12, display: "grid", placeItems: "center start" }}>
                项目：{selectedProject?.name ?? "-"}，Suite：{selectedSuiteId ? suiteNameById(suites, selectedSuiteId) : "全部"}
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="data-table min-w-[1080px]">
                <thead>
                  <tr>
                    <th>文档名称</th>
                    <th>文档类型</th>
                    <th>项目</th>
                    <th>Suite</th>
                    <th>更新时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredApiDocs.length === 0 ? (
                    <tr>
                      <td colSpan={6} style={{ padding: "12px 8px", color: "#687274" }}>
                        暂无 API 文档资产
                      </td>
                    </tr>
                  ) : (
                    filteredApiDocs
                      .slice()
                      .reverse()
                      .map((asset) => {
                        const meta = safeMeta(asset);
                        return (
                          <tr key={asset.id} style={{ borderBottom: "1px solid rgba(31,37,39,0.08)" }}>
                            <td style={{ padding: "9px 8px" }}>{asset.name}</td>
                            <td style={{ padding: "9px 8px" }}>{String(meta.doc_format ?? "-")}</td>
                            <td style={{ padding: "9px 8px" }}>{selectedProject?.name ?? asset.project_id}</td>
                            <td style={{ padding: "9px 8px" }}>{suiteNameById(suites, typeof meta.suite_id === "number" ? meta.suite_id : null)}</td>
                            <td style={{ padding: "9px 8px" }}>{asset.updated_at ?? "-"}</td>
                            <td style={{ padding: "9px 8px", display: "flex", gap: 6, flexWrap: "wrap" }}>
                              <button
                                type="button"
                                onClick={() => setDocDetail(asset)}
                                style={actionButtonStyle}
                              >
                                查看详情
                              </button>
                              <button
                                type="button"
                                onClick={() => onOpenEditDoc(asset)}
                                style={actionButtonStyle}
                              >
                                修改
                              </button>
                              <button
                                type="button"
                                onClick={() => void onDeleteDoc(asset.id)}
                                style={dangerActionButtonStyle}
                              >
                                删除
                              </button>
                            </td>
                          </tr>
                        );
                      })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        {currentTab === "report_channels" ? (
          <div style={{ display: "grid", gap: 12 }}>
            <form
              onSubmit={(event) => void onCreateReportChannel(event)}
              style={{ borderRadius: 14, border: "1px solid rgba(31,37,39,0.08)", padding: 12, display: "grid", gap: 8 }}
            >
              <strong>新增发送渠道（飞书应用凭证）</strong>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <input
                  value={reportChannelForm.name}
                  onChange={(event) => setReportChannelForm((prev) => ({ ...prev, name: event.target.value }))}
                  placeholder="渠道名称（例如：测试群通知）"
                  disabled={busy || !hasProject}
                  style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
                />
                <input
                  value={reportChannelForm.appId}
                  onChange={(event) => setReportChannelForm((prev) => ({ ...prev, appId: event.target.value }))}
                  placeholder="APP_ID（例如：cli_xxx）"
                  disabled={busy || !hasProject}
                  style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
                />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <input
                  value={reportChannelForm.appSecret}
                  onChange={(event) => setReportChannelForm((prev) => ({ ...prev, appSecret: event.target.value }))}
                  placeholder="APP_SECRET"
                  type="password"
                  disabled={busy || !hasProject}
                  style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
                />
                <input
                  value={reportChannelForm.chatId}
                  onChange={(event) => setReportChannelForm((prev) => ({ ...prev, chatId: event.target.value }))}
                  placeholder="CHAT_ID（群 ID）"
                  disabled={busy || !hasProject}
                  style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
                />
              </div>
              <input
                value={reportChannelForm.defaultMessage}
                onChange={(event) => setReportChannelForm((prev) => ({ ...prev, defaultMessage: event.target.value }))}
                placeholder="发送信息（默认消息，可选）"
                disabled={busy || !hasProject}
                style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
              />
              <button
                type="submit"
                disabled={busy || !hasProject}
                style={{
                  border: "1px solid #10a37f",
                  borderRadius: 10,
                  padding: "8px 11px",
                  background: "#10a37f",
                  color: "#ffffff",
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                创建发送渠道
              </button>
            </form>

            <div style={{ color: "#6b7578", fontSize: 12 }}>发送渠道为全局资产，可在任意项目的定时任务中选择。</div>

            <div className="overflow-x-auto">
              <table className="data-table min-w-[1180px]">
                <thead>
                  <tr>
                    <th>渠道 ID</th>
                    <th>渠道名称</th>
                    <th>渠道类型</th>
                    <th>APP_ID</th>
                    <th>CHAT_ID</th>
                    <th>发送信息</th>
                    <th>更新时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredReportChannels.length === 0 ? (
                    <tr>
                      <td colSpan={8} style={{ padding: "12px 8px", color: "#687274" }}>
                        暂无发送渠道
                      </td>
                    </tr>
                  ) : (
                    filteredReportChannels
                      .slice()
                      .reverse()
                      .map((channel) => {
                        const contentJson = isRecord(channel.content_json) ? channel.content_json : {};
                        return (
                          <tr key={channel.id} style={{ borderBottom: "1px solid rgba(31,37,39,0.08)" }}>
                            <td style={{ padding: "9px 8px", fontWeight: 700 }}>{channel.id}</td>
                            <td style={{ padding: "9px 8px" }}>{channel.name}</td>
                            <td style={{ padding: "9px 8px" }}>{String(contentJson.channel_type ?? "feishu_app")}</td>
                            <td style={{ padding: "9px 8px" }}>{maskCredential(contentJson.app_id, 6, 3)}</td>
                            <td style={{ padding: "9px 8px" }}>{maskCredential(contentJson.chat_id, 6, 3)}</td>
                            <td style={{ padding: "9px 8px" }}>{String(contentJson.default_message ?? "-")}</td>
                            <td style={{ padding: "9px 8px" }}>{channel.updated_at ?? "-"}</td>
                            <td style={{ padding: "9px 8px", display: "flex", gap: 6, flexWrap: "wrap" }}>
                              <button type="button" onClick={() => setDocDetail(channel)} style={actionButtonStyle}>
                                查看详情
                              </button>
                              <button
                                type="button"
                                onClick={() => void onDeleteReportChannel(channel.id)}
                                style={dangerActionButtonStyle}
                              >
                                删除
                              </button>
                            </td>
                          </tr>
                        );
                      })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        {currentTab === "api_suite_cases" ? (
          <div style={{ display: "grid", gap: 12 }}>
            {apiActiveSuiteId === null ? (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1280 }}>
                  <thead>
                    <tr style={{ textAlign: "left", borderBottom: "1px solid rgba(31,37,39,0.12)" }}>
                      <th style={{ padding: "9px 8px" }}>Suite ID</th>
                      <th style={{ padding: "9px 8px" }}>Suite 名称</th>
                      <th style={{ padding: "9px 8px" }}>所属项目</th>
                      <th style={{ padding: "9px 8px" }}>关联 PRD 文档</th>
                      <th style={{ padding: "9px 8px" }}>关联 API 文档</th>
                      <th style={{ padding: "9px 8px" }}>case 数量</th>
                      <th style={{ padding: "9px 8px" }}>来源</th>
                      <th style={{ padding: "9px 8px" }}>最近生成时间</th>
                      <th style={{ padding: "9px 8px" }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {apiSuiteOverviews.length === 0 ? (
                      <tr>
                        <td colSpan={9} style={{ padding: "12px 8px", color: "#687274" }}>
                          当前项目暂无 API Suite
                        </td>
                      </tr>
                    ) : (
                      apiSuiteOverviews.map((suite) => (
                        <tr key={suite.id} style={{ borderBottom: "1px solid rgba(31,37,39,0.08)" }}>
                          <td style={{ padding: "9px 8px", fontWeight: 700 }}>{suite.id}</td>
                          <td style={{ padding: "9px 8px" }}>{suite.name}</td>
                          <td style={{ padding: "9px 8px" }}>{selectedProject?.name ?? suite.project_id}</td>
                          <td style={{ padding: "9px 8px" }}>{suite.linked_prd_doc_name ?? "-"}</td>
                          <td style={{ padding: "9px 8px" }}>{suite.linked_api_doc_name ?? "-"}</td>
                          <td style={{ padding: "9px 8px" }}>{suite.case_count}</td>
                          <td style={{ padding: "9px 8px" }}>{suite.source_summary ?? "-"}</td>
                          <td style={{ padding: "9px 8px" }}>{suite.last_generated_at ?? "-"}</td>
                          <td style={{ padding: "9px 8px", display: "flex", gap: 6, flexWrap: "wrap" }}>
                            <button
                              type="button"
                              onClick={() => onOpenApiSuiteCases(suite.id)}
                              style={actionButtonCompactStyle}
                            >
                              查看案例
                            </button>
                            <Link
                              to={`/generation?tab=generate_api_cases&projectId=${suite.project_id}&suiteId=${suite.id}`}
                              style={actionLinkCompactStyle}
                            >
                              跳转生成
                            </Link>
                            <button
                              type="button"
                              onClick={() => onViewApiLinkedDocs(suite.id)}
                              style={actionButtonCompactStyle}
                            >
                              查看关联文档
                            </button>
                            <button
                              type="button"
                              onClick={() => void onDeleteSuiteItem(suite.id)}
                              style={dangerActionButtonCompactStyle}
                            >
                              删除 Suite
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            ) : (
              <div style={{ display: "grid", gap: 12 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                  <strong>API Suite 测试案例 / {activeApiSuite?.name ?? apiActiveSuiteId}</strong>
                  <button
                    type="button"
                    onClick={onBackToApiSuiteList}
                    style={subtleActionButtonStyle}
                  >
                    返回 Suite 列表
                  </button>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 8 }}>
                  <select
                    value={apiCaseSourceFilter}
                    onChange={(event) => setApiCaseSourceFilter(event.target.value)}
                    style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
                  >
                    <option value="all">全部来源</option>
                    <option value="manual">manual</option>
                    <option value="llm_generated">llm_generated</option>
                    <option value="imported">imported</option>
                  </select>
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1320 }}>
                    <thead>
                      <tr style={{ textAlign: "left", borderBottom: "1px solid rgba(31,37,39,0.12)" }}>
                        <th style={{ padding: "9px 8px" }}>case ID</th>
                        <th style={{ padding: "9px 8px" }}>case 名称</th>
                        <th style={{ padding: "9px 8px" }}>场景类型</th>
                        <th style={{ padding: "9px 8px" }}>method</th>
                        <th style={{ padding: "9px 8px" }}>path</th>
                        <th style={{ padding: "9px 8px" }}>来源</th>
                        <th style={{ padding: "9px 8px" }}>更新时间</th>
                        <th style={{ padding: "9px 8px" }}>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredApiCases.length === 0 ? (
                        <tr>
                          <td colSpan={8} style={{ padding: "12px 8px", color: "#687274" }}>
                            当前 Suite 暂无 API 案例
                          </td>
                        </tr>
                      ) : (
                        filteredApiCases.map((caseItem) => {
                          const input = isRecord(caseItem.input_payload) ? caseItem.input_payload : {};
                          const meta = safeCaseMeta(caseItem);
                          return (
                            <tr key={caseItem.id} style={{ borderBottom: "1px solid rgba(31,37,39,0.08)" }}>
                              <td style={{ padding: "9px 8px", fontWeight: 700 }}>{caseItem.id}</td>
                              <td style={{ padding: "9px 8px" }}>{caseItem.name}</td>
                              <td style={{ padding: "9px 8px" }}>
                                {typeof meta.scenario_type === "string"
                                  ? meta.scenario_type
                                  : typeof meta.generation_reason === "string"
                                    ? meta.generation_reason
                                    : "-"}
                              </td>
                              <td style={{ padding: "9px 8px" }}>{typeof input.method === "string" ? input.method : "-"}</td>
                              <td style={{ padding: "9px 8px" }}>{typeof input.path === "string" ? input.path : "-"}</td>
                              <td style={{ padding: "9px 8px" }}>{caseItem.source_type ?? "-"}</td>
                              <td style={{ padding: "9px 8px" }}>{caseItem.updated_at ?? "-"}</td>
                              <td style={{ padding: "9px 8px", display: "flex", gap: 6, flexWrap: "wrap" }}>
                                <button
                                  type="button"
                                  onClick={() => setCaseDetail(caseItem)}
                                  style={actionButtonStyle}
                                >
                                  查看详情
                                </button>
                                <Link
                                  to={`/assets/cases/${caseItem.id}/edit?returnTab=api_suite_cases&projectId=${caseItem.project_id}${caseItem.suite_id ? `&suiteId=${caseItem.suite_id}` : ""}`}
                                  style={actionLinkStyle}
                                >
                                  编辑
                                </Link>
                                <Link
                                  to={`/execution/builder?projectId=${caseItem.project_id}&suiteId=${caseItem.suite_id ?? ""}`}
                                  style={actionLinkStyle}
                                >
                                  跳转执行
                                </Link>
                                <button
                                  type="button"
                                  onClick={() => void onDeleteCaseItem(caseItem.id)}
                                  style={dangerActionButtonStyle}
                                >
                                  删除
                                </button>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        ) : null}

        {currentTab === "agent_benchmark_cases" ? (
          <div style={{ display: "grid", gap: 12 }}>
            {agentActiveSuiteId === null ? (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1240 }}>
                  <thead>
                    <tr style={{ textAlign: "left", borderBottom: "1px solid rgba(31,37,39,0.12)" }}>
                      <th style={{ padding: "9px 8px" }}>Suite ID</th>
                      <th style={{ padding: "9px 8px" }}>Suite 名称</th>
                      <th style={{ padding: "9px 8px" }}>所属项目</th>
                      <th style={{ padding: "9px 8px" }}>关联文档</th>
                      <th style={{ padding: "9px 8px" }}>case 数量</th>
                      <th style={{ padding: "9px 8px" }}>来源</th>
                      <th style={{ padding: "9px 8px" }}>最近生成时间</th>
                      <th style={{ padding: "9px 8px" }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agentSuiteOverviews.length === 0 ? (
                      <tr>
                        <td colSpan={8} style={{ padding: "12px 8px", color: "#687274" }}>
                          当前项目暂无 Agent Benchmark Suite
                        </td>
                      </tr>
                    ) : (
                      agentSuiteOverviews.map((suite) => (
                        <tr key={suite.id} style={{ borderBottom: "1px solid rgba(31,37,39,0.08)" }}>
                          <td style={{ padding: "9px 8px", fontWeight: 700 }}>{suite.id}</td>
                          <td style={{ padding: "9px 8px" }}>{suite.name}</td>
                          <td style={{ padding: "9px 8px" }}>{selectedProject?.name ?? suite.project_id}</td>
                          <td style={{ padding: "9px 8px" }}>{suite.linked_source_doc_name ?? suite.linked_prd_doc_name ?? "-"}</td>
                          <td style={{ padding: "9px 8px" }}>{suite.case_count}</td>
                          <td style={{ padding: "9px 8px" }}>{suite.source_summary ?? "-"}</td>
                          <td style={{ padding: "9px 8px" }}>{suite.last_generated_at ?? "-"}</td>
                          <td style={{ padding: "9px 8px", display: "flex", gap: 6, flexWrap: "wrap" }}>
                            <button
                              type="button"
                              onClick={() => onOpenAgentSuiteCases(suite.id)}
                              style={actionButtonCompactStyle}
                            >
                              查看案例
                            </button>
                            <Link
                              to={`/generation?tab=generate_agent_dataset&projectId=${suite.project_id}&suiteId=${suite.id}`}
                              style={actionLinkCompactStyle}
                            >
                              跳转生成
                            </Link>
                            <button
                              type="button"
                              onClick={() => onViewAgentLinkedDocs(suite.id)}
                              style={actionButtonCompactStyle}
                            >
                              查看关联文档
                            </button>
                            <button
                              type="button"
                              onClick={() => void onDeleteSuiteItem(suite.id)}
                              style={dangerActionButtonCompactStyle}
                            >
                              删除 Suite
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            ) : (
              <div style={{ display: "grid", gap: 12 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                  <strong>Agent Benchmark 测试案例 / {activeAgentSuite?.name ?? agentActiveSuiteId}</strong>
                  <button
                    type="button"
                    onClick={onBackToAgentSuiteList}
                    style={subtleActionButtonStyle}
                  >
                    返回 Suite 列表
                  </button>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <select
                    value={agentCaseStatusFilter}
                    onChange={(event) => setAgentCaseStatusFilter(event.target.value)}
                    style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
                  >
                    <option value="all">全部状态</option>
                    <option value="draft">draft</option>
                    <option value="active">active</option>
                  </select>
                  <select
                    value={agentHasReferenceFilter}
                    onChange={(event) => setAgentHasReferenceFilter(event.target.value as YesNoAll)}
                    style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
                  >
                    <option value="all">是否带标准答案：全部</option>
                    <option value="yes">是</option>
                    <option value="no">否</option>
                  </select>
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1200 }}>
                    <thead>
                      <tr style={{ textAlign: "left", borderBottom: "1px solid rgba(31,37,39,0.12)" }}>
                        <th style={{ padding: "9px 8px" }}>case ID</th>
                        <th style={{ padding: "9px 8px" }}>benchmark 名称</th>
                        <th style={{ padding: "9px 8px" }}>输入摘要</th>
                        <th style={{ padding: "9px 8px" }}>标准答案</th>
                        <th style={{ padding: "9px 8px" }}>来源</th>
                        <th style={{ padding: "9px 8px" }}>更新时间</th>
                        <th style={{ padding: "9px 8px" }}>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredAgentCases.length === 0 ? (
                        <tr>
                          <td colSpan={7} style={{ padding: "12px 8px", color: "#687274" }}>
                            当前 Suite 暂无 Agent Benchmark 案例
                          </td>
                        </tr>
                      ) : (
                        filteredAgentCases.map((caseItem) => {
                          const input = isRecord(caseItem.input_payload) ? caseItem.input_payload : {};
                          const expected = isRecord(caseItem.expected_output) ? caseItem.expected_output : {};
                          const hasRef = isRecord(expected.reference_answer);
                          return (
                            <tr key={caseItem.id} style={{ borderBottom: "1px solid rgba(31,37,39,0.08)" }}>
                              <td style={{ padding: "9px 8px", fontWeight: 700 }}>{caseItem.id}</td>
                              <td style={{ padding: "9px 8px" }}>{caseItem.name}</td>
                              <td style={{ padding: "9px 8px", maxWidth: 360 }}>
                                {typeof input.user_input === "string" ? input.user_input.slice(0, 120) : "-"}
                              </td>
                              <td style={{ padding: "9px 8px" }}>{hasRef ? "是" : "否"}</td>
                              <td style={{ padding: "9px 8px" }}>{caseItem.source_type ?? "-"}</td>
                              <td style={{ padding: "9px 8px" }}>{caseItem.updated_at ?? "-"}</td>
                              <td style={{ padding: "9px 8px", display: "flex", gap: 6, flexWrap: "wrap" }}>
                                <button
                                  type="button"
                                  onClick={() => setCaseDetail(caseItem)}
                                  style={actionButtonStyle}
                                >
                                  查看详情
                                </button>
                                <Link
                                  to={`/assets/cases/${caseItem.id}/edit?returnTab=agent_benchmark_cases&projectId=${caseItem.project_id}${caseItem.suite_id ? `&suiteId=${caseItem.suite_id}` : ""}`}
                                  style={actionLinkStyle}
                                >
                                  编辑
                                </Link>
                                <button
                                  type="button"
                                  onClick={() => void onDeleteCaseItem(caseItem.id)}
                                  style={dangerActionButtonStyle}
                                >
                                  删除
                                </button>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>

      {docDetail ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/25 p-4 backdrop-blur-sm">
          <div className="w-full max-w-[920px] max-h-[84vh] overflow-auto rounded-2xl border border-border/80 bg-card p-4 shadow-panel">
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
              <strong>文档详情</strong>
              <button
                type="button"
                onClick={() => setDocDetail(null)}
                className="console-btn px-2.5 py-1.5 text-sm font-semibold"
              >
                关闭
              </button>
            </div>
            <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
              <div>名称：{docDetail.name}</div>
              <div>文件名：{docDetail.file_name ?? "-"}</div>
              <div>项目：{selectedProject?.name ?? docDetail.project_id}</div>
              <div>Suite：{suiteNameById(suites, isRecord(docDetail.meta_info) ? (typeof docDetail.meta_info.suite_id === "number" ? docDetail.meta_info.suite_id : null) : null)}</div>
              <div>上传时间：{docDetail.created_at ?? "-"}</div>
              <div>更新时间：{docDetail.updated_at ?? "-"}</div>
              <div style={{ fontWeight: 700, marginTop: 6 }}>内容预览</div>
              <pre className="m-0 max-h-[340px] overflow-auto rounded-xl border border-border/70 bg-zinc-50 p-2.5 text-xs font-mono leading-relaxed">
                {assetPreviewText(docDetail)}
              </pre>
              <button
                type="button"
                onClick={() => onDownloadDoc(docDetail)}
                className="console-btn w-fit px-3 py-1.5 text-sm font-semibold"
              >
                下载
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {docEditTarget ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/25 p-4 backdrop-blur-sm">
          <form onSubmit={(event) => void onSaveDocEdit(event)} className="grid w-full max-w-[920px] max-h-[84vh] gap-2.5 overflow-auto rounded-2xl border border-border/80 bg-card p-4 shadow-panel">
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
              <strong>修改文档</strong>
              <button
                type="button"
                onClick={() => setDocEditTarget(null)}
                className="console-btn px-2.5 py-1.5 text-sm font-semibold"
              >
                关闭
              </button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              <input
                value={docEditForm.name}
                onChange={(event) => setDocEditForm((prev) => ({ ...prev, name: event.target.value }))}
                placeholder="文档名称"
                style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
              />
              <select
                value={docEditForm.suiteId}
                onChange={(event) =>
                  setDocEditForm((prev) => ({
                    ...prev,
                    suiteId: event.target.value ? Number(event.target.value) : "",
                  }))
                }
                style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
              >
                <option value="">无 Suite</option>
                {suites.map((suite) => (
                  <option key={suite.id} value={suite.id}>
                    {suite.name}
                  </option>
                ))}
              </select>
              <input
                value={docEditForm.remark}
                onChange={(event) => setDocEditForm((prev) => ({ ...prev, remark: event.target.value }))}
                placeholder="备注"
                style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
              />
            </div>

            {docEditTarget.asset_type === "prd_agent_doc" ? (
              <select
                value={docEditForm.docType}
                onChange={(event) => setDocEditForm((prev) => ({ ...prev, docType: event.target.value as PrdDocType }))}
                style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px", width: 260 }}
              >
                <option value="prd">PRD</option>
                <option value="agent_info">Agent 信息文档</option>
              </select>
            ) : (
              <select
                value={docEditForm.docFormat}
                onChange={(event) => setDocEditForm((prev) => ({ ...prev, docFormat: event.target.value as ApiDocFormat }))}
                style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px", width: 260 }}
              >
                <option value="openapi_json">OpenAPI / Swagger JSON</option>
                <option value="json">普通 JSON</option>
                <option value="markdown">Markdown</option>
              </select>
            )}

            <textarea
              value={docEditForm.contentText}
              onChange={(event) => setDocEditForm((prev) => ({ ...prev, contentText: event.target.value }))}
              rows={16}
              style={{
                borderRadius: 10,
                border: "1px solid rgba(31,37,39,0.16)",
                padding: "9px 11px",
                fontFamily: "monospace",
              }}
            />

            <button
              type="submit"
              disabled={busy}
              className="rounded-xl border border-primary/60 bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? "保存中..." : "保存修改"}
            </button>
          </form>
        </div>
      ) : null}

      {caseDetail ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/25 p-4 backdrop-blur-sm">
          <div className="w-full max-w-[1020px] max-h-[84vh] overflow-auto rounded-2xl border border-border/80 bg-card p-4 shadow-panel">
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
              <strong>案例详情</strong>
              <button
                type="button"
                onClick={() => setCaseDetail(null)}
                className="console-btn px-2.5 py-1.5 text-sm font-semibold"
              >
                关闭
              </button>
            </div>
            <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
              <div>
                caseId：{caseDetail.id} · {caseDetail.name} · {caseDetail.case_type} · {caseDetail.status}
              </div>
              <div>项目：{selectedProject?.name ?? caseDetail.project_id}</div>
              <div>Suite：{suiteNameById(suites, caseDetail.suite_id)}</div>
              <div>来源：{caseDetail.source_type ?? "-"}</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <div>
                  <div style={{ fontWeight: 700, marginBottom: 4 }}>请求参数 / 输入</div>
                  <pre
                    style={{
                      margin: 0,
                      borderRadius: 10,
                      border: "1px solid rgba(31,37,39,0.08)",
                      padding: 10,
                      maxHeight: 260,
                      overflow: "auto",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      fontFamily: "monospace",
                      fontSize: 12,
                      background: "rgba(31,37,39,0.03)",
                    }}
                  >
                    {toPretty(caseDetail.input_payload)}
                  </pre>
                </div>
                <div>
                  <div style={{ fontWeight: 700, marginBottom: 4 }}>预期结果</div>
                  <pre
                    style={{
                      margin: 0,
                      borderRadius: 10,
                      border: "1px solid rgba(31,37,39,0.08)",
                      padding: 10,
                      maxHeight: 260,
                      overflow: "auto",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      fontFamily: "monospace",
                      fontSize: 12,
                      background: "rgba(31,37,39,0.03)",
                    }}
                  >
                    {toPretty(caseDetail.expected_output)}
                  </pre>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <div>
                  <div style={{ fontWeight: 700, marginBottom: 4 }}>断言规则</div>
                  <pre
                    style={{
                      margin: 0,
                      borderRadius: 10,
                      border: "1px solid rgba(31,37,39,0.08)",
                      padding: 10,
                      maxHeight: 200,
                      overflow: "auto",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      fontFamily: "monospace",
                      fontSize: 12,
                      background: "rgba(31,37,39,0.03)",
                    }}
                  >
                    {toPretty(caseDetail.assertion_config)}
                  </pre>
                </div>
                <div>
                  <div style={{ fontWeight: 700, marginBottom: 4 }}>评分配置</div>
                  <pre
                    style={{
                      margin: 0,
                      borderRadius: 10,
                      border: "1px solid rgba(31,37,39,0.08)",
                      padding: 10,
                      maxHeight: 200,
                      overflow: "auto",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      fontFamily: "monospace",
                      fontSize: 12,
                      background: "rgba(31,37,39,0.03)",
                    }}
                  >
                    {toPretty(caseDetail.eval_config)}
                  </pre>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
