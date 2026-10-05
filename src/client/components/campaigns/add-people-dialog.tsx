import { useEffect, useState } from "react";
import { api } from "@/api";
import { useApp } from "@/context";
import { ENROLLMENT_STATUS, personName, plural } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { AddPeopleResult, Campaign, EnrollResult, Page, Person } from "@/types";

type Outcome = { enrolled: number; skipped: Array<{ email: string; reason: string }>; invalid: number };

/** Puts people in a campaign: picked from People, or pasted as addresses (added to People on the way). */
export function AddPeopleDialog({ open, onOpenChange, campaign, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; campaign: Campaign; onDone: () => void }) {
  const { setError } = useApp();
  const [mode, setMode] = useState<"pick" | "paste">("pick");
  const [search, setSearch] = useState("");
  const [people, setPeople] = useState<Person[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  useEffect(() => {
    if (!open) {
      setOutcome(null);
      setPicked(new Set());
      setPasted("");
      setSearch("");
      return;
    }
    if (mode !== "pick") return;
    const t = setTimeout(() => {
      api<Page<"people", Person>>("GET", `/api/people?limit=50${search.trim() ? `&search=${encodeURIComponent(search.trim())}` : ""}`)
        .then((r) => setPeople(r.people))
        .catch((e) => setError(e instanceof Error ? e.message : "Could not load people"));
    }, 200);
    return () => clearTimeout(t);
  }, [open, mode, search, setError]);

  const emails = pasted.split(/[\s,;]+/).map((e) => e.trim()).filter((e) => e.includes("@"));

  const submit = async () => {
    setBusy(true);
    try {
      if (mode === "pick") {
        const r = await api<EnrollResult>("POST", `/api/campaigns/${encodeURIComponent(campaign.id)}/enroll`, { person_ids: [...picked] });
        setOutcome({ enrolled: r.enrolled, skipped: r.skipped, invalid: 0 });
      } else {
        const r = await api<AddPeopleResult>("POST", "/api/people", { people: emails.slice(0, 500).map((email) => ({ email })), campaign_id: campaign.id });
        setOutcome({ enrolled: r.enrolled ?? 0, skipped: r.skipped, invalid: r.invalid.length });
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add them");
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) => setPicked((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add people to {campaign.name}</DialogTitle>
          <DialogDescription>They start at step 1. Anyone who asked not to be emailed, bounced, or is already in another live campaign is left out.</DialogDescription>
        </DialogHeader>
        {outcome ? (
          <div className="flex flex-col gap-2 text-sm">
            <p>{plural(outcome.enrolled, "person", "people")} added{outcome.invalid ? `, ${outcome.invalid} not an email address` : ""}.</p>
            {outcome.skipped.length > 0 && (
              <ul className="max-h-48 overflow-y-auto text-[0.8125rem] text-muted-foreground">
                {outcome.skipped.map((s, i) => <li key={i}>{s.email || "Someone"}: {s.reason}</li>)}
              </ul>
            )}
            <DialogFooter><Button onClick={() => onOpenChange(false)}>Done</Button></DialogFooter>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <Tabs value={mode} onValueChange={(v) => setMode(v as "pick" | "paste")}>
              <TabsList>
                <TabsTrigger value="pick">From People</TabsTrigger>
                <TabsTrigger value="paste">Paste addresses</TabsTrigger>
              </TabsList>
            </Tabs>
            {mode === "pick" ? (
              <>
                <Input aria-label="Search people" placeholder="Search by name, email or company" value={search} onChange={(e) => setSearch(e.target.value)} />
                <ul className="flex max-h-72 flex-col overflow-y-auto rounded-md bg-card shadow-edge">
                  {people.length === 0 && <li className="px-3 py-3 text-[0.8125rem] text-muted-foreground">No one matches.</li>}
                  {people.map((p) => {
                    const busyElsewhere = p.campaign && (p.campaign.status === "active" || p.campaign.status === "paused");
                    const blocked = !!p.unsubscribed_at || !!p.bounced_at;
                    return (
                      <li key={p.id} className="[&+li]:border-t [&+li]:border-border">
                        <label className="flex cursor-pointer items-center gap-3 px-3 py-2">
                          <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={picked.has(p.id)} disabled={blocked} onChange={() => toggle(p.id)} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm">{personName(p)}</span>
                            <span className="block truncate text-[0.75rem] text-muted-foreground">
                              {[p.company, p.email].filter(Boolean).join(" · ")}
                              {blocked ? " · won't be emailed" : busyElsewhere ? ` · ${ENROLLMENT_STATUS[p.campaign!.status].label.toLowerCase()} in ${p.campaign!.name}` : ""}
                            </span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : (
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Email addresses
                <Textarea rows={6} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder={"ada@example.com\njan@bouwbedrijf.nl"} />
                <span className="text-[0.8125rem] font-normal text-muted-foreground">One per line, up to 500. New ones are added to People; add their name and notes there, so drafts can use them.</span>
              </label>
            )}
            <DialogFooter>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button disabled={busy || (mode === "pick" ? picked.size === 0 : emails.length === 0)} onClick={() => void submit()}>
                Add {mode === "pick" ? (picked.size || "") : (emails.length || "")}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
