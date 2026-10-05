// The run: one bounded pass over everything that moves a campaign forward,
// booked on the platform queue so it carries on after the page that started
// it closes. In order:
//   settle    a send a dead run left half done is looked up in Gmail first
//   inbox     received mail since the last read; a reply, an automatic answer
//             or a bounce on a campaign's thread stops or pauses it
//   read      a few new replies go to the AI, which says what they want
//   calendar  a meeting booked with someone in a campaign stops it
//   resume    out-of-office pauses that have run out
//   prepare   steps due soon become touches: an AI draft, research for the
//             agent, or a task for a person
//   draft     a few AI drafts are written
//   send      one approved email, inside the window and under the cap
// Then the next run is booked. The rules live in sequence-rules.ts.

import type { ConnectionsEnv } from "@clawnify/connections";
import { get, query, run } from "./db.js";
import { bookableAt } from "./jobs.js";
import { complete, ModelError, type AiEnv } from "./model.js";
import {
  calendarPage, calendarRun, crmContactFor, crmNote, mailFor, readMessage, readThread, searchMail, sendNew, sendReply,
  type Mail, type PlatformEnv,
} from "./integrations.js";
import {
  DAY_MS, MINUTE_MS, PREPARE_AHEAD_MS, addressOf, addressesIn, bookedWith, coerceDraft, coerceReading, companyDomain,
  composeBody, dailyCap, dayStart, draftPrompt, emailDomain, inboundKind, isInbound, localDay, nextSendAt,
  ownWords, prepareBudget, readingPrompt, type GmailMessage, type Window,
} from "./sequence-rules.js";
import {
  OPEN_TOUCH, advance, endEnrollments, getSettings, isPersonal, parts, personName, skipOpenTouches, stepsOf, stopAround,
  stopCompany, unsubscribe, type Enrollment, type Person, type Settings, type Touch,
} from "./store.js";

export type EngineEnv = ConnectionsEnv & AiEnv & PlatformEnv & {
  CLAWNIFY_QUEUE_URL?: string;
  /** Set by a bundle install next to a CRM: the default CRM to write to. */
  CRM_APP_ID?: string;
};

const RUN_BUDGET_MS = 20_000;
/** Longer than a run can take, so a run that died is not waited on for long. */
const LEASE_MS = 90_000;
/** How often received mail is read, and booked meetings looked for. */
export const INBOX_INTERVAL_MS = 10 * MINUTE_MS;
const CALENDAR_INTERVAL_MS = 30 * MINUTE_MS;
/** Each read of received mail reaches back this far before the last one: mail can be searchable late. */
const INBOX_OVERLAP_MS = 60 * MINUTE_MS;
const INBOX_PAGES = 5;
/** A send handed to Gmail this long ago by a run that never finished is looked up. */
const SETTLE_AFTER_MS = 2 * MINUTE_MS;
const DRAFTS_PER_RUN = 5;
const READS_PER_RUN = 3;
const MAX_ATTEMPTS = 3;
/** An automatic answer without a return date pauses this long. */
const AUTO_PAUSE_MS = 7 * DAY_MS;
/** Booked meetings are looked for from a day back to this far ahead. */
const CALENDAR_AHEAD_MS = 60 * DAY_MS;
/** With no live campaign, the run keeps reading replies to what went out this recently. */
const LATE_REPLY_MS = 30 * DAY_MS;

const inList = (n: number) => Array.from({ length: n }, () => "?").join(", ");
const OPEN_SQL = OPEN_TOUCH.map((s) => `'${s}'`).join(", ");

export function windowOf(s: Settings): Window {
  return { timezone: s.timezone, send_from: s.send_from, send_until: s.send_until, weekdays_only: !!s.weekdays_only };
}

/** The CRM sends and replies are written to: the one picked in Settings, else the
 *  one a bundle install named. An empty pick means "none". */
export function crmAppOf(env: EngineEnv, s: Settings): string | null {
  if (s.crm_app_id !== null) return s.crm_app_id.trim() || null;
  return env.CRM_APP_ID?.trim() || null;
}

interface Ctx {
  env: EngineEnv;
  s: Settings;
  now: Date;
  deadline: number;
  /** The sending mailbox, opened once per run. */
  mail: Mail | null;
  mailError: string | null;
  done: { sent: number; drafted: number; replies: number; meetings: number };
  more: boolean;
}

async function openMail(ctx: Ctx): Promise<Mail | null> {
  if (ctx.mail || ctx.mailError) return ctx.mail;
  if (!ctx.s.mailbox) {
    ctx.mailError = "Pick the mailbox to send from in Settings";
    return null;
  }
  try {
    ctx.mail = await mailFor(ctx.env, ctx.s.mailbox);
  } catch (e) {
    ctx.mailError = (e as Error).message;
  }
  return ctx.mail;
}

// ── The CRM ────────────────────────────────────────────────────────

