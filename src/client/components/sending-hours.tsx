import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SendRange } from "@/types";

// Sending hours: the stretches of the day email goes out in. Settings has the
// workspace's; a campaign can have its own.

export function zones(current: string): Array<{ value: string; label: string }> {
  let all: string[] = [];
  try {
    all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    all = [];
  }
  if (!all.includes("UTC")) all = ["UTC", ...all];
  if (current && !all.includes(current)) all = [current, ...all];
  return all.map((z) => ({ value: z, label: z.replace(/_/g, " ") }));
}

/** "09:00–12:00 and 14:00–17:00, weekdays, Europe/Amsterdam" */
export function describeHours(w: { ranges: SendRange[]; weekdays_only: boolean; timezone: string }): string {
  const hours = w.ranges.map((r) => `${r.from}–${r.until}`).join(" and ");
  return `${hours}${w.weekdays_only ? ", weekdays" : ""}, ${w.timezone.replace(/_/g, " ")}`;
}

export function TimeField({ label, value, disabled, onSave }: { label: string; value: string; disabled?: boolean; onSave: (t: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <Input aria-label={label} type="time" className="w-28" value={text} disabled={disabled} onChange={(e) => setText(e.target.value)}
      onBlur={() => /^\d\d:\d\d$/.test(text) && text !== value ? onSave(text) : setText(value)} />
  );
}

const MAX_RANGES = 4;
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const toTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** A range one hour after the last one ends, two hours long; null when the day has no room. */
function nextRange(ranges: SendRange[]): SendRange | null {
  const from = toMin(ranges[ranges.length - 1].until) + 60;
  const until = Math.min(from + 120, 23 * 60 + 59);
  return until - from >= 30 ? { from: toTime(from), until: toTime(until) } : null;
}

/** The ranges, one row each, saved whole on every change: the server checks they don't overlap. */
export function RangesField({ ranges, disabled, onSave }: { ranges: SendRange[]; disabled?: boolean; onSave: (r: SendRange[]) => void }) {
  const next = nextRange(ranges);
  const set = (i: number, part: keyof SendRange, t: string) => onSave(ranges.map((r, j) => (j === i ? { ...r, [part]: t } : r)));
  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      {ranges.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <TimeField label={`From, range ${i + 1}`} value={r.from} disabled={disabled} onSave={(t) => set(i, "from", t)} />
          <span className="text-muted-foreground">to</span>
          <TimeField label={`Until, range ${i + 1}`} value={r.until} disabled={disabled} onSave={(t) => set(i, "until", t)} />
          {ranges.length > 1 && (
            <Button size="icon" variant="ghost" aria-label={`Remove ${r.from} to ${r.until}`} disabled={disabled}
              onClick={() => onSave(ranges.filter((_, j) => j !== i))}>
              <X />
            </Button>
          )}
        </div>
      ))}
      {ranges.length < MAX_RANGES && next && (
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onSave([...ranges, next])}>
          <Plus /> Add hours
        </Button>
      )}
    </div>
  );
}
