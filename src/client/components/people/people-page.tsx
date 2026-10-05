import { useEffect, useState } from "react";
import { FileUp, Plus, Users } from "lucide-react";
import { useApp } from "@/context";
import { useLoad } from "@/hooks/use-load";
import type { Navigate } from "@/hooks/use-router";
import { ENROLLMENT_STATUS, personName } from "@/lib/format";
import { Avatar, EmptyState, PageHeader, Pager, Pill } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Picker } from "@/components/ui/picker";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AddPersonDialog, CrmDialog, ImportDialog } from "./people-dialogs";
import type { Page, Person } from "@/types";

const FILTERS = [
  { value: "", label: "Everyone" },
  { value: "live", label: "Being written to" },
  { value: "replied", label: "Replied" },
  { value: "meeting", label: "Meeting booked" },
  { value: "none", label: "In no campaign" },
  { value: "unsubscribed", label: "Unsubscribed" },
  { value: "bounced", label: "Bounced" },
];

export function PeoplePage({ navigate }: { navigate: Navigate }) {
  const { overview } = useApp();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<"add" | "csv" | "crm" | null>(null);

  useEffect(() => {
    const t = setTimeout(() => { setQuery(search.trim()); setPage(1); }, 250);
    return () => clearTimeout(t);
  }, [search]);

  const params = new URLSearchParams({ limit: "50", page: String(page) });
  if (query) params.set("search", query);
  if (status) params.set("status", status);
  const list = useLoad<Page<"people", Person>>(`/api/people?${params}`);
  const people = list.data?.people ?? [];
  const filtered = !!query || !!status;

  return (
    <>
      <PageHeader title="People" meta={list.data ? `${list.data.total}` : undefined}>
        {overview?.crm && <Button size="sm" variant="outline" onClick={() => setDialog("crm")}><Users /> From the CRM</Button>}
        <Button size="sm" variant="outline" onClick={() => setDialog("csv")}><FileUp /> Import CSV</Button>
        <Button size="sm" onClick={() => setDialog("add")}><Plus /> Add person</Button>
      </PageHeader>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2.5 md:px-6">
        <Input aria-label="Search people" placeholder="Search name, email or company" value={search} onChange={(e) => setSearch(e.target.value)} className="w-full sm:w-72" />
        <Picker label="Show" className="w-48" value={status} options={FILTERS} onChange={(v) => { setStatus(v); setPage(1); }} />
      </div>
      {list.data && people.length === 0 ? (
        <EmptyState
          title={filtered ? "No one matches." : "No people yet."}
          action={!filtered ? <Button size="sm" onClick={() => setDialog("add")}><Plus /> Add person</Button> : undefined}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
          <div className="overflow-hidden rounded-md shadow-edge">
            <Table grid>
              <TableHeader>
                <TableRow>
                  <TableHead pinned width={220}>Name</TableHead>
                  <TableHead width={240}>Email</TableHead>
                  <TableHead width={180}>Company</TableHead>
                  <TableHead width={180}>Title</TableHead>
                  <TableHead width={280}>Campaign</TableHead>
                  <TableHead aria-hidden="true" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {people.map((p) => (
                  <TableRow key={p.id} className="cursor-pointer" onClick={() => navigate(`/people/${encodeURIComponent(p.id)}`)}>
                    <TableCell pinned>
                      <a href={`/people/${encodeURIComponent(p.id)}`} onClick={(e) => { e.preventDefault(); navigate(`/people/${encodeURIComponent(p.id)}`); }} className="flex min-w-0 items-center gap-2 font-medium">
                        <Avatar firstName={p.first_name || p.email} lastName={p.last_name} className="size-6 text-[0.625rem]" />
                        <span className="truncate">{personName(p)}</span>
                      </a>
                    </TableCell>
                    <TableCell className="truncate text-muted-foreground">{p.email}</TableCell>
                    <TableCell className="truncate">{p.company || <span className="text-faint">-</span>}</TableCell>
                    <TableCell className="truncate">{p.title || <span className="text-faint">-</span>}</TableCell>
                    <TableCell>
                      {p.unsubscribed_at ? (
                        <Pill tone="slate">Unsubscribed</Pill>
                      ) : p.bounced_at ? (
                        <Pill tone="danger">Bounced</Pill>
                      ) : p.campaign ? (
                        <div className="flex min-w-0 items-center gap-2">
                          <Pill tone={ENROLLMENT_STATUS[p.campaign.status].tone}>{ENROLLMENT_STATUS[p.campaign.status].label}</Pill>
                          <span className="truncate text-muted-foreground">{p.campaign.name}</span>
                        </div>
                      ) : (
                        <span className="text-faint">None</span>
                      )}
                    </TableCell>
                    <TableCell aria-hidden="true" />
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {list.data && <Pager page={list.data.page} limit={list.data.limit} total={list.data.total} onPage={setPage} />}
        </div>
      )}
      <AddPersonDialog open={dialog === "add"} onOpenChange={(v) => setDialog(v ? "add" : null)} onDone={(id) => { void list.reload(); if (id) navigate(`/people/${encodeURIComponent(id)}`); }} />
      <ImportDialog open={dialog === "csv"} onOpenChange={(v) => setDialog(v ? "csv" : null)} onDone={() => void list.reload()} />
      <CrmDialog open={dialog === "crm"} onOpenChange={(v) => setDialog(v ? "crm" : null)} onDone={() => void list.reload()} />
    </>
  );
}