/** A line on the person's CRM timeline. Best effort: a CRM that can't be
 *  reached never holds up a send or a stop; the failure shows in Settings. */
async function crmLog(ctx: Ctx, person: Person, type: "email" | "note", text: string): Promise<void> {
  const appId = crmAppOf(ctx.env, ctx.s);
  if (!appId) return;
  try {
    let contactId = person.crm_contact_id;
    if (!contactId) {
      contactId = await crmContactFor(ctx.env, appId, person);
      await run("UPDATE people SET crm_contact_id = ? WHERE id = ?", [contactId, person.id]);
      person.crm_contact_id = contactId;
    }
    await crmNote(ctx.env, appId, contactId, type, text);
    if (ctx.s.crm_error) {
      await run("UPDATE settings SET crm_error = NULL WHERE id = 1");
      ctx.s.crm_error = null;
    }
  } catch (e) {
    const msg = `${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC: ${(e as Error).message}`.slice(0, 300);
    await run("UPDATE settings SET crm_error = ? WHERE id = 1", [msg]);
    ctx.s.crm_error = msg;
  }
}

async function campaignName(id: string): Promise<string> {
  return (await get<{ name: string }>("SELECT name FROM campaigns WHERE id = ?", [id]))?.name ?? "a campaign";
}

// ── What came back ─────────────────────────────────────────────────

/**
 * Records one message someone sent back on an enrollment's thread, and acts
 * on it once: a reply stops the person (and their company, where the campaign
 * says so), an automatic answer pauses them, a bounce stops them for good.
 * The AI reads replies afterwards; nothing here waits on it.
 */
async function recordInbound(ctx: Ctx, e: Enrollment, m: GmailMessage, kindOverride?: "bounce"): Promise<void> {
  if (!m.messageId) return;
  const kind = kindOverride ?? inboundKind(m);
  const receivedAt = m.messageTimestamp && !Number.isNaN(Date.parse(m.messageTimestamp)) ? new Date(m.messageTimestamp).toISOString() : ctx.now.toISOString();
  const inserted = await query<{ message_id: string }>(
    `INSERT INTO inbound (message_id, thread_id, enrollment_id, person_id, kind, excerpt, from_email, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (message_id) DO NOTHING RETURNING message_id`,
    [m.messageId, m.threadId ?? e.thread_id ?? "", e.id, e.person_id, kind, kind === "bounce" ? "" : ownWords(m.messageText ?? m.preview?.body), addressOf(m.sender), receivedAt],
  );
  if (!inserted.length) return;
  const person = await get<Person>("SELECT * FROM people WHERE id = ?", [e.person_id]);
  if (!person) return;
  const campaign = await campaignName(e.campaign_id);
  ctx.done.replies++;

  if (kind === "bounce") {
    await run("UPDATE people SET bounced_at = COALESCE(bounced_at, ?), updated_at = datetime('now') WHERE id = ?", [receivedAt, person.id]);
    await run(
      "UPDATE enrollments SET status = 'bounced', reason = 'The address bounced', due_at = NULL, paused_until = NULL, updated_at = datetime('now') WHERE id = ? AND status NOT IN ('meeting', 'unsubscribed')",
      [e.id],
    );
    await skipOpenTouches([e.id], "The address bounced");
    const others = await query<{ id: string }>("SELECT id FROM enrollments WHERE person_id = ? AND id != ? AND status IN ('active', 'paused')", [person.id, e.id]);
    await endEnrollments(others.map((r) => r.id), "bounced", "The address bounced");
    return;
  }

  if (kind === "auto") {
    // Out of office: wait, then carry on. Only a live enrollment pauses.
    await run(
      "UPDATE enrollments SET status = 'paused', paused_until = ?, reason = 'Out of office', updated_at = datetime('now') WHERE id = ? AND status = 'active'",
      [new Date(ctx.now.getTime() + AUTO_PAUSE_MS).toISOString(), e.id],
    );
    return;
  }

  const changed = await query<{ id: string }>(
    `UPDATE enrollments SET status = 'replied', reason = ?, due_at = NULL, paused_until = NULL, updated_at = datetime('now')
      WHERE id = ? AND status IN ('active', 'paused', 'finished', 'stopped') RETURNING id`,
    [`Replied on ${receivedAt.slice(0, 10)}`, e.id],
  );
  await skipOpenTouches([e.id], "They replied");
  await stopAround(person, e.id, {
    person: `Replied to ${campaign}`,
    company: `${personName(person)} at ${person.domain} replied to ${campaign}`,
  });
  if (changed.length) await crmLog(ctx, person, "email", `Replied to the "${campaign}" sequence.`);
}

/** Enrollments that own any of these threads, whatever their status: a late reply still counts. */
async function enrollmentsByThread(threadIds: string[]): Promise<Map<string, Enrollment>> {
  const out = new Map<string, Enrollment>();
  for (const chunk of parts([...new Set(threadIds)])) {
    const rows = await query<Enrollment>(`SELECT * FROM enrollments WHERE thread_id IN (${inList(chunk.length)})`, chunk);
    for (const r of rows) if (r.thread_id) out.set(r.thread_id, r);
  }
  return out;
}

