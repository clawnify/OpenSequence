import { useEffect, useState } from "react";
import { api } from "@/api";
import { useApp } from "@/context";
import { csvPeople, parseCsv, type CsvPeople } from "@/lib/csv";
import { personName, plural } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Picker } from "@/components/ui/picker";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { AddPeopleResult, Campaign, Page } from "@/types";

/** Campaigns people can be put in straight away: not archived. */
function useCampaignOptions(open: boolean) {
  const [options, setOptions] = useState<Array<{ value: string; label: string; hint?: string }>>([{ value: "", label: "Don't add to a campaign yet" }]);
  useEffect(() => {
    if (!open) return;
    api<Page<"campaigns", Campaign>>("GET", "/api/campaigns?limit=100")
      .then((r) => setOptions([
        { value: "", label: "Don't add to a campaign yet" },
        ...r.campaigns.map((c) => ({ value: c.id, label: c.name, hint: c.status === "active" ? "Sending" : c.status === "draft" ? "Draft: nothing goes out until it starts" : "Paused" })),
      ]))
      .catch(() => undefined);
  }, [open]);
  return options;
}

function Outcome({ result, onClose }: { result: AddPeopleResult; onClose: () => void }) {
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p>
        {plural(result.created, "person", "people")} added, {result.updated} already here and updated
        {result.enrolled !== null ? `, ${result.enrolled} put in the campaign` : ""}.
      </p>
      {(result.invalid.length > 0 || result.skipped.length > 0) && (
        <ul className="max-h-48 overflow-y-auto text-[0.8125rem] text-muted-foreground">
          {result.invalid.map((x) => <li key={`i${x.row}`}>Row {x.row}: {x.error}</li>)}
          {result.skipped.map((x, i) => <li key={`s${i}`}>{x.email || "Someone"}: {x.reason}</li>)}
        </ul>
      )}
      <DialogFooter><Button onClick={onClose}>Done</Button></DialogFooter>
    </div>
  );
}

