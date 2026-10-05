import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
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
import { SignatureEditor } from "@/components/signature-editor";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { SettingsView, Signature } from "@/types";

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
  const agentOptions = [
    { value: "", label: "None" },
    ...v.agents.map((a) => ({ value: a.id, label: `${a.name}${agentState(a.status)}` })),
    // The one picked, if it is no longer in the workspace.
    ...(s.research_agent_id && !v.agents.some((a) => a.id === s.research_agent_id)
      ? [{ value: s.research_agent_id, label: `${s.research_agent_name ?? "Agent"} (no longer in this workspace)` }]
      : []),
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
            <TextSetting label="What you sell" rows={3} max={1000} value={s.about} disabled={!can}
              placeholder={v.about_source ? `Empty: drafts use “${v.about_source.title}” from Company Knowledge.` : "e.g. Site management software for building firms: permits, planning and photos in one place."}
              hint={<AboutSource view={v} filled={!!s.about.trim()} />}
              onSave={(t) => void save({ about: t })} />

            <TextSetting label="Opt-out line" rows={2} max={300} value={s.opt_out} disabled={!can} onSave={(t) => void save({ opt_out: t })}
              hint="Required, in any words you like: people answer in their own, and the AI reads every reply. Anyone who asks you to stop is never emailed again; a short answer that might mean it is flagged on Replies for you to decide." />
          </Section>

          <Section title="Research" description="Steps set to “The agent researches first” are handed to this agent, up to 10 people at a time. It looks into each person and their company, and its drafts land in To approve. A sleeping agent is woken for it, and its runs use the workspace's credits.">
            <Rows label="Research">
              <Row title="Research agent" hint={v.agents_error ? `The workspace's agents can't be listed: ${v.agents_error}` : v.agents.length ? undefined : "No agents in this workspace yet."}>
                <Picker label="Research agent" className="w-56" disabled={!can || (v.agents.length === 0 && !s.research_agent_id)} value={s.research_agent_id ?? ""} options={agentOptions}
                  onChange={(id) => void save({ research_agent_id: id || null })} />
              </Row>
            </Rows>
            {s.research_error && <Notice>{s.research_error}</Notice>}
          </Section>

          <SignaturesSection view={v} disabled={!can} onSaveDefaults={(patch) => save(patch)} onChanged={() => view.reload()} />

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

/** Where "What you sell" comes from: this field, or the org's Company Knowledge document when it's empty. */
function AboutSource({ view: v, filled }: { view: SettingsView; filled: boolean }) {
  const doc = v.about_source;
  const link = doc && (
    <a href={doc.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">{doc.title} v{doc.version}</a>
  );
  if (doc && filled) return <>Filled in, this wins over {link} in Company Knowledge. Clear it to use the document.</>;
  if (doc) return <>From Company Knowledge: {link}. Write here to use different words in this app.</>;
  if (v.about_source_error) return <>Company Knowledge can't be read right now ({v.about_source_error}).</>;
  if (filled) return null;
  return <>Or pin a document as “What you sell” in Clawnify, under Settings, Brand, and leave this empty.</>;
}

/** How an agent's state reads next to its name: nothing when it can take work. */
function agentState(status: string): string {
  if (status === "ready" || status === "active") return "";
  if (status === "sleeping" || status === "dreaming") return " (asleep)";
  if (status === "error") return " (unavailable)";
  return " (starting)";
}

/**
 * Named signatures, as in Gmail: the list on the left, the one picked on the
 * right (Visual or Code), and which one first emails and follow-ups get unless
 * a campaign picks its own. "Copy from Gmail" reads the sending mailbox's
 * default signature into the one picked.
 */
function SignaturesSection({ view, disabled, onSaveDefaults, onChanged }: {
  view: SettingsView;
  disabled?: boolean;
  onSaveDefaults: (patch: Record<string, unknown>) => Promise<void>;
  onChanged: () => Promise<void>;
}) {
  const { setError } = useApp();
  const sigs = view.signatures;
  const [picked, setPicked] = useState<string | null>(sigs[0]?.id ?? null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [confirm, setConfirm] = useState<Signature | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // The one picked, or the first when it was deleted (or is still being created).
  const current = sigs.find((x) => x.id === picked) ?? sigs[0] ?? null;

  const call = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the signature");
    }
  };

  const create = () => call(async () => {
    const r = await api<{ signature: Signature }>("POST", "/api/signatures", { name: `Signature ${sigs.length + 1}`, body: "" });
    setPicked(r.signature.id);
    setRenaming(r.signature.id);
    setName(r.signature.name);
  });

  const rename = (id: string) => {
    setRenaming(null);
    const next = name.trim();
    if (next && next !== sigs.find((x) => x.id === id)?.name) void call(() => api("PATCH", `/api/signatures/${id}`, { name: next }));
  };

  const fromGmail = async () => {
    if (!current) return;
    setNote(null);
    try {
      const r = await api<{ address: string; signature: string }>("GET", "/api/settings/gmail-signature");
      if (!r.signature) {
        setNote(`Gmail has no default signature for ${r.address}: Gmail's API only shows the one picked under Settings, Signature defaults, "For new emails use". Pick one there, or copy it from Gmail and paste it here.`);
        return;
      }
      await call(() => api("PATCH", `/api/signatures/${current.id}`, { body: r.signature }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read Gmail's signature");
    }
  };

  const options = [{ value: "", label: "No signature" }, ...sigs.map((x) => ({ value: x.id, label: x.name }))];
  const set = view.settings;

  return (
    <Section title="Signatures" description="As in Gmail: as many as you like, one for first emails and one for follow-ups, and a campaign can pick its own. Paste a formatted signature and it keeps its links and styling; with one, emails go out as HTML.">
      <div className="flex flex-col gap-3 md:flex-row">
        <ul className="flex shrink-0 flex-col rounded-md bg-card p-1 shadow-edge md:w-52" aria-label="Signatures">
          {sigs.map((x) => (
            <li key={x.id} className="group flex items-center gap-1">
              {renaming === x.id ? (
                <Input aria-label="Signature name" value={name} autoFocus maxLength={80} className="h-8"
                  onChange={(e) => setName(e.target.value)} onBlur={() => rename(x.id)}
                  onKeyDown={(e) => { if (e.key === "Enter") rename(x.id); if (e.key === "Escape") setRenaming(null); }} />
              ) : (
                <>
                  <button type="button" onClick={() => setPicked(x.id)} aria-current={x.id === current?.id ? "true" : undefined}
                    className={cn("min-w-0 flex-1 truncate rounded-sm px-2.5 py-1.5 text-left text-sm hover:bg-secondary", x.id === current?.id && "bg-secondary font-medium")}>
                    {x.name}
                  </button>
                  <Button size="icon" variant="ghost" aria-label={`Rename ${x.name}`} disabled={disabled} className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={() => { setRenaming(x.id); setName(x.name); }}><Pencil /></Button>
                  <Button size="icon" variant="ghost" aria-label={`Delete ${x.name}`} disabled={disabled} className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={() => setConfirm(x)}><Trash2 /></Button>
                </>
              )}
            </li>
          ))}
          <li>
            <Button size="sm" variant="ghost" className="w-full justify-start" disabled={disabled} onClick={() => void create()}><Plus /> Create new</Button>
          </li>
        </ul>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {current ? (
            <>
              <SignatureEditor key={current.id} value={current.body} disabled={disabled}
                onSave={(body) => call(() => api("PATCH", `/api/signatures/${current.id}`, { body }))} />
              <div className="flex items-center justify-between gap-2">
                <span className="text-[0.8125rem] text-muted-foreground">Paste formatted text and it keeps its formatting. Saved when you click away.</span>
                <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void fromGmail()}>Copy from Gmail</Button>
              </div>
              {note && <p className="text-[0.8125rem] text-muted-foreground">{note}</p>}
            </>
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">No signatures yet.</p>
          )}
        </div>
      </div>
      <Rows label="Signature defaults">
        <Row title="For first emails use">
          <Picker label="For first emails use" className="w-56" disabled={disabled} value={set.signature_id ?? ""} options={options}
            onChange={(id) => void onSaveDefaults({ signature_id: id || null })} />
        </Row>
        <Row title="For follow-ups use" hint="Follow-ups reply in the thread, under the first email.">
          <Picker label="For follow-ups use" className="w-56" disabled={disabled} value={set.reply_signature_id ?? ""} options={options}
            onChange={(id) => void onSaveDefaults({ reply_signature_id: id || null })} />
        </Row>
      </Rows>
      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {confirm?.name}?</DialogTitle>
            <DialogDescription>Campaigns that use it switch to the workspace default; a default that was this one becomes no signature.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => { const x = confirm!; setConfirm(null); void call(() => api("DELETE", `/api/signatures/${x.id}`)); }}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Section>
  );
}

function TextSetting({ label, value, onSave, rows, max, disabled, placeholder, hint }: {
  label: string; value: string; onSave: (v: string) => void; rows: number; max: number; disabled?: boolean; placeholder?: string; hint?: ReactNode;
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
