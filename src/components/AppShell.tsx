import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  BarChart3,
  FileText,
  LayoutDashboard,
  Map,
  MoreHorizontal,
  Package,
  Search,
  Settings,
  Ship,
  Siren,
  X,
} from "lucide-react";

import { isLegacyStatus, listAllDocuments, listShipments, shortId, type Shipment } from "@/lib/api";
import { useMonitoringConfig } from "@/hooks/useMonitoringConfig";
import { kpis } from "@/lib/insights";
import { utcClock } from "@/components/maritime/format";
import { useNow } from "@/components/maritime/useNow";

type NavItem = {
  to: string;
  label: string;
  short?: string;
  icon: typeof LayoutDashboard;
  /** Active for this path and anything beneath it. */
  match: (pathname: string) => boolean;
};

const NAV: NavItem[] = [
  { to: "/", label: "Operations", short: "Ops", icon: LayoutDashboard, match: (p) => p === "/" },
  { to: "/shipments", label: "Shipments", icon: Package, match: (p) => p.startsWith("/shipments") },
  { to: "/map", label: "Fleet map", short: "Map", icon: Map, match: (p) => p === "/map" },
  { to: "/vessels", label: "Vessels", icon: Ship, match: (p) => p === "/vessels" },
  { to: "/documents", label: "Documents", icon: FileText, match: (p) => p === "/documents" },
  { to: "/alerts", label: "Alerts", icon: Siren, match: (p) => p === "/alerts" },
  { to: "/analytics", label: "Analytics", icon: BarChart3, match: (p) => p === "/analytics" },
];

/** Phones and tablets: four destinations on the bottom bar, the rest under More. */
const TAB_PATHS = ["/", "/shipments", "/map", "/alerts"];

/**
 * The application frame. One dark rail across the top carries identity,
 * navigation, search, the watch clock and the standing alarm count; below
 * it everything is the light working surface. On phones and tablets the
 * navigation moves to a bottom bar within thumb reach.
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
  const maxW = wide ? "max-w-[1600px]" : "max-w-[1160px]";

  return (
    <div className="min-h-dvh bg-background pb-[calc(56px+env(safe-area-inset-bottom))] lg:pb-0">
      <a
        href="#main"
        className="sr-only z-50 bg-sea-surface px-3 py-2 text-sm focus:not-sr-only focus:fixed focus:left-2 focus:top-2"
      >
        Skip to content
      </a>
      <Rail />

      {bare ? (
        <main id="main" className="w-full">
          {children}
        </main>
      ) : (
        <>
          <header className="border-b border-sea-rule">
            <div
              className={`mx-auto w-full px-4 pt-5 sm:px-6 lg:px-8 ${maxW} ${tabs ? "" : "pb-5"}`}
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

      <BottomBar />
    </div>
  );
}

/* ------------------------------------------------------------- the rail --- */

function useFleetCounts() {
  const config = useMonitoringConfig();
  const { data: shipments = [] } = useQuery({ queryKey: ["shipments"], queryFn: listShipments });
  const { data: documents = [] } = useQuery({
    queryKey: ["documents", "all"],
    queryFn: listAllDocuments,
  });
  const active = shipments.filter(
    (s) => !isLegacyStatus(s.status) && s.status !== "Arrived",
  ).length;
  // Same verdict as the dashboard's intervention count, so the two never disagree.
  const { atRisk, delayed } = kpis(shipments, documents, config);
  return { active, alarms: atRisk + delayed, loaded: shipments.length > 0 };
}

