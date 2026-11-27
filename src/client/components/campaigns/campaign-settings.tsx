import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Info } from "lucide-react";
import { useApp } from "@/context";
import { useLoad } from "@/hooks/use-load";
import { Notice, Row, Rows, Section, Switch } from "@/components/settings-ui";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Picker } from "@/components/ui/picker";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { RangesField, describeHours, zones } from "@/components/sending-hours";
import { mailboxOptions } from "@/components/mailbox-options";
import type { Campaign, MailboxOption, Signature } from "@/types";

// A campaign's Settings tab: who it is for, what stops it, and how it sends.
// Each setting is a row with a short label and its control; the detail behind
// an info icon. Sequencers we studied lay settings out the same way
// (clawnify-inspiration/apps/sequencers/SOURCES.txt).

type Save = (b: Record<string, unknown>) => Promise<void>;

export function CampaignSettings({ campaign: c, onSave }: { campaign: Campaign; onSave: Save }) {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8">
      <Section title="Audience">
        <Brief campaign={c} onSave={onSave} />
        <Rows label="Audience">
          <NameRow campaign={c} onSave={onSave} />
          <Row title="Writes to" hint={c.people > 0 ? "A change applies to whoever joins next." : undefined}>
            <Picker label="Writes to" className="w-56" value={c.audience} options={AUDIENCES} onChange={(v) => void onSave({ audience: v })} />
            <More>
              {c.audience === "inboxes"
                ? "Companies' general addresses (info@, contact@), one a company. Drafts greet the team and ask who handles it."
                : "Named people. Companies' general addresses (info@, contact@) are left out: give them a campaign of their own."}
            </More>
          </Row>
        </Rows>
      </Section>

      <Section title="When someone replies">
        <Rows label="When someone replies">
          <Row title="A reply stops their whole company" hint="A reply or a booked meeting from anyone there stops everyone at it.">
            <Switch checked={c.stop_company} onChange={(v) => void onSave({ stop_company: v })} label="A reply stops their whole company" />
          </Row>
          <SkipKnownRow campaign={c} onSave={onSave} />
        </Rows>
      </Section>

      <Section title="Sending">
        <Rows label="Sending">
          <MailboxRow campaign={c} onSave={onSave} />
          <HoursRows campaign={c} onSave={onSave} />
          <SignatureRows campaign={c} onSave={onSave} />
        </Rows>
        {c.mailbox_error && <Notice>{c.mailbox_error}</Notice>}
      </Section>
    </div>
  );
}

const AUDIENCES = [
  { value: "people", label: "Named people" },
  { value: "inboxes", label: "Company inboxes", hint: "info@, contact@: no first name" },
];

/** The detail behind a setting, one click or hover away. */
function More({ children }: { children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label="More about this" className="inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Info className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{children}</TooltipContent>
    </Tooltip>
  );
}

