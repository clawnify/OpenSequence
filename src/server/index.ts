import { createApp, createRoute, widgets, z, caller, user, PageQuery, pageParams, pagedResponse } from "@clawnify/app";
import { verifyDelivery } from "@clawnify/queue";
import type { Context } from "hono";
import type { CredentialBinding } from "@clawnify/connections";
import { query, get, run } from "./db.js";
import {
  CHANNELS, WRITERS, dayStart, dailyCap, isDay, isHtml, isTimezone, localDay, minutesOf, nextSendAt, normaliseEmail, validateSteps,
} from "./sequence-rules.js";
import { MAX_SIGNATURE, sanitizeSignature } from "./signature.js";
import { NO_SIGNATURE, signatureFor } from "./sequence-rules.js";
import {
  advance, cleanPerson, deleteSignature, endEnrollments, enroll, getSettings, listSignatures, parts, saveSettings, signatureBodies,
  skipOpenTouches, stepsOf, unsubscribe, upsertPerson, type Campaign, type Enrollment, type Person, type Settings, type SettingsPatch,
  type Step, type Touch,
} from "./store.js";
import { crmAppOf, ensureScheduled, runAndBook, scheduleRun, windowOf, type EngineEnv } from "./engine.js";
import { connectionStatus, contactApps, crmContactsPage, gmailSignature, mailFor, mailboxes } from "./integrations.js";

// In production Clawnify injects the CREDENTIALS broker binding, CLAWNIFY_ORG_ID
// and the org token (CLAWNIFY_TOKEN: the platform queue, the model endpoint and
// the app proxy to a sibling CRM). The URLs are only set off-platform, to point
// them at a local stand-in. CRM_APP_ID is set by a bundle install next to a CRM.
type Env = {
  Bindings: EngineEnv & {
    DB: D1Database;
    CREDENTIALS?: CredentialBinding;
    CLAWNIFY_ORG_ID?: string;
    CLAWNIFY_TOKEN?: string;
    CLAWNIFY_API_URL?: string;
    CLAWNIFY_QUEUE_URL?: string;
    CLAWNIFY_SERVICES_URL?: string;
    CRM_APP_ID?: string;
  };
};
type C = Context<Env>;

const app = createApp<Env>({
  title: "OpenSequence",
  version: "1.0.0",
  description: "Email sequences a person approves before they send: campaigns, the people in them, a review queue, and the replies that come back.",
});

// ── Who may do what ────────────────────────────────────────────────

/** A person: approving an email or changing where and when mail goes out is theirs, never an agent's. */
const isPerson = (c: C) => (caller(c) === "user" || caller(c) === "api") && !!user(c);
/** People and agents: runs and the research queue. */
const mayWrite = (c: C) => ["user", "api", "agent"].includes(caller(c) ?? "");
const who = (c: C) => user(c)?.email ?? user(c)?.id ?? caller(c) ?? null;
const originOf = (c: C) => new URL(c.req.url).origin;
const PERSON_ONLY = "Only a signed-in person can do this: every email is approved by a person before it goes out.";

/** Books a run soon, after something that gives it work. */
async function kick(c: C): Promise<void> {
  await scheduleRun(c.env, originOf(c), new Date());
}

const fail = (c: C, err: unknown, status: 400 | 404 | 409 | 500 = 500) =>
  c.json({ error: err instanceof Error ? err.message : String(err) }, status);

async function body(c: C): Promise<Record<string, unknown>> {
  return c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
}

const inList = (n: number) => Array.from({ length: n }, () => "?").join(", ");

// ── Schemas ────────────────────────────────────────────────────────

const ErrorSchema = z.object({ error: z.string() }).openapi("Error");

const StepSchema = z.object({
  id: z.string(),
  position: z.number().int(),
  wait_days: z.number().int().openapi({ description: "Days after the step before; for step 1, after the person joins" }),
  channel: z.enum(CHANNELS),
  writer: z.enum(WRITERS).openapi({ description: "Email steps: research = the agent researches the person first and writes it; thread = the app's AI writes it from the thread" }),
  instructions: z.string(),
}).openapi("Step");

const CampaignSchema = z.object({
  id: z.string(),
  name: z.string(),
  angle: z.string().openapi({ description: "Who it writes to and why: frames every draft" }),
  status: z.enum(["draft", "active", "paused", "archived"]),
  stop_company: z.boolean().openapi({ description: "A reply or a booked meeting from anyone at a company stops everyone there" }),
  signature_id: z.string().nullable().openapi({ description: "First emails: null = the workspace default, 'none' = no signature, else a signature id" }),
  reply_signature_id: z.string().nullable().openapi({ description: "Follow-ups: the same" }),
  people: z.number().int(),
  live: z.number().int().openapi({ description: "People still being written to" }),
  reached: z.number().int().openapi({ description: "People who got at least one email" }),
  sent: z.number().int(),
  replied: z.number().int(),
  meetings: z.number().int(),
  bounced: z.number().int(),
  created_at: z.string(),
}).openapi("Campaign");

const PersonSchema = z.object({
  id: z.string(),
  email: z.string(),
  first_name: z.string(),
  last_name: z.string(),
  title: z.string(),
  company: z.string(),
  domain: z.string().openapi({ description: "The company's mail domain; empty for a personal address" }),
  linkedin_url: z.string(),
  phone: z.string(),
  notes: z.string().openapi({ description: "Context and evidence for whoever writes to them" }),
  source: z.string(),
  crm_contact_id: z.string().nullable(),
  unsubscribed_at: z.string().nullable(),
  bounced_at: z.string().nullable(),
  created_at: z.string(),
  campaign: z.object({ id: z.string(), name: z.string(), status: z.string(), step: z.number().int(), reason: z.string().nullable() }).nullable()
    .openapi({ description: "Their latest campaign and where they are in it" }),
}).openapi("Person");

const SourceSchema = z.object({ title: z.string(), url: z.string(), note: z.string() });

const TouchSchema = z.object({
  id: z.string(),
  status: z.enum(["research", "drafting", "review", "approved", "sending", "sent", "todo", "done", "skipped", "failed"]),
  channel: z.enum(CHANNELS),
  position: z.number().int(),
  total_steps: z.number().int(),
  subject: z.string().nullable().openapi({ description: "Only an email that starts a thread has one" }),
  body: z.string().nullable(),
  edited: z.boolean().openapi({ description: "A person changed the writer's draft" }),
  rationale: z.string().nullable(),
  sources: z.array(SourceSchema),
  written_by: z.string().nullable(),
  review_note: z.string().nullable(),
  error: z.string().nullable(),
  instructions: z.string().openapi({ description: "What the step is for" }),
  writer: z.enum(WRITERS),
  due_at: z.string().nullable(),
  sent_at: z.string().nullable(),
  starts_thread: z.boolean(),
  person: z.object({ id: z.string(), email: z.string(), first_name: z.string(), last_name: z.string(), title: z.string(), company: z.string(), linkedin_url: z.string(), phone: z.string(), notes: z.string() }),
  campaign: z.object({ id: z.string(), name: z.string() }),
  enrollment: z.object({ id: z.string(), status: z.string(), reason: z.string().nullable() }),
}).openapi("Touch");

const ReplySchema = z.object({
  id: z.string(),
  kind: z.enum(["reply", "auto", "bounce"]),
  intent: z.string().nullable().openapi({ description: "interested | not_interested | unsubscribe | out_of_office | other, as the AI read it; null until read. unsubscribe has already marked the person as never to be emailed" }),
  maybe_opt_out: z.boolean().openapi({ description: "Might be asking us to stop, but not clearly (a bare yes or no): a person decides, with POST /api/people/{id}/unsubscribe" }),
  summary: z.string().nullable(),
  excerpt: z.string(),
  from_email: z.string(),
  received_at: z.string(),
  handled_at: z.string().nullable(),
  person: z.object({ id: z.string(), email: z.string(), name: z.string(), company: z.string(), unsubscribed: z.boolean() }).nullable(),
  campaign: z.object({ id: z.string(), name: z.string() }).nullable(),
  enrollment: z.object({ id: z.string(), status: z.string(), reason: z.string().nullable() }).nullable(),
}).openapi("Reply");

// ── Views ──────────────────────────────────────────────────────────

type CampaignRow = Campaign & { people: number; live: number; reached: number; sent: number; replied: number; meetings: number; bounced: number };

const CAMPAIGN_SELECT = `SELECT c.*,
  (SELECT COUNT(*) FROM enrollments e WHERE e.campaign_id = c.id) AS people,
  (SELECT COUNT(*) FROM enrollments e WHERE e.campaign_id = c.id AND e.status IN ('active', 'paused')) AS live,
  (SELECT COUNT(*) FROM enrollments e WHERE e.campaign_id = c.id AND e.last_sent_at IS NOT NULL) AS reached,
  (SELECT COUNT(*) FROM touches t JOIN enrollments e ON e.id = t.enrollment_id WHERE e.campaign_id = c.id AND t.status = 'sent') AS sent,
  (SELECT COUNT(*) FROM enrollments e WHERE e.campaign_id = c.id AND e.status = 'replied') AS replied,
  (SELECT COUNT(*) FROM enrollments e WHERE e.campaign_id = c.id AND e.status = 'meeting') AS meetings,
  (SELECT COUNT(*) FROM enrollments e WHERE e.campaign_id = c.id AND e.status = 'bounced') AS bounced
  FROM campaigns c`;