async function knownInbound(ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const chunk of parts(ids)) {
    const rows = await query<{ message_id: string }>(`SELECT message_id FROM inbound WHERE message_id IN (${inList(chunk.length)})`, chunk);
    for (const r of rows) out.add(r.message_id);
  }
  return out;
}

const BOUNCERS = /^(mailer-daemon|postmaster)@/;

/** A bounce Gmail filed outside the thread: the enrollments whose address it names. */
async function bouncedEnrollments(m: GmailMessage): Promise<Enrollment[]> {
  const named = addressesIn(`${m.messageText ?? ""} ${m.preview?.body ?? ""}`).filter((a) => !BOUNCERS.test(a));
  if (!named.length) return [];
  const out: Enrollment[] = [];
  for (const chunk of parts(named.slice(0, 50))) {
    out.push(...await query<Enrollment>(
      `SELECT e.* FROM enrollments e JOIN people p ON p.id = e.person_id
        WHERE p.email IN (${inList(chunk.length)}) AND e.thread_id IS NOT NULL AND e.status IN ('active', 'paused', 'finished')`,
      chunk,
    ));
  }
  return out;
}

async function handleFound(ctx: Ctx, mail: Mail, found: GmailMessage[]): Promise<void> {
  const theirs = found.filter((m) => m.messageId && m.threadId && isInbound(m, mail.address));
  const known = await knownInbound(theirs.map((m) => m.messageId!));
  const fresh = theirs.filter((m) => !known.has(m.messageId!));
  if (!fresh.length) return;
  const byThread = await enrollmentsByThread(fresh.map((m) => m.threadId!));
  for (const m of fresh) {
    if (Date.now() > ctx.deadline) {
      ctx.more = true;
      return;
    }
    const e = byThread.get(m.threadId!);
    if (e) {
      await recordInbound(ctx, e, await readMessage(mail, m.messageId!));
    } else if (BOUNCERS.test(addressOf(m.sender))) {
      const full = await readMessage(mail, m.messageId!);
      for (const b of await bouncedEnrollments(full)) await recordInbound(ctx, b, { ...full, messageId: full.messageId ?? m.messageId }, "bounce");
    }
  }
}

interface InboxCursor {
  after: number;
  page: string;
  started: string;
}

/** Received mail since the last read, a few pages per run; a read that doesn't
 *  finish carries on from its page next run. */
async function checkInbox(ctx: Ctx, force: boolean): Promise<void> {
  const s = ctx.s;
  let cursor: InboxCursor | null = null;
  try {
    cursor = s.inbox_cursor ? (JSON.parse(s.inbox_cursor) as InboxCursor) : null;
  } catch {
    cursor = null;
  }
  if (!s.inbox_checked_at && !cursor) {
    // Nothing went out before the first run: start reading from here.
    await run("UPDATE settings SET inbox_checked_at = ? WHERE id = 1", [ctx.now.toISOString()]);
    return;
  }
  const last = s.inbox_checked_at ? Date.parse(s.inbox_checked_at) : ctx.now.getTime();
  if (!cursor && !force && ctx.now.getTime() - last < INBOX_INTERVAL_MS) return;
  const mail = await openMail(ctx);
  if (!mail) return;
  const after = cursor?.after ?? Math.floor((last - INBOX_OVERLAP_MS) / 1000);
  const started = cursor?.started ?? ctx.now.toISOString();
  const q = `-in:sent -in:chats -in:drafts after:${after}`;
  let page: string | null = cursor?.page ?? null;
  for (let i = 0; i < INBOX_PAGES; i++) {
    if (Date.now() > ctx.deadline) break;
    const { messages, next } = await searchMail(mail, q, page);
    await handleFound(ctx, mail, messages);
    page = next;
    if (!page) break;
  }
  if (page) {
    ctx.more = true;
    await run("UPDATE settings SET inbox_cursor = ? WHERE id = 1", [JSON.stringify({ after, page, started } satisfies InboxCursor)]);
  } else {
    await run("UPDATE settings SET inbox_cursor = NULL, inbox_checked_at = ? WHERE id = 1", [started]);
  }
}

