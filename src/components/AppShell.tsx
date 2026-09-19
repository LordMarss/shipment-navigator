import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  Anchor,
  Bell,
  BarChart3,
  ChevronDown,
  FileText,
  LayoutDashboard,
  Map,
  Menu,
  Package,
  Search,
  Settings,
  Ship,
  Siren,
  X,
} from "lucide-react";

import { isLegacyStatus, listAllDocuments, listAlerts, listShipments, shortId, type Shipment } from "@/lib/api";
import { useMonitoringConfig } from "@/hooks/useMonitoringConfig";
import { kpis, relativeTime } from "@/lib/insights";

type NavItem = { to: string; label: string; icon: typeof LayoutDashboard };

const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  { label: "Overview", items: [{ to: "/", label: "Dashboard", icon: LayoutDashboard }] },
  {
    label: "Shipments",
    items: [
      { to: "/shipments", label: "All Shipments", icon: Package },
      { to: "/shipments/active", label: "Active", icon: Activity },
      { to: "/shipments/completed", label: "Completed", icon: Anchor },
    ],
  },
  {
    label: "Fleet",
    items: [
      { to: "/map", label: "Fleet Map", icon: Map },
      { to: "/vessels", label: "Vessels", icon: Ship },
    ],
  },
  { label: "Documents", items: [{ to: "/documents", label: "Documents", icon: FileText }] },
  {
    label: "Intelligence",
    items: [
      { to: "/alerts", label: "Alerts", icon: Siren },
      { to: "/analytics", label: "Analytics", icon: BarChart3 },
    ],
  },
  { label: "", items: [{ to: "/settings", label: "Settings", icon: Settings }] },
];

