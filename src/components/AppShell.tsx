import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  ArrowRight,
  BarChart3,
  FileText,
  LayoutDashboard,
  Map,
  MoreHorizontal,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  Ship,
  Siren,
  X,
} from "lucide-react";

import { isLegacyStatus, listAllDocuments, listShipments, shortId, type Shipment } from "@/lib/api";
import { useMonitoringConfig } from "@/hooks/useMonitoringConfig";
import { kpis, relativeTime } from "@/lib/lifecycle";
import { clock, utcClock } from "@/components/maritime/format";
import { useNow } from "@/components/maritime/useNow";

type NavItem = {
  to: string;
  label: string;
  /** Label on the phone tab bar, where width is short. */
  short?: string;
  icon: typeof LayoutDashboard;
  /** Active for this path and anything beneath it. */
  match: (pathname: string) => boolean;
};

/** The working destinations, in the order an operator's day runs. */
const OPERATE: NavItem[] = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, match: (p) => p === "/" },
  { to: "/shipments", label: "Shipments", icon: Package, match: (p) => p.startsWith("/shipments") },
  { to: "/vessels", label: "Fleet", icon: Ship, match: (p) => p === "/vessels" },
  { to: "/map", label: "Map", icon: Map, match: (p) => p === "/map" },
  { to: "/alerts", label: "Alerts", icon: Siren, match: (p) => p === "/alerts" },
  { to: "/analytics", label: "Analytics", icon: BarChart3, match: (p) => p === "/analytics" },
];

/** Reference and configuration, set apart below a rule. */
const RECORDS: NavItem[] = [
  { to: "/documents", label: "Documents", icon: FileText, match: (p) => p === "/documents" },
  { to: "/settings", label: "Settings", icon: Settings, match: (p) => p === "/settings" },
];

const ALL_NAV = [...OPERATE, ...RECORDS];

/** Phones and tablets: four destinations on the bottom bar, the rest under More. */
const TAB_PATHS = ["/", "/shipments", "/map", "/alerts"];

/** The daily automation run is late once its last pass is this old. */
const MONITOR_STALE_MS = 26 * 3_600_000;

/* ------------------------------------------------------- sidebar state --- */

/*
 * The sidebar is expanded or reduced to an icon rail. Left alone ("auto")
 * it follows the viewport: expanded from 1280px, a rail from 1024px. Once
 * the operator chooses, the choice holds across pages and visits. The mode
 * sits on the shell root as data-side; the `side-open` variant in
 * styles.css reads it, so the layout never waits on JavaScript to measure.
 */
type SideMode = "auto" | "open" | "closed";
const SIDE_KEY = "ww.sidebar";
let sideMode: SideMode = "auto";
let sideHydrated = false;
const sideListeners = new Set<() => void>();

function setSideMode(next: SideMode) {
  sideMode = next;
  try {
    localStorage.setItem(SIDE_KEY, next);
  } catch {
    // Storage unavailable: the choice lasts for this session only.
  }
  sideListeners.forEach((l) => l());
}

function useSideMode() {
  const mode = useSyncExternalStore(
    (l) => {
      sideListeners.add(l);
      return () => sideListeners.delete(l);
    },
    () => sideMode,
    () => "auto" as SideMode,
  );
  useEffect(() => {
    if (sideHydrated) return;
    sideHydrated = true;
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(SIDE_KEY);
    } catch {
      stored = null;
    }
    if (stored === "open" || stored === "closed") {
      sideMode = stored;
      sideListeners.forEach((l) => l());
    }
  }, []);
  return mode;
}

function toggleSide() {
  const expanded =
    sideMode === "auto" ? window.matchMedia("(min-width: 1280px)").matches : sideMode === "open";
  setSideMode(expanded ? "closed" : "open");
}

/**
 * The application frame. A quiet sidebar carries identity, navigation,
 * search and the watch (UTC clock, monitor state, workspace); the working
 * surface sits beside it. Below 1024px the sidebar gives way to a slim top
 * bar and a bottom tab bar within thumb reach.
 */
