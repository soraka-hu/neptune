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

type SortOrder = "asc" | "desc";

export type ProjectRecord = {
  id: number;
  name: string;
  project_key: string;
  description?: string | null;
  project_type: string;
  status: string;
  created_at?: string;
  updated_at?: string;
};

export type SuiteRecord = {
  id: number;
  project_id: number;
  name: string;
  description?: string | null;
  suite_type: string;
  status: string;
  version?: number;
  created_at?: string;
  updated_at?: string;
};

export type SuiteAssetOverviewRecord = {
  id: number;
  project_id: number;
  name: string;
  suite_type: string;
  status: string;
  updated_at?: string;
  case_type: "api" | "agent" | string;
  case_count: number;
  source_summary?: string;
  last_generated_at?: string | null;
  last_generation_batch_id?: string | null;
  last_case_updated_at?: string | null;
  linked_prd_doc_id?: number | null;
  linked_prd_doc_name?: string | null;
  linked_api_doc_id?: number | null;
  linked_api_doc_name?: string | null;
  linked_source_doc_id?: number | null;
  linked_source_doc_name?: string | null;
  generation_method?: string | null;
};

export type CaseRecord = {
  id: number;
  project_id: number;
  suite_id: number | null;
  name: string;
  description?: string | null;
  case_type: string;
  source_type?: string;
  status: string;
  priority?: string;
  input_payload?: Record<string, unknown>;
  expected_output?: Record<string, unknown> | null;
  assertion_config?: Record<string, unknown> | null;
  eval_config?: Record<string, unknown> | null;
  meta_info?: Record<string, unknown> | null;
  created_at?: string;
  updated_at?: string;
};

export type DatasetRecord = {
  id: number;
  project_id: number;
  name: string;
  dataset_type: string;
  generation_config?: Record<string, unknown> | null;
  status: string;
};

export type EnvironmentRecord = {
  id: number;
  project_id: number;
  name: string;
  env_type: string;
  base_url?: string | null;
  headers?: Record<string, unknown> | null;
  variables?: Record<string, unknown> | null;
  secrets_ref?: Record<string, unknown> | null;
  status: string;
  created_at?: string;
  updated_at?: string;
};

export type UserAssetRecord = {
  id: number;
  project_id: number;
  suite_id?: number | null;
  asset_type: string;
  name: string;
  file_name?: string | null;
  content_text?: string | null;
  content_json?: Record<string, unknown> | null;
  meta_info?: Record<string, unknown> | null;
  status: string;
  created_at?: string;
  updated_at?: string;
};

export type ModelConfigRecord = UserAssetRecord & {
  provider: string;
  base_url?: string;
  api_key?: string;
  model?: string;
  project_ids: number[];
};

export type DatasetGenerationPayload = {
  projectId: number;
  datasetId: number;
  datasetName: string;
  datasetType: string;
  count: number;
  prompt?: string;
};

async function unwrap<T>(promise: Promise<ApiEnvelope<T>>): Promise<T> {
  const response = await promise;
  if (response.code !== 0) {
    throw new Error(response.message || "请求失败");
  }
  return response.data;
}

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

export async function listProjects(): Promise<ProjectRecord[]> {
  const data = await listProjectsPaged();
  return data.items;
}

export async function listProjectsPaged(options?: {
  page?: number;
  pageSize?: number;
  order?: SortOrder;
}): Promise<PaginatedListData<ProjectRecord>> {
  const query = queryString({
    page: options?.page,
    pageSize: options?.pageSize,
    order: options?.order,
  });
  return unwrap(apiClient<ApiEnvelope<PaginatedListData<ProjectRecord>>>(`/projects${query ? `?${query}` : ""}`));
}

export function getProject(projectId: number): Promise<ProjectRecord> {
  return unwrap(apiClient<ApiEnvelope<ProjectRecord>>(`/projects/${projectId}`));
}

export function createProject(payload: {
  name: string;
  projectType: string;
  description?: string;
}) {
  return unwrap(
    apiClient<ApiEnvelope<ProjectRecord>>("/projects", {
      method: "POST",
      body: payload,
    })
  );
}