function campaignView(r: CampaignRow) {
  return {
    id: r.id, name: r.name, angle: r.angle, status: r.status, stop_company: !!r.stop_company,
    signature_id: r.signature_id, reply_signature_id: r.reply_signature_id,
    people: r.people, live: r.live, reached: r.reached, sent: r.sent, replied: r.replied, meetings: r.meetings, bounced: r.bounced,
    created_at: r.created_at,
  };
}

async function campaignById(id: string): Promise<CampaignRow | undefined> {
  return get<CampaignRow>(`${CAMPAIGN_SELECT} WHERE c.id = ?`, [id]);
}

function stepView(s: Step) {
  return { id: s.id, position: s.position, wait_days: s.wait_days, channel: s.channel, writer: s.writer, instructions: s.instructions };
}

type PersonRow = Person & { c_id: string | null; c_name: string | null; c_status: string | null; c_step: number | null; c_reason: string | null };

/** People with their latest campaign: the live one if any, else the most recent. */
const PERSON_SELECT = `SELECT p.*, le.campaign_id AS c_id, lc.name AS c_name, le.status AS c_status, le.step AS c_step, le.reason AS c_reason
  FROM people p
  LEFT JOIN enrollments le ON le.id = (
    SELECT e.id FROM enrollments e WHERE e.person_id = p.id
     ORDER BY CASE WHEN e.status IN ('active', 'paused') THEN 0 ELSE 1 END, e.updated_at DESC LIMIT 1)
  LEFT JOIN campaigns lc ON lc.id = le.campaign_id`;

function personView(r: PersonRow) {
  return {
    id: r.id, email: r.email, first_name: r.first_name, last_name: r.last_name, title: r.title, company: r.company, domain: r.domain,
    linkedin_url: r.linkedin_url, phone: r.phone, notes: r.notes, source: r.source, crm_contact_id: r.crm_contact_id,
    unsubscribed_at: r.unsubscribed_at, bounced_at: r.bounced_at, created_at: r.created_at,
    campaign: r.c_id ? { id: r.c_id, name: r.c_name ?? "", status: r.c_status ?? "", step: r.c_step ?? 0, reason: r.c_reason } : null,
  };
}

type TouchRow = Touch & {
  e_status: string; e_reason: string | null; due_at: string | null; thread_id: string | null; campaign_id: string; campaign_name: string;
  total_steps: number; instructions: string | null; writer: string | null;
  person_id: string; email: string; first_name: string; last_name: string; title: string; company: string; linkedin_url: string; phone: string; person_notes: string;
  sent_before: number;
};

const TOUCH_SELECT = `SELECT t.*, e.status AS e_status, e.reason AS e_reason, e.due_at, e.thread_id, e.campaign_id, c.name AS campaign_name,
  (SELECT COUNT(*) FROM steps x WHERE x.campaign_id = e.campaign_id) AS total_steps, s.instructions, s.writer,
  p.id AS person_id, p.email, p.first_name, p.last_name, p.title, p.company, p.linkedin_url, p.phone, p.notes AS person_notes,
  (SELECT COUNT(*) FROM touches o WHERE o.enrollment_id = t.enrollment_id AND o.status = 'sent' AND o.id != t.id) AS sent_before
  FROM touches t
  JOIN enrollments e ON e.id = t.enrollment_id
  JOIN campaigns c ON c.id = e.campaign_id
  JOIN people p ON p.id = e.person_id
  LEFT JOIN steps s ON s.id = t.step_id`;

function sourcesOf(v: string): Array<{ title: string; url: string; note: string }> {
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? a.filter((x) => x && typeof x === "object").map((x) => ({ title: String(x.title ?? ""), url: String(x.url ?? ""), note: String(x.note ?? "") })) : [];
  } catch {
    return [];
  }
}

function touchView(r: TouchRow) {
  const startsThread = r.channel === "email" && !r.thread_id && r.sent_before === 0;
  return {
    id: r.id, status: r.status, channel: r.channel, position: r.position, total_steps: r.total_steps,
    subject: r.status === "sent" ? r.sent_subject ?? r.subject : r.subject,
    body: r.body,
    edited: r.draft_body !== null && (r.body !== r.draft_body || (r.subject ?? null) !== (r.draft_subject ?? null)),
    rationale: r.rationale, sources: sourcesOf(r.sources), written_by: r.written_by, review_note: r.review_note, error: r.error,
    instructions: r.instructions ?? "", writer: (r.writer ?? "thread") as "research" | "thread",
    due_at: r.due_at, sent_at: r.sent_at, starts_thread: startsThread,
    person: { id: r.person_id, email: r.email, first_name: r.first_name, last_name: r.last_name, title: r.title, company: r.company, linkedin_url: r.linkedin_url, phone: r.phone, notes: r.person_notes },
    campaign: { id: r.campaign_id, name: r.campaign_name },
    enrollment: { id: r.enrollment_id, status: r.e_status, reason: r.e_reason },
  };
}

async function touchById(id: string): Promise<TouchRow | undefined> {
  return get<TouchRow>(`${TOUCH_SELECT} WHERE t.id = ?`, [id]);
}

// ── Overview and widgets ───────────────────────────────────────────

async function counts() {
  const r = await get<Record<string, number>>(`SELECT
    (SELECT COUNT(*) FROM touches t JOIN enrollments e ON e.id = t.enrollment_id WHERE t.status = 'review' AND e.status = 'active') AS review,
    (SELECT COUNT(*) FROM touches t JOIN enrollments e ON e.id = t.enrollment_id WHERE t.status = 'research' AND e.status = 'active') AS research,
    (SELECT COUNT(*) FROM touches t JOIN enrollments e ON e.id = t.enrollment_id WHERE t.status = 'drafting' AND e.status = 'active') AS drafting,
    (SELECT COUNT(*) FROM touches t JOIN enrollments e ON e.id = t.enrollment_id WHERE t.status = 'todo' AND e.status = 'active') AS todo,
    (SELECT COUNT(*) FROM touches t JOIN enrollments e ON e.id = t.enrollment_id WHERE t.status IN ('approved', 'sending') AND e.status = 'active') AS approved,
    (SELECT COUNT(*) FROM touches WHERE status = 'failed') AS failed,
    (SELECT COUNT(*) FROM inbound WHERE handled_at IS NULL AND kind = 'reply') AS replies,
    (SELECT COUNT(*) FROM campaigns WHERE status != 'archived') AS campaigns,
    (SELECT COUNT(*) FROM people) AS people`);
  return {
    review: r?.review ?? 0, research: r?.research ?? 0, drafting: r?.drafting ?? 0, todo: r?.todo ?? 0, approved: r?.approved ?? 0,
    failed: r?.failed ?? 0, replies: r?.replies ?? 0, campaigns: r?.campaigns ?? 0, people: r?.people ?? 0,
  };
}

async function sendingView(s: Settings, now = new Date()) {
  const w = windowOf(s);
  const cap = dailyCap(s.daily_cap, s.ramp_from, localDay(now, s.timezone));
  const sentToday = (await get<{ n: number }>("SELECT COUNT(*) AS n FROM touches WHERE status = 'sent' AND sent_at >= ?", [dayStart(now, w.timezone).toISOString()]))?.n ?? 0;
  return {
    mailbox: s.mailbox,
    cap_today: cap,
    sent_today: sentToday,
    next_send_at: nextSendAt(now, w, cap, { sentToday, lastSentAt: s.last_sent_at }).toISOString(),
    last_run_at: s.last_run_at,
    next_run_at: s.next_run_at,
    last_error: s.last_error,
    crm_error: s.crm_error,
  };
}

app.get("/api/overview", async (c) => {
  try {
    await ensureScheduled(c.env, originOf(c)).catch(() => undefined);
    const s = await getSettings();
    return c.json({
      counts: await counts(),
      sending: await sendingView(s),
      ready: { mailbox: !!s.mailbox, about: !!s.about.trim() },
      crm: !!crmAppOf(c.env, s),
      can_approve: isPerson(c),
      footer: { opt_out: s.opt_out },
    }, 200);
  } catch (err) {
    return fail(c, err);
  }
});

const REVIEW = { icon: "check-square", color: "blue" } as const;
const REPLIES = { icon: "inbox", color: "green" } as const;