export function AppShell({
  title,
  description,
  actions,
  headerExtra,
  tabs,
  children,
  wide = false,
  bare = false,
}: {
  /** Usually plain text; a page needing a richer header may pass a node. */
  title: ReactNode;
  description?: string;
  actions?: ReactNode;
  /** The page's live summary, set in the header under the title row. */
  headerExtra?: ReactNode;
  /** Secondary navigation for the section, set flush on the header rule. */
  tabs?: ReactNode;
  children: ReactNode;
  wide?: boolean;
  /** The page draws its own header and layout (the operations dashboard). */
  bare?: boolean;
}) {
  const mode = useSideMode();
  const maxW = wide ? "max-w-[1600px]" : "max-w-[1180px]";

  // "[" toggles the sidebar, as in most desktop tools.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "[" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
      e.preventDefault();
      toggleSide();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div data-side={mode} className="min-h-dvh bg-background">
      <a
        href="#main"
        className="sr-only z-50 bg-sea-surface px-3 py-2 text-sm focus:not-sr-only focus:fixed focus:left-2 focus:top-2"
      >
        Skip to content
      </a>
      <Sidebar mode={mode} />

      <div className="pb-[calc(56px+env(safe-area-inset-bottom))] transition-[padding] duration-200 ease-[var(--ease-premium)] lg:pb-0 lg:pl-16 lg:side-open:pl-60">
        <TopBar />
        {bare ? (
          <main id="main" className="w-full">
            {children}
          </main>
        ) : (
          <>
            <header className={tabs ? "border-b border-sea-rule" : ""}>
              <div
                className={`mx-auto w-full px-4 pt-7 sm:px-6 lg:px-8 ${maxW} ${tabs ? "" : "pb-1"}`}
              >
                <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
                  <div className="min-w-0">
                    <h1 className="display text-[28px] leading-[32px] text-sea-ink">{title}</h1>
                    {description ? (
                      <p className="mt-1.5 text-[13.5px] text-sea-ink-3">{description}</p>
                    ) : null}
                  </div>
                  {actions ? (
                    <div className="flex flex-wrap items-center gap-2">{actions}</div>
                  ) : null}
                </div>
                {headerExtra ? <div className="mt-6">{headerExtra}</div> : null}
                {tabs ? <div className="mt-5">{tabs}</div> : null}
              </div>
            </header>
            <main id="main" className={`mx-auto w-full px-4 pb-12 pt-6 sm:px-6 lg:px-8 ${maxW}`}>
              <div className="animate-in">{children}</div>
            </main>
          </>
        )}
      </div>

      <BottomBar />
    </div>
  );
}

/* ------------------------------------------------------------ the watch --- */

function useFleetCounts() {
  const config = useMonitoringConfig();
  const { data: shipments = [], isLoading } = useQuery({
    queryKey: ["shipments"],
    queryFn: listShipments,
  });
  const { data: documents = [] } = useQuery({
    queryKey: ["documents", "all"],
    queryFn: listAllDocuments,
  });
  const active = shipments.filter(
    (s) => !isLegacyStatus(s.status) && s.status !== "Arrived",
  ).length;
  // Same verdict as the dashboard's attention count, so the two never disagree.
  const { atRisk, delayed } = kpis(shipments, documents, config);
  // The automated pipeline runs server-side on a schedule; this only reports
  // when it last touched a shipment.
  const lastSync = shipments
    .map((s) => s.last_synced_at)
    .filter((v): v is string => Boolean(v))
    .sort()
    .pop();
  return { active, alarms: atRisk + delayed, loaded: shipments.length > 0, lastSync, isLoading };
}

/* -------------------------------------------------------------- sidebar --- */

