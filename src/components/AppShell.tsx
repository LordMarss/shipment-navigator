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

import { listAlerts, listShipments, shortId } from "@/lib/api";
import { relativeTime } from "@/lib/insights";

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
  children,
  wide = false,
}: {
  /** Usually plain text; a page needing a richer header (e.g. an inline back
   *  button) may pass a small ReactNode instead. */
  title: ReactNode;
  description?: string;
  eyebrow?: string;
  actions?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  const [mobileNav, setMobileNav] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    setMobileNav(false);
  }, [pathname]);

  return (
    <div className="min-h-screen bg-background">
      <Sidebar open={mobileNav} onClose={() => setMobileNav(false)} />

      <div className="lg:pl-[248px]">
        <TopBar onMenu={() => setMobileNav(true)} />

        <main
          className={`mx-auto w-full px-6 py-10 sm:px-8 lg:px-10 ${wide ? "max-w-[1600px]" : "max-w-[1160px]"}`}
        >
          <div className="mb-9 flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-0">
              {eyebrow ? <p className="label-xs mb-2">{eyebrow}</p> : null}
              <h1 className="text-3xl font-semibold text-foreground">{title}</h1>
              {description ? <p className="mt-1.5 text-sm text-muted-foreground">{description}</p> : null}
            </div>
            {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
          </div>
          <div className="animate-in">{children}</div>
        </main>
      </div>
    </div>
  );
}

function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const body = (
    <div className="flex h-full flex-col bg-nav">
      <div className="flex h-16 shrink-0 items-center gap-2.5 border-b border-nav-border px-5">
        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground">
          <Ship className="size-3.5" />
        </span>
        <span className="text-[13px] font-semibold tracking-[0.01em] text-nav-foreground">WhiteWind</span>
        <button
          className="focus-ring ml-auto rounded-md p-1 text-nav-muted-foreground lg:hidden"
          onClick={onClose}
          aria-label="Close navigation"
        >
          <X className="size-4" />
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-5">
        {NAV_GROUPS.map((group, gi) => (
          <div key={group.label || `g${gi}`} className={gi === 0 ? "" : "mt-5"}>
            {group.label ? (
              <p className="label-xs px-2.5 pb-2 text-nav-muted-foreground">{group.label}</p>
            ) : null}
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const active = item.to === "/" ? pathname === "/" : pathname === item.to;
                return (
                  <li key={item.to}>
                    <Link
                      to={item.to}
                      className={`flex items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[13px] transition-colors duration-150 ${
                        active
                          ? "bg-nav-active font-medium text-nav-active-foreground"
                          : "text-nav-muted-foreground hover:bg-nav-elevated hover:text-nav-foreground"
                      }`}
                    >
                      <item.icon className="size-[15px] shrink-0" />
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
        <p className="text-xs text-nav-foreground/80">Logistics Intelligence</p>
        <p className="text-xs text-nav-muted-foreground">v1.0 · Operations workspace</p>
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
    <header className="sticky top-0 z-20 border-b border-border bg-surface/95 backdrop-blur">
      <div className="flex h-14 items-center gap-3 px-5 sm:px-6 lg:px-8">
        <button
          className="focus-ring rounded-md p-2 text-muted-foreground transition-colors hover:bg-subtle lg:hidden"
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

function GlobalSearch() {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const ref = useDismiss(() => setOpen(false));

  const { data: shipments = [] } = useQuery({ queryKey: ["shipments"], queryFn: listShipments });

  const term = q.trim().toLowerCase();
  const results = term
    ? shipments
        .filter((s) =>
          [s.client_name, s.origin, s.destination, s.vessel_name ?? "", s.vessel_mmsi ?? "", shortId(s.id)]
            .join(" ")
            .toLowerCase()
            .includes(term),
        )
        .slice(0, 6)
    : [];

  return (
    <div ref={ref} className="relative w-full max-w-[400px]">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="Search shipments, clients, vessels, MMSI…"
        className="focus-ring h-8 w-full rounded-md border border-input bg-background pl-8 pr-2.5 text-sm transition-colors placeholder:text-muted-foreground"
      />
      {open && term ? (
        <div className="panel-lifted animate-in absolute left-0 top-9 z-30 w-full overflow-hidden p-1">
          {results.length === 0 ? (
            <p className="px-2.5 py-3 text-xs text-muted-foreground">No shipments match “{q.trim()}”.</p>
          ) : (
            results.map((s) => (
              <button
                key={s.id}
                className="focus-ring flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-subtle"
                onClick={() => {
                  setOpen(false);
                  setQ("");
                  navigate({ to: "/shipments/$id", params: { id: s.id } });
                }}
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
      ) : null}
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
        className="focus-ring relative rounded-md p-2 text-muted-foreground transition-colors hover:bg-subtle hover:text-foreground"
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
        className="focus-ring flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-subtle"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="grid size-6 place-items-center rounded-md bg-primary text-[10px] font-semibold text-primary-foreground">
          ST
        </span>
        <span className="hidden leading-tight sm:block">
          <span className="block text-xs font-medium">StimTech Solutions</span>
          <span className="block text-xs text-muted-foreground">Operations</span>
        </span>
        <ChevronDown className="size-3.5 text-muted-foreground" />
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
 * A labelled number, quiet by default — the single shared visual language
 * for "a KPI" used by both the dashboard strip and Analytics, so the same
 * concept never has to be re-invented per page.
 */
export function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: ReactNode;
  tone?: "risk";
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="label-xs">{label}</span>
      <span className="inline-flex items-center gap-2 text-2xl font-semibold tabular-nums text-foreground">
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

export const btnDanger =
  "focus-ring inline-flex h-9 items-center gap-1.5 rounded-md border border-destructive/30 bg-surface px-3.5 text-sm font-medium text-destructive transition-colors duration-150 hover:bg-risk-soft active:scale-[0.98]";

export const fieldClass =
  "focus-ring h-9 w-full rounded-md border border-input bg-surface px-2.5 text-sm text-foreground transition-colors placeholder:text-muted-foreground";
