import { apiClient } from "./apiClient";

type ApiEnvelope<T> = {
  code: number;
  message: string;
  requestId: string;
  data: T;
};

type ListData<T> = {
  items: T[];
  total: number;
};

export type PaginatedListData<T> = ListData<T> & {
  page?: number;
  pageSize?: number;
  totalPages?: number;
};

export type RunItemRecord = {
  id: number;
  run_id: number;
  case_id?: number | null;
  dataset_item_id?: number | null;
  item_type: string;
  status: string;
  retry_count?: number;
  duration_ms?: number | null;
  request_data?: Record<string, unknown> | null;
  response_data?: Record<string, unknown> | null;
  parsed_output?: Record<string, unknown> | null;
  assertion_result?: Record<string, unknown> | null;
  score_result?: Record<string, unknown> | null;
  error_info?: Record<string, unknown> | null;
  started_at?: string | null;
  finished_at?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type RunLogRecord = {
  id: number;
  run_id: number;
  run_item_id?: number | null;
  log_level: string;
  log_type: string;
  content: string;
  meta_info?: Record<string, unknown> | null;
  created_at?: string;
};

export type RunRecord = {
  id: number;
  run_no: string;
  project_id: number;
  suite_id?: number | null;
  dataset_id?: number | null;
  run_type: string;
  trigger_type: string;
  source_id?: number | null;
  environment_id?: number | null;
  status: string;
  progress?: number;
  summary?: {
    total?: number;
    passed?: number;
    failed?: number;
    avg_score?: number;
    min_score?: number;
    max_score?: number;
    [key: string]: unknown;
  } | null;
  request_snapshot?: {
    bound_rule_ids?: number[];
    bound_rules?: Array<{
      id?: number;
      name?: string;
      rule_type?: string;
      content?: Record<string, unknown>;
    }>;
    report_delivery?: {
      attempted_at?: string;
      status?: string;
      error?: string | null;
      channel_source?: string | null;
      channel_asset_id?: number | null;
      summary_scope?: string | null;
      summary_mode?: string | null;
      model?: string | null;
      llm_error?: string | null;
      report_page_url?: string | null;
      report_page_screenshot_url?: string | null;
      [key: string]: unknown;
    } | null;
    [key: string]: unknown;
  } | null;
  report_delivery_status?: string;
  report_delivery_error?: string | null;
  report_delivery_attempted_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type RunRulePreviewRule = {
  id: number;
  name: string;
  rule_type: string;
  status: string;
  description?: string | null;
  content: Record<string, unknown>;
};

export type RunRulePreview = {
  run_type: "api_test" | "agent_eval";
  project_id: number;
  suite_id?: number | null;
  strategy_mode: "custom" | "selected_rule" | "binding_auto";
  strategy_description: string;
  rule_types: string[];
  selected_rule_ids: number[];
  selected_rules: RunRulePreviewRule[];
  auto_bound_rules: RunRulePreviewRule[];
  effective_rules: RunRulePreviewRule[];
};

function queryString(params: Record<string, string | number | undefined | null>) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") {
      return;
    }
    search.set(key, String(value));
  });
  return search.toString();
}

async function unwrap<T>(promise: Promise<ApiEnvelope<T>>): Promise<T> {
  const response = await promise;
  if (response.code !== 0) {
    throw new Error(response.message || "请求失败");
  }
  return response.data;
}

export async function listRuns(filters?: {
  projectId?: number;
  suiteId?: number;
  status?: string;
  runType?: string;
  timeRange?: "all" | "24h" | "7d" | "30d";
}): Promise<RunRecord[]> {
  const data = await listRunsPaged(filters);
  return data.items;
}

export async function listRunsPaged(filters?: {
  projectId?: number;
  suiteId?: number;
  status?: string;
  runType?: string;
  timeRange?: "all" | "24h" | "7d" | "30d";
  page?: number;
  pageSize?: number;
  order?: "asc" | "desc";
}): Promise<PaginatedListData<RunRecord>> {
  const query = queryString({
    projectId: filters?.projectId,
    suiteId: filters?.suiteId,
    status: filters?.status,
    runType: filters?.runType,
    timeRange: filters?.timeRange,
    page: filters?.page,
    pageSize: filters?.pageSize,
    order: filters?.order,
  });
  return unwrap(
    apiClient<ApiEnvelope<PaginatedListData<RunRecord>>>(`/runs${query ? `?${query}` : ""}`)
  );
}