function Sidebar({ mode }: { mode: SideMode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { active, alarms, loaded } = useFleetCounts();
  const expanded = mode === "open";

  const countFor = (to: string) =>
    !loaded
      ? null
      : to === "/shipments"
        ? { n: active, alarm: false, label: `${active} active` }
        : to === "/" && alarms > 0
          ? { n: alarms, alarm: true, label: `${alarms} voyages in alarm` }
          : null;

  return (
    <aside
      aria-label="Sidebar"
      className="fixed inset-y-0 left-0 z-30 hidden w-16 flex-col bg-ww-navy text-ww-navy-ink transition-[width] duration-200 ease-[var(--ease-premium)] lg:flex side-open:w-60"
    >
      {/* Identity, level with the top bar */}
      <div className="flex h-[var(--bar-h)] shrink-0 items-center justify-center border-b border-ww-navy-line px-3 side-open:justify-start side-open:px-4">
        <Link
          to="/"
          className="focus-ring flex items-center gap-2.5 rounded-md"
          aria-label="WhiteWind, dashboard"
        >
          <BrandMark />
          <Wordmark className="hidden side-open:inline" />
        </Link>
      </div>

      <nav aria-label="Primary" className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-4">
        <p className="mb-1.5 hidden px-2.5 text-[10.5px] font-medium uppercase tracking-[0.08em] text-ww-navy-ink-2/70 side-open:block">
          Operations
        </p>
        <ul className="space-y-0.5">
          {OPERATE.map((item) => (
            <SideLink
              key={item.to}
              item={item}
              on={item.match(pathname)}
              count={countFor(item.to)}
            />
          ))}
        </ul>
        <div aria-hidden className="mx-2.5 my-4 h-px bg-ww-navy-line side-open:hidden" />
        <p className="mb-1.5 mt-7 hidden px-2.5 text-[10.5px] font-medium uppercase tracking-[0.08em] text-ww-navy-ink-2/70 side-open:block">
          Records
        </p>
        <ul className="space-y-0.5">
          {RECORDS.map((item) => (
            <SideLink key={item.to} item={item} on={item.match(pathname)} count={null} />
          ))}
        </ul>
      </nav>

      {/* Workspace */}
      <div className="flex shrink-0 flex-col items-center gap-2 border-t border-ww-navy-line px-3 py-3 side-open:flex-row side-open:gap-1">
        <WorkspaceMenu variant="sidebar" />
        <button
          type="button"
          onClick={toggleSide}
          aria-label={expanded ? "Collapse sidebar" : "Expand sidebar"}
          title={`${expanded ? "Collapse" : "Expand"} sidebar  [`}
          className="focus-ring grid size-8 shrink-0 place-items-center rounded-md text-ww-navy-ink-2 transition-colors hover:bg-ww-navy-2 hover:text-ww-navy-ink"
        >
          <PanelLeftClose
            className="hidden size-4 side-open:block"
            strokeWidth={1.75}
            aria-hidden
          />
          <PanelLeftOpen className="size-4 side-open:hidden" strokeWidth={1.75} aria-hidden />
        </button>
      </div>
    </aside>
  );
}

function SideLink({
  item,
  on,
  count,
}: {
  item: NavItem;
  on: boolean;
  count: { n: number; alarm: boolean; label: string } | null;
}) {
  const Icon = item.icon;
  return (
    <li>
      <Link
        to={item.to}
        aria-current={on ? "page" : undefined}
        title={item.label}
        className={`focus-ring group relative flex h-[34px] items-center justify-center gap-3 rounded-md px-2.5 text-[13.5px] transition-colors duration-150 side-open:justify-start ${
          on
            ? "bg-ww-navy-3 font-medium text-white"
            : "text-ww-navy-ink-2 hover:bg-ww-navy-2 hover:text-ww-navy-ink"
        }`}
      >
        <span
          aria-hidden
          className={`absolute inset-y-2 left-0 w-[3px] rounded-r-full transition-colors ${on ? "bg-ww-blue-bright" : "bg-transparent"}`}
        />
        <Icon
          className={`size-[17px] shrink-0 ${on ? "text-ww-blue-bright" : "text-ww-navy-ink-2 group-hover:text-ww-navy-ink"}`}
          strokeWidth={1.75}
          aria-hidden
        />
        <span className="hidden min-w-0 flex-1 truncate side-open:block">{item.label}</span>
        {count ? (
          <>
            <span
              className={`telemetry hidden text-[10.5px] side-open:inline-flex ${
                count.alarm
                  ? "h-[18px] min-w-[20px] items-center justify-center rounded-[4px] bg-sea-red px-1 font-medium text-white"
                  : "text-ww-navy-ink-2"
              }`}
            >
              {count.n}
            </span>
            {count.alarm ? (
              <span
                aria-hidden
                className="telemetry absolute right-1 top-0.5 min-w-[15px] rounded-[4px] bg-sea-red px-[3px] text-center text-[9px] leading-[14px] text-white side-open:hidden"
              >
                {count.n}
              </span>
            ) : null}
            <span className="sr-only">, {count.label}</span>
          </>
        ) : null}
      </Link>
    </li>
  );
}

/** The mark: a vane over a rule, white on WhiteWind blue. The one drawn
 * symbol in the product. */
function BrandMark() {
  return (
    <span
      aria-hidden
      className="grid size-7 shrink-0 place-items-center rounded-md bg-ww-blue text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.18)]"
    >
      <svg width="14" height="14" viewBox="0 0 14 14">
        <path d="M7 1.5 L11 10 L7 8.2 L3 10 Z" fill="currentColor" />
        <rect x="2" y="11.6" width="10" height="1.2" fill="currentColor" opacity="0.6" />
      </svg>
    </span>
  );
}

/** Extended caps set against the condensed labels everywhere else: the
 * one place the type system goes wide. */
function Wordmark({
  className = "",
  tone = "navy",
}: {
  className?: string;
  tone?: "navy" | "light";
}) {
  return (
    <span
      className={`text-[12.5px] font-bold uppercase tracking-[0.16em] ${tone === "navy" ? "text-white" : "text-sea-ink"} ${className}`}
      style={{ fontVariationSettings: '"wdth" 125' }}
    >
      White
      <span className={tone === "navy" ? "text-ww-navy-ink-2" : "text-ww-blue"}>wind</span>
    </span>
  );
}

/* ------------------------------------------------------------- top bar --- */

/** Where the operator is, as a trail: section, then the record. */
function useTrail(pathname: string) {
  const section = ALL_NAV.find((n) => n.match(pathname)) ?? null;
  const record = /^\/shipments\/[0-9a-f-]{8,}/i.test(pathname)
    ? "Voyage record"
    : pathname === "/shipments/active"
      ? "Active"
      : pathname === "/shipments/completed"
        ? "Completed"
        : null;
  return { section, record };
}

/**
 * The top of the workspace at every width: where you are, search, and the
 * watch (UTC clock and the state of the automation run). On phones and
 * tablets it also carries the mark and the standing alarm count.
 */
function TopBar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { section, record } = useTrail(pathname);
  const { alarms, loaded, lastSync, isLoading } = useFleetCounts();
  const now = useNow(30_000);
  const stale = !lastSync || (now != null && now - new Date(lastSync).getTime() > MONITOR_STALE_MS);

  return (
    <div className="sticky top-0 z-20 border-b border-sea-rule bg-sea-surface/92 backdrop-blur-md">
      <div className="flex h-[var(--bar-h)] items-center gap-3 px-4 sm:px-6 lg:px-8">
        <Link
          to="/"
          className="focus-ring flex shrink-0 items-center rounded-md lg:hidden"
          aria-label="WhiteWind, dashboard"
        >
          <BrandMark />
        </Link>

        {/* Where you are, only once there is somewhere to go back to; a
         * top-level page names itself in its title, so search leads. */}
        {record && section ? (
          <nav aria-label="You are here" className="flex min-w-0 items-center gap-2 text-[13px]">
            <Link
              to={section.to}
              className="focus-ring shrink-0 rounded-sm text-sea-ink-3 transition-colors hover:text-ww-blue"
            >
              {section.label}
            </Link>
            <span aria-hidden className="text-sea-ink-4">
              /
            </span>
            <span className="truncate font-medium text-sea-ink">{record}</span>
          </nav>
        ) : (
          <GlobalSearch />
        )}

        <div className="ml-auto flex items-center gap-2 sm:gap-4">
          {record && section ? <GlobalSearch /> : null}

          {/* The watch */}
          <div className="hidden items-center gap-4 border-l border-sea-rule pl-4 md:flex">
            <span
              className="flex items-center gap-1.5 text-[12px] text-sea-ink-3"
              title="The automated AIS and status pass runs server-side on a schedule"
            >
              <span
                aria-hidden
                className={`inline-block size-[7px] rotate-45 ${
                  isLoading ? "bg-sea-rule" : stale ? "bg-sea-amber" : "bg-sea-green"
                }`}
              />
              <span className="hidden xl:inline">AIS monitor</span>
              <span className="telemetry text-[11px] text-sea-ink-2">
                {isLoading ? "" : lastSync ? relativeTime(lastSync) : "not run"}
              </span>
            </span>
            {now != null ? (
              <span
                className="telemetry whitespace-nowrap text-[12.5px] font-medium text-sea-ink"
                title={`Coordinated Universal Time. Local ${clock(now)}`}
              >
                {utcClock(now)}
                <span className="ml-1 text-[10px] font-normal text-sea-ink-3">UTC</span>
              </span>
            ) : (
              <span className="block h-4 w-14 animate-pulse rounded-sm bg-sea-paper-2" />
            )}
          </div>

          {loaded && alarms > 0 ? (
            <Link
              to="/"
              className="focus-ring flex h-8 items-center gap-1.5 rounded-md bg-sea-red-soft px-2 text-[12px] font-medium text-sea-red lg:hidden"
              aria-label={`${alarms} voyages in alarm, open the dashboard`}
            >
              <span aria-hidden className="inline-block size-[7px] rotate-45 bg-sea-red" />
              <span className="telemetry">{alarms}</span>
            </Link>
          ) : null}
          <div className="lg:hidden">
            <WorkspaceMenu variant="bar" />
          </div>
        </div>
      </div>
    </div>
  );
}

