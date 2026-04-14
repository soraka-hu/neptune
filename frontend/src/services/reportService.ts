import { apiClient } from "./apiClient";

type ApiEnvelope<T> = {
  code: number;
  message: string;
  requestId: string;
  data: T;
};

export type RunItemReport = {
  id: number;
  run_id: number;
  case_id?: number | null;
  case_name?: string | null;
  case_display_name?: string | null;
  dataset_item_id?: number | null;
  item_type: string;
  status: string;
  method?: string | null;
  path?: string | null;
  input_summary?: string | null;
  retry_count?: number;
  duration_ms?: number | null;
  request_data?: Record<string, unknown> | null;
  response_data?: Record<string, unknown> | null;
  parsed_output?: Record<string, unknown> | null;
  assertion_result?: Record<string, unknown> | null;
  score_result?: Record<string, unknown> | null;
  benchmark_api_case_id?: number | null;
  benchmark_api_request_case?: Record<string, unknown> | null;
  judge_reason?: string | Array<{ name?: string; reason?: string }> | null;
  error_info?: Record<string, unknown> | null;
  started_at?: string | null;
  finished_at?: string | null;
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

export type RunSummaryReport = {
  runId: number;
  runNo: string;
  runType: string;
  status: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
  };
  versionMetadata?: Record<string, unknown>;
};

export type RunReport = RunSummaryReport & {
  overview?: Record<string, unknown>;
  comparison?: Record<string, unknown> | null;
  detail?: RunDetailReport;
};

export type RunDetailReport = {
  runId: number;
  runNo: string;
  runType?: string;
  status: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
  };
  items: RunItemReport[];
  logs?: RunLogRecord[];
};

export type ProjectDashboardReport = {
  projectId: number;
  projectName: string;
  generatedAt: string;
  api: {
    passRateTrend: Array<{ runId: number; createdAt?: string; passRate: number; failed: number }>;
    failureDistribution: Array<{ name: string; value: number }>;
  };
  benchmark: {
    avgScoreTrend: Array<{ runId: number; createdAt?: string; avgScore: number }>;
    dimensionDistribution: Array<{ dimension: string; avgScore: number }>;
  };
  suites: Array<{ suiteId: number; suiteName: string; passRate: number; avgScore?: number; trend: string }>;
};

export type DashboardV1Filters = {
  projectId?: number | null;
  timeRange?: "7d" | "30d" | "all";
  type?: "all" | "api" | "benchmark";
  environment?: string;
  model?: string;
};

export type DashboardV1Response = {
  projectId: number | null;
  projectName: string;
  generatedAt: string;
  filters: {
    timeRange: "7d" | "30d" | "all";
    type: "all" | "api" | "benchmark";
    environment: string;
    model: string;
  };
  kpis: {
    projectCount: number;
    runCount: number;
    avgPassRate: number;
    avgScore: number;
    apiSuccessRate: number;
    failRate: number;
    p95LatencyMs: number;
    totalCost: number;
  };
  trends: {
    apiPassRate: Array<{ runId: number; createdAt?: string; value: number }>;
    benchmarkScore: Array<{ runId: number; createdAt?: string; value: number }>;
  };
  distributions: {
    failure: Array<{ name: string; value: number }>;
    benchmarkDimensions: Array<{ name: string; value: number }>;
  };
  suites: Array<{ suiteId: number; suiteName: string; projectId?: number; passRate: number; avgScore?: number; trend: string }>;
  projects: Array<{
    projectId: number;
    projectName: string;
    runCount: number;
    avgPassRate: number;
    apiSuccessRate: number;
    avgScore: number;
    failRate: number;
  }>;
};

export type SuiteAnalyticsReport = {
  suiteId: number;
  suiteName: string;
  projectId: number;
  generatedAt: string;
  runHistory: Array<{
    runId: number;
    runType: string;
    status: string;
    createdAt?: string;
    passRate?: number;
    avgScore?: number;
  }>;
  api: {
    topFailedCases: Array<{ caseId: number; caseName: string; failedCount: number }>;
    errorTypeDistribution: Array<{ name: string; value: number }>;
    qualitySummary?: {
      runCount: number;
      itemCount: number;
      failedItemCount: number;
      failedCaseCount: number;
      errorTypeCount: number;
      statusCodeTypeCount: number;
      retryHitCount: number;
      retryRate: number;
      timeoutCount: number;
      timeoutRate: number;
      slowRequestCount: number;
      slowRequestRate: number;
      avgDurationMs: number;
      p95DurationMs: number;
      flakyCaseCount: number;
      slowThresholdMs: number;
    };
    latestRunInsight?: {
      runId: number | null;
      passRate: number;
      failed: number;
      total: number;
    };
    statusCodeDistribution?: Array<{ name: string; value: number }>;
    topSlowCases?: Array<{
      caseId?: number | null;
      caseName: string;
      sampleCount: number;
      avgDurationMs: number;
      p95DurationMs: number;
    }>;
    flakyCases?: Array<{
      caseId?: number;
      caseName: string;
      passCount: number;
      failCount: number;
      flakyIndex: number;
    }>;
  };
  benchmark: {
    dimensionTrend: Array<{ runId: number; dimensions: Array<{ dimension: string; avgScore: number }> }>;
    lowScoreCases: Array<{ runId: number; caseId?: number; caseName: string; score: number }>;
  };
};

