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

export type RunScheduleRecord = {
  id: number;
  name: string;
  run_type: "api_test" | "agent_eval";
  project_id: number;
  suite_id?: number | null;
  environment_id: number;
  dataset_id?: number | null;
  rule_ids?: number[];
  daily_time: string;
  evaluation_mode?: string;
  next_run_at: string;
  last_run_at?: string | null;
  last_run_id?: number | null;
  trigger_count?: number;
  status: "active" | "paused" | "archived";
  meta_info?: Record<string, unknown> | null;
  created_at?: string;
  updated_at?: string;
};

export type ReportDeliveryConfig = {
  enabled: boolean;
  channelAssetId?: number;
  summaryScope?: "project" | "suite";
  includeReportPageScreenshot?: boolean;
};

type TriggerScheduleResult = {
  schedule: RunScheduleRecord;
  run: Record<string, unknown>;
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

export async function listRunSchedules(filters?: {
  projectId?: number;
  suiteId?: number;
  status?: string;
  runType?: string;
}): Promise<RunScheduleRecord[]> {
  const query = queryString({
    projectId: filters?.projectId,
    suiteId: filters?.suiteId,
    status: filters?.status,
    runType: filters?.runType,
  });
  const data = await unwrap(
    apiClient<ApiEnvelope<ListData<RunScheduleRecord>>>(`/run-schedules${query ? `?${query}` : ""}`)
  );
  return data.items;
}

export function createRunSchedule(payload: {
  name: string;
  runType: "api_test" | "benchmark";
  projectId: number;
  suiteId?: number;
  environmentId: number;
  datasetId?: number;
  ruleIds?: number[];
  dailyTime: string;
  evaluationMode?: string;
  nextRunAt?: string;
  reportDelivery?: ReportDeliveryConfig;
}) {
  return unwrap(
    apiClient<ApiEnvelope<RunScheduleRecord>>("/run-schedules", {
      method: "POST",
      body: payload,
    })
  );
}

export function updateRunSchedule(
  scheduleId: number,
  payload: {
    name?: string;
    runType?: "api_test" | "benchmark";
    projectId?: number;
    suiteId?: number;
    environmentId?: number;
    datasetId?: number;
    ruleIds?: number[];
    dailyTime?: string;
    evaluationMode?: string;
    nextRunAt?: string;
    reportDelivery?: ReportDeliveryConfig;
    status?: "active" | "paused" | "archived";
  }
) {
  return unwrap(
    apiClient<ApiEnvelope<RunScheduleRecord>>(`/run-schedules/${scheduleId}`, {
      method: "PUT",
      body: payload,
    })
  );
}

export function setRunScheduleStatus(scheduleId: number, status: "active" | "paused") {
  return unwrap(
    apiClient<ApiEnvelope<RunScheduleRecord>>(`/run-schedules/${scheduleId}/status`, {
      method: "POST",
      body: { status },
    })
  );
}

export function triggerRunSchedule(scheduleId: number, triggerType: "manual" | "scheduled" = "manual") {
  return unwrap(
    apiClient<ApiEnvelope<TriggerScheduleResult>>(`/run-schedules/${scheduleId}/trigger`, {
      method: "POST",
      body: { triggerType },
    })
  );
}

export function deleteRunSchedule(scheduleId: number) {
  return unwrap(
    apiClient<ApiEnvelope<Record<string, never>>>(`/run-schedules/${scheduleId}`, {
      method: "DELETE",
    })
  );
}
