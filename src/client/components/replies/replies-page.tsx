import { useEffect, useState } from "react";
import { Check, ExternalLink, Play } from "lucide-react";
import { api } from "@/api";
import { useApp } from "@/context";
import { useLoad } from "@/hooks/use-load";
import { withQuery, type Navigate } from "@/hooks/use-router";
import { ENROLLMENT_STATUS, INTENT, ago, gmailLink } from "@/lib/format";
import { EmptyState, PageHeader, Pager, Pill } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Page, Reply } from "@/types";

/**
 * What came back on the campaigns' threads. A reply has already stopped the
 * sequence for that person (and their company, where the campaign says so);
 * this is where a person picks it up.
 */
export function RepliesPage({ show, navigate }: { show: "open" | "all"; navigate: Navigate }) {
  const { overview, refresh, setError } = useApp();
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [show]);
  const list = useLoad<Page<"replies", Reply>>(`/api/replies?show=${show}&limit=25&page=${page}`);
  const mailbox = overview?.sending.mailbox ?? null;

  const act = async (r: Reply, path: string) => {
    try {
      await api("POST", `/api/replies/${encodeURIComponent(r.id)}/${path}`, {});
      if (show === "open") list.setData((d) => (d ? { ...d, replies: d.replies.filter((x) => x.id !== r.id), total: Math.max(0, d.total - 1) } : d));
      await Promise.all([refresh(), list.reload()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work");
    }
  };

  return (
    <>
      <PageHeader title="Replies" meta={list.data ? `${list.data.total} ${show === "open" ? "to deal with" : "in all"}` : undefined}>
        <Tabs value={show} onValueChange={(v) => navigate(withQuery({ show: v === "open" ? null : v }))}>
          <TabsList>
            <TabsTrigger value="open">To deal with</TabsTrigger>
            <TabsTrigger value="all">Everything</TabsTrigger>
          </TabsList>
        </Tabs>
      </PageHeader>
      {list.data && list.data.replies.length === 0 ? (
        <EmptyState title={show === "open" ? "No replies waiting." : "Nothing has come back yet."} />
      ) : list.data && (
        <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
          <ul className="mx-auto flex max-w-3xl flex-col rounded-md bg-card shadow-edge">
            {(list.data?.replies ?? []).map((r) => (
              <li key={r.id} className="flex flex-col gap-2 px-4 py-3.5 [&+li]:border-t [&+li]:border-border">
                <div className="flex flex-wrap items-center gap-2">
                  {r.kind === "bounce" ? (
                    <Pill tone="danger">Bounced</Pill>
                  ) : r.kind === "auto" ? (
                    <Pill tone="warning">Automatic</Pill>
                  ) : r.intent ? (
                    <Pill tone={INTENT[r.intent].tone}>{INTENT[r.intent].label}</Pill>
                  ) : (
                    <Pill tone="slate">Not read yet</Pill>
                  )}
                  {r.person ? (
                    <button type="button" onClick={() => navigate(`/people/${encodeURIComponent(r.person!.id)}`)} className="truncate text-sm font-medium hover:underline">
                      {r.person.name}
                    </button>
                  ) : (
                    <span className="truncate text-sm font-medium">{r.from_email}</span>
                  )}
                  {r.person?.company && <span className="truncate text-[0.8125rem] text-muted-foreground">{r.person.company}</span>}
                  <span className="ml-auto shrink-0 text-[0.8125rem] text-muted-foreground">{ago(r.received_at)}</span>
                </div>
                {r.summary && <p className="text-sm">{r.summary}</p>}
                {r.excerpt && <p className="line-clamp-4 whitespace-pre-wrap text-[0.8125rem] text-muted-foreground">{r.excerpt}</p>}
                <div className="flex flex-wrap items-center gap-2 text-[0.8125rem] text-muted-foreground">
                  {r.campaign && (
                    <button type="button" onClick={() => navigate(`/campaigns/${encodeURIComponent(r.campaign!.id)}`)} className="hover:text-foreground hover:underline">
                      {r.campaign.name}
                    </button>
                  )}
                  {r.enrollment && <span>· {ENROLLMENT_STATUS[r.enrollment.status]?.label ?? r.enrollment.status}</span>}
                  <span className="ml-auto flex flex-wrap gap-2">
                    <Button size="sm" variant="ghost" asChild>
                      <a href={gmailLink(mailbox, r.id)} target="_blank" rel="noreferrer noopener"><ExternalLink /> Open in Gmail</a>
                    </Button>
                    {r.kind === "reply" && r.intent === "out_of_office" && r.enrollment?.status === "replied" && (
                      <Button size="sm" variant="outline" onClick={() => void act(r, "resume")}><Play /> Carry on with the sequence</Button>
                    )}
                    {!r.handled_at && r.kind === "reply" && (
                      <Button size="sm" variant="outline" onClick={() => void act(r, "handled")}><Check /> Done</Button>
                    )}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          {list.data && (
            <div className="mx-auto max-w-3xl">
              <Pager page={list.data.page} limit={list.data.limit} total={list.data.total} onPage={setPage} />
            </div>
          )}
        </div>
      )}
    </>
  );
}