function BottomBar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { alarms, loaded } = useFleetCounts();
  const [more, setMore] = useState(false);
  const tabs = ALL_NAV.filter((n) => TAB_PATHS.includes(n.to));
  const rest = ALL_NAV.filter((n) => !TAB_PATHS.includes(n.to));
  const moreActive = rest.some((n) => n.match(pathname));

  useEffect(() => setMore(false), [pathname]);

  return (
    <>
      {more ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            className="absolute inset-0 bg-ww-navy/40"
            aria-label="Close menu"
            onClick={() => setMore(false)}
          />
          <div className="animate-in absolute inset-x-0 bottom-[calc(60px+env(safe-area-inset-bottom))] overflow-hidden rounded-t-xl bg-ww-navy">
            <ul className="py-1">
              {rest.map((item) => {
                const on = item.match(pathname);
                return (
                  <li key={item.to}>
                    <Link
                      to={item.to}
                      aria-current={on ? "page" : undefined}
                      className={`focus-ring flex h-12 items-center gap-3 px-5 text-[15px] ${on ? "font-medium text-white" : "text-ww-navy-ink-2"}`}
                    >
                      <item.icon
                        className={`size-[18px] ${on ? "text-ww-blue-bright" : ""}`}
                        strokeWidth={1.75}
                        aria-hidden
                      />
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      ) : null}
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-40 bg-ww-navy pb-[env(safe-area-inset-bottom)] lg:hidden"
      >
        <ul className="grid h-[60px] grid-cols-5">
          {tabs.map((item) => {
            const on = item.match(pathname);
            const badge = item.to === "/" && loaded && alarms > 0 ? alarms : null;
            return (
              <li key={item.to}>
                <Link
                  to={item.to}
                  aria-current={on ? "page" : undefined}
                  className={`focus-ring relative flex h-full flex-col items-center justify-center gap-1 text-[11px] ${
                    on ? "font-medium text-white" : "text-ww-navy-ink-2"
                  }`}
                >
                  <span
                    aria-hidden
                    className={`absolute inset-x-6 top-0 h-[3px] rounded-b-full ${on ? "bg-ww-blue-bright" : ""}`}
                  />
                  <span className="relative">
                    <item.icon
                      className={`size-[19px] ${on ? "text-ww-blue-bright" : ""}`}
                      strokeWidth={1.75}
                      aria-hidden
                    />
                    {badge ? (
                      <span className="telemetry absolute -right-2.5 -top-1.5 min-w-[15px] rounded-[4px] bg-sea-red px-[3px] text-center text-[9px] leading-[14px] text-white">
                        {badge}
                      </span>
                    ) : null}
                  </span>
                  {item.short ?? item.label}
                </Link>
              </li>
            );
          })}
          <li>
            <button
              type="button"
              onClick={() => setMore((v) => !v)}
              aria-expanded={more}
              className={`focus-ring relative flex h-full w-full flex-col items-center justify-center gap-1 text-[11px] ${
                moreActive || more ? "font-medium text-white" : "text-ww-navy-ink-2"
              }`}
            >
              <span
                aria-hidden
                className={`absolute inset-x-6 top-0 h-[3px] rounded-b-full ${moreActive ? "bg-ww-blue-bright" : ""}`}
              />
              {more ? (
                <X className="size-[19px]" strokeWidth={1.75} aria-hidden />
              ) : (
                <MoreHorizontal className="size-[19px]" strokeWidth={1.75} aria-hidden />
              )}
              More
            </button>
          </li>
        </ul>
      </nav>
    </>
  );
}

/* --------------------------------------------------------------- search --- */

export function useDismiss<T extends HTMLElement = HTMLDivElement>(onClose: () => void) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);
  return ref;
}