widgets(app, async () => {
  const s = await getSettings();
  const n = await counts();
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const week = await get<{ sent: number; replies: number }>(
    `SELECT (SELECT COUNT(*) FROM touches WHERE status = 'sent' AND sent_at >= ?) AS sent,
            (SELECT COUNT(*) FROM inbound WHERE kind = 'reply' AND received_at >= ?) AS replies`,
    [weekAgo, weekAgo],
  );
  const view = await sendingView(s);
  return [
    { key: "to-approve", kind: "metric", title: "Emails waiting for approval", value: n.review, at: "/", ...REVIEW },
    { key: "open-replies", kind: "metric", title: "Replies to deal with", value: n.replies, at: "/replies", ...REPLIES },
    { key: "sent-today", kind: "metric", title: "Emails sent today", value: view.sent_today, at: "/", ...REVIEW },
    {
      key: "this-week", kind: "breakdown", title: "The last 7 days", at: "/campaigns", icon: "send", color: "violet",
      items: [{ label: "Emails sent", value: week?.sent ?? 0 }, { label: "Replies", value: week?.replies ?? 0 }],
    },
  ];
});

// ── Campaigns ──────────────────────────────────────────────────────

/** Where a new campaign starts: the research-led first email, two follow-ups in the thread, and a last note. */
const DEFAULT_STEPS = [
  { wait_days: 0, channel: "email", writer: "research", instructions: "First email. Open with something specific the research found about them or their company, connect it to what we sell in a sentence, and ask one easy question." },
  { wait_days: 3, channel: "email", writer: "thread", instructions: "Short follow-up in the same thread: one new, useful point, the same ask." },
  { wait_days: 4, channel: "email", writer: "thread", instructions: "Second follow-up: a different angle, such as a result for a company like theirs. Keep it short." },
  { wait_days: 7, channel: "email", writer: "thread", instructions: "Last email: polite, no pressure, easy to say no or to point to the right person." },
];

async function writeSteps(campaignId: string, input: unknown): Promise<{ error: string } | null> {
  const v = validateSteps(input);
  if ("error" in v) return v;
  const existing = await stepsOf(campaignId);
  const keep = new Set(v.steps.map((s) => s.id).filter(Boolean));
  for (const old of existing) {
    if (!keep.has(old.id)) await run("DELETE FROM steps WHERE id = ?", [old.id]);
  }
  for (const [i, s] of v.steps.entries()) {
    const position = i + 1;
    const known = s.id && existing.some((e) => e.id === s.id);
    if (known) {
      await run(
        "UPDATE steps SET position = ?, wait_days = ?, channel = ?, writer = ?, instructions = ?, updated_at = datetime('now') WHERE id = ?",
        [position, s.wait_days, s.channel, s.writer, s.instructions, s.id],
      );
    } else {
      await run(
        "INSERT INTO steps (id, campaign_id, position, wait_days, channel, writer, instructions) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [crypto.randomUUID(), campaignId, position, s.wait_days, s.channel, s.writer, s.instructions],
      );
    }
  }
  // People past the new last step are done; touches made for a step that is gone are skipped.
  const count = v.steps.length;
  const past = await query<{ id: string }>("SELECT id FROM enrollments WHERE campaign_id = ? AND step > ? AND status IN ('active', 'paused')", [campaignId, count]);
  await endEnrollments(past.map((r) => r.id), "finished", "Every step done");
  await run(
    `UPDATE touches SET status = 'skipped', error = 'Its step was removed', updated_at = datetime('now')
      WHERE step_id IS NULL AND status IN ('research', 'drafting', 'review', 'approved', 'todo')
        AND enrollment_id IN (SELECT id FROM enrollments WHERE campaign_id = ?)`,
    [campaignId],
  );
  return null;
}

const listCampaigns = createRoute({
  method: "get",
  path: "/api/campaigns",
  tags: ["Campaigns"],
  summary: "List campaigns with their numbers",
  request: { query: PageQuery.extend({ status: z.enum(["draft", "active", "paused", "archived"]).optional() }) },
  responses: { 200: pagedResponse("campaigns", CampaignSchema), 500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } } },
});

app.openapi(listCampaigns, async (c) => {
  try {
    const q = c.req.valid("query");
    const { page, limit, offset, search } = pageParams(q);
    const where: string[] = [];
    const params: unknown[] = [];
    if (search) {
      where.push("(c.name LIKE ? OR c.angle LIKE ?)");
      params.push(`%${search}%`, `%${search}%`);
    }
    if (q.status) {
      where.push("c.status = ?");
      params.push(q.status);
    } else {
      where.push("c.status != 'archived'");
    }
    const w = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const total = (await get<{ n: number }>(`SELECT COUNT(*) AS n FROM campaigns c${w}`, params))?.n ?? 0;
    const rows = await query<CampaignRow>(`${CAMPAIGN_SELECT}${w} ORDER BY c.created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    return c.json({ campaigns: rows.map(campaignView), total, page, limit }, 200);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

const createCampaign = createRoute({
  method: "post",
  path: "/api/campaigns",
  tags: ["Campaigns"],
  summary: "Create a campaign (a draft). Without steps it starts from the research-led four-email sequence",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1).max(120),
            angle: z.string().max(2000).optional(),
            stop_company: z.boolean().optional(),
            steps: z.array(z.object({
              wait_days: z.number().int(), channel: z.enum(CHANNELS), writer: z.enum(WRITERS).optional(), instructions: z.string().optional(),
            })).optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: z.object({ campaign: CampaignSchema, steps: z.array(StepSchema) }) } } },
    400: { description: "Invalid", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(createCampaign, async (c) => {
  try {
    const b = c.req.valid("json");
    const id = crypto.randomUUID();
    await run("INSERT INTO campaigns (id, name, angle, stop_company, created_by) VALUES (?, ?, ?, ?, ?)", [
      id, b.name.trim(), (b.angle ?? "").trim(), b.stop_company === false ? 0 : 1, who(c),
    ]);
    const bad = await writeSteps(id, b.steps ?? DEFAULT_STEPS);
    if (bad) {
      await run("DELETE FROM campaigns WHERE id = ?", [id]);
      return c.json(bad, 400);
    }
    return c.json({ campaign: campaignView((await campaignById(id))!), steps: (await stepsOf(id)).map(stepView) }, 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

const getCampaign = createRoute({
  method: "get",
  path: "/api/campaigns/{id}",
  tags: ["Campaigns"],
  summary: "A campaign with its steps and numbers",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "The campaign", content: { "application/json": { schema: z.object({ campaign: CampaignSchema, steps: z.array(StepSchema) }) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getCampaign, async (c) => {
  const { id } = c.req.valid("param");
  const row = await campaignById(id);
  if (!row) return c.json({ error: "No such campaign" }, 404);
  return c.json({ campaign: campaignView(row), steps: (await stepsOf(id)).map(stepView) }, 200);
});

// Name, angle, the company rule, and its state: draft → active ⇄ paused → archived.
app.patch("/api/campaigns/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const row = await campaignById(id);
    if (!row) return c.json({ error: "No such campaign" }, 404);
    const b = await body(c);
    const sets: string[] = [];
    const params: unknown[] = [];
    if (b.name !== undefined) {
      if (typeof b.name !== "string" || !b.name.trim() || b.name.length > 120) return c.json({ error: "name is 1 to 120 characters" }, 400);
      sets.push("name = ?");
      params.push(b.name.trim());
    }
    if (b.angle !== undefined) {
      if (typeof b.angle !== "string" || b.angle.length > 2000) return c.json({ error: "angle is text under 2,000 characters" }, 400);
      sets.push("angle = ?");
      params.push(b.angle.trim());
    }
    if (b.stop_company !== undefined) {
      if (typeof b.stop_company !== "boolean") return c.json({ error: "stop_company must be true or false" }, 400);
      sets.push("stop_company = ?");
      params.push(b.stop_company ? 1 : 0);
    }
    for (const key of ["signature_id", "reply_signature_id"] as const) {
      if (b[key] === undefined) continue;
      const v = b[key];
      if (v !== null && v !== NO_SIGNATURE && (typeof v !== "string" || !(await get("SELECT id FROM signatures WHERE id = ?", [v])))) {
        return c.json({ error: `${key} is null (the default), "none", or a signature's id` }, 400);
      }
      sets.push(`${key} = ?`);
      params.push(v);
    }
    if (b.status !== undefined) {
      const to = b.status;
      const allowed: Record<string, string[]> = { draft: ["active", "archived"], active: ["paused", "archived"], paused: ["active", "archived"], archived: [] };
      if (typeof to !== "string" || !(allowed[row.status] ?? []).includes(to)) {
        return c.json({ error: `A ${row.status} campaign can't become ${String(to)}` }, 409);
      }
      if (to === "active" && !(await stepsOf(id)).length) return c.json({ error: "Add steps first" }, 409);
      sets.push("status = ?");
      params.push(to);
    }
    if (sets.length) await run(`UPDATE campaigns SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`, [...params, id]);
    if (b.status === "archived") {
      const live = await query<{ id: string }>("SELECT id FROM enrollments WHERE campaign_id = ? AND status IN ('active', 'paused')", [id]);
      await endEnrollments(live.map((r) => r.id), "stopped", "The campaign was archived");
    }
    if (b.status === "active") await kick(c);
    return c.json({ campaign: campaignView((await campaignById(id))!) }, 200);
  } catch (err) {
    return fail(c, err);
  }
});