/** New replies go to the AI, a few per run: what they want, in a line. */
async function readReplies(ctx: Ctx): Promise<void> {
  const rows = await query<{ message_id: string; kind: string; excerpt: string; enrollment_id: string | null; person_id: string | null }>(
    `SELECT message_id, kind, excerpt, enrollment_id, person_id FROM inbound
      WHERE intent IS NULL AND kind IN ('reply', 'auto') AND read_attempts < ? ORDER BY received_at LIMIT ?`,
    [MAX_ATTEMPTS, READS_PER_RUN + 1],
  );
  for (const [i, r] of rows.entries()) {
    if (i >= READS_PER_RUN || Date.now() > ctx.deadline) {
      ctx.more = true;
      return;
    }
    let reading;
    try {
      reading = coerceReading(await complete(ctx.env, readingPrompt(), r.excerpt || "(empty message)", { timeoutMs: 15_000, maxTokens: 200 }));
    } catch (e) {
      await run("UPDATE inbound SET read_attempts = read_attempts + 1 WHERE message_id = ?", [r.message_id]);
      if (e instanceof ModelError && e.outOfCredits) return;
      continue;
    }
    if (!reading) {
      await run("UPDATE inbound SET read_attempts = read_attempts + 1 WHERE message_id = ?", [r.message_id]);
      continue;
    }
    await run("UPDATE inbound SET intent = ?, summary = ? WHERE message_id = ?", [reading.intent, reading.summary, r.message_id]);
    if (reading.intent === "unsubscribe" && r.person_id) await unsubscribe(r.person_id, "Asked not to be emailed");
    if (r.kind === "auto" && reading.return_date && r.enrollment_id) {
      // Back on that day: resume the morning after, so the first thing they read isn't us.
      const resume = new Date(Date.parse(`${reading.return_date}T00:00:00Z`) + DAY_MS).toISOString();
      await run(
        "UPDATE enrollments SET paused_until = ?, reason = ? WHERE id = ? AND status = 'paused' AND reason = 'Out of office'",
        [resume, `Out of office until ${reading.return_date}`, r.enrollment_id],
      );
    }
  }
}

// ── Booked meetings ────────────────────────────────────────────────

async function checkCalendar(ctx: Ctx, force: boolean): Promise<void> {
  const last = ctx.s.calendar_checked_at ? Date.parse(ctx.s.calendar_checked_at) : 0;
  if (!force && ctx.now.getTime() - last < CALENDAR_INTERVAL_MS) return;
  const cal = await calendarRun(ctx.env).catch(() => null);
  await run("UPDATE settings SET calendar_checked_at = ? WHERE id = 1", [ctx.now.toISOString()]);
  if (!cal) return;
  const from = new Date(ctx.now.getTime() - DAY_MS).toISOString();
  const to = new Date(ctx.now.getTime() + CALENDAR_AHEAD_MS).toISOString();
  const guests = new Map<string, string>(); // address → when
  let page: string | null = null;
  for (let i = 0; i < 3; i++) {
    const res = await calendarPage(cal, from, to, page);
    for (const ev of res.items) {
      const when = ev.start?.dateTime ?? ev.start?.date ?? "";
      for (const g of bookedWith(ev)) if (!guests.has(g)) guests.set(g, when);
    }
    page = res.next;
    if (!page || Date.now() > ctx.deadline) break;
  }
  if (!guests.size) return;
  const ownDomain = ctx.s.mailbox ? emailDomain(ctx.s.mailbox) : "";
  const matched = new Set<string>();
  for (const chunk of parts([...guests.keys()])) {
    const rows = await query<Enrollment & { email: string }>(
      `SELECT e.*, p.email FROM enrollments e JOIN people p ON p.id = e.person_id
        WHERE p.email IN (${inList(chunk.length)}) AND e.status IN ('active', 'paused', 'finished', 'replied', 'stopped')`,
      chunk,
    );
    for (const e of rows) {
      matched.add(e.email);
      const when = (guests.get(e.email) ?? "").slice(0, 10);
      const changed = await query<{ id: string }>(
        `UPDATE enrollments SET status = 'meeting', reason = ?, due_at = NULL, paused_until = NULL, updated_at = datetime('now')
          WHERE id = ? AND status != 'meeting' RETURNING id`,
        [when ? `Meeting booked for ${when}` : "Meeting booked", e.id],
      );
      if (!changed.length) continue;
      ctx.done.meetings++;
      await skipOpenTouches([e.id], "A meeting is booked");
      const person = await get<Person>("SELECT * FROM people WHERE id = ?", [e.person_id]);
      if (!person) continue;
      const campaign = await campaignName(e.campaign_id);
      await stopAround(person, e.id, {
        person: `Meeting booked (${campaign})`,
        company: `${personName(person)} at ${person.domain} booked a meeting`,
      });
      await crmLog(ctx, person, "note", `Booked a meeting${when ? ` for ${when}` : ""} after the "${campaign}" sequence.`);
    }
  }
  // A colleague booked instead: everyone at that company stops where the campaign says so.
  for (const [guest, when] of guests) {
    if (matched.has(guest)) continue;
    const domain = companyDomain(guest, isPersonal);
    if (!domain || domain === ownDomain) continue;
    await stopCompany(domain, null, `${guest} booked a meeting${when ? ` for ${when.slice(0, 10)}` : ""}`);
  }
}

// ── Moving forward ─────────────────────────────────────────────────