export function AppShell({
  title,
  description,
  eyebrow,
  actions,
  headerExtra,
  children,
  wide = false,
}: {
  /** Usually plain text; a page needing a richer header (e.g. an inline back
   *  button) may pass a small ReactNode instead. */
  title: ReactNode;
  description?: string;
  eyebrow?: string;
  actions?: ReactNode;
  /** Optional content rendered inside the dark header bezel, below the
   * title row — the page's live operational summary (KPI strip, cockpit
   * stats) rather than the working content itself, which always lives on
   * the light chart surface below. */
  headerExtra?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  const [mobileNav, setMobileNav] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const maxW = wide ? "max-w-[1600px]" : "max-w-[1160px]";

  useEffect(() => {
    setMobileNav(false);
  }, [pathname]);

  return (
    <div className="min-h-screen bg-background">
      <Sidebar open={mobileNav} onClose={() => setMobileNav(false)} />

      <div className="lg:pl-[248px]">
        <TopBar onMenu={() => setMobileNav(true)} />

        {/* The bezel: the instrument's dark housing continues from the top
         * bar into the page's identity and (where it matters) its live
         * summary, before handing off to the light chart surface below. */}
        <div className="bezel">
          <div className={`mx-auto w-full px-6 pb-7 pt-7 sm:px-8 lg:px-10 ${maxW}`}>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div className="min-w-0">
                {eyebrow ? (
                  <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.05em] text-nav-muted-foreground">
                    {eyebrow}
                  </p>
                ) : null}
                <h1 className="font-serif text-3xl font-semibold text-nav-foreground">{title}</h1>
                {description ? (
                  <p className="mt-1.5 text-sm text-nav-muted-foreground">{description}</p>
                ) : null}
              </div>
              {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
            </div>
            {headerExtra ? <div className="mt-7">{headerExtra}</div> : null}
          </div>
        </div>

        <main className={`mx-auto w-full px-6 py-8 sm:px-8 lg:px-10 ${maxW}`}>
          <div className="animate-in">{children}</div>
        </main>
      </div>
    </div>
  );
}

function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const config = useMonitoringConfig();
  const { data: shipments = [] } = useQuery({ queryKey: ["shipments"], queryFn: listShipments });
  const { data: documents = [] } = useQuery({ queryKey: ["documents", "all"], queryFn: listAllDocuments });
  const activeCount = shipments.filter((s) => !isLegacyStatus(s.status) && s.status !== "Arrived").length;
  // Same definition as the dashboard's attention line (real risk state, via
  // shipmentHealth) — never the raw alert-feed volume, so the two numbers
  // never disagree about what "needs attention" means.
  const { atRisk, delayed } = kpis(shipments, documents, config);
  const exceptions = atRisk + delayed;

  const body = (
    <div className="flex h-full flex-col bg-nav">
      <div className="flex h-16 shrink-0 items-center gap-2.5 border-b border-nav-border px-5">
        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-navy text-nav-foreground">
          <Ship className="size-3.5" />
        </span>
        <span className="text-sm font-semibold tracking-[0.01em] text-nav-foreground">WhiteWind</span>
        <button
          className="focus-ring ml-auto rounded-md p-1 text-nav-muted-foreground lg:hidden"
          onClick={onClose}
          aria-label="Close navigation"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* Fleet pulse — the sidebar itself reports what's moving and what
       * needs attention, so "visibility" starts before you click anything. */}
      <div className="flex shrink-0 flex-col gap-1 border-b border-nav-border px-5 py-3">
        <Link
          to="/shipments/active"
          className="flex items-center gap-1.5 text-xs text-nav-muted-foreground transition-colors hover:text-nav-foreground"
        >
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-nav-accent" />
          {activeCount} shipment{activeCount === 1 ? "" : "s"} active
        </Link>
        {exceptions > 0 ? (
          <Link
            to="/alerts"
            className="flex items-center gap-1.5 text-xs text-risk transition-opacity hover:opacity-80"
          >
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-risk" />
            {exceptions} need{exceptions === 1 ? "s" : ""} attention
          </Link>
        ) : null}
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-5">
        {NAV_GROUPS.map((group, gi) => (
          <div key={group.label || `g${gi}`} className={gi === 0 ? "" : "mt-6"}>
            {group.label ? (
              <p className="px-2.5 pb-2 text-[11px] font-semibold tracking-[0.06em] text-nav-label uppercase">
                {group.label}
              </p>
            ) : null}
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const active = item.to === "/" ? pathname === "/" : pathname === item.to;
                return (
                  <li key={item.to} className="relative">
                    {/* Current-position marker — a small filled dot rather
                     * than a generic bar, echoing "you are here" on a
                     * chart rather than a plain highlight. */}
                    <span
                      aria-hidden
                      className={`absolute left-0 top-1/2 size-1 -translate-y-1/2 rounded-full transition-opacity duration-150 ${
                        active ? "bg-nav-accent opacity-100" : "opacity-0"
                      }`}
                    />
                    <Link
                      to={item.to}
                      className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors duration-150 ${
                        active
                          ? "bg-nav-active font-medium text-nav-active-foreground"
                          : "text-nav-muted-foreground hover:bg-nav-elevated hover:text-nav-foreground"
                      }`}
                    >
                      <item.icon className={`size-4 shrink-0 ${active ? "text-nav-accent" : ""}`} />
                      <span className="truncate">{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="shrink-0 border-t border-nav-border px-4 py-3.5">
        <p className="text-xs font-medium text-nav-foreground/90">Logistics Intelligence</p>
        <p className="mt-0.5 text-xs text-nav-muted-foreground">v1.0 · Operations workspace</p>
      </div>
    </div>
  );

  return (
    <>
      {/* Hard left edge by design — the one place in the interface that
       * meets the screen edge, per the shell's exception to the radius
       * system. */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] lg:block">{body}</aside>
      {open ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            className="absolute inset-0 bg-foreground/30"
            aria-label="Close navigation"
            onClick={onClose}
          />
          <aside className="absolute inset-y-0 left-0 w-[248px] shadow-[0_0_32px_rgba(0,0,0,0.25)]">
            {body}
          </aside>
        </div>
      ) : null}
    </>
  );
}

function TopBar({ onMenu }: { onMenu: () => void }) {
  return (
    <header className="bezel sticky top-0 z-20 border-b border-nav-border">
      <div className="flex h-14 items-center gap-3 px-5 sm:px-6 lg:px-8">
        <button
          className="focus-ring rounded-md p-2 text-nav-muted-foreground transition-colors hover:bg-nav-elevated hover:text-nav-foreground lg:hidden"
          onClick={onMenu}
          aria-label="Open navigation"
        >
          <Menu className="size-4" />
        </button>

        <GlobalSearch />

        <div className="ml-auto flex items-center gap-1.5">
          <NotificationsMenu />
          <WorkspaceMenu />
        </div>
      </div>
    </header>
  );
}

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

/** Slim trigger in the top bar; the actual search lives in a centered
 * command palette (⌘K), which feels like a real application affordance
 * rather than a generic top-bar input everyone has seen before. */
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
        className="focus-ring flex h-8 w-full max-w-[380px] items-center gap-2 rounded-md border border-nav-border bg-nav-elevated px-2.5 text-sm text-nav-muted-foreground transition-colors hover:border-nav-accent/40 hover:text-nav-foreground"
      >
        <Search className="size-3.5 shrink-0" />
        <span className="flex-1 truncate text-left">Search shipments, vessels, clients…</span>
        <kbd className="instrument hidden shrink-0 items-center rounded border border-nav-border px-1.5 py-0.5 text-[10px] text-nav-muted-foreground sm:flex">
          ⌘K
        </kbd>
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
          [s.client_name, s.origin, s.destination, s.vessel_name ?? "", s.vessel_mmsi ?? "", shortId(s.id)]
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
      className="fixed inset-0 z-50 flex items-start justify-center bg-foreground/20 px-4 pt-[14vh] backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="panel-lifted animate-in w-full max-w-lg overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search shipments, clients, vessels, MMSI…"
            className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          <kbd className="hidden shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:block">
            ESC
          </kbd>
        </div>
        <div className="max-h-[360px] overflow-y-auto p-1.5">
          {shipments.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">No shipments yet.</p>
          ) : results.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              No shipments match “{q.trim()}”.
            </p>
          ) : (
            results.map((s, i) => (
              <button
                key={s.id}
                onClick={() => go(s)}
                onMouseEnter={() => setIndex(i)}
                className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                  i === index ? "bg-subtle" : ""
                }`}
              >
                <span className="font-mono text-xs text-muted-foreground">{shortId(s.id)}</span>
                <span className="truncate font-medium">{s.client_name}</span>
                <span className="ml-auto truncate text-xs text-muted-foreground">
                  {s.vessel_name || `${s.origin} → ${s.destination}`}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function NotificationsMenu() {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(() => setOpen(false));
  const { data: alerts = [] } = useQuery({ queryKey: ["alerts"], queryFn: listAlerts });
  const recent = alerts.slice(0, 6);

  return (
    <div ref={ref} className="relative">
      <button
        className="focus-ring relative rounded-md p-2 text-nav-muted-foreground transition-colors hover:bg-nav-elevated hover:text-nav-foreground"
        onClick={() => setOpen((v) => !v)}
        aria-label="Notifications"
      >
        <Bell className="size-4" />
        {alerts.length > 0 ? (
          <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-risk" />
        ) : null}
      </button>
      {open ? (
        <div className="panel-lifted animate-in absolute right-0 top-10 z-30 w-[320px] overflow-hidden">
          <div className="flex items-center justify-between border-b border-border px-3.5 py-2.5">
            <span className="text-sm font-semibold">Notifications</span>
            <Link to="/alerts" className="text-xs font-medium text-primary hover:underline">
              View all
            </Link>
          </div>
          {recent.length === 0 ? (
            <p className="px-3.5 py-4 text-xs text-muted-foreground">No activity yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {recent.map((a) => (
                <li key={a.id} className="px-3.5 py-2.5">
                  <p className="text-xs leading-snug text-foreground">{a.message}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{relativeTime(a.created_at)}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

function WorkspaceMenu() {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(() => setOpen(false));

  return (
    <div ref={ref} className="relative">
      <button
        className="focus-ring flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-nav-elevated"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="grid size-6 place-items-center rounded-md bg-primary text-[10px] font-semibold text-primary-foreground">
          ST
        </span>
        <span className="hidden leading-tight sm:block">
          <span className="block text-xs font-medium text-nav-foreground">StimTech Solutions</span>
          <span className="block text-xs text-nav-muted-foreground">Operations</span>
        </span>
        <ChevronDown className="size-3.5 text-nav-muted-foreground" />
      </button>
      {open ? (
        <div className="panel-lifted animate-in absolute right-0 top-10 z-30 w-[220px] overflow-hidden p-1">
          <div className="px-2.5 py-2">
            <p className="text-xs font-medium">StimTech Solutions</p>
            <p className="text-xs text-muted-foreground">Single-user workspace</p>
          </div>
          <Link
            to="/settings"
            className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors hover:bg-subtle"
            onClick={() => setOpen(false)}
          >
            <Settings className="size-3.5 text-muted-foreground" /> Settings
          </Link>
          <Link
            to="/analytics"
            className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors hover:bg-subtle"
            onClick={() => setOpen(false)}
          >
            <BarChart3 className="size-3.5 text-muted-foreground" /> Analytics
          </Link>
        </div>
      ) : null}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-subtle ${className}`} />;
}

export function EmptyState({
  title,
  description,
  action,
  icon: Icon,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: typeof LayoutDashboard;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {Icon ? (
        <span className="mb-3 grid size-9 place-items-center rounded-full bg-subtle text-muted-foreground">
          <Icon className="size-[17px]" />
        </span>
      ) : null}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description ? <p className="mt-1 max-w-sm text-xs text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/**
 * A labelled reading, quiet by default — the single shared visual language
 * for "a KPI" used by the dashboard's bezel summary, Analytics and the
 * fleet map, so the same concept never has to be re-invented per page.
 * The value is always instrument mono: a count is a reading, not prose.
 */
export function Stat({
  label,
  value,
  tone,
  onBezel = false,
}: {
  label: string;
  value: ReactNode;
  tone?: "risk";
  /** True when rendered inside the dark header bezel rather than on the
   * light chart surface — swaps to the bezel's own text colours. */
  onBezel?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span
        className={
          onBezel
            ? "text-[11px] font-medium uppercase tracking-[0.05em] text-nav-muted-foreground"
            : "label-xs"
        }
      >
        {label}
      </span>
      <span
        className={`instrument inline-flex items-center gap-2 text-2xl font-semibold ${onBezel ? "text-nav-foreground" : "text-foreground"}`}
      >
        {tone === "risk" ? <span aria-hidden className="size-[7px] rounded-full bg-risk" /> : null}
        {value}
      </span>
    </div>
  );
}

export const btnPrimary =
  "focus-ring inline-flex h-9 items-center gap-1.5 rounded-md border border-primary bg-primary px-3.5 text-sm font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary-hover active:scale-[0.98] disabled:opacity-45";

export const btnGhost =
  "focus-ring inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface px-3.5 text-sm font-medium text-foreground transition-colors duration-150 hover:bg-subtle active:scale-[0.98] disabled:opacity-45";

/** A ghost button styled for the dark bezel — used only in a page's
 * `actions` slot, which now renders inside the header bezel rather than
 * on the light chart surface. */
export const btnBezel =
  "focus-ring inline-flex h-9 items-center gap-1.5 rounded-md border border-nav-border bg-nav-elevated px-3.5 text-sm font-medium text-nav-foreground transition-colors duration-150 hover:border-nav-accent/40 active:scale-[0.98] disabled:opacity-45";

export const btnDanger =
  "focus-ring inline-flex h-9 items-center gap-1.5 rounded-md border border-destructive/30 bg-surface px-3.5 text-sm font-medium text-destructive transition-colors duration-150 hover:bg-risk-soft active:scale-[0.98]";

export const fieldClass =
  "focus-ring h-9 w-full rounded-md border border-input bg-surface px-2.5 text-sm text-foreground transition-colors placeholder:text-muted-foreground";
