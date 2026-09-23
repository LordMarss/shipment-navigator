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
  const maxW = wide ? "max-w-[1600px]" : "max-w-[1160px]";

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
      <MobileBar />

      <div className="pb-[calc(56px+env(safe-area-inset-bottom))] transition-[padding] duration-200 ease-[var(--ease-premium)] lg:pb-0 lg:pl-16 lg:side-open:pl-60">
        {bare ? (
          <main id="main" className="w-full">
            {children}
          </main>
        ) : (
          <>
            <header className="border-b border-sea-rule">
              <div
                className={`mx-auto w-full px-4 pt-6 sm:px-6 lg:px-8 ${maxW} ${tabs ? "" : "pb-5"}`}
              >
                <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
                  <div className="min-w-0">
                    <h1 className="display text-[26px] leading-[30px] text-sea-ink">{title}</h1>
                    {description ? (
                      <p className="mt-1 text-[13px] text-sea-ink-3">{description}</p>
                    ) : null}
                  </div>
                  {actions ? (
                    <div className="flex flex-wrap items-center gap-2">{actions}</div>
                  ) : null}
                </div>
                {headerExtra ? <div className="mt-5">{headerExtra}</div> : null}
                {tabs ? <div className="mt-4">{tabs}</div> : null}
              </div>
            </header>
            <main id="main" className={`mx-auto w-full px-4 py-6 sm:px-6 lg:px-8 ${maxW}`}>
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
  const { active, alarms, loaded, lastSync, isLoading } = useFleetCounts();
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
      className="fixed inset-y-0 left-0 z-30 hidden w-16 flex-col border-r border-sea-rule bg-sea-paper-2 transition-[width] duration-200 ease-[var(--ease-premium)] lg:flex side-open:w-60"
    >
      {/* Identity */}
      <div className="flex h-14 shrink-0 items-center justify-center px-3 side-open:justify-start side-open:px-4">
        <Link
          to="/"
          className="focus-ring flex items-center gap-2.5"
          aria-label="WhiteWind, dashboard"
        >
          <BrandMark />
          <Wordmark className="hidden side-open:inline" />
        </Link>
      </div>

      <div className="shrink-0 px-3">
        <GlobalSearch variant="sidebar" />
      </div>

      <nav aria-label="Primary" className="mt-4 min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        <ul className="space-y-px">
          {OPERATE.map((item) => (
            <SideLink
              key={item.to}
              item={item}
              on={item.match(pathname)}
              count={countFor(item.to)}
            />
          ))}
        </ul>
        <div aria-hidden className="mx-2.5 my-3 h-px bg-sea-rule" />
        <ul className="space-y-px">
          {RECORDS.map((item) => (
            <SideLink key={item.to} item={item} on={item.match(pathname)} count={null} />
          ))}
        </ul>
      </nav>

      {/* The watch: clock, monitor, workspace */}
      <div className="shrink-0 border-t border-sea-rule px-3 pb-3 pt-3">
        <Watch lastSync={lastSync} isLoading={isLoading} />
        <div className="mt-3 flex flex-col items-center gap-2 side-open:flex-row side-open:gap-1">
          <WorkspaceMenu />
          <button
            type="button"
            onClick={toggleSide}
            aria-label={expanded ? "Collapse sidebar" : "Expand sidebar"}
            title={`${expanded ? "Collapse" : "Expand"} sidebar  [`}
            className="focus-ring grid size-8 shrink-0 place-items-center rounded-[2px] text-sea-ink-3 transition-colors hover:bg-sea-shallows hover:text-sea-ink"
          >
            <PanelLeftClose className="hidden size-4 side-open:block" aria-hidden />
            <PanelLeftOpen className="size-4 side-open:hidden" aria-hidden />
          </button>
        </div>
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
        className={`focus-ring group relative flex h-8 items-center justify-center gap-2.5 rounded-[2px] px-2.5 text-[13px] transition-colors duration-150 side-open:justify-start ${
          on
            ? "bg-sea-surface font-medium text-sea-ink shadow-[inset_0_0_0_1px_var(--sea-rule)]"
            : "text-sea-ink-2 hover:bg-sea-shallows hover:text-sea-ink"
        }`}
      >
        <span
          aria-hidden
          className={`absolute inset-y-[7px] left-0 w-[2px] ${on ? "bg-sea-ink" : "bg-transparent"}`}
        />
        <Icon
          className={`size-4 shrink-0 ${on ? "text-sea-ink" : "text-sea-ink-3 group-hover:text-sea-ink-2"}`}
          strokeWidth={1.75}
          aria-hidden
        />
        <span className="hidden min-w-0 flex-1 truncate side-open:block">{item.label}</span>
        {count ? (
          <>
            <span
              className={`telemetry hidden text-[10.5px] side-open:inline ${count.alarm ? "font-medium text-sea-red" : "text-sea-ink-3"}`}
            >
              {count.n}
            </span>
            {count.alarm ? (
              <span
                aria-hidden
                className="telemetry absolute right-1 top-0.5 min-w-[15px] rounded-[2px] bg-sea-red px-[3px] text-center text-[9px] leading-[14px] text-sea-surface side-open:hidden"
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

/** UTC first (the voyage record's clock), local beneath; then the state of
 * the automation run, the one system fact an operator needs at a glance. */
function Watch({ lastSync, isLoading }: { lastSync: string | undefined; isLoading: boolean }) {
  const now = useNow(30_000);
  const stale = !lastSync || (now != null && now - new Date(lastSync).getTime() > MONITOR_STALE_MS);
  return (
    <div className="flex flex-col items-center side-open:items-stretch">
      {now != null ? (
        <p className="telemetry flex items-baseline gap-2 text-[12px] text-sea-ink">
          <span title="Coordinated Universal Time">
            {utcClock(now)}
            <span className="ml-1 hidden text-[9.5px] text-sea-ink-3 side-open:inline">UTC</span>
          </span>
          <span className="hidden text-[11px] text-sea-ink-3 side-open:inline">
            {clock(now)} local
          </span>
        </p>
      ) : (
        <span className="block h-4 w-12 animate-pulse bg-sea-paper" />
      )}
      <p
        className="mt-1.5 hidden items-center gap-1.5 text-[11.5px] text-sea-ink-3 side-open:flex"
        title="The automated AIS and status pass runs server-side on a schedule"
      >
        <span
          aria-hidden
          className={`inline-block size-[6px] shrink-0 rotate-45 ${
            isLoading ? "bg-sea-rule" : stale ? "bg-sea-amber" : "bg-sea-green"
          }`}
        />
        {isLoading
          ? "AIS monitor"
          : lastSync
            ? `AIS monitor ran ${relativeTime(lastSync)}`
            : "AIS monitor has not run"}
      </p>
    </div>
  );
}

/** The mark alone, for the icon rail and the phone bar: a vane over a
 * rule, the one drawn symbol in the product. */
function BrandMark() {
  return (
    <span
      aria-hidden
      className="grid size-7 shrink-0 place-items-center rounded-[2px] bg-sea-ink text-sea-surface"
    >
      <svg width="14" height="14" viewBox="0 0 14 14">
        <path d="M7 1.5 L11 10 L7 8.2 L3 10 Z" fill="currentColor" />
        <rect x="2" y="11.6" width="10" height="1.2" fill="currentColor" opacity="0.55" />
      </svg>
    </span>
  );
}

/** Extended caps set against the condensed labels everywhere else: the
 * one place the type system goes wide. */
function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span
      className={`text-[12.5px] font-bold uppercase tracking-[0.16em] text-sea-ink ${className}`}
      style={{ fontVariationSettings: '"wdth" 125' }}
    >
      White<span className="text-sea-ink-3">wind</span>
    </span>
  );
}

/* -------------------------------------------------- phones and tablets --- */

function MobileBar() {
  const { alarms, loaded } = useFleetCounts();
  return (
    <header className="sticky top-0 z-30 flex h-[var(--rail-h)] items-center gap-3 border-b border-sea-rule bg-sea-surface/95 px-4 backdrop-blur-sm sm:px-6 lg:hidden">
      <Link
        to="/"
        className="focus-ring flex items-center gap-2.5"
        aria-label="WhiteWind, dashboard"
      >
        <BrandMark />
        <Wordmark />
      </Link>
      <div className="ml-auto flex items-center gap-1">
        <GlobalSearch variant="bar" />
        {loaded && alarms > 0 ? (
          <Link
            to="/"
            className="focus-ring flex h-9 items-center gap-1.5 px-2 text-[12px] font-medium text-sea-red"
            aria-label={`${alarms} voyages in alarm, open the dashboard`}
          >
            <span aria-hidden className="inline-block size-[7px] rotate-45 bg-sea-red" />
            <span className="telemetry">{alarms}</span>
          </Link>
        ) : null}
        <WorkspaceMenu />
      </div>
    </header>
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
            className="absolute inset-0 bg-sea-ink/30"
            aria-label="Close menu"
            onClick={() => setMore(false)}
          />
          <div className="animate-in absolute inset-x-0 bottom-[calc(56px+env(safe-area-inset-bottom))] border-t border-sea-rule bg-sea-surface">
            <ul>
              {rest.map((item) => {
                const on = item.match(pathname);
                return (
                  <li key={item.to} className="border-b border-sea-rule-2 last:border-b-0">
                    <Link
                      to={item.to}
                      aria-current={on ? "page" : undefined}
                      className={`focus-ring flex h-12 items-center gap-3 px-5 text-[15px] ${on ? "font-medium text-sea-ink" : "text-sea-ink-2"}`}
                    >
                      <item.icon className="size-4 text-sea-ink-3" strokeWidth={1.75} aria-hidden />
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
        className="fixed inset-x-0 bottom-0 z-40 border-t border-sea-rule bg-sea-surface pb-[env(safe-area-inset-bottom)] lg:hidden"
      >
        <ul className="grid h-14 grid-cols-5">
          {tabs.map((item) => {
            const on = item.match(pathname);
            const badge = item.to === "/" && loaded && alarms > 0 ? alarms : null;
            return (
              <li key={item.to}>
                <Link
                  to={item.to}
                  aria-current={on ? "page" : undefined}
                  className={`focus-ring relative flex h-full flex-col items-center justify-center gap-1 text-[11px] ${
                    on ? "font-medium text-sea-ink" : "text-sea-ink-3"
                  }`}
                >
                  <span
                    aria-hidden
                    className={`absolute inset-x-5 top-0 h-[2px] ${on ? "bg-sea-ink" : ""}`}
                  />
                  <span className="relative">
                    <item.icon className="size-[18px]" strokeWidth={1.75} aria-hidden />
                    {badge ? (
                      <span className="telemetry absolute -right-2.5 -top-1.5 min-w-[15px] rounded-[2px] bg-sea-red px-[3px] text-center text-[9px] leading-[14px] text-sea-surface">
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
                moreActive || more ? "font-medium text-sea-ink" : "text-sea-ink-3"
              }`}
            >
              <span
                aria-hidden
                className={`absolute inset-x-5 top-0 h-[2px] ${moreActive ? "bg-sea-ink" : ""}`}
              />
              {more ? (
                <X className="size-[18px]" strokeWidth={1.75} aria-hidden />
              ) : (
                <MoreHorizontal className="size-[18px]" strokeWidth={1.75} aria-hidden />
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

/** Both the sidebar and the phone bar mount a trigger; only the visible
 * one may own the shortcut, or ⌘K would open two palettes. */
function GlobalSearch({ variant }: { variant: "sidebar" | "bar" }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")) return;
      const desktop = window.matchMedia("(min-width: 1024px)").matches;
      if ((variant === "sidebar") !== desktop) return;
      e.preventDefault();
      setOpen(true);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [variant]);

  return (
    <>
      {variant === "sidebar" ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Search shipments and pages"
          title="Search  ⌘K"
          className="focus-ring flex h-8 w-full items-center justify-center gap-2 rounded-[2px] text-[12.5px] text-sea-ink-3 transition-colors hover:text-sea-ink side-open:justify-start side-open:border side-open:border-sea-rule side-open:bg-sea-surface side-open:px-2.5 side-open:hover:border-sea-ink-4"
        >
          <Search className="size-4 shrink-0 side-open:size-3.5" strokeWidth={1.75} aria-hidden />
          <span className="hidden flex-1 truncate text-left side-open:block">Search</span>
          <kbd className="telemetry hidden text-[10px] text-sea-ink-4 side-open:block">⌘K</kbd>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Search shipments and pages"
          className="focus-ring grid size-9 place-items-center text-sea-ink-2 hover:text-sea-ink"
        >
          <Search className="size-[18px]" strokeWidth={1.75} aria-hidden />
        </button>
      )}
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
                  <span className="telemetry text-[11px] text-sea-ink-3">
                    {shortId(r.shipment.id)}
                  </span>
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

function WorkspaceMenu() {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(() => setOpen(false));

  return (
    <div ref={ref} className="relative lg:side-open:min-w-0 lg:side-open:flex-1">
      <button
        className="focus-ring flex h-8 items-center gap-2.5 rounded-[2px] text-left transition-colors hover:bg-sea-shallows lg:side-open:w-full lg:side-open:px-1"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Workspace menu, StimTech Solutions"
      >
        <span className="grid size-7 shrink-0 place-items-center rounded-[2px] border border-sea-rule bg-sea-surface text-[10px] font-semibold tracking-[0.04em] text-sea-ink">
          ST
        </span>
        <span className="hidden min-w-0 lg:side-open:block">
          <span className="block truncate text-[12.5px] font-medium leading-[16px] text-sea-ink">
            StimTech Solutions
          </span>
          <span className="block truncate text-[11px] leading-[14px] text-sea-ink-3">
            Operations workspace
          </span>
        </span>
      </button>
      {open ? (
        <div className="panel-lifted animate-in absolute right-0 top-10 z-40 w-[232px] overflow-hidden text-sea-ink lg:bottom-10 lg:left-0 lg:right-auto lg:top-auto">
          <div className="border-b border-sea-rule px-3.5 py-3">
            <p className="text-[13px] font-medium">StimTech Solutions</p>
            <p className="text-[12px] text-sea-ink-3">Operations workspace</p>
          </div>
          <Link
            to="/settings"
            className="flex items-center gap-2 px-3.5 py-2.5 text-[13px] transition-colors hover:bg-sea-paper-2"
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
                ? "border-sea-ink font-medium text-sea-ink"
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
  "focus-ring inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-[2px] border border-primary bg-primary px-3 text-[13px] font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary-hover active:translate-y-px disabled:opacity-45";

export const btnGhost =
  "focus-ring inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-[2px] border border-sea-rule bg-sea-surface px-3 text-[13px] font-medium text-sea-ink transition-colors duration-150 hover:border-sea-ink-4 hover:bg-sea-paper-2 active:translate-y-px disabled:opacity-45";

export const btnDanger =
  "focus-ring inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-[2px] border border-sea-red/35 bg-sea-surface px-3 text-[13px] font-medium text-sea-red transition-colors duration-150 hover:bg-sea-red-soft active:translate-y-px";

const fieldBase =
  "focus-ring h-8 rounded-[2px] border border-sea-rule bg-sea-surface px-2.5 text-[13px] text-sea-ink transition-colors placeholder:text-sea-ink-3 hover:border-sea-ink-4";

export const fieldClass = `${fieldBase} w-full`;

/** A field sized to its content (e.g. a filter select in a toolbar). */
export const fieldInlineClass = `${fieldBase} w-auto`;