async function resumePaused(now: Date): Promise<void> {
  await run(
    `UPDATE enrollments SET status = 'active', reason = NULL, paused_until = NULL,
       due_at = CASE WHEN due_at IS NULL OR due_at < ? THEN ? ELSE due_at END, updated_at = datetime('now')
      WHERE status = 'paused' AND paused_until IS NOT NULL AND paused_until <= ?`,
    [now.toISOString(), now.toISOString(), now.toISOString()],
  );
}

/** Steps due soon become touches, up to about two days of sending in the queue. */
async function prepare(ctx: Ctx, cap: number): Promise<void> {
  const open = (await get<{ n: number }>(`SELECT COUNT(*) AS n FROM touches WHERE status IN ('research', 'drafting', 'review', 'approved')`))?.n ?? 0;
  const budget = prepareBudget(open, cap);
  if (!budget) return;
  const due = await query<{ id: string; step: number; step_id: string; channel: string; writer: string }>(
    `SELECT e.id, e.step, s.id AS step_id, s.channel, s.writer
       FROM enrollments e
       JOIN campaigns c ON c.id = e.campaign_id AND c.status = 'active'
       JOIN steps s ON s.campaign_id = e.campaign_id AND s.position = e.step
      WHERE e.status = 'active' AND e.due_at IS NOT NULL AND e.due_at <= ?
        AND NOT EXISTS (SELECT 1 FROM touches t WHERE t.enrollment_id = e.id AND t.position = e.step AND t.status NOT IN ('skipped', 'failed'))
      ORDER BY e.due_at LIMIT ?`,
    [new Date(ctx.now.getTime() + PREPARE_AHEAD_MS).toISOString(), budget],
  );
  for (const d of due) {
    const status = d.channel !== "email" ? "todo" : d.writer === "research" ? "research" : "drafting";
    await run(
      "INSERT INTO touches (id, enrollment_id, step_id, position, channel, status) VALUES (?, ?, ?, ?, ?, ?)",
      [crypto.randomUUID(), d.id, d.step_id, d.step, d.channel, status],
    );
  }
}

/** The emails already sent to an enrollment, oldest first, as their writer knew them. */
export async function sentOn(enrollmentId: string): Promise<Array<{ subject: string | null; body: string; sent_at: string }>> {
  return query(
    "SELECT subject, COALESCE(body, '') AS body, sent_at FROM touches WHERE enrollment_id = ? AND status = 'sent' ORDER BY position, sent_at",
    [enrollmentId],
  );
}

async function draftNext(ctx: Ctx): Promise<void> {
  const rows = await query<Touch & { campaign_id: string; person_id: string; thread_id: string | null; total: number }>(
    `SELECT t.*, e.campaign_id, e.person_id, e.thread_id,
            (SELECT COUNT(*) FROM steps s WHERE s.campaign_id = e.campaign_id) AS total
       FROM touches t JOIN enrollments e ON e.id = t.enrollment_id
      WHERE t.status = 'drafting' AND t.attempts < ? AND e.status = 'active'
      ORDER BY e.due_at, t.created_at LIMIT ?`,
    [MAX_ATTEMPTS, DRAFTS_PER_RUN + 1],
  );
  for (const [i, t] of rows.entries()) {
    if (i >= DRAFTS_PER_RUN || Date.now() > ctx.deadline) {
      ctx.more = true;
      return;
    }
    const campaign = await get<{ name: string; angle: string }>("SELECT name, angle FROM campaigns WHERE id = ?", [t.campaign_id]);
    const step = t.step_id ? await get<{ instructions: string }>("SELECT instructions FROM steps WHERE id = ?", [t.step_id]) : undefined;
    const person = await get<Person>("SELECT * FROM people WHERE id = ?", [t.person_id]);
    if (!campaign || !person) continue;
    const sent = await sentOn(t.enrollment_id);
    const needsSubject = !t.thread_id && !sent.length;
    const prompt = draftPrompt({
      about: ctx.s.about,
      campaign,
      step: { position: t.position, total: t.total, instructions: step?.instructions ?? "" },
      person,
      sent,
      review_note: t.review_note,
      needsSubject,
    });
    try {
      const draft = coerceDraft(await complete(ctx.env, prompt.system, prompt.user, { timeoutMs: 20_000, maxTokens: 900 }), needsSubject);
      if (!draft) throw new Error("The AI's draft wasn't usable (no body, no subject, or a placeholder left in)");
      await run(
        `UPDATE touches SET status = 'review', draft_subject = ?, draft_body = ?, subject = ?, body = ?, rationale = ?,
           written_by = 'ai', error = NULL, updated_at = datetime('now') WHERE id = ? AND status = 'drafting'`,
        [draft.subject, draft.body, draft.subject, draft.body, draft.rationale, t.id],
      );
      ctx.done.drafted++;
    } catch (e) {
      const out = e instanceof ModelError && e.outOfCredits;
      await run(
        "UPDATE touches SET attempts = attempts + ?, error = ?, updated_at = datetime('now') WHERE id = ?",
        [out ? 0 : 1, out ? "Out of Clawnify credits: the draft waits" : (e as Error).message.slice(0, 300), t.id],
      );
      if (out) return;
    }
  }
}

