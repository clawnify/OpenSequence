import { useEffect, useMemo, useState } from "react";
import { Check, ExternalLink, Linkedin, Phone, RefreshCw, Search, Sparkles, Undo2 } from "lucide-react";
import { openChat, useChatContext, useHasChat } from "@clawnify/app/client";
import { api } from "@/api";
import { useApp } from "@/context";
import { useLoad } from "@/hooks/use-load";
import { withQuery, type Navigate, type ReviewTab } from "@/hooks/use-router";
import { cn } from "@/lib/utils";
import { CHANNEL_LABEL, due, personName, plural } from "@/lib/format";
import { Avatar, EmptyState, PageHeader, Pager, Pill } from "@/components/shared";
import { Notice } from "@/components/settings-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Page, Touch, TouchDetail } from "@/types";

const TAB_LABEL: Record<ReviewTab, string> = {
  review: "To approve",
  research: "Waiting for research",
  drafting: "Being written",
  todo: "To do",
  approved: "Approved",
};

const EMPTY: Record<ReviewTab, string> = {
  review: "Nothing to approve right now.",
  research: "No drafts are waiting for research.",
  drafting: "No drafts are being written.",
  todo: "No calls or tasks to do.",
  approved: "No approved emails waiting to go out.",
};

const wide = () => typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches;

/**
 * The home screen: every draft waiting on a person, across campaigns. A list on
 * the left; the selected one on the right, shown as the email that will go out
 * with what its writer checked and why.
 */