/** The search field in the top bar: a field on wide screens, an icon on
 * phones. ⌘K opens the same palette from anywhere. */
function GlobalSearch() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")) return;
      e.preventDefault();
      setOpen(true);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Search shipments and pages"
        className="focus-ring grid size-9 place-items-center rounded-md text-sea-ink-2 transition-colors hover:bg-sea-paper hover:text-sea-ink sm:flex sm:h-8 sm:w-56 sm:items-center sm:gap-2 sm:border sm:border-sea-rule sm:bg-sea-paper/60 sm:px-2.5 sm:text-left sm:text-[12.5px] sm:text-sea-ink-3 sm:hover:border-ww-blue-line sm:hover:bg-sea-surface xl:w-72"
      >
        <Search className="size-[18px] shrink-0 sm:size-3.5" strokeWidth={1.75} aria-hidden />
        <span className="hidden flex-1 truncate sm:block">Search shipments, vessels, ports</span>
        <kbd className="telemetry hidden rounded-[4px] border border-sea-rule bg-sea-surface px-1 text-[10px] leading-[16px] text-sea-ink-3 sm:block">
          ⌘K
        </kbd>
      </button>
      {open ? <CommandPalette onClose={() => setOpen(false)} /> : null}
    </>
  );
}

type PaletteResult =
  | { kind: "page"; key: string; item: NavItem }
  | { kind: "shipment"; key: string; shipment: Shipment };

