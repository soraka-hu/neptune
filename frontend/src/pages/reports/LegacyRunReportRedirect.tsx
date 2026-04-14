import { Navigate, useParams } from "react-router-dom";

export function LegacyRunReportRedirect() {
  const params = useParams();
  const runId = params.runId;
  if (runId) {
    return <Navigate to={`/reports/run?runId=${runId}`} replace />;
  }
  return <Navigate to="/reports/run" replace />;
}
