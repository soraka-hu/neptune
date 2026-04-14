import { FormEvent, type CSSProperties, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { FloatingNotice, type NoticeTone } from "../../components/FloatingNotice";
import {
  DatasetRecord,
  ProjectRecord,
  SuiteRecord,
  UserAssetRecord,
  archiveProject,
  createProject,
  createSuite,
  deleteSuite,
  deleteUserAsset,
  generateAgentDataset,
  generateApiCases,
  generateApiCasesFromBenchmarkDataset,
  importDatasetItems,
  listDatasets,
  listProjects,
  listProjectsPaged,
  listSuites,
  listSuitesPaged,
  listUserAssets,
  listUserAssetsPaged,
  updateProject,
  updateSuite,
} from "../../services/assetService";
type GenerationTab =
  | "project_mgmt"
  | "suite_mgmt"
  | "generate_api_cases"
  | "generate_agent_dataset";
type AgentDatasetInputTab = "generate_agent" | "upload_benchmark";

const tabOptions: Array<{ key: GenerationTab; label: string }> = [
  { key: "project_mgmt", label: "项目管理" },
  { key: "suite_mgmt", label: "Suite 管理" },
  { key: "generate_api_cases", label: "生成 API 案例" },
  { key: "generate_agent_dataset", label: "生成 Agent 数据集" },
];

const panelStyle: CSSProperties = {
  borderRadius: 12,
  padding: 16,
  background: "#ffffff",
  border: "1px solid #E5E7EB",
  boxShadow: "none",
};
const TABLE_PAGE_SIZE = 9;

const benchmarkDatasetTemplateHeaders = [
  "user_input",
  "reference_answer_json",
  "conversation_history_json",
  "tools_context_json",
  "constraints_json",
  "scenario_type",
  "dimensions",
  "meta_info_json",
];

const benchmarkDatasetTemplateRow = {
  user_input: "请总结这段内容的要点，并给出 3 条可执行建议",
  reference_answer_json: "{\"answer\":\"总结要点并给出3条建议\"}",
  conversation_history_json: "[]",
  tools_context_json: "[]",
  constraints_json: "{\"tone\":\"professional\"}",
  scenario_type: "single_turn",
  dimensions: "single_turn|open_task",
  meta_info_json: "{\"source\":\"manual_upload\"}",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeCsvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, "\"\"")}"`;
  }
  return value;
}

function buildBenchmarkTemplateCsv(): string {
  const headerLine = benchmarkDatasetTemplateHeaders.join(",");
  const rowLine = benchmarkDatasetTemplateHeaders
    .map((key) => escapeCsvCell(String(benchmarkDatasetTemplateRow[key as keyof typeof benchmarkDatasetTemplateRow] ?? "")))
    .join(",");
  return `\uFEFF${headerLine}\n${rowLine}\n`;
}

function downloadTextFile(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(objectUrl);
}

function detectDelimiter(headerLine: string): string {
  const candidates = [",", "\t", ";"];
  let best = ",";
  let bestCount = -1;
  candidates.forEach((candidate) => {
    const count = headerLine.split(candidate).length - 1;
    if (count > bestCount) {
      bestCount = count;
      best = candidate;
    }
  });
  return best;
}

function parseDelimitedText(content: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];
    if (inQuotes) {
      if (char === "\"") {
        if (next === "\"") {
          field += "\"";
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === "\"") {
      inQuotes = true;
      continue;
    }
    if (char === delimiter) {
      row.push(field);
      field = "";
      continue;
    }
    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    if (char !== "\r") {
      field += char;
    }
  }

  row.push(field);
  if (row.some((item) => item.trim() !== "")) {
    rows.push(row);
  }
  return rows;
}

function parseOptionalJson(value: string, label: string, rowNumber: number): unknown {
  if (!value.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`第 ${rowNumber} 行的 ${label} 不是合法 JSON`);
  }
}

function parseArrayJson(value: string, label: string, rowNumber: number): unknown[] {
  const parsed = parseOptionalJson(value, label, rowNumber);
  if (parsed === undefined) {
    return [];
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`第 ${rowNumber} 行的 ${label} 必须是 JSON 数组`);
  }
  return parsed;
}

function parseObjectJson(
  value: string,
  label: string,
  rowNumber: number,
  options?: { optional?: boolean }
): Record<string, unknown> | undefined {
  const parsed = parseOptionalJson(value, label, rowNumber);
  if (parsed === undefined) {
    return options?.optional ? undefined : {};
  }
  if (!isRecord(parsed)) {
    throw new Error(`第 ${rowNumber} 行的 ${label} 必须是 JSON 对象`);
  }
  return parsed;
}

function parseReferenceAnswer(value: string, rowNumber: number): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (isRecord(parsed)) {
      return parsed;
    }
    if (typeof parsed === "string") {
      return { answer: parsed };
    }
    return { answer: JSON.stringify(parsed) };
  } catch {
    return { answer: trimmed };
  }
}

function parseDimensions(value: string): string[] {
  return value
    .split(/[|,]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

const AUTO_GENERATED_DATASET_MARKERS = new Set([
  "batch_id",
  "source_doc_id",
  "api_doc_id",
  "dimensions",
  "model",
  "generation_batch_id",
]);

function isUserUploadedBenchmarkDataset(dataset: DatasetRecord): boolean {
  const generationConfig = isRecord(dataset.generation_config) ? dataset.generation_config : null;
  const configKeys = generationConfig ? Object.keys(generationConfig) : [];
  if (generationConfig && configKeys.some((key) => AUTO_GENERATED_DATASET_MARKERS.has(key))) {
    return false;
  }

  const normalizedName = dataset.name.trim().toLowerCase();
  if (/-agent-dataset-\d+$/.test(normalizedName)) {
    return false;
  }

  return dataset.dataset_type === "with_reference" || dataset.dataset_type === "without_reference";
}

function parseDatasetItemsFromTabular(content: string): Array<Record<string, unknown>> {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.trim()) {
    throw new Error("上传内容为空，请选择包含数据的 CSV 文件");
  }
  const [headerLine] = normalized.split("\n");
  const delimiter = detectDelimiter(headerLine ?? "");
  const rows = parseDelimitedText(normalized, delimiter).map((row) => row.map((cell) => cell.trim()));
  if (rows.length <= 1) {
    throw new Error("未识别到数据行，请至少填写 1 行数据");
  }
  const headers = rows[0];
  const userInputIndex = headers.indexOf("user_input");
  if (userInputIndex < 0) {
    throw new Error("表头缺少必填列：user_input");
  }

  const items: Array<Record<string, unknown>> = [];
  rows.slice(1).forEach((cells, dataIndex) => {
    const rowNumber = dataIndex + 2;
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      if (header) {
        row[header] = cells[index] ?? "";
      }
    });
    if (Object.values(row).every((value) => value.trim() === "")) {
      return;
    }
    const userInput = (row.user_input ?? "").trim();
    if (!userInput) {
      throw new Error(`第 ${rowNumber} 行缺少必填字段 user_input`);
    }

    const conversationHistory = parseArrayJson(row.conversation_history_json ?? "", "conversation_history_json", rowNumber);
    const toolsContext = parseArrayJson(row.tools_context_json ?? "", "tools_context_json", rowNumber);
    const constraints = parseObjectJson(row.constraints_json ?? "", "constraints_json", rowNumber) ?? {};
    const referenceAnswer = parseReferenceAnswer(row.reference_answer_json ?? "", rowNumber);
    const metaInfo = parseObjectJson(row.meta_info_json ?? "", "meta_info_json", rowNumber, { optional: true }) ?? {};

    const scenarioType = (row.scenario_type ?? "").trim();
    if (scenarioType) {
      metaInfo.scenario_type = scenarioType;
    }
    const dimensions = parseDimensions(row.dimensions ?? "");
    if (dimensions.length > 0) {
      metaInfo.dimensions = dimensions;
    }

    const nextItem: Record<string, unknown> = {
      input_data: {
        user_input: userInput,
        conversation_history: conversationHistory,
        tools_context: toolsContext,
        constraints,
      },
      status: "active",
    };
    if (referenceAnswer) {
      nextItem.reference_answer = referenceAnswer;
    }
    if (Object.keys(metaInfo).length > 0) {
      nextItem.meta_info = metaInfo;
    }
    items.push(nextItem);
  });

  if (items.length === 0) {
    throw new Error("未识别到可导入数据，请检查内容后重试");
  }
  return items;
}