/** One field for everything: shipments by client, port, vessel, MMSI or
 * SHP number, and every page by name. */
function CommandPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const [index, setIndex] = useState(0);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { data: shipments = [] } = useQuery({ queryKey: ["shipments"], queryFn: listShipments });

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const term = q.trim().toLowerCase();
  const pages: PaletteResult[] = term
    ? ALL_NAV.filter((n) => n.label.toLowerCase().includes(term)).map((item) => ({
        kind: "page",
        key: `p:${item.to}`,
        item,
      }))
    : [];
  const ships: PaletteResult[] = (
    term
      ? shipments.filter((s) =>
          [
            s.client_name,
            s.origin,
            s.destination,
            s.vessel_name ?? "",
            s.vessel_mmsi ?? "",
            shortId(s.id),
          ]
            .join(" ")
            .toLowerCase()
            .includes(term),
        )
      : shipments
  )
    .slice(0, 8)
    .map((shipment) => ({ kind: "shipment", key: shipment.id, shipment }));
  const results = [...pages, ...ships];

  const go = (r: PaletteResult) => {
    onClose();
    if (r.kind === "page") navigate({ to: r.item.to });
    else navigate({ to: "/shipments/$id", params: { id: r.shipment.id } });
  };

  useEffect(() => {
    setIndex(0);
  }, [q]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setIndex((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" && results[index]) {
        go(results[index]);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, index]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-sea-ink/25 px-4 pt-[12vh] text-sea-ink"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Search"
        className="panel-lifted animate-in w-full max-w-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-sea-rule px-4 py-3">
          <Search className="size-4 shrink-0 text-sea-ink-3" aria-hidden />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Client, port, vessel, MMSI, SHP number or page"
            aria-label="Search"
            className="w-full bg-transparent text-[15px] text-sea-ink outline-none placeholder:text-sea-ink-3"
          />
          <kbd className="telemetry hidden shrink-0 text-[10px] text-sea-ink-3 sm:block">ESC</kbd>
        </div>
        <div className="max-h-[380px] overflow-y-auto py-1">
          {results.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-sea-ink-3">
              {term ? `Nothing matches “${q.trim()}”.` : "No shipments yet."}
            </p>
          ) : (
            results.map((r, i) =>
              r.kind === "page" ? (
                <button
                  key={r.key}
                  onClick={() => go(r)}
                  onMouseEnter={() => setIndex(i)}
                  className={`flex w-full items-center gap-3 px-4 py-2 text-left text-sm ${
                    i === index ? "bg-sea-shallows" : ""
                  }`}
                >
                  <r.item.icon className="size-4 text-sea-ink-3" strokeWidth={1.75} aria-hidden />
                  <span className="flex-1 font-medium">{r.item.label}</span>
                  <ArrowRight className="size-3.5 text-sea-ink-4" aria-hidden />
                </button>
              ) : (
                <button
                  key={r.key}
                  onClick={() => go(r)}
                  onMouseEnter={() => setIndex(i)}
                  className={`grid w-full grid-cols-[88px_minmax(0,1fr)_auto] items-baseline gap-3 px-4 py-2 text-left text-sm ${
                    i === index ? "bg-sea-shallows" : ""
                  }`}
                >
                  <span className="ref-tag justify-self-start">{shortId(r.shipment.id)}</span>
                  <span className="truncate font-medium">{r.shipment.client_name}</span>
                  <span className="truncate text-[12px] text-sea-ink-3">
                    {r.shipment.origin} → {r.shipment.destination}
                  </span>
                </button>
              ),
            )
          )}
        </div>
      </div>
    </div>
  );
}

