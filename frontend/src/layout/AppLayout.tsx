import { useEffect, useMemo, useState, type ComponentType } from "react";

import { ChartColumnIncreasing, ChevronDown, FolderArchive, LayoutDashboard, MoonStar, Settings2, ShieldCheck, SunMedium } from "lucide-react";
import { NavLink, Outlet, useLocation } from "react-router-dom";

import { cn } from "../lib/utils";

type NavItem = {
  label: string;
  to: string;
};

type NavSection = {
  title: string;
  icon: ComponentType<{ className?: string }>;
  items: NavItem[];
};

type UiTheme = "light" | "dark";

const THEME_STORAGE_KEY = "neptune-ui-theme";

function isRouteMatch(pathname: string, to: string): boolean {
  return pathname === to || pathname.startsWith(`${to}/`);
}

function resolveInitialTheme(): UiTheme {
  if (typeof window === "undefined") {
    return "light";
  }
  const storage = window.localStorage as Partial<Storage> | undefined;
  const saved = storage && typeof storage.getItem === "function" ? storage.getItem(THEME_STORAGE_KEY) : null;
  if (saved === "light" || saved === "dark") {
    return saved;
  }
  if (typeof window.matchMedia === "function") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "light";
}

const sections: NavSection[] = [
  {
    title: "工作台",
    icon: LayoutDashboard,
    items: [
      { label: "生成数据集", to: "/generation" },
      { label: "执行发起", to: "/execution/builder" },
      { label: "定时任务", to: "/execution/schedules" },
    ],
  },
  {
    title: "运行结果",
    icon: Settings2,
    items: [
      { label: "运行列表", to: "/results/list" },
      { label: "RUN详情", to: "/results/detail" },
    ],
  },
  {
    title: "规则中心",
    icon: ShieldCheck,
    items: [
      { label: "API 规则", to: "/rules/api" },
      { label: "智能体评价规则", to: "/rules/agent-benchmark" },
    ],
  },
  {
    title: "报告中心",
    icon: ChartColumnIncreasing,
    items: [
      { label: "项目看板", to: "/reports/project" },
      { label: "Suite分析", to: "/reports/suite" },
      { label: "对比分析", to: "/reports/compare" },
    ],
  },
  {
    title: "资产中心",
    icon: FolderArchive,
    items: [
      { label: "文档管理", to: "/assets" },
      { label: "发送渠道", to: "/assets/channels" },
      { label: "环境信息配置", to: "/config/environment" },
    ],
  },
];

