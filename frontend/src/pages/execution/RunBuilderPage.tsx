import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { FloatingNotice, type NoticeTone } from "../../components/FloatingNotice";
import { cn } from "../../lib/utils";
import {
  DatasetRecord,
  EnvironmentRecord,
  ProjectRecord,
  SuiteAssetOverviewRecord,
  SuiteRecord,
  listDatasets,
  listEnvironments,
  listProjects,
  listSuiteAssetOverview,
  listSuites,
} from "../../services/assetService";
import { RuleRecord, bindRuleProjects, bindRuleSuites, getRuleRelations, listRules } from "../../services/ruleService";
import { RunRulePreview, createRun, previewRunRuleBinding } from "../../services/runService";
import { makeIdempotencyKey, panelStyle, parseMaybeNumber } from "./executionShared";

type RunMode = "api_test" | "benchmark";
const RULE_PAGE_SIZE = 8;
const SELECTED_RULE_PREVIEW_LIMIT = 6;

export function ExecutionRunBuilderPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const [runMode, setRunMode] = useState<RunMode>("api_test");

  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [suites, setSuites] = useState<SuiteRecord[]>([]);
  const [environments, setEnvironments] = useState<EnvironmentRecord[]>([]);
  const [datasets, setDatasets] = useState<DatasetRecord[]>([]);
  const [suiteOverviewApi, setSuiteOverviewApi] = useState<SuiteAssetOverviewRecord[]>([]);
  const [suiteOverviewAgent, setSuiteOverviewAgent] = useState<SuiteAssetOverviewRecord[]>([]);
  const [executionRules, setExecutionRules] = useState<RuleRecord[]>([]);
  const [scoringRules, setScoringRules] = useState<RuleRecord[]>([]);

  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(() => parseMaybeNumber(searchParams.get("projectId")));
  const [selectedSuiteId, setSelectedSuiteId] = useState<number | null>(() => parseMaybeNumber(searchParams.get("suiteId")));
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<number | null>(null);
  const [selectedDatasetId, setSelectedDatasetId] = useState<number | null>(null);
  const [selectedRuleIds, setSelectedRuleIds] = useState<number[]>([]);
  const [ruleKeyword, setRuleKeyword] = useState("");
  const [showSelectedOnly, setShowSelectedOnly] = useState(false);
  const [rulePage, setRulePage] = useState(1);
  const [showAllSelectedPreview, setShowAllSelectedPreview] = useState(false);

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: NoticeTone; text: string } | null>(null);
  const [rulePreview, setRulePreview] = useState<RunRulePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const primaryButtonClass = "console-btn-primary";
  const secondaryButtonClass = "console-btn-secondary";
  const strategyPanelClass = "grid gap-2 rounded-2xl border border-border/85 bg-card/90 p-3 shadow-soft";
  const strategySectionTitleClass = "text-xs font-semibold tracking-[0.03em] text-foreground/80";
  const strategyBodyTextClass = "text-[13px] text-foreground/85";
  const strategyHintTextClass = "text-xs text-foreground/72";
  const ruleChipBaseClass = "rounded-full border px-2 py-0.5 text-[11px] font-medium";
  const manualRuleChipClass = `${ruleChipBaseClass} border-blue-400/55 bg-blue-500/18 text-blue-200`;
  const autoRuleChipClass = `${ruleChipBaseClass} border-primary/45 bg-primary/18 text-primary`;
  const effectiveRuleChipClass = `${ruleChipBaseClass} border-success/45 bg-success/18 text-success`;

  const visibleSuites = useMemo(() => {
    if (runMode === "api_test") {
      const allowIds = new Set(
        suiteOverviewApi
          .filter((item) => Number(item.case_count || 0) > 0)
          .map((item) => item.id)
      );
      return suites.filter((suite) => allowIds.has(suite.id));
    }
    const allowIds = new Set(
      suiteOverviewAgent
        .filter((item) => Number(item.case_count || 0) > 0)
        .map((item) => item.id)
    );
    return suites.filter((suite) => allowIds.has(suite.id));
  }, [runMode, suites, suiteOverviewApi, suiteOverviewAgent]);

  const selectedSuite = useMemo(
    () => (selectedSuiteId ? visibleSuites.find((suite) => suite.id === selectedSuiteId) ?? null : null),
    [selectedSuiteId, visibleSuites]
  );

  const filteredDatasets = useMemo(() => {
    if (!selectedSuite) {
      return datasets;
    }
    const suiteName = selectedSuite.name;
    const prefix = `${suiteName}-agent-dataset`;
    return datasets.filter((dataset) => dataset.name.startsWith(prefix));
  }, [datasets, selectedSuite]);

  const currentRulePool = useMemo(() => (runMode === "api_test" ? executionRules : scoringRules), [runMode, executionRules, scoringRules]);

  const autoBoundRuleIds = useMemo(
    () => new Set((rulePreview?.auto_bound_rules ?? []).map((rule) => rule.id)),
    [rulePreview]
  );

  const manualSelectableRulePool = useMemo(
    () => currentRulePool.filter((rule) => !autoBoundRuleIds.has(rule.id)),
    [currentRulePool, autoBoundRuleIds]
  );

  const selectedRuleIdSet = useMemo(() => new Set(selectedRuleIds), [selectedRuleIds]);

  const manualSelectedRules = useMemo(
    () => manualSelectableRulePool.filter((rule) => selectedRuleIdSet.has(rule.id)),
    [manualSelectableRulePool, selectedRuleIdSet]
  );

  const ruleSearchPool = useMemo(() => {
    if (!showSelectedOnly) {
      return manualSelectableRulePool;
    }
    return manualSelectedRules;
  }, [showSelectedOnly, manualSelectableRulePool, manualSelectedRules]);

  const filteredRulePool = useMemo(() => {
    const keyword = ruleKeyword.trim().toLowerCase();
    if (!keyword) {
      return ruleSearchPool;
    }
    return ruleSearchPool.filter((rule) => {
      const byName = rule.name.toLowerCase().includes(keyword);
      const byId = String(rule.id).includes(keyword);
      return byName || byId;
    });
  }, [ruleSearchPool, ruleKeyword]);

  const totalRulePages = useMemo(
    () => Math.max(1, Math.ceil(filteredRulePool.length / RULE_PAGE_SIZE)),
    [filteredRulePool.length]
  );

  const pagedRulePool = useMemo(() => {
    const start = (rulePage - 1) * RULE_PAGE_SIZE;
    return filteredRulePool.slice(start, start + RULE_PAGE_SIZE);
  }, [filteredRulePool, rulePage]);

  const selectedPreviewRules = useMemo(() => {
    if (showAllSelectedPreview) {
      return manualSelectedRules;
    }
    return manualSelectedRules.slice(0, SELECTED_RULE_PREVIEW_LIMIT);
  }, [manualSelectedRules, showAllSelectedPreview]);

  const hasMoreSelectedRules = manualSelectedRules.length > SELECTED_RULE_PREVIEW_LIMIT;
  const pageHasUncheckedRule = pagedRulePool.some((rule) => !selectedRuleIdSet.has(rule.id));
  const hasAnySelectedRule = selectedRuleIds.length > 0;

  useEffect(() => {
    const validIds = new Set(manualSelectableRulePool.map((item) => item.id));
    setSelectedRuleIds((prev) => {
      const next = prev.filter((id) => validIds.has(id));
      if (next.length === prev.length && next.every((id, index) => id === prev[index])) {
        return prev;
      }
      return next;
    });
  }, [manualSelectableRulePool]);

  useEffect(() => {
    setRulePage(1);
  }, [ruleKeyword, showSelectedOnly, runMode, selectedProjectId, selectedSuiteId]);

  useEffect(() => {
    setShowAllSelectedPreview(false);
  }, [showSelectedOnly, runMode]);

  useEffect(() => {
    if (rulePage <= totalRulePages) {
      return;
    }
    setRulePage(totalRulePages);
  }, [rulePage, totalRulePages]);

  useEffect(() => {
    setSelectedSuiteId((prev) =>
      prev && visibleSuites.some((item) => item.id === prev) ? prev : visibleSuites[0]?.id ?? null
    );
  }, [visibleSuites]);

  useEffect(() => {
    if (runMode !== "benchmark") {
      return;
    }
    setSelectedDatasetId((prev) =>
      prev && filteredDatasets.some((item) => item.id === prev) ? prev : filteredDatasets[0]?.id ?? null
    );
  }, [runMode, filteredDatasets]);

  async function refreshBaseData(preferredProjectId?: number | null) {
    const [projectItems, executionRuleItems, scoringRuleItems] = await Promise.all([
      listProjects(),
      listRules("assertion"),
      listRules("scoring"),
    ]);
    const activeExecutionRules = executionRuleItems.filter((item) => item.status === "active");
    const activeScoringRules = scoringRuleItems.filter((item) => item.status === "active");

    setProjects(projectItems);
    setExecutionRules(activeExecutionRules);
    setScoringRules(activeScoringRules);

    const nextProjectId =
      preferredProjectId && projectItems.some((item) => item.id === preferredProjectId) ? preferredProjectId : projectItems[0]?.id ?? null;
    setSelectedProjectId(nextProjectId);
    return { nextProjectId, activeExecutionRules, activeScoringRules };
  }

  async function refreshProjectData(projectId: number) {
    const [suiteItems, environmentItems, datasetItems, apiOverviewItems, agentOverviewItems] = await Promise.all([
      listSuites(projectId),
      listEnvironments(projectId),
      listDatasets(projectId),
      listSuiteAssetOverview(projectId, "api"),
      listSuiteAssetOverview(projectId, "agent"),
    ]);
    setSuites(suiteItems);
    setEnvironments(environmentItems);
    setDatasets(datasetItems);
    setSuiteOverviewApi(apiOverviewItems);
    setSuiteOverviewAgent(agentOverviewItems);

    setSelectedEnvironmentId((prev) =>
      prev && environmentItems.some((item) => item.id === prev) ? prev : environmentItems[0]?.id ?? null
    );
    setSelectedDatasetId((prev) => (prev && datasetItems.some((item) => item.id === prev) ? prev : null));
  }

  async function refreshAll() {
    setLoading(true);
    try {
      const base = await refreshBaseData(selectedProjectId);
      if (base.nextProjectId) {
        await refreshProjectData(base.nextProjectId);
      } else {
        setSuites([]);
        setSuiteOverviewApi([]);
        setSuiteOverviewAgent([]);
        setEnvironments([]);
        setDatasets([]);
      }
      setNotice(null);
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "加载执行发起资源失败",
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
    if (!selectedProjectId) {
      setSuites([]);
      setEnvironments([]);
      setDatasets([]);
      return;
    }
    setLoading(true);
    void refreshProjectData(selectedProjectId)
      .catch((error: unknown) => {
        setNotice({
          tone: "error",
          text: error instanceof Error ? error.message : "加载项目资源失败",
        });
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId]);

  useEffect(() => {
    const next = new URLSearchParams();
    if (selectedProjectId) {
      next.set("projectId", String(selectedProjectId));
    }
    if (selectedSuiteId) {
      next.set("suiteId", String(selectedSuiteId));
    }
    setSearchParams(next, { replace: true });
  }, [selectedProjectId, selectedSuiteId, setSearchParams]);

  useEffect(() => {
    if (!selectedProjectId || !selectedSuiteId) {
      setRulePreview(null);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }

    let canceled = false;
    setPreviewLoading(true);
    void previewRunRuleBinding({
      runType: runMode,
      projectId: selectedProjectId,
      suiteId: selectedSuiteId,
      ruleIds: selectedRuleIds,
    })
      .then((data) => {
        if (canceled) {
          return;
        }
        setRulePreview(data);
        setPreviewError(null);
      })
      .catch((error: unknown) => {
        if (canceled) {
          return;
        }
        setRulePreview(null);
        setPreviewError(error instanceof Error ? error.message : "关联规则解析失败");
      })
      .finally(() => {
        if (canceled) {
          return;
        }
        setPreviewLoading(false);
      });

    return () => {
      canceled = true;
    };
  }, [
    selectedProjectId,
    selectedSuiteId,
    runMode,
    selectedRuleIds,
  ]);

  async function onCreateRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProjectId || !selectedSuiteId || !selectedEnvironmentId) {
      setNotice({ tone: "error", text: "请先选择执行类型、项目、Suite、环境" });
      return;
    }
    if (runMode === "benchmark" && !selectedDatasetId) {
      setNotice({ tone: "error", text: "Benchmark 评测必须选择数据集" });
      return;
    }
    if (
      runMode === "benchmark" &&
      (rulePreview?.effective_rules.filter((rule) => rule.rule_type === "scoring").length ?? 0) === 0
    ) {
      setNotice({ tone: "error", text: "Benchmark 评测请至少选择一条评分规则" });
      return;
    }

    setBusy(true);
    try {
      const uniqueSelectedRuleIds = Array.from(new Set(selectedRuleIds));
      if (uniqueSelectedRuleIds.length > 0) {
        await Promise.all(
          uniqueSelectedRuleIds.map(async (ruleId) => {
            const relations = await getRuleRelations(ruleId);
            const existingProjectIds = Array.isArray(relations.project_ids)
              ? relations.project_ids.filter((id): id is number => Number.isInteger(id))
              : [];
            const existingSuiteIds = Array.isArray(relations.suite_ids)
              ? relations.suite_ids.filter((id): id is number => Number.isInteger(id))
              : [];
            const nextProjectIds = Array.from(new Set([...existingProjectIds, selectedProjectId]));
            const nextSuiteIds = Array.from(new Set([...existingSuiteIds, selectedSuiteId]));
            const bindTasks: Array<Promise<unknown>> = [];

            if (!existingProjectIds.includes(selectedProjectId)) {
              bindTasks.push(bindRuleProjects(ruleId, nextProjectIds));
            }
            if (!existingSuiteIds.includes(selectedSuiteId)) {
              bindTasks.push(bindRuleSuites(ruleId, nextSuiteIds));
            }

            if (bindTasks.length > 0) {
              await Promise.all(bindTasks);
            }
          })
        );
      }

      const created = await createRun(
        {
          runType: runMode,
          projectId: selectedProjectId,
          suiteId: selectedSuiteId,
          environmentId: selectedEnvironmentId,
          datasetId: runMode === "benchmark" ? selectedDatasetId ?? undefined : undefined,
          ruleIds: selectedRuleIds,
          evaluationMode: runMode === "benchmark" ? "with_reference" : undefined,
        },
        makeIdempotencyKey(runMode)
      );
      setNotice({ tone: "success", text: `Run 创建成功：#${created.id}` });
      navigate(`/results/list?projectId=${selectedProjectId}&suiteId=${selectedSuiteId}&runId=${created.id}`);
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "创建 run 失败",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="execution-page grid gap-3">
      <FloatingNotice notice={notice} onClose={() => setNotice(null)} />
      <header className="grid gap-2">
        <h2 className="page-title m-0">执行发起</h2>
      </header>

      <form onSubmit={(event) => void onCreateRun(event)} style={panelStyle} className="console-panel grid gap-2.5">
        <strong className="section-title">执行发起（Run Builder）</strong>
        <div className="grid gap-3">
          <div className="grid gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">执行类型</span>
            <div className="segmented-group w-fit">
              <button
                type="button"
                onClick={() => setRunMode("api_test")}
                className={cn("segmented-item", runMode === "api_test" && "segmented-item-active")}
                disabled={busy}
              >
                API 测试
              </button>
              <button
                type="button"
                onClick={() => setRunMode("benchmark")}
                className={cn("segmented-item", runMode === "benchmark" && "segmented-item-active")}
                disabled={busy}
              >
                Benchmark 评测
              </button>
            </div>
          </div>

          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_150px]">
            <label className="grid gap-1">
              <span className="text-xs text-muted-foreground">项目</span>
              <select
                value={selectedProjectId ?? ""}
                onChange={(event) => setSelectedProjectId(event.target.value ? Number(event.target.value) : null)}
                disabled={busy || projects.length === 0}
              >
                <option value="">项目</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1">
              <span className="text-xs text-muted-foreground">Suite</span>
              <select
                value={selectedSuiteId ?? ""}
                onChange={(event) => setSelectedSuiteId(event.target.value ? Number(event.target.value) : null)}
                disabled={busy || visibleSuites.length === 0}
              >
                <option value="">Suite</option>
                {visibleSuites.map((suite) => (
                  <option key={suite.id} value={suite.id}>
                    {suite.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1">
              <span className="text-xs text-muted-foreground">环境</span>
              <select
                value={selectedEnvironmentId ?? ""}
                onChange={(event) => setSelectedEnvironmentId(event.target.value ? Number(event.target.value) : null)}
                disabled={busy || environments.length === 0}
              >
                <option value="">环境</option>
                {environments.map((environment) => (
                  <option key={environment.id} value={environment.id}>
                    {environment.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1">
              <span className="text-xs text-muted-foreground">环境管理</span>
              <Link
                to={selectedProjectId ? `/config/environment?projectId=${selectedProjectId}&tab=environment` : "/config/environment"}
                className={`${secondaryButtonClass} min-h-[38px] text-center`}
              >
                环境配置
              </Link>
            </label>
          </div>

          {runMode === "benchmark" ? (
            <div className="grid gap-2 md:grid-cols-2">
              <select
                value={selectedDatasetId ?? ""}
                onChange={(event) => setSelectedDatasetId(event.target.value ? Number(event.target.value) : null)}
                disabled={busy || filteredDatasets.length === 0}
              >
                <option value="">数据集</option>
                {filteredDatasets.map((dataset) => (
                  <option key={dataset.id} value={dataset.id}>
                    {dataset.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div className={strategyPanelClass}>
            <strong className="text-sm font-semibold text-foreground">执行策略（Execution）</strong>
            <div className="grid gap-2">
              <input
                value={ruleKeyword}
                onChange={(event) => setRuleKeyword(event.target.value)}
                placeholder={runMode === "api_test" ? "搜索 API 规则（名称或ID）" : "搜索 Benchmark 规则（名称或ID）"}
              />
              <div className="grid gap-2 rounded-xl border border-border/75 bg-background/80 p-2.5">
                <div className="flex flex-wrap items-center justify-between gap-1.5">
                  <div className="text-xs text-foreground/75">
                    可选 {manualSelectableRulePool.length} 条 · 命中 {filteredRulePool.length} 条 · 已选 {selectedRuleIds.length} 条
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        setShowSelectedOnly((prev) => !prev);
                        setRulePage(1);
                      }}
                      className={`${secondaryButtonClass} min-h-[28px] px-2 text-[11px]`}
                    >
                      {showSelectedOnly ? "查看全部" : "仅看已选"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedRuleIds((prev) => {
                          const next = new Set(prev);
                          if (pageHasUncheckedRule) {
                            pagedRulePool.forEach((rule) => next.add(rule.id));
                          } else {
                            pagedRulePool.forEach((rule) => next.delete(rule.id));
                          }
                          return Array.from(next);
                        });
                      }}
                      disabled={pagedRulePool.length === 0}
                      className={`${secondaryButtonClass} min-h-[28px] px-2 text-[11px] disabled:cursor-not-allowed disabled:opacity-60`}
                    >
                      {pageHasUncheckedRule ? "全选当前页" : "取消当前页"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedRuleIds([])}
                      disabled={!hasAnySelectedRule}
                      className={`${secondaryButtonClass} min-h-[28px] px-2 text-[11px] disabled:cursor-not-allowed disabled:opacity-60`}
                    >
                      清空已选
                    </button>
                  </div>
                </div>
                <div className="max-h-60 overflow-auto rounded-lg border border-border/70 bg-background/90">
                  {filteredRulePool.length === 0 ? (
                    <div className={`${strategyBodyTextClass} px-3 py-4`}>暂无可选规则</div>
                  ) : (
                    <div className="divide-y divide-border/65">
                      {pagedRulePool.map((rule) => {
                        const checked = selectedRuleIdSet.has(rule.id);
                        return (
                          <label
                            key={rule.id}
                            className={cn(
                              "flex cursor-pointer items-center gap-2.5 px-3 py-2 text-[13px] text-foreground transition-colors",
                              checked ? "bg-primary/10" : "hover:bg-muted/35"
                            )}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(event) => {
                                const nextChecked = event.target.checked;
                                setSelectedRuleIds((prev) => {
                                  if (nextChecked) {
                                    return prev.includes(rule.id) ? prev : [...prev, rule.id];
                                  }
                                  return prev.filter((id) => id !== rule.id);
                                });
                              }}
                            />
                            <span className="rounded-full border border-border/80 bg-muted/40 px-1.5 py-0.5 text-[11px] text-foreground/75">
                              #{rule.id}
                            </span>
                            <span className="min-w-0 flex-1 truncate">{rule.name}</span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
                {filteredRulePool.length > 0 ? (
                  <div className="flex flex-wrap items-center justify-between gap-1.5 text-xs text-foreground/72">
                    <span>
                      第 {rulePage} / {totalRulePages} 页 · 每页 {RULE_PAGE_SIZE} 条
                    </span>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setRulePage((prev) => Math.max(1, prev - 1))}
                        disabled={rulePage <= 1}
                        className={`${secondaryButtonClass} min-h-[28px] px-2 text-[11px] disabled:cursor-not-allowed disabled:opacity-60`}
                      >
                        上一页
                      </button>
                      <button
                        type="button"
                        onClick={() => setRulePage((prev) => Math.min(totalRulePages, prev + 1))}
                        disabled={rulePage >= totalRulePages}
                        className={`${secondaryButtonClass} min-h-[28px] px-2 text-[11px] disabled:cursor-not-allowed disabled:opacity-60`}
                      >
                        下一页
                      </button>
                    </div>
                  </div>
                ) : null}
                <div className="grid gap-1 rounded-lg border border-border/70 bg-background/90 p-2.5">
                  <div className={strategySectionTitleClass}>已选规则清单</div>
                  {manualSelectedRules.length === 0 ? (
                    <div className={strategyBodyTextClass}>当前未手动选择规则</div>
                  ) : (
                    <>
                      <div className="flex flex-wrap gap-1.5">
                        {selectedPreviewRules.map((rule) => (
                          <span key={`selected-preview-${rule.id}`} className={manualRuleChipClass}>
                            <span className="inline-block max-w-[220px] truncate align-bottom">
                              #{rule.id} {rule.name}
                            </span>
                          </span>
                        ))}
                      </div>
                      {hasMoreSelectedRules ? (
                        <div className="flex items-center justify-end">
                          <button
                            type="button"
                            onClick={() => setShowAllSelectedPreview((prev) => !prev)}
                            className={`${secondaryButtonClass} min-h-[28px] px-2 text-[11px]`}
                          >
                            {showAllSelectedPreview ? "收起已选" : `展开全部（+${manualSelectedRules.length - SELECTED_RULE_PREVIEW_LIMIT}）`}
                          </button>
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            </div>

            <div className="grid gap-2 border-t border-border/70 pt-2">
              <strong className={strategySectionTitleClass}>关联策略与绑定规则</strong>
              {previewLoading ? <div className="text-sm text-foreground/75">正在解析项目/Suite 绑定规则...</div> : null}
              {!previewLoading && previewError ? <div className="text-sm text-danger">{previewError}</div> : null}
              {!previewLoading && !previewError && rulePreview ? (
                <>
                  <div className={strategyBodyTextClass}>
                    策略：{rulePreview.strategy_description}（{rulePreview.strategy_mode}）
                  </div>
                  <div className={strategyHintTextClass}>
                    规则范围：{rulePreview.rule_types.join(" / ")} ｜ 选中规则 {rulePreview.selected_rules.length} 条 ｜ 自动绑定{" "}
                    {rulePreview.auto_bound_rules.length} 条
                  </div>
                  <div className="grid gap-1">
                    <div className={strategySectionTitleClass}>手动选择规则</div>
                    {rulePreview.selected_rules.length === 0 ? (
                      <div className={strategyBodyTextClass}>当前未手动选择规则</div>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {rulePreview.selected_rules.map((rule) => (
                          <span
                            key={`selected-${rule.id}-${rule.rule_type}`}
                            className={manualRuleChipClass}
                          >
                            #{rule.id} {rule.name} · {rule.rule_type}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="grid gap-1">
                    <div className={strategySectionTitleClass}>自动绑定规则（项目 / Suite）</div>
                    {rulePreview.auto_bound_rules.length === 0 ? (
                      <div className={strategyBodyTextClass}>当前项目/Suite 暂无绑定规则</div>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {rulePreview.auto_bound_rules.map((rule) => (
                          <span
                            key={`auto-${rule.id}-${rule.rule_type}`}
                            className={autoRuleChipClass}
                          >
                            #{rule.id} {rule.name} · {rule.rule_type}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="grid gap-1">
                    <div className={strategySectionTitleClass}>本次生效规则</div>
                    {rulePreview.effective_rules.length === 0 ? (
                      <div className={strategyBodyTextClass}>当前运行不会加载规则</div>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {rulePreview.effective_rules.map((rule) => (
                          <span
                            key={`effective-${rule.id}-${rule.rule_type}`}
                            className={effectiveRuleChipClass}
                          >
                            #{rule.id} {rule.name} · {rule.rule_type}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="submit"
              disabled={busy}
              className={`${primaryButtonClass} disabled:cursor-not-allowed disabled:opacity-60`}
            >
              {busy ? "创建中..." : "发起执行"}
            </button>
            <button
              type="button"
              onClick={() => {
                setRunMode("api_test");
                setSelectedDatasetId(datasets[0]?.id ?? null);
                setSelectedRuleIds([]);
                setRuleKeyword("");
                setShowSelectedOnly(false);
                setRulePage(1);
                setShowAllSelectedPreview(false);
                setNotice({ tone: "info", text: "执行配置已重置" });
              }}
              disabled={busy}
              className={`${secondaryButtonClass} disabled:cursor-not-allowed disabled:opacity-60`}
            >
              重置配置
            </button>
            <button
              type="button"
              onClick={() => void refreshAll()}
              disabled={loading}
              className={`${secondaryButtonClass} disabled:cursor-not-allowed disabled:opacity-60`}
            >
              {loading ? "刷新中..." : "刷新资源"}
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}
