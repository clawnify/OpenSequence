import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

// The pieces settings and setup screens are made of.

export function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">{title}</h2>
      {description && <p className="text-[0.8125rem] text-muted-foreground">{description}</p>}
      <div className="flex flex-col gap-2 pt-1">{children}</div>
    </section>
  );
}

export function Notice({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md bg-warning-tint px-3 py-2 text-[0.8125rem] text-warning">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  );
}

/** Bordered rows: a list of settings, one control each. */
export function Rows({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div aria-label={label} className="flex flex-col rounded-md bg-card shadow-edge [&>*+*]:border-t [&>*+*]:border-border">
      {children}
    </div>
  );
}

/** One setting: what it is and a hint on the left, its control on the right (below on a phone). */
export function Row({ title, hint, children, htmlFor }: { title: string; hint?: ReactNode; children?: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-6">
      <div className="min-w-0 flex-1">
        <label htmlFor={htmlFor} className="block text-sm font-medium">{title}</label>
        {hint && <div className="mt-0.5 text-[0.8125rem] text-muted-foreground">{hint}</div>}
      </div>
      {children && <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
        checked ? "bg-primary" : "bg-border",
      )}
    >
      <span className={cn("inline-block size-4 rounded-full bg-card shadow-raised transition-transform", checked ? "translate-x-[1.125rem]" : "translate-x-0.5")} />
    </button>
  );
}