function parseTab(value: string | null): GenerationTab {
  if (
    value === "project_mgmt" ||
    value === "suite_mgmt" ||
    value === "generate_api_cases" ||
    value === "generate_agent_dataset"
  ) {
    return value;
  }
  return "project_mgmt";
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

function safeMeta(asset: UserAssetRecord): Record<string, unknown> {
  return typeof asset.meta_info === "object" && asset.meta_info !== null && !Array.isArray(asset.meta_info)
    ? asset.meta_info
    : {};
}

type ApiCaseScenario = {
  scenarioType: string;
  title: string;
  description: string;
  statusCode: number;
  expectedCode: number;
  expectedMessage: string;
  bodyPatch?: Record<string, unknown>;
};

type ApiEndpointTemplate = {
  method: string;
  path: string;
  headers: Record<string, string>;
  query: Record<string, unknown>;
};

const apiScenarioLibrary: ApiCaseScenario[] = [
  {
    scenarioType: "normal",
    title: "合法参数调用返回成功",
    description: "当关键参数都合法时，接口应成功处理并返回成功状态",
    statusCode: 200,
    expectedCode: 0,
    expectedMessage: "success",
  },
  {
    scenarioType: "validation",
    title: "缺少用户ID时返回参数错误",
    description: "缺失 userId 时应触发参数校验失败",
    statusCode: 400,
    expectedCode: 1001,
    expectedMessage: "invalid_user_id",
    bodyPatch: { userId: null },
  },
  {
    scenarioType: "validation",
    title: "非法商品ID时返回校验失败",
    description: "skuId 非法时应返回参数校验失败",
    statusCode: 400,
    expectedCode: 1002,
    expectedMessage: "invalid_sku_id",
    bodyPatch: { skuId: -1 },
  },
  {
    scenarioType: "boundary",
    title: "count为最大值时创建成功返回200",
    description: "count 取边界大值时仍应满足成功场景",
    statusCode: 200,
    expectedCode: 0,
    expectedMessage: "success",
    bodyPatch: { count: 9999 },
  },
  {
    scenarioType: "boundary",
    title: "count为0时返回业务错误",
    description: "count 为 0 时应触发业务约束并返回失败",
    statusCode: 422,
    expectedCode: 2001,
    expectedMessage: "invalid_count",
    bodyPatch: { count: 0 },
  },
  {
    scenarioType: "auth",
    title: "未登录调用接口返回401",
    description: "缺少鉴权信息时应返回未授权",
    statusCode: 401,
    expectedCode: 401,
    expectedMessage: "unauthorized",
  },
  {
    scenarioType: "boundary",
    title: "超长备注输入时返回校验失败",
    description: "超长文本输入应被参数层拦截",
    statusCode: 400,
    expectedCode: 1003,
    expectedMessage: "invalid_remark_length",
    bodyPatch: { remark: "x".repeat(520) },
  },
];

function safeRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function compactText(value: string): string {
  return value.replace(/\s+/g, "").replace(/[()（）【】[\]{}]/g, "").trim();
}

function normalizeCaseName(name: string): string {
  let result = compactText(name);
  if (!result) {
    result = "接口调用返回预期结果";
  }
  if (result.length > 30) {
    result = result.slice(0, 30);
  }
  if (result.length < 8) {
    result = `${result}校验场景`;
  }
  return result;
}

function toChineseOrdinal(index: number): string {
  const digits = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
  if (index <= 10) {
    return digits[index - 1] ?? `第${index}`;
  }
  if (index < 20) {
    return `十${digits[index - 11] ?? ""}`;
  }
  const tens = Math.floor(index / 10);
  const units = index % 10;
  const tensLabel = digits[tens - 1] ?? String(tens);
  const unitsLabel = units === 0 ? "" : digits[units - 1] ?? String(units);
  return `${tensLabel}十${unitsLabel}`;
}

function inferEndpointFromApiDoc(apiDoc: UserAssetRecord): ApiEndpointTemplate | null {
  const allowedMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

  function normalizeMethod(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }
    const normalized = value.trim().toUpperCase();
    return allowedMethods.includes(normalized as (typeof allowedMethods)[number]) ? normalized : null;
  }

  function normalizePath(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }
    const raw = value.trim();
    if (!raw) {
      return null;
    }
    if (raw.startsWith("http://") || raw.startsWith("https://")) {
      return raw;
    }
    return raw.startsWith("/") ? raw : `/${raw}`;
  }

  function normalizeScalarSample(name: string, value: unknown): string | null {
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    if (Array.isArray(value) && value.length > 0) {
      return normalizeScalarSample(name, value[0]);
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (record.example !== undefined) {
        return normalizeScalarSample(name, record.example);
      }
      if (record.default !== undefined) {
        return normalizeScalarSample(name, record.default);
      }
      if (Array.isArray(record.enum) && record.enum.length > 0) {
        return normalizeScalarSample(name, record.enum[0]);
      }
      if (record.type === "integer" || record.type === "number") {
        return "1";
      }
      if (record.type === "boolean") {
        return "true";
      }
      if (record.type === "array" && record.items !== undefined) {
        return normalizeScalarSample(name, record.items);
      }
      if (record.type === "string") {
        return `${name}_sample`;
      }
    }
    return `${name}_sample`;
  }

  function inferOpenApiParameterValue(parameter: Record<string, unknown>): string {
    const name = typeof parameter.name === "string" ? parameter.name : "param";
    if (parameter.example !== undefined) {
      return normalizeScalarSample(name, parameter.example) ?? `${name}_sample`;
    }
    const schema = safeRecord(parameter.schema);
    if (schema.example !== undefined) {
      return normalizeScalarSample(name, schema.example) ?? `${name}_sample`;
    }
    if (schema.default !== undefined) {
      return normalizeScalarSample(name, schema.default) ?? `${name}_sample`;
    }
    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
      return normalizeScalarSample(name, schema.enum[0]) ?? `${name}_sample`;
    }
    return normalizeScalarSample(name, schema) ?? `${name}_sample`;
  }

  function normalizeHeaderRecord(input: unknown): Record<string, string> {
    const source = safeRecord(input);
    const next: Record<string, string> = {};
    Object.entries(source).forEach(([key, value]) => {
      if (value === null || value === undefined) {
        return;
      }
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        next[key] = String(value);
      }
    });
    return next;
  }

  function normalizeQueryRecord(input: unknown): Record<string, unknown> {
    const source = safeRecord(input);
    const next: Record<string, unknown> = {};
    Object.entries(source).forEach(([key, value]) => {
      if (value !== undefined) {
        next[key] = value;
      }
    });
    return next;
  }

  function pickEndpointFromRecord(record: Record<string, unknown>): ApiEndpointTemplate | null {
    const directMethod = normalizeMethod(record.method);
    const directPath = normalizePath(record.path ?? record.url ?? record.endpoint);
    if (directMethod && directPath) {
      return {
        method: directMethod,
        path: directPath,
        headers: normalizeHeaderRecord(record.headers),
        query: normalizeQueryRecord(record.query),
      };
    }

    const requestRecord = safeRecord(record.request);
    const nestedMethod = normalizeMethod(requestRecord.method);
    const nestedPath = normalizePath(requestRecord.path ?? requestRecord.url ?? requestRecord.endpoint);
    if (nestedMethod && nestedPath) {
      return {
        method: nestedMethod,
        path: nestedPath,
        headers: normalizeHeaderRecord(requestRecord.headers),
        query: normalizeQueryRecord(requestRecord.query),
      };
    }
    return null;
  }

  function pickEndpointFromList(items: unknown[]): ApiEndpointTemplate | null {
    for (const item of items) {
      const endpoint = pickEndpointFromRecord(safeRecord(item));
      if (endpoint) {
        return endpoint;
      }
    }
    return null;
  }

  function pickEndpointFromOpenApi(record: Record<string, unknown>): ApiEndpointTemplate | null {
    const paths = safeRecord(record.paths);
    const firstPath = Object.keys(paths)[0];
    if (!firstPath) {
      return null;
    }
    const pathRecord = safeRecord(paths[firstPath]);
    const pathLevelParameters = Array.isArray(pathRecord.parameters) ? pathRecord.parameters : [];
    for (const method of allowedMethods) {
      const operation = safeRecord(pathRecord[method.toLowerCase()]);
      if (Object.keys(operation).length === 0) {
        continue;
      }
      const operationParameters = Array.isArray(operation.parameters) ? operation.parameters : [];
      const allParameters = [...pathLevelParameters, ...operationParameters].map((item) => safeRecord(item));

      const headers: Record<string, string> = {};
      const query: Record<string, unknown> = {};
      const pathParams: Record<string, string> = {};

      allParameters.forEach((parameter) => {
        const name = typeof parameter.name === "string" ? parameter.name : "";
        const location = typeof parameter.in === "string" ? parameter.in : "";
        if (!name || !location) {
          return;
        }
        const sampleValue = inferOpenApiParameterValue(parameter);
        if (location === "header") {
          headers[name] = sampleValue;
          return;
        }
        if (location === "query") {
          query[name] = sampleValue;
          return;
        }
        if (location === "path") {
          pathParams[name] = sampleValue;
        }
      });

      const resolvedPath = firstPath.replace(/\{([^}]+)\}/g, (_matched, key: string) =>
        encodeURIComponent(pathParams[key] ?? `${key}_sample`)
      );

      return { method, path: resolvedPath, headers, query };
    }
    return null;
  }

  const jsonContent = safeRecord(apiDoc.content_json);
  const directFromJson = pickEndpointFromRecord(jsonContent);
  if (directFromJson) {
    return directFromJson;
  }
  const openApiFromJson = pickEndpointFromOpenApi(jsonContent);
  if (openApiFromJson) {
    return openApiFromJson;
  }
  const jsonItems = Array.isArray(jsonContent.items) ? jsonContent.items : [];
  const fromJsonItems = pickEndpointFromList(jsonItems);
  if (fromJsonItems) {
    return fromJsonItems;
  }

  const textContent = typeof apiDoc.content_text === "string" ? apiDoc.content_text.trim() : "";
  if (!textContent) {
    return null;
  }

  try {
    const parsed = JSON.parse(textContent);
    if (Array.isArray(parsed)) {
      const fromArray = pickEndpointFromList(parsed);
      if (fromArray) {
        return fromArray;
      }
    }
    const parsedRecord = safeRecord(parsed);
    const directFromParsed = pickEndpointFromRecord(parsedRecord);
    if (directFromParsed) {
      return directFromParsed;
    }
    const openApiFromParsed = pickEndpointFromOpenApi(parsedRecord);
    if (openApiFromParsed) {
      return openApiFromParsed;
    }
    const parsedItems = Array.isArray(parsedRecord.items) ? parsedRecord.items : [];
    const fromParsedItems = pickEndpointFromList(parsedItems);
    if (fromParsedItems) {
      return fromParsedItems;
    }
  } catch {
    const matched = textContent.match(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s"']+)/i);
    if (matched) {
      const method = normalizeMethod(matched[1]);
      const path = normalizePath(matched[2]);
      if (method && path) {
        return { method, path, headers: {}, query: {} };
      }
    }
  }

  return null;
}