export type SuiteMarkdownExport = {
  suiteId: number;
  suiteName: string;
  generatedAt: string;
  fileName: string;
  markdownContent: string;
  summaryMode: "llm" | "fallback";
  model?: string | null;
  llmError?: string | null;
};

export type DashboardMarkdownExport = {
  projectId: number | null;
  projectName: string;
  generatedAt: string;
  filters: {
    projectId?: number | null;
    timeRange?: "7d" | "30d" | "all";
    type?: "all" | "api" | "benchmark";
    environment?: string;
    model?: string;
  };
  fileName: string;
  markdownContent: string;
  summaryMode: "llm" | "fallback";
  model?: string | null;
  llmError?: string | null;
};

export type DashboardImageExport = {
  projectId: number | null;
  generatedAt: string;
  filters: {
    projectId?: number | null;
    timeRange?: "7d" | "30d" | "all";
    type?: "all" | "api" | "benchmark";
    environment?: string;
    model?: string;
  };
  reportPageUrl?: string | null;
  screenshotUrl?: string | null;
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

export function getRunReport(runId: number): Promise<RunReport> {
  return unwrap(apiClient<ApiEnvelope<RunReport>>(`/reports/run/${runId}`));
}

export function getRunDetailReport(runId: number): Promise<RunDetailReport> {
  return unwrap(apiClient<ApiEnvelope<RunDetailReport>>(`/reports/run/${runId}/detail`));
}

export function compareReports(runId1: number, runId2: number) {
  const query = queryString({ runId1, runId2 });
  return unwrap(apiClient<ApiEnvelope<Record<string, unknown>>>(`/reports/compare?${query}`));
}

export function exportRunReport(runId: number) {
  return unwrap(
    apiClient<ApiEnvelope<{ runId: number; reportId: number; fileUrl: string }>>(`/reports/run/${runId}/export`, {
      method: "POST",
    })
  );
}

export function exportRunHtml(runId: number) {
  return unwrap(
    apiClient<ApiEnvelope<{ runId: number; reportId: number; fileUrl: string; contentPreview?: string }>>(
      `/reports/run/${runId}/export-html`,
      {
        method: "POST",
      }
    )
  );
}

export function getProjectDashboardReport(projectId: number): Promise<ProjectDashboardReport> {
  return unwrap(apiClient<ApiEnvelope<ProjectDashboardReport>>(`/reports/project/${projectId}`));
}

export function getDashboardV1(filters: DashboardV1Filters): Promise<DashboardV1Response> {
  const query = queryString({
    projectId: filters.projectId,
    timeRange: filters.timeRange ?? "7d",
    type: filters.type ?? "all",
    environment: filters.environment ?? "all",
    model: filters.model ?? "all",
  });
  return unwrap(apiClient<ApiEnvelope<DashboardV1Response>>(`/reports/dashboard/v1?${query}`));
}

export function exportDashboardV1Markdown(filters: DashboardV1Filters): Promise<DashboardMarkdownExport> {
  const query = queryString({
    projectId: filters.projectId,
    timeRange: filters.timeRange ?? "7d",
    type: filters.type ?? "all",
    environment: filters.environment ?? "all",
    model: filters.model ?? "all",
  });
  return unwrap(
    apiClient<ApiEnvelope<DashboardMarkdownExport>>(`/reports/dashboard/v1/export-markdown?${query}`, {
      method: "POST",
    })
  );
}

export function exportDashboardV1Image(filters: DashboardV1Filters): Promise<DashboardImageExport> {
  const query = queryString({
    projectId: filters.projectId,
    timeRange: filters.timeRange ?? "7d",
    type: filters.type ?? "all",
    environment: filters.environment ?? "all",
    model: filters.model ?? "all",
  });
  return unwrap(
    apiClient<ApiEnvelope<DashboardImageExport>>(`/reports/dashboard/v1/export-image?${query}`, {
      method: "POST",
    })
  );
}

export function getSuiteAnalyticsReport(suiteId: number): Promise<SuiteAnalyticsReport> {
  return unwrap(apiClient<ApiEnvelope<SuiteAnalyticsReport>>(`/reports/suite/${suiteId}`));
}

export function exportSuiteMarkdownReport(suiteId: number): Promise<SuiteMarkdownExport> {
  return unwrap(
    apiClient<ApiEnvelope<SuiteMarkdownExport>>(`/reports/suite/${suiteId}/export-markdown`, {
      method: "POST",
    })
  );
}
