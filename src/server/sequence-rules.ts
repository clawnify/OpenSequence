// OpenSequence: the rules. When a step is due and when an email may go out
// (the sending window, the daily cap and its ramp, the spacing between sends),
// what came back on a thread (a reply, an automatic answer or a bounce), which
// company a person belongs to, and what the AI may write. Pure: no I/O and no
// clock of its own, so each rule can be checked on its own. engine.ts is the
// I/O around them.

export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;

// ── Time where the sender is ───────────────────────────────────────

export interface Window {
  timezone: string; // IANA name, e.g. Europe/Amsterdam
  send_from: string; // "HH:MM", local
  send_until: string; // "HH:MM", local, after send_from
  weekdays_only: boolean;
}

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  minutes: number; // since local midnight
  weekday: number; // 0 Sunday … 6 Saturday
}

export function isTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "09:30" → 570; anything else → null. */
export function minutesOf(hhmm: unknown): number | null {
  if (typeof hhmm !== "string") return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localParts(at: Date, tz: string): LocalParts {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(at)) p[part.type] = part.value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    minutes: (Number(p.hour) % 24) * 60 + Number(p.minute),
    weekday: WEEKDAYS[p.weekday] ?? 0,
  };
}

/** The local calendar day as YYYY-MM-DD. */
export function localDay(at: Date, tz: string): string {
  const p = localParts(at, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** How far the zone's clock is ahead of UTC at `at`, in ms. */
function offsetMs(at: Date, tz: string): number {
  const p = localParts(at, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, 0, p.minutes);
  return asUtc - Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS;
}

/** The instant a local date and time happens in `tz`. Across a DST change the
 *  offset is read again at the first guess, which lands within the hour. */
export function zonedInstant(year: number, month: number, day: number, minutes: number, tz: string): Date {
  const naive = Date.UTC(year, month - 1, day, 0, minutes);
  const first = naive - offsetMs(new Date(naive), tz);
  return new Date(naive - offsetMs(new Date(first), tz));
}

/** Local midnight of the day `at` falls on. */
export function dayStart(at: Date, tz: string): Date {
  const p = localParts(at, tz);
  return zonedInstant(p.year, p.month, p.day, 0, tz);
}

function sendingDay(weekday: number, w: Window): boolean {
  return !w.weekdays_only || (weekday >= 1 && weekday <= 5);
}

export function inWindow(at: Date, w: Window): boolean {
  const p = localParts(at, w.timezone);
  const from = minutesOf(w.send_from) ?? 0;
  const until = minutesOf(w.send_until) ?? 0;
  return sendingDay(p.weekday, w) && p.minutes >= from && p.minutes < until;
}

/** `at` itself when it falls inside the window, else the next time it opens. */
export function nextWindowOpen(at: Date, w: Window): Date {
  if (inWindow(at, w)) return at;
  const p = localParts(at, w.timezone);
  const from = minutesOf(w.send_from) ?? 0;
  for (let d = 0; d <= 7; d++) {
    const day = new Date(Date.UTC(p.year, p.month - 1, p.day + d));
    const weekday = day.getUTCDay();
    if (!sendingDay(weekday, w)) continue;
    const open = zonedInstant(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), from, w.timezone);
    if (open.getTime() > at.getTime()) return open;
  }
  return new Date(at.getTime() + DAY_MS); // unreachable with a valid window
}

/** Whole days from one YYYY-MM-DD to another (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

export function isDay(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
}

// ── How much goes out ──────────────────────────────────────────────

/** A new mailbox starts at RAMP_START emails a day and adds RAMP_STEP each week,
 *  up to the cap: providers distrust a fresh address that sends a lot at once. */
export const RAMP_START = 10;
export const RAMP_STEP = 10;

export function dailyCap(cap: number, rampFrom: string | null, today: string): number {
  if (!rampFrom || !isDay(rampFrom)) return cap;
  const days = daysBetween(rampFrom, today);
  if (days < 0) return Math.min(cap, RAMP_START);
  return Math.min(cap, RAMP_START + Math.floor(days / 7) * RAMP_STEP);
}

/** The gap between two sends: the day's emails spread across the window, never
 *  closer than 2 minutes and never more than an hour apart. */
export function sendGapMs(w: Window, cap: number): number {
  const span = (minutesOf(w.send_until) ?? 0) - (minutesOf(w.send_from) ?? 0);
  const gap = Math.floor(Math.max(span, 0) / Math.max(cap, 1));
  return Math.min(Math.max(gap, 2), 60) * MINUTE_MS;
}

export interface SendState {
  sentToday: number;
  lastSentAt: string | null;
}

/** When the next email may go out: inside the window, under the day's cap,
 *  and a gap after the last one. At or before `now` means now. */
export function nextSendAt(now: Date, w: Window, cap: number, s: SendState): Date {
  if (cap <= 0 || s.sentToday >= cap) {
    const tomorrow = new Date(dayStart(now, w.timezone).getTime() + DAY_MS + 2 * 60 * MINUTE_MS);
    return nextWindowOpen(dayStart(tomorrow, w.timezone), w);
  }
  const last = s.lastSentAt ? Date.parse(s.lastSentAt) : NaN;
  const earliest = Number.isNaN(last) ? now : new Date(Math.max(now.getTime(), last + sendGapMs(w, cap)));
  return nextWindowOpen(earliest, w);
}

// ── Steps ──────────────────────────────────────────────────────────

export const CHANNELS = ["email", "call", "linkedin", "task"] as const;
export type Channel = (typeof CHANNELS)[number];
export const WRITERS = ["research", "thread"] as const;
export type Writer = (typeof WRITERS)[number];

export interface StepInput {
  id?: string;
  wait_days: number;
  channel: Channel;
  writer: Writer;
  instructions: string;
}

export const MAX_STEPS = 10;
export const MAX_WAIT_DAYS = 60;

/** A campaign's steps as a person sends them: checked whole, in order. */
export function validateSteps(input: unknown): { steps: StepInput[] } | { error: string } {
  if (!Array.isArray(input) || input.length === 0) return { error: "A campaign needs at least one step" };
  if (input.length > MAX_STEPS) return { error: `A campaign has at most ${MAX_STEPS} steps` };
  const steps: StepInput[] = [];
  for (const [i, raw] of input.entries()) {
    const s = (raw ?? {}) as Record<string, unknown>;
    const n = i + 1;
    const wait = s.wait_days;
    if (typeof wait !== "number" || !Number.isInteger(wait) || wait < 0 || wait > MAX_WAIT_DAYS) {
      return { error: `Step ${n}: wait between 0 and ${MAX_WAIT_DAYS} whole days` };
    }
    if (!CHANNELS.includes(s.channel as Channel)) return { error: `Step ${n}: channel must be one of ${CHANNELS.join(", ")}` };
    const channel = s.channel as Channel;
    const writer = (s.writer ?? "thread") as Writer;
    if (!WRITERS.includes(writer)) return { error: `Step ${n}: writer must be research or thread` };
    const instructions = typeof s.instructions === "string" ? s.instructions.trim() : "";
    if (instructions.length > 2000) return { error: `Step ${n}: instructions are at most 2,000 characters` };
    if (channel !== "email" && !instructions) return { error: `Step ${n}: say what the ${channel === "task" ? "task" : channel} is for` };
    steps.push({
      ...(typeof s.id === "string" && s.id ? { id: s.id } : {}),
      wait_days: wait,
      channel,
      writer: channel === "email" ? writer : "thread",
      instructions,
    });
  }
  if (!steps.some((s) => s.channel === "email")) return { error: "A campaign needs at least one email step" };
  return { steps };
}

export function dueAfter(from: Date | string, waitDays: number): string {
  const t = typeof from === "string" ? Date.parse(from) : from.getTime();
  return new Date(t + waitDays * DAY_MS).toISOString();
}

/** After step `done`: the next step and when it is due, or null when it was the last. */
export function nextStep(
  steps: Array<{ position: number; wait_days: number }>,
  done: number,
  at: Date,
): { step: number; due_at: string } | null {
  const next = steps.find((s) => s.position === done + 1);
  return next ? { step: next.position, due_at: dueAfter(at, next.wait_days) } : null;
}

/** Drafts are written this far ahead of their step, so they can be approved in time. */
export const PREPARE_AHEAD_MS = 2 * DAY_MS;

/** How many more drafts to start: the queue holds about two days of sending. */
export function prepareBudget(openDrafts: number, cap: number): number {
  return Math.max(0, Math.max(cap, 1) * 2 - openDrafts);
}

// ── People and companies ──────────────────────────────────────────

export function normaliseEmail(v: unknown): string {
  return typeof v === "string" ? v.trim().toLowerCase().replace(/^mailto:/, "") : "";
}

export function isEmail(v: unknown): boolean {
  const e = normaliseEmail(v);
  return e.length <= 254 && /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z0-9-]{2,}$/i.test(e);
}

