import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";

import { AppLayout } from "./layout/AppLayout";
import { AssetsCenter } from "./pages/assets/AssetsCenter";
import { CaseEditPage } from "./pages/cases/CaseEditPage";
import { ExecutionRunBuilderPage } from "./pages/execution/RunBuilderPage";
import { ExecutionRunDetailPage } from "./pages/execution/RunDetailPage";
import { ExecutionRunListPage } from "./pages/execution/RunListPage";
import { ExecutionScheduleTaskPage } from "./pages/execution/ScheduleTaskPage";
import { EnvironmentConfigPage } from "./pages/environment/EnvironmentConfigPage";
import { GenerationDataCenter } from "./pages/generation/GenerationDataCenter";
import { CompareReportPage } from "./pages/reports/CompareReportPage";
import { LegacyRunReportRedirect } from "./pages/reports/LegacyRunReportRedirect";
import { ProjectDashboardPage } from "./pages/reports/ProjectDashboardPage";
import { RunReportPage } from "./pages/reports/RunReportPage";
import { SuiteAnalyticsPage } from "./pages/reports/SuiteAnalyticsPage";
import { RulesCenter } from "./pages/rules/RulesCenter";

function LegacyExecutionDetailRedirect() {
  const location = useLocation();
  const query = new URLSearchParams(location.search);
  const runId = query.get("runId");
  const target = runId ? `/results/detail?runId=${encodeURIComponent(runId)}` : "/results/detail";
  return <Navigate to={target} replace />;
}

function LegacyExecutionRunsRedirect() {
  const location = useLocation();
  const query = new URLSearchParams(location.search);
  if (query.get("tab") === "detail") {
    const runId = query.get("runId");
    const target = runId ? `/results/detail?runId=${encodeURIComponent(runId)}` : "/results/detail";
    return <Navigate to={target} replace />;
  }

  const passthrough = new URLSearchParams();
  const passthroughKeys = ["projectId", "suiteId", "runType", "status", "timeRange", "runId"];
  passthroughKeys.forEach((key) => {
    const value = query.get(key);
    if (value) {
      passthrough.set(key, value);
    }
  });
  const search = passthrough.toString();
  const target = search ? `/results/list?${search}` : "/results/list";
  return <Navigate to={target} replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/reports/project-capture" element={<ProjectDashboardPage />} />
        <Route element={<AppLayout />}>
          <Route index element={<Navigate to="/assets" replace />} />
          <Route path="/assets" element={<AssetsCenter defaultTab="prd_agent_docs" />} />
          <Route path="/assets/channels" element={<AssetsCenter defaultTab="report_channels" hideTabNavigation />} />
          <Route path="/assets/center" element={<Navigate to="/assets" replace />} />
          <Route path="/generation" element={<GenerationDataCenter />} />
          <Route path="/assets/cases/:caseId/edit" element={<CaseEditPage />} />
          <Route path="/rules" element={<Navigate to="/rules/api" replace />} />
          <Route path="/rules/api" element={<RulesCenter key="rules-api" mode="api_rules" />} />
          <Route path="/rules/agent-benchmark" element={<RulesCenter key="rules-agent-benchmark" mode="agent_benchmark_rules" />} />
          <Route path="/execution" element={<Navigate to="/execution/builder" replace />} />
          <Route path="/execution/builder" element={<ExecutionRunBuilderPage />} />
          <Route path="/execution/runs" element={<LegacyExecutionRunsRedirect />} />
          <Route path="/execution/schedules" element={<ExecutionScheduleTaskPage />} />
          <Route path="/execution/detail" element={<LegacyExecutionDetailRedirect />} />
          <Route path="/results" element={<Navigate to="/results/list" replace />} />
          <Route path="/results/list" element={<ExecutionRunListPage />} />
          <Route path="/results/detail" element={<ExecutionRunDetailPage />} />
          <Route path="/config/environment" element={<EnvironmentConfigPage />} />
          <Route path="/reports" element={<Navigate to="/reports/project" replace />} />
          <Route path="/reports/project" element={<ProjectDashboardPage />} />
          <Route path="/reports/suite" element={<SuiteAnalyticsPage />} />
          <Route path="/reports/compare" element={<CompareReportPage />} />
          <Route path="/reports/run" element={<RunReportPage />} />
          <Route path="/reports/runs/:runId" element={<LegacyRunReportRedirect />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
