import { useEffect, useMemo, useState } from "react";
import { MoreHorizontal, Pause, Play, Plus, Square, Trash2, UserPlus } from "lucide-react";
import { useChatCommands, useChatContext } from "@clawnify/app/client";
import { api } from "@/api";
import { useApp } from "@/context";
import { useLoad } from "@/hooks/use-load";
import { withQuery, type CampaignTab, type Navigate } from "@/hooks/use-router";
import { CAMPAIGN_STATUS, CHANNEL_ICON, CHANNEL_LABEL, ENROLLMENT_STATUS, ago, due, personName, plural } from "@/lib/format";
import { EmptyState, PageHeader, Pager, Pill, SectionTitle } from "@/components/shared";
import { Notice } from "@/components/settings-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Picker } from "@/components/ui/picker";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AddPeopleDialog } from "./add-people-dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CampaignSettings } from "./campaign-settings";
import type { Campaign, CampaignPerson, Channel, EnrollmentStatus, Page, PeopleList, SourceActivity, Step, Writer } from "@/types";

const CHANNELS: Channel[] = ["email", "call", "linkedin", "task"];
const WRITER_OPTIONS: Array<{ value: Writer; label: string; hint: string }> = [
  { value: "research", label: "The agent researches first", hint: "For an email that has to be about them" },
  { value: "thread", label: "The AI writes from the thread", hint: "For follow-ups" },
];

const TABS: Array<{ value: CampaignTab; label: string }> = [
  { value: "steps", label: "Steps" },
  { value: "people", label: "People" },
  { value: "settings", label: "Settings" },
];

