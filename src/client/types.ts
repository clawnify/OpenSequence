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
  footer: { signature: string; opt_out: string };
}

export interface Campaign {
  id: string;
  name: string;
  angle: string;
  status: CampaignStatus;
  stop_company: boolean;
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
  person: PersonRef & { linkedin_url: string; phone: string; notes: string };
  campaign: { id: string; name: string };
  enrollment: { id: string; status: EnrollmentStatus; reason: string | null };
}

export interface TouchDetail {
  touch: Touch;
  thread: Array<{ position: number; subject: string | null; body: string; sent_at: string }>;
  replies: Array<{ kind: string; intent: Intent | null; summary: string | null; excerpt: string; received_at: string }>;
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
  person: { id: string; email: string; name: string; company: string } | null;
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
    signature: string;
    opt_out: string;
    daily_cap: number;
    ramp_from: string | null;
    send_from: string;
    send_until: string;
    timezone: string;
    weekdays_only: boolean;
    crm_app_id: string | null;
    crm_in_use: string | null;
  };
  mailboxes: Array<{ address: string; isDefault: boolean }>;
  connections: { mail: boolean; calendar: boolean };
  crm_apps: Array<{ id: string; name: string }>;
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
