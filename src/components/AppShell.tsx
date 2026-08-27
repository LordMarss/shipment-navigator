import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

const NAV = [
  { to: "/", label: "Dashboard" },
  { to: "/map", label: "Fleet Map" },
  { to: "/alerts", label: "Alerts" },
] as const;

export function AppShell({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex h-12 max-w-6xl items-center gap-6 px-4">
          <Link to="/" className="text-[13px] font-semibold tracking-tight text-foreground">
            StimTech Solutions
          </Link>
          <nav className="flex items-center gap-1">
            {NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                activeOptions={{ exact: item.to === "/" }}
                className="rounded-sm px-2 py-1 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-subtle hover:text-foreground"
                activeProps={{ className: "bg-subtle text-foreground" }}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-[17px] font-semibold text-foreground">{title}</h1>
            {description ? (
              <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </div>
        {children}
      </main>
    </div>
  );
}

export const btnPrimary =
  "focus-ring inline-flex h-8 items-center rounded-sm border border-primary bg-primary px-3 text-[13px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-45";

export const btnGhost =
  "focus-ring inline-flex h-8 items-center rounded-sm border border-border bg-surface px-3 text-[13px] font-medium text-foreground transition-colors hover:bg-subtle disabled:opacity-45";

export const btnDanger =
  "focus-ring inline-flex h-8 items-center rounded-sm border border-destructive/30 bg-surface px-3 text-[13px] font-medium text-destructive transition-colors hover:bg-risk-soft";

export const fieldClass =
  "focus-ring h-8 w-full rounded-sm border border-input bg-surface px-2 text-[13px] text-foreground placeholder:text-muted-foreground";