export function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at < 0 ? "" : email.slice(at + 1).trim().toLowerCase();
}

/** The company's mail domain, or "" for a personal address: someone at
 *  gmail.com shares nothing with everyone else at gmail.com. */
export function companyDomain(email: string, isPersonal: (domain: string) => boolean): string {
  const d = emailDomain(normaliseEmail(email));
  return d && !isPersonal(d) ? d : "";
}

/** "Ada Lovelace <ADA@x.com>" or "ada@x.com" → "ada@x.com". */
export function addressOf(v: string | null | undefined): string {
  if (!v) return "";
  const m = /<([^>]+)>/.exec(v);
  return normaliseEmail(m ? m[1] : v.split(",")[0]);
}

// ── What came back ─────────────────────────────────────────────────

export interface GmailHeader {
  name?: string;
  value?: string;
}

/** A message as Gmail's thread and message reads return it. */
export interface GmailMessage {
  messageId?: string;
  threadId?: string;
  labelIds?: string[];
  messageText?: string;
  messageTimestamp?: string;
  sender?: string;
  to?: string;
  subject?: string;
  preview?: { body?: string; subject?: string };
  payload?: { mimeType?: string; headers?: GmailHeader[] };
}

export function header(m: GmailMessage, name: string): string | null {
  const want = name.toLowerCase();
  const h = (m.payload?.headers ?? []).find((x) => (x.name ?? "").toLowerCase() === want);
  return h?.value ?? null;
}

