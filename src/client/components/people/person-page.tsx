import { useEffect, useState } from "react";
import { Ban, ExternalLink, Pause, Play, Square, Trash2 } from "lucide-react";
import { useChatContext } from "@clawnify/app/client";
import { api } from "@/api";
import { useApp } from "@/context";
import { useLoad } from "@/hooks/use-load";
import type { Navigate } from "@/hooks/use-router";
import { CHANNEL_LABEL, ENROLLMENT_STATUS, INTENT, ago, due, personName } from "@/lib/format";
import { Avatar, PageHeader, Pill, SectionTitle } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { InlineField } from "@/components/ui/inline-field";
import { Picker } from "@/components/ui/picker";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Campaign, EnrollResult, Page, Person, PersonDetail } from "@/types";

const TOUCH_LABEL: Record<string, string> = {
  research: "Waiting for research",
  drafting: "Being written",
  review: "Waiting for approval",
  approved: "Approved, waiting to go out",
  sending: "Going out",
  sent: "Sent",
  todo: "To do",
  done: "Done",
  skipped: "Skipped",
  failed: "Couldn't be sent",
};

export function PersonPage({ id, navigate }: { id: string; navigate: Navigate }) {
  const { setError, refresh } = useApp();
  const data = useLoad<PersonDetail>(`/api/people/${encodeURIComponent(id)}`);
  const [confirm, setConfirm] = useState<"unsubscribe" | "delete" | null>(null);
  const p = data.data?.person;
  useChatContext(p ? { label: "Person", record: { type: "person", id: p.id, label: personName(p) } } : null);

  const save = async (patch: Record<string, string>) => {
    try {
      const r = await api<{ person: Person }>("PATCH", `/api/people/${encodeURIComponent(id)}`, patch);
      data.setData((d) => (d ? { ...d, person: r.person } : d));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await Promise.all([data.reload(), refresh()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work");
    }
  };

  if (!p) return <PageHeader title="Person" />;
  const d = data.data!;
  const blocked = p.unsubscribed_at ? "Asked not to be emailed" : p.bounced_at ? "Their address bounced" : null;

  return (
    <>
      <PageHeader title={personName(p)} meta={p.email}>
        {blocked && <Pill tone={p.unsubscribed_at ? "slate" : "danger"}>{blocked}</Pill>}
        {!p.unsubscribed_at && <Button size="sm" variant="ghost" onClick={() => setConfirm("unsubscribe")}><Ban /> Don't email again</Button>}
        {!p.unsubscribed_at && <Button size="icon" variant="ghost" aria-label="Delete" onClick={() => setConfirm("delete")}><Trash2 /></Button>}
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto grid max-w-5xl gap-8 lg:grid-cols-[18rem_1fr]">
          <aside className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <Avatar firstName={p.first_name || p.email} lastName={p.last_name} className="size-10 text-sm" />
              <div className="min-w-0 text-[0.8125rem] text-muted-foreground">
                <div>Added {ago(p.created_at)}{p.source !== "manual" ? ` from ${p.source === "crm" ? "the CRM" : p.source === "csv" ? "a CSV" : "the agent"}` : ""}</div>
              </div>
            </div>
            <dl className="flex flex-col gap-1 text-sm">
              {([
                ["first_name", "First name"], ["last_name", "Last name"], ["title", "Title"], ["company", "Company"], ["phone", "Phone"],
              ] as const).map(([k, label]) => (
                <div key={k} className="grid grid-cols-[6rem_1fr] items-center gap-2">
                  <dt className="text-[0.8125rem] text-muted-foreground">{label}</dt>
                  <dd><InlineField value={p[k]} placeholder={label} onSave={(v) => save({ [k]: v })} /></dd>
                </div>
              ))}
              <div className="grid grid-cols-[6rem_1fr] items-center gap-2">
                <dt className="text-[0.8125rem] text-muted-foreground">LinkedIn</dt>
                <dd>
                  <InlineField value={p.linkedin_url} placeholder="LinkedIn" onSave={(v) => save({ linkedin_url: v })}
                    render={(v) => <span className="inline-flex items-center gap-1">Profile <ExternalLink className="size-3" /></span>} />
                </dd>
              </div>
            </dl>
            <Notes person={p} onSave={(notes) => save({ notes })} />
          </aside>
          <div className="flex min-w-0 flex-col gap-8">
            <section className="flex flex-col gap-3">
              <SectionTitle action={!blocked && <AddToCampaign personId={p.id} onDone={() => void data.reload()} />}>Campaigns</SectionTitle>
              {d.enrollments.length === 0 ? (
                <p className="text-sm text-muted-foreground">Not in a campaign.</p>
              ) : (
                <ul className="flex flex-col rounded-md bg-card shadow-edge">
                  {d.enrollments.map((e) => {
                    const s = ENROLLMENT_STATUS[e.status];
                    return (
                      <li key={e.id} className="flex flex-wrap items-center gap-2 px-4 py-3 [&+li]:border-t [&+li]:border-border">
                        <button type="button" onClick={() => navigate(`/campaigns/${encodeURIComponent(e.campaign.id)}`)} className="truncate text-sm font-medium hover:underline">{e.campaign.name}</button>
                        <Pill tone={s.tone}>{s.label}</Pill>
                        <span className="truncate text-[0.8125rem] text-muted-foreground">
                          {e.reason ?? (e.status === "active" && e.due_at ? `Step ${e.step} ${due(e.due_at)}` : `Step ${e.step}`)}
                        </span>
                        <span className="ml-auto flex gap-1">
                          {e.status === "active" && <Button size="sm" variant="ghost" onClick={() => void act(() => api("POST", `/api/enrollments/${e.id}/pause`, {}))}><Pause /> Pause</Button>}
                          {e.status === "paused" && <Button size="sm" variant="ghost" onClick={() => void act(() => api("POST", `/api/enrollments/${e.id}/resume`, {}))}><Play /> Resume</Button>}
                          {(e.status === "active" || e.status === "paused") && <Button size="sm" variant="ghost" onClick={() => void act(() => api("POST", `/api/enrollments/${e.id}/stop`, {}))}><Square /> Stop</Button>}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
            {d.replies.length > 0 && (
              <section className="flex flex-col gap-3">
                <SectionTitle>What came back</SectionTitle>
                <ul className="flex flex-col rounded-md bg-card shadow-edge">
                  {d.replies.map((r) => (
                    <li key={r.id} className="flex flex-col gap-1 px-4 py-3 [&+li]:border-t [&+li]:border-border">
                      <div className="flex items-center gap-2">
                        {r.kind === "bounce" ? <Pill tone="danger">Bounced</Pill> : r.kind === "auto" ? <Pill tone="warning">Automatic</Pill> : r.intent ? <Pill tone={INTENT[r.intent].tone}>{INTENT[r.intent].label}</Pill> : <Pill tone="slate">Not read yet</Pill>}
                        <span className="text-[0.8125rem] text-muted-foreground">{ago(r.received_at)}</span>
                      </div>
                      {r.summary && <p className="text-sm">{r.summary}</p>}
                      {r.excerpt && <p className="line-clamp-4 whitespace-pre-wrap text-[0.8125rem] text-muted-foreground">{r.excerpt}</p>}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section className="flex flex-col gap-3">
              <SectionTitle>Emails and tasks</SectionTitle>
              {d.touches.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing yet.</p>
              ) : (
                <ul className="flex flex-col rounded-md bg-card shadow-edge">
                  {d.touches.map((t) => (
                    <li key={t.id} className="px-4 py-3 [&+li]:border-t [&+li]:border-border">
                      <details>
                        <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm">
                          <span className="font-medium">{t.channel === "email" ? (t.subject || `Email ${t.position}`) : CHANNEL_LABEL[t.channel]}</span>
                          <span className="text-[0.8125rem] text-muted-foreground">{t.campaign.name} · step {t.position}</span>
                          <span className="ml-auto text-[0.8125rem] text-muted-foreground">{TOUCH_LABEL[t.status] ?? t.status}{t.sent_at ? ` ${ago(t.sent_at)}` : ""}</span>
                        </summary>
                        {t.body ? <p className="mt-2 whitespace-pre-wrap text-[0.8125rem]">{t.body}</p> : t.instructions && <p className="mt-2 text-[0.8125rem] text-muted-foreground">{t.instructions}</p>}
                        {t.status === "review" && (
                          <Button size="sm" variant="outline" className="mt-2" onClick={() => navigate(`/review?touch=${encodeURIComponent(t.id)}`)}>Review it</Button>
                        )}
                      </details>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      </div>
      <Dialog open={confirm !== null} onOpenChange={(v) => !v && setConfirm(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{confirm === "delete" ? `Delete ${personName(p)}?` : `Never email ${personName(p)} again?`}</DialogTitle>
            <DialogDescription>
              {confirm === "delete"
                ? "Their campaigns, drafts and replies here go too. Nothing changes in Gmail or the CRM."
                : "Every campaign stops for them, and they can't be added to one again. The record stays so they never are."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => {
              const k = confirm;
              setConfirm(null);
              if (k === "delete") void api("DELETE", `/api/people/${encodeURIComponent(id)}`).then(() => { void refresh(); navigate("/people"); }).catch((e) => setError(e instanceof Error ? e.message : "Could not delete"));
              else void act(() => api("POST", `/api/people/${encodeURIComponent(id)}/unsubscribe`, {}));
            }}>
              {confirm === "delete" ? "Delete" : "Don't email again"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Notes({ person, onSave }: { person: Person; onSave: (notes: string) => Promise<void> }) {
  const [notes, setNotes] = useState(person.notes);
  useEffect(() => setNotes(person.notes), [person.notes]);
  return (
    <label className="flex flex-col gap-1.5 text-sm font-medium">
      Notes
      <Textarea rows={6} value={notes} maxLength={4000} onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== person.notes && void onSave(notes)}
        placeholder="What you know about them and where it came from. The writer works from this." />
    </label>
  );
}

function AddToCampaign({ personId, onDone }: { personId: string; onDone: () => void }) {
  const { setError, refresh } = useApp();
  const [options, setOptions] = useState<Array<{ value: string; label: string }>>([]);
  useEffect(() => {
    api<Page<"campaigns", Campaign>>("GET", "/api/campaigns?limit=100")
      .then((r) => setOptions(r.campaigns.map((c) => ({ value: c.id, label: c.name }))))
      .catch(() => undefined);
  }, []);
  if (!options.length) return null;
  return (
    <Picker label="Add to a campaign" className="w-56" value="" placeholder="Add to a campaign" options={options} onChange={(campaignId) => {
      void api<EnrollResult>("POST", `/api/campaigns/${encodeURIComponent(campaignId)}/enroll`, { person_ids: [personId] })
        .then((r) => {
          if (r.skipped.length) setError(r.skipped[0].reason);
          onDone();
          void refresh();
        })
        .catch((e) => setError(e instanceof Error ? e.message : "Could not add them"));
    }} />
  );
}