export function CampaignPage({ id, tab, navigate }: { id: string; tab: CampaignTab; navigate: Navigate }) {
  const { setError, refresh } = useApp();
  const data = useLoad<{ campaign: Campaign; steps: Step[]; source_activity?: SourceActivity }>(`/api/campaigns/${encodeURIComponent(id)}`);
  const [peopleKey, setPeopleKey] = useState(0);
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<"archive" | "delete" | null>(null);
  const c = data.data?.campaign;

  useChatContext(c ? { label: "Campaign", record: { type: "campaign", id: c.id, label: c.name } } : null);
  useChatCommands(c ? [{
    id: "find-people-here",
    label: "Find people for this campaign",
    prompt: `Find people who fit the OpenSequence campaign ${c.id} (read its angle first) and add them to it, with what you found about each in their notes. Ask me how many.`,
  }] : []);

  const patch = async (body: Record<string, unknown>) => {
    try {
      const r = await api<{ campaign: Campaign }>("PATCH", `/api/campaigns/${encodeURIComponent(id)}`, body);
      data.setData((d) => (d ? { ...d, campaign: r.campaign } : d));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    }
  };

  const remove = async () => {
    try {
      await api("DELETE", `/api/campaigns/${encodeURIComponent(id)}`);
      await refresh();
      navigate("/campaigns");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete");
    }
  };

  if (!c) return <PageHeader title="Campaign" />;
  const st = CAMPAIGN_STATUS[c.status];

  return (
    <>
      <PageHeader title={c.name} meta={`${plural(c.people, "person", "people")} · ${c.reached} reached · ${c.replied} replied · ${plural(c.meetings, "meeting")}`}>
        <Pill tone={st.tone}>{st.label}</Pill>
        {c.status === "draft" && <Button size="sm" onClick={() => void patch({ status: "active" })}><Play /> Start</Button>}
        {c.status === "active" && <Button size="sm" variant="outline" onClick={() => void patch({ status: "paused" })}><Pause /> Pause</Button>}
        {c.status === "paused" && <Button size="sm" onClick={() => void patch({ status: "active" })}><Play /> Resume</Button>}
        {c.status !== "archived" && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" aria-label="More"><MoreHorizontal /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setConfirm("archive")}>Archive</DropdownMenuItem>
              {c.sent === 0 && <DropdownMenuItem onSelect={() => setConfirm("delete")} className="text-destructive">Delete</DropdownMenuItem>}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </PageHeader>
      <div className="shrink-0 border-b border-border px-4 py-2.5 md:px-6">
        <Tabs value={tab} onValueChange={(v) => navigate(withQuery({ tab: v === "steps" ? null : v }))}>
          <TabsList>
            {TABS.map((t) => (
              <TabsTrigger key={t.value} value={t.value} className="gap-1.5">
                {t.label}
                {t.value === "steps" && <span className="tabular text-muted-foreground">{data.data!.steps.length}</span>}
                {t.value === "people" && <span className="tabular text-muted-foreground">{c.people}</span>}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        {/* Every tab stays mounted, so unsaved steps survive a look at the settings. */}
        <div hidden={tab !== "steps"} className="mx-auto max-w-4xl">
          {!c.angle.trim() && (
            <div className="mb-4">
              <Notice action={<Button size="sm" variant="outline" onClick={() => navigate(withQuery({ tab: "settings" }))}>Settings</Button>}>
                Say who this campaign is for in Settings: every draft starts from it.
              </Notice>
            </div>
          )}
          <StepsEditor key={data.data!.steps.map((s) => s.id).join()} campaignId={c.id} steps={data.data!.steps} onSaved={(steps) => data.setData((d) => (d ? { ...d, steps } : d))} />
        </div>
        <div hidden={tab !== "people"} className="mx-auto max-w-4xl">
          <section className="flex flex-col gap-3">
            <SectionTitle action={c.status !== "archived" && <Button size="sm" variant="outline" onClick={() => setAdding(true)}><UserPlus /> Add people</Button>}>
              People
            </SectionTitle>
            <ListSource campaign={c} activity={data.data?.source_activity} onSave={patch} />
            <CampaignPeople key={peopleKey} campaign={c} navigate={navigate} onChanged={() => void data.reload()} />
          </section>
        </div>
        <div hidden={tab !== "settings"}>
          <CampaignSettings campaign={c} onSave={patch} />
        </div>
      </div>
      <AddPeopleDialog open={adding} onOpenChange={setAdding} campaign={c} onDone={() => { setPeopleKey((k) => k + 1); void data.reload(); void refresh(); }} />
      <Dialog open={confirm !== null} onOpenChange={(v) => !v && setConfirm(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{confirm === "delete" ? "Delete this campaign?" : "Archive this campaign?"}</DialogTitle>
            <DialogDescription>
              {confirm === "delete"
                ? "Nothing has been sent from it. Its steps and the list of people in it go; the people stay in People."
                : `Everyone still in it stops (${plural(c.live, "person", "people")}). What was sent and what came back stay.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => { const k = confirm; setConfirm(null); if (k === "delete") void remove(); else void patch({ status: "archived" }); }}>
              {confirm === "delete" ? "Delete" : "Archive"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Where new people come from on their own: a list in another app of the
 * workspace (OpenProspector), read every hour, up to a number a day.
 */
function ListSource({ campaign: c, activity, onSave }: { campaign: Campaign; activity?: SourceActivity; onSave: (b: Record<string, unknown>) => Promise<void> }) {
  const sources = useLoad<{ apps: Array<{ id: string; name: string; lists: PeopleList[]; error: string | null }> }>("/api/sources");
  if (!sources.data) return null;
  const apps = sources.data.apps;
  const current = c.source ? `${c.source.app_id}:${c.source.list_id}` : "";
  if (!apps.length && !c.source) {
    return <p className="text-[0.8125rem] text-muted-foreground">To fill this campaign every day, add OpenProspector to the workspace and make a list there.</p>;
  }
  const options = [
    { value: "", label: "No list" },
    ...apps.flatMap((a) => a.lists.map((l) => ({ value: `${a.id}:${l.id}`, label: l.name, hint: `${a.name} · ${plural(l.verified_count, "person", "people")} with an email` }))),
  ];
  if (c.source && !options.some((o) => o.value === current)) options.push({ value: current, label: `${c.source.list_name} (not found now)` });
  const pick = (v: string) => {
    if (!v) return void onSave({ source: null });
    const [appId, ...rest] = v.split(":");
    void onSave({ source: { app_id: appId, list_id: rest.join(":") } });
  };
  const skipped = activity?.recent.filter((r) => r.outcome === "skipped").slice(0, 3) ?? [];
  const inboxes = c.audience === "inboxes";
  return (
    <div className="flex flex-col gap-2 rounded-md bg-card p-3 shadow-edge">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm">
        <span>{inboxes ? "New inboxes from" : "New people from"}</span>
        <Picker label="List" className="w-64" disabled={c.status === "archived"} value={current} options={options} searchPlaceholder="Search lists" onChange={pick} />
        {c.source && (
          <>
            <span>up to</span>
            <NumberField label={inboxes ? "New inboxes a day, at most" : "New people a day, at most"} value={c.source.daily} min={1} max={200} onSave={(n) => void onSave({ source: { daily: n } })} />
            <span>a day, at most</span>
            {inboxes ? (
              <span>one per company</span>
            ) : (
              <>
                <NumberField label="People per company, at most" value={c.source.per_company} min={1} max={20} onSave={(n) => void onSave({ source: { per_company: n } })} />
                <span>per company</span>
              </>
            )}
          </>
        )}
      </div>
      {c.source && (
        <p className="text-[0.8125rem] text-muted-foreground">
          Today {activity?.taken_today ?? 0} of {c.source.daily} taken; {c.source.checked_at ? `checked ${ago(c.source.checked_at)}` : "not checked yet"}.
          {inboxes
            ? " Only companies' inboxes, and none twice. Inboxes need no lookups, so this campaign buys none."
            : " Only people with a verified email, and nobody twice. The list looks up just enough emails for this number."}
        </p>
      )}
      {skipped.map((r) => (
        <p key={`${r.email}-${r.taken_at}`} className="text-[0.8125rem] text-muted-foreground">Skipped {r.email ?? "a lead"}: {r.reason}</p>
      ))}
      {c.source?.error && <Notice>{c.source.error}</Notice>}
      {apps.filter((a) => a.error).map((a) => <Notice key={a.id}>{a.name}'s lists can't be read: {a.error}</Notice>)}
    </div>
  );
}

/** A small whole number, saved when you leave it. */
function NumberField({ label, value, min, max, onSave }: { label: string; value: number; min: number; max: number; onSave: (n: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Number(text);
    if (Number.isInteger(n) && n >= min && n <= max && n !== value) onSave(n);
    else setText(String(value));
  };
  return (
    <Input aria-label={label} type="number" inputMode="numeric" min={min} max={max} value={text} className="h-8 w-16"
      onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") commit(); }} />
  );
}

function StepsEditor({ campaignId, steps: saved, onSaved }: { campaignId: string; steps: Step[]; onSaved: (s: Step[]) => void }) {
  const { setError } = useApp();
  const [steps, setSteps] = useState<Step[]>(saved);
  const [busy, setBusy] = useState(false);
  const dirty = useMemo(() => JSON.stringify(steps) !== JSON.stringify(saved), [steps, saved]);
  const set = (i: number, patch: Partial<Step>) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  let day = 0;

  const save = async () => {
    setBusy(true);
    try {
      const r = await api<{ steps: Step[] }>("PUT", `/api/campaigns/${encodeURIComponent(campaignId)}/steps`, {
        steps: steps.map((s) => ({ id: s.id, wait_days: s.wait_days, channel: s.channel, writer: s.writer, instructions: s.instructions })),
      });
      setSteps(r.steps);
      onSaved(r.steps);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the steps");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <SectionTitle
        action={dirty && (
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setSteps(saved)}>Discard</Button>
            <Button size="sm" disabled={busy} onClick={() => void save()}>Save steps</Button>
          </div>
        )}
      >
        Steps
      </SectionTitle>
      <ol className="flex flex-col rounded-md bg-card shadow-edge">
        {steps.map((s, i) => {
          day += s.wait_days;
          return (
            <li key={s.id ?? `new-${i}`} className="flex flex-col gap-3 p-4 [&+li]:border-t [&+li]:border-border">
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-16 shrink-0 text-sm font-medium">Step {i + 1}</span>
                <span className="w-16 shrink-0 tabular text-[0.8125rem] text-muted-foreground">day {day}</span>
                <Picker label={`Step ${i + 1} channel`} className="w-32" value={s.channel}
                  options={CHANNELS.map((ch) => ({ value: ch, label: CHANNEL_LABEL[ch], icon: CHANNEL_ICON[ch] }))}
                  onChange={(v) => set(i, { channel: v as Channel })} />
                {s.channel === "email" && (
                  <Picker label={`Step ${i + 1} writer`} className="w-60" value={s.writer} options={WRITER_OPTIONS} onChange={(v) => set(i, { writer: v as Writer })} />
                )}
                <label className="flex items-center gap-2 text-[0.8125rem] text-muted-foreground">
                  Wait
                  <Input type="number" min={0} max={60} value={s.wait_days} className="w-16"
                    onChange={(e) => set(i, { wait_days: Math.max(0, Math.min(60, Math.round(Number(e.target.value) || 0))) })} />
                  {i === 0 ? "days after joining" : "days"}
                </label>
                {steps.length > 1 && (
                  <Button size="icon" variant="ghost" className="ml-auto" aria-label={`Remove step ${i + 1}`} onClick={() => setSteps((x) => x.filter((_, j) => j !== i))}>
                    <Trash2 />
                  </Button>
                )}
              </div>
              <Textarea aria-label={`Step ${i + 1} instructions`} rows={2} maxLength={2000} value={s.instructions}
                placeholder={s.channel === "email" ? "What this email is for, e.g. a short follow-up with one useful point" : `What the ${CHANNEL_LABEL[s.channel].toLowerCase()} is for`}
                onChange={(e) => set(i, { instructions: e.target.value })} />
            </li>
          );
        })}
      </ol>
      {steps.length < 10 && (
        <Button size="sm" variant="ghost" className="self-start" onClick={() => setSteps((x) => [...x, { wait_days: 3, channel: "email", writer: "thread", instructions: "" }])}>
          <Plus /> Add a step
        </Button>
      )}
    </section>
  );
}

const STATUS_FILTER: Array<{ value: "" | EnrollmentStatus; label: string }> = [
  { value: "", label: "Everyone" },
  { value: "active", label: "In sequence" },
  { value: "paused", label: "Paused" },
  { value: "replied", label: "Replied" },
  { value: "meeting", label: "Meeting booked" },
  { value: "finished", label: "Finished" },
  { value: "stopped", label: "Stopped" },
  { value: "bounced", label: "Bounced" },
  { value: "unsubscribed", label: "Unsubscribed" },
];

function CampaignPeople({ campaign, navigate, onChanged }: { campaign: Campaign; navigate: Navigate; onChanged: () => void }) {
  const { setError, refresh } = useApp();
  const [status, setStatus] = useState<"" | EnrollmentStatus>("");
  const [page, setPage] = useState(1);
  const list = useLoad<Page<"people", CampaignPerson>>(
    `/api/campaigns/${encodeURIComponent(campaign.id)}/people?limit=25&page=${page}${status ? `&status=${status}` : ""}`,
  );

  const act = async (e: CampaignPerson, action: "pause" | "resume" | "stop") => {
    try {
      await api("POST", `/api/enrollments/${encodeURIComponent(e.id)}/${action}`, {});
      await Promise.all([list.reload(), refresh()]);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work");
    }
  };

  const rows = list.data?.people ?? [];
  return (
    <div className="flex flex-col gap-3">
      <Picker label="Show" className="w-48" value={status} options={STATUS_FILTER} onChange={(v) => { setStatus(v as "" | EnrollmentStatus); setPage(1); }} />
      {list.data && rows.length === 0 ? (
        <EmptyState title={status ? "No one here." : "No one in this campaign yet."} />
      ) : list.data && (
        <div className="overflow-hidden rounded-md shadow-edge">
          <Table grid>
            <TableHeader>
              <TableRow>
                <TableHead pinned width={200}>Person</TableHead>
                <TableHead width={260}>Status</TableHead>
                <TableHead width={64}>Step</TableHead>
                <TableHead width={120}>Next</TableHead>
                <TableHead width={180} className="text-right"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((e) => {
                const s = ENROLLMENT_STATUS[e.status];
                return (
                  <TableRow key={e.id}>
                    <TableCell pinned>
                      <button type="button" onClick={() => navigate(`/people/${encodeURIComponent(e.person.id)}`)} className="block w-full truncate text-left font-medium hover:underline">
                        {personName(e.person)}
                      </button>
                    </TableCell>
                    <TableCell>
                      <div className="flex min-w-0 items-center gap-2">
                        <Pill tone={s.tone}>{s.label}</Pill>
                        {e.reason && <span className="truncate text-muted-foreground" title={e.reason}>{e.reason}</span>}
                      </div>
                    </TableCell>
                    <TableCell className="tabular">{e.step}</TableCell>
                    <TableCell className="tabular">{e.status === "active" && e.due_at ? due(e.due_at) : <span className="text-faint">-</span>}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        {e.status === "active" && <Button size="sm" variant="ghost" onClick={() => void act(e, "pause")}><Pause /> Pause</Button>}
                        {e.status === "paused" && <Button size="sm" variant="ghost" onClick={() => void act(e, "resume")}><Play /> Resume</Button>}
                        {(e.status === "active" || e.status === "paused") && <Button size="sm" variant="ghost" onClick={() => void act(e, "stop")}><Square /> Stop</Button>}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {list.data && <Pager page={list.data.page} limit={list.data.limit} total={list.data.total} onPage={setPage} />}
    </div>
  );
}