// ── Sending ────────────────────────────────────────────────────────

async function markSent(ctx: Ctx, t: Touch, e: Enrollment, sent: { messageId: string; threadId: string }, at: Date, out: { subject: string | null; body: string }): Promise<void> {
  const iso = at.toISOString();
  await run(
    `UPDATE touches SET status = 'sent', sent_subject = ?, sent_body = ?, message_id = ?, sent_at = ?, error = NULL, updated_at = datetime('now')
      WHERE id = ?`,
    [out.subject, out.body, sent.messageId, iso, t.id],
  );
  await run(
    "UPDATE enrollments SET thread_id = COALESCE(thread_id, ?), mailbox = COALESCE(mailbox, ?), last_sent_at = ?, updated_at = datetime('now') WHERE id = ?",
    [sent.threadId, ctx.s.mailbox, iso, e.id],
  );
  await run("UPDATE settings SET last_sent_at = ? WHERE id = 1", [iso]);
  ctx.s.last_sent_at = iso;
  await advance(e.id, t.position, at);
  ctx.done.sent++;
  const person = await get<Person>("SELECT * FROM people WHERE id = ?", [e.person_id]);
  if (person) {
    const campaign = await campaignName(e.campaign_id);
    await crmLog(ctx, person, "email", e.thread_id
      ? `Follow-up ${t.position} sent in the "${campaign}" sequence.`
      : `Sent "${out.subject ?? ""}" (the "${campaign}" sequence, from ${ctx.s.mailbox}).`);
  }
}

/**
 * A send a run handed to Gmail and never recorded: looked up before anything
 * else goes out, so an email is never sent twice. Found in Gmail: recorded as
 * sent. Not found: approved again, and the next send retries it.
 */
async function settle(ctx: Ctx): Promise<void> {
  const stuck = await query<Touch>(
    "SELECT * FROM touches WHERE status = 'sending' AND sending_at < ? ORDER BY sending_at LIMIT 5",
    [new Date(ctx.now.getTime() - SETTLE_AFTER_MS).toISOString()],
  );
  if (!stuck.length) return;
  const mail = await openMail(ctx);
  if (!mail) return;
  for (const t of stuck) {
    const e = await get<Enrollment>("SELECT * FROM enrollments WHERE id = ?", [t.enrollment_id]);
    const person = e ? await get<Person>("SELECT * FROM people WHERE id = ?", [e.person_id]) : undefined;
    if (!e || !person) continue;
    const since = Date.parse(t.sending_at!) - MINUTE_MS;
    let found: GmailMessage | undefined;
    if (e.thread_id) {
      const known = new Set((await query<{ message_id: string }>("SELECT message_id FROM touches WHERE enrollment_id = ? AND message_id IS NOT NULL", [e.id])).map((r) => r.message_id));
      found = (await readThread(mail, e.thread_id)).find((m) =>
        (m.labelIds ?? []).includes("SENT") && m.messageId && !known.has(m.messageId) && Date.parse(m.messageTimestamp ?? "") >= since);
    } else {
      const res = await searchMail(mail, `in:sent to:${person.email} after:${Math.floor(since / 1000)}`, null, 10);
      found = res.messages.find((m) => (m.subject ?? "").trim() === (t.sent_subject ?? t.subject ?? "").trim());
    }
    if (found?.messageId && found.threadId) {
      await markSent(ctx, t, e, { messageId: found.messageId, threadId: found.threadId }, new Date(Date.parse(found.messageTimestamp ?? "") || Date.parse(t.sending_at!)), {
        subject: t.sent_subject, body: t.sent_body ?? "",
      });
    } else {
      const failed = t.attempts + 1 >= MAX_ATTEMPTS;
      await run(
        "UPDATE touches SET status = ?, attempts = attempts + 1, sending_at = NULL, updated_at = datetime('now') WHERE id = ?",
        [failed ? "failed" : "approved", t.id],
      );
      if (failed) {
        await run(
          "UPDATE enrollments SET status = 'paused', paused_until = NULL, reason = ? WHERE id = ? AND status = 'active'",
          [`Sending failed: ${t.error ?? "Gmail didn't take it"}`.slice(0, 300), e.id],
        );
      }
    }
  }
}