// The whole list of steps, in order. Steps keep their id when it is sent back.
app.put("/api/campaigns/:id/steps", async (c) => {
  try {
    const id = c.req.param("id");
    if (!(await campaignById(id))) return c.json({ error: "No such campaign" }, 404);
    const b = await body(c);
    const bad = await writeSteps(id, b.steps);
    if (bad) return c.json(bad, 400);
    return c.json({ steps: (await stepsOf(id)).map(stepView) }, 200);
  } catch (err) {
    return fail(c, err);
  }
});

// Only a campaign that never sent anything can be deleted; archive the others.
app.delete("/api/campaigns/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const row = await campaignById(id);
    if (!row) return c.json({ error: "No such campaign" }, 404);
    if (row.sent > 0) return c.json({ error: "This campaign has sent emails: archive it instead, so its history stays" }, 409);
    await run("DELETE FROM campaigns WHERE id = ?", [id]);
    return c.json({ ok: true }, 200);
  } catch (err) {
    return fail(c, err);
  }
});

const EnrollmentRowSchema = z.object({
  id: z.string(),
  status: z.string(),
  step: z.number().int(),
  due_at: z.string().nullable(),
  last_sent_at: z.string().nullable(),
  reason: z.string().nullable(),
  person: z.object({ id: z.string(), email: z.string(), first_name: z.string(), last_name: z.string(), title: z.string(), company: z.string() }),
}).openapi("CampaignPerson");

const listCampaignPeople = createRoute({
  method: "get",
  path: "/api/campaigns/{id}/people",
  tags: ["Campaigns"],
  summary: "The people in a campaign and where each one is",
  request: {
    params: z.object({ id: z.string() }),
    query: PageQuery.extend({ status: z.enum(["active", "paused", "replied", "meeting", "bounced", "unsubscribed", "stopped", "finished"]).optional() }),
  },
  responses: { 200: pagedResponse("people", EnrollmentRowSchema) },
});