/** Someone else's message: not one we sent, not a draft. */
export function isInbound(m: GmailMessage, mailbox: string): boolean {
  const labels = m.labelIds ?? [];
  if (labels.includes("SENT") || labels.includes("DRAFT")) return false;
  return addressOf(m.sender) !== normaliseEmail(mailbox);
}

export type InboundKind = "reply" | "auto" | "bounce";

const BOUNCE_SENDERS = new Set(["mailer-daemon", "postmaster"]);

/** From the headers alone: a delivery failure, an automatic answer (out of
 *  office, vacation, ticket receipts), or a person writing back. */
export function inboundKind(m: GmailMessage): InboundKind {
  const from = addressOf(m.sender);
  const local = from.slice(0, from.lastIndexOf("@"));
  const type = `${m.payload?.mimeType ?? ""} ${header(m, "Content-Type") ?? ""}`.toLowerCase();
  if (BOUNCE_SENDERS.has(local) || type.includes("multipart/report") || header(m, "X-Failed-Recipients")) return "bounce";
  const auto = (header(m, "Auto-Submitted") ?? "").trim().toLowerCase();
  const precedence = (header(m, "Precedence") ?? "").trim().toLowerCase();
  if ((auto && auto !== "no") || header(m, "X-Autoreply") || header(m, "X-Autorespond") || precedence === "auto_reply") return "auto";
  return "reply";
}

const ENTITIES: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

/** Lines mail clients put above the quoted thread. Mechanical: these are
 *  written by software, so a match is a fact, never a reading of the person. */