async function sendNext(ctx: Ctx, cap: number): Promise<Date | null> {
  const w = windowOf(ctx.s);
  const sentToday = (await get<{ n: number }>("SELECT COUNT(*) AS n FROM touches WHERE status = 'sent' AND sent_at >= ?", [dayStart(ctx.now, w.timezone).toISOString()]))?.n ?? 0;
  const ready = await get<Touch & { campaign_id: string; person_id: string; thread_id: string | null; email: string }>(
    `SELECT t.*, e.campaign_id, e.person_id, e.thread_id, p.email
       FROM touches t
       JOIN enrollments e ON e.id = t.enrollment_id AND e.status = 'active' AND e.step = t.position
       JOIN campaigns c ON c.id = e.campaign_id AND c.status = 'active'
       JOIN people p ON p.id = e.person_id AND p.unsubscribed_at IS NULL AND p.bounced_at IS NULL
      WHERE t.status = 'approved' AND t.channel = 'email' AND e.due_at <= ?
      ORDER BY e.due_at, t.approved_at LIMIT 1`,
    [ctx.now.toISOString()],
  );
  if (!ready) return null;
  const when = nextSendAt(ctx.now, w, cap, { sentToday, lastSentAt: ctx.s.last_sent_at });
  if (when.getTime() > ctx.now.getTime()) return when;
  const mail = await openMail(ctx);
  if (!mail) return null;
  const e = (await get<Enrollment>("SELECT * FROM enrollments WHERE id = ?", [ready.enrollment_id]))!;

  // A thread lives in the mailbox that started it: another mailbox can't reply in it.
  if (e.thread_id && e.mailbox && e.mailbox !== mail.address) {
    await run(
      "UPDATE enrollments SET status = 'paused', paused_until = NULL, reason = ?, updated_at = datetime('now') WHERE id = ? AND status = 'active'",
      [`This thread was started from ${e.mailbox}: send from it again in Settings to carry on`, e.id],
    );
    return ctx.now;
  }

  // A follow-up: read the thread once more, in case they wrote back since the last check.
  if (e.thread_id) {
    const thread = await readThread(mail, e.thread_id);
    const theirs = thread.filter((m) => m.messageId && isInbound(m, mail.address));
    const known = await knownInbound(theirs.map((m) => m.messageId!));
    const fresh = theirs.filter((m) => !known.has(m.messageId!));
    if (fresh.length) {
      for (const m of fresh) await recordInbound(ctx, e, m);
      return ctx.now; // something else may be ready
    }
  }

  const subject = e.thread_id ? null : (ready.subject ?? "").trim();
  if (!e.thread_id && !subject) {
    await run("UPDATE touches SET status = 'review', error = 'The first email needs a subject' WHERE id = ?", [ready.id]);
    return ctx.now;
  }
  const body = composeBody(ready.body ?? "", ctx.s.signature, ctx.s.opt_out);
  const claimed = await query<{ id: string }>(
    `UPDATE touches SET status = 'sending', sending_at = ?, sent_subject = ?, sent_body = ?, updated_at = datetime('now')
      WHERE id = ? AND status = 'approved' RETURNING id`,
    [ctx.now.toISOString(), subject, body, ready.id],
  );
  if (!claimed.length) return ctx.now;
  try {
    const sent = e.thread_id
      ? await sendReply(mail, ready.email, e.thread_id, body)
      : await sendNew(mail, ready.email, subject!, body);
    await markSent(ctx, ready, e, sent, new Date(), { subject, body });
  } catch (err) {
    // Gmail may still have taken it: the touch stays 'sending' and is looked up before anything else goes out.
    await run("UPDATE touches SET error = ? WHERE id = ?", [(err as Error).message.slice(0, 300), ready.id]);
    throw err;
  }
  return ctx.now;
}

// ── The run ────────────────────────────────────────────────────────

async function claim(now: Date): Promise<boolean> {
  await getSettings();
  const rows = await query<{ id: number }>(
    "UPDATE settings SET running_until = ? WHERE id = 1 AND (running_until IS NULL OR running_until < ?) RETURNING id",
    [new Date(now.getTime() + LEASE_MS).toISOString(), now.toISOString()],
  );
  return rows.length === 1;
}

export interface RunResult {
  status: "ran" | "busy" | "error";
  sent: number;
  drafted: number;
  replies: number;
  meetings: number;
  /** Work is left that the next run should start on at once. */
  more: boolean;
  /** When the next run should happen, or null when nothing needs one. */
  next: string | null;
  error?: string;
}

