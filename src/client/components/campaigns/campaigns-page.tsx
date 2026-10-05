import { useState } from "react";
import { Plus } from "lucide-react";
import { api } from "@/api";
import { useApp } from "@/context";
import { useLoad } from "@/hooks/use-load";
import type { Navigate } from "@/hooks/use-router";
import { CAMPAIGN_STATUS } from "@/lib/format";
import { EmptyState, PageHeader, Pager, Pill } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Campaign, Page } from "@/types";

const rate = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "");

export function CampaignsPage({ navigate }: { navigate: Navigate }) {
  const [page, setPage] = useState(1);
  const list = useLoad<Page<"campaigns", Campaign>>(`/api/campaigns?limit=25&page=${page}`);
  const [creating, setCreating] = useState(false);
  const campaigns = list.data?.campaigns ?? [];

  return (
    <>
      <PageHeader title="Campaigns" meta={list.data ? `${list.data.total}` : undefined}>
        <Button size="sm" onClick={() => setCreating(true)}><Plus /> New campaign</Button>
      </PageHeader>
      {list.data && campaigns.length === 0 ? (
        <EmptyState title="No campaigns yet." action={<Button size="sm" onClick={() => setCreating(true)}><Plus /> New campaign</Button>} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
          <div className="overflow-hidden rounded-md shadow-edge">
            <Table grid>
              <TableHeader>
                <TableRow>
                  <TableHead pinned width={260}>Campaign</TableHead>
                  <TableHead width={110}>Status</TableHead>
                  <TableHead width={90} className="text-right">People</TableHead>
                  <TableHead width={110} className="text-right">In sequence</TableHead>
                  <TableHead width={90} className="text-right">Emails sent</TableHead>
                  <TableHead width={110} className="text-right">Replied</TableHead>
                  <TableHead width={100} className="text-right">Meetings</TableHead>
                  <TableHead aria-hidden="true" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {campaigns.map((c) => (
                  <TableRow key={c.id} className="cursor-pointer" onClick={() => navigate(`/campaigns/${encodeURIComponent(c.id)}`)}>
                    <TableCell pinned>
                      <a href={`/campaigns/${encodeURIComponent(c.id)}`} onClick={(e) => { e.preventDefault(); navigate(`/campaigns/${encodeURIComponent(c.id)}`); }} className="block truncate font-medium">
                        {c.name}
                      </a>
                    </TableCell>
                    <TableCell><Pill tone={CAMPAIGN_STATUS[c.status].tone}>{CAMPAIGN_STATUS[c.status].label}</Pill></TableCell>
                    <TableCell className="text-right tabular">{c.people}</TableCell>
                    <TableCell className="text-right tabular">{c.live || <span className="text-faint">0</span>}</TableCell>
                    <TableCell className="text-right tabular">{c.sent || <span className="text-faint">0</span>}</TableCell>
                    <TableCell className="text-right tabular">
                      {c.replied || <span className="text-faint">0</span>}
                      {c.replied > 0 && <span className="text-muted-foreground"> · {rate(c.replied, c.reached)}</span>}
                    </TableCell>
                    <TableCell className="text-right tabular">{c.meetings || <span className="text-faint">0</span>}</TableCell>
                    <TableCell aria-hidden="true" />
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {list.data && <Pager page={list.data.page} limit={list.data.limit} total={list.data.total} onPage={setPage} />}
        </div>
      )}
      <NewCampaign open={creating} onOpenChange={setCreating} navigate={navigate} />
    </>
  );
}

function NewCampaign({ open, onOpenChange, navigate }: { open: boolean; onOpenChange: (v: boolean) => void; navigate: Navigate }) {
  const { setError, refresh } = useApp();
  const [name, setName] = useState("");
  const [angle, setAngle] = useState("");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      const r = await api<{ campaign: Campaign }>("POST", "/api/campaigns", { name: name.trim(), angle: angle.trim() });
      onOpenChange(false);
      setName("");
      setAngle("");
      await refresh();
      navigate(`/campaigns/${encodeURIComponent(r.campaign.id)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the campaign");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New campaign</DialogTitle>
          <DialogDescription>It starts with a researched first email and three follow-ups in the same thread. You can change the steps next.</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void create(); }}>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Name
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Dutch builders, autumn" autoFocus maxLength={120} />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Who it's for, and why they'd care
            <Textarea value={angle} onChange={(e) => setAngle(e.target.value)} rows={4} maxLength={2000}
              placeholder="e.g. Owners of building firms with 10 to 50 people, who lose days chasing permits. We save them that time." />
            <span className="text-[0.8125rem] font-normal text-muted-foreground">Every draft starts from this. Write it in the language the emails should be in.</span>
          </label>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !name.trim()}>Create</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
