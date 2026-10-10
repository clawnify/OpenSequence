export type CampaignStatus = "draft" | "active" | "paused" | "archived";
export type Channel = "email" | "call" | "linkedin" | "task";
export type Writer = "research" | "thread";
export type EnrollmentStatus = "active" | "paused" | "replied" | "meeting" | "bounced" | "unsubscribed" | "stopped" | "finished";
export type TouchStatus = "research" | "drafting" | "review" | "approved" | "sending" | "sent" | "todo" | "done" | "skipped" | "failed";
export type Intent = "interested" | "not_interested" | "unsubscribe" | "out_of_office" | "other";

export interface Sending {
  mailbox: string | null;
  cap_today: number;
  sent_today: number;
  next_send_at: string;
  last_run_at: string | null;
  next_run_at: string | null;
  last_error: string | null;
  crm_error: string | null;
}

export interface Counts {
  review: number;
  research: number;
  drafting: number;
  todo: number;
  approved: number;
  failed: number;
  replies: number;
  campaigns: number;
  people: number;
}

export interface Overview {
  counts: Counts;
  sending: Sending;
  ready: { mailbox: boolean; about: boolean };
  crm: boolean;
  can_approve: boolean;
  /** Added under every email when it is sent. */
  footer: { opt_out: string };
  /** Who research-first steps are handed to, and why the last hand-off was refused. */
  research: { agent: { id: string; name: string } | null; error: string | null };
}

export interface Campaign {
  id: string;
  name: string;
  angle: string;
  status: CampaignStatus;
  stop_company: boolean;
  /** People the CRM knows (a customer, an open deal, a call booked) stay out as they join. */
  skip_known: boolean;
  /** Who it writes to: named people, or companies' general addresses (info@) with no first name. Never both. */
  audience: "people" | "inboxes";
  /** null: the workspace default; "none": no signature; else a signature's id. */
  signature_id: string | null;
  reply_signature_id: string | null;
  /** A list in another app of the workspace (OpenProspector) that new people come from, every day. */
  source: CampaignSource | null;
  people: number;
  live: number;
  reached: number;
  sent: number;
  replied: number;
  meetings: number;
  bounced: number;
  created_at: string;
}

export interface Step {
  id?: string;
  position?: number;
  wait_days: number;
  channel: Channel;
  writer: Writer;
  instructions: string;
}

export interface PersonRef {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  title: string;
  company: string;
}

export interface Person extends PersonRef {
  domain: string;
  linkedin_url: string;
  phone: string;
  notes: string;
  /** A company's general address (info@, contact@), not a person's. */
  inbox: boolean;
  source: string;
  crm_contact_id: string | null;
  unsubscribed_at: string | null;
  bounced_at: string | null;
  created_at: string;
  campaign: { id: string; name: string; status: EnrollmentStatus; step: number; reason: string | null } | null;
}

export interface Source {
  title: string;
  url: string;
  note: string;
}

export interface Touch {
  id: string;
  status: TouchStatus;
  channel: Channel;
  position: number;
  total_steps: number;
  subject: string | null;
  body: string | null;
  edited: boolean;
  rationale: string | null;
  sources: Source[];
  written_by: string | null;
  review_note: string | null;
  error: string | null;
  instructions: string;
  writer: Writer;
  due_at: string | null;
  sent_at: string | null;
  starts_thread: boolean;
  /** For a touch waiting for research: whom it was handed to, when, and how many times. */
  research: { agent_id: string | null; sent_at: string | null; tries: number } | null;
  person: PersonRef & { linkedin_url: string; phone: string; notes: string; inbox: boolean };
  campaign: { id: string; name: string };
  enrollment: { id: string; status: EnrollmentStatus; reason: string | null };
}