export function updateProject(
  projectId: number,
  payload: {
    name?: string;
    projectType?: string;
    description?: string;
    status?: string;
  }
) {
  return unwrap(
    apiClient<ApiEnvelope<ProjectRecord>>(`/projects/${projectId}`, {
      method: "PUT",
      body: payload,
    })
  );
}

export function archiveProject(projectId: number) {
  return unwrap(
    apiClient<ApiEnvelope<ProjectRecord>>(`/projects/${projectId}/archive`, {
      method: "POST",
    })
  );
}

export async function listSuites(projectId: number): Promise<SuiteRecord[]> {
  const data = await listSuitesPaged(projectId);
  return data.items;
}

export async function listSuitesPaged(
  projectId: number,
  options?: {
    suiteType?: string;
    page?: number;
    pageSize?: number;
    order?: SortOrder;
  }
): Promise<PaginatedListData<SuiteRecord>> {
  const query = queryString({
    projectId,
    suiteType: options?.suiteType,
    page: options?.page,
    pageSize: options?.pageSize,
    order: options?.order,
  });
  return unwrap(apiClient<ApiEnvelope<PaginatedListData<SuiteRecord>>>(`/suites?${query}`));
}

export async function listSuiteAssetOverview(
  projectId: number,
  caseType: "api" | "agent"
): Promise<SuiteAssetOverviewRecord[]> {
  const query = queryString({ projectId, caseType });
  const data = await unwrap(
    apiClient<ApiEnvelope<ListData<SuiteAssetOverviewRecord>>>(`/suite-asset-overview?${query}`)
  );
  return data.items;
}

export function getSuite(suiteId: number): Promise<SuiteRecord> {
  return unwrap(apiClient<ApiEnvelope<SuiteRecord>>(`/suites/${suiteId}`));
}

export function createSuite(payload: {
  projectId: number;
  name: string;
  suiteType: string;
  description?: string;
}) {
  return unwrap(
    apiClient<ApiEnvelope<SuiteRecord>>("/suites", {
      method: "POST",
      body: payload,
    })
  );
}

export function updateSuite(
  suiteId: number,
  payload: {
    name?: string;
    description?: string;
    suiteType?: string;
    status?: string;
    tags?: Record<string, unknown>;
  }
) {
  return unwrap(
    apiClient<ApiEnvelope<SuiteRecord>>(`/suites/${suiteId}`, {
      method: "PUT",
      body: payload,
    })
  );
}

export function deleteSuite(suiteId: number) {
  return unwrap(
    apiClient<ApiEnvelope<SuiteRecord>>(`/suites/${suiteId}`, {
      method: "DELETE",
    })
  );
}

export async function listCases(
  projectId: number,
  suiteId?: number,
  caseType?: string
): Promise<CaseRecord[]> {
  const query = queryString({
    projectId,
    suiteId,
    caseType,
  });
  const data = await unwrap(
    apiClient<ApiEnvelope<ListData<CaseRecord>>>(`/cases?${query}`)
  );
  return data.items;
}

export async function getCase(caseId: number): Promise<CaseRecord> {
  return unwrap(apiClient<ApiEnvelope<CaseRecord>>(`/cases/${caseId}`));
}

export function createCase(payload: {
  projectId: number;
  suiteId?: number;
  name: string;
  description?: string;
  caseType: "api" | "agent" | string;
  inputPayload: Record<string, unknown>;
  expectedOutput?: Record<string, unknown>;
  evalConfig?: Record<string, unknown>;
  assertionConfig?: Record<string, unknown>;
  priority?: string;
  sourceType?: string;
  status?: string;
  metaInfo?: Record<string, unknown>;
}) {
  return unwrap(
    apiClient<ApiEnvelope<CaseRecord>>("/cases", {
      method: "POST",
      body: payload,
    })
  );
}

export function generateApiCases(payload: {
  projectId: number;
  suiteId: number;
  prdDocAssetId: number;
  apiDocAssetId?: number;
  count: number;
  coverage: string;
  featureDesc?: string;
  model?: string;
}) {
  return unwrap(
    apiClient<
      ApiEnvelope<{
        batch_id: string;
        batch_asset_id: number;
        generated_count: number;
        case_ids: number[];
        cases: CaseRecord[];
        generation?: Record<string, unknown>;
      }>
    >("/case-generation/generate", {
      method: "POST",
      body: payload,
    })
  );
}

