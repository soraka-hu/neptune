import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

import { FloatingNotice, type NoticeTone } from "../../components/FloatingNotice";
import {
  DatasetRecord,
  EnvironmentRecord,
  ProjectRecord,
  SuiteRecord,
  UserAssetRecord,
  listDatasets,
  listEnvironments,
  listProjects,
  listSuites,
  listUserAssets,
} from "../../services/assetService";
import {
  ReportDeliveryConfig,
  RunScheduleRecord,
  createRunSchedule,
  deleteRunSchedule,
  listRunSchedules,
  setRunScheduleStatus,
  triggerRunSchedule,
} from "../../services/runScheduleService";
import { formatDate, panelStyle, runTypeLabel } from "./executionShared";

type ScheduleRunType = "api_test" | "benchmark";

type ScheduleFormState = {
  name: string;
  runType: ScheduleRunType;
  projectId: string;
  suiteId: string;
  environmentId: string;
  datasetId: string;
  dailyTime: string;
  reportChannelAssetId: string;
  includeReportPageScreenshot: boolean;
};

function toPositiveNumber(value: string): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readReportDelivery(schedule: RunScheduleRecord): Record<string, unknown> | null {
  const meta = asRecord(schedule.meta_info);
  if (!meta) {
    return null;
  }
  return asRecord(meta.report_delivery);
}

function formatReportDelivery(schedule: RunScheduleRecord): string {
  const config = readReportDelivery(schedule);
  if (!config || !Boolean(config.enabled)) {
    return "未开启";
  }
  const scope = config.summary_scope === "suite" ? "Suite" : "项目";
  if (typeof config.channel_asset_id === "number" && config.channel_asset_id > 0) {
    return `飞书（资产 #${config.channel_asset_id}，${scope}）`;
  }
  return "未开启";
}