/** The brief every draft starts from: grows with its text, so none of it is hidden. */
function Brief({ campaign: c, onSave }: { campaign: Campaign; onSave: Save }) {
  const [angle, setAngle] = useState(c.angle);
  useEffect(() => setAngle(c.angle), [c.angle]);
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + 2, 480)}px`;
  }, [angle]);
  return (
    <label className="flex flex-col gap-1.5 text-sm font-medium">
      Who it's for, and why they'd care
      <Textarea ref={ref} value={angle} rows={3} maxLength={2000} className="resize-none font-normal"
        placeholder="e.g. Building firms in the Netherlands that still run permits on paper"
        onChange={(e) => setAngle(e.target.value)} onBlur={() => angle !== c.angle && void onSave({ angle })} />
      <span className="text-[0.8125rem] font-normal text-muted-foreground">Every draft in this campaign starts from it.</span>
    </label>
  );
}

function NameRow({ campaign: c, onSave }: { campaign: Campaign; onSave: Save }) {
  const [name, setName] = useState(c.name);
  useEffect(() => setName(c.name), [c.name]);
  return (
    <Row title="Name" htmlFor="campaign-name">
      <Input id="campaign-name" value={name} maxLength={120} className="w-96 max-w-full"
        onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== c.name && void onSave({ name })} />
    </Row>
  );
}

function SkipKnownRow({ campaign: c, onSave }: { campaign: Campaign; onSave: Save }) {
  const { overview } = useApp();
  const noCrm = !!overview && !overview.crm;
  return (
    <Row
      title="Skip people your CRM knows"
      hint={noCrm ? "No CRM is connected, so nobody is checked." : c.skip_known ? "Customers, open deals and booked calls stay out." : "Off: customers and companies mid-deal can join."}
    >
      <More>Checked in your CRM as each person joins: anyone whose company is a customer, has an open deal or a call booked. Turn it off for a campaign meant for customers.</More>
      <Switch checked={c.skip_known} onChange={(v) => void onSave({ skip_known: v })} label="Skip people your CRM knows" />
    </Row>
  );
}

/**
 * The mailbox it sends from, and how its day is going. A person picks it, from
 * their own mailboxes and the team's; an owner or admin from anyone's.
 */
function MailboxRow({ campaign: c, onSave }: { campaign: Campaign; onSave: Save }) {
  const { overview } = useApp();
  const data = useLoad<{ mailboxes: MailboxOption[]; workspace: string | null }>("/api/mailboxes");
  const workspace = data.data?.workspace ?? overview?.sending.mailbox ?? null;
  const sendsFrom = c.mailbox ?? workspace;
  const pace = overview?.sending.mailboxes.find((m) => m.address === sendsFrom);
  const options = [
    { value: "", label: workspace ?? "No mailbox yet", hint: "The workspace's, set in Settings" },
    ...mailboxOptions(data.data?.mailboxes ?? [], c.mailbox).filter((o) => o.value !== workspace || c.mailbox === workspace),
  ];
  return (
    <Row
      title="Sends from"
      hint={pace ? `${pace.sent_today} of ${pace.cap_today} sent today. Its daily cap and warm-up are in Settings.` : c.mailbox ? undefined : "The workspace's mailbox, from Settings."}
    >
      {c.live > 0 && <More>Conversations already started carry on only from the mailbox that started them: they wait while the campaign sends from another, and carry on when it sends from theirs again.</More>}
      <Picker label="Sends from" className="w-72" disabled={!overview?.can_approve || !data.data} value={c.mailbox ?? ""} options={options}
        onChange={(v) => void onSave({ mailbox: v || null })} />
    </Row>
  );
}

/** The workspace's sending hours, or the campaign's own: for a list in another time zone, or other hours. */
function HoursRows({ campaign: c, onSave }: { campaign: Campaign; onSave: Save }) {
  const { overview } = useApp();
  const base = overview?.sending.hours;
  const own = c.send_window;
  const zoneOptions = useMemo(() => zones(own?.timezone ?? base?.timezone ?? ""), [own?.timezone, base?.timezone]);
  if (!base) return null;
  const w = { timezone: own?.timezone ?? base.timezone, ranges: own?.ranges ?? base.ranges, weekdays_only: own?.weekdays_only ?? base.weekdays_only };
  const save = (part: Partial<typeof w>) => void onSave({ send_window: { ...w, ...part } });
  return (
    <>
      <Row title="Sending hours" hint={own ? "This campaign's own. Approved emails wait for them." : `The workspace's: ${describeHours(base)}.`}>
        <Picker label="Sending hours" className="w-56" value={own ? "own" : ""}
          options={[{ value: "", label: "The workspace's" }, { value: "own", label: "Its own", hint: "Another time zone, or other hours" }]}
          onChange={(v) => void onSave({ send_window: v ? w : null })} />
      </Row>
      {own && (
        <>
          <Row title="Hours">
            <RangesField ranges={w.ranges} onSave={(ranges) => save({ ranges })} />
          </Row>
          <Row title="Time zone">
            <Picker label="Time zone" className="w-56" value={w.timezone} options={zoneOptions} searchPlaceholder="Search time zones" onChange={(timezone) => save({ timezone })} />
          </Row>
          <Row title="Weekdays only">
            <Switch checked={w.weekdays_only} onChange={(weekdays_only) => save({ weekdays_only })} label="Weekdays only" />
          </Row>
        </>
      )}
    </>
  );
}

/** Which signature first emails and follow-ups get: the workspace default unless it picks one. */
function SignatureRows({ campaign: c, onSave }: { campaign: Campaign; onSave: Save }) {
  const data = useLoad<{ signatures: Signature[]; defaults: { signature_id: string | null; reply_signature_id: string | null } }>("/api/signatures?limit=100");
  if (!data.data) return null;
  const { signatures, defaults } = data.data;
  const nameOf = (id: string | null) => (id ? signatures.find((x) => x.id === id)?.name ?? "none" : "none");
  const options = (fallback: string | null) => [
    { value: "", label: `Default: ${nameOf(fallback)}`, hint: "Set in Settings" },
    { value: "none", label: "No signature" },
    ...signatures.map((x) => ({ value: x.id, label: x.name })),
  ];
  return (
    <>
      <Row title="Signature, first emails">
        <Picker label="Signature on first emails" className="w-56" value={c.signature_id ?? ""} options={options(defaults.signature_id)}
          onChange={(v) => void onSave({ signature_id: v || null })} />
      </Row>
      <Row title="Signature, follow-ups">
        <Picker label="Signature on follow-ups" className="w-56" value={c.reply_signature_id ?? ""} options={options(defaults.reply_signature_id)}
          onChange={(v) => void onSave({ reply_signature_id: v || null })} />
      </Row>
    </>
  );
}