export function generateAgentDataset(payload: {
  projectId: number;
  suiteId: number;
  sourceDocAssetId: number;
  apiDocAssetId?: number;
  count: number;
  withReference: boolean;
  dimensions: string[];
  model?: string;
}) {
  return unwrap(
    apiClient<
      ApiEnvelope<{
        batch_id: string;
        batch_asset_id: number;
        dataset_id: number;
        generated_count: number;
        case_ids: number[];
        api_case_ids?: number[];
        api_generated_count?: number;
        dataset_item_ids: number[];
        generated_rule_ids: number[];
        generation?: Record<string, unknown>;
        rule_generation?: Record<string, unknown> | null;
      }>
    >("/case-generation/generate-agent-dataset", {
      method: "POST",
      body: payload,
    })
  );
}

export function generateApiCasesFromBenchmarkDataset(payload: {
  projectId: number;
  suiteId: number;
  datasetId: number;
  apiDocAssetId: number;
  model?: string;
}) {
  return unwrap(
    apiClient<
      ApiEnvelope<{
        batch_id: string;
        batch_asset_id: number;
        dataset_id: number;
        source_item_count: number;
        generated_count: number;
        case_ids: number[];
        cases: CaseRecord[];
        operation?: Record<string, unknown>;
      }>
    >("/case-generation/generate-api-from-benchmark-dataset", {
      method: "POST",
      body: payload,
    })
  );
}

export function updateCase(
  caseId: number,
  payload: {
    suiteId?: number | null;
    name?: string;
    description?: string;
    caseType?: "api" | "agent" | string;
    sourceType?: string;
    status?: string;
    priority?: string;
    inputPayload?: Record<string, unknown>;
    expectedOutput?: Record<string, unknown>;
    assertionConfig?: Record<string, unknown>;
    evalConfig?: Record<string, unknown>;
  }
) {
  return unwrap(
    apiClient<ApiEnvelope<CaseRecord>>(`/cases/${caseId}`, {
      method: "PUT",
      body: payload,
    })
  );
}

export function deleteCase(caseId: number) {
  return unwrap(
    apiClient<ApiEnvelope<CaseRecord>>(`/cases/${caseId}`, {
      method: "DELETE",
    })
  );
}

export function changeCaseStatus(caseId: number, status: string) {
  return unwrap(
    apiClient<ApiEnvelope<CaseRecord>>(`/cases/${caseId}/status`, {
      method: "POST",
      body: { status },
    })
  );
}

export async function listDatasets(projectId: number): Promise<DatasetRecord[]> {
  const query = queryString({ projectId });
  const data = await unwrap(
    apiClient<ApiEnvelope<ListData<DatasetRecord>>>(`/datasets?${query}`)
  );
  return data.items;
}

export function createDataset(payload: {
  projectId: number;
  name: string;
  datasetType: string;
  description?: string;
}) {
  return unwrap(
    apiClient<ApiEnvelope<DatasetRecord>>("/datasets", {
      method: "POST",
      body: payload,
    })
  );
}

export function getDataset(datasetId: number): Promise<DatasetRecord> {
  return unwrap(apiClient<ApiEnvelope<DatasetRecord>>(`/datasets/${datasetId}`));
}

export function updateDataset(
  datasetId: number,
  payload: {
    name?: string;
    description?: string;
    datasetType?: string;
    schemaDefinition?: Record<string, unknown>;
    generationConfig?: Record<string, unknown>;
    status?: string;
    version?: number;
  }
) {
  return unwrap(
    apiClient<ApiEnvelope<DatasetRecord>>(`/datasets/${datasetId}`, {
      method: "PUT",
      body: payload,
    })
  );
}

export function deleteDataset(datasetId: number) {
  return unwrap(
    apiClient<ApiEnvelope<DatasetRecord>>(`/datasets/${datasetId}`, {
      method: "DELETE",
    })
  );
}

