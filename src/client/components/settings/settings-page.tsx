import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api } from "@/api";
import { useApp } from "@/context";
import { useLoad } from "@/hooks/use-load";
import { ago, due } from "@/lib/format";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/shared";
import { Notice, Row, Rows, Section, Switch } from "@/components/settings-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Picker } from "@/components/ui/picker";
import type { SettingsView } from "@/types";

function zones(current: string): Array<{ value: string; label: string }> {
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

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Where and when email goes out, and what every draft is framed by. Only a
 * signed-in person changes these; everyone else reads them.
 */
export function SettingsPage() {
  const { setError, refresh } = useApp();
  const view = useLoad<SettingsView>("/api/settings");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const zoneOptions = useMemo(() => zones(view.data?.settings.timezone ?? ""), [view.data?.settings.timezone]);

  const save = async (patch: Record<string, unknown>) => {
    setBusy(true);
    try {
      view.setData(await api<SettingsView>("PUT", "/api/settings", patch));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
      await view.reload();
    } finally {
      setBusy(false);
    }
  };

  const checkNow = async () => {
    setChecking(true);
    try {
      await api("POST", "/api/run-now", {});
      await Promise.all([view.reload(), refresh()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not check");
    } finally {
      setChecking(false);
    }
  };

  const v = view.data;
  if (!v) {
    return (
      <>
        <PageHeader title="Settings" />
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading…</div>
      </>
    );
  }
  const s = v.settings;
  const can = v.can_configure && !busy;
  const crmOptions = [
    { value: "", label: "None" },
    ...v.crm_apps.map((a) => ({ value: a.id, label: a.name })),
  ];

  return (
    <>
      <PageHeader title="Settings">
        <Button size="sm" variant="outline" onClick={() => void checkNow()} disabled={checking}>
          <RefreshCw className={cn(checking && "animate-spin")} /> Check now
        </Button>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto flex max-w-2xl flex-col gap-8">
          {!v.can_configure && <Notice>Only a person signed in to Clawnify can change these.</Notice>}

          <Section title="Sending">
            {!v.connections.mail && <Notice>Gmail isn't connected. Connect it in Clawnify (Settings, Integrations), then pick the mailbox here.</Notice>}
            <Rows label="Sending">
              <Row
                title="Send from"
                hint={
                  <>
                    Use a mailbox on a separate domain for outreach, so your main domain's reputation stays safe. Add it in Clawnify: Integrations, Gmail, Add another account.
                    {v.live_threads > 0 && ` ${v.live_threads} conversations started from the current mailbox only carry on from it.`}
                  </>
                }
              >
                <Picker
                  label="Send from"
                  className="w-64"
                  disabled={!can || v.mailboxes.length === 0}
                  value={s.mailbox ?? ""}
                  placeholder={v.mailboxes.length ? "Pick a mailbox" : "No Gmail connected"}
                  options={v.mailboxes.map((m) => ({ value: m.address, label: m.address, hint: m.isDefault ? "The workspace's main Gmail" : undefined }))}
                  onChange={(address) => void save({ mailbox: address })}
                />
              </Row>
              <Row title="Warm up a new mailbox" hint={s.ramp_from ? `Since ${s.ramp_from}: 10 emails a day the first week, 10 more each week, up to the daily cap.` : "A new address starts slowly: 10 emails a day, 10 more each week, up to the daily cap."}>
                <Switch label="Warm up a new mailbox" checked={!!s.ramp_from} disabled={!can} onChange={(on) => void save({ ramp_from: on ? today() : null })} />
              </Row>
              <Row title="Emails a day" hint="All campaigns together. They are spread across the sending hours." htmlFor="cap">
                <NumberField id="cap" value={s.daily_cap} min={1} max={200} disabled={!can} onSave={(n) => void save({ daily_cap: n })} />
              </Row>
              <Row title="Sending hours" hint="Local time. Nothing goes out outside them.">
                <TimeField label="From" value={s.send_from} disabled={!can} onSave={(t) => void save({ send_from: t })} />
                <span className="text-muted-foreground">to</span>
                <TimeField label="Until" value={s.send_until} disabled={!can} onSave={(t) => void save({ send_until: t })} />
              </Row>
              <Row title="Time zone">
                <Picker label="Time zone" className="w-64" disabled={!can} value={s.timezone} options={zoneOptions} searchPlaceholder="Search time zones" onChange={(tz) => void save({ timezone: tz })} />
              </Row>
              <Row title="Weekdays only">
                <Switch label="Weekdays only" checked={s.weekdays_only} disabled={!can} onChange={(on) => void save({ weekdays_only: on })} />
              </Row>
            </Rows>
            <p className="text-[0.8125rem] text-muted-foreground">
              {v.sending.mailbox
                ? `Today ${v.sending.sent_today} of ${v.sending.cap_today} sent; the next one can go ${due(v.sending.next_send_at)}. `
                : "Nothing goes out until a mailbox is picked. "}
              {v.sending.last_run_at ? `Replies and booked meetings were last checked ${ago(v.sending.last_run_at)}.` : "Replies and booked meetings haven't been checked yet."}
            </p>
            {v.sending.last_error && <Notice>The last check stopped: {v.sending.last_error}</Notice>}
          </Section>

          <Section title="Writing" description="Every draft starts from what you sell and the campaign's angle. The signature and the opt-out line are added under every email when it goes out.">
            <TextSetting label="What you sell" rows={3} max={1000} value={s.about} disabled={!can} placeholder="e.g. Site management software for building firms: permits, planning and photos in one place." onSave={(t) => void save({ about: t })} />
            <TextSetting label="Signature" rows={4} max={1000} value={s.signature} disabled={!can} placeholder={"Sam de Vries\nOurCo · ourco.example"} onSave={(t) => void save({ signature: t })} />
            <TextSetting label="Opt-out line" rows={2} max={300} value={s.opt_out} disabled={!can} onSave={(t) => void save({ opt_out: t })}
              hint="Required, in any words you like: people answer in their own, and the AI reads every reply. Anyone who asks you to stop is never emailed again; a short answer that might mean it is flagged on Replies for you to decide." />
          </Section>

          <Section title="CRM" description="Sends, replies and booked meetings are written onto the contact's timeline in the CRM. The CRM reads only the main mailbox, so this is how it sees outreach.">
            <Rows label="CRM">
              <Row title="Write to" hint={v.crm_apps.length ? undefined : "No CRM in this workspace."}>
                <Picker label="CRM" className="w-56" disabled={!can || v.crm_apps.length === 0} value={s.crm_in_use ?? ""} options={crmOptions}
                  onChange={(id) => void save({ crm_app_id: id })} />
              </Row>
            </Rows>
            {v.sending.crm_error && <Notice>The last write to the CRM failed: {v.sending.crm_error}</Notice>}
          </Section>
        </div>
      </div>
    </>
  );
}

function TextSetting({ label, value, onSave, rows, max, disabled, placeholder, hint }: {
  label: string; value: string; onSave: (v: string) => void; rows: number; max: number; disabled?: boolean; placeholder?: string; hint?: string;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <label className="flex flex-col gap-1.5 text-sm font-medium">
      {label}
      <Textarea rows={rows} maxLength={max} value={text} disabled={disabled} placeholder={placeholder} onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== value && onSave(text)} />
      {hint && <span className="text-[0.8125rem] font-normal text-muted-foreground">{hint}</span>}
    </label>
  );
}

function NumberField({ id, value, min, max, disabled, onSave }: { id: string; value: number; min: number; max: number; disabled?: boolean; onSave: (n: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Math.round(Number(text));
    if (!Number.isFinite(n) || n < min || n > max) return setText(String(value));
    if (n !== value) onSave(n);
  };
  return <Input id={id} type="number" min={min} max={max} className="w-20" value={text} disabled={disabled} onChange={(e) => setText(e.target.value)} onBlur={commit} />;
}

function TimeField({ label, value, disabled, onSave }: { label: string; value: string; disabled?: boolean; onSave: (t: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <Input aria-label={label} type="time" className="w-28" value={text} disabled={disabled} onChange={(e) => setText(e.target.value)}
      onBlur={() => /^\d\d:\d\d$/.test(text) && text !== value ? onSave(text) : setText(value)} />
  );
}