export function ExecutionScheduleTaskPage() {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [suites, setSuites] = useState<SuiteRecord[]>([]);
  const [environments, setEnvironments] = useState<EnvironmentRecord[]>([]);
  const [datasets, setDatasets] = useState<DatasetRecord[]>([]);
  const [reportChannels, setReportChannels] = useState<UserAssetRecord[]>([]);
  const [schedules, setSchedules] = useState<RunScheduleRecord[]>([]);

  const [form, setForm] = useState<ScheduleFormState>({
    name: "",
    runType: "api_test",
    projectId: "",
    suiteId: "",
    environmentId: "",
    datasetId: "",
    dailyTime: "09:00",
    reportChannelAssetId: "",
    includeReportPageScreenshot: true,
  });

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: NoticeTone; text: string } | null>(null);
  const createScheduleLockRef = useRef(false);

  const scheduleProjectMap = useMemo(() => new Map(projects.map((item) => [item.id, item.name])), [projects]);
  const scheduleSuiteMap = useMemo(() => new Map(suites.map((item) => [item.id, item.name])), [suites]);

  const benchmarkDatasets = useMemo(() => {
    if (!form.suiteId) {
      return datasets;
    }
    const suite = suites.find((item) => item.id === Number(form.suiteId));
    if (!suite) {
      return datasets;
    }
    const prefix = `${suite.name}-agent-dataset`;
    const matched = datasets.filter((dataset) => dataset.name.startsWith(prefix));
    return matched.length > 0 ? matched : datasets;
  }, [datasets, form.suiteId, suites]);

  async function refreshSchedules(projectId?: number) {
    const items = await listRunSchedules({ projectId });
    setSchedules(items.slice().sort((a, b) => a.id - b.id));
  }

  async function loadProjectAssets(projectId: number) {
    const [suiteItems, envItems, datasetItems, channelItems] = await Promise.all([
      listSuites(projectId),
      listEnvironments(projectId),
      listDatasets(projectId),
      listUserAssets(undefined, undefined, "report_channel", "active"),
    ]);
    setSuites(suiteItems);
    setEnvironments(envItems);
    setDatasets(datasetItems);
    setReportChannels(channelItems);
    setForm((prev) => ({
      ...prev,
      suiteId: prev.suiteId && suiteItems.some((item) => String(item.id) === prev.suiteId) ? prev.suiteId : "",
      environmentId: envItems.some((item) => String(item.id) === prev.environmentId)
        ? prev.environmentId
        : String(envItems[0]?.id ?? ""),
      datasetId: datasetItems.some((item) => String(item.id) === prev.datasetId) ? prev.datasetId : String(datasetItems[0]?.id ?? ""),
      reportChannelAssetId: channelItems.some((item) => String(item.id) === prev.reportChannelAssetId)
        ? prev.reportChannelAssetId
        : "",
    }));
  }

  async function refreshAll() {
    setLoading(true);
    try {
      const projectItems = await listProjects();
      setProjects(projectItems);
      const defaultProjectId = form.projectId ? Number(form.projectId) : projectItems[0]?.id;
      if (defaultProjectId) {
        await Promise.all([loadProjectAssets(defaultProjectId), refreshSchedules(defaultProjectId)]);
        setForm((prev) => ({
          ...prev,
          projectId: String(defaultProjectId),
        }));
      } else {
        setSuites([]);
        setEnvironments([]);
        setDatasets([]);
        setReportChannels([]);
        setSchedules([]);
      }
      setNotice(null);
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "加载定时任务失败",
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!form.projectId) {
      setSuites([]);
      setEnvironments([]);
      setDatasets([]);
      setReportChannels([]);
      setSchedules([]);
      return;
    }
    const projectId = Number(form.projectId);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return;
    }
    void Promise.all([loadProjectAssets(projectId), refreshSchedules(projectId)]).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.projectId]);

  useEffect(() => {
    if (form.runType !== "benchmark") {
      return;
    }
    if (form.datasetId && benchmarkDatasets.some((item) => String(item.id) === form.datasetId)) {
      return;
    }
    setForm((prev) => ({ ...prev, datasetId: String(benchmarkDatasets[0]?.id ?? "") }));
  }, [form.runType, form.datasetId, benchmarkDatasets]);

  async function onCreateSchedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const projectId = toPositiveNumber(form.projectId);
    const suiteId = toPositiveNumber(form.suiteId);
    const environmentId = toPositiveNumber(form.environmentId);
    const datasetId = toPositiveNumber(form.datasetId);
    const reportChannelAssetId = toPositiveNumber(form.reportChannelAssetId);
    const dailyTime = form.dailyTime.trim();

    if (!projectId || !environmentId || !dailyTime) {
      setNotice({ tone: "error", text: "请完整选择项目、环境与每日执行时间" });
      return;
    }
    if (form.runType === "benchmark" && !datasetId) {
      setNotice({ tone: "error", text: "benchmark 定时任务需要选择数据集" });
      return;
    }
    const shouldSendReport = Boolean(reportChannelAssetId);
    const reportSummaryScope: "project" | "suite" = suiteId ? "suite" : "project";

    let reportDelivery: ReportDeliveryConfig | undefined;
    reportDelivery = {
      enabled: shouldSendReport,
      channelAssetId: shouldSendReport ? reportChannelAssetId ?? undefined : undefined,
      summaryScope: shouldSendReport ? reportSummaryScope : undefined,
      includeReportPageScreenshot: shouldSendReport ? form.includeReportPageScreenshot : undefined,
    };

    if (createScheduleLockRef.current) {
      return;
    }
    createScheduleLockRef.current = true;
    setBusy(true);
    try {
      await createRunSchedule({
        name: form.name.trim() || `${form.runType === "api_test" ? "API" : "Benchmark"} 定时任务`,
        runType: form.runType,
        projectId,
        suiteId: suiteId ?? undefined,
        environmentId,
        datasetId: form.runType === "benchmark" ? datasetId ?? undefined : undefined,
        dailyTime,
        reportDelivery,
      });
      await Promise.all([refreshSchedules(projectId), loadProjectAssets(projectId)]);
      setForm((prev) => ({
        ...prev,
        name: "",
      }));
      setNotice({ tone: "success", text: "定时任务已创建" });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "创建定时任务失败",
      });
    } finally {
      createScheduleLockRef.current = false;
      setBusy(false);
    }
  }

  async function onToggleStatus(schedule: RunScheduleRecord) {
    setBusy(true);
    try {
      const nextStatus = schedule.status === "active" ? "paused" : "active";
      await setRunScheduleStatus(schedule.id, nextStatus);
      await refreshSchedules(schedule.project_id);
      setNotice({
        tone: "success",
        text: `任务 #${schedule.id} 已${nextStatus === "active" ? "启用" : "暂停"}`,
      });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "更新任务状态失败",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onTriggerNow(schedule: RunScheduleRecord) {
    setBusy(true);
    try {
      const result = await triggerRunSchedule(schedule.id);
      await refreshSchedules(schedule.project_id);
      setNotice({
        tone: "success",
        text: `任务 #${schedule.id} 已触发，Run #${result.run.id ?? "-"}`,
      });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "触发任务失败",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteSchedule(schedule: RunScheduleRecord) {
    if (!window.confirm(`确认删除定时任务 #${schedule.id} 吗？`)) {
      return;
    }
    setBusy(true);
    try {
      await deleteRunSchedule(schedule.id);
      await refreshSchedules(schedule.project_id);
      setNotice({ tone: "success", text: `任务 #${schedule.id} 已删除` });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "删除任务失败",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="execution-page grid gap-4">
      <FloatingNotice notice={notice} onClose={() => setNotice(null)} />
      <header className="grid gap-2">
        <h2 className="page-title m-0">定时任务</h2>
      </header>

      <section style={panelStyle} className="console-panel grid gap-3">
        <strong className="section-title">新建定时任务</strong>
        <form onSubmit={(event) => void onCreateSchedule(event)} className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            <span>任务名称（可选）</span>
            <input
              value={form.name}
              onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
              placeholder="不填写时自动命名"
            />
          </label>
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            <span>执行类型</span>
            <select
              value={form.runType}
              onChange={(event) =>
                setForm((prev) => ({
                  ...prev,
                  runType: event.target.value as ScheduleRunType,
                }))
              }
            >
              <option value="api_test">api_test</option>
              <option value="benchmark">benchmark</option>
            </select>
          </label>
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            <span>项目</span>
            <select value={form.projectId} onChange={(event) => setForm((prev) => ({ ...prev, projectId: event.target.value }))}>
              <option value="">选择项目</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            <span>每天执行时间（HH:mm）</span>
            <input
              type="time"
              value={form.dailyTime}
              onChange={(event) => setForm((prev) => ({ ...prev, dailyTime: event.target.value }))}
              step={60}
            />
          </label>
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            <span>Suite</span>
            <select value={form.suiteId} onChange={(event) => setForm((prev) => ({ ...prev, suiteId: event.target.value }))}>
              <option value="">全部 Suite（不指定）</option>
              {suites.map((suite) => (
                <option key={suite.id} value={suite.id}>
                  {suite.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            <span>环境</span>
            <select
              value={form.environmentId}
              onChange={(event) => setForm((prev) => ({ ...prev, environmentId: event.target.value }))}
            >
              <option value="">选择环境</option>
              {environments.map((environment) => (
                <option key={environment.id} value={environment.id}>
                  {environment.name}
                </option>
              ))}
            </select>
          </label>
          {form.runType === "benchmark" ? (
            <label className="grid gap-1 text-[11px] text-muted-foreground">
              <span>数据集</span>
              <select value={form.datasetId} onChange={(event) => setForm((prev) => ({ ...prev, datasetId: event.target.value }))}>
                <option value="">选择数据集</option>
                {benchmarkDatasets.map((dataset) => (
                  <option key={dataset.id} value={dataset.id}>
                    {dataset.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            <span>发送报告</span>
            <select
              value={form.reportChannelAssetId}
              onChange={(event) => setForm((prev) => ({ ...prev, reportChannelAssetId: event.target.value }))}
            >
              <option value="">不发送</option>
              {reportChannels.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  {channel.name}
                </option>
              ))}
            </select>
          </label>
          {form.reportChannelAssetId ? (
            <>
              <label className="grid gap-1 text-[11px] text-muted-foreground">
                <span>项目报告页面截图</span>
                <select
                  value={form.includeReportPageScreenshot ? "yes" : "no"}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      includeReportPageScreenshot: event.target.value === "yes",
                    }))
                  }
                >
                  <option value="yes">附加截图</option>
                  <option value="no">不附加</option>
                </select>
              </label>
              <div className="grid gap-1 text-[11px] text-muted-foreground">
                <span>报告范围</span>
                <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-foreground">
                  {form.suiteId ? "当前 Suite（含 API / Benchmark 运行情况）" : "当前项目（含 API / Benchmark 运行情况）"}
                </div>
              </div>
            </>
          ) : null}
          <div className="flex items-center justify-end gap-2 md:col-span-2 xl:col-span-4">
            <button type="button" onClick={() => void refreshAll()} className="console-btn-secondary" disabled={loading || busy}>
              刷新
            </button>
            <button type="submit" className="console-btn-primary" disabled={loading || busy}>
              {busy ? "提交中..." : "创建任务"}
            </button>
          </div>
        </form>
      </section>

      <section style={panelStyle} className="console-panel grid gap-2.5">
        <strong className="section-title">任务列表</strong>
        <div className="overflow-x-auto">
          <table className="min-w-full border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-[0.08em] text-muted-foreground">
                <th className="pb-2 pr-4">ID</th>
                <th className="pb-2 pr-4">名称</th>
                <th className="pb-2 pr-4">类型</th>
                <th className="pb-2 pr-4">项目/Suite</th>
                <th className="pb-2 pr-4">每日执行</th>
                <th className="pb-2 pr-4">报告发送</th>
                <th className="pb-2 pr-4">下次执行</th>
                <th className="pb-2 pr-4">最近执行</th>
                <th className="pb-2 pr-4">状态</th>
                <th className="pb-2 pr-2">操作</th>
              </tr>
            </thead>
            <tbody>
              {schedules.length === 0 ? (
                <tr>
                  <td colSpan={10} className="py-3 text-sm text-muted-foreground">
                    暂无定时任务
                  </td>
                </tr>
              ) : (
                schedules.map((schedule) => (
                  <tr key={schedule.id} className="border-t border-border/80 align-top">
                    <td className="py-2.5 pr-4 font-semibold">#{schedule.id}</td>
                    <td className="py-2.5 pr-4">{schedule.name}</td>
                    <td className="py-2.5 pr-4">{runTypeLabel(schedule.run_type)}</td>
                    <td className="py-2.5 pr-4">
                      {scheduleProjectMap.get(schedule.project_id) ?? `P${schedule.project_id}`} /{" "}
                      {typeof schedule.suite_id === "number"
                        ? (scheduleSuiteMap.get(schedule.suite_id) ?? `S${schedule.suite_id}`)
                        : "全部 Suite"}
                    </td>
                    <td className="py-2.5 pr-4">{schedule.daily_time}</td>
                    <td className="py-2.5 pr-4">{formatReportDelivery(schedule)}</td>
                    <td className="py-2.5 pr-4">{formatDate(schedule.next_run_at)}</td>
                    <td className="py-2.5 pr-4">
                      {formatDate(schedule.last_run_at)}
                      {schedule.last_run_id ? <div className="text-xs text-muted-foreground">Run #{schedule.last_run_id}</div> : null}
                    </td>
                    <td className="py-2.5 pr-4">
                      <span className="status-pill" style={{ padding: "2px 8px" }}>
                        {schedule.status}
                      </span>
                    </td>
                    <td className="py-2.5 pr-2">
                      <div className="max-w-[220px] overflow-x-auto pb-1">
                        <div className="flex w-max flex-nowrap gap-1.5">
                          <button
                            type="button"
                            className="console-btn-secondary whitespace-nowrap text-xs"
                            onClick={() => void onToggleStatus(schedule)}
                            disabled={loading || busy}
                          >
                            {schedule.status === "active" ? "暂停" : "启用"}
                          </button>
                          <button
                            type="button"
                            className="console-btn-secondary whitespace-nowrap text-xs"
                            onClick={() => void onTriggerNow(schedule)}
                            disabled={loading || busy}
                          >
                            立即执行
                          </button>
                          <button
                            type="button"
                            className="console-btn-danger whitespace-nowrap text-xs"
                            onClick={() => void onDeleteSchedule(schedule)}
                            disabled={loading || busy}
                          >
                            删除
                          </button>
                        </div>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}