export function importDatasetItems(
  datasetId: number,
  items: Array<Record<string, unknown>>
) {
  return unwrap(
    apiClient<ApiEnvelope<{ items: Array<Record<string, unknown>>; total: number }>>(
      `/datasets/${datasetId}/items/import`,
      {
        method: "POST",
        body: { items },
      }
    )
  );
}

export function generateDataset(payload: DatasetGenerationPayload) {
  return unwrap(
    apiClient<ApiEnvelope<{ taskId: string }>>("/datasets/generate", {
      method: "POST",
      body: payload,
    })
  );
}

export async function listEnvironments(projectId?: number): Promise<EnvironmentRecord[]> {
  const data = await listEnvironmentsPaged({ projectId });
  return data.items;
}

export async function listEnvironmentsPaged(options?: {
  projectId?: number;
  envType?: string;
  keyword?: string;
  page?: number;
  pageSize?: number;
  order?: SortOrder;
}): Promise<PaginatedListData<EnvironmentRecord>> {
  const query = queryString({
    projectId: options?.projectId,
    envType: options?.envType,
    keyword: options?.keyword,
    page: options?.page,
    pageSize: options?.pageSize,
    order: options?.order,
  });
  return unwrap(apiClient<ApiEnvelope<PaginatedListData<EnvironmentRecord>>>(`/environments${query ? `?${query}` : ""}`));
}

export function createEnvironment(payload: {
  projectId: number;
  name: string;
  envType: string;
  baseUrl?: string;
  headers?: Record<string, unknown>;
  variables?: Record<string, unknown>;
  secretsRef?: Record<string, unknown>;
  status?: string;
}) {
  return unwrap(
    apiClient<ApiEnvelope<EnvironmentRecord>>("/environments", {
      method: "POST",
      body: payload,
    })
  );
}

export function updateEnvironment(
  environmentId: number,
  payload: {
    projectId?: number;
    name?: string;
    envType?: string;
    baseUrl?: string;
    headers?: Record<string, unknown>;
    variables?: Record<string, unknown>;
    secretsRef?: Record<string, unknown>;
    status?: string;
  }
) {
  return unwrap(
    apiClient<ApiEnvelope<EnvironmentRecord>>(`/environments/${environmentId}`, {
      method: "PUT",
      body: payload,
    })
  );
}

export function deleteEnvironment(environmentId: number) {
  return unwrap(
    apiClient<ApiEnvelope<EnvironmentRecord>>(`/environments/${environmentId}`, {
      method: "DELETE",
    })
  );
}

export async function listUserAssets(
  projectId?: number,
  suiteId?: number,
  assetType?: string,
  status?: string
): Promise<UserAssetRecord[]> {
  const data = await listUserAssetsPaged({ projectId, suiteId, assetType, status });
  return data.items;
}

export async function listUserAssetsPaged(options?: {
  projectId?: number;
  suiteId?: number;
  assetType?: string;
  status?: string;
  page?: number;
  pageSize?: number;
  order?: SortOrder;
}): Promise<PaginatedListData<UserAssetRecord>> {
  const query = queryString({
    projectId: options?.projectId,
    suiteId: options?.suiteId,
    assetType: options?.assetType,
    status: options?.status,
    page: options?.page,
    pageSize: options?.pageSize,
    order: options?.order,
  });
  return unwrap(apiClient<ApiEnvelope<PaginatedListData<UserAssetRecord>>>(`/user-assets${query ? `?${query}` : ""}`));
}

export function createUserAsset(payload: {
  projectId: number;
  suiteId?: number | null;
  assetType: string;
  name: string;
  fileName?: string;
  contentText?: string;
  fileBase64?: string;
  contentJson?: Record<string, unknown>;
  metaInfo?: Record<string, unknown>;
  status?: string;
}) {
  return unwrap(
    apiClient<ApiEnvelope<UserAssetRecord>>("/user-assets", {
      method: "POST",
      body: payload,
    })
  );
}

export function updateUserAsset(
  assetId: number,
  payload: {
    projectId?: number;
    suiteId?: number | null;
    assetType?: string;
    name?: string;
    fileName?: string;
    contentText?: string;
    contentJson?: Record<string, unknown>;
    metaInfo?: Record<string, unknown>;
    status?: string;
  }
) {
  return unwrap(
    apiClient<ApiEnvelope<UserAssetRecord>>(`/user-assets/${assetId}`, {
      method: "PUT",
      body: payload,
    })
  );
}

