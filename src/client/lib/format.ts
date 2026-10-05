import type { CampaignStatus, Channel, EnrollmentStatus, Intent, PersonRef } from "../types";
import type { ColorToken } from "./utils";

export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

export function personName(p: Pick<PersonRef, "first_name" | "last_name" | "email">): string {
  return [p.first_name, p.last_name].filter(Boolean).join(" ") || p.email;
}

/** "just now", "12 min ago", "3 h ago", then the date. */
export function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const t = Date.parse(iso.includes("T") || iso.endsWith("Z") ? iso : `${iso.replace(" ", "T")}Z`);
  if (Number.isNaN(t)) return iso;
  const min = Math.round((Date.now() - t) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** When something is due: "now", "in 40 min", "today 14:30", "tomorrow 09:00", "Mon 6 Oct". */
export function due(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  const now = new Date();
  const min = Math.round((t - now.getTime()) / 60_000);
  if (min <= 0) return min > -60 * 24 ? "now" : `${Math.round(-min / (60 * 24))} days late`;
  if (min < 60) return `in ${min} min`;
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(d) - day(now)) / 86_400_000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

export const ENROLLMENT_STATUS: Record<EnrollmentStatus, { label: string; tone: ColorToken }> = {
  active: { label: "In sequence", tone: "info" },
  paused: { label: "Paused", tone: "warning" },
  replied: { label: "Replied", tone: "success" },
  meeting: { label: "Meeting booked", tone: "success" },
  bounced: { label: "Bounced", tone: "danger" },
  unsubscribed: { label: "Unsubscribed", tone: "slate" },
  stopped: { label: "Stopped", tone: "slate" },
  finished: { label: "Finished", tone: "slate" },
};

export const CAMPAIGN_STATUS: Record<CampaignStatus, { label: string; tone: ColorToken }> = {
  draft: { label: "Draft", tone: "slate" },
  active: { label: "Active", tone: "success" },
  paused: { label: "Paused", tone: "warning" },
  archived: { label: "Archived", tone: "slate" },
};

export const INTENT: Record<Intent, { label: string; tone: ColorToken }> = {
  interested: { label: "Interested", tone: "success" },
  not_interested: { label: "Not interested", tone: "slate" },
  unsubscribe: { label: "Opted out", tone: "danger" },
  out_of_office: { label: "Out of office", tone: "warning" },
  other: { label: "Other", tone: "info" },
};

export const CHANNEL_LABEL: Record<Channel, string> = {
  email: "Email",
  call: "Call",
  linkedin: "LinkedIn",
  task: "Task",
};

/** A link to a message in the sending mailbox's Gmail, signed in as that address. */
export function gmailLink(mailbox: string | null, messageId: string): string {
  const user = mailbox ? `?authuser=${encodeURIComponent(mailbox)}` : "";
  return `https://mail.google.com/mail/${user}#all/${encodeURIComponent(messageId)}`;
}
