import { type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn, getInitials, categoryClasses, colorClasses, type ColorToken } from "../lib/utils";
import { Button } from "./ui/button";

/** Initials avatar tinted by a stable category color. */
export function Avatar({ firstName, lastName, className }: { firstName?: string | null; lastName?: string | null; className?: string }) {
  const initials = getInitials(firstName, lastName);
  const c = categoryClasses(`${firstName ?? ""} ${lastName ?? ""}`.trim() || "?");
  return (
    <span className={cn("inline-flex size-7 shrink-0 items-center justify-center rounded-full text-[0.6875rem] font-semibold", c.bg, c.text, className)}>
      {initials}
    </span>
  );
}

/** A quiet status label. The tone is the state's, never decoration. */
export function Pill({ tone, children, className, title }: { tone: ColorToken; children: ReactNode; className?: string; title?: string }) {
  const c = colorClasses(tone);
  return (
    <span title={title} className={cn("inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[0.75rem] font-medium leading-5", c.bg, c.text, className)}>
      {children}
    </span>
  );
}

/** Sticky page toolbar: the title left (with a quiet detail), actions right. */
export function PageHeader({ title, meta, children }: { title: ReactNode; meta?: ReactNode; children?: ReactNode }) {
  return (
    <header className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border px-4 py-2.5 md:px-6">
      <div className="flex min-w-0 items-baseline gap-2.5">
        <h1 className="truncate text-[1.375rem] font-semibold tracking-[-0.01em]">{title}</h1>
        {meta !== undefined && <span className="tabular truncate text-[0.8125rem] text-muted-foreground">{meta}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </header>
  );
}

/** Borderless empty state: one line and at most one action. */
export function EmptyState({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-12 text-center">
      <p className="text-muted-foreground">{title}</p>
      {action}
    </div>
  );
}

/** "26–50 of 120", with previous and next. Hidden when everything fits on one page. */
export function Pager({ page, limit, total, onPage }: { page: number; limit: number; total: number; onPage: (page: number) => void }) {
  if (total <= limit) return null;
  const from = (page - 1) * limit + 1;
  const to = Math.min(total, page * limit);
  return (
    <div className="flex items-center justify-end gap-2 py-3 text-[0.8125rem] text-muted-foreground">
      <span className="tabular">{from}–{to} of {total}</span>
      <Button size="icon" variant="ghost" aria-label="Previous page" disabled={page <= 1} onClick={() => onPage(page - 1)}><ChevronLeft /></Button>
      <Button size="icon" variant="ghost" aria-label="Next page" disabled={to >= total} onClick={() => onPage(page + 1)}><ChevronRight /></Button>
    </div>
  );
}

/** A section heading inside a page. */
export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-sm font-medium">{children}</h2>
      {action}
    </div>
  );
}