export function getRun(runId: number): Promise<RunRecord> {
  return unwrap(apiClient<ApiEnvelope<RunRecord>>(`/runs/${runId}`));
}

export function createApiRun(
  payload: {
    projectId: number;
    suiteId: number;
    environmentId: number;
    ruleIds?: number[];
    triggerType?: string;
  },
  idempotencyKey: string
) {
  return unwrap(
    apiClient<ApiEnvelope<RunRecord>>("/runs/api", {
      method: "POST",
      body: payload,
      headers: {
        "Idempotency-Key": idempotencyKey,
      },
    })
  );
}

export function createRun(
  payload: {
    runType: "api_test" | "benchmark" | "agent_eval";
    projectId: number;
    suiteId: number;
    environmentId: number;
    datasetId?: number;
    scoringRuleId?: number;
    executionRuleId?: number;
    executionConfig?: {
      timeout_ms: number;
      retry_count: number;
      retry_interval_ms: number;
    };
    ruleIds?: number[];
    evaluationMode?: string;
    triggerType?: string;
  },
  idempotencyKey: string
) {
  return unwrap(
    apiClient<ApiEnvelope<RunRecord>>("/runs", {
      method: "POST",
      body: payload,
      headers: {
        "Idempotency-Key": idempotencyKey,
      },
    })
  );
}

export function previewRunRuleBinding(payload: {
  runType: "api_test" | "benchmark" | "agent_eval";
  projectId: number;
  suiteId?: number;
  ruleIds?: number[];
  executionRuleId?: number;
  scoringRuleId?: number;
  executionConfig?: {
    timeout_ms?: number;
    retry_count?: number;
    retry_interval_ms?: number;
    [key: string]: unknown;
  };
}) {
  return unwrap(
    apiClient<ApiEnvelope<RunRulePreview>>("/runs/rule-preview", {
      method: "POST",
      body: payload,
    })
  );
}

export function createAgentEvalRun(
  payload: {
    projectId: number;
    suiteId: number;
    datasetId: number;
    environmentId: number;
    ruleIds?: number[];
    evaluationMode?: string;
    triggerType?: string;
  },
  idempotencyKey: string
) {
  return unwrap(
    apiClient<ApiEnvelope<RunRecord>>("/runs/agent-eval", {
      method: "POST",
      body: payload,
      headers: {
        "Idempotency-Key": idempotencyKey,
      },
    })
  );
}

export function cancelRun(runId: number) {
  return unwrap(
    apiClient<ApiEnvelope<RunRecord>>(`/runs/${runId}/cancel`, {
      method: "POST",
    })
  );
}

export function retryFailedRun(runId: number) {
  return unwrap(
    apiClient<ApiEnvelope<RunRecord>>(`/runs/${runId}/retry-failed`, {
      method: "POST",
    })
  );
}

export function deleteRun(runId: number) {
  return unwrap(
    apiClient<ApiEnvelope<Record<string, never>>>(`/runs/${runId}`, {
      method: "DELETE",
    })
  );
}

export async function listRunItems(runId: number): Promise<RunItemRecord[]> {
  const data = await unwrap(apiClient<ApiEnvelope<ListData<RunItemRecord>>>(`/runs/${runId}/items`));
  return data.items;
}

export async function listRunLogs(runId: number): Promise<RunLogRecord[]> {
  const data = await unwrap(apiClient<ApiEnvelope<ListData<RunLogRecord>>>(`/runs/${runId}/logs`));
  return data.items;
}

export function compareRun(runId: number, targetRunId?: number) {
  const query = queryString({ targetRunId });
  return unwrap(apiClient<ApiEnvelope<Record<string, unknown>>>(`/runs/${runId}/compare${query ? `?${query}` : ""}`));
}