const QUOTE_HEADS = [
  /^On .{4,200} wrote:\s*$/,
  /^Il giorno .{4,200} ha scritto:\s*$/,
  /^Op .{4,200} schreef .{0,200}:\s*$/,
  /^Am .{4,200} schrieb .{0,200}:\s*$/,
  /^Le .{4,200} a écrit\s?:\s*$/,
  /^El .{4,200} escribió:\s*$/,
  /^-{2,}\s*Original Message\s*-{2,}\s*$/i,
  /^_{8,}\s*$/, // Outlook's rule above "From: … Sent: …"
];

/** What the person wrote in this message: the quoted thread below it cut off,
 *  HTML turned into text, at most `max` characters. */
export function ownWords(text: string | null | undefined, max = 1500): string {
  let t = text ?? "";
  if (/<(div|br|p|blockquote|html|body|span)\b/i.test(t)) {
    const cut = t.search(/<div[^>]*class="?[^">]*gmail_quote|<blockquote/i);
    if (cut >= 0) t = t.slice(0, cut);
    t = t.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div)>/gi, "\n").replace(/<[^>]+>/g, "");
    t = t.replace(/&(lt|gt|amp|quot|#39|nbsp);/g, (e) => ENTITIES[e] ?? e);
  }
  const lines = t.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const s = line.trim();
    if (s.startsWith(">")) break;
    if (QUOTE_HEADS.some((re) => re.test(s))) break;
    if (/^From: /.test(s) && kept.length > 0) break;
    kept.push(line.replace(/\s+$/, ""));
  }
  const out = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return out.length > max ? `${out.slice(0, max - 1).trimEnd()}…` : out;
}

/** Every address mentioned in a message, for a bounce Gmail filed outside the thread. */
export function addressesIn(text: string | null | undefined): string[] {
  const found = (text ?? "").toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) ?? [];
  return [...new Set(found)];
}

// ── The AI ─────────────────────────────────────────────────────────

export const INTENTS = ["interested", "not_interested", "unsubscribe", "out_of_office", "other"] as const;
export type Intent = (typeof INTENTS)[number];

export interface Reading {
  intent: Intent;
  summary: string;
  return_date: string | null;
}

/** The first JSON object in a model's answer. */
export function jsonIn(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(raw.slice(start, end + 1));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function oneLine(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

export function coerceReading(raw: string): Reading | null {
  const j = jsonIn(raw);
  if (!j) return null;
  const intent = INTENTS.includes(j.intent as Intent) ? (j.intent as Intent) : "other";
  const summary = oneLine(j.summary, 200);
  if (!summary) return null;
  return { intent, summary, return_date: isDay(j.return_date) ? j.return_date : null };
}

export function readingPrompt(): string {
  return [
    "You read one email someone sent back to a sales email. Answer only with JSON:",
    '{"intent": "interested" | "not_interested" | "unsubscribe" | "out_of_office" | "other",',
    ' "summary": "one short line saying what they wrote, in English",',
    ' "return_date": "YYYY-MM-DD" or null}',
    "interested: wants to talk, asks for a call, a demo, prices or more information.",
    "not_interested: declines, has a provider already, says not now.",
    "unsubscribe: asks not to be emailed again, to be removed, or to stop.",
    "out_of_office: an automatic away message. return_date is the day they are back, when it says.",
    "other: anything else, such as pointing to a colleague or asking who you are.",
    "Read only what they wrote, not the quoted email below it.",
  ].join("\n");
}

export interface Draft {
  subject: string | null;
  body: string;
  rationale: string;
}

/** An unfilled template placeholder: [Name], {{first_name}}, <company>. */
const PLACEHOLDER = /\[[A-Z][^\]\n]{0,40}\]|\{\{[^}\n]{1,40}\}\}|<(first|last)?_?name>/i;

export function hasPlaceholder(text: string): boolean {
  return PLACEHOLDER.test(text);
}

/** A model's draft, or null when it is unusable: no body, a subject missing on
 *  an email that starts a thread, or a placeholder left in. */