app.openapi(listCampaignPeople, async (c) => {
  const { id } = c.req.valid("param");
  const q = c.req.valid("query");
  const { page, limit, offset, search } = pageParams(q);
  const where = ["e.campaign_id = ?"];
  const params: unknown[] = [id];
  if (q.status) {
    where.push("e.status = ?");
    params.push(q.status);
  }
  if (search) {
    where.push("(p.email LIKE ? OR p.first_name LIKE ? OR p.last_name LIKE ? OR p.company LIKE ?)");
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  const w = ` WHERE ${where.join(" AND ")}`;
  const total = (await get<{ n: number }>(`SELECT COUNT(*) AS n FROM enrollments e JOIN people p ON p.id = e.person_id${w}`, params))?.n ?? 0;
  const rows = await query<Enrollment & { email: string; first_name: string; last_name: string; title: string; company: string }>(
    `SELECT e.*, p.email, p.first_name, p.last_name, p.title, p.company FROM enrollments e JOIN people p ON p.id = e.person_id${w}
      ORDER BY CASE WHEN e.status IN ('active', 'paused') THEN 0 ELSE 1 END, e.due_at, e.updated_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return c.json({
    people: rows.map((r) => ({
      id: r.id, status: r.status, step: r.step, due_at: r.due_at, last_sent_at: r.last_sent_at, reason: r.reason,
      person: { id: r.person_id, email: r.email, first_name: r.first_name, last_name: r.last_name, title: r.title, company: r.company },
    })),
    total, page, limit,
  }, 200);
});

const enrollRoute = createRoute({
  method: "post",
  path: "/api/campaigns/{id}/enroll",
  tags: ["Campaigns"],
  summary: "Add people to a campaign, by id or by email. Someone who asked not to be emailed, bounced, or is in another live campaign is skipped, with the reason",
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: z.object({ person_ids: z.array(z.string()).max(500).optional(), emails: z.array(z.string()).max(500).optional() }) } } },
  },
  responses: {
    200: { description: "What happened", content: { "application/json": { schema: z.object({ enrolled: z.number().int(), skipped: z.array(z.object({ person_id: z.string(), email: z.string(), reason: z.string() })) }) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Not possible", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(enrollRoute, async (c) => {
  const { id } = c.req.valid("param");
  const b = c.req.valid("json");
  const row = await campaignById(id);
  if (!row) return c.json({ error: "No such campaign" }, 404);
  if (row.status === "archived") return c.json({ error: "The campaign is archived" }, 409);
  const ids = [...(b.person_ids ?? [])];
  const missing: Array<{ person_id: string; email: string; reason: string }> = [];
  const emails = [...new Set((b.emails ?? []).map(normaliseEmail).filter(Boolean))];
  for (const chunk of parts(emails)) {
    const found = await query<{ id: string; email: string }>(`SELECT id, email FROM people WHERE email IN (${inList(chunk.length)})`, chunk);
    const by = new Map(found.map((f) => [f.email, f.id]));
    for (const e of chunk) {
      const pid = by.get(e);
      if (pid) ids.push(pid);
      else missing.push({ person_id: "", email: e, reason: "Not in People yet: add them first" });
    }
  }
  try {
    const result = await enroll(id, ids, who(c));
    if (result.enrolled && row.status === "active") await kick(c);
    return c.json({ enrolled: result.enrolled, skipped: [...result.skipped, ...missing] }, 200);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 409);
  }
});

// Pause, resume or stop one person in a campaign.
app.post("/api/enrollments/:id/:action{pause|resume|stop}", async (c) => {
  try {
    const id = c.req.param("id");
    const action = c.req.param("action");
    const e = await get<Enrollment>("SELECT * FROM enrollments WHERE id = ?", [id]);
    if (!e) return c.json({ error: "Not in this campaign" }, 404);
    if (action === "pause") {
      if (e.status !== "active") return c.json({ error: `Only someone being written to can be paused (this one is ${e.status})` }, 409);
      await run("UPDATE enrollments SET status = 'paused', paused_until = NULL, reason = ?, updated_at = datetime('now') WHERE id = ?", [`Paused by ${who(c) ?? "a person"}`, id]);
    } else if (action === "resume") {
      if (e.status !== "paused") return c.json({ error: "Only a paused person can be resumed" }, 409);
      const now = new Date().toISOString();
      await run(
        "UPDATE enrollments SET status = 'active', paused_until = NULL, reason = NULL, due_at = CASE WHEN due_at IS NULL OR due_at < ? THEN ? ELSE due_at END, updated_at = datetime('now') WHERE id = ?",
        [now, now, id],
      );
      // A send that failed for good is tried again.
      await run("UPDATE touches SET status = 'approved', attempts = 0, error = NULL WHERE enrollment_id = ? AND status = 'failed' AND position = ?", [id, e.step]);
      await kick(c);
    } else {
      await endEnrollments([id], "stopped", `Stopped by ${who(c) ?? "a person"}`);
    }
    return c.json({ enrollment: await get<Enrollment>("SELECT * FROM enrollments WHERE id = ?", [id]) }, 200);
  } catch (err) {
    return fail(c, err);
  }
});

// ── People ─────────────────────────────────────────────────────────

const listPeople = createRoute({
  method: "get",
  path: "/api/people",
  tags: ["People"],
  summary: "People, with their latest campaign. Search matches name, email and company",
  request: { query: PageQuery.extend({ status: z.enum(["live", "replied", "meeting", "unsubscribed", "bounced", "none"]).optional().openapi({ description: "live = being written to now; none = in no campaign" }) }) },
  responses: { 200: pagedResponse("people", PersonSchema) },
});

app.openapi(listPeople, async (c) => {
  const q = c.req.valid("query");
  const { page, limit, offset, search } = pageParams(q);
  const where: string[] = [];
  const params: unknown[] = [];
  if (search) {
    where.push("(p.email LIKE ? OR p.first_name LIKE ? OR p.last_name LIKE ? OR p.company LIKE ? OR p.title LIKE ?)");
    params.push(...Array(5).fill(`%${search}%`));
  }
  if (q.status === "live") where.push("le.status IN ('active', 'paused')");
  else if (q.status === "replied" || q.status === "meeting") {
    where.push("le.status = ?");
    params.push(q.status);
  } else if (q.status === "unsubscribed") where.push("p.unsubscribed_at IS NOT NULL");
  else if (q.status === "bounced") where.push("p.bounced_at IS NOT NULL");
  else if (q.status === "none") where.push("le.id IS NULL");
  const w = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const total = (await get<{ n: number }>(`SELECT COUNT(*) AS n FROM (${PERSON_SELECT}${w})`, params))?.n ?? 0;
  const rows = await query<PersonRow>(`${PERSON_SELECT}${w} ORDER BY p.created_at DESC, p.id LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return c.json({ people: rows.map(personView), total, page, limit }, 200);
});

const PersonInputSchema = z.object({
  email: z.string(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  title: z.string().optional(),
  company: z.string().optional(),
  linkedin_url: z.string().optional(),
  phone: z.string().optional(),
  notes: z.string().optional().openapi({ description: "Context and evidence for whoever writes to them: what you found and where" }),
  crm_contact_id: z.string().optional().openapi({ description: "Their contact in the connected CRM, when they come from it" }),
});

const addPeople = createRoute({
  method: "post",
  path: "/api/people",
  tags: ["People"],
  summary: "Add people (up to 500), or fill in the ones already here by email. Optionally put them in a campaign",
  request: {
    body: { content: { "application/json": { schema: z.object({ people: z.array(PersonInputSchema).min(1).max(500), campaign_id: z.string().optional(), source: z.enum(["manual", "csv", "crm", "agent"]).optional() }) } } },
  },
  responses: {
    200: {
      description: "What happened",
      content: {
        "application/json": {
          schema: z.object({
            created: z.number().int(), updated: z.number().int(),
            invalid: z.array(z.object({ row: z.number().int(), error: z.string() })),
            enrolled: z.number().int().nullable(),
            skipped: z.array(z.object({ person_id: z.string(), email: z.string(), reason: z.string() })),
          }),
        },
      },
    },
    404: { description: "No such campaign", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(addPeople, async (c) => {
  const b = c.req.valid("json");
  const campaign = b.campaign_id ? await campaignById(b.campaign_id) : undefined;
  if (b.campaign_id && !campaign) return c.json({ error: "No such campaign" }, 404);
  const source = b.source ?? (caller(c) === "agent" ? "agent" : "manual");
  let created = 0;
  let updated = 0;
  const invalid: Array<{ row: number; error: string }> = [];
  const ids: string[] = [];
  for (const [i, raw] of b.people.entries()) {
    const p = cleanPerson(raw as Record<string, unknown>);
    if ("error" in p) {
      invalid.push({ row: i + 1, error: p.error });
      continue;
    }
    const r = await upsertPerson(p, source);
    ids.push(r.person.id);
    if (r.created) created++;
    else updated++;
  }
  let enrolled: number | null = null;
  let skipped: Array<{ person_id: string; email: string; reason: string }> = [];
  if (campaign && ids.length) {
    const r = await enroll(campaign.id, ids, who(c));
    enrolled = r.enrolled;
    skipped = r.skipped;
    if (r.enrolled && campaign.status === "active") await kick(c);
  }
  return c.json({ created, updated, invalid, enrolled, skipped }, 200);
});

app.get("/api/people/:id", async (c) => {
  const id = c.req.param("id");
  const row = await get<PersonRow>(`${PERSON_SELECT} WHERE p.id = ?`, [id]);
  if (!row) return c.json({ error: "No such person" }, 404);
  const enrollments = await query<Enrollment & { campaign_name: string }>(
    "SELECT e.*, c.name AS campaign_name FROM enrollments e JOIN campaigns c ON c.id = e.campaign_id WHERE e.person_id = ? ORDER BY e.created_at DESC LIMIT 20",
    [id],
  );
  const touches = await query<TouchRow>(`${TOUCH_SELECT} WHERE e.person_id = ? ORDER BY t.created_at DESC LIMIT 50`, [id]);
  const replies = await query<{ message_id: string; kind: string; intent: string | null; summary: string | null; excerpt: string; received_at: string }>(
    "SELECT message_id, kind, intent, summary, excerpt, received_at FROM inbound WHERE person_id = ? ORDER BY received_at DESC LIMIT 20",
    [id],
  );
  return c.json({
    person: personView(row),
    enrollments: enrollments.map((e) => ({ id: e.id, campaign: { id: e.campaign_id, name: e.campaign_name }, status: e.status, step: e.step, due_at: e.due_at, reason: e.reason, last_sent_at: e.last_sent_at })),
    touches: touches.map(touchView),
    replies: replies.map((r) => ({ id: r.message_id, kind: r.kind, intent: r.intent, summary: r.summary, excerpt: r.excerpt, received_at: r.received_at })),
  }, 200);
});

app.patch("/api/people/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const existing = await get<Person>("SELECT * FROM people WHERE id = ?", [id]);
    if (!existing) return c.json({ error: "No such person" }, 404);
    const b = await body(c);
    const p = cleanPerson({ ...b, email: existing.email });
    if ("error" in p) return c.json(p, 400);
    // Only the fields sent change; an empty string clears one.
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const f of ["first_name", "last_name", "title", "company", "linkedin_url", "phone", "notes"] as const) {
      if (b[f] === undefined) continue;
      sets.push(`${f} = ?`);
      params.push(p[f] ?? "");
    }
    if (sets.length) await run(`UPDATE people SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`, [...params, id]);
    return c.json({ person: personView((await get<PersonRow>(`${PERSON_SELECT} WHERE p.id = ?`, [id]))!) }, 200);
  } catch (err) {
    return fail(c, err);
  }
});

// Someone who asked not to be emailed stays on file, so they never are again.
app.delete("/api/people/:id", async (c) => {
  const id = c.req.param("id");
  const p = await get<Person>("SELECT * FROM people WHERE id = ?", [id]);
  if (!p) return c.json({ error: "No such person" }, 404);
  if (p.unsubscribed_at) return c.json({ error: "They asked not to be emailed: the record stays so they never are" }, 409);
  await run("DELETE FROM people WHERE id = ?", [id]);
  return c.json({ ok: true }, 200);
});

app.post("/api/people/:id/unsubscribe", async (c) => {
  const id = c.req.param("id");
  if (!(await get("SELECT id FROM people WHERE id = ?", [id]))) return c.json({ error: "No such person" }, 404);
  await unsubscribe(id, `Marked as not to be emailed by ${who(c) ?? "a person"}`);
  return c.json({ person: personView((await get<PersonRow>(`${PERSON_SELECT} WHERE p.id = ?`, [id]))!) }, 200);
});

// ── The CRM next door ──────────────────────────────────────────────

app.get("/api/crm/contacts", async (c) => {
  const s = await getSettings();
  const appId = crmAppOf(c.env, s);
  if (!appId) return c.json({ error: "No CRM is connected: pick one in Settings" }, 409);
  try {
    const page = Math.max(1, Number(c.req.query("page") || "1") || 1);
    const search = (c.req.query("search") || "").trim().slice(0, 100) || undefined;
    const res = await crmContactsPage(c.env, appId, { page, search });
    const emails = res.contacts.map((r) => normaliseEmail(r.email)).filter(Boolean);
    const here = new Set<string>();
    for (const chunk of parts(emails)) {
      for (const r of await query<{ email: string }>(`SELECT email FROM people WHERE email IN (${inList(chunk.length)})`, chunk)) here.add(r.email);
    }
    return c.json({
      contacts: res.contacts.map((r) => ({
        id: r.id, email: normaliseEmail(r.email), first_name: r.first_name, last_name: r.last_name, title: r.title ?? "",
        phone: r.phone ?? "", company: r.company_name ?? "", in_people: here.has(normaliseEmail(r.email)),
      })),
      total: res.total, page: res.page, limit: res.limit,
    }, 200);
  } catch (err) {
    return fail(c, err, 409);
  }
});

// ── The review queue ───────────────────────────────────────────────

const TOUCH_STATUSES = ["research", "drafting", "review", "approved", "sending", "sent", "todo", "done", "skipped", "failed"] as const;

const listTouches = createRoute({
  method: "get",
  path: "/api/touches",
  tags: ["Touches"],
  summary: "Touches by status: review = drafts waiting for a person; research = waiting for the agent to research and write; todo = calls and tasks for a person",
  request: {
    query: PageQuery.extend({
      status: z.enum(TOUCH_STATUSES).optional().openapi({ description: "Default: review" }),
      campaign_id: z.string().optional(),
    }),
  },
  responses: { 200: pagedResponse("touches", TouchSchema) },
});

app.openapi(listTouches, async (c) => {
  const q = c.req.valid("query");
  const { page, limit, offset, search } = pageParams(q);
  const status = q.status ?? "review";
  const where = ["t.status = ?"];
  const params: unknown[] = [status];
  // Waiting work only counts for people still being written to.
  if (["research", "drafting", "review", "approved", "todo"].includes(status)) where.push("e.status = 'active'");
  if (q.campaign_id) {
    where.push("e.campaign_id = ?");
    params.push(q.campaign_id);
  }
  if (search) {
    where.push("(p.email LIKE ? OR p.first_name LIKE ? OR p.last_name LIKE ? OR p.company LIKE ?)");
    params.push(...Array(4).fill(`%${search}%`));
  }
  const w = ` WHERE ${where.join(" AND ")}`;
  const total = (await get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM touches t JOIN enrollments e ON e.id = t.enrollment_id JOIN people p ON p.id = e.person_id${w}`,
    params,
  ))?.n ?? 0;
  const order = status === "sent" ? "t.sent_at DESC" : "e.due_at, t.created_at";
  const rows = await query<TouchRow>(`${TOUCH_SELECT}${w} ORDER BY ${order} LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return c.json({ touches: rows.map(touchView), total, page, limit }, 200);
});

const getTouch = createRoute({
  method: "get",
  path: "/api/touches/{id}",
  tags: ["Touches"],
  summary: "One touch, with what was already sent on the thread and anything that came back",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "The touch",
      content: {
        "application/json": {
          schema: z.object({
            touch: TouchSchema,
            thread: z.array(z.object({ position: z.number().int(), subject: z.string().nullable(), body: z.string(), sent_at: z.string() })),
            replies: z.array(z.object({ kind: z.string(), intent: z.string().nullable(), summary: z.string().nullable(), excerpt: z.string(), received_at: z.string() })),
            signature: z.string().openapi({ description: "The signature this email gets when it goes out: plain text or HTML" }),
          }),
        },
      },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getTouch, async (c) => {
  const { id } = c.req.valid("param");
  const t = await touchById(id);
  if (!t) return c.json({ error: "No such touch" }, 404);
  const thread = await query<{ position: number; subject: string | null; body: string; sent_at: string }>(
    "SELECT position, sent_subject AS subject, COALESCE(sent_body, '') AS body, sent_at FROM touches WHERE enrollment_id = ? AND status = 'sent' AND id != ? ORDER BY sent_at",
    [t.enrollment_id, id],
  );
  const replies = await query<{ kind: string; intent: string | null; summary: string | null; excerpt: string; received_at: string }>(
    "SELECT kind, intent, summary, excerpt, received_at FROM inbound WHERE enrollment_id = ? ORDER BY received_at",
    [t.enrollment_id],
  );
  const view = touchView(t);
  const campaign = await get<{ signature_id: string | null; reply_signature_id: string | null }>("SELECT signature_id, reply_signature_id FROM campaigns WHERE id = ?", [t.campaign_id]);
  const signature = signatureFor(view.starts_thread ? "first" : "reply", campaign ?? { signature_id: null, reply_signature_id: null }, await getSettings(), await signatureBodies());
  return c.json({ touch: view, thread, replies, signature }, 200);
});

function cleanSources(v: unknown): Array<{ title: string; url: string; note: string }> | { error: string } {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 10) return { error: "sources is a list of at most 10" };
  const out: Array<{ title: string; url: string; note: string }> = [];
  for (const s of v) {
    const r = (s ?? {}) as Record<string, unknown>;
    const url = typeof r.url === "string" ? r.url.trim() : "";
    if (url && !/^https?:\/\//i.test(url)) return { error: `"${url.slice(0, 80)}" is not a web address` };
    out.push({ title: String(r.title ?? "").trim().slice(0, 200), url: url.slice(0, 500), note: String(r.note ?? "").trim().slice(0, 500) });
  }
  return out;
}

function cleanText(v: unknown, field: string, max: number, required: boolean): string | null | { error: string } {
  if (v === undefined || v === null) return required ? { error: `${field} is required` } : null;
  if (typeof v !== "string") return { error: `${field} must be text` };
  const t = v.replace(/\r\n?/g, "\n").trim();
  if (required && !t) return { error: `${field} is required` };
  if (t.length > max) return { error: `${field} is at most ${max.toLocaleString("en")} characters` };
  return t;
}

const depositDraft = createRoute({
  method: "put",
  path: "/api/touches/{id}/draft",
  tags: ["Touches"],
  summary: "Hand in a researched draft for a touch waiting on research (or one the app's AI couldn't write). It goes to a person for approval; it is never sent from here",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            subject: z.string().optional().openapi({ description: "Required when the touch starts a thread" }),
            body: z.string(),
            rationale: z.string().optional().openapi({ description: "Why this angle, and what you left out" }),
            sources: z.array(z.object({ title: z.string(), url: z.string(), note: z.string().optional() })).optional()
              .openapi({ description: "What you checked, each with a link" }),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Waiting for approval", content: { "application/json": { schema: z.object({ touch: TouchSchema }) } } },
    400: { description: "Invalid", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Not waiting for a draft", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(depositDraft, async (c) => {
  const { id } = c.req.valid("param");
  const t = await touchById(id);
  if (!t) return c.json({ error: "No such touch" }, 404);
  if (t.channel !== "email" || !["research", "drafting"].includes(t.status)) {
    return c.json({ error: `This touch is ${t.status}: it isn't waiting for a draft` }, 409);
  }
  const b = c.req.valid("json");
  const startsThread = touchView(t).starts_thread;
  const subject = startsThread ? cleanText(b.subject, "subject", 150, true) : null;
  if (subject && typeof subject === "object") return c.json(subject, 400);
  const text = cleanText(b.body, "body", 5000, true);
  if (text && typeof text === "object") return c.json(text, 400);
  const sources = cleanSources(b.sources);
  if ("error" in sources) return c.json(sources, 400);
  const rationale = cleanText(b.rationale, "rationale", 1000, false);
  if (rationale && typeof rationale === "object") return c.json(rationale, 400);
  const writer = caller(c) === "agent" ? "agent" : user(c) ? "person" : "agent";
  await run(
    `UPDATE touches SET status = 'review', draft_subject = ?, draft_body = ?, subject = ?, body = ?, sources = ?, rationale = ?,
       written_by = ?, error = NULL, updated_at = datetime('now') WHERE id = ? AND status IN ('research', 'drafting')`,
    [subject, text, subject, text, JSON.stringify(sources), rationale, writer, id],
  );
  return c.json({ touch: touchView((await touchById(id))!) }, 200);
});

// Edit a draft before approving it. Editing an approved email sends it back to review.
app.patch("/api/touches/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const t = await touchById(id);
    if (!t) return c.json({ error: "No such touch" }, 404);
    if (!["review", "approved"].includes(t.status)) return c.json({ error: `A ${t.status} touch can't be edited` }, 409);
    const b = await body(c);
    const startsThread = touchView(t).starts_thread;
    const subject = b.subject === undefined ? t.subject : startsThread ? cleanText(b.subject, "subject", 150, true) : null;
    if (subject && typeof subject === "object") return c.json(subject, 400);
    const text = b.body === undefined ? t.body : cleanText(b.body, "body", 5000, true);
    if (text && typeof text === "object") return c.json(text, 400);
    await run(
      "UPDATE touches SET subject = ?, body = ?, status = 'review', approved_by = NULL, approved_at = NULL, updated_at = datetime('now') WHERE id = ?",
      [subject, text, id],
    );
    return c.json({ touch: touchView((await touchById(id))!) }, 200);
  } catch (err) {
    return fail(c, err);
  }
});

// Approve: the email goes out when it is due, inside the sending window. A person only.
app.post("/api/touches/:id/approve", async (c) => {
  try {
    if (!isPerson(c)) return c.json({ error: PERSON_ONLY }, 403);
    const id = c.req.param("id");
    const t = await touchById(id);
    if (!t) return c.json({ error: "No such touch" }, 404);
    if (t.status !== "review") return c.json({ error: `This touch is ${t.status}, not waiting for approval` }, 409);
    if (t.e_status !== "active") return c.json({ error: `${t.email} is no longer being written to (${t.e_status})` }, 409);
    const b = await body(c);
    const startsThread = touchView(t).starts_thread;
    const subject = startsThread ? cleanText(b.subject ?? t.subject, "subject", 150, true) : null;
    if (subject && typeof subject === "object") return c.json(subject, 400);
    const text = cleanText(b.body ?? t.body, "body", 5000, true);
    if (text && typeof text === "object") return c.json(text, 400);
    await run(
      `UPDATE touches SET subject = ?, body = ?, status = 'approved', approved_by = ?, approved_at = datetime('now'), error = NULL, updated_at = datetime('now')
        WHERE id = ? AND status = 'review'`,
      [subject, text, who(c), id],
    );
    await kick(c);
    return c.json({ touch: touchView((await touchById(id))!) }, 200);
  } catch (err) {
    return fail(c, err);
  }
});

// Send back to its writer with a note: the AI rewrites a thread step, the agent a researched one.
app.post("/api/touches/:id/send-back", async (c) => {
  try {
    const id = c.req.param("id");
    const t = await touchById(id);
    if (!t) return c.json({ error: "No such touch" }, 404);
    if (!["review", "approved"].includes(t.status)) return c.json({ error: `A ${t.status} touch can't be sent back` }, 409);
    const b = await body(c);
    const note = cleanText(b.note, "note", 1000, true);
    if (note && typeof note === "object") return c.json(note, 400);
    const status = t.writer === "research" ? "research" : "drafting";
    await run(
      "UPDATE touches SET status = ?, review_note = ?, attempts = 0, error = NULL, approved_by = NULL, approved_at = NULL, updated_at = datetime('now') WHERE id = ?",
      [status, note, id],
    );
    if (status === "drafting") await kick(c);
    return c.json({ touch: touchView((await touchById(id))!) }, 200);
  } catch (err) {
    return fail(c, err);
  }
});

// Skip this step for this person: nothing is sent, and they move on to the next one.
app.post("/api/touches/:id/skip", async (c) => {
  try {
    const id = c.req.param("id");
    const t = await touchById(id);
    if (!t) return c.json({ error: "No such touch" }, 404);
    if (!["research", "drafting", "review", "approved", "todo", "failed"].includes(t.status)) return c.json({ error: `A ${t.status} touch can't be skipped` }, 409);
    await run("UPDATE touches SET status = 'skipped', error = ?, updated_at = datetime('now') WHERE id = ?", [`Skipped by ${who(c) ?? "a person"}`, id]);
    await advance(t.enrollment_id, t.position, new Date());
    await kick(c);
    return c.json({ touch: touchView((await touchById(id))!) }, 200);
  } catch (err) {
    return fail(c, err);
  }
});

// A call, a LinkedIn step or a task is done: the person moves on to the next step.
app.post("/api/touches/:id/done", async (c) => {
  try {
    const id = c.req.param("id");
    const t = await touchById(id);
    if (!t) return c.json({ error: "No such touch" }, 404);
    if (t.status !== "todo") return c.json({ error: `This touch is ${t.status}, not a task to do` }, 409);
    await run("UPDATE touches SET status = 'done', done_by = ?, updated_at = datetime('now') WHERE id = ?", [who(c), id]);
    await advance(t.enrollment_id, t.position, new Date());
    await kick(c);
    return c.json({ touch: touchView((await touchById(id))!) }, 200);
  } catch (err) {
    return fail(c, err);
  }
});

// ── Replies ────────────────────────────────────────────────────────

const listReplies = createRoute({
  method: "get",
  path: "/api/replies",
  tags: ["Replies"],
  summary: "What came back: replies, automatic answers and bounces. Default: replies nobody has dealt with yet",
  request: { query: PageQuery.extend({ show: z.enum(["open", "all"]).optional() }) },
  responses: { 200: pagedResponse("replies", ReplySchema) },
});

app.openapi(listReplies, async (c) => {
  const q = c.req.valid("query");
  const { page, limit, offset, search } = pageParams(q);
  const where: string[] = [];
  const params: unknown[] = [];
  if ((q.show ?? "open") === "open") where.push("i.handled_at IS NULL AND i.kind = 'reply'");
  if (search) {
    where.push("(p.email LIKE ? OR p.first_name LIKE ? OR p.last_name LIKE ? OR p.company LIKE ? OR i.summary LIKE ?)");
    params.push(...Array(5).fill(`%${search}%`));
  }
  const w = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const from = `FROM inbound i LEFT JOIN people p ON p.id = i.person_id LEFT JOIN enrollments e ON e.id = i.enrollment_id LEFT JOIN campaigns c ON c.id = e.campaign_id`;
  const total = (await get<{ n: number }>(`SELECT COUNT(*) AS n ${from}${w}`, params))?.n ?? 0;
  const rows = await query<{
    message_id: string; kind: "reply" | "auto" | "bounce"; intent: string | null; summary: string | null; excerpt: string; from_email: string; received_at: string; handled_at: string | null;
    maybe_opt_out: number; person_id: string | null; email: string | null; first_name: string | null; last_name: string | null; company: string | null; unsubscribed_at: string | null;
    campaign_id: string | null; campaign_name: string | null; enrollment_id: string | null; e_status: string | null; e_reason: string | null;
  }>(
    `SELECT i.*, p.email, p.first_name, p.last_name, p.company, p.unsubscribed_at, c.id AS campaign_id, c.name AS campaign_name, e.status AS e_status, e.reason AS e_reason
     ${from}${w} ORDER BY i.received_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return c.json({
    replies: rows.map((r) => ({
      id: r.message_id, kind: r.kind, intent: r.intent, summary: r.summary, excerpt: r.excerpt, from_email: r.from_email, received_at: r.received_at, handled_at: r.handled_at,
      maybe_opt_out: !!r.maybe_opt_out,
      person: r.person_id ? {
        id: r.person_id, email: r.email ?? "", name: [r.first_name, r.last_name].filter(Boolean).join(" ") || (r.email ?? ""), company: r.company ?? "", unsubscribed: !!r.unsubscribed_at,
      } : null,
      campaign: r.campaign_id ? { id: r.campaign_id, name: r.campaign_name ?? "" } : null,
      enrollment: r.enrollment_id ? { id: r.enrollment_id, status: r.e_status ?? "", reason: r.e_reason } : null,
    })),
    total, page, limit,
  }, 200);
});

app.post("/api/replies/:id/handled", async (c) => {
  const id = c.req.param("id");
  const r = await run("UPDATE inbound SET handled_at = datetime('now'), handled_by = ? WHERE message_id = ? AND handled_at IS NULL", [who(c), id]);
  if (!r.changes && !(await get("SELECT message_id FROM inbound WHERE message_id = ?", [id]))) return c.json({ error: "No such reply" }, 404);
  return c.json({ ok: true }, 200);
});

// It was an automatic answer after all: carry on with the sequence.
app.post("/api/replies/:id/resume", async (c) => {
  try {
    const id = c.req.param("id");
    const r = await get<{ enrollment_id: string | null }>("SELECT enrollment_id FROM inbound WHERE message_id = ?", [id]);
    if (!r?.enrollment_id) return c.json({ error: "No such reply" }, 404);
    const e = await get<Enrollment>("SELECT * FROM enrollments WHERE id = ?", [r.enrollment_id]);
    if (!e || e.status !== "replied") return c.json({ error: `Only a person marked as replied can be resumed (this one is ${e?.status ?? "gone"})` }, 409);
    const steps = await stepsOf(e.campaign_id);
    const left = steps.some((s) => s.position >= e.step) && !!(await get("SELECT id FROM touches WHERE enrollment_id = ? AND position = ? AND status = 'sent'", [e.id, e.step])) === false;
    const now = new Date().toISOString();
    await run(
      `UPDATE enrollments SET status = ?, reason = ?, due_at = ?, updated_at = datetime('now') WHERE id = ?`,
      left ? ["active", null, now, e.id] : ["finished", "Every step done", null, e.id],
    );
    await run("UPDATE inbound SET handled_at = datetime('now'), handled_by = ? WHERE message_id = ?", [who(c), id]);
    if (left) await kick(c);
    return c.json({ ok: true, resumed: left }, 200);
  } catch (err) {
    return fail(c, err);
  }
});

// ── Settings ───────────────────────────────────────────────────────

async function settingsView(c: C) {
  const s = await getSettings();
  const [boxes, status, apps] = await Promise.all([
    mailboxes(c.env).catch(() => []),
    connectionStatus(c.env),
    contactApps(c.env, originOf(c)),
  ]);
  return {
    settings: {
      about: s.about, mailbox: s.mailbox, signature_id: s.signature_id, reply_signature_id: s.reply_signature_id,
      opt_out: s.opt_out, daily_cap: s.daily_cap, ramp_from: s.ramp_from,
      send_from: s.send_from, send_until: s.send_until, timezone: s.timezone, weekdays_only: !!s.weekdays_only,
      crm_app_id: s.crm_app_id, crm_in_use: crmAppOf(c.env, s),
    },
    mailboxes: boxes,
    signatures: (await listSignatures()).map((x) => ({ id: x.id, name: x.name, body: x.body })),
    connections: status,
    crm_apps: apps.map((a) => ({ id: a.id, name: a.name })),
    sending: await sendingView(s),
    live_threads: (await get<{ n: number }>("SELECT COUNT(*) AS n FROM enrollments WHERE thread_id IS NOT NULL AND status IN ('active', 'paused')"))?.n ?? 0,
    can_configure: isPerson(c),
  };
}

app.get("/api/settings", async (c) => {
  try {
    return c.json(await settingsView(c), 200);
  } catch (err) {
    return fail(c, err);
  }
});

app.put("/api/settings", async (c) => {
  try {
    if (!isPerson(c)) return c.json({ error: "Only a signed-in person can change where and when email goes out." }, 403);
    const b = await body(c);
    const patch: SettingsPatch = {};
    const text = (key: "about" | "opt_out", max: number, required = false) => {
      if (b[key] === undefined) return null;
      const v = cleanText(b[key], key.replace("_", "-"), max, required);
      if (v && typeof v === "object") return v.error;
      patch[key] = (v as string | null) ?? "";
      return null;
    };
    const bad = text("about", 1000) ?? text("opt_out", 300, true);
    if (bad) return c.json({ error: bad === "opt-out is required" ? "Every email carries an opt-out line: write one" : bad }, 400);
    if (b.signature !== undefined) return c.json({ error: "Signatures are named now: change them with /api/signatures, and pick the defaults with signature_id and reply_signature_id" }, 400);
    for (const key of ["signature_id", "reply_signature_id"] as const) {
      if (b[key] === undefined) continue;
      const v = b[key];
      if (v !== null && (typeof v !== "string" || !(await get("SELECT id FROM signatures WHERE id = ?", [v])))) {
        return c.json({ error: `${key} is null (no signature) or a signature's id` }, 400);
      }
      patch[key] = v as string | null;
    }
    if (b.mailbox !== undefined) {
      if (b.mailbox === null) patch.mailbox = null;
      else {
        const address = normaliseEmail(b.mailbox);
        const boxes = await mailboxes(c.env);
        if (!boxes.some((m) => m.address === address)) return c.json({ error: `${address || "That"} isn't a Gmail account connected in Clawnify` }, 400);
        patch.mailbox = address;
      }
    }
    if (b.daily_cap !== undefined) {
      if (typeof b.daily_cap !== "number" || !Number.isInteger(b.daily_cap) || b.daily_cap < 1 || b.daily_cap > 200) return c.json({ error: "daily_cap is a whole number from 1 to 200" }, 400);
      patch.daily_cap = b.daily_cap;
    }
    if (b.ramp_from !== undefined) {
      if (b.ramp_from !== null && !isDay(b.ramp_from)) return c.json({ error: "ramp_from is a day (YYYY-MM-DD) or null" }, 400);
      patch.ramp_from = b.ramp_from as string | null;
    }
    for (const key of ["send_from", "send_until"] as const) {
      if (b[key] === undefined) continue;
      if (minutesOf(b[key]) === null) return c.json({ error: `${key} is a time like 09:00` }, 400);
      patch[key] = b[key] as string;
    }
    if (b.timezone !== undefined) {
      if (!isTimezone(b.timezone)) return c.json({ error: "timezone is a time zone name like Europe/Amsterdam" }, 400);
      patch.timezone = b.timezone;
    }
    if (b.weekdays_only !== undefined) {
      if (typeof b.weekdays_only !== "boolean") return c.json({ error: "weekdays_only must be true or false" }, 400);
      patch.weekdays_only = b.weekdays_only ? 1 : 0;
    }
    if (b.crm_app_id !== undefined) {
      if (b.crm_app_id !== null && typeof b.crm_app_id !== "string") return c.json({ error: "crm_app_id is an app id, an empty string for none, or null for the default" }, 400);
      if (typeof b.crm_app_id === "string" && b.crm_app_id) {
        const apps = await contactApps(c.env, originOf(c));
        if (!apps.some((a) => a.id === b.crm_app_id)) return c.json({ error: "That app isn't a CRM in this workspace" }, 400);
      }
      patch.crm_app_id = b.crm_app_id as string | null;
    }
    const before = await getSettings();
    const from = minutesOf(patch.send_from ?? before.send_from)!;
    const until = minutesOf(patch.send_until ?? before.send_until)!;
    if (until - from < 30) return c.json({ error: "The sending window is at least 30 minutes, and ends after it starts" }, 400);
    await saveSettings(patch);
    if (patch.mailbox && patch.mailbox !== before.mailbox) await kick(c);
    return c.json(await settingsView(c), 200);
  } catch (err) {
    return fail(c, err);
  }
});

// ── Signatures ─────────────────────────────────────────────────────

const SignatureSchema = z.object({ id: z.string(), name: z.string(), body: z.string().openapi({ description: "Plain text or HTML" }) }).openapi("Signature");

/** A signature's body as saved: HTML cleaned to what a signature needs, plain text kept. */
async function cleanSignature(v: unknown): Promise<string | { error: string }> {
  if (typeof v !== "string") return { error: "body must be text or HTML" };
  const raw = v.replace(/\r\n?/g, "\n").trim();
  const body = isHtml(raw) ? await sanitizeSignature(raw) : raw;
  return body.length > MAX_SIGNATURE ? { error: "A signature is at most 10,000 characters" } : body;
}

const listSignaturesRoute = createRoute({
  method: "get",
  path: "/api/signatures",
  tags: ["Signatures"],
  summary: "The named signatures. Settings pick a default for first emails and one for follow-ups; a campaign can pick its own",
  request: { query: PageQuery },
  responses: {
    200: {
      description: "A page of signatures, and the workspace defaults",
      content: {
        "application/json": {
          schema: z.object({
            signatures: z.array(SignatureSchema),
            total: z.number().int(),
            page: z.number().int(),
            limit: z.number().int(),
            defaults: z.object({ signature_id: z.string().nullable(), reply_signature_id: z.string().nullable() })
              .openapi({ description: "The signatures first emails and follow-ups get unless a campaign picks one; null: none" }),
          }),
        },
      },
    },
  },
});

app.openapi(listSignaturesRoute, async (c) => {
  const { page, limit, offset } = pageParams(c.req.valid("query"));
  // Settings first: on an install from before named signatures, reading them
  // moves its one signature into the list.
  const s = await getSettings();
  const all = await listSignatures();
  return c.json({
    signatures: all.slice(offset, offset + limit).map((x) => ({ id: x.id, name: x.name, body: x.body })),
    total: all.length, page, limit,
    defaults: { signature_id: s.signature_id, reply_signature_id: s.reply_signature_id },
  }, 200);
});

app.post("/api/signatures", async (c) => {
  if (!isPerson(c)) return c.json({ error: "Only a signed-in person can change signatures." }, 403);
  const b = await body(c);
  const name = typeof b.name === "string" ? b.name.trim().slice(0, 80) : "";
  if (!name) return c.json({ error: "A signature needs a name" }, 400);
  const sig = await cleanSignature(b.body ?? "");
  if (typeof sig !== "string") return c.json(sig, 400);
  const id = crypto.randomUUID();
  await run("INSERT INTO signatures (id, name, body) VALUES (?, ?, ?)", [id, name, sig]);
  return c.json({ signature: { id, name, body: sig } }, 201);
});

app.patch("/api/signatures/:id", async (c) => {
  if (!isPerson(c)) return c.json({ error: "Only a signed-in person can change signatures." }, 403);
  const id = c.req.param("id");
  if (!(await get("SELECT id FROM signatures WHERE id = ?", [id]))) return c.json({ error: "No such signature" }, 404);
  const b = await body(c);
  if (b.name !== undefined) {
    const name = typeof b.name === "string" ? b.name.trim().slice(0, 80) : "";
    if (!name) return c.json({ error: "A signature needs a name" }, 400);
    await run("UPDATE signatures SET name = ?, updated_at = datetime('now') WHERE id = ?", [name, id]);
  }
  if (b.body !== undefined) {
    const sig = await cleanSignature(b.body);
    if (typeof sig !== "string") return c.json(sig, 400);
    await run("UPDATE signatures SET body = ?, updated_at = datetime('now') WHERE id = ?", [sig, id]);
  }
  const row = (await get<{ id: string; name: string; body: string }>("SELECT id, name, body FROM signatures WHERE id = ?", [id]))!;
  return c.json({ signature: row }, 200);
});

app.delete("/api/signatures/:id", async (c) => {
  if (!isPerson(c)) return c.json({ error: "Only a signed-in person can change signatures." }, 403);
  const id = c.req.param("id");
  if (!(await get("SELECT id FROM signatures WHERE id = ?", [id]))) return c.json({ error: "No such signature" }, 404);
  await deleteSignature(id);
  return c.json({ ok: true }, 200);
});

// The signature Gmail adds to new emails from the sending mailbox (or the
// main Gmail before one is picked), cleaned like a pasted one. Gmail's API only
// knows the one set under "Signature defaults: for new emails".
app.get("/api/settings/gmail-signature", async (c) => {
  if (!isPerson(c)) return c.json({ error: "Only a signed-in person can read the mailbox's settings." }, 403);
  try {
    const s = await getSettings();
    const boxes = await mailboxes(c.env);
    const address = s.mailbox ?? boxes.find((m) => m.isDefault)?.address ?? boxes[0]?.address;
    if (!address) return c.json({ error: "Gmail isn't connected" }, 409);
    const raw = (await gmailSignature(await mailFor(c.env, address))).trim();
    return c.json({ address, signature: raw && isHtml(raw) ? await sanitizeSignature(raw) : raw }, 200);
  } catch (err) {
    return fail(c, err, 409);
  }
});

// ── Runs ───────────────────────────────────────────────────────────

// The platform queue's target: a signed delivery on a declared public route.
// A person or an agent may call it too; anyone else is refused.
app.post("/api/run", async (c) => {
  const raw = await c.req.text();
  const signed = await verifyDelivery(raw, {
    signature: c.req.header("X-Queue-Signature") ?? null,
    timestamp: c.req.header("X-Queue-Timestamp") ?? null,
    keyId: c.req.header("X-Queue-Key-Id") ?? null,
  }).catch(() => false);
  if (!signed && !mayWrite(c)) return c.json({ error: "Sign in to run it." }, 403);
  try {
    return c.json(await runAndBook(c.env, originOf(c)), 200);
  } catch (err) {
    return fail(c, err);
  }
});

// "Check now": reads replies and the calendar even when no read is due, then sends what is ready.
app.post("/api/run-now", async (c) => {
  if (!mayWrite(c)) return c.json({ error: "Sign in to run it." }, 403);
  try {
    const result = await runAndBook(c.env, originOf(c), { force: true });
    return c.json({ ...result, sending: await sendingView(await getSettings()) }, 200);
  } catch (err) {
    return fail(c, err);
  }
});

export default app;