export function AddPersonDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; onDone: (id: string | null) => void }) {
  const { setError, refresh } = useApp();
  const campaigns = useCampaignOptions(open);
  const empty = { email: "", first_name: "", last_name: "", title: "", company: "", linkedin_url: "", notes: "" };
  const [f, setF] = useState(empty);
  const [campaign, setCampaign] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!open) { setF(empty); setCampaign(""); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setBusy(true);
    try {
      const person = Object.fromEntries(Object.entries(f).filter(([, v]) => v.trim()));
      const r = await api<AddPeopleResult>("POST", "/api/people", { people: [person], ...(campaign ? { campaign_id: campaign } : {}) });
      if (r.invalid.length) throw new Error(r.invalid[0].error);
      if (r.skipped.length) setError(`Added, but not to the campaign: ${r.skipped[0].reason}`);
      onOpenChange(false);
      await refresh();
      const found = await api<Page<"people", { id: string; email: string }>>("GET", `/api/people?search=${encodeURIComponent(f.email.trim())}&limit=1`);
      onDone(found.people[0]?.id ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add them");
    } finally {
      setBusy(false);
    }
  };

  const field = (key: keyof typeof empty, label: string, placeholder = "") => (
    <label className="flex flex-col gap-1.5 text-sm font-medium">
      {label}
      <Input value={f[key]} placeholder={placeholder} onChange={(e) => setF((x) => ({ ...x, [key]: e.target.value }))} />
    </label>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a person</DialogTitle>
          <DialogDescription>Notes are what the writer works from: what you know about them, and where it came from.</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (f.email.includes("@")) void save(); }}>
          {field("email", "Email", "ada@example.com")}
          <div className="grid gap-3 sm:grid-cols-2">
            {field("first_name", "First name")}
            {field("last_name", "Last name")}
            {field("company", "Company")}
            {field("title", "Title")}
          </div>
          {field("linkedin_url", "LinkedIn", "https://www.linkedin.com/in/…")}
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Notes
            <Textarea rows={3} value={f.notes} onChange={(e) => setF((x) => ({ ...x, notes: e.target.value }))} />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Campaign
            <Picker label="Campaign" value={campaign} options={campaigns} onChange={setCampaign} />
          </label>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !f.email.includes("@")}>Add</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ImportDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const { setError, refresh } = useApp();
  const campaigns = useCampaignOptions(open);
  const [parsed, setParsed] = useState<CsvPeople | null>(null);
  const [fileName, setFileName] = useState("");
  const [campaign, setCampaign] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AddPeopleResult | null>(null);
  useEffect(() => { if (!open) { setParsed(null); setFileName(""); setCampaign(""); setResult(null); } }, [open]);

  const read = async (file: File) => {
    setFileName(file.name);
    try {
      setParsed(csvPeople(parseCsv(await file.text())));
    } catch {
      setError("That file couldn't be read as a CSV");
    }
  };

  const run = async () => {
    if (!parsed) return;
    setBusy(true);
    const total: AddPeopleResult = { created: 0, updated: 0, invalid: [], enrolled: campaign ? 0 : null, skipped: [] };
    try {
      for (let i = 0; i < parsed.people.length; i += 500) {
        const r = await api<AddPeopleResult>("POST", "/api/people", { people: parsed.people.slice(i, i + 500), source: "csv", ...(campaign ? { campaign_id: campaign } : {}) });
        total.created += r.created;
        total.updated += r.updated;
        total.invalid.push(...r.invalid.map((x) => ({ ...x, row: x.row + i })));
        total.skipped.push(...r.skipped);
        if (total.enrolled !== null) total.enrolled += r.enrolled ?? 0;
      }
      setResult(total);
      await refresh();
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The import stopped");
    } finally {
      setBusy(false);
    }
  };

  const found = parsed ? Object.keys(parsed.columns).filter((k) => k !== "email") : [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Import a CSV</DialogTitle>
          <DialogDescription>One person per row, with a column for the email. Names, company, title, LinkedIn, phone and notes are picked up by their header.</DialogDescription>
        </DialogHeader>
        {result ? (
          <Outcome result={result} onClose={() => onOpenChange(false)} />
        ) : (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              File
              <Input type="file" accept=".csv,text/csv" onChange={(e) => { const file = e.target.files?.[0]; if (file) void read(file); }} />
            </label>
            {parsed && (
              <p className="text-[0.8125rem] text-muted-foreground">
                {fileName}: {plural(parsed.people.length, "person", "people")} with an email
                {parsed.withoutEmail ? `, ${parsed.withoutEmail} rows without one left out` : ""}.
                {parsed.columns.email ? ` Email from "${parsed.columns.email}"` : " No email column found."}
                {found.length ? `; also ${found.join(", ").replace(/_/g, " ")}.` : "."}
              </p>
            )}
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Campaign
              <Picker label="Campaign" value={campaign} options={campaigns} onChange={setCampaign} />
            </label>
            <DialogFooter>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button disabled={busy || !parsed?.people.length} onClick={() => void run()}>
                {busy ? "Importing…" : `Import ${parsed?.people.length ?? ""}`}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface CrmContact {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  title: string;
  phone: string;
  company: string;
  in_people: boolean;
}

export function CrmDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const { setError, refresh } = useApp();
  const campaigns = useCampaignOptions(open);
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<CrmContact[]>([]);
  const [picked, setPicked] = useState<Map<string, CrmContact>>(new Map());
  const [campaign, setCampaign] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AddPeopleResult | null>(null);

  useEffect(() => {
    if (!open) {
      setPicked(new Map());
      setResult(null);
      setCampaign("");
      return;
    }
    const t = setTimeout(() => {
      api<{ contacts: CrmContact[] }>("GET", `/api/crm/contacts?page=1${search.trim() ? `&search=${encodeURIComponent(search.trim())}` : ""}`)
        .then((r) => setRows(r.contacts))
        .catch((e) => setError(e instanceof Error ? e.message : "Could not reach the CRM"));
    }, 250);
    return () => clearTimeout(t);
  }, [open, search, setError]);

  const toggle = (c: CrmContact) => setPicked((m) => {
    const n = new Map(m);
    if (n.has(c.id)) n.delete(c.id);
    else n.set(c.id, c);
    return n;
  });

  const add = async () => {
    setBusy(true);
    try {
      const people = [...picked.values()].map((c) => ({
        email: c.email, first_name: c.first_name, last_name: c.last_name, title: c.title, phone: c.phone, company: c.company, crm_contact_id: c.id,
      }));
      setResult(await api<AddPeopleResult>("POST", "/api/people", { people, source: "crm", ...(campaign ? { campaign_id: campaign } : {}) }));
      await refresh();
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add them");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add from the CRM</DialogTitle>
          <DialogDescription>Contacts stay in the CRM; what gets sent and what comes back is written onto their timeline there.</DialogDescription>
        </DialogHeader>
        {result ? (
          <Outcome result={result} onClose={() => onOpenChange(false)} />
        ) : (
          <div className="flex flex-col gap-3">
            <Input aria-label="Search the CRM" placeholder="Search the CRM's contacts" value={search} onChange={(e) => setSearch(e.target.value)} />
            <ul className="flex max-h-72 flex-col overflow-y-auto rounded-md bg-card shadow-edge">
              {rows.length === 0 && <li className="px-3 py-3 text-[0.8125rem] text-muted-foreground">No contacts with an email match.</li>}
              {rows.map((c) => (
                <li key={c.id} className="[&+li]:border-t [&+li]:border-border">
                  <label className="flex cursor-pointer items-center gap-3 px-3 py-2">
                    <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={picked.has(c.id)} onChange={() => toggle(c)} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{personName(c)}</span>
                      <span className="block truncate text-[0.75rem] text-muted-foreground">
                        {[c.company, c.email].filter(Boolean).join(" · ")}{c.in_people ? " · already in People" : ""}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Campaign
              <Picker label="Campaign" value={campaign} options={campaigns} onChange={setCampaign} />
            </label>
            <DialogFooter>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button disabled={busy || picked.size === 0} onClick={() => void add()}>Add {picked.size || ""}</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
