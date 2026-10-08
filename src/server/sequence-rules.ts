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

/** A long heading wraps onto a second line ("On … <sam@ourco.io>" / "wrote:"),
 *  as Gmail's plain text does. Joined, it counts only with an address in it,
 *  which a heading always has: a line of the person's own that happens to
 *  end in "wrote:" is kept. */
function wrappedHead(line: string, next: string | undefined): boolean {
  if (next === undefined) return false;
  const joined = `${line} ${next.trim()}`;
  return /<[^<>\s]+@[^<>\s]+>/.test(joined) && QUOTE_HEADS.some((re) => re.test(joined));
}

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
  for (const [i, line] of lines.entries()) {
    const s = line.trim();
    if (s.startsWith(">")) break;
    if (QUOTE_HEADS.some((re) => re.test(s)) || wrappedHead(s, lines[i + 1])) break;
    if (/^From: /.test(s) && kept.length > 0) break;
    kept.push(line.replace(/\s+$/, ""));
  }
  const out = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return out.length > max ? `${out.slice(0, max - 1).trimEnd()}…` : out;
}

/** How many words someone wrote. A reply of a few words can't say which
 *  question it answers, the email's or the opt-out line's: a fact, counted. */
export function wordCount(text: string | null | undefined): number {
  return (text ?? "").trim().split(/\s+/).filter(Boolean).length;
}

/** Whether a person should decide if a reply asks us to stop: the AI says it
 *  might, or the reply is too short to say what it answers. Never for a clear
 *  opt-out (already applied) or an automatic answer. */
