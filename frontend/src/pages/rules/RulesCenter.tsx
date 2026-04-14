import { FormEvent, useEffect, useMemo, useState } from "react";

import { FloatingNotice, type NoticeTone } from "../../components/FloatingNotice";
import {
  ProjectRecord,
  SuiteRecord,
  UserAssetRecord,
  listProjects,
  listSuites,
  listUserAssets,
} from "../../services/assetService";
import {
  RuleOverviewRecord,
  RuleRecord,
  RuleRelationsRecord,
  bindRuleProjects,
  bindRuleSuites,
  createRule,
  deleteRule,
  generateAgentScoringDimensions,
  getRule,
  getRuleRelations,
  listRuleOverview,
  updateRule,
} from "../../services/ruleService";
type RuleTab = "api_rules" | "agent_benchmark_rules";
type RuleType = "execution" | "assertion" | "scoring" | "generation";
type AssertionOperator = "eq" | "ne" | "contains" | "not_contains" | "gt" | "gte" | "lt" | "lte" | "exists";
type EvaluationMode = "with_reference" | "without_reference";
type AgentMatchType = "exact_match" | "json_match" | "llm_judge" | "rule_based";

type AssertionRow = {
  id: string;
  path: string;
  op: AssertionOperator;
  value: string;
};

type DimensionRow = {
  name: string;
  weight: string;
  description: string;
};

type RuleFormState = {
  name: string;
  description: string;
  status: string;
  ruleType: RuleType;
  executionEnabled: boolean;
  executionTimeoutMs: string;
  executionRetryCount: string;
  executionRetryIntervalMs: string;
  assertionExpectedStatusCode: string;
  assertionMaxLatencyMs: string;
  assertionItems: AssertionRow[];
  agentEvaluationMode: EvaluationMode;
  agentUseReference: boolean;
  agentMatchType: AgentMatchType;
  agentThreshold: string;
  agentJudgePrompt: string;
  agentDimensions: DimensionRow[];
};

type AgentRuleGeneratorFormState = {
  projectId: number | null;
  suiteId: number | null;
  sourceAssetId: number | null;
  userRequirement: string;
  dimensionRows: Array<{
    id: string;
    name: string;
    weight: string;
  }>;
  withReference: boolean;
};

type FormUpdater = (updater: (prev: RuleFormState) => RuleFormState) => void;

const secondaryButtonClass = "console-btn-secondary disabled:cursor-not-allowed disabled:opacity-60";
const primaryButtonClass = "console-btn-primary disabled:cursor-not-allowed disabled:opacity-60";
const dangerButtonClass = "console-btn-danger disabled:cursor-not-allowed disabled:opacity-60";

const statusOptions = ["active", "inactive", "archived"];
const apiRuleTypeOptions: RuleType[] = ["assertion"];
const agentRuleTypeOptions: RuleType[] = ["scoring"];
const assertionOperatorOptions: AssertionOperator[] = ["eq", "ne", "contains", "not_contains", "gt", "gte", "lt", "lte", "exists"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createAssertionRow(seed?: Partial<AssertionRow>): AssertionRow {
  const randomId =
    typeof globalThis !== "undefined" && globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `assertion-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return {
    id: seed?.id && seed.id.trim() ? seed.id : randomId,
    path: seed?.path ?? "",
    op: seed?.op ?? "eq",
    value: seed?.value ?? "",
  };
}

function defaultAssertionRows(): AssertionRow[] {
  return [createAssertionRow({ path: "$.code", op: "eq", value: "0" })];
}

function defaultDimensionRows(): DimensionRow[] {
  return [
    { name: "correctness", weight: "0.5", description: "回答是否准确" },
    { name: "completeness", weight: "0.3", description: "是否覆盖核心信息" },
    { name: "format_compliance", weight: "0.2", description: "格式是否符合要求" },
  ];
}

function defaultRuleTypeForTab(tab: RuleTab): RuleType {
  return tab === "api_rules" ? "assertion" : "scoring";
}

function createGeneratorDimensionRow(
  seed?: Partial<{
    id: string;
    name: string;
    weight: string;
  }>
): { id: string; name: string; weight: string } {
  const randomId =
    typeof globalThis !== "undefined" && globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `generator-dimension-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return {
    id: seed?.id && seed.id.trim() ? seed.id : randomId,
    name: seed?.name ?? "",
    weight: seed?.weight ?? "0.3",
  };
}

function defaultGeneratorDimensionRows(): Array<{ id: string; name: string; weight: string }> {
  return [
    createGeneratorDimensionRow({ name: "correctness", weight: "0.5" }),
    createGeneratorDimensionRow({ name: "completeness", weight: "0.3" }),
    createGeneratorDimensionRow({ name: "format_compliance", weight: "0.2" }),
  ];
}

function createDefaultAgentRuleGeneratorForm(): AgentRuleGeneratorFormState {
  return {
    projectId: null,
    suiteId: null,
    sourceAssetId: null,
    userRequirement: "",
    dimensionRows: defaultGeneratorDimensionRows(),
    withReference: true,
  };
}

function createDefaultForm(ruleType: RuleType): RuleFormState {
  return {
    name: "",
    description: "",
    status: "active",
    ruleType,
    executionEnabled: true,
    executionTimeoutMs: "8000",
    executionRetryCount: "0",
    executionRetryIntervalMs: "300",
    assertionExpectedStatusCode: "200",
    assertionMaxLatencyMs: "2000",
    assertionItems: defaultAssertionRows(),
    agentEvaluationMode: "with_reference",
    agentUseReference: true,
    agentMatchType: "llm_judge",
    agentThreshold: "0.8",
    agentJudgePrompt: "",
    agentDimensions: defaultDimensionRows(),
  };
}

function normalizeRuleType(value: string): RuleType {
  if (value === "execution" || value === "assertion" || value === "scoring" || value === "generation") {
    return value;
  }
  return "assertion";
}

function toStringValue(value: unknown, fallback: string): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return fallback;
}

function toBooleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") {
      return true;
    }
    if (value.toLowerCase() === "false") {
      return false;
    }
  }
  return fallback;
}