export interface TouchDetail {
  touch: Touch;
  thread: Array<{ position: number; subject: string | null; body: string; sent_at: string }>;
  replies: Array<{ kind: string; intent: Intent | null; summary: string | null; excerpt: string; received_at: string }>;
  /** The signature this email gets when it goes out: plain text or HTML. */
  signature: string;
}

/** What the connected CRM knows about the person, read when a draft is opened (GET /api/touches/:id/crm). */
export interface CrmCheck {
  crm: boolean;
  notes: Array<{ tone: "warn" | "info"; text: string }>;
  link: string | null;
  error: string | null;
}

export interface Signature {
  id: string;
  name: string;
  body: string;
}

export interface Reply {
  id: string;
  kind: "reply" | "auto" | "bounce";
  intent: Intent | null;
  summary: string | null;
  excerpt: string;
  from_email: string;
  received_at: string;
  handled_at: string | null;
  /** Might be asking us to stop, but not clearly: a person decides. */
  maybe_opt_out: boolean;
  person: { id: string; email: string; name: string; company: string; unsubscribed: boolean } | null;
  campaign: { id: string; name: string } | null;
  enrollment: { id: string; status: EnrollmentStatus; reason: string | null } | null;
}

export interface CampaignPerson {
  id: string;
  status: EnrollmentStatus;
  step: number;
  due_at: string | null;
  last_sent_at: string | null;
  reason: string | null;
  person: PersonRef;
}

export interface PersonDetail {
  person: Person;
  enrollments: Array<{ id: string; campaign: { id: string; name: string }; status: EnrollmentStatus; step: number; due_at: string | null; reason: string | null; last_sent_at: string | null }>;
  touches: Touch[];
  replies: Array<{ id: string; kind: string; intent: Intent | null; summary: string | null; excerpt: string; received_at: string }>;
}

export interface SettingsView {
  settings: {
    about: string;
    mailbox: string | null;
    signature_id: string | null;
    reply_signature_id: string | null;
    opt_out: string;
    daily_cap: number;
    ramp_from: string | null;
    send_from: string;
    send_until: string;
    timezone: string;
    weekdays_only: boolean;
    crm_app_id: string | null;
    crm_in_use: string | null;
    research_agent_id: string | null;
    research_agent_name: string | null;
    research_error: string | null;
  };
  mailboxes: Array<{ address: string; isDefault: boolean }>;
  signatures: Signature[];
  connections: { mail: boolean; calendar: boolean };
  crm_apps: Array<{ id: string; name: string }>;
  /** The workspace's agents, for the research pick. */
  agents: Array<{ id: string; name: string; status: string }>;
  agents_error: string | null;
  /** The Company Knowledge document pinned as "What you sell", used when the field is empty. */
  about_source: { title: string; version: number; url: string } | null;
  about_source_error: string | null;
  sending: Sending;
  live_threads: number;
  can_configure: boolean;
}

export interface EnrollResult {
  enrolled: number;
  skipped: Array<{ person_id: string; email: string; reason: string }>;
}

export interface AddPeopleResult {
  created: number;
  updated: number;
  invalid: Array<{ row: number; error: string }>;
  enrolled: number | null;
  skipped: Array<{ person_id: string; email: string; reason: string }>;
}

export type Page<K extends string, T> = { [k in K]: T[] } & { total: number; page: number; limit: number };

export interface CampaignSource {
  app_id: string;
  list_id: string;
  list_name: string;
  /** New people a day from the list, at most. */
  daily: number;
  /** People per company in the campaign, at most. */
  per_company: number;
  checked_at: string | null;
  error: string | null;
}

/** What a campaign's list gave: today's count, and the latest people taken or skipped. */
export interface SourceActivity {
  taken_today: number;
  recent: Array<{ email: string | null; outcome: "enrolled" | "skipped"; reason: string | null; taken_at: string }>;
}

/** A list of people in another app of the workspace. */
export interface PeopleList {
  id: string;
  name: string;
  refresh: string;
  member_count: number;
  verified_count: number;
}