export function needsOptOutCheck(reading: Reading, excerpt: string): boolean {
  if (reading.intent === "unsubscribe" || reading.intent === "out_of_office") return false;
  return reading.maybe_opt_out || wordCount(excerpt) <= 3;
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
  /** Might be asking us to stop, but not clearly (a bare "yes" that could
   *  answer the opt-out line or the email): a person decides. */
  maybe_opt_out: boolean;
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

/** A model's reading of a reply, or null when it is unusable. A return date
 *  must be after `today`: a model unsure of the year answers with a past one. */
export function coerceReading(raw: string, today?: string): Reading | null {
  const j = jsonIn(raw);
  if (!j) return null;
  const intent = INTENTS.includes(j.intent as Intent) ? (j.intent as Intent) : "other";
  const summary = oneLine(j.summary, 200);
  if (!summary) return null;
  const back = isDay(j.return_date) && (!today || j.return_date > today) ? j.return_date : null;
  return { intent, summary, return_date: back, maybe_opt_out: intent !== "unsubscribe" && j.maybe_opt_out === true };
}

/**
 * How the AI reads a reply. An opt-out is recognised in any words or language,
 * so the opt-out line in our emails can be as human as we like: it is handed
 * over, because a short reply ("yes please", "no") may be answering it.
 */
export function readingPrompt(optOut = "", today = ""): string {
  const line = optOut.replace(/\s+/g, " ").trim();
  return [
    "You read one email someone sent back to a sales email. Answer only with JSON:",
    '{"intent": "interested" | "not_interested" | "unsubscribe" | "out_of_office" | "other",',
    ' "summary": "one short line saying what they wrote, in English",',
    ' "return_date": "YYYY-MM-DD" or null,',
    ' "maybe_opt_out": true or false}',
    "unsubscribe: they don't want to hear from us again, in any words or language: remove me, stop, take me off your list, don't contact me, no more emails, or a short answer to our opt-out line asking us to stop.",
    "not_interested: declines but leaves the door open: not now, maybe later, we already have a provider, ask me next year.",
    "When a reply could be either of those two, and it sounds final or annoyed, it is unsubscribe.",
    "interested: wants to talk, asks for a call, a demo, prices or more information.",
    "out_of_office: an automatic away message. return_date is the day they are back, when it says.",
    "other: anything else, such as pointing to a colleague or asking who you are.",
    "maybe_opt_out: true when the reply might be asking us to stop but it isn't clear. Any reply of a few words that says yes, no, sure or no thanks without saying to what is one: it could answer the opt-out line as much as the email. A person decides those. False when the intent is unsubscribe.",
    ...(line ? [`Every email we send ends with this opt-out line, which a short reply may be answering: "${line}"`] : []),
    ...(today ? [`Today is ${today}. A date given without a year is the next one after today.`] : []),
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
  person: { first_name: string; last_name: string; title: string; company: string; notes: string; inbox?: boolean };
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
    "The body is plain text in short paragraphs, under 120 words. Put the greeting on its own line (Hi Jan,) and leave a blank line after it and between paragraphs.",
    "Make the point the step's instructions ask for. That point is what this email is for.",
    "No signature, no sign-off name and no unsubscribe line: those are added when it is sent.",
    "Never leave a placeholder such as [Name] or {{company}}. If you lack a fact, write around it.",
    "Use only what you are given about the person and about what we sell. Do not invent facts, results, features or names; if you have little to go on, keep it shorter.",
    "Write in the language the campaign's angle and the step's instructions are written in.",
    'In "rationale", say in one or two sentences why this draft, and what you left out.',
    ...(ctx.person.inbox
      ? ["This goes to the company's shared inbox (info@ and the like), not to a named person: no first name. Greet the team (Hello,), say in a line who it is for, and ask who handles this or to pass it on to whoever does."]
      : []),
  ].join("\n");
  const p = ctx.person;
  const name = [p.first_name, p.last_name].filter(Boolean).join(" ");
  const lines = [
    `What we sell: ${ctx.about || "(not set)"}`,
    `Campaign: ${ctx.campaign.name}`,
    `Who we write to and why: ${ctx.campaign.angle || "(not set)"}`,
    `This is step ${ctx.step.position} of ${ctx.step.total}. What it is for: ${ctx.step.instructions || "(no instructions: a short, polite follow-up)"}`,
    "",
    p.inbox ? "The company's shared inbox:" : "The person:",
    `Name: ${p.inbox ? (name ? `(a shared inbox; the person it is for: ${name})` : "(a shared inbox: no name)") : name || "(unknown)"}`,
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

/** A campaign's pick: null means the workspace default, NO_SIGNATURE none. */
export const NO_SIGNATURE = "none";

/**
 * The signature an email gets, as in Gmail: a first email and a follow-up
 * each have their own, the campaign's pick when it made one, else the
 * workspace default. A signature that no longer exists is no signature.
 */
export function signatureFor(
  kind: "first" | "reply",
  campaign: { signature_id: string | null; reply_signature_id: string | null },
  defaults: { signature_id: string | null; reply_signature_id: string | null },
  bodies: Map<string, string>,
): string {
  const pick = kind === "first" ? campaign.signature_id : campaign.reply_signature_id;
  const id = pick === null ? (kind === "first" ? defaults.signature_id : defaults.reply_signature_id) : pick === NO_SIGNATURE ? null : pick;
  return id ? bodies.get(id) ?? "" : "";
}

/** The email as it goes out: the draft, the signature, then the opt-out line. */
export function composeBody(body: string, signature: string, optOut: string): string {
  return [body.trim(), signature.trim(), optOut.trim()].filter(Boolean).join("\n\n");
}

/** Whether a signature is HTML (pasted from Gmail's settings or a signature
 *  maker) rather than plain text. Only real tag names count, and nothing with an
 *  @ in it: "Sam <sam@ourco.io>" is a plain-text signature line. */
const HTML_TAG = /<\/?(a|b|br|div|p|span|img|table|tbody|thead|tr|td|th|font|strong|em|i|u|s|ul|ol|li|hr|h[1-6]|small|sub|sup|blockquote|center|html|body|meta|style)\b[^<>@]*>/i;

export function isHtml(text: string): boolean {
  return HTML_TAG.test(text);
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Plain text as HTML that reads the same: escaped, line breaks kept. */
export function textToHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]).replace(/\r\n?/g, "\n").replace(/\n/g, "<br>");
}

/**
 * The email as it goes out. With a plain signature it stays plain text, which
 * is what a person's own cold email looks like. With an HTML signature the
 * whole email is HTML: the draft and the opt-out line escaped with their line
 * breaks kept, the signature in Gmail's own signature block.
 */
export function composeEmail(body: string, signature: string, optOut: string): { body: string; html: boolean } {
  if (!isHtml(signature)) return { body: composeBody(body, signature, optOut), html: false };
  const parts = [textToHtml(body.trim()), `<div class="gmail_signature">${signature.trim()}</div>`];
  if (optOut.trim()) parts.push(textToHtml(optOut.trim()));
  return { body: `<div dir="ltr">${parts.join("<br><br>")}</div>`, html: true };
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

// ── Handing research to the agent ──────────────────────────────────

/** People per hand-off: one agent task per batch, not per person, keeps its sessions few. */
export const RESEARCH_BATCH = 10;
/** A hand-off still without a draft after this long is made again: the agent's run may have died. */
export const RESEARCH_RETRY_MS = 3 * 60 * MINUTE_MS;
/** Hand-offs without a draft before a touch is left to a person. */
export const RESEARCH_TRIES = 2;

export interface ResearchWaiting {
  id: string;
  sent_at: string | null;
  agent_id: string | null;
  tries: number;
}

/**
 * What to hand to the research agent now, in the order given (oldest first).
 * Nothing while a batch it was handed is still being worked; else the touches
 * not handed yet, or handed long enough ago that the run ended without them,
 * each at most RESEARCH_TRIES times. A batch handed to an agent that is no
 * longer the pick is left to finish.
 */
export function researchBatch(waiting: ResearchWaiting[], agentId: string, now: Date): string[] {
  const working = (t: ResearchWaiting) => t.sent_at !== null && now.getTime() - Date.parse(t.sent_at) < RESEARCH_RETRY_MS;
  if (waiting.some((t) => t.agent_id === agentId && working(t))) return [];
  return waiting.filter((t) => !working(t) && t.tries < RESEARCH_TRIES).slice(0, RESEARCH_BATCH).map((t) => t.id);
}

/** What the research agent is asked to do. The touch ids travel in the payload. */
export function researchInstruction(app: { id: string | null; url: string | null }, count: number): string {
  const via = app.id
    ? `call_app_api with app_id "${app.id}"`
    : `call_app_api on the OpenSequence app${app.url ? ` at ${app.url}` : ""}`;
  return [
    `OpenSequence has ${count === 1 ? "an email" : `${count} emails`} waiting for your research; a person approves each one before it is sent. The payload lists the touch ids. For each one, through ${via}:`,
    "1. GET /api/touches/{id}: the person, the campaign, the step's instructions, what we sell (what_we_sell) and the thread so far. A review_note means a person sent your earlier draft back: do what it says. Read the campaign's angle with GET /api/campaigns/{campaign.id}.",
    "2. Research the person and their company: their website, recent news, job posts, their LinkedIn profile. Find one or two specific facts you can link to that connect to the angle. Leave out anything you can't source.",
    "3. Write the email: plain text, under 120 words, greeting them by first name. When person.inbox is true it goes to the company's shared inbox (info@): no name; greet the team and ask who handles this. No signature and no opt-out line (both are added when it goes out), and never a placeholder. When starts_thread is true it needs a short subject.",
    '4. Hand it in: PUT /api/touches/{id}/draft { "subject", "body", "rationale": "why this angle, what you left out", "sources": [{ "title", "url", "note" }] }. A 409 means it no longer needs you: move on.',
    "If you find nothing worth writing about someone, hand in nothing for them and say why in your summary. Never approve or send anything.",
  ].join("\n");
}

// ── People from a list ─────────────────────────────────────────────

/** A campaign reads its list at most this often. */
export const SOURCE_CHECK_MS = 60 * MINUTE_MS;

/** A person in a list, as the list's app gives it (an OpenProspector lead). */
export interface ListLead {
  id: string;
  full_name: string;
  title: string;
  company: string;
  domain: string;
  linkedin_url: string;
  source_url: string;
  evidence: string;
  email: string;
  email_verified: number;
  phone: string;
}

// ── A company's inbox ──────────────────────────────────────────────

/**
 * Local parts that name a company's shared inbox (info@, contact@, kantoor@),
 * not a person. A campaign writes either to named people or to such inboxes,
 * never both. OpenProspector keeps the same list in src/shared/inbox.ts:
 * change both together.
 */
export const INBOX_PARTS = [
  "info", "contact", "contactus", "hello", "hi", "hallo", "office", "general", "mail", "post",
  "sales", "support", "service", "help", "team", "admin", "enquiries", "inquiries", "reception",
  "booking", "bookings", "orders",
  "kantoor", "receptie", "welkom", "administratie",
  "segreteria", "amministrazione", "ufficio",
];

/** Whether an address is a company's shared inbox rather than a person's. */
export function isInbox(email: string | null | undefined): boolean {
  const e = (email ?? "").trim().toLowerCase();
  const at = e.lastIndexOf("@");
  return at > 0 && INBOX_PARTS.includes(e.slice(0, at));
}

export type Audience = "people" | "inboxes";

/** Why a person can't join a campaign of this audience, or null when they can. */
export function audienceMismatch(audience: Audience, email: string): string | null {
  const inbox = isInbox(email);
  if (audience === "people" && inbox) return "A company inbox: add it to a campaign that writes to company inboxes";
  if (audience === "inboxes" && !inbox) return "Not a company inbox (info@, contact@): this campaign writes to companies";
  return null;
}

/** The person a lead becomes here. Its evidence goes into the notes, which the writer works from. */
export function leadPerson(l: ListLead): Record<string, string> {
  const [first = "", ...rest] = (l.full_name ?? "").trim().split(/\s+/);
  const notes = [(l.evidence ?? "").trim(), (l.source_url ?? "").trim() ? `Found at: ${l.source_url.trim()}` : ""].filter(Boolean).join("\n");
  return {
    email: l.email, first_name: first, last_name: rest.join(" "), title: l.title ?? "", company: l.company ?? "",
    linkedin_url: l.linkedin_url ?? "", phone: l.phone ?? "", notes,
  };
}

/**
 * Whether a campaign takes a lead now: not if it took it before, not without a
 * verified email, not an address of the other kind (a person's in a campaign
 * written to inboxes, or the reverse), and not once the company (by email
 * domain; a personal address is no company) already has `cap` people in the
 * campaign. A company gets one inbox: its info@ and its sales@ reach the same
 * few people.
 */
export function leadVerdict(
  l: ListLead,
  taken: Set<string>,
  perCompany: Map<string, number>,
  cap: number,
  domain: string,
  audience: Audience = "people",
): "take" | "taken" | "unverified" | "other_audience" | "company_full" {
  if (taken.has(l.id)) return "taken";
  if (!l.email || !l.email_verified) return "unverified";
  if (audienceMismatch(audience, l.email)) return "other_audience";
  if (domain && (perCompany.get(domain) ?? 0) >= (audience === "inboxes" ? 1 : cap)) return "company_full";
  return "take";
}
