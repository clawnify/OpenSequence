import { useEffect, useMemo, useState } from "react";
import { MoreHorizontal, Pause, Play, Plus, Square, Trash2, UserPlus } from "lucide-react";
import { useChatCommands, useChatContext } from "@clawnify/app/client";
import { api } from "@/api";
import { useApp } from "@/context";
import { useLoad } from "@/hooks/use-load";
import type { Navigate } from "@/hooks/use-router";
import { CAMPAIGN_STATUS, CHANNEL_LABEL, ENROLLMENT_STATUS, due, personName, plural } from "@/lib/format";
import { EmptyState, PageHeader, Pager, Pill, SectionTitle } from "@/components/shared";
import { Switch } from "@/components/settings-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Picker } from "@/components/ui/picker";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AddPeopleDialog } from "./add-people-dialog";
import type { Campaign, CampaignPerson, Channel, EnrollmentStatus, Page, Signature, Step, Writer } from "@/types";

const CHANNELS: Channel[] = ["email", "call", "linkedin", "task"];
const WRITER_OPTIONS: Array<{ value: Writer; label: string; hint: string }> = [
  { value: "research", label: "The agent researches first", hint: "For an email that has to be about them" },
  { value: "thread", label: "The AI writes from the thread", hint: "For follow-ups" },
];

export function CampaignPage({ id, navigate }: { id: string; navigate: Navigate }) {
  const { setError, refresh } = useApp();
  const data = useLoad<{ campaign: Campaign; steps: Step[] }>(`/api/campaigns/${encodeURIComponent(id)}`);
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
      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto flex max-w-4xl flex-col gap-8">
          <About campaign={c} onSave={patch} />
          <StepsEditor key={data.data!.steps.map((s) => s.id).join()} campaignId={c.id} steps={data.data!.steps} onSaved={(steps) => data.setData((d) => (d ? { ...d, steps } : d))} />
          <section className="flex flex-col gap-3">
            <SectionTitle action={c.status !== "archived" && <Button size="sm" variant="outline" onClick={() => setAdding(true)}><UserPlus /> Add people</Button>}>
              People
            </SectionTitle>
            <CampaignPeople key={peopleKey} campaign={c} navigate={navigate} onChanged={() => void data.reload()} />
          </section>
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

function About({ campaign: c, onSave }: { campaign: Campaign; onSave: (b: Record<string, unknown>) => Promise<void> }) {
  const [angle, setAngle] = useState(c.angle);
  const [name, setName] = useState(c.name);
  useEffect(() => setAngle(c.angle), [c.angle]);
  useEffect(() => setName(c.name), [c.name]);
  return (
    <section className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Name
        <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== c.name && void onSave({ name })} className="max-w-md" />
      </label>
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Who it's for, and why they'd care
        <Textarea value={angle} rows={3} maxLength={2000} onChange={(e) => setAngle(e.target.value)} onBlur={() => angle !== c.angle && void onSave({ angle })} />
        <span className="text-[0.8125rem] font-normal text-muted-foreground">Every draft in this campaign starts from it.</span>
      </label>
      <div className="flex items-center gap-3">
        <Switch checked={c.stop_company} onChange={(v) => void onSave({ stop_company: v })} label="Stop the whole company" />
        <span className="text-sm">When someone replies or books a meeting, stop writing to everyone else at their company</span>
      </div>
      <CampaignSignatures campaign={c} onSave={onSave} />
    </section>
  );
}

/** Which signature this campaign's first emails and follow-ups get: the workspace default unless it picks one. */
function CampaignSignatures({ campaign: c, onSave }: { campaign: Campaign; onSave: (b: Record<string, unknown>) => Promise<void> }) {
  const data = useLoad<{ signatures: Signature[]; defaults: { signature_id: string | null; reply_signature_id: string | null } }>("/api/signatures?limit=100");
  if (!data.data) return null;
  const { signatures, defaults } = data.data;
  const nameOf = (id: string | null) => (id ? signatures.find((x) => x.id === id)?.name ?? "none" : "none");
  const options = (fallback: string | null) => [
    { value: "", label: `Default (${nameOf(fallback)})` },
    { value: "none", label: "No signature" },
    ...signatures.map((x) => ({ value: x.id, label: x.name })),
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
      <label className="flex items-center gap-2 text-sm">
        Signature on first emails
        <Picker label="Signature on first emails" className="w-60" value={c.signature_id ?? ""} options={options(defaults.signature_id)}
          onChange={(v) => void onSave({ signature_id: v || null })} />
      </label>
      <label className="flex items-center gap-2 text-sm">
        on follow-ups
        <Picker label="Signature on follow-ups" className="w-60" value={c.reply_signature_id ?? ""} options={options(defaults.reply_signature_id)}
          onChange={(v) => void onSave({ reply_signature_id: v || null })} />
      </label>
    </div>
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
                  options={CHANNELS.map((ch) => ({ value: ch, label: CHANNEL_LABEL[ch] }))}
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