function scenarioPoolForCoverage(coverage: string): ApiCaseScenario[] {
  if (coverage === "normal") {
    return apiScenarioLibrary.filter((item) => item.scenarioType === "normal");
  }
  if (coverage === "boundary") {
    return apiScenarioLibrary.filter((item) => item.scenarioType === "boundary");
  }
  if (coverage === "exception") {
    return apiScenarioLibrary.filter((item) => item.scenarioType === "validation" || item.scenarioType === "auth");
  }
  return apiScenarioLibrary;
}

export function GenerationDataCenter() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const neutralButtonClass = "console-btn";
  const dangerButtonClass = "console-btn-danger";
  const tabClass = "console-tab rounded-full px-4 py-2 text-sm font-semibold";
  const tabActiveClass = "console-tab console-tab-active rounded-full px-4 py-2 text-sm font-semibold";
  const compactActionButtonClass = `${neutralButtonClass} min-h-[30px] px-2.5 py-1 text-xs font-semibold`;
  const compactDangerButtonClass = `${dangerButtonClass} min-h-[30px] px-2.5 py-1 text-xs font-semibold`;

  const [tab, setTab] = useState<GenerationTab>(() => parseTab(searchParams.get("tab")));
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [projectTableItems, setProjectTableItems] = useState<ProjectRecord[]>([]);
  const [projectTablePage, setProjectTablePage] = useState(1);
  const [projectTableTotal, setProjectTableTotal] = useState(0);
  const [projectTableTotalPages, setProjectTableTotalPages] = useState(1);
  const [suites, setSuites] = useState<SuiteRecord[]>([]);
  const [suiteTableItems, setSuiteTableItems] = useState<SuiteRecord[]>([]);
  const [suiteTablePage, setSuiteTablePage] = useState(1);
  const [suiteTableTotal, setSuiteTableTotal] = useState(0);
  const [suiteTableTotalPages, setSuiteTableTotalPages] = useState(1);
  const [datasets, setDatasets] = useState<DatasetRecord[]>([]);
  const [prdAgentDocs, setPrdAgentDocs] = useState<UserAssetRecord[]>([]);
  const [apiDocs, setApiDocs] = useState<UserAssetRecord[]>([]);
  const [apiBatchHistory, setApiBatchHistory] = useState<UserAssetRecord[]>([]);
  const [apiBatchPage, setApiBatchPage] = useState(1);
  const [apiBatchTotal, setApiBatchTotal] = useState(0);
  const [apiBatchTotalPages, setApiBatchTotalPages] = useState(1);
  const [agentBatchHistory, setAgentBatchHistory] = useState<UserAssetRecord[]>([]);
  const [agentBatchPage, setAgentBatchPage] = useState(1);
  const [agentBatchTotal, setAgentBatchTotal] = useState(0);
  const [agentBatchTotalPages, setAgentBatchTotalPages] = useState(1);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(() => parseMaybeNumber(searchParams.get("projectId")));
  const [selectedSuiteId, setSelectedSuiteId] = useState<number | null>(() => parseMaybeNumber(searchParams.get("suiteId")));
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [apiGenerating, setApiGenerating] = useState(false);
  const [apiLoadingTick, setApiLoadingTick] = useState(0);
  const [notice, setNotice] = useState<{ tone: NoticeTone; text: string } | null>(null);
  const [agentDatasetInputTab, setAgentDatasetInputTab] = useState<AgentDatasetInputTab>("generate_agent");
  const [selectedImportDatasetId, setSelectedImportDatasetId] = useState<number | null>(null);
  const [datasetImportFile, setDatasetImportFile] = useState<File | null>(null);
  const [datasetImportInputKey, setDatasetImportInputKey] = useState(0);
  const [datasetImporting, setDatasetImporting] = useState(false);
  const [selectedBenchmarkApiDocId, setSelectedBenchmarkApiDocId] = useState("");
  const [datasetToApiGenerating, setDatasetToApiGenerating] = useState(false);

  const [projectForm, setProjectForm] = useState({
    name: "",
    projectType: "hybrid",
    description: "",
  });
  const [projectEditId, setProjectEditId] = useState<number | null>(null);
  const [projectEditForm, setProjectEditForm] = useState({
    name: "",
    projectType: "hybrid",
    description: "",
    status: "active",
  });

  const [suiteForm, setSuiteForm] = useState({
    name: "",
    suiteType: "api",
    description: "",
  });
  const [suiteEditId, setSuiteEditId] = useState<number | null>(null);
  const [suiteEditForm, setSuiteEditForm] = useState({
    name: "",
    suiteType: "api",
    description: "",
    status: "active",
  });

  const [apiGenForm, setApiGenForm] = useState({
    prdDocId: "",
    apiDocId: "",
    count: 5,
    coverage: "mixed",
    featureDesc: "",
  });

  const [agentGenForm, setAgentGenForm] = useState({
    sourceDocId: "",
    includeApiDoc: false,
    apiDocId: "",
    count: 10,
    withReference: true,
    dimensions: {
      single_turn: true,
      multi_turn: false,
      tool_calling: false,
      open_task: false,
    },
  });

  const [historyDetail, setHistoryDetail] = useState<UserAssetRecord | null>(null);

  const selectedProject = useMemo(
    () => projects.find((item) => item.id === selectedProjectId) ?? null,
    [projects, selectedProjectId]
  );

  const selectedSuite = useMemo(
    () => suites.find((item) => item.id === selectedSuiteId) ?? null,
    [suites, selectedSuiteId]
  );

  const benchmarkDatasets = useMemo(
    () => datasets.filter((item) => isUserUploadedBenchmarkDataset(item)),
    [datasets]
  );

  const selectedImportDataset = useMemo(
    () => benchmarkDatasets.find((item) => item.id === selectedImportDatasetId) ?? null,
    [benchmarkDatasets, selectedImportDatasetId]
  );

  useEffect(() => {
    setSelectedImportDatasetId((prev) =>
      prev && benchmarkDatasets.some((item) => item.id === prev) ? prev : benchmarkDatasets[0]?.id ?? null
    );
  }, [benchmarkDatasets]);

  useEffect(() => {
    setSelectedBenchmarkApiDocId((prev) =>
      prev && apiDocs.some((item) => String(item.id) === prev) ? prev : apiDocs[0]?.id ? String(apiDocs[0].id) : ""
    );
  }, [apiDocs]);

  async function refreshProjectTable(page = projectTablePage) {
    const data = await listProjectsPaged({ page, pageSize: TABLE_PAGE_SIZE, order: "asc" });
    const totalPages = data.totalPages ?? Math.max(1, Math.ceil(data.total / TABLE_PAGE_SIZE));
    if (page > totalPages) {
      setProjectTablePage(totalPages);
      return;
    }
    setProjectTableItems(data.items);
    setProjectTableTotal(data.total);
    setProjectTableTotalPages(totalPages);
  }

  async function refreshSuiteTable(projectId: number, page = suiteTablePage) {
    const data = await listSuitesPaged(projectId, { page, pageSize: TABLE_PAGE_SIZE, order: "asc" });
    const totalPages = data.totalPages ?? Math.max(1, Math.ceil(data.total / TABLE_PAGE_SIZE));
    if (page > totalPages) {
      setSuiteTablePage(totalPages);
      return;
    }
    setSuiteTableItems(data.items);
    setSuiteTableTotal(data.total);
    setSuiteTableTotalPages(totalPages);
  }

  async function refreshApiBatchTable(projectId: number, page = apiBatchPage) {
    const data = await listUserAssetsPaged({
      projectId,
      assetType: "api_case_generation_batch",
      status: "active",
      page,
      pageSize: TABLE_PAGE_SIZE,
      order: "desc",
    });
    const totalPages = data.totalPages ?? Math.max(1, Math.ceil(data.total / TABLE_PAGE_SIZE));
    if (page > totalPages) {
      setApiBatchPage(totalPages);
      return;
    }
    setApiBatchHistory(data.items);
    setApiBatchTotal(data.total);
    setApiBatchTotalPages(totalPages);
  }

  async function refreshAgentBatchTable(projectId: number, page = agentBatchPage) {
    const data = await listUserAssetsPaged({
      projectId,
      assetType: "agent_dataset_generation_batch",
      status: "active",
      page,
      pageSize: TABLE_PAGE_SIZE,
      order: "desc",
    });
    const totalPages = data.totalPages ?? Math.max(1, Math.ceil(data.total / TABLE_PAGE_SIZE));
    if (page > totalPages) {
      setAgentBatchPage(totalPages);
      return;
    }
    setAgentBatchHistory(data.items);
    setAgentBatchTotal(data.total);
    setAgentBatchTotalPages(totalPages);
  }

  async function refreshProjectScopedData(
    projectId: number,
    options?: { suitePage?: number; apiBatchPage?: number; agentBatchPage?: number }
  ) {
    const [suiteData, prdDocs, apiDocAssets, datasetItems] = await Promise.all([
      listSuites(projectId),
      listUserAssets(projectId, undefined, "prd_agent_doc", "active"),
      listUserAssets(projectId, undefined, "api_doc", "active"),
      listDatasets(projectId),
    ]);
    setSuites(suiteData);
    setPrdAgentDocs(prdDocs);
    setApiDocs(apiDocAssets);
    setDatasets(datasetItems);
    setSelectedSuiteId((prev) => {
      if (prev === null) {
        return null;
      }
      return suiteData.some((item) => item.id === prev) ? prev : null;
    });
    await Promise.all([
      refreshSuiteTable(projectId, options?.suitePage ?? suiteTablePage),
      refreshApiBatchTable(projectId, options?.apiBatchPage ?? apiBatchPage),
      refreshAgentBatchTable(projectId, options?.agentBatchPage ?? agentBatchPage),
    ]);
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
        await refreshProjectScopedData(resolvedProjectId, { suitePage: 1, apiBatchPage: 1, agentBatchPage: 1 });
      } else {
        setSuites([]);
        setSuiteTableItems([]);
        setSuiteTableTotal(0);
        setSuiteTableTotalPages(1);
        setDatasets([]);
        setPrdAgentDocs([]);
        setApiDocs([]);
        setApiBatchHistory([]);
        setApiBatchTotal(0);
        setApiBatchTotalPages(1);
        setAgentBatchHistory([]);
        setAgentBatchTotal(0);
        setAgentBatchTotalPages(1);
      }
      await refreshProjectTable();
      setNotice(null);
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "加载生成数据集页面失败",
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
    void refreshProjectTable();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectTablePage]);

  useEffect(() => {
    if (!selectedProjectId) {
      setSuites([]);
      setSuiteTableItems([]);
      setSuiteTableTotal(0);
      setSuiteTableTotalPages(1);
      setDatasets([]);
      setPrdAgentDocs([]);
      setApiDocs([]);
      setApiBatchHistory([]);
      setApiBatchTotal(0);
      setApiBatchTotalPages(1);
      setAgentBatchHistory([]);
      setAgentBatchTotal(0);
      setAgentBatchTotalPages(1);
      return;
    }
    setSuiteTablePage(1);
    setApiBatchPage(1);
    setAgentBatchPage(1);
    setLoading(true);
    void refreshProjectScopedData(selectedProjectId, { suitePage: 1, apiBatchPage: 1, agentBatchPage: 1 })
      .catch((error: unknown) => {
        setNotice({
          tone: "error",
          text: error instanceof Error ? error.message : "加载项目生成上下文失败",
        });
      })
      .finally(() => setLoading(false));
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }
    void refreshSuiteTable(selectedProjectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId, suiteTablePage]);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }
    void refreshApiBatchTable(selectedProjectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId, apiBatchPage]);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }
    void refreshAgentBatchTable(selectedProjectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId, agentBatchPage]);

  useEffect(() => {
    const next = new URLSearchParams();
    next.set("tab", tab);
    if (selectedProjectId) {
      next.set("projectId", String(selectedProjectId));
    }
    if (selectedSuiteId) {
      next.set("suiteId", String(selectedSuiteId));
    }
    setSearchParams(next, { replace: true });
  }, [tab, selectedProjectId, selectedSuiteId, setSearchParams]);

  useEffect(() => {
    if (!apiGenerating) {
      setApiLoadingTick(0);
      return;
    }
    const timer = window.setInterval(() => {
      setApiLoadingTick((prev) => (prev + 1) % 4);
    }, 320);
    return () => window.clearInterval(timer);
  }, [apiGenerating]);

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
      setProjectForm({
        name: "",
        projectType: "hybrid",
        description: "",
      });
      setSelectedProjectId(created.id);
      await loadInitialData();
      setNotice({ tone: "success", text: `项目创建成功：${created.name}` });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "创建项目失败",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onSaveProjectEdit() {
    if (!projectEditId) {
      return;
    }
    if (!projectEditForm.name.trim()) {
      setNotice({ tone: "error", text: "项目名称不能为空" });
      return;
    }
    setBusy(true);
    try {
      await updateProject(projectEditId, {
        name: projectEditForm.name.trim(),
        projectType: projectEditForm.projectType,
        description: projectEditForm.description.trim() || undefined,
        status: projectEditForm.status,
      });
      setProjectEditId(null);
      await loadInitialData();
      setNotice({ tone: "success", text: "项目更新成功" });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "更新项目失败",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onArchiveProject(projectId: number) {
    setBusy(true);
    try {
      await archiveProject(projectId);
      await loadInitialData();
      setNotice({ tone: "success", text: `项目 ${projectId} 已归档` });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "归档项目失败",
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
      setNotice({ tone: "error", text: "Suite 名称不能为空" });
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
      await refreshProjectScopedData(selectedProjectId);
      setNotice({ tone: "success", text: `Suite 创建成功：${created.name}` });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "创建 Suite 失败",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onSaveSuiteEdit() {
    if (!suiteEditId) {
      return;
    }
    if (!suiteEditForm.name.trim()) {
      setNotice({ tone: "error", text: "Suite 名称不能为空" });
      return;
    }
    setBusy(true);
    try {
      await updateSuite(suiteEditId, {
        name: suiteEditForm.name.trim(),
        suiteType: suiteEditForm.suiteType,
        description: suiteEditForm.description.trim() || undefined,
        status: suiteEditForm.status,
      });
      setSuiteEditId(null);
      if (selectedProjectId) {
        await refreshProjectScopedData(selectedProjectId);
      }
      setNotice({ tone: "success", text: "Suite 更新成功" });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "更新 Suite 失败",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteSuite(suiteId: number) {
    if (!selectedProjectId) {
      return;
    }
    setBusy(true);
    try {
      await deleteSuite(suiteId);
      await refreshProjectScopedData(selectedProjectId);
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

  async function onGenerateApiCases(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProjectId || !selectedSuiteId) {
      setNotice({ tone: "error", text: "请先选择项目和 Suite" });
      return;
    }
    if (!apiGenForm.prdDocId) {
      setNotice({ tone: "error", text: "请先选择 PRD 文档" });
      return;
    }
    const count = Math.max(1, Math.min(50, apiGenForm.count));
    const prdDoc = prdAgentDocs.find((item) => item.id === Number(apiGenForm.prdDocId));
    const hasApiDoc = Boolean(apiGenForm.apiDocId);
    const apiDoc = hasApiDoc ? apiDocs.find((item) => item.id === Number(apiGenForm.apiDocId)) : null;
    if (!prdDoc || (hasApiDoc && !apiDoc)) {
      setNotice({ tone: "error", text: "所选文档不存在，请刷新后重试" });
      return;
    }

    setBusy(true);
    setApiGenerating(true);
    try {
      const generation = await generateApiCases({
        projectId: selectedProjectId,
        suiteId: selectedSuiteId,
        prdDocAssetId: Number(apiGenForm.prdDocId),
        apiDocAssetId: apiGenForm.apiDocId ? Number(apiGenForm.apiDocId) : undefined,
        count,
        coverage: apiGenForm.coverage,
        featureDesc: apiGenForm.featureDesc.trim() || undefined,
        model: "kimi-k2.5",
      });

      await refreshProjectScopedData(selectedProjectId);
      setNotice({
        tone: "success",
        text: `API 案例生成完成，共 ${generation.generated_count} 条（批次 ${generation.batch_id}）`,
      });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "生成 API 案例失败",
      });
    } finally {
      setApiGenerating(false);
      setBusy(false);
    }
  }

  async function onGenerateAgentDataset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProjectId || !selectedSuiteId) {
      setNotice({ tone: "error", text: "请先选择项目和 Suite" });
      return;
    }
    if (!agentGenForm.sourceDocId) {
      setNotice({ tone: "error", text: "请先选择 PRD / Agent 信息文档" });
      return;
    }
    const count = Math.max(1, Math.min(100, agentGenForm.count));
    const withReference = agentGenForm.withReference;
    const sourceDoc = prdAgentDocs.find((item) => item.id === Number(agentGenForm.sourceDocId));
    if (!sourceDoc) {
      setNotice({ tone: "error", text: "所选文档不存在，请刷新后重试" });
      return;
    }
    if (agentGenForm.includeApiDoc && !agentGenForm.apiDocId) {
      setNotice({ tone: "error", text: "已选择带 API 文档，请选择 API 文档" });
      return;
    }
    const dimensions = Object.entries(agentGenForm.dimensions)
      .filter(([, enabled]) => enabled)
      .map(([name]) => name);

    setBusy(true);
    try {
      const generation = await generateAgentDataset({
        projectId: selectedProjectId,
        suiteId: selectedSuiteId,
        sourceDocAssetId: Number(agentGenForm.sourceDocId),
        apiDocAssetId: agentGenForm.includeApiDoc && agentGenForm.apiDocId ? Number(agentGenForm.apiDocId) : undefined,
        count,
        withReference,
        dimensions,
        model: "kimi-k2.5",
      });

      await refreshProjectScopedData(selectedProjectId);
      const apiGeneratedCount = Number(generation.api_generated_count ?? 0);
      setNotice({
        tone: "success",
        text:
          apiGeneratedCount > 0
            ? `Agent 数据集生成完成 ${generation.generated_count} 条，同时生成 API Suite 案例 ${apiGeneratedCount} 条（批次 ${generation.batch_id}）`
            : `Agent 数据集生成完成，共 ${generation.generated_count} 条（批次 ${generation.batch_id}）`,
      });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "生成 Agent 数据集失败",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteHistoryBatch(assetId: number) {
    if (!selectedProjectId) {
      return;
    }
    setBusy(true);
    try {
      await deleteUserAsset(assetId);
      await refreshProjectScopedData(selectedProjectId);
      setNotice({ tone: "success", text: `批次 ${assetId} 已删除` });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "删除批次失败",
      });
    } finally {
      setBusy(false);
    }
  }

  function onDownloadBenchmarkTemplate() {
    downloadTextFile("benchmark-dataset-template.csv", buildBenchmarkTemplateCsv(), "text/csv;charset=utf-8");
    setNotice({ tone: "success", text: "Benchmark 表头模板已开始下载" });
  }

  async function onImportDatasetByCsv(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProjectId) {
      setNotice({ tone: "error", text: "请先选择项目" });
      return;
    }
    if (!selectedImportDatasetId) {
      setNotice({ tone: "error", text: "请先选择目标数据集" });
      return;
    }
    if (!datasetImportFile) {
      setNotice({ tone: "error", text: "请先选择待上传文件" });
      return;
    }
    const lowerFileName = datasetImportFile.name.toLowerCase();
    if (lowerFileName.endsWith(".xlsx") || lowerFileName.endsWith(".xls")) {
      setNotice({ tone: "error", text: "暂不支持直接上传 xlsx/xls，请先另存为 UTF-8 CSV" });
      return;
    }

    setBusy(true);
    setDatasetImporting(true);
    try {
      const text = await datasetImportFile.text();
      const items = parseDatasetItemsFromTabular(text);
      const imported = await importDatasetItems(selectedImportDatasetId, items);
      await refreshProjectScopedData(selectedProjectId);
      setDatasetImportFile(null);
      setDatasetImportInputKey((prev) => prev + 1);
      setNotice({
        tone: "success",
        text: `导入完成：已写入 ${imported.total} 条数据到数据集 ${selectedImportDataset?.name ?? selectedImportDatasetId}`,
      });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "导入 Benchmark 表格失败",
      });
    } finally {
      setDatasetImporting(false);
      setBusy(false);
    }
  }

  async function onGenerateApiCasesFromBenchmarkDataset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProjectId || !selectedSuiteId) {
      setNotice({ tone: "error", text: "请先选择项目和 Suite" });
      return;
    }
    if (!selectedImportDatasetId) {
      setNotice({ tone: "error", text: "请先选择 Benchmark 数据集" });
      return;
    }
    if (!selectedBenchmarkApiDocId) {
      setNotice({ tone: "error", text: "请先选择 API 文档" });
      return;
    }

    setBusy(true);
    setDatasetToApiGenerating(true);
    try {
      const result = await generateApiCasesFromBenchmarkDataset({
        projectId: selectedProjectId,
        suiteId: selectedSuiteId,
        datasetId: selectedImportDatasetId,
        apiDocAssetId: Number(selectedBenchmarkApiDocId),
        model: "kimi-k2.5",
      });
      await refreshProjectScopedData(selectedProjectId);
      setNotice({
        tone: "success",
        text: `已根据 Benchmark 数据集生成 ${result.generated_count} 条 API 案例（源数据 ${result.source_item_count} 条，批次 ${result.batch_id}）`,
      });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "根据 Benchmark 数据集生成 API 案例失败",
      });
    } finally {
      setDatasetToApiGenerating(false);
      setBusy(false);
    }
  }

  return (
    <section className="generation-page grid gap-4">
      <FloatingNotice notice={notice} onClose={() => setNotice(null)} />
      <header className="grid gap-2">
        <h2 className="page-title m-0">生成数据集</h2>
      </header>

      <div style={{ ...panelStyle, display: "grid", gap: 10 }} className="console-panel grid gap-3 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <strong>上下文筛选</strong>
          <div className="flex flex-wrap items-center gap-2.5">
            <Link to="/assets" className="text-sm font-semibold text-primary hover:text-primary/80">
              去文档管理
            </Link>
            <button
              type="button"
              onClick={() => void loadInitialData()}
              disabled={loading || busy}
              className={`${neutralButtonClass} px-3 py-1.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60`}
            >
              {loading ? "刷新中..." : "刷新页面"}
            </button>
          </div>
        </div>

        <div className="grid gap-2 md:grid-cols-2">
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
        </div>
      </div>

      <div style={{ ...panelStyle, display: "grid", gap: 10 }} className="console-panel grid gap-3 p-5">
        <div className="flex flex-wrap gap-2">
          {tabOptions.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setTab(item.key)}
              className={item.key === tab ? tabActiveClass : tabClass}
            >
              {item.label}
            </button>
          ))}
        </div>

        {tab === "project_mgmt" ? (
          <div style={{ display: "grid", gap: 12 }}>
            <form onSubmit={(event) => void onCreateProject(event)} style={{ borderRadius: 14, border: "1px solid rgba(31,37,39,0.08)", padding: 12, display: "grid", gridTemplateColumns: "1fr 180px 1fr auto", gap: 8 }}>
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
                placeholder="描述"
                disabled={busy}
                style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
              />
              <button
                type="submit"
                disabled={busy}
                style={{ border: "none", borderRadius: 10, padding: "9px 12px", background: "#1f2527", color: "#fff8eb", fontWeight: 700, cursor: "pointer" }}
              >
                创建项目
              </button>
            </form>

            <div className="overflow-x-auto">
              <table className="data-table min-w-[1080px]" style={{ minWidth: 1260, tableLayout: "fixed" }}>
                <colgroup>
                  <col style={{ width: 96 }} />
                  <col style={{ width: 180 }} />
                  <col style={{ width: 100 }} />
                  <col style={{ width: 280 }} />
                  <col style={{ width: 100 }} />
                  <col style={{ width: 220 }} />
                  <col style={{ width: 180 }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>项目 ID</th>
                    <th>项目名称</th>
                    <th>类型</th>
                    <th>描述</th>
                    <th>状态</th>
                    <th>更新时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {projectTableItems.map((project) => (
                    <tr key={project.id} style={{ borderBottom: "1px solid rgba(31,37,39,0.08)" }}>
                      <td style={{ padding: "9px 8px", fontWeight: 700 }}>{project.id}</td>
                      <td style={{ padding: "9px 8px" }}>
                        {projectEditId === project.id ? (
                          <input
                            value={projectEditForm.name}
                            onChange={(event) => setProjectEditForm((prev) => ({ ...prev, name: event.target.value }))}
                            style={{ borderRadius: 8, border: "1px solid rgba(31,37,39,0.16)", padding: "6px 8px", width: "100%" }}
                          />
                        ) : (
                          <span
                            title={project.name}
                            style={{
                              display: "block",
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                          >
                            {project.name}
                          </span>
                        )}
                      </td>
                      <td style={{ padding: "9px 8px" }}>
                        {projectEditId === project.id ? (
                          <select
                            value={projectEditForm.projectType}
                            onChange={(event) => setProjectEditForm((prev) => ({ ...prev, projectType: event.target.value }))}
                            style={{ borderRadius: 8, border: "1px solid rgba(31,37,39,0.16)", padding: "6px 8px", width: "100%" }}
                          >
                            <option value="hybrid">hybrid</option>
                            <option value="api">api</option>
                            <option value="agent">agent</option>
                          </select>
                        ) : (
                          project.project_type
                        )}
                      </td>
                      <td style={{ padding: "9px 8px" }}>
                        {projectEditId === project.id ? (
                          <input
                            value={projectEditForm.description}
                            onChange={(event) => setProjectEditForm((prev) => ({ ...prev, description: event.target.value }))}
                            style={{ borderRadius: 8, border: "1px solid rgba(31,37,39,0.16)", padding: "6px 8px", width: "100%" }}
                          />
                        ) : (
                          <span
                            title={project.description ?? "-"}
                            style={{
                              display: "block",
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                          >
                            {project.description ?? "-"}
                          </span>
                        )}
                      </td>
                      <td style={{ padding: "9px 8px" }}>
                        {projectEditId === project.id ? (
                          <select
                            value={projectEditForm.status}
                            onChange={(event) => setProjectEditForm((prev) => ({ ...prev, status: event.target.value }))}
                            style={{ borderRadius: 8, border: "1px solid rgba(31,37,39,0.16)", padding: "6px 8px", width: "100%" }}
                          >
                            <option value="active">active</option>
                            <option value="archived">archived</option>
                          </select>
                        ) : (
                          project.status
                        )}
                      </td>
                      <td style={{ padding: "9px 8px" }}>{(project as { updated_at?: string }).updated_at ?? "-"}</td>
                      <td style={{ padding: "9px 8px", display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {projectEditId === project.id ? (
                          <>
                            <button
                              type="button"
                              onClick={() => void onSaveProjectEdit()}
                              disabled={busy}
                              className={`${compactActionButtonClass} disabled:cursor-not-allowed disabled:opacity-60`}
                            >
                              保存
                            </button>
                            <button
                              type="button"
                              onClick={() => setProjectEditId(null)}
                              className={compactActionButtonClass}
                            >
                              取消
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => {
                                setProjectEditId(project.id);
                                setProjectEditForm({
                                  name: project.name,
                                  projectType: project.project_type,
                                  description: project.description ?? "",
                                  status: project.status,
                                });
                              }}
                              className={compactActionButtonClass}
                            >
                              编辑
                            </button>
                            <button
                              type="button"
                              onClick={() => void onArchiveProject(project.id)}
                              className={compactDangerButtonClass}
                            >
                              删除/归档
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>
                第 {projectTablePage} / {projectTableTotalPages} 页 · 共 {projectTableTotal} 条 · 每页 {TABLE_PAGE_SIZE} 条
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setProjectTablePage((prev) => Math.max(1, prev - 1))}
                  disabled={loading || busy || projectTablePage <= 1}
                  className={`${compactActionButtonClass} disabled:cursor-not-allowed disabled:opacity-60`}
                >
                  上一页
                </button>
                <button
                  type="button"
                  onClick={() => setProjectTablePage((prev) => Math.min(projectTableTotalPages, prev + 1))}
                  disabled={loading || busy || projectTablePage >= projectTableTotalPages}
                  className={`${compactActionButtonClass} disabled:cursor-not-allowed disabled:opacity-60`}
                >
                  下一页
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {tab === "suite_mgmt" ? (
          <div style={{ display: "grid", gap: 12 }}>
            <form onSubmit={(event) => void onCreateSuite(event)} style={{ borderRadius: 14, border: "1px solid rgba(31,37,39,0.08)", padding: 12, display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 8 }}>
              <input
                value={suiteForm.name}
                onChange={(event) => setSuiteForm((prev) => ({ ...prev, name: event.target.value }))}
                placeholder="Suite 名称"
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
              <input
                value={suiteForm.description}
                onChange={(event) => setSuiteForm((prev) => ({ ...prev, description: event.target.value }))}
                placeholder="描述"
                disabled={busy || !selectedProjectId}
                style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
              />
              <button
                type="submit"
                disabled={busy || !selectedProjectId}
                style={{ border: "none", borderRadius: 10, padding: "9px 12px", background: "#1f2527", color: "#fff8eb", fontWeight: 700, cursor: "pointer" }}
              >
                创建 Suite
              </button>
            </form>

            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1080 }}>
                <thead>
                  <tr style={{ textAlign: "left", borderBottom: "1px solid rgba(31,37,39,0.12)" }}>
                    <th style={{ padding: "9px 8px" }}>Suite ID</th>
                    <th style={{ padding: "9px 8px" }}>Suite 名称</th>
                    <th style={{ padding: "9px 8px" }}>所属项目</th>
                    <th style={{ padding: "9px 8px" }}>类型</th>
                    <th style={{ padding: "9px 8px" }}>状态</th>
                    <th style={{ padding: "9px 8px" }}>更新时间</th>
                    <th style={{ padding: "9px 8px" }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {suiteTableItems.map((suite) => (
                    <tr key={suite.id} style={{ borderBottom: "1px solid rgba(31,37,39,0.08)" }}>
                      <td style={{ padding: "9px 8px", fontWeight: 700 }}>{suite.id}</td>
                      <td style={{ padding: "9px 8px" }}>
                        {suiteEditId === suite.id ? (
                          <input
                            value={suiteEditForm.name}
                            onChange={(event) => setSuiteEditForm((prev) => ({ ...prev, name: event.target.value }))}
                            style={{ borderRadius: 8, border: "1px solid rgba(31,37,39,0.16)", padding: "6px 8px", width: "100%" }}
                          />
                        ) : (
                          suite.name
                        )}
                      </td>
                      <td style={{ padding: "9px 8px" }}>{selectedProject?.name ?? suite.project_id}</td>
                      <td style={{ padding: "9px 8px" }}>
                        {suiteEditId === suite.id ? (
                          <select
                            value={suiteEditForm.suiteType}
                            onChange={(event) => setSuiteEditForm((prev) => ({ ...prev, suiteType: event.target.value }))}
                            style={{ borderRadius: 8, border: "1px solid rgba(31,37,39,0.16)", padding: "6px 8px", width: "100%" }}
                          >
                            <option value="api">api</option>
                            <option value="agent_eval">agent_eval</option>
                            <option value="regression">regression</option>
                            <option value="smoke">smoke</option>
                            <option value="dataset">dataset</option>
                          </select>
                        ) : (
                          suite.suite_type
                        )}
                      </td>
                      <td style={{ padding: "9px 8px" }}>
                        {suiteEditId === suite.id ? (
                          <select
                            value={suiteEditForm.status}
                            onChange={(event) => setSuiteEditForm((prev) => ({ ...prev, status: event.target.value }))}
                            style={{ borderRadius: 8, border: "1px solid rgba(31,37,39,0.16)", padding: "6px 8px", width: "100%" }}
                          >
                            <option value="active">active</option>
                            <option value="archived">archived</option>
                          </select>
                        ) : (
                          suite.status
                        )}
                      </td>
                      <td style={{ padding: "9px 8px" }}>{(suite as { updated_at?: string }).updated_at ?? "-"}</td>
                      <td style={{ padding: "9px 8px", display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {suiteEditId === suite.id ? (
                          <>
                            <button
                              type="button"
                              onClick={() => void onSaveSuiteEdit()}
                              disabled={busy}
                              className={`${compactActionButtonClass} disabled:cursor-not-allowed disabled:opacity-60`}
                            >
                              保存
                            </button>
                            <button
                              type="button"
                              onClick={() => setSuiteEditId(null)}
                              className={compactActionButtonClass}
                            >
                              取消
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => {
                                setSuiteEditId(suite.id);
                                setSuiteEditForm({
                                  name: suite.name,
                                  suiteType: suite.suite_type,
                                  description: "",
                                  status: suite.status,
                                });
                              }}
                              className={compactActionButtonClass}
                            >
                              编辑
                            </button>
                            <button
                              type="button"
                              onClick={() => void onDeleteSuite(suite.id)}
                              className={compactDangerButtonClass}
                            >
                              删除
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>
                第 {suiteTablePage} / {suiteTableTotalPages} 页 · 共 {suiteTableTotal} 条 · 每页 {TABLE_PAGE_SIZE} 条
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSuiteTablePage((prev) => Math.max(1, prev - 1))}
                  disabled={loading || busy || suiteTablePage <= 1}
                  className={`${compactActionButtonClass} disabled:cursor-not-allowed disabled:opacity-60`}
                >
                  上一页
                </button>
                <button
                  type="button"
                  onClick={() => setSuiteTablePage((prev) => Math.min(suiteTableTotalPages, prev + 1))}
                  disabled={loading || busy || suiteTablePage >= suiteTableTotalPages}
                  className={`${compactActionButtonClass} disabled:cursor-not-allowed disabled:opacity-60`}
                >
                  下一页
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {tab === "generate_api_cases" ? (
          <div style={{ display: "grid", gap: 12 }}>
            <form onSubmit={(event) => void onGenerateApiCases(event)} style={{ borderRadius: 14, border: "1px solid rgba(31,37,39,0.08)", padding: 12, display: "grid", gap: 8 }}>
              <strong>生成 API 案例</strong>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 160px 160px", gap: 8 }}>
                <select
                  value={apiGenForm.prdDocId}
                  onChange={(event) => setApiGenForm((prev) => ({ ...prev, prdDocId: event.target.value }))}
                  disabled={busy || !selectedProjectId}
                  style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
                >
                  <option value="">选择 PRD 文档</option>
                  {prdAgentDocs.map((doc) => (
                    <option key={doc.id} value={doc.id}>
                      {doc.name}
                    </option>
                  ))}
                </select>
                <select
                  value={apiGenForm.apiDocId}
                  onChange={(event) => setApiGenForm((prev) => ({ ...prev, apiDocId: event.target.value }))}
                  disabled={busy || !selectedProjectId}
                  style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
                >
                  <option value="">选择 API 文档（可选）</option>
                  {apiDocs.map((doc) => (
                    <option key={doc.id} value={doc.id}>
                      {doc.name}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={apiGenForm.count}
                  onChange={(event) =>
                    setApiGenForm((prev) => ({
                      ...prev,
                      count: Number.isFinite(Number(event.target.value)) ? Number(event.target.value) : prev.count,
                    }))
                  }
                  disabled={busy || !selectedProjectId || !selectedSuiteId}
                  style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
                />
                <select
                  value={apiGenForm.coverage}
                  onChange={(event) => setApiGenForm((prev) => ({ ...prev, coverage: event.target.value }))}
                  disabled={busy || !selectedProjectId || !selectedSuiteId}
                  style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
                >
                  <option value="normal">正常</option>
                  <option value="boundary">边界</option>
                  <option value="exception">异常</option>
                  <option value="mixed">混合</option>
                </select>
              </div>
              <textarea
                value={apiGenForm.featureDesc}
                onChange={(event) => setApiGenForm((prev) => ({ ...prev, featureDesc: event.target.value }))}
                placeholder="功能点描述（可选）"
                rows={3}
                disabled={busy || !selectedProjectId || !selectedSuiteId}
                style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px", fontFamily: "inherit" }}
              />
              <button
                type="submit"
                disabled={busy || !selectedProjectId || !selectedSuiteId}
                style={{ border: "none", borderRadius: 10, padding: "9px 12px", background: "#1f2527", color: "#fff8eb", fontWeight: 700, cursor: "pointer" }}
              >
                {apiGenerating ? `生成中${".".repeat((apiLoadingTick % 3) + 1)}` : "生成 API 案例"}
              </button>
              {apiGenerating ? (
                <div style={{ color: "#5f6a6c", fontSize: 13 }}>
                  {apiGenForm.apiDocId
                    ? `正在解析 API 文档并调用模型生成中${".".repeat((apiLoadingTick % 3) + 1)}`
                    : `正在根据 PRD 文档调用模型生成中${".".repeat((apiLoadingTick % 3) + 1)}`}
                </div>
              ) : null}
            </form>

            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1180 }}>
                <thead>
                  <tr style={{ textAlign: "left", borderBottom: "1px solid rgba(31,37,39,0.12)" }}>
                    <th style={{ padding: "9px 8px" }}>批次 ID</th>
                    <th style={{ padding: "9px 8px" }}>项目</th>
                    <th style={{ padding: "9px 8px" }}>Suite</th>
                    <th style={{ padding: "9px 8px" }}>PRD 文档</th>
                    <th style={{ padding: "9px 8px" }}>API 文档</th>
                    <th style={{ padding: "9px 8px" }}>生成数量</th>
                    <th style={{ padding: "9px 8px" }}>状态</th>
                    <th style={{ padding: "9px 8px" }}>生成时间</th>
                    <th style={{ padding: "9px 8px" }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {apiBatchHistory.length === 0 ? (
                    <tr>
                      <td colSpan={9} style={{ padding: "12px 8px", color: "#687274" }}>
                        暂无 API 案例生成批次
                      </td>
                    </tr>
                  ) : (
                    apiBatchHistory.map((batch) => {
                      const content = (batch.content_json ?? {}) as Record<string, unknown>;
                      const prdName = prdAgentDocs.find((item) => item.id === Number(content.prd_doc_id))?.name;
                      const sourceLabel =
                        prdName ??
                        (String(content.source_type ?? "") === "benchmark_dataset"
                          ? `Benchmark 数据集#${String(content.dataset_id ?? "-")}`
                          : "-");
                      const apiName =
                        apiDocs.find((item) => item.id === Number(content.api_doc_id))?.name ??
                        (content.api_doc_id ? String(content.api_doc_id) : "-");
                      const suiteId = Number(content.suite_id);
                      return (
                        <tr key={batch.id} style={{ borderBottom: "1px solid rgba(31,37,39,0.08)" }}>
                          <td style={{ padding: "9px 8px", fontWeight: 700 }}>{String(content.batch_id ?? batch.id)}</td>
                          <td style={{ padding: "9px 8px" }}>{selectedProject?.name ?? "-"}</td>
                          <td style={{ padding: "9px 8px" }}>{suiteNameById(suites, Number.isFinite(suiteId) ? suiteId : null)}</td>
                          <td style={{ padding: "9px 8px" }}>{sourceLabel}</td>
                          <td style={{ padding: "9px 8px" }}>{String(apiName ?? "-")}</td>
                          <td style={{ padding: "9px 8px" }}>{String(content.generated_count ?? "-")}</td>
                          <td style={{ padding: "9px 8px" }}>{String(content.status ?? content.mode ?? "-")}</td>
                          <td style={{ padding: "9px 8px" }}>{batch.created_at ?? "-"}</td>
                          <td style={{ padding: "9px 8px", display: "flex", gap: 6, flexWrap: "wrap" }}>
                            <button
                              type="button"
                              onClick={() => setHistoryDetail(batch)}
                              className={compactActionButtonClass}
                            >
                              查看批次
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                navigate(
                                  `/assets?tab=api_suite_cases&projectId=${selectedProjectId ?? ""}&suiteId=${content.suite_id ?? ""}`
                                )
                              }
                              className={compactActionButtonClass}
                            >
                              查看 Suite 资产
                            </button>
                            <button
                              type="button"
                              onClick={() => void onDeleteHistoryBatch(batch.id)}
                              className={compactDangerButtonClass}
                            >
                              删除批次
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>
                第 {apiBatchPage} / {apiBatchTotalPages} 页 · 共 {apiBatchTotal} 条 · 每页 {TABLE_PAGE_SIZE} 条
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setApiBatchPage((prev) => Math.max(1, prev - 1))}
                  disabled={loading || busy || apiBatchPage <= 1}
                  className={`${compactActionButtonClass} disabled:cursor-not-allowed disabled:opacity-60`}
                >
                  上一页
                </button>
                <button
                  type="button"
                  onClick={() => setApiBatchPage((prev) => Math.min(apiBatchTotalPages, prev + 1))}
                  disabled={loading || busy || apiBatchPage >= apiBatchTotalPages}
                  className={`${compactActionButtonClass} disabled:cursor-not-allowed disabled:opacity-60`}
                >
                  下一页
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {tab === "generate_agent_dataset" ? (
          <div style={{ display: "grid", gap: 12 }}>
            <div style={{ display: "grid", gap: 10 }}>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setAgentDatasetInputTab("generate_agent")}
                  className={agentDatasetInputTab === "generate_agent" ? tabActiveClass : tabClass}
                >
                  生成 Agent 数据集
                </button>
                <button
                  type="button"
                  onClick={() => setAgentDatasetInputTab("upload_benchmark")}
                  className={agentDatasetInputTab === "upload_benchmark" ? tabActiveClass : tabClass}
                >
                  上传 Benchmark 数据集
                </button>
              </div>

              {agentDatasetInputTab === "generate_agent" ? (
                <div style={{ borderRadius: 14, border: "1px solid rgba(31,37,39,0.08)", padding: 12 }}>
                  <form onSubmit={(event) => void onGenerateAgentDataset(event)} style={{ display: "grid", gap: 8 }}>
                    <strong>生成 Agent 数据集</strong>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 120px 160px 160px 1fr", gap: 8 }}>
                      <select
                        value={agentGenForm.sourceDocId}
                        onChange={(event) => setAgentGenForm((prev) => ({ ...prev, sourceDocId: event.target.value }))}
                        disabled={busy || !selectedProjectId}
                        style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
                      >
                        <option value="">选择 PRD / Agent 信息文档</option>
                        {prdAgentDocs.map((doc) => (
                          <option key={doc.id} value={doc.id}>
                            {doc.name}
                          </option>
                        ))}
                      </select>
                      <input
                        type="number"
                        min={1}
                        max={100}
                        value={agentGenForm.count}
                        onChange={(event) =>
                          setAgentGenForm((prev) => ({
                            ...prev,
                            count: Number.isFinite(Number(event.target.value)) ? Number(event.target.value) : prev.count,
                          }))
                        }
                        disabled={busy || !selectedProjectId || !selectedSuiteId}
                        style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
                      />
                      <select
                        value={agentGenForm.withReference ? "yes" : "no"}
                        onChange={(event) => setAgentGenForm((prev) => ({ ...prev, withReference: event.target.value === "yes" }))}
                        disabled={busy || !selectedProjectId || !selectedSuiteId}
                        style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
                      >
                        <option value="yes">带标准答案</option>
                        <option value="no">不带标准答案</option>
                      </select>
                      <select
                        value={agentGenForm.includeApiDoc ? "yes" : "no"}
                        onChange={(event) =>
                          setAgentGenForm((prev) => ({
                            ...prev,
                            includeApiDoc: event.target.value === "yes",
                            apiDocId: event.target.value === "yes" ? prev.apiDocId : "",
                          }))
                        }
                        disabled={busy || !selectedProjectId || !selectedSuiteId}
                        style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
                      >
                        <option value="no">不带 API 文档</option>
                        <option value="yes">带 API 文档</option>
                      </select>
                      <select
                        value={agentGenForm.apiDocId}
                        onChange={(event) => setAgentGenForm((prev) => ({ ...prev, apiDocId: event.target.value }))}
                        disabled={busy || !selectedProjectId || !selectedSuiteId || !agentGenForm.includeApiDoc}
                        style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
                      >
                        <option value="">
                          {agentGenForm.includeApiDoc ? "选择 API 文档" : "未启用 API 文档"}
                        </option>
                        {apiDocs.map((doc) => (
                          <option key={doc.id} value={doc.id}>
                            {doc.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 8 }}>
                      {[
                        { key: "single_turn", label: "单轮问答" },
                        { key: "multi_turn", label: "多轮对话" },
                        { key: "tool_calling", label: "工具调用" },
                        { key: "open_task", label: "开放式任务" },
                      ].map((item) => (
                        <label key={item.key} style={{ display: "flex", alignItems: "center", gap: 8, border: "1px solid rgba(31,37,39,0.12)", borderRadius: 10, padding: "8px 10px" }}>
                          <input
                            type="checkbox"
                            checked={agentGenForm.dimensions[item.key as keyof typeof agentGenForm.dimensions]}
                            onChange={(event) =>
                              setAgentGenForm((prev) => ({
                                ...prev,
                                dimensions: {
                                  ...prev.dimensions,
                                  [item.key]: event.target.checked,
                                },
                              }))
                            }
                            disabled={busy || !selectedProjectId || !selectedSuiteId}
                          />
                          <span>{item.label}</span>
                        </label>
                      ))}
                    </div>

                    <button
                      type="submit"
                      disabled={busy || !selectedProjectId || !selectedSuiteId}
                      style={{ border: "none", borderRadius: 10, padding: "9px 12px", background: "#1f2527", color: "#fff8eb", fontWeight: 700, cursor: "pointer" }}
                    >
                      生成 Agent 数据集
                    </button>
                  </form>
                </div>
              ) : null}

              {agentDatasetInputTab === "upload_benchmark" ? (
                <div style={{ borderRadius: 14, border: "1px solid rgba(31,37,39,0.08)", padding: 12 }}>
                  <div style={{ display: "grid", gap: 12 }}>
                    <form
                      onSubmit={(event) => void onImportDatasetByCsv(event)}
                      style={{ borderRadius: 12, border: "1px solid rgba(31,37,39,0.08)", padding: 12, display: "grid", gap: 8 }}
                    >
                      <strong>上传 Benchmark 数据集</strong>
                      <div style={{ fontSize: 12, color: "#667173" }}>
                        先下载表头模板填写后上传。支持 CSV / TSV；若是 Excel，请先另存为 UTF-8 CSV。
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr auto auto", gap: 8 }}>
                        <select
                          value={selectedImportDatasetId ?? ""}
                          onChange={(event) => setSelectedImportDatasetId(event.target.value ? Number(event.target.value) : null)}
                          disabled={busy || benchmarkDatasets.length === 0}
                          style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
                        >
                          <option value="">选择目标数据集</option>
                          {benchmarkDatasets.map((dataset) => (
                            <option key={dataset.id} value={dataset.id}>
                              {dataset.name}（{dataset.dataset_type}）
                            </option>
                          ))}
                        </select>
                        <input
                          key={datasetImportInputKey}
                          type="file"
                          accept=".csv,.tsv,.txt"
                          disabled={busy}
                          onChange={(event) => setDatasetImportFile(event.target.files?.[0] ?? null)}
                          style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "7px 9px" }}
                        />
                        <button
                          type="button"
                          onClick={onDownloadBenchmarkTemplate}
                          className={compactActionButtonClass}
                          disabled={busy}
                        >
                          下载表头模板
                        </button>
                        <button
                          type="submit"
                          className={compactActionButtonClass}
                          disabled={busy || !selectedImportDatasetId || !datasetImportFile}
                        >
                          {datasetImporting ? "导入中..." : "上传并导入"}
                        </button>
                      </div>
                      <div style={{ fontSize: 12, color: "#667173", lineHeight: 1.5 }}>
                        必填列：user_input。可选 JSON 列：reference_answer_json、conversation_history_json、tools_context_json、constraints_json、meta_info_json。
                      </div>
                      {selectedImportDataset ? (
                        <div style={{ fontSize: 12, color: "#667173" }}>
                          当前目标：{selectedImportDataset.name}（类型：{selectedImportDataset.dataset_type}）
                        </div>
                      ) : (
                        <div style={{ fontSize: 12, color: "#9aa3a6" }}>
                          当前项目暂无可用的用户上传 Benchmark 数据集。请先在文档管理手动创建并上传，系统自动生成的数据集不会出现在此列表。
                        </div>
                      )}
                    </form>

                    <form
                      onSubmit={(event) => void onGenerateApiCasesFromBenchmarkDataset(event)}
                      style={{ borderRadius: 12, border: "1px solid rgba(31,37,39,0.08)", padding: 12, display: "grid", gap: 8 }}
                    >
                      <strong>根据 Benchmark 数据集生成 API 测试案例</strong>
                      <div style={{ fontSize: 12, color: "#667173" }}>
                        请求输入来自 Benchmark 数据集的 `user_input`。会按数据集有效条数 1:1 生成 API case。
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 8 }}>
                        <select
                          value={selectedImportDatasetId ?? ""}
                          onChange={(event) => setSelectedImportDatasetId(event.target.value ? Number(event.target.value) : null)}
                          disabled={busy || benchmarkDatasets.length === 0}
                          style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
                        >
                          <option value="">选择 Benchmark 数据集</option>
                          {benchmarkDatasets.map((dataset) => (
                            <option key={dataset.id} value={dataset.id}>
                              {dataset.name}
                            </option>
                          ))}
                        </select>
                        <select
                          value={selectedBenchmarkApiDocId}
                          onChange={(event) => setSelectedBenchmarkApiDocId(event.target.value)}
                          disabled={busy || apiDocs.length === 0}
                          style={{ borderRadius: 10, border: "1px solid rgba(31,37,39,0.16)", padding: "9px 11px" }}
                        >
                          <option value="">选择 API 文档</option>
                          {apiDocs.map((doc) => (
                            <option key={doc.id} value={doc.id}>
                              {doc.name}
                            </option>
                          ))}
                        </select>
                        <button
                          type="submit"
                          className={compactActionButtonClass}
                          disabled={busy || !selectedProjectId || !selectedSuiteId || !selectedImportDatasetId || !selectedBenchmarkApiDocId}
                        >
                          {datasetToApiGenerating ? "生成中..." : "生成测试 API Case"}
                        </button>
                      </div>
                      <div style={{ fontSize: 12, color: "#667173" }}>
                        生成目标 Suite：{selectedSuite?.name ?? "未选择"}。
                      </div>
                    </form>
                  </div>
                </div>
              ) : null}
            </div>

            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1180 }}>
                <thead>
                  <tr style={{ textAlign: "left", borderBottom: "1px solid rgba(31,37,39,0.12)" }}>
                    <th style={{ padding: "9px 8px" }}>批次 ID</th>
                    <th style={{ padding: "9px 8px" }}>项目</th>
                    <th style={{ padding: "9px 8px" }}>Suite</th>
                    <th style={{ padding: "9px 8px" }}>文档来源</th>
                    <th style={{ padding: "9px 8px" }}>数据条数</th>
                    <th style={{ padding: "9px 8px" }}>标准答案</th>
                    <th style={{ padding: "9px 8px" }}>状态</th>
                    <th style={{ padding: "9px 8px" }}>生成时间</th>
                    <th style={{ padding: "9px 8px" }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {agentBatchHistory.length === 0 ? (
                    <tr>
                      <td colSpan={9} style={{ padding: "12px 8px", color: "#687274" }}>
                        暂无 Agent 数据集生成批次
                      </td>
                    </tr>
                  ) : (
                    agentBatchHistory.map((batch) => {
                      const content = (batch.content_json ?? {}) as Record<string, unknown>;
                      const sourceName = prdAgentDocs.find((item) => item.id === Number(content.source_doc_id))?.name ?? content.source_doc_id;
                      const suiteId = Number(content.suite_id);
                      return (
                        <tr key={batch.id} style={{ borderBottom: "1px solid rgba(31,37,39,0.08)" }}>
                          <td style={{ padding: "9px 8px", fontWeight: 700 }}>{String(content.batch_id ?? batch.id)}</td>
                          <td style={{ padding: "9px 8px" }}>{selectedProject?.name ?? "-"}</td>
                          <td style={{ padding: "9px 8px" }}>{suiteNameById(suites, Number.isFinite(suiteId) ? suiteId : null)}</td>
                          <td style={{ padding: "9px 8px" }}>{String(sourceName ?? "-")}</td>
                          <td style={{ padding: "9px 8px" }}>{String(content.generated_count ?? "-")}</td>
                          <td style={{ padding: "9px 8px" }}>{content.with_reference ? "是" : "否"}</td>
                          <td style={{ padding: "9px 8px" }}>{String(content.status ?? "-")}</td>
                          <td style={{ padding: "9px 8px" }}>{batch.created_at ?? "-"}</td>
                          <td style={{ padding: "9px 8px", display: "flex", gap: 6, flexWrap: "wrap" }}>
                            <button
                              type="button"
                              onClick={() => setHistoryDetail(batch)}
                              className={compactActionButtonClass}
                            >
                              查看批次
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                navigate(
                                  `/assets?tab=agent_benchmark_cases&projectId=${selectedProjectId ?? ""}&suiteId=${content.suite_id ?? ""}`
                                )
                              }
                              className={compactActionButtonClass}
                            >
                              查看 Benchmark 资产
                            </button>
                            <button
                              type="button"
                              onClick={() => void onDeleteHistoryBatch(batch.id)}
                              className={compactDangerButtonClass}
                            >
                              删除批次
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>
                第 {agentBatchPage} / {agentBatchTotalPages} 页 · 共 {agentBatchTotal} 条 · 每页 {TABLE_PAGE_SIZE} 条
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setAgentBatchPage((prev) => Math.max(1, prev - 1))}
                  disabled={loading || busy || agentBatchPage <= 1}
                  className={`${compactActionButtonClass} disabled:cursor-not-allowed disabled:opacity-60`}
                >
                  上一页
                </button>
                <button
                  type="button"
                  onClick={() => setAgentBatchPage((prev) => Math.min(agentBatchTotalPages, prev + 1))}
                  disabled={loading || busy || agentBatchPage >= agentBatchTotalPages}
                  className={`${compactActionButtonClass} disabled:cursor-not-allowed disabled:opacity-60`}
                >
                  下一页
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {historyDetail ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/25 p-4 backdrop-blur-sm">
          <div className="w-full max-w-[920px] max-h-[84vh] overflow-auto rounded-2xl border border-border/80 bg-card p-4 shadow-panel">
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
              <strong>生成批次详情</strong>
              <button
                type="button"
                onClick={() => setHistoryDetail(null)}
                className={`${neutralButtonClass} px-2.5 py-1.5 text-sm font-semibold`}
              >
                关闭
              </button>
            </div>
            <pre className="mb-0 mt-2.5 max-h-[380px] overflow-auto rounded-xl border border-border/70 bg-zinc-50 p-2.5 text-xs font-mono leading-relaxed">
              {JSON.stringify(
                {
                  id: historyDetail.id,
                  name: historyDetail.name,
                  asset_type: historyDetail.asset_type,
                  created_at: historyDetail.created_at,
                  content_json: historyDetail.content_json,
                  meta_info: safeMeta(historyDetail),
                },
                null,
                2
              )}
            </pre>
          </div>
        </div>
      ) : null}
    </section>
  );
}