export function AppLayout() {
  const location = useLocation();
  const [sidebarExpanded, setSidebarExpanded] = useState(true);
  const [theme, setTheme] = useState<UiTheme>(resolveInitialTheme);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(sections.map((section) => [section.title, true]))
  );

  const gridClass = sidebarExpanded ? "md:grid-cols-[220px_minmax(0,1fr)]" : "md:grid-cols-[62px_minmax(0,1fr)]";

  const visibleSections = useMemo(
    () =>
      sections.map((section) => ({
        ...section,
        isOpen: openSections[section.title] ?? true,
      })),
    [openSections]
  );
  function toggleSection(title: string) {
    setOpenSections((prev) => ({ ...prev, [title]: !(prev[title] ?? true) }));
  }

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.classList.toggle("dark", theme === "dark");
    const storage = window.localStorage as Partial<Storage> | undefined;
    if (storage && typeof storage.setItem === "function") {
      storage.setItem(THEME_STORAGE_KEY, theme);
    }
  }, [theme]);

  return (
    <div className={cn("grid h-screen gap-0 overflow-hidden", gridClass)}>
      <aside className="app-sidebar relative flex h-screen flex-col overflow-hidden border-r border-sidebar-border text-sidebar-foreground">
        <div className={cn("flex h-[84px] items-center border-b border-border", sidebarExpanded ? "px-4" : "px-2")}>
          <button
            type="button"
            onClick={() => setSidebarExpanded((prev) => !prev)}
            aria-label={sidebarExpanded ? "点击收起侧边栏" : "点击展开侧边栏"}
            className={cn("app-brand-trigger", sidebarExpanded ? "expanded" : "collapsed")}
          >
            <span className="app-brand-mark" aria-hidden>
              <span className="app-brand-mark-core" />
              <span className="app-brand-mark-orbit" />
              <span className="app-brand-mark-dot" />
            </span>
            {sidebarExpanded ? (
              <span className="app-brand-copy">
                <span className="app-brand-name">NEPTUNE</span>
                <span className="app-brand-subtitle">AI Test Platform</span>
              </span>
            ) : null}
          </button>
        </div>
        <div className={cn("flex min-h-0 flex-1 flex-col", sidebarExpanded ? "p-4" : "px-2 py-3")}>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <nav className="grid gap-2 pr-1">
              {sidebarExpanded
                ? visibleSections.map((section) => {
                    const SectionIcon = section.icon;
                    return (
                      <section className="grid gap-2" key={section.title}>
                        <button
                          type="button"
                          className="flex items-center gap-2 rounded-md px-1.5 py-1.5 text-[15px] font-medium tracking-normal text-sidebar-foreground/90 transition-colors hover:bg-muted hover:text-foreground"
                          onClick={() => toggleSection(section.title)}
                        >
                          <SectionIcon className="h-[18px] w-[18px] shrink-0 text-sidebar-muted" />
                          <span className="min-w-0 flex-1 truncate text-left">{section.title}</span>
                          <ChevronDown className={cn("h-4 w-4 transition-transform", section.isOpen ? "rotate-0" : "-rotate-90")} />
                        </button>
                        {section.isOpen ? (
                          <div className="ml-4 grid gap-1 border-l border-border pl-3">
                            {section.items.map((item) => (
                              <NavLink
                                end={item.to === "/assets"}
                                className={({ isActive }) =>
                                  cn(
                                    "group relative flex items-center rounded-lg px-2.5 py-2 text-[13px] transition-colors",
                                    isActive
                                      ? "bg-sidebar-active text-primary"
                                      : "text-sidebar-foreground hover:bg-muted hover:text-foreground"
                                  )
                                }
                                key={item.to}
                                to={item.to}
                                title={item.label}
                              >
                                <span className="absolute -left-[13px] top-1/2 h-px w-2.5 -translate-y-1/2 bg-border" />
                                <span className="font-medium">{item.label}</span>
                              </NavLink>
                            ))}
                          </div>
                        ) : null}
                      </section>
                    );
                  })
                : sections.map((section) => {
                    const SectionIcon = section.icon;
                    const fallbackTo = section.items[0]?.to ?? "/";
                    const isSectionActive = section.items.some((item) => isRouteMatch(location.pathname, item.to));
                    return (
                      <NavLink
                        key={section.title}
                        to={fallbackTo}
                        title={section.title}
                        className={() =>
                          cn(
                            "mx-auto flex h-9 w-9 items-center justify-center rounded-lg border border-transparent transition-colors",
                            isSectionActive
                              ? "bg-sidebar-active text-primary shadow-[inset_0_0_0_1px_rgba(16,163,127,0.26)]"
                              : "text-sidebar-foreground/85 hover:bg-muted hover:text-foreground"
                          )
                        }
                      >
                        <SectionIcon className="h-[19px] w-[19px]" />
                      </NavLink>
                    );
                  })}
            </nav>
          </div>
          <div className={cn("app-theme-wrap", sidebarExpanded ? "is-expanded" : "is-collapsed")}>
            <button
              type="button"
              onClick={() => setTheme((previous) => (previous === "light" ? "dark" : "light"))}
              className={cn("app-theme-toggle", sidebarExpanded ? "expanded" : "collapsed", theme === "dark" ? "is-dark" : "is-light")}
              aria-label={theme === "dark" ? "切换浅色模式" : "切换深色模式"}
              title={theme === "dark" ? "切换浅色模式" : "切换深色模式"}
            >
              <span className="app-theme-toggle-icon">{theme === "dark" ? <SunMedium size={16} /> : <MoonStar size={16} />}</span>
            </button>
          </div>
        </div>
      </aside>

      <main className="app-main min-w-0 h-screen overflow-hidden">
        <div className="app-main-surface min-h-full">
          <div className="p-6">
            <Outlet />
          </div>
        </div>
      </main>
    </div>
  );
}