/** Whether anything still needs the run: a live campaign, or replies that could still come in. */
async function hasWork(now: Date): Promise<boolean> {
  const live = await get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM enrollments e JOIN campaigns c ON c.id = e.campaign_id
      WHERE c.status = 'active' AND e.status IN ('active', 'paused')`,
  );
  if (live?.n) return true;
  const recent = await get<{ n: number }>("SELECT COUNT(*) AS n FROM touches WHERE status IN ('sent', 'sending') AND (sent_at IS NULL OR sent_at >= ?)", [
    new Date(now.getTime() - LATE_REPLY_MS).toISOString(),
  ]);
  return !!recent?.n;
}

export async function runOnce(env: EngineEnv, now = new Date(), opts: { force?: boolean } = {}): Promise<RunResult> {
  const result: RunResult = { status: "ran", sent: 0, drafted: 0, replies: 0, meetings: 0, more: false, next: null };
  if (!(await claim(now))) return { ...result, status: "busy" };
  const s = await getSettings();
  // The job being delivered (or an older one) is spent: the next booking is this run's to make.
  if (s.next_run_at && Date.parse(s.next_run_at) <= now.getTime() + MINUTE_MS) {
    await run("UPDATE settings SET job_id = NULL, next_run_at = NULL WHERE id = 1");
    s.job_id = null;
    s.next_run_at = null;
  }
  const ctx: Ctx = {
    env, s, now, deadline: Date.now() + RUN_BUDGET_MS, mail: null, mailError: null,
    done: { sent: 0, drafted: 0, replies: 0, meetings: 0 }, more: false,
  };
  const cap = dailyCap(s.daily_cap, s.ramp_from, localDay(now, s.timezone));
  let sendAt: Date | null = null;
  let error: string | null = null;
  try {
    await settle(ctx);
    await checkInbox(ctx, !!opts.force);
    await readReplies(ctx);
    await checkCalendar(ctx, !!opts.force);
    await resumePaused(now);
    await prepare(ctx, cap);
    await draftNext(ctx);
    if (Date.now() < ctx.deadline) sendAt = await sendNext(ctx, cap);
    else ctx.more = true;
  } catch (e) {
    error = (e as Error).message.slice(0, 500);
  }
  if (!error && ctx.mailError && (await hasMailWork())) error = ctx.mailError;

  let next: Date | null = null;
  if (await hasWork(now)) {
    const soon = ctx.more || (sendAt && sendAt.getTime() <= now.getTime()) ? now : null;
    const check = new Date(now.getTime() + (error ? 10 * MINUTE_MS : INBOX_INTERVAL_MS));
    next = soon ?? (sendAt && sendAt < check ? sendAt : check);
  }
  await run(
    "UPDATE settings SET running_until = NULL, last_run_at = ?, last_error = ? WHERE id = 1",
    [now.toISOString(), error],
  );
  return {
    ...result,
    ...ctx.done,
    status: error ? "error" : "ran",
    more: ctx.more,
    next: next ? next.toISOString() : null,
    ...(error ? { error } : {}),
  };
}

/** Whether the missing mailbox is holding anything up: an approved email, or a thread to read. */
async function hasMailWork(): Promise<boolean> {
  const n = await get<{ n: number }>(
    `SELECT (SELECT COUNT(*) FROM touches WHERE status IN ('approved', 'sending'))
          + (SELECT COUNT(*) FROM enrollments WHERE thread_id IS NOT NULL AND status IN ('active', 'paused')) AS n`,
  );
  return !!n?.n;
}

// ── Booking runs ───────────────────────────────────────────────────

type QueueEnv = { CLAWNIFY_TOKEN?: string; CLAWNIFY_QUEUE_URL?: string };

/**
 * Books a run on the platform queue for `when` (never the current minute, see
 * bookableAt). One run stays booked: an earlier booking is kept, a later one is
 * replaced. A missing queue (local dev, an outage) is not an error: the next
 * page load books again.
 */
export async function scheduleRun(env: QueueEnv, origin: string, when: Date, now = new Date()): Promise<void> {
  const runAt = bookableAt(when, now);
  const s = await getSettings();
  const booked = s.next_run_at ? Date.parse(s.next_run_at) : NaN;
  if (!Number.isNaN(booked) && booked <= runAt.getTime() && booked > now.getTime() - 5 * MINUTE_MS) return;
  try {
    const { enqueueJob, cancelJob } = await import("@clawnify/queue");
    if (s.job_id) await cancelJob(env, s.job_id).catch(() => undefined);
    const job = await enqueueJob(env, {
      targetUrl: `${origin}/api/run`,
      payload: {},
      runAt,
      idempotencyKey: `sequence-${new URL(origin).host}-${runAt.toISOString().slice(0, 16)}`,
      maxAttempts: 3,
    });
    await run("UPDATE settings SET job_id = ?, next_run_at = ? WHERE id = 1", [job.id, runAt.toISOString()]);
  } catch {
    /* no queue here: ensureScheduled books it on the next page load */
  }
}

/** Books a run when there is work and none is coming, or the booked one is long overdue. */
export async function ensureScheduled(env: QueueEnv, origin: string, now = new Date()): Promise<void> {
  const s = await getSettings();
  const overdue = !s.next_run_at || Date.parse(s.next_run_at) < now.getTime() - 5 * MINUTE_MS;
  if (overdue && (await hasWork(now))) await scheduleRun(env, origin, now, now);
}

/** One run, then the next booked from what it found. */
export async function runAndBook(env: EngineEnv, origin: string, opts: { force?: boolean } = {}): Promise<RunResult> {
  const result = await runOnce(env, new Date(), opts);
  if (result.status !== "busy" && result.next) await scheduleRun(env, origin, new Date(result.next));
  return result;
}

export { stepsOf, OPEN_SQL };