function Rail() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { active, alarms, loaded } = useFleetCounts();
  const now = useNow(30_000);

  return (
    <header className="sticky top-0 z-30 h-[var(--rail-h)] bg-sea-console text-sea-console-ink">
      <div className="flex h-full items-stretch gap-4 px-4 sm:px-6 lg:gap-6 lg:px-8">
        <Link
          to="/"
          className="focus-ring flex shrink-0 items-center gap-2.5"
          aria-label="WhiteWind, operations"
        >
          <Wordmark />
        </Link>

        <nav aria-label="Primary" className="hidden min-w-0 items-stretch lg:flex">
          {NAV.map((item) => {
            const on = item.match(pathname);
            const count =
              loaded && item.to === "/shipments"
                ? { n: active, tone: "text-sea-console-ink-2" }
                : loaded && item.to === "/alerts" && alarms > 0
                  ? { n: alarms, tone: "text-sea-red-bright" }
                  : null;
            return (
              <Link
                key={item.to}
                to={item.to}
                aria-current={on ? "page" : undefined}
                className={`focus-ring relative flex items-center gap-1.5 whitespace-nowrap px-3 text-[13px] transition-colors duration-150 ${
                  on ? "text-sea-console-ink" : "text-sea-console-ink-2 hover:text-sea-console-ink"
                }`}
              >
                {item.label}
                {count ? (
                  <span className={`telemetry text-[10.5px] ${count.tone}`}>
                    {count.n}
                    {item.to === "/alerts" ? <span className="sr-only"> in alarm</span> : null}
                  </span>
                ) : null}
                <span
                  aria-hidden
                  className={`absolute inset-x-3 bottom-0 h-[2px] transition-opacity duration-150 ${
                    on ? "bg-sea-console-ink opacity-100" : "opacity-0"
                  }`}
                />
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <GlobalSearch />
          {now != null ? (
            <span
              className="telemetry hidden whitespace-nowrap text-[12px] text-sea-console-ink-2 xl:block"
              title="Coordinated Universal Time"
            >
              {utcClock(now)}
              <span className="ml-1 text-[10px]">UTC</span>
            </span>
          ) : null}
          {loaded && alarms > 0 ? (
            <Link
              to="/alerts"
              className="focus-ring flex items-center gap-1.5 text-[12px] text-sea-red-bright lg:hidden"
              aria-label={`${alarms} shipments in alarm`}
            >
              <span aria-hidden className="inline-block size-[7px] rotate-45 bg-sea-red-bright" />
              <span className="telemetry">{alarms}</span>
            </Link>
          ) : null}
          <WorkspaceMenu />
        </div>
      </div>
    </header>
  );
}

/** Extended caps set against the condensed labels everywhere else: the
 * one place the type system goes wide. */
function Wordmark() {
  return (
    <span
      className="text-[12.5px] font-bold uppercase tracking-[0.16em] text-sea-console-ink"
      style={{ fontVariationSettings: '"wdth" 125' }}
    >
      White<span className="text-sea-console-ink-2">wind</span>
    </span>
  );
}

/* ------------------------------------------------------- the bottom bar --- */

function BottomBar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [more, setMore] = useState(false);
  const tabs = NAV.filter((n) => TAB_PATHS.includes(n.to));
  const rest = NAV.filter((n) => !TAB_PATHS.includes(n.to));
  const moreActive = rest.some((n) => n.match(pathname)) || pathname === "/settings";

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
              {[
                ...rest,
                { to: "/settings", label: "Settings", icon: Settings, match: () => false },
              ].map((item) => (
                <li key={item.to} className="border-b border-sea-rule-2 last:border-b-0">
                  <Link
                    to={item.to}
                    className="focus-ring flex h-12 items-center gap-3 px-5 text-[15px] text-sea-ink"
                  >
                    <item.icon className="size-4 text-sea-ink-3" aria-hidden />
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-sea-console-line bg-sea-console pb-[env(safe-area-inset-bottom)] lg:hidden"
      >
        <ul className="grid h-14 grid-cols-5">
          {tabs.map((item) => {
            const on = item.match(pathname);
            return (
              <li key={item.to}>
                <Link
                  to={item.to}
                  aria-current={on ? "page" : undefined}
                  className={`focus-ring relative flex h-full flex-col items-center justify-center gap-1 text-[11px] ${
                    on ? "text-sea-console-ink" : "text-sea-console-ink-2"
                  }`}
                >
                  <span
                    aria-hidden
                    className={`absolute inset-x-5 top-0 h-[2px] ${on ? "bg-sea-console-ink" : ""}`}
                  />
                  <item.icon className="size-[18px]" aria-hidden />
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
                moreActive || more ? "text-sea-console-ink" : "text-sea-console-ink-2"
              }`}
            >
              <span
                aria-hidden
                className={`absolute inset-x-5 top-0 h-[2px] ${moreActive ? "bg-sea-console-ink" : ""}`}
              />
              {more ? (
                <X className="size-[18px]" aria-hidden />
              ) : (
                <MoreHorizontal className="size-[18px]" aria-hidden />
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

function GlobalSearch() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(true);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Search shipments"
        className="focus-ring flex h-8 items-center gap-2 rounded-[2px] text-[12.5px] text-sea-console-ink-2 transition-colors hover:text-sea-console-ink sm:w-44 sm:border sm:border-sea-console-line sm:bg-sea-console-2/60 sm:px-2.5 xl:w-56"
      >
        <Search className="size-4 shrink-0 sm:size-3.5" aria-hidden />
        <span className="hidden flex-1 truncate text-left sm:block">Search</span>
        <kbd className="telemetry hidden text-[10px] sm:block">⌘K</kbd>
      </button>
      {open ? <CommandPalette onClose={() => setOpen(false)} /> : null}
    </>
  );
}

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
  const results = (
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
  ).slice(0, 8);

  const go = (s: Shipment) => {
    onClose();
    navigate({ to: "/shipments/$id", params: { id: s.id } });
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
        aria-label="Search shipments"
        className="panel-lifted animate-in w-full max-w-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-sea-rule px-4 py-3">
          <Search className="size-4 shrink-0 text-sea-ink-3" aria-hidden />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Client, port, vessel, MMSI or SHP number"
            aria-label="Search"
            className="w-full bg-transparent text-[15px] text-sea-ink outline-none placeholder:text-sea-ink-3"
          />
          <kbd className="telemetry hidden shrink-0 text-[10px] text-sea-ink-3 sm:block">ESC</kbd>
        </div>
        <div className="max-h-[380px] overflow-y-auto py-1">
          {shipments.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-sea-ink-3">No shipments yet.</p>
          ) : results.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-sea-ink-3">
              No shipments match “{q.trim()}”.
            </p>
          ) : (
            results.map((s, i) => (
              <button
                key={s.id}
                onClick={() => go(s)}
                onMouseEnter={() => setIndex(i)}
                className={`grid w-full grid-cols-[88px_minmax(0,1fr)_auto] items-baseline gap-3 px-4 py-2 text-left text-sm ${
                  i === index ? "bg-sea-shallows" : ""
                }`}
              >
                <span className="telemetry text-[11px] text-sea-ink-3">{shortId(s.id)}</span>
                <span className="truncate font-medium">{s.client_name}</span>
                <span className="truncate text-[12px] text-sea-ink-3">
                  {s.origin} → {s.destination}
                </span>
              </button>
            ))
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
    <div ref={ref} className="relative">
      <button
        className="focus-ring grid size-8 place-items-center rounded-[2px] border border-sea-console-line text-[10.5px] font-semibold tracking-[0.04em] text-sea-console-ink transition-colors hover:bg-sea-console-2"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Workspace menu, StimTech Solutions"
      >
        ST
      </button>
      {open ? (
        <div className="panel-lifted animate-in absolute right-0 top-10 z-40 w-[232px] overflow-hidden text-sea-ink">
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
