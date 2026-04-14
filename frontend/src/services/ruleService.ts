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

export type RuleRecord = {
  id: number;
  name: string;
  rule_type: string;
  description?: string | null;
  content: Record<string, unknown>;
  status: string;
  version: number;
  created_at?: string;
  updated_at?: string;
};

export type RuleOverviewRecord = RuleRecord & {
  project_count: number;
  suite_count: number;
};

export type RuleRelationProject = {
  id: number;
  name: string;
  status?: string | null;
  source?: string | null;
};

export type RuleRelationSuite = {
  id: number;
  name: string;
  status?: string | null;
  project_id?: number | null;
  project_name?: string | null;
  source?: string | null;
};

export type RuleRelationsRecord = {
  rule_id: number;
  project_ids: number[];
  suite_ids: number[];
  project_count: number;
  suite_count: number;
  projects: RuleRelationProject[];
  suites: RuleRelationSuite[];
};

export type AgentScoringRuleGenerationResult = {
  project_id: number;
  suite_id?: number | null;
  generated_count: number;
  generated_rule_ids: number[];
  rules: RuleRecord[];
  generation_meta?: {
    mode?: string;
    model?: string;
    llm_error?: string;
    [key: string]: unknown;
  };
};

export type AgentScoringDimensionSuggestionResult = {
  project_id: number;
  suite_id?: number | null;
  count: number;
  dimensions: Array<{
    name: string;
    weight: number;
    description?: string;
  }>;
  generation_meta?: {
    mode?: string;
    model?: string;
    llm_error?: string;
    [key: string]: unknown;
  };
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

export async function listRules(ruleType?: string): Promise<RuleRecord[]> {
  const query = queryString({ ruleType });
  const data = await unwrap(
    apiClient<ApiEnvelope<ListData<RuleRecord>>>(`/rules${query ? `?${query}` : ""}`)
  );
  return data.items;
}

export async function listRuleOverview(ruleTypes?: string[]): Promise<RuleOverviewRecord[]> {
  const query = queryString({ ruleTypes: ruleTypes && ruleTypes.length > 0 ? ruleTypes.join(",") : undefined });
  const data = await unwrap(
    apiClient<ApiEnvelope<ListData<RuleOverviewRecord>>>(`/rules/overview${query ? `?${query}` : ""}`)
  );
  return data.items;
}

export function getRule(ruleId: number): Promise<RuleRecord> {
  return unwrap(apiClient<ApiEnvelope<RuleRecord>>(`/rules/${ruleId}`));
}

export function getRuleRelations(ruleId: number): Promise<RuleRelationsRecord> {
  return unwrap(apiClient<ApiEnvelope<RuleRelationsRecord>>(`/rules/${ruleId}/relations`));
}

export function createRule(payload: {
  name: string;
  ruleType: string;
  description?: string;
  content: Record<string, unknown>;
  status?: string;
}) {
  return unwrap(
    apiClient<ApiEnvelope<RuleRecord>>("/rules", {
      method: "POST",
      body: payload,
    })
  );
}

export function updateRule(
  ruleId: number,
  payload: {
    name?: string;
    ruleType?: string;
    description?: string;
    content?: Record<string, unknown>;
    status?: string;
  }
) {
  return unwrap(
    apiClient<ApiEnvelope<RuleRecord>>(`/rules/${ruleId}`, {
      method: "PUT",
      body: payload,
    })
  );
}

export function deleteRule(ruleId: number) {
  return unwrap(
    apiClient<ApiEnvelope<RuleRecord>>(`/rules/${ruleId}`, {
      method: "DELETE",
    })
  );
}

export function bindRuleProjects(ruleId: number, projectIds: number[]) {
  return unwrap(
    apiClient<ApiEnvelope<{ ruleId: number; projectIds: number[] }>>(`/rules/${ruleId}/bind-projects`, {
      method: "POST",
      body: { projectIds },
    })
  );
}

export function bindRuleSuites(ruleId: number, suiteIds: number[]) {
  return unwrap(
    apiClient<ApiEnvelope<{ ruleId: number; suiteIds: number[] }>>(`/rules/${ruleId}/bind-suites`, {
      method: "POST",
      body: { suiteIds },
    })
  );
}

export function generateAgentScoringRules(payload: {
  projectId: number;
  suiteId?: number;
  agentDescription: string;
  userRequirement?: string;
  dimensions?: string[];
  withReference?: boolean;
  count?: number;
  model?: string;
  ruleNote?: string;
  bindProject?: boolean;
  bindSuite?: boolean;
}) {
  return unwrap(
    apiClient<ApiEnvelope<AgentScoringRuleGenerationResult>>("/rules/generate-agent-scoring", {
      method: "POST",
      body: payload,
    })
  );
}

export function generateAgentScoringDimensions(payload: {
  projectId: number;
  suiteId?: number;
  agentDescription: string;
  userRequirement?: string;
  dimensions?: string[];
  withReference?: boolean;
  count?: number;
  model?: string;
  ruleNote?: string;
}) {
  return unwrap(
    apiClient<ApiEnvelope<AgentScoringDimensionSuggestionResult>>("/rules/generate-agent-dimensions", {
      method: "POST",
      body: payload,
    })
  );
}