export function coerceDraft(raw: string, needsSubject: boolean): Draft | null {
  const j = jsonIn(raw);
  if (!j) return null;
  const body = typeof j.body === "string" ? j.body.replace(/\r\n?/g, "\n").trim() : "";
  if (!body || body.length > 5000) return null;
  const subject = needsSubject ? oneLine(j.subject, 150) : null;
  if (needsSubject && !subject) return null;
  if (hasPlaceholder(body) || (subject && hasPlaceholder(subject))) return null;
  return { subject, body, rationale: oneLine(j.rationale, 600) };
}

export interface DraftContext {
  about: string;
  campaign: { name: string; angle: string };
  step: { position: number; total: number; instructions: string };
  person: { first_name: string; last_name: string; title: string; company: string; notes: string };
  /** What already went out on this thread, oldest first. Empty for a first email. */
  sent: Array<{ subject: string | null; body: string; sent_at: string }>;
  /** A person's note when they sent an earlier draft back. */
  review_note: string | null;
  needsSubject: boolean;
}

export function draftPrompt(ctx: DraftContext): { system: string; user: string } {
  const system = [
    "You write one short sales email for a person to review before it is sent.",
    'Answer only with JSON: {"subject": string or null, "body": string, "rationale": string}.',
    ctx.needsSubject
      ? "This email starts a new thread: give it a plain subject of a few words."
      : 'This email replies in an existing thread: "subject" is null.',
    "The body is plain text in short paragraphs, under 120 words. Greet the person by first name when you have it.",
    "No signature, no sign-off name and no unsubscribe line: those are added when it is sent.",
    "Never leave a placeholder such as [Name] or {{company}}. If you lack a fact, write around it.",
    "Use only what you are given about the person. Do not invent facts, results or names.",
    "Write in the language the campaign's angle and the step's instructions are written in.",
    'In "rationale", say in one or two sentences why this draft, and what you left out.',
  ].join("\n");
  const p = ctx.person;
  const lines = [
    `What we sell: ${ctx.about || "(not set)"}`,
    `Campaign: ${ctx.campaign.name}`,
    `Who we write to and why: ${ctx.campaign.angle || "(not set)"}`,
    `This is step ${ctx.step.position} of ${ctx.step.total}. What it is for: ${ctx.step.instructions || "(no instructions: a short, polite follow-up)"}`,
    "",
    "The person:",
    `Name: ${[p.first_name, p.last_name].filter(Boolean).join(" ") || "(unknown)"}`,
    `Title: ${p.title || "(unknown)"}`,
    `Company: ${p.company || "(unknown)"}`,
    `Notes: ${p.notes || "(none)"}`,
  ];
  if (ctx.sent.length) {
    lines.push("", "Already sent on this thread, oldest first. They have not replied:");
    for (const [i, s] of ctx.sent.entries()) {
      lines.push(`--- Email ${i + 1}, ${s.sent_at.slice(0, 10)}${s.subject ? `, subject "${s.subject}"` : ""}`, s.body);
    }
  }
  if (ctx.review_note) lines.push("", `A reviewer sent the last draft back with this note: ${ctx.review_note}`);
  return { system, user: lines.join("\n") };
}

/** The email as it goes out: the draft, the signature, then the opt-out line. */
export function composeBody(body: string, signature: string, optOut: string): string {
  return [body.trim(), signature.trim(), optOut.trim()].filter(Boolean).join("\n\n");
}

// ── The calendar ───────────────────────────────────────────────────

export interface CalendarAttendee {
  email?: string;
  self?: boolean;
  resource?: boolean;
  responseStatus?: string;
}

export interface CalendarEvent {
  id?: string;
  status?: string;
  start?: { dateTime?: string; date?: string };
  attendees?: CalendarAttendee[];
}

/** The people a meeting is booked with: not cancelled, not declined by us, and
 *  only guests who have not declined it themselves. */
export function bookedWith(e: CalendarEvent): string[] {
  if (!e.id || e.status === "cancelled") return [];
  const attendees = e.attendees ?? [];
  if (attendees.some((a) => a.self && a.responseStatus === "declined")) return [];
  return attendees
    .filter((a) => !a.self && !a.resource && a.responseStatus !== "declined")
    .map((a) => normaliseEmail(a.email))
    .filter((a) => a.includes("@"));
}