function stringifyLoose(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseLoose(valueText: string): unknown {
  const raw = valueText.trim();
  if (!raw) {
    return "";
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  if (raw === "null") {
    return null;
  }
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    return Number(raw);
  }
  if (
    (raw.startsWith("{") && raw.endsWith("}")) ||
    (raw.startsWith("[") && raw.endsWith("]")) ||
    (raw.startsWith("\"") && raw.endsWith("\""))
  ) {
    try {
      return JSON.parse(raw);
    } catch {
      return valueText;
    }
  }
  return valueText;
}

function toSafeInteger(value: string, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.trunc(parsed);
}

function toSafeFloat(value: string, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

function extractAgentDescriptionFromAsset(asset: UserAssetRecord | null): string {
  if (!asset) {
    return "";
  }
  if (typeof asset.content_text === "string" && asset.content_text.trim()) {
    return asset.content_text.trim();
  }
  if (isRecord(asset.content_json)) {
    const candidates = [
      asset.content_json.agent_description,
      asset.content_json.description,
      asset.content_json.text,
      asset.content_json.content,
      asset.content_json.prompt,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }
  }
  return "";
}

function normalizeGeneratorDimensionRows(
  rows: Array<{ id: string; name: string; weight: string }>
): Array<{ name: string; weight: number }> {
  const deduped = rows
    .map((row) => ({
      name: row.name.trim(),
      weight: Number(row.weight),
    }))
    .filter((row) => row.name)
    .filter((row, index, source) => source.findIndex((item) => item.name === row.name) === index);
  if (deduped.length === 0) {
    return [];
  }
  const allWeightsValid = deduped.every((row) => Number.isFinite(row.weight) && row.weight > 0);
  if (!allWeightsValid) {
    const evenWeight = Number((1 / deduped.length).toFixed(4));
    return deduped.map((row) => ({
      name: row.name,
      weight: evenWeight,
    }));
  }
  return deduped.map((row) => ({
    name: row.name,
    weight: Number(row.weight.toFixed(4)),
  }));
}

function normalizeSuggestedDimensionRows(
  rows: Array<{ name: string; weight: number }>,
  targetCount: number
): Array<{ name: string; weight: number }> {
  const uniqueRows = rows
    .map((row) => ({
      name: row.name.trim(),
      weight: Number(row.weight),
    }))
    .filter((row) => row.name)
    .filter((row, index, source) => source.findIndex((item) => item.name === row.name) === index);

  if (uniqueRows.length === 0) {
    return [];
  }

  const count = Math.max(6, Math.min(8, targetCount || uniqueRows.length));
  const sliced = uniqueRows.slice(0, count);
  const allPositive = sliced.every((row) => Number.isFinite(row.weight) && row.weight > 0);

  if (!allPositive) {
    const evenWeight = Number((1 / sliced.length).toFixed(4));
    return sliced.map((row) => ({ name: row.name, weight: evenWeight }));
  }

  const total = sliced.reduce((sum, row) => sum + row.weight, 0);
  if (total <= 0) {
    const evenWeight = Number((1 / sliced.length).toFixed(4));
    return sliced.map((row) => ({ name: row.name, weight: evenWeight }));
  }

  const normalized = sliced.map((row) => ({
    name: row.name,
    weight: Number((row.weight / total).toFixed(4)),
  }));
  const normalizedSum = normalized.reduce((sum, row) => sum + row.weight, 0);
  const drift = Number((1 - normalizedSum).toFixed(4));
  normalized[0].weight = Number((normalized[0].weight + drift).toFixed(4));

  if (normalized[0].weight <= 0) {
    const evenWeight = Number((1 / normalized.length).toFixed(4));
    return normalized.map((row) => ({ name: row.name, weight: evenWeight }));
  }

  if (normalized.some((row) => row.weight <= 0)) {
    const minPositive = 0.01;
    const lifted = normalized.map((row) => ({
      name: row.name,
      weight: Math.max(minPositive, row.weight),
    }));
    const liftedTotal = lifted.reduce((sum, row) => sum + row.weight, 0);
    const rescaled = lifted.map((row) => ({
      name: row.name,
      weight: Number((row.weight / liftedTotal).toFixed(4)),
    }));
    const rescaledSum = rescaled.reduce((sum, row) => sum + row.weight, 0);
    const rescaledDrift = Number((1 - rescaledSum).toFixed(4));
    rescaled[0].weight = Number((rescaled[0].weight + rescaledDrift).toFixed(4));
    return rescaled;
  }

  return normalized;
}

function readEvaluationMode(content: Record<string, unknown>): EvaluationMode {
  return content.evaluation_mode === "without_reference" ? "without_reference" : "with_reference";
}

function normalizeAssertionOperator(value: unknown): AssertionOperator {
  if (
    value === "eq" ||
    value === "ne" ||
    value === "contains" ||
    value === "not_contains" ||
    value === "gt" ||
    value === "gte" ||
    value === "lt" ||
    value === "lte" ||
    value === "exists"
  ) {
    return value;
  }
  return "eq";
}

function readAgentMatchType(content: Record<string, unknown>): AgentMatchType {
  const raw = content.match_type;
  if (raw === "exact_match" || raw === "json_match" || raw === "llm_judge" || raw === "rule_based") {
    return raw;
  }
  return "llm_judge";
}

function readAssertionRows(content: Record<string, unknown>): AssertionRow[] {
  const rawItems = content.assertion_items;
  if (!Array.isArray(rawItems)) {
    return defaultAssertionRows();
  }
  const rows = rawItems
    .filter(isRecord)
    .map((item) =>
      createAssertionRow({
        id: typeof item.id === "string" ? item.id : undefined,
        path: typeof item.path === "string" ? item.path : typeof item.field_path === "string" ? item.field_path : "",
        op: normalizeAssertionOperator(item.op),
        value: stringifyLoose(item.value),
      })
    )
    .filter((item) => item.path || item.value);
  return rows.length > 0 ? rows : defaultAssertionRows();
}

function readDimensionRows(content: Record<string, unknown>): DimensionRow[] {
  const rawDimensions = content.dimensions;
  if (!Array.isArray(rawDimensions)) {
    return defaultDimensionRows();
  }
  const rows = rawDimensions
    .filter(isRecord)
    .map((item) => ({
      name: typeof item.name === "string" ? item.name : "",
      weight: toStringValue(item.weight, "0"),
      description: typeof item.description === "string" ? item.description : "",
    }))
    .filter((item) => item.name);
  return rows.length > 0 ? rows : defaultDimensionRows();
}

function buildFormFromRule(rule: RuleRecord): RuleFormState {
  const normalizedType = normalizeRuleType(rule.rule_type);
  const content = isRecord(rule.content) ? rule.content : {};
  const form = createDefaultForm(normalizedType);
  form.name = rule.name;
  form.description = rule.description ?? "";
  form.status = rule.status;
  form.ruleType = normalizedType;

  if (normalizedType === "execution") {
    form.executionEnabled = toBooleanValue(content.enabled, true);
    form.executionTimeoutMs = toStringValue(content.timeout_ms, form.executionTimeoutMs);
    form.executionRetryCount = toStringValue(content.retry_count, form.executionRetryCount);
    form.executionRetryIntervalMs = toStringValue(content.retry_interval_ms, form.executionRetryIntervalMs);
    return form;
  }

  if (normalizedType === "assertion") {
    form.assertionExpectedStatusCode = toStringValue(
      content.expected_status_code ?? content.status_code,
      form.assertionExpectedStatusCode
    );
    form.assertionMaxLatencyMs = toStringValue(content.max_latency_ms, form.assertionMaxLatencyMs);
    form.assertionItems = readAssertionRows(content);
    return form;
  }

  form.agentEvaluationMode = readEvaluationMode(content);
  form.agentUseReference = toBooleanValue(content.use_reference, form.agentEvaluationMode === "with_reference");
  form.agentMatchType = readAgentMatchType(content);
  form.agentThreshold = toStringValue(content.threshold, form.agentThreshold);
  form.agentJudgePrompt = typeof content.judge_prompt === "string" ? content.judge_prompt : "";
  form.agentDimensions = readDimensionRows(content);
  return form;
}

function buildRuleContent(form: RuleFormState): Record<string, unknown> {
  if (form.ruleType === "execution") {
    return {
      enabled: form.executionEnabled,
      timeout_ms: toSafeInteger(form.executionTimeoutMs, 8000),
      retry_count: Math.max(0, toSafeInteger(form.executionRetryCount, 0)),
      retry_interval_ms: Math.max(0, toSafeInteger(form.executionRetryIntervalMs, 300)),
    };
  }

  if (form.ruleType === "assertion") {
    const assertionItems = form.assertionItems
      .filter((item) => item.path.trim())
      .map((item) => ({
        path: item.path.trim(),
        op: item.op,
        value: parseLoose(item.value),
      }));
    return {
      expected_status_code: toSafeInteger(form.assertionExpectedStatusCode, 200),
      max_latency_ms: Math.max(1, toSafeInteger(form.assertionMaxLatencyMs, 2000)),
      assertion_items: assertionItems,
    };
  }

  const dimensions = form.agentDimensions
    .filter((item) => item.name.trim())
    .map((item) => ({
      name: item.name.trim(),
      weight: Math.max(0, toSafeFloat(item.weight, 0)),
      description: item.description.trim(),
    }));

  const content: Record<string, unknown> = {
    evaluation_mode: form.agentEvaluationMode,
    use_reference: form.agentUseReference,
    match_type: form.agentMatchType,
    threshold: Math.max(0, Math.min(1, toSafeFloat(form.agentThreshold, 0.8))),
    dimensions,
  };
  if (form.agentJudgePrompt.trim()) {
    content.judge_prompt = form.agentJudgePrompt.trim();
  }
  return content;
}

function relationSourceLabel(source: string | null | undefined): string {
  if (source === "rule_binding") {
    return "规则中心绑定";
  }
  if (source === "manual_binding") {
    return "规则中心手动绑定";
  }
  return source ?? "未知来源";
}

type RuleContentEditorProps = {
  form: RuleFormState;
  updateForm: FormUpdater;
  disabled: boolean;
};

function RuleContentEditor({ form, updateForm, disabled }: RuleContentEditorProps) {
  if (form.ruleType === "execution") {
    return (
      <div className="grid gap-2">
        <strong className="text-sm">执行规则配置</strong>
        <div className="grid gap-2 md:grid-cols-3">
          <input
            value={form.executionTimeoutMs}
            onChange={(event) =>
              updateForm((prev) => ({
                ...prev,
                executionTimeoutMs: event.target.value,
              }))
            }
            disabled={disabled}
            placeholder="超时(ms)"
          />
          <input
            value={form.executionRetryCount}
            onChange={(event) =>
              updateForm((prev) => ({
                ...prev,
                executionRetryCount: event.target.value,
              }))
            }
            disabled={disabled}
            placeholder="重试次数"
          />
          <input
            value={form.executionRetryIntervalMs}
            onChange={(event) =>
              updateForm((prev) => ({
                ...prev,
                executionRetryIntervalMs: event.target.value,
              }))
            }
            disabled={disabled}
            placeholder="重试间隔(ms)"
          />
        </div>
        <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={form.executionEnabled}
            onChange={(event) =>
              updateForm((prev) => ({
                ...prev,
                executionEnabled: event.target.checked,
              }))
            }
            disabled={disabled}
          />
          启用规则
        </label>
      </div>
    );
  }

  if (form.ruleType === "assertion") {
    return (
      <div className="grid gap-2">
        <strong className="text-sm">断言规则配置</strong>
        <div className="grid gap-2 md:grid-cols-2">
          <input
            value={form.assertionExpectedStatusCode}
            onChange={(event) =>
              updateForm((prev) => ({
                ...prev,
                assertionExpectedStatusCode: event.target.value,
              }))
            }
            disabled={disabled}
            placeholder="期望状态码"
          />
          <input
            value={form.assertionMaxLatencyMs}
            onChange={(event) =>
              updateForm((prev) => ({
                ...prev,
                assertionMaxLatencyMs: event.target.value,
              }))
            }
            disabled={disabled}
            placeholder="最大响应时间(ms)"
          />
        </div>
        <div className="console-scroll grid gap-2 p-2.5">
          <div className="flex items-center justify-between">
            <strong className="text-sm">断言列表</strong>
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                updateForm((prev) => ({
                  ...prev,
                  assertionItems: [...prev.assertionItems, createAssertionRow()],
                }))
              }
              className={`${secondaryButtonClass} h-7 px-2 text-[11px]`}
            >
              新增断言
            </button>
          </div>
          {form.assertionItems.map((item, index) => (
            <div key={item.id} className="grid gap-2 md:grid-cols-[2fr_1fr_2fr_auto]">
              <input
                value={item.path}
                onChange={(event) =>
                  updateForm((prev) => ({
                    ...prev,
                    assertionItems: prev.assertionItems.map((row, rowIndex) =>
                      rowIndex === index ? { ...row, path: event.target.value } : row
                    ),
                  }))
                }
                disabled={disabled}
                placeholder="字段路径，例如 $.code"
              />
              <select
                value={item.op}
                onChange={(event) =>
                  updateForm((prev) => ({
                    ...prev,
                    assertionItems: prev.assertionItems.map((row, rowIndex) =>
                      rowIndex === index ? { ...row, op: event.target.value as AssertionOperator } : row
                    ),
                  }))
                }
                disabled={disabled}
              >
                {assertionOperatorOptions.map((op) => (
                  <option key={op} value={op}>
                    {op}
                  </option>
                ))}
              </select>
              <input
                value={item.value}
                onChange={(event) =>
                  updateForm((prev) => ({
                    ...prev,
                    assertionItems: prev.assertionItems.map((row, rowIndex) =>
                      rowIndex === index ? { ...row, value: event.target.value } : row
                    ),
                  }))
                }
                disabled={disabled}
                placeholder='期望值，例如 0 或 "success"'
              />
              <button
                type="button"
                disabled={disabled || form.assertionItems.length <= 1}
                onClick={() =>
                  updateForm((prev) => ({
                    ...prev,
                    assertionItems: prev.assertionItems.filter((_, rowIndex) => rowIndex !== index),
                  }))
                }
                className={`${dangerButtonClass} h-7 px-2 text-[11px]`}
              >
                删除
              </button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      <strong className="text-sm">智能体评价配置</strong>
      <div className="grid gap-2 md:grid-cols-3">
        <select
          value={form.agentEvaluationMode}
          onChange={(event) =>
            updateForm((prev) => ({
              ...prev,
              agentEvaluationMode: event.target.value as EvaluationMode,
              agentUseReference: event.target.value === "with_reference",
            }))
          }
          disabled={disabled}
        >
          <option value="with_reference">有标准答案</option>
          <option value="without_reference">无标准答案</option>
        </select>
        <select
          value={form.agentMatchType}
          onChange={(event) =>
            updateForm((prev) => ({
              ...prev,
              agentMatchType: event.target.value as AgentMatchType,
            }))
          }
          disabled={disabled}
        >
          <option value="exact_match">exact_match</option>
          <option value="json_match">json_match</option>
          <option value="llm_judge">llm_judge</option>
          <option value="rule_based">rule_based</option>
        </select>
        <input
          value={form.agentThreshold}
          onChange={(event) =>
            updateForm((prev) => ({
              ...prev,
              agentThreshold: event.target.value,
            }))
          }
          disabled={disabled}
          placeholder="通过阈值(0~1)"
        />
      </div>
      <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
        <input
          type="checkbox"
          checked={form.agentUseReference}
          onChange={(event) =>
            updateForm((prev) => ({
              ...prev,
              agentUseReference: event.target.checked,
            }))
          }
          disabled={disabled}
        />
        启用标准答案比对
      </label>
      <textarea
        value={form.agentJudgePrompt}
        onChange={(event) =>
          updateForm((prev) => ({
            ...prev,
            agentJudgePrompt: event.target.value,
          }))
        }
        rows={4}
        disabled={disabled}
        placeholder="Judge Prompt（可选）"
        className="font-mono"
      />
      <div className="console-scroll grid gap-2 p-2.5">
        <div className="flex items-center justify-between">
          <strong className="text-sm">评价维度</strong>
          <button
            type="button"
            disabled={disabled}
            onClick={() =>
              updateForm((prev) => ({
                ...prev,
                agentDimensions: [...prev.agentDimensions, { name: "", weight: "0", description: "" }],
              }))
            }
            className={`${secondaryButtonClass} h-7 px-2 text-[11px]`}
          >
            新增维度
          </button>
        </div>
        {form.agentDimensions.map((dimension, index) => (
          <div key={`dimension-row-${index}`} className="grid gap-2 md:grid-cols-[1.4fr_0.8fr_2fr_auto]">
            <input
              value={dimension.name}
              onChange={(event) =>
                updateForm((prev) => ({
                  ...prev,
                  agentDimensions: prev.agentDimensions.map((row, rowIndex) =>
                    rowIndex === index ? { ...row, name: event.target.value } : row
                  ),
                }))
              }
              disabled={disabled}
              placeholder="维度名"
            />
            <input
              value={dimension.weight}
              onChange={(event) =>
                updateForm((prev) => ({
                  ...prev,
                  agentDimensions: prev.agentDimensions.map((row, rowIndex) =>
                    rowIndex === index ? { ...row, weight: event.target.value } : row
                  ),
                }))
              }
              disabled={disabled}
              placeholder="权重"
            />
            <input
              value={dimension.description}
              onChange={(event) =>
                updateForm((prev) => ({
                  ...prev,
                  agentDimensions: prev.agentDimensions.map((row, rowIndex) =>
                    rowIndex === index ? { ...row, description: event.target.value } : row
                  ),
                }))
              }
              disabled={disabled}
              placeholder="评价说明"
            />
            <button
              type="button"
              disabled={disabled || form.agentDimensions.length <= 1}
              onClick={() =>
                updateForm((prev) => ({
                  ...prev,
                  agentDimensions: prev.agentDimensions.filter((_, rowIndex) => rowIndex !== index),
                }))
              }
              className={`${dangerButtonClass} h-7 px-2 text-[11px]`}
            >
              删除
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

type RulesCenterProps = {
  mode: RuleTab;
};

export function RulesCenter({ mode }: RulesCenterProps) {
  const tab = mode;
  const [rules, setRules] = useState<RuleOverviewRecord[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [suites, setSuites] = useState<SuiteRecord[]>([]);
  const [selectedRuleIdByTab, setSelectedRuleIdByTab] = useState<Record<RuleTab, number | null>>({
    api_rules: null,
    agent_benchmark_rules: null,
  });
  const [bindProjectIds, setBindProjectIds] = useState<number[]>([]);
  const [bindSuiteIds, setBindSuiteIds] = useState<number[]>([]);
  const [suiteProjectFilterId, setSuiteProjectFilterId] = useState<number | null>(null);
  const [bindingBusy, setBindingBusy] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState("");
  const [apiTypeFilter, setApiTypeFilter] = useState<"all" | "assertion">("all");
  const [agentModeFilter, setAgentModeFilter] = useState<"all" | EvaluationMode>("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [detailRule, setDetailRule] = useState<RuleRecord | null>(null);
  const [relations, setRelations] = useState<RuleRelationsRecord | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: NoticeTone; text: string } | null>(null);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [createForm, setCreateForm] = useState<RuleFormState>(() => createDefaultForm("assertion"));
  const [agentRuleGeneratorForm, setAgentRuleGeneratorForm] = useState<AgentRuleGeneratorFormState>(
    createDefaultAgentRuleGeneratorForm
  );
  const [generatorAgentDocs, setGeneratorAgentDocs] = useState<UserAssetRecord[]>([]);
  const [loadingGeneratorAgentDocs, setLoadingGeneratorAgentDocs] = useState(false);
  const [agentRuleSuggestionBusy, setAgentRuleSuggestionBusy] = useState(false);
  const [agentRuleGenerationBusy, setAgentRuleGenerationBusy] = useState(false);
  const [editForm, setEditForm] = useState<RuleFormState>(() => createDefaultForm("assertion"));
  const [detailPanel, setDetailPanel] = useState<"config" | "binding">("config");

  const selectedRuleId = selectedRuleIdByTab[tab];
  const visibleSuites = useMemo(
    () => (suiteProjectFilterId ? suites.filter((item) => item.project_id === suiteProjectFilterId) : suites),
    [suites, suiteProjectFilterId]
  );
  const generatorSuites = useMemo(() => {
    if (!agentRuleGeneratorForm.projectId) {
      return suites;
    }
    return suites.filter((item) => item.project_id === agentRuleGeneratorForm.projectId);
  }, [agentRuleGeneratorForm.projectId, suites]);
  const selectedGeneratorAgentDoc = useMemo(
    () => generatorAgentDocs.find((item) => item.id === agentRuleGeneratorForm.sourceAssetId) ?? null,
    [generatorAgentDocs, agentRuleGeneratorForm.sourceAssetId]
  );
  const agentGeneratorBusy = agentRuleSuggestionBusy || agentRuleGenerationBusy;

  const filteredRules = useMemo(() => {
    const keyword = searchKeyword.trim().toLowerCase();
    return rules.filter((rule) => {
      if (statusFilter !== "all" && rule.status !== statusFilter) {
        return false;
      }
      if (tab === "api_rules" && apiTypeFilter !== "all" && rule.rule_type !== apiTypeFilter) {
        return false;
      }
      if (tab === "agent_benchmark_rules" && agentModeFilter !== "all") {
        const mode = isRecord(rule.content) ? readEvaluationMode(rule.content) : "with_reference";
        if (mode !== agentModeFilter) {
          return false;
        }
      }
      if (!keyword) {
        return true;
      }
      return (
        String(rule.id).includes(keyword) ||
        rule.name.toLowerCase().includes(keyword) ||
        (rule.description ?? "").toLowerCase().includes(keyword)
      );
    });
  }, [rules, searchKeyword, statusFilter, tab, apiTypeFilter, agentModeFilter]);

  async function refreshRules(targetTab: RuleTab, preferredSelectedId?: number | null) {
    setLoadingList(true);
    try {
      const queryRuleTypes = targetTab === "api_rules" ? ["assertion"] : ["scoring"];
      const items = await listRuleOverview(queryRuleTypes);
      setRules(items);
      setSelectedRuleIdByTab((prev) => {
        const current = preferredSelectedId ?? prev[targetTab];
        const nextId = current && items.some((item) => item.id === current) ? current : items[0]?.id ?? null;
        return {
          ...prev,
          [targetTab]: nextId,
        };
      });
      setNotice(null);
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "加载规则列表失败",
      });
      setRules([]);
    } finally {
      setLoadingList(false);
    }
  }

  async function loadRuleDetail(ruleId: number) {
    setLoadingDetail(true);
    try {
      const [detail, relationData] = await Promise.all([getRule(ruleId), getRuleRelations(ruleId)]);
      setDetailRule(detail);
      setRelations(relationData);
      setEditForm(buildFormFromRule(detail));
      setBindProjectIds(relationData.project_ids ?? []);
      setBindSuiteIds(relationData.suite_ids ?? []);
      setSuiteProjectFilterId((prev) => {
        if (prev && relationData.projects.some((item) => item.id === prev)) {
          return prev;
        }
        return relationData.projects[0]?.id ?? prev ?? null;
      });
      setNotice(null);
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "加载规则详情失败",
      });
      setDetailRule(null);
      setRelations(null);
    } finally {
      setLoadingDetail(false);
    }
  }

  useEffect(() => {
    void refreshRules(tab);
  }, [tab]);

  useEffect(() => {
    void (async () => {
      try {
        const projectItems = await listProjects();
        setProjects(projectItems);
        setSuiteProjectFilterId((prev) => {
          if (prev && projectItems.some((item) => item.id === prev)) {
            return prev;
          }
          return projectItems[0]?.id ?? null;
        });
      } catch (error) {
        setNotice({
          tone: "error",
          text: error instanceof Error ? error.message : "加载项目失败",
        });
      }
    })();
  }, []);

  useEffect(() => {
    if (projects.length === 0) {
      setSuites([]);
      return;
    }
    void (async () => {
      try {
        const suiteGroups = await Promise.all(projects.map((project) => listSuites(project.id)));
        const merged = suiteGroups.flat();
        setSuites(merged);
      } catch (error) {
        setNotice({
          tone: "error",
          text: error instanceof Error ? error.message : "加载 suite 失败",
        });
      }
    })();
  }, [projects]);

  useEffect(() => {
    if (!selectedRuleId) {
      setDetailRule(null);
      setRelations(null);
      setBindProjectIds([]);
      setBindSuiteIds([]);
      setEditForm(createDefaultForm(defaultRuleTypeForTab(tab)));
      return;
    }
    void loadRuleDetail(selectedRuleId);
  }, [selectedRuleId, tab]);

  useEffect(() => {
    if (filteredRules.length === 0) {
      setSelectedRuleIdByTab((prev) => ({
        ...prev,
        [tab]: null,
      }));
      return;
    }
    if (!selectedRuleId || !filteredRules.some((item) => item.id === selectedRuleId)) {
      setSelectedRuleIdByTab((prev) => ({
        ...prev,
        [tab]: filteredRules[0].id,
      }));
    }
  }, [filteredRules, selectedRuleId, tab]);

  useEffect(() => {
    setDetailPanel("config");
  }, [selectedRuleId, tab]);

  useEffect(() => {
    if (tab !== "agent_benchmark_rules" || !createModalOpen) {
      setGeneratorAgentDocs([]);
      setLoadingGeneratorAgentDocs(false);
      return;
    }
    const projectId = agentRuleGeneratorForm.projectId;
    if (!projectId) {
      setGeneratorAgentDocs([]);
      setLoadingGeneratorAgentDocs(false);
      return;
    }
    let cancelled = false;
    setLoadingGeneratorAgentDocs(true);
    void (async () => {
      try {
        const docs = await listUserAssets(projectId, undefined, "prd_agent_doc", "active");
        if (cancelled) {
          return;
        }
        const preferredDocs = docs.filter((item) => {
          const fileName = (item.file_name ?? "").toLowerCase();
          const assetName = item.name.toLowerCase();
          const docType =
            isRecord(item.meta_info) && typeof item.meta_info.doc_type === "string"
              ? item.meta_info.doc_type.toLowerCase()
              : "";
          return (
            docType === "agent_info" ||
            fileName.endsWith(".md") ||
            fileName.endsWith(".markdown") ||
            assetName.includes("agent")
          );
        });
        const nextDocs = preferredDocs.length > 0 ? preferredDocs : docs;
        setGeneratorAgentDocs(nextDocs);
        setAgentRuleGeneratorForm((prev) => {
          const keepCurrent = prev.sourceAssetId && nextDocs.some((item) => item.id === prev.sourceAssetId);
          if (keepCurrent) {
            return prev;
          }
          return {
            ...prev,
            sourceAssetId: nextDocs[0]?.id ?? null,
          };
        });
      } catch (error) {
        if (!cancelled) {
          setNotice({
            tone: "error",
            text: error instanceof Error ? error.message : "加载 Agent 文档失败",
          });
          setGeneratorAgentDocs([]);
        }
      } finally {
        if (!cancelled) {
          setLoadingGeneratorAgentDocs(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, createModalOpen, agentRuleGeneratorForm.projectId]);

  function openCreateModal() {
    setCreateForm(createDefaultForm(defaultRuleTypeForTab(tab)));
    const defaultProjectId = projects[0]?.id ?? null;
    const defaultSuiteId = defaultProjectId
      ? suites.find((item) => item.project_id === defaultProjectId)?.id ?? null
      : null;
    setAgentRuleGeneratorForm(() => ({
      ...createDefaultAgentRuleGeneratorForm(),
      projectId: defaultProjectId,
      suiteId: defaultSuiteId,
    }));
    setCreateModalOpen(true);
  }

  async function onSuggestAgentRuleDimensions() {
    const projectId = agentRuleGeneratorForm.projectId;
    if (!projectId) {
      setNotice({ tone: "error", text: "请选择项目后再生成评价规则" });
      return;
    }
    const sourceDoc = generatorAgentDocs.find((item) => item.id === agentRuleGeneratorForm.sourceAssetId) ?? null;
    if (!sourceDoc) {
      setNotice({ tone: "error", text: "请先选择 Agent 描述文档" });
      return;
    }
    const agentDescription = extractAgentDescriptionFromAsset(sourceDoc);
    if (!agentDescription) {
      setNotice({ tone: "error", text: "所选文档没有可用描述，请先在文档管理补充 Agent 描述内容" });
      return;
    }
    const dimensionRows = normalizeGeneratorDimensionRows(agentRuleGeneratorForm.dimensionRows);
    const genericDimensionNames = new Set(["correctness", "completeness", "format_compliance", "clarity", "helpfulness"]);
    const hintDimensions = dimensionRows
      .map((item) => item.name)
      .filter((name) => !genericDimensionNames.has(name.trim().toLowerCase()));
    const countSeed = dimensionRows.length >= 6 ? dimensionRows.length : 6;
    const count = Math.max(6, Math.min(8, countSeed));
    setAgentRuleSuggestionBusy(true);
    try {
      const result = await generateAgentScoringDimensions({
        projectId,
        suiteId: agentRuleGeneratorForm.suiteId ?? undefined,
        agentDescription,
        userRequirement: agentRuleGeneratorForm.userRequirement.trim() || undefined,
        dimensions: hintDimensions.length > 0 ? hintDimensions : undefined,
        withReference: agentRuleGeneratorForm.withReference,
        count,
      });
      const rawRows = Array.isArray(result.dimensions)
        ? result.dimensions
            .map((item) => ({
              name: typeof item?.name === "string" ? item.name.trim() : "",
              weight:
                typeof item?.weight === "number" && Number.isFinite(item.weight)
                  ? String(Number(item.weight.toFixed(4)))
                  : "",
            }))
            .filter((item) => item.name)
        : [];

      const nextRows = normalizeSuggestedDimensionRows(
        rawRows.map((row) => ({
          name: row.name,
          weight: Number(row.weight),
        })),
        count
      );

      if (nextRows.length === 0) {
        setNotice({ tone: "error", text: "AI 未生成有效维度，请调整 Agent 描述后重试" });
        return;
      }
      setAgentRuleGeneratorForm((prev) => ({
        ...prev,
        dimensionRows: nextRows.map((row) =>
          createGeneratorDimensionRow({
            name: row.name,
            weight: String(Number(row.weight.toFixed(4))),
          })
        ),
      }));
      setNotice({
        tone: "success",
        text: `AI 已生成 ${nextRows.length} 条评价规则维度`,
      });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "AI 生成评价规则失败",
      });
    } finally {
      setAgentRuleSuggestionBusy(false);
    }
  }

  async function onGenerateAgentRules() {
    const projectId = agentRuleGeneratorForm.projectId;
    if (!projectId) {
      setNotice({ tone: "error", text: "请选择项目后再生成规则" });
      return;
    }
    const sourceDoc = generatorAgentDocs.find((item) => item.id === agentRuleGeneratorForm.sourceAssetId) ?? null;
    if (!sourceDoc) {
      setNotice({ tone: "error", text: "请先选择 Agent 描述文档" });
      return;
    }
    const agentDescription = extractAgentDescriptionFromAsset(sourceDoc);
    if (!agentDescription) {
      setNotice({ tone: "error", text: "所选文档没有可用描述，请先在文档管理补充 Agent 描述内容" });
      return;
    }
    const dimensionRows = normalizeGeneratorDimensionRows(agentRuleGeneratorForm.dimensionRows);
    if (dimensionRows.length === 0) {
      setNotice({ tone: "error", text: "请至少配置一个有效维度（维度名 + 权重）" });
      return;
    }
    setAgentRuleGenerationBusy(true);
    try {
      const suiteId = agentRuleGeneratorForm.suiteId ?? null;
      const suiteName = suiteId ? suites.find((item) => item.id === suiteId)?.name ?? "" : "";
      const baseName = (suiteName || sourceDoc.name || "智能体").trim();

      const dimensions = dimensionRows
        .filter((item) => item.name.trim())
        .map((item) => ({
          name: item.name.trim(),
          weight: Math.max(0, item.weight),
          description: `${item.name.trim()} 维度`,
        }));

      const created = await createRule({
        name: `${baseName}智能体评价规则`,
        ruleType: "scoring",
        description: agentRuleGeneratorForm.userRequirement.trim() || "由 Agent 描述生成的智能体评价规则",
        status: "active",
        content: {
          evaluation_mode: agentRuleGeneratorForm.withReference ? "with_reference" : "without_reference",
          use_reference: agentRuleGeneratorForm.withReference,
          match_type: agentRuleGeneratorForm.withReference ? "json_match" : "llm_judge",
          threshold: 0.8,
          judge_prompt: "请按维度对回答进行评分并给出理由，严格输出 JSON 结构结果。",
          dimensions,
        },
      });

      await bindRuleProjects(created.id, [projectId]);
      if (suiteId) {
        await bindRuleSuites(created.id, [suiteId]);
      }

      setCreateModalOpen(false);
      await refreshRules(tab, created.id);
      setNotice({
        tone: "success",
        text: "已创建 1 条智能体评价规则",
      });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "生成智能体评价规则失败",
      });
    } finally {
      setAgentRuleGenerationBusy(false);
    }
  }

  async function onCreateRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!createForm.name.trim()) {
      setNotice({ tone: "error", text: "规则名称不能为空" });
      return;
    }
    setBusy(true);
    try {
      const created = await createRule({
        name: createForm.name.trim(),
        ruleType: createForm.ruleType,
        description: createForm.description.trim() || undefined,
        status: createForm.status,
        content: buildRuleContent(createForm),
      });
      setCreateModalOpen(false);
      setNotice({ tone: "success", text: `规则创建成功：${created.name}` });
      await refreshRules(tab, created.id);
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "创建规则失败",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onSaveRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedRuleId || !detailRule) {
      setNotice({ tone: "error", text: "请先选择规则" });
      return;
    }
    if (!editForm.name.trim()) {
      setNotice({ tone: "error", text: "规则名称不能为空" });
      return;
    }
    setBusy(true);
    try {
      const updated = await updateRule(selectedRuleId, {
        name: editForm.name.trim(),
        ruleType: editForm.ruleType,
        description: editForm.description.trim() || undefined,
        status: editForm.status,
        content: buildRuleContent(editForm),
      });
      setNotice({ tone: "success", text: `规则已更新：${updated.name}` });
      await refreshRules(tab, selectedRuleId);
      await loadRuleDetail(selectedRuleId);
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "保存规则失败",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteRule() {
    if (!selectedRuleId) {
      setNotice({ tone: "error", text: "请先选择规则" });
      return;
    }
    setBusy(true);
    try {
      await deleteRule(selectedRuleId);
      setNotice({ tone: "success", text: `规则 ${selectedRuleId} 已删除/归档` });
      await refreshRules(tab);
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "删除规则失败",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onDuplicateRule() {
    if (!selectedRuleId || !detailRule) {
      setNotice({ tone: "error", text: "请先选择规则" });
      return;
    }
    setBusy(true);
    try {
      const duplicated = await createRule({
        name: `${editForm.name.trim() || detailRule.name}（副本）`,
        ruleType: editForm.ruleType,
        description: editForm.description.trim() || undefined,
        status: "active",
        content: buildRuleContent(editForm),
      });
      setNotice({ tone: "success", text: `规则复制成功：${duplicated.name}` });
      await refreshRules(tab, duplicated.id);
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "复制规则失败",
      });
    } finally {
      setBusy(false);
    }
  }

  function toggleNumber(list: number[], value: number): number[] {
    return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  }

  async function onSaveBindings() {
    if (!selectedRuleId) {
      setNotice({ tone: "error", text: "请先选择规则" });
      return;
    }
    setBindingBusy(true);
    try {
      await bindRuleProjects(selectedRuleId, bindProjectIds);
      await bindRuleSuites(selectedRuleId, bindSuiteIds);
      await refreshRules(tab, selectedRuleId);
      await loadRuleDetail(selectedRuleId);
      setNotice({ tone: "success", text: "规则关联已保存，后续执行会加载这些规则" });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "保存规则关联失败",
      });
    } finally {
      setBindingBusy(false);
    }
  }

  const createFormTypeOptions = tab === "api_rules" ? apiRuleTypeOptions : agentRuleTypeOptions;
  const editFormTypeOptions = tab === "api_rules" ? apiRuleTypeOptions : agentRuleTypeOptions;

  return (
    <section className="rules-page grid gap-4">
      <FloatingNotice notice={notice} onClose={() => setNotice(null)} />
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="page-title m-0">规则中心</h2>
        <button
          type="button"
          onClick={openCreateModal}
          disabled={busy}
          className={primaryButtonClass}
        >
          新建规则
        </button>
      </header>

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[380px_minmax(0,1fr)]">
        <div className="console-panel flex min-h-0 flex-col gap-3 p-4">
          <div className="flex items-center justify-between gap-2">
            <strong className="m-0 text-[15px]">规则列表</strong>
            <span className="text-xs text-muted-foreground">共 {filteredRules.length} 条</span>
          </div>
          <div className="grid gap-2">
            <input
              value={searchKeyword}
              onChange={(event) => setSearchKeyword(event.target.value)}
              placeholder="搜索名称 / ID / 描述"
            />
            <button
              type="button"
              onClick={() => void refreshRules(tab)}
              disabled={loadingList || busy}
              className={secondaryButtonClass}
            >
              {loadingList ? "刷新中..." : "刷新"}
            </button>
          </div>
          <div className="grid gap-2 grid-cols-2">
            {tab === "api_rules" ? (
              <select
                value={apiTypeFilter}
                onChange={(event) => setApiTypeFilter(event.target.value as "all" | "assertion")}
              >
                <option value="all">全部规则类型</option>
                <option value="assertion">assertion</option>
              </select>
            ) : (
              <select
                value={agentModeFilter}
                onChange={(event) => setAgentModeFilter(event.target.value as "all" | EvaluationMode)}
              >
                <option value="all">全部评价模式</option>
                <option value="with_reference">有标准答案</option>
                <option value="without_reference">无标准答案</option>
              </select>
            )}
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="all">全部状态</option>
              <option value="active">active</option>
              <option value="inactive">inactive</option>
              <option value="archived">archived</option>
            </select>
          </div>
          <div className="console-scroll min-h-[220px] max-h-[56vh] overflow-auto bg-foreground/[0.015]">
            {filteredRules.length === 0 ? (
              <div className="p-3 text-muted-foreground">暂无规则</div>
            ) : (
              filteredRules.map((item) => {
                const evaluationMode = isRecord(item.content) ? readEvaluationMode(item.content) : "with_reference";
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() =>
                      setSelectedRuleIdByTab((prev) => ({
                        ...prev,
                        [tab]: item.id,
                      }))
                    }
                    className={`w-full cursor-pointer border-b border-foreground/[0.06] px-3 py-2.5 text-left transition-colors ${
                      selectedRuleId === item.id ? "bg-primary/15" : "bg-transparent hover:bg-foreground/[0.03]"
                    }`}
                  >
                    <div className="font-semibold">{item.name}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      ID {item.id} · {item.rule_type} · {item.status}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-2.5 text-xs text-muted-foreground">
                      <span>项目 {item.project_count}</span>
                      <span>Suite {item.suite_count}</span>
                      {tab === "agent_benchmark_rules" ? <span>模式 {evaluationMode}</span> : null}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <form
          onSubmit={(event) => void onSaveRule(event)}
          className="console-panel flex min-h-0 flex-col gap-3 p-4"
        >
          <strong className="m-0 text-[15px]">规则详情 / 编辑</strong>
          {!detailRule ? (
            <div className="text-muted-foreground">{loadingDetail ? "加载规则详情中..." : "请选择左侧规则"}</div>
          ) : (
            <>
              <div className="text-xs text-muted-foreground">当前规则 ID: {detailRule.id}</div>
              <input
                value={editForm.name}
                onChange={(event) =>
                  setEditForm((prev) => ({
                    ...prev,
                    name: event.target.value,
                  }))
                }
                placeholder="规则名称"
                disabled={busy}
              />
              <div className="grid gap-2 md:grid-cols-2">
                <select
                  value={editForm.ruleType}
                  onChange={(event) =>
                    setEditForm((prev) => ({
                      ...prev,
                      ruleType: event.target.value as RuleType,
                    }))
                  }
                  disabled={busy}
                >
                  {editFormTypeOptions.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
                <select
                  value={editForm.status}
                  onChange={(event) =>
                    setEditForm((prev) => ({
                      ...prev,
                      status: event.target.value,
                    }))
                  }
                  disabled={busy}
                >
                  {statusOptions.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </div>
              <input
                value={editForm.description}
                onChange={(event) =>
                  setEditForm((prev) => ({
                    ...prev,
                    description: event.target.value,
                  }))
                }
                placeholder="描述（可选）"
                disabled={busy}
              />

              <div className="segmented-group w-fit">
                <button
                  type="button"
                  onClick={() => setDetailPanel("config")}
                  className={`segmented-item ${detailPanel === "config" ? "segmented-item-active" : ""}`}
                >
                  规则配置
                </button>
                <button
                  type="button"
                  onClick={() => setDetailPanel("binding")}
                  className={`segmented-item ${detailPanel === "binding" ? "segmented-item-active" : ""}`}
                >
                  关联绑定
                </button>
              </div>

              {detailPanel === "config" ? (
                <RuleContentEditor
                  form={editForm}
                  updateForm={(updater) => setEditForm((prev) => updater(prev))}
                  disabled={busy}
                />
              ) : (
                <div className="console-scroll grid gap-2.5 p-3">
                  <strong className="text-sm">关联信息</strong>
                  <div className="grid gap-2 md:grid-cols-2">
                    <div className="console-scroll p-2.5">
                      <div className="mb-2 font-semibold">已关联项目 ({relations?.project_count ?? 0})</div>
                      {!relations || relations.projects.length === 0 ? (
                        <div className="text-muted-foreground">暂无项目关联</div>
                      ) : (
                        <div className="grid gap-1.5">
                          {relations.projects.map((project) => (
                            <div key={project.id} className="text-sm leading-6">
                              <div>
                                {project.name} (ID {project.id})
                              </div>
                              <div className="text-xs text-muted-foreground">来源：{relationSourceLabel(project.source)}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="console-scroll p-2.5">
                      <div className="mb-2 font-semibold">已关联 Suite ({relations?.suite_count ?? 0})</div>
                      {!relations || relations.suites.length === 0 ? (
                        <div className="text-muted-foreground">暂无 suite 关联</div>
                      ) : (
                        <div className="grid gap-1.5">
                          {relations.suites.map((suite) => (
                            <div key={suite.id} className="text-sm leading-6">
                              <div>
                                {suite.project_name ? `${suite.project_name} / ` : ""}
                                {suite.name} (ID {suite.id})
                              </div>
                              <div className="text-xs text-muted-foreground">来源：{relationSourceLabel(suite.source)}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="grid gap-2 border-t border-border/70 pt-2">
                    <strong className="text-sm">关联绑定（用于执行时加载规则）</strong>
                    <div className="text-xs leading-relaxed text-muted-foreground">
                      规则会按“项目 + Suite”上下文在执行时自动加载：
                      API 执行会应用 assertion 规则，Agent 评测会应用 scoring 规则。
                    </div>
                    <div className="grid gap-2 md:grid-cols-2">
                      <div className="console-scroll grid gap-2 p-2.5">
                        <strong className="text-sm">选择项目</strong>
                        <div className="console-scroll max-h-[150px] overflow-auto p-2">
                          {projects.length === 0 ? (
                            <div className="text-muted-foreground">暂无可选项目</div>
                          ) : (
                            projects.map((project) => (
                              <label key={project.id} className="mb-1.5 flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={bindProjectIds.includes(project.id)}
                                  onChange={() => setBindProjectIds((prev) => toggleNumber(prev, project.id))}
                                  disabled={bindingBusy}
                                />
                                <span>
                                  {project.name} (ID {project.id})
                                </span>
                              </label>
                            ))
                          )}
                        </div>
                      </div>
                      <div className="console-scroll grid gap-2 p-2.5">
                        <strong className="text-sm">选择 Suite</strong>
                        <select
                          value={suiteProjectFilterId ?? ""}
                          onChange={(event) => setSuiteProjectFilterId(event.target.value ? Number(event.target.value) : null)}
                          disabled={bindingBusy || projects.length === 0}
                        >
                          <option value="">全部项目</option>
                          {projects.map((project) => (
                            <option key={project.id} value={project.id}>
                              {project.name}
                            </option>
                          ))}
                        </select>
                        <div className="console-scroll max-h-[150px] overflow-auto p-2">
                          {visibleSuites.length === 0 ? (
                            <div className="text-muted-foreground">暂无可选 suite</div>
                          ) : (
                            visibleSuites.map((suite) => (
                              <label key={suite.id} className="mb-1.5 flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={bindSuiteIds.includes(suite.id)}
                                  onChange={() => setBindSuiteIds((prev) => toggleNumber(prev, suite.id))}
                                  disabled={bindingBusy}
                                />
                                <span>
                                  {suite.name} (ID {suite.id})
                                </span>
                              </label>
                            ))
                          )}
                        </div>
                      </div>
                    </div>
                    <div>
                      <button
                        type="button"
                        onClick={() => void onSaveBindings()}
                        disabled={bindingBusy || busy}
                        className={secondaryButtonClass}
                      >
                        {bindingBusy ? "保存中..." : "保存关联"}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                <button
                  type="submit"
                  disabled={busy}
                  className={primaryButtonClass}
                >
                  保存修改
                </button>
                <button
                  type="button"
                  onClick={() => void onDuplicateRule()}
                  disabled={busy}
                  className={secondaryButtonClass}
                >
                  复制规则
                </button>
                <button
                  type="button"
                  onClick={() => void onDeleteRule()}
                  disabled={busy}
                  className={dangerButtonClass}
                >
                  删除规则
                </button>
              </div>
            </>
          )}
        </form>
      </div>

      {createModalOpen ? (
        <div className="fixed inset-0 z-[1000] grid place-items-center bg-black/35 p-6 backdrop-blur-sm">
          <form
            onSubmit={(event) => {
              if (tab === "agent_benchmark_rules") {
                event.preventDefault();
                return;
              }
              void onCreateRule(event);
            }}
            className="console-panel grid max-h-[88vh] w-[min(920px,96vw)] gap-2.5 overflow-auto p-[18px]"
          >
            <div className="flex items-center justify-between">
              <strong className="section-title">新建规则</strong>
              <button
                type="button"
                onClick={() => setCreateModalOpen(false)}
                className={secondaryButtonClass}
              >
                关闭
              </button>
            </div>
            {tab === "api_rules" ? (
              <>
                <input
                  value={createForm.name}
                  onChange={(event) =>
                    setCreateForm((prev) => ({
                      ...prev,
                      name: event.target.value,
                    }))
                  }
                  placeholder="规则名称"
                  disabled={busy}
                />
                <div className="grid gap-2 md:grid-cols-2">
                  <select
                    value={createForm.ruleType}
                    onChange={(event) =>
                      setCreateForm((prev) => ({
                        ...prev,
                        ruleType: event.target.value as RuleType,
                      }))
                    }
                    disabled={busy}
                  >
                    {createFormTypeOptions.map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                  <select
                    value={createForm.status}
                    onChange={(event) =>
                      setCreateForm((prev) => ({
                        ...prev,
                        status: event.target.value,
                      }))
                    }
                    disabled={busy}
                  >
                    {statusOptions.map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                </div>
                <input
                  value={createForm.description}
                  onChange={(event) =>
                    setCreateForm((prev) => ({
                      ...prev,
                      description: event.target.value,
                    }))
                  }
                  placeholder="描述（可选）"
                  disabled={busy}
                />
                <RuleContentEditor
                  form={createForm}
                  updateForm={(updater) => setCreateForm((prev) => updater(prev))}
                  disabled={busy}
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setCreateModalOpen(false)}
                    className={secondaryButtonClass}
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    disabled={busy}
                    className={primaryButtonClass}
                  >
                    {busy ? "处理中..." : "创建规则"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="rounded-lg border border-border/70 p-3">
                  <div className="mb-1.5 text-sm font-semibold">根据 Agent 描述创建智能体评价规则</div>
                  <div className="text-xs text-muted-foreground">
                    先选择资产里的 Agent 文档作为描述来源，再按“维度 + 权重”生成规则。
                    系统会创建 1 条规则，并默认绑定所选项目（如选择 suite 则同时绑定 suite）。
                  </div>
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  <select
                    value={agentRuleGeneratorForm.projectId ?? ""}
                    disabled={agentGeneratorBusy}
                    onChange={(event) => {
                      const nextProjectId = event.target.value ? Number(event.target.value) : null;
                      const firstSuiteId = nextProjectId
                        ? suites.find((item) => item.project_id === nextProjectId)?.id ?? null
                        : null;
                      setAgentRuleGeneratorForm((prev) => ({
                        ...prev,
                        projectId: nextProjectId,
                        suiteId: firstSuiteId,
                      }));
                    }}
                  >
                    <option value="">选择项目</option>
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name} (ID {project.id})
                      </option>
                    ))}
                  </select>
                  <select
                    value={agentRuleGeneratorForm.suiteId ?? ""}
                    disabled={agentGeneratorBusy || !agentRuleGeneratorForm.projectId}
                    onChange={(event) =>
                      setAgentRuleGeneratorForm((prev) => ({
                        ...prev,
                        suiteId: event.target.value ? Number(event.target.value) : null,
                      }))
                    }
                  >
                    <option value="">不绑定 suite（可选）</option>
                    {generatorSuites.map((suite) => (
                      <option key={suite.id} value={suite.id}>
                        {suite.name} (ID {suite.id})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  <select
                    value={agentRuleGeneratorForm.sourceAssetId ?? ""}
                    disabled={agentGeneratorBusy || loadingGeneratorAgentDocs || !agentRuleGeneratorForm.projectId}
                    onChange={(event) =>
                      setAgentRuleGeneratorForm((prev) => ({
                        ...prev,
                        sourceAssetId: event.target.value ? Number(event.target.value) : null,
                      }))
                    }
                  >
                    <option value="">
                      {loadingGeneratorAgentDocs ? "加载 Agent 文档中..." : "选择 Agent 描述文档"}
                    </option>
                    {generatorAgentDocs.map((asset) => (
                      <option key={asset.id} value={asset.id}>
                        {asset.name}
                        {asset.file_name ? ` · ${asset.file_name}` : ""}
                      </option>
                    ))}
                  </select>
                  <input
                    value={agentRuleGeneratorForm.userRequirement}
                    onChange={(event) =>
                      setAgentRuleGeneratorForm((prev) => ({
                        ...prev,
                        userRequirement: event.target.value,
                      }))
                    }
                    disabled={agentGeneratorBusy}
                    placeholder="用户要求（可选）"
                  />
                </div>
                <textarea
                  value={extractAgentDescriptionFromAsset(selectedGeneratorAgentDoc)}
                  rows={5}
                  disabled
                  placeholder="将展示所选 Agent 文档内容"
                />
                <div className="console-scroll grid gap-2 p-2.5">
                  <div className="flex items-center justify-between">
                    <strong className="text-sm">规则维度（1条规则包含多个维度与权重）</strong>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={agentGeneratorBusy}
                        onClick={() =>
                          setAgentRuleGeneratorForm((prev) => ({
                            ...prev,
                            dimensionRows: [createGeneratorDimensionRow()],
                          }))
                        }
                        className={`${dangerButtonClass} h-7 px-2 text-[11px]`}
                      >
                        删除全部
                      </button>
                      <button
                        type="button"
                        disabled={agentGeneratorBusy}
                        onClick={() => void onSuggestAgentRuleDimensions()}
                        className={`${secondaryButtonClass} h-7 px-2 text-[11px]`}
                      >
                        {agentRuleSuggestionBusy ? "AI生成中..." : "使用AI生成评价规则"}
                      </button>
                      <button
                        type="button"
                        disabled={agentGeneratorBusy}
                        onClick={() =>
                          setAgentRuleGeneratorForm((prev) => ({
                            ...prev,
                            dimensionRows: [...prev.dimensionRows, createGeneratorDimensionRow()],
                          }))
                        }
                        className={`${secondaryButtonClass} h-7 px-2 text-[11px]`}
                      >
                        新增维度
                      </button>
                    </div>
                  </div>
                  {agentRuleGeneratorForm.dimensionRows.map((dimension, index) => (
                    <div key={dimension.id} className="grid gap-2 md:grid-cols-[1.6fr_0.7fr_auto]">
                      <input
                        value={dimension.name}
                        onChange={(event) =>
                          setAgentRuleGeneratorForm((prev) => ({
                            ...prev,
                            dimensionRows: prev.dimensionRows.map((item, rowIndex) =>
                              rowIndex === index ? { ...item, name: event.target.value } : item
                            ),
                          }))
                        }
                        disabled={agentGeneratorBusy}
                        placeholder="维度名，例如 correctness"
                      />
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={dimension.weight}
                        onChange={(event) =>
                          setAgentRuleGeneratorForm((prev) => ({
                            ...prev,
                            dimensionRows: prev.dimensionRows.map((item, rowIndex) =>
                              rowIndex === index ? { ...item, weight: event.target.value } : item
                            ),
                          }))
                        }
                        disabled={agentGeneratorBusy}
                        placeholder="权重"
                      />
                      <button
                        type="button"
                        disabled={agentGeneratorBusy || agentRuleGeneratorForm.dimensionRows.length <= 1}
                        onClick={() =>
                          setAgentRuleGeneratorForm((prev) => ({
                            ...prev,
                            dimensionRows: prev.dimensionRows.filter((_, rowIndex) => rowIndex !== index),
                          }))
                        }
                        className={`${dangerButtonClass} h-9 px-3 text-xs`}
                      >
                        删除
                      </button>
                    </div>
                  ))}
                </div>
                <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={agentRuleGeneratorForm.withReference}
                    disabled={agentGeneratorBusy}
                    onChange={(event) =>
                      setAgentRuleGeneratorForm((prev) => ({
                        ...prev,
                        withReference: event.target.checked,
                      }))
                    }
                  />
                  启用标准答案模式（with_reference）
                </label>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setCreateModalOpen(false)}
                    className={secondaryButtonClass}
                    disabled={agentGeneratorBusy}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={() => void onGenerateAgentRules()}
                    disabled={agentGeneratorBusy}
                    className={primaryButtonClass}
                  >
                    {agentRuleGenerationBusy ? "处理中..." : "创建规则"}
                  </button>
                </div>
              </>
            )}
          </form>
        </div>
      ) : null}
    </section>
  );
}