export function ReviewPage({ tab, touchId, navigate }: { tab: ReviewTab; touchId?: string; navigate: Navigate }) {
  const { overview, refresh, setError } = useApp();
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [tab]);
  const list = useLoad<Page<"touches", Touch>>(`/api/touches?status=${tab}&limit=50&page=${page}`);
  const touches = list.data?.touches ?? [];
  const selected = touchId ?? (wide() ? touches[0]?.id : undefined);
  const detail = useLoad<TouchDetail>(selected ? `/api/touches/${encodeURIComponent(selected)}` : null);
  const [checking, setChecking] = useState(false);

  const select = (id: string | null) => navigate(withQuery({ touch: id }), { replace: true });

  /** After an action: off the list, on to the next one. */
  const settled = async (id: string) => {
    const i = touches.findIndex((t) => t.id === id);
    const next = touches[i + 1] ?? touches[i - 1];
    list.setData((d) => (d ? { ...d, touches: d.touches.filter((t) => t.id !== id), total: Math.max(0, d.total - 1) } : d));
    select(next && next.id !== id && wide() ? next.id : null);
    await Promise.all([refresh(), list.reload()]);
  };

  const checkNow = async () => {
    setChecking(true);
    try {
      await api("POST", "/api/run-now", {});
      await Promise.all([refresh(), list.reload()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not check");
    } finally {
      setChecking(false);
    }
  };

  const counts = overview?.counts;
  const tabs = (Object.keys(TAB_LABEL) as ReviewTab[]).filter((t) => t !== "drafting" || t === tab || (counts?.drafting ?? 0) > 0);
  const sending = overview?.sending;

  return (
    <>
      <PageHeader
        title="Review"
        meta={sending?.mailbox ? `${sending.mailbox} · ${sending.sent_today} of ${sending.cap_today} sent today` : undefined}
      >
        <Button size="sm" variant="outline" onClick={() => void checkNow()} disabled={checking}>
          <RefreshCw className={cn(checking && "animate-spin")} /> Check now
        </Button>
      </PageHeader>

      <div className="flex shrink-0 flex-col gap-2 border-b border-border px-4 py-2.5 md:px-6">
        {overview && !overview.ready.mailbox && (
          <Notice action={<Button size="sm" variant="outline" onClick={() => navigate("/settings")}>Settings</Button>}>
            Nothing goes out until you pick the mailbox to send from.
          </Notice>
        )}
        {overview && overview.ready.mailbox && !overview.ready.about && (
          <Notice action={<Button size="sm" variant="outline" onClick={() => navigate("/settings")}>Settings</Button>}>
            Say what you sell in Settings: every draft starts from it.
          </Notice>
        )}
        {sending?.last_error && <Notice>The last check stopped: {sending.last_error}</Notice>}
        <div className="overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <Tabs value={tab} onValueChange={(v) => navigate(withQuery({ tab: v === "review" ? null : v, touch: null }))}>
            <TabsList>
              {tabs.map((t) => (
                <TabsTrigger key={t} value={t} className="gap-1.5">
                  {TAB_LABEL[t]}
                  {counts && counts[t] > 0 && <span className="tabular text-muted-foreground">{counts[t]}</span>}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </div>

      {list.data && touches.length === 0 ? (
        <EmptyState
          title={EMPTY[tab]}
          action={tab === "review" && (counts?.campaigns ?? 0) === 0 ? <Button size="sm" onClick={() => navigate("/campaigns")}>Start a campaign</Button> : undefined}
        />
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className={cn("min-h-0 w-full shrink-0 overflow-y-auto border-border md:w-[22rem] md:border-r", selected && "hidden md:block")}>
            <ul aria-label={TAB_LABEL[tab]}>
              {touches.map((t) => (
                <li key={t.id} className="border-b border-border">
                  <button
                    type="button"
                    onClick={() => select(t.id)}
                    aria-current={t.id === selected ? "true" : undefined}
                    className={cn("flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-secondary/60", t.id === selected && "bg-secondary")}
                  >
                    <Avatar firstName={t.person.first_name || t.person.email} lastName={t.person.last_name} className="mt-0.5" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{personName(t.person)}</span>
                        {t.person.company && <span className="truncate text-[0.8125rem] text-muted-foreground">{t.person.company}</span>}
                      </span>
                      <span className="mt-0.5 block truncate text-[0.8125rem] text-muted-foreground">
                        {t.campaign.name} · {t.channel === "email" ? `email ${t.position}` : CHANNEL_LABEL[t.channel]} of {t.total_steps}
                        {t.due_at && ` · ${due(t.due_at)}`}
                      </span>
                      {t.error && <span className="mt-0.5 block truncate text-[0.8125rem] text-destructive">{t.error}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {list.data && <div className="px-4"><Pager page={list.data.page} limit={list.data.limit} total={list.data.total} onPage={setPage} /></div>}
          </div>
          <div className={cn("min-h-0 min-w-0 flex-1 overflow-y-auto", !selected && "hidden md:block")}>
            {detail.data && detail.data.touch.id === selected ? (
              <Detail key={detail.data.touch.id} detail={detail.data} onBack={() => select(null)} onSettled={settled} navigate={navigate} />
            ) : selected ? (
              <div className="p-8 text-sm text-muted-foreground">Loading…</div>
            ) : null}
          </div>
        </div>
      )}
    </>
  );
}

function Detail({ detail, onBack, onSettled, navigate }: { detail: TouchDetail; onBack: () => void; onSettled: (id: string) => Promise<void>; navigate: Navigate }) {
  const t = detail.touch;
  useChatContext({ label: "Draft", record: { type: "touch", id: t.id, label: `Step ${t.position} of ${t.campaign.name}` } });
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-4 md:p-6">
      <button type="button" onClick={onBack} className="-mb-2 self-start text-[0.8125rem] text-muted-foreground hover:text-foreground md:hidden">← Back</button>
      <PersonHeader touch={t} navigate={navigate} />
      {t.review_note && (t.status === "research" || t.status === "drafting") && (
        <p className="rounded-md bg-secondary px-3 py-2 text-[0.8125rem]">Sent back with: {t.review_note}</p>
      )}
      {(t.status === "review" || t.status === "approved") && <EmailEditor detail={detail} onSettled={onSettled} />}
      {(t.status === "research" || t.status === "drafting") && <WriteIt touch={t} onSettled={onSettled} />}
      {t.status === "todo" && <TaskPanel touch={t} onSettled={onSettled} />}
      <Context detail={detail} />
    </div>
  );
}

function PersonHeader({ touch: t, navigate }: { touch: Touch; navigate: Navigate }) {
  const p = t.person;
  return (
    <div className="flex flex-wrap items-start gap-3">
      <Avatar firstName={p.first_name || p.email} lastName={p.last_name} className="size-9 text-xs" />
      <div className="min-w-0 flex-1">
        <button type="button" onClick={() => navigate(`/people/${encodeURIComponent(p.id)}`)} className="text-base font-semibold hover:underline">
          {personName(p)}
        </button>
        <div className="text-[0.8125rem] text-muted-foreground">
          {[p.title, p.company].filter(Boolean).join(" at ") || p.email}
          {(p.title || p.company) && <span> · {p.email}</span>}
        </div>
      </div>
      <div className="text-right text-[0.8125rem] text-muted-foreground">
        <button type="button" onClick={() => navigate(`/campaigns/${encodeURIComponent(t.campaign.id)}`)} className="hover:text-foreground hover:underline">
          {t.campaign.name}
        </button>
        <div>Step {t.position} of {t.total_steps}{t.due_at ? ` · due ${due(t.due_at)}` : ""}</div>
      </div>
    </div>
  );
}

/** The email as it will go out: subject (first email only), the draft, then what is added under it. */
function EmailEditor({ detail, onSettled }: { detail: TouchDetail; onSettled: (id: string) => Promise<void> }) {
  const { overview, setError } = useApp();
  const t = detail.touch;
  const [subject, setSubject] = useState(t.subject ?? "");
  const [body, setBody] = useState(t.body ?? "");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const approved = t.status === "approved";
  const canApprove = !!overview?.can_approve;
  const dirty = subject !== (t.subject ?? "") || body !== (t.body ?? "");
  const previousSubject = detail.thread.find((m) => m.subject)?.subject ?? null;

  const act = async (fn: () => Promise<unknown>, after = true) => {
    setBusy(true);
    try {
      await fn();
      if (after) await onSettled(t.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work");
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    if (!dirty || approved) return;
    void act(() => api("PATCH", `/api/touches/${t.id}`, t.starts_thread ? { subject, body } : { body }), false);
  };

  const footer = [overview?.footer.signature, overview?.footer.opt_out].filter((x) => x?.trim()).join("\n\n");

  return (
    <section aria-label="The email" className="flex flex-col gap-3">
      <div className="flex flex-col rounded-md bg-card shadow-edge">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2 text-[0.8125rem]">
          <span className="text-muted-foreground">To</span>
          <span className="truncate">{personName(t.person)} &lt;{t.person.email}&gt;</span>
          {t.written_by && (
            <span className="ml-auto flex shrink-0 items-center gap-1 text-muted-foreground">
              {t.written_by === "agent" ? <Search className="size-3.5" /> : <Sparkles className="size-3.5" />}
              {t.written_by === "agent" ? "Researched by the agent" : t.written_by === "ai" ? "Written by AI" : "Written by a person"}
              {t.edited && " · edited"}
            </span>
          )}
        </div>
        {t.starts_thread ? (
          <div className="border-b border-border px-4 py-1.5">
            <label htmlFor="subject" className="sr-only">Subject</label>
            <Input id="subject" value={subject} onChange={(e) => setSubject(e.target.value)} onBlur={save} disabled={approved || busy}
              placeholder="Subject" className="h-8 bg-transparent px-0 font-medium shadow-none focus-visible:shadow-none" />
          </div>
        ) : (
          <div className="border-b border-border px-4 py-2 text-[0.8125rem] text-muted-foreground">
            A reply in the thread{previousSubject ? ` "${previousSubject}"` : ""}
          </div>
        )}
        <label htmlFor="body" className="sr-only">Email</label>
        <Textarea id="body" value={body} onChange={(e) => setBody(e.target.value)} onBlur={save} disabled={approved || busy} rows={12}
          className="min-h-[14rem] resize-y rounded-none bg-transparent px-4 py-3 leading-relaxed shadow-none focus-visible:ring-0 focus-visible:ring-offset-0" />
        {footer && <p className="whitespace-pre-wrap border-t border-border px-4 py-2.5 text-[0.8125rem] text-faint">{footer}</p>}
      </div>

      {approved ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[0.8125rem] text-muted-foreground">
            Approved{t.due_at ? `: goes out ${due(laterOf(t.due_at, overview?.sending.next_send_at))}` : ""}, inside the sending hours.
          </span>
          <Button size="sm" variant="outline" className="ml-auto" disabled={busy}
            onClick={() => void act(() => api("PATCH", `/api/touches/${t.id}`, {}))}>
            <Undo2 /> Edit again
          </Button>
        </div>
      ) : note === null ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="lg" disabled={busy || !canApprove || !body.trim() || (t.starts_thread && !subject.trim())}
            title={canApprove ? undefined : "Only a person signed in to Clawnify can approve"}
            onClick={() => void act(() => api("POST", `/api/touches/${t.id}/approve`, t.starts_thread ? { subject, body } : { body }))}>
            <Check /> Approve
          </Button>
          <Button size="lg" variant="outline" disabled={busy} onClick={() => setNote("")}>Send back</Button>
          <Button size="lg" variant="ghost" disabled={busy} onClick={() => void act(() => api("POST", `/api/touches/${t.id}/skip`, {}))}>Skip this step</Button>
          {!canApprove && <span className="text-[0.8125rem] text-muted-foreground">Only a signed-in person can approve.</span>}
        </div>
      ) : (
        <div className="flex flex-col gap-2 rounded-md bg-card p-3 shadow-edge">
          <label htmlFor="note" className="text-sm font-medium">What should change?</label>
          <Textarea id="note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} autoFocus
            placeholder={t.writer === "research" ? "e.g. Lead with their new office, not the funding round" : "e.g. Shorter, and drop the case study"} />
          <div className="flex gap-2">
            <Button size="sm" disabled={busy || !note.trim()} onClick={() => void act(() => api("POST", `/api/touches/${t.id}/send-back`, { note }))}>
              Send back to {t.writer === "research" ? "the agent" : "the AI"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setNote(null)}>Cancel</Button>
          </div>
        </div>
      )}
    </section>
  );
}

function laterOf(a: string, b: string | undefined): string {
  return b && Date.parse(b) > Date.parse(a) ? b : a;
}

/** A draft nobody has written yet: the agent's job for a researched step, or the AI's. A person can always write it. */
function WriteIt({ touch: t, onSettled }: { touch: Touch; onSettled: (id: string) => Promise<void> }) {
  const { setError } = useApp();
  const hasChat = useHasChat();
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const stuck = t.status === "drafting" && !!t.error;

  const handIn = async () => {
    setBusy(true);
    try {
      await api("PUT", `/api/touches/${t.id}/draft`, t.starts_thread ? { subject, body } : { body });
      await onSettled(t.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the draft");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Writing" className="flex flex-col gap-3 rounded-md bg-card p-4 shadow-edge">
      <p className="text-sm">
        {t.status === "research"
          ? "This email starts from research: the agent looks into the person and their company, writes it, and hands it in for your approval."
          : stuck
            ? `The AI couldn't write this one: ${t.error}`
            : "The AI is writing this email from the thread. It lands in To approve when it's ready."}
      </p>
      <div className="flex flex-wrap gap-2">
        {t.status === "research" && hasChat && (
          <Button size="sm" onClick={() => openChat(`In OpenSequence, research the person for touch ${t.id}, write the email, and hand it in with PUT /api/touches/${t.id}/draft for my approval. Never approve or send it.`)}>
            <Search /> Ask the agent to research it
          </Button>
        )}
        {!open && <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Write it myself</Button>}
      </div>
      {open && (
        <div className="flex flex-col gap-2">
          {t.starts_thread && <Input aria-label="Subject" placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />}
          <Textarea aria-label="Email" rows={10} value={body} onChange={(e) => setBody(e.target.value)} placeholder="The email, without a signature: it is added when it goes out." />
          <div className="flex gap-2">
            <Button size="sm" disabled={busy || !body.trim() || (t.starts_thread && !subject.trim())} onClick={() => void handIn()}>Hand in for approval</Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </div>
      )}
    </section>
  );
}

function TaskPanel({ touch: t, onSettled }: { touch: Touch; onSettled: (id: string) => Promise<void> }) {
  const { setError } = useApp();
  const [busy, setBusy] = useState(false);
  const act = async (path: string) => {
    setBusy(true);
    try {
      await api("POST", `/api/touches/${t.id}/${path}`, {});
      await onSettled(t.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Task" className="flex flex-col gap-3 rounded-md bg-card p-4 shadow-edge">
      <div className="flex items-center gap-2">
        <Pill tone="info">{CHANNEL_LABEL[t.channel]}</Pill>
        <span className="text-sm">{t.instructions}</span>
      </div>
      <div className="flex flex-wrap gap-3 text-[0.8125rem]">
        {t.person.phone && <a className="inline-flex items-center gap-1.5 hover:underline" href={`tel:${t.person.phone}`}><Phone className="size-3.5" /> {t.person.phone}</a>}
        {t.person.linkedin_url && (
          <a className="inline-flex items-center gap-1.5 hover:underline" href={t.person.linkedin_url} target="_blank" rel="noreferrer noopener">
            <Linkedin className="size-3.5" /> LinkedIn <ExternalLink className="size-3" />
          </a>
        )}
      </div>
      <div className="flex gap-2">
        <Button size="sm" disabled={busy} onClick={() => void act("done")}><Check /> Done</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act("skip")}>Skip this step</Button>
      </div>
    </section>
  );
}

/** Why this draft, what its writer checked, what the step is for, and the thread so far. */
function Context({ detail }: { detail: TouchDetail }) {
  const t = detail.touch;
  const notes = t.person.notes.trim();
  const earlier = useMemo(() => [...detail.thread].reverse(), [detail.thread]);
  return (
    <div className="flex flex-col gap-5 text-sm">
      {t.rationale && (
        <section className="flex flex-col gap-1">
          <h2 className="font-medium">Why this draft</h2>
          <p className="text-muted-foreground">{t.rationale}</p>
        </section>
      )}
      {t.sources.length > 0 && (
        <section className="flex flex-col gap-1">
          <h2 className="font-medium">What the writer checked</h2>
          <ul className="flex flex-col gap-1.5">
            {t.sources.map((s, i) => (
              <li key={i} className="text-muted-foreground">
                {s.url ? (
                  <a href={s.url} target="_blank" rel="noreferrer noopener" className="text-foreground hover:underline">{s.title || s.url}</a>
                ) : (
                  <span className="text-foreground">{s.title}</span>
                )}
                {s.note && <span>: {s.note}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {t.instructions && t.channel === "email" && (
        <section className="flex flex-col gap-1">
          <h2 className="font-medium">What this step is for</h2>
          <p className="text-muted-foreground">{t.instructions}</p>
        </section>
      )}
      {detail.replies.length > 0 && (
        <section className="flex flex-col gap-1">
          <h2 className="font-medium">What came back</h2>
          {detail.replies.map((r, i) => (
            <p key={i} className="text-muted-foreground">{r.summary ?? r.excerpt}</p>
          ))}
        </section>
      )}
      {earlier.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="font-medium">Earlier in this thread ({plural(earlier.length, "email")})</h2>
          {earlier.map((m, i) => (
            <details key={i} className="rounded-md bg-card px-3 py-2 shadow-edge">
              <summary className="cursor-pointer text-[0.8125rem] text-muted-foreground">
                Email {m.position}{m.subject ? `: ${m.subject}` : ""} · {new Date(m.sent_at).toLocaleDateString()}
              </summary>
              <p className="mt-2 whitespace-pre-wrap text-[0.8125rem]">{m.body}</p>
            </details>
          ))}
        </section>
      )}
      {notes && (
        <section className="flex flex-col gap-1">
          <h2 className="font-medium">Notes on {t.person.first_name || "them"}</h2>
          <p className="whitespace-pre-wrap text-muted-foreground">{notes}</p>
        </section>
      )}
    </div>
  );
}