export function deleteUserAsset(assetId: number) {
  return unwrap(
    apiClient<ApiEnvelope<UserAssetRecord>>(`/user-assets/${assetId}`, {
      method: "DELETE",
    })
  );
}

function toModelConfigRecord(asset: UserAssetRecord): ModelConfigRecord {
  const content =
    typeof asset.content_json === "object" && asset.content_json !== null && !Array.isArray(asset.content_json)
      ? asset.content_json
      : {};
  const meta =
    typeof asset.meta_info === "object" && asset.meta_info !== null && !Array.isArray(asset.meta_info)
      ? asset.meta_info
      : {};
  const projectIdsFromMeta = Array.isArray(meta.project_ids)
    ? meta.project_ids
        .map((item) => Number(item))
        .filter((item) => Number.isInteger(item) && item > 0)
    : [];
  const mergedProjectIds = Array.from(new Set([asset.project_id, ...projectIdsFromMeta])).filter(
    (item) => Number.isInteger(item) && item > 0
  );
  return {
    ...asset,
    provider: typeof content.provider === "string" ? content.provider : "openai",
    base_url: typeof content.base_url === "string" ? content.base_url : "",
    api_key: typeof content.api_key === "string" ? content.api_key : "",
    model: typeof content.model === "string" ? content.model : "",
    project_ids: mergedProjectIds,
  };
}

export async function listModelConfigs(projectId?: number): Promise<ModelConfigRecord[]> {
  const items = await listUserAssets(undefined, undefined, "model_config");
  const records = items.map(toModelConfigRecord);
  if (!projectId) {
    return records;
  }
  return records.filter((item) => item.project_ids.includes(projectId));
}

export function createModelConfig(payload: {
  projectId?: number;
  projectIds?: number[];
  name: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  status?: string;
}) {
  const normalizedProjectIds = Array.from(
    new Set((payload.projectIds ?? [payload.projectId]).map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0))
  );
  const primaryProjectId = normalizedProjectIds[0];
  if (!primaryProjectId) {
    throw new Error("请至少选择一个关联项目");
  }
  return createUserAsset({
    projectId: primaryProjectId,
    assetType: "model_config",
    name: payload.name,
    status: payload.status,
    contentJson: {
      provider: payload.provider,
      base_url: payload.baseUrl,
      api_key: payload.apiKey,
      model: payload.model,
    },
    metaInfo: {
      source: "environment_config_center",
      project_ids: normalizedProjectIds,
    },
  }).then(toModelConfigRecord);
}

export function updateModelConfig(
  configId: number,
  payload: {
    projectId?: number;
    projectIds?: number[];
    name?: string;
    provider?: string;
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    status?: string;
  }
) {
  const contentJson: Record<string, unknown> = {};
  if (payload.provider !== undefined) {
    contentJson.provider = payload.provider;
  }
  if (payload.baseUrl !== undefined) {
    contentJson.base_url = payload.baseUrl;
  }
  if (payload.apiKey !== undefined) {
    contentJson.api_key = payload.apiKey;
  }
  if (payload.model !== undefined) {
    contentJson.model = payload.model;
  }
  const normalizedProjectIds =
    payload.projectIds === undefined
      ? undefined
      : Array.from(
          new Set(payload.projectIds.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0))
        );
  if (payload.projectIds !== undefined && (!normalizedProjectIds || normalizedProjectIds.length === 0)) {
    throw new Error("请至少选择一个关联项目");
  }
  return updateUserAsset(configId, {
    projectId: normalizedProjectIds?.[0] ?? payload.projectId,
    name: payload.name,
    status: payload.status,
    contentJson: Object.keys(contentJson).length > 0 ? contentJson : undefined,
    metaInfo:
      normalizedProjectIds !== undefined
        ? {
            source: "environment_config_center",
            project_ids: normalizedProjectIds,
          }
        : undefined,
  }).then(toModelConfigRecord);
}

export function deleteModelConfig(configId: number) {
  return deleteUserAsset(configId).then(toModelConfigRecord);
}
