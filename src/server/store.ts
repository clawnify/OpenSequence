// The records and the moves on them that both the API and the run make:
// settings, people, putting people in a campaign, moving them to the next
// step, and stopping them. The run itself is engine.ts.

import freemailDomains from "free-email-domains";
import { get, query, run } from "./db.js";
import { companyDomain, isEmail, nextStep, dueAfter, normaliseEmail } from "./sequence-rules.js";

// ── Rows ───────────────────────────────────────────────────────────

export interface Settings {
  id: number;
  about: string;
  mailbox: string | null;
  /** Before named signatures: moved into `signatures` on first read. */
  signature: string;
  signature_id: string | null;
  reply_signature_id: string | null;
  opt_out: string;
  daily_cap: number;
  ramp_from: string | null;
  send_from: string;
  send_until: string;
  timezone: string;
  weekdays_only: number;
  crm_app_id: string | null;
  crm_error: string | null;
  research_agent_id: string | null;
  research_agent_name: string | null;
  research_error: string | null;
  running_until: string | null;
  job_id: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  last_error: string | null;
  last_sent_at: string | null;
  inbox_checked_at: string | null;
  inbox_cursor: string | null;
  calendar_checked_at: string | null;
}

export interface Campaign {
  id: string;
  name: string;
  angle: string;
  status: "draft" | "active" | "paused" | "archived";
  stop_company: number;
  /** null: the workspace default; "none": no signature; else a signature's id. */
  signature_id: string | null;
  reply_signature_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface Step {
  id: string;
  campaign_id: string;
  position: number;
  wait_days: number;
  channel: "email" | "call" | "linkedin" | "task";
  writer: "research" | "thread";
  instructions: string;
}

export interface Person {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  title: string;
  company: string;
  domain: string;
  linkedin_url: string;
  phone: string;
  notes: string;
  source: string;
  crm_contact_id: string | null;
  unsubscribed_at: string | null;
  bounced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Enrollment {
  id: string;
  campaign_id: string;
  person_id: string;
  status: "active" | "paused" | "replied" | "meeting" | "bounced" | "unsubscribed" | "stopped" | "finished";
  step: number;
  due_at: string | null;
  thread_id: string | null;
  mailbox: string | null;
  last_sent_at: string | null;
  paused_until: string | null;
  reason: string | null;
  enrolled_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface Touch {
  id: string;
  enrollment_id: string;
  step_id: string | null;
  position: number;
  channel: Step["channel"];
  status: "research" | "drafting" | "review" | "approved" | "sending" | "sent" | "todo" | "done" | "skipped" | "failed";
  draft_subject: string | null;
  draft_body: string | null;
  subject: string | null;
  body: string | null;
  sent_subject: string | null;
  sent_body: string | null;
  sources: string;
  rationale: string | null;
  written_by: string | null;
  review_note: string | null;
  research_sent_at: string | null;
  research_agent_id: string | null;
  research_tries: number;
  research_task_id: string | null;
  attempts: number;
  message_id: string | null;
  error: string | null;
  approved_by: string | null;
  approved_at: string | null;
  sending_at: string | null;
  sent_at: string | null;
  done_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Touches still waiting on someone: a writer, a reviewer, the send, a person's task. */
export const OPEN_TOUCH = ["research", "drafting", "review", "approved", "todo"] as const;
/** Enrollments that can still receive something. */
export const LIVE = ["active", "paused"] as const;

const inList = (n: number) => Array.from({ length: n }, () => "?").join(", ");
const OPEN_SQL = OPEN_TOUCH.map((s) => `'${s}'`).join(", ");

/** D1 caps a statement at 100 bound parameters: fan-outs go in parts. */
export function parts<T>(items: T[], size = 90): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export const nowIso = () => new Date().toISOString();

// ── Settings ───────────────────────────────────────────────────────

export async function getSettings(): Promise<Settings> {
  await run("INSERT OR IGNORE INTO settings (id) VALUES (1)");
  const s = (await get<Settings>("SELECT * FROM settings WHERE id = 1"))!;
  // Before named signatures there was one: it becomes "Signature", the default
  // for first emails and follow-ups. Only the request that clears the old
  // field creates it, so two at once can't make two.
  if (s.signature.trim() && !s.signature_id) {
    const id = crypto.randomUUID();
    const moved = await run(
      "UPDATE settings SET signature_id = ?, reply_signature_id = COALESCE(reply_signature_id, ?), signature = '' WHERE id = 1 AND signature = ? AND signature_id IS NULL",
      [id, id, s.signature],
    );
    if (moved.changes === 1) await run("INSERT INTO signatures (id, name, body) VALUES (?, 'Signature', ?)", [id, s.signature]);
    return (await get<Settings>("SELECT * FROM settings WHERE id = 1"))!;
  }
  return s;
}

const EDITABLE = [
  "about", "mailbox", "signature_id", "reply_signature_id", "opt_out", "daily_cap", "ramp_from", "send_from", "send_until",
  "timezone", "weekdays_only", "crm_app_id", "research_agent_id", "research_agent_name",
] as const;
export type SettingsPatch = Partial<Pick<Settings, (typeof EDITABLE)[number]>>;

export async function saveSettings(patch: SettingsPatch): Promise<Settings> {
  await getSettings();
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const key of EDITABLE) {
    if (patch[key] === undefined) continue;
    sets.push(`${key} = ?`);
    params.push(patch[key]);
  }
  if (sets.length) await run(`UPDATE settings SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = 1`, params);
  return getSettings();
}

// ── Signatures ─────────────────────────────────────────────────────

export interface Signature {
  id: string;
  name: string;
  body: string;
  created_at: string;
  updated_at: string;
}

export async function listSignatures(): Promise<Signature[]> {
  return query<Signature>("SELECT * FROM signatures ORDER BY created_at, id");
}

export async function signatureBodies(): Promise<Map<string, string>> {
  return new Map((await listSignatures()).map((x) => [x.id, x.body]));
}

/** Deletes a signature; whatever used it falls back to the default (a campaign) or to none. */
export async function deleteSignature(id: string): Promise<void> {
  await run("DELETE FROM signatures WHERE id = ?", [id]);
  await run("UPDATE settings SET signature_id = CASE WHEN signature_id = ? THEN NULL ELSE signature_id END, reply_signature_id = CASE WHEN reply_signature_id = ? THEN NULL ELSE reply_signature_id END WHERE id = 1", [id, id]);
  await run("UPDATE campaigns SET signature_id = NULL WHERE signature_id = ?", [id]);
  await run("UPDATE campaigns SET reply_signature_id = NULL WHERE reply_signature_id = ?", [id]);
}

// ── People ─────────────────────────────────────────────────────────

const FREEMAIL = new Set((freemailDomains as string[]).map((d) => d.toLowerCase()));
export const isPersonal = (domain: string) => FREEMAIL.has(domain.toLowerCase());

export interface PersonInput {
  email: string;
  first_name?: string;
  last_name?: string;
  title?: string;
  company?: string;
  linkedin_url?: string;
  phone?: string;
  notes?: string;
  crm_contact_id?: string | null;
}

const PERSON_FIELDS = ["first_name", "last_name", "title", "company", "linkedin_url", "phone", "notes"] as const;
const LIMITS: Record<(typeof PERSON_FIELDS)[number], number> = {
  first_name: 100, last_name: 100, title: 200, company: 200, linkedin_url: 500, phone: 50, notes: 4000,
};

/** A person's fields as given, trimmed and capped; an error names the first bad one. */
export function cleanPerson(raw: Record<string, unknown>): PersonInput | { error: string } {
  const email = normaliseEmail(raw.email);
  if (!isEmail(email)) return { error: `"${String(raw.email ?? "").slice(0, 80)}" is not an email address` };
  const out: PersonInput = { email };
  for (const f of PERSON_FIELDS) {
    const v = raw[f];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") return { error: `${f} must be text` };
    out[f] = v.trim().slice(0, LIMITS[f]);
  }
  if (typeof raw.crm_contact_id === "string" && raw.crm_contact_id.trim()) out.crm_contact_id = raw.crm_contact_id.trim();
  return out;
}

/** Adds a person, or fills in the one with that address: a field given here
 *  replaces what was there, a field left out keeps it. */
export async function upsertPerson(p: PersonInput, source: string): Promise<{ person: Person; created: boolean }> {
  const existing = await get<Person>("SELECT * FROM people WHERE email = ?", [p.email]);
  if (!existing) {
    const id = crypto.randomUUID();
    await run(
      `INSERT INTO people (id, email, first_name, last_name, title, company, domain, linkedin_url, phone, notes, source, crm_contact_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, p.email, p.first_name ?? "", p.last_name ?? "", p.title ?? "", p.company ?? "",
        companyDomain(p.email, isPersonal), p.linkedin_url ?? "", p.phone ?? "", p.notes ?? "", source, p.crm_contact_id ?? null,
      ],
    );
    return { person: (await get<Person>("SELECT * FROM people WHERE id = ?", [id]))!, created: true };
  }
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const f of PERSON_FIELDS) {
    if (p[f] === undefined || (p[f] === "" && f !== "notes")) continue;
    sets.push(`${f} = ?`);
    params.push(p[f]);
  }
  if (p.crm_contact_id) {
    sets.push("crm_contact_id = ?");
    params.push(p.crm_contact_id);
  }
  if (sets.length) {
    await run(`UPDATE people SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`, [...params, existing.id]);
  }
  return { person: (await get<Person>("SELECT * FROM people WHERE id = ?", [existing.id]))!, created: false };
}

// ── Campaign membership ───────────────────────────────────────────

export async function stepsOf(campaignId: string): Promise<Step[]> {
  return query<Step>("SELECT * FROM steps WHERE campaign_id = ? ORDER BY position", [campaignId]);
}

export interface EnrollResult {
  enrolled: number;
  skipped: Array<{ person_id: string; email: string; reason: string }>;
}

/**
 * Puts people in a campaign at its first step. Never someone who asked not to
 * be written to or whose address bounced, and never someone already being
 * written to by another campaign: one person, one conversation at a time.
 */
export async function enroll(campaignId: string, personIds: string[], by: string | null, now = new Date()): Promise<EnrollResult> {
  const steps = await stepsOf(campaignId);
  if (!steps.length) throw new Error("Add the campaign's steps before adding people");
  const first = steps[0];
  const result: EnrollResult = { enrolled: 0, skipped: [] };
  const ids = [...new Set(personIds)];
  for (const chunk of parts(ids)) {
    const people = await query<Person & { live_in: string | null; here: number }>(
      `SELECT p.*,
         (SELECT c.name FROM enrollments e JOIN campaigns c ON c.id = e.campaign_id
           WHERE e.person_id = p.id AND e.campaign_id != ? AND e.status IN ('active', 'paused') LIMIT 1) AS live_in,
         (SELECT COUNT(*) FROM enrollments e WHERE e.person_id = p.id AND e.campaign_id = ?) AS here
       FROM people p WHERE p.id IN (${inList(chunk.length)})`,
      [campaignId, campaignId, ...chunk],
    );
    const found = new Set(people.map((p) => p.id));
    for (const id of chunk) if (!found.has(id)) result.skipped.push({ person_id: id, email: "", reason: "No such person" });
    for (const p of people) {
      const reason = p.unsubscribed_at
        ? "Asked not to be emailed"
        : p.bounced_at
          ? "Their address bounced"
          : p.here
            ? "Already in this campaign"
            : p.live_in
              ? `Already being emailed in ${p.live_in}`
              : null;
      if (reason) {
        result.skipped.push({ person_id: p.id, email: p.email, reason });
        continue;
      }
      await run(
        `INSERT INTO enrollments (id, campaign_id, person_id, status, step, due_at, enrolled_by)
         VALUES (?, ?, ?, 'active', ?, ?, ?) ON CONFLICT (campaign_id, person_id) DO NOTHING`,
        [crypto.randomUUID(), campaignId, p.id, first.position, dueAfter(now, first.wait_days), by],
      );
      result.enrolled++;
    }
  }
  return result;
}

/** After a touch at `position`: on to the next step, or finished after the last. */
export async function advance(enrollmentId: string, position: number, at: Date): Promise<void> {
  const e = await get<Enrollment>("SELECT * FROM enrollments WHERE id = ?", [enrollmentId]);
  if (!e || e.step !== position) return;
  const next = nextStep(await stepsOf(e.campaign_id), position, at);
  if (next) {
    await run("UPDATE enrollments SET step = ?, due_at = ?, updated_at = datetime('now') WHERE id = ? AND step = ?", [next.step, next.due_at, e.id, position]);
  } else {
    await run(
      "UPDATE enrollments SET status = CASE WHEN status IN ('active', 'paused') THEN 'finished' ELSE status END, due_at = NULL, reason = CASE WHEN status IN ('active', 'paused') THEN 'Every step done' ELSE reason END, updated_at = datetime('now') WHERE id = ? AND step = ?",
      [e.id, position],
    );
  }
}

/** Ends live enrollments with a status and a reason; their open touches are
 *  skipped. Returns the ones that actually changed. */
export async function endEnrollments(ids: string[], status: Enrollment["status"], reason: string): Promise<string[]> {
  const changed: string[] = [];
  for (const chunk of parts(ids)) {
    const rows = await query<{ id: string }>(
      `UPDATE enrollments SET status = ?, reason = ?, due_at = NULL, paused_until = NULL, updated_at = datetime('now')
        WHERE id IN (${inList(chunk.length)}) AND status IN ('active', 'paused') RETURNING id`,
      [status, reason, ...chunk],
    );
    changed.push(...rows.map((r) => r.id));
  }
  await skipOpenTouches(changed, reason);
  return changed;
}

export async function skipOpenTouches(enrollmentIds: string[], why: string): Promise<void> {
  for (const chunk of parts(enrollmentIds)) {
    await run(
      `UPDATE touches SET status = 'skipped', error = ?, updated_at = datetime('now')
        WHERE enrollment_id IN (${inList(chunk.length)}) AND status IN (${OPEN_SQL})`,
      [why, ...chunk],
    );
  }
}

/**
 * When someone replies or books a meeting: their other campaigns stop, and so
 * does everyone at their company in a campaign that says so. A personal
 * address has no company, so it stops no one else.
 */
export async function stopAround(person: Person, exceptEnrollment: string, reasons: { person: string; company: string }): Promise<void> {
  const mine = await query<{ id: string }>(
    "SELECT id FROM enrollments WHERE person_id = ? AND id != ? AND status IN ('active', 'paused')",
    [person.id, exceptEnrollment],
  );
  await endEnrollments(mine.map((r) => r.id), "stopped", reasons.person);
  if (person.domain) await stopCompany(person.domain, person.id, reasons.company);
}

export async function stopCompany(domain: string, exceptPerson: string | null, reason: string): Promise<string[]> {
  const theirs = await query<{ id: string }>(
    `SELECT e.id FROM enrollments e JOIN people p ON p.id = e.person_id JOIN campaigns c ON c.id = e.campaign_id
      WHERE p.domain = ? AND (? IS NULL OR p.id != ?) AND c.stop_company = 1 AND e.status IN ('active', 'paused')`,
    [domain, exceptPerson, exceptPerson],
  );
  return endEnrollments(theirs.map((r) => r.id), "stopped", reason);
}

/** Someone asked not to be written to: every campaign stops, for good. */
export async function unsubscribe(personId: string, why: string): Promise<void> {
  await run("UPDATE people SET unsubscribed_at = COALESCE(unsubscribed_at, datetime('now')), updated_at = datetime('now') WHERE id = ?", [personId]);
  const live = await query<{ id: string }>("SELECT id FROM enrollments WHERE person_id = ? AND status IN ('active', 'paused')", [personId]);
  await endEnrollments(live.map((r) => r.id), "unsubscribed", why);
}

export function personName(p: Pick<Person, "first_name" | "last_name" | "email">): string {
  return [p.first_name, p.last_name].filter(Boolean).join(" ") || p.email;
}