function WorkspaceMenu({ variant }: { variant: "sidebar" | "bar" }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(() => setOpen(false));
  const onNavy = variant === "sidebar";

  return (
    <div ref={ref} className={`relative ${onNavy ? "side-open:min-w-0 side-open:flex-1" : ""}`}>
      <button
        className={`focus-ring flex h-9 items-center gap-2.5 rounded-md text-left transition-colors ${
          onNavy ? "hover:bg-ww-navy-2 side-open:w-full side-open:px-1.5" : "hover:bg-sea-paper"
        }`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Workspace menu, StimTech Solutions"
      >
        <span
          className={`grid size-7 shrink-0 place-items-center rounded-md text-[10px] font-semibold tracking-[0.04em] ${
            onNavy
              ? "bg-ww-navy-3 text-white ring-1 ring-ww-navy-line"
              : "bg-ww-blue-soft text-ww-blue ring-1 ring-ww-blue-line"
          }`}
        >
          ST
        </span>
        {onNavy ? (
          <span className="hidden min-w-0 side-open:block">
            <span className="block truncate text-[12.5px] font-medium leading-[16px] text-white">
              StimTech Solutions
            </span>
            <span className="block truncate text-[11px] leading-[14px] text-ww-navy-ink-2">
              Operations workspace
            </span>
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          className={`panel-lifted animate-in absolute z-40 w-[232px] overflow-hidden text-sea-ink ${
            onNavy ? "bottom-11 left-0" : "right-0 top-11"
          }`}
        >
          <div className="border-b border-sea-rule px-3.5 py-3">
            <p className="text-[13px] font-medium">StimTech Solutions</p>
            <p className="text-[12px] text-sea-ink-3">Operations workspace</p>
          </div>
          <Link
            to="/settings"
            className="flex items-center gap-2 px-3.5 py-2.5 text-[13px] transition-colors hover:bg-sea-shallows"
            onClick={() => setOpen(false)}
          >
            <Settings className="size-3.5 text-sea-ink-3" aria-hidden /> Settings
          </Link>
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------- shared --- */

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse bg-sea-paper-2 ${className}`} />;
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="px-1 py-12">
      <p className="text-[14px] font-medium text-sea-ink">{title}</p>
      {description ? (
        <p className="mt-1 max-w-[52ch] text-[13px] text-sea-ink-2">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/**
 * Section tabs set on the header rule (the shipment book's All / Active /
 * Completed). A route link per tab, so each view has its own URL.
 */
export function HeaderTabs({
  items,
}: {
  items: { to: string; label: string; count?: number | undefined }[];
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav aria-label="Section" className="-mb-px flex gap-6 overflow-x-auto">
      {items.map((t) => {
        const on = pathname === t.to || pathname === `${t.to}/`;
        return (
          <Link
            key={t.to}
            to={t.to}
            aria-current={on ? "page" : undefined}
            className={`focus-ring flex shrink-0 items-center gap-2 border-b-2 pb-2.5 text-[13px] transition-colors ${
              on
                ? "border-ww-blue font-medium text-sea-ink"
                : "border-transparent text-sea-ink-3 hover:text-sea-ink"
            }`}
          >
            {t.label}
            {t.count != null ? (
              <span className="telemetry text-[10.5px] text-sea-ink-3">{t.count}</span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

export const btnPrimary =
  "focus-ring inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border border-primary bg-primary px-3 text-[13px] font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary-hover active:translate-y-px disabled:opacity-45";

export const btnGhost =
  "focus-ring inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border border-sea-rule bg-sea-surface px-3 text-[13px] font-medium text-sea-ink transition-colors duration-150 hover:border-ww-blue-line hover:bg-ww-blue-soft hover:text-ww-blue active:translate-y-px disabled:opacity-45";

export const btnDanger =
  "focus-ring inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border border-sea-red/35 bg-sea-surface px-3 text-[13px] font-medium text-sea-red transition-colors duration-150 hover:bg-sea-red-soft active:translate-y-px";

const fieldBase =
  "focus-ring h-8 rounded-md border border-sea-rule bg-sea-surface px-2.5 text-[13px] text-sea-ink transition-colors placeholder:text-sea-ink-3 hover:border-ww-blue-line focus:border-ww-blue";

export const fieldClass = `${fieldBase} w-full`;

/** A field sized to its content (e.g. a filter select in a toolbar). */
export const fieldInlineClass = `${fieldBase} w-auto`;
