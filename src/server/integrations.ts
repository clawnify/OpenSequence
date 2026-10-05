// Everything OpenSequence reaches outside its own database: the Gmail account
// it sends from, the calendar where booked meetings show up, and a CRM in the
// same workspace. Google is reached through @clawnify/connections, so the app
// never holds a credential; the CRM through the platform's app proxy, with the
// org token. Action slugs and argument shapes were run against the live
// Composio catalogue on 2026-10-05.

import { accounts, connect, describe, type ConnectionsEnv } from "@clawnify/connections";
import type { CalendarEvent, GmailMessage } from "./sequence-rules.js";
import { normaliseEmail } from "./sequence-rules.js";

export const SERVICES = { mail: "gmail", calendar: "googlecalendar", google: "googlesuper" } as const;

async function connectedServices(env: ConnectionsEnv): Promise<Set<string>> {
  const all = await describe(env, undefined, Object.values(SERVICES).map((service) => ({ service, as: "integration" as const })));
  return new Set(all.filter((s) => s.connected).map((s) => s.id));
}

// ── The mailbox ────────────────────────────────────────────────────

/** A Gmail account the org has connected, by its address. */
export interface Mailbox {
  address: string;
  isDefault: boolean;
}

export interface Mail {
  address: string;
  run(action: string, args: Record<string, unknown>): Promise<unknown>;
}

async function profileAddress(run: Mail["run"]): Promise<string> {
  const data = (await run("GET_PROFILE", { user_id: "me" })) as { emailAddress?: string } | null;
  const address = normaliseEmail(data?.emailAddress);
  if (!address) throw new Error("Gmail did not say which address it is");
  return address;
}

function gmail(env: ConnectionsEnv, account?: string): Mail["run"] {
  const client = connect(SERVICES.mail, env, account ? { account } : undefined);
  return (action, args) => client.run(`GMAIL_${action}`, args);
}

/**
 * The org's Gmail accounts. An account connected before Gmail recorded which
 * address it is can only be the default one: Gmail is asked for its address.
 */
export async function mailboxes(env: ConnectionsEnv): Promise<Mailbox[]> {
  const listed = await accounts(SERVICES.mail, env);
  const out: Mailbox[] = listed
    .filter((a) => a.account)
    .map((a) => ({ address: normaliseEmail(a.account), isDefault: a.isDefault }));
  const unnamed = listed.some((a) => !a.account) || (listed.length === 0 && (await connectedServices(env)).has(SERVICES.mail));
  if (unnamed) {
    const address = await profileAddress(gmail(env)).catch(() => "");
    if (address && !out.some((m) => m.address === address)) out.push({ address, isDefault: true });
  }
  return out;
}

/**
 * The Gmail account that sends, by address. It is named to the broker when
 * the org's account list knows it; otherwise it can only be the default
 * connection, and then only when Gmail confirms it is that address, so an
 * email never leaves from the wrong mailbox.
 */
export async function mailFor(env: ConnectionsEnv, mailbox: string): Promise<Mail> {
  const address = normaliseEmail(mailbox);
  const listed = await accounts(SERVICES.mail, env);
  const named = listed.find((a) => a.account && normaliseEmail(a.account) === address);
  if (named?.account) return { address, run: gmail(env, named.account) };
  const run = gmail(env);
  let actual = "";
  try {
    actual = await profileAddress(run);
  } catch {
    throw new Error(`Gmail isn't connected for ${address}. Connect it in Clawnify, or pick another mailbox in Settings.`);
  }
  if (actual !== address) {
    throw new Error(`${address} isn't connected in Clawnify (the default Gmail is ${actual}). Connect it, or pick another mailbox in Settings.`);
  }
  return { address, run };
}

/** What a send or a reply returns: the message and its thread. */
export interface Sent {
  messageId: string;
  threadId: string;
}

function sentOf(data: unknown): Sent {
  const d = (data ?? {}) as { id?: string; messageId?: string; threadId?: string; thread_id?: string };
  const messageId = d.id ?? d.messageId ?? "";
  const threadId = d.threadId ?? d.thread_id ?? "";
  if (!messageId || !threadId) throw new Error("Gmail accepted the email but did not return its message and thread");
  return { messageId, threadId };
}

/** A new email, which starts a thread (Composio GMAIL_SEND_EMAIL, plain text). */
export async function sendNew(mail: Mail, to: string, subject: string, body: string): Promise<Sent> {
  return sentOf(await mail.run("SEND_EMAIL", { recipient_email: to, subject, body, is_html: false }));
}

/** A reply inside a thread. Gmail keeps the thread's subject (GMAIL_REPLY_TO_THREAD). */
export async function sendReply(mail: Mail, to: string, threadId: string, body: string): Promise<Sent> {
  return sentOf(await mail.run("REPLY_TO_THREAD", { thread_id: threadId, recipient_email: to, message_body: body, is_html: false }));
}

export async function readThread(mail: Mail, threadId: string): Promise<GmailMessage[]> {
  const data = (await mail.run("FETCH_MESSAGE_BY_THREAD_ID", { thread_id: threadId, user_id: "me" })) as { messages?: GmailMessage[] } | null;
  return data?.messages ?? [];
}

export async function readMessage(mail: Mail, messageId: string): Promise<GmailMessage> {
  return ((await mail.run("FETCH_MESSAGE_BY_MESSAGE_ID", { message_id: messageId, user_id: "me", format: "full" })) ?? {}) as GmailMessage;
}

/** One page of a mailbox search, headers only: no body text is read here. */
export async function searchMail(
  mail: Mail,
  query: string,
  page: string | null,
  max = 100,
): Promise<{ messages: GmailMessage[]; next: string | null }> {
  const data = (await mail.run("FETCH_EMAILS", {
    query,
    max_results: max,
    verbose: false,
    include_payload: false,
    ...(page ? { page_token: page } : {}),
  })) as { messages?: GmailMessage[]; nextPageToken?: string } | null;
  return { messages: data?.messages ?? [], next: data?.nextPageToken || null };
}

// ── The calendar ───────────────────────────────────────────────────

/** The org's calendar: Google Calendar, or Google Workspace when Calendar isn't
 *  connected. Null when neither is. */
export async function calendarRun(env: ConnectionsEnv): Promise<Mail["run"] | null> {
  const connected = await connectedServices(env);
  const service = connected.has(SERVICES.calendar) ? SERVICES.calendar : connected.has(SERVICES.google) ? SERVICES.google : null;
  if (!service) return null;
  const client = connect(service, env);
  const toolkit = service.toUpperCase();
  return (action, args) => client.run(`${toolkit}_${action}`, args);
}

export async function calendarPage(
  run: Mail["run"],
  from: string,
  to: string,
  page: string | null,
): Promise<{ items: CalendarEvent[]; next: string | null }> {
  const data = ((await run("EVENTS_LIST", {
    calendarId: "primary",
    timeMin: from,
    timeMax: to,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 250,
    ...(page ? { pageToken: page } : {}),
  })) ?? {}) as { items?: CalendarEvent[]; nextPageToken?: string };
  return { items: data.items ?? [], next: data.nextPageToken || null };
}

export async function connectionStatus(env: ConnectionsEnv): Promise<{ mail: boolean; calendar: boolean }> {
  try {
    const connected = await connectedServices(env);
    return { mail: connected.has(SERVICES.mail), calendar: connected.has(SERVICES.calendar) || connected.has(SERVICES.google) };
  } catch {
    return { mail: false, calendar: false };
  }
}

// ── A CRM in the same workspace ────────────────────────────────────

export interface PlatformEnv {
  CLAWNIFY_TOKEN?: string;
  /** Off-platform only: where the platform answers (a local stand-in). */
  CLAWNIFY_API_URL?: string;
}

function platformBase(env: PlatformEnv): string {
  return (env.CLAWNIFY_API_URL || "https://provision.clawnify.com").replace(/\/+$/, "");
}

export interface SiblingApp {
  id: string;
  name: string;
  url: string;
  provides: string[];
}

/** The org's live apps that hold contacts, this one left out. Empty when the
 *  platform can't be reached: the app then simply works on its own. */
export async function contactApps(env: PlatformEnv, selfOrigin: string): Promise<SiblingApp[]> {
  if (!env.CLAWNIFY_TOKEN) return [];
  try {
    const res = await fetch(`${platformBase(env)}/v1/apps/directory`, { headers: { Authorization: `Bearer ${env.CLAWNIFY_TOKEN}` } });
    if (!res.ok) return [];
    const data = (await res.json()) as { apps?: SiblingApp[] };
    return (data.apps ?? []).filter((a) => a.url !== selfOrigin && Array.isArray(a.provides) && a.provides.includes("contacts"));
  } catch {
    return [];
  }
}

async function crmFetch<T>(env: PlatformEnv, appId: string, method: string, path: string, body?: unknown): Promise<T> {
  if (!env.CLAWNIFY_TOKEN) throw new Error("No Clawnify token: the CRM can't be reached from here");
  const res = await fetch(`${platformBase(env)}/v1/apps/${encodeURIComponent(appId)}/proxy${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.CLAWNIFY_TOKEN}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text.slice(0, 200) };
  }
  if (!res.ok) throw new Error(`The CRM answered ${res.status}: ${(data as { error?: string }).error ?? "no reason given"}`);
  return data as T;
}

export interface CrmContact {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  title?: string | null;
  phone?: string | null;
  company_name?: string | null;
  company_domain?: string | null;
}

export async function crmContactsPage(
  env: PlatformEnv,
  appId: string,
  opts: { page: number; search?: string },
): Promise<{ contacts: CrmContact[]; total: number; page: number; limit: number }> {
  const q = new URLSearchParams({ page: String(opts.page), limit: "50" });
  if (opts.search) q.set("search", opts.search);
  return crmFetch(env, appId, "GET", `/api/contacts?${q}`);
}

/** The CRM contact for an address: the one with exactly that email, else a new one. */
export async function crmContactFor(
  env: PlatformEnv,
  appId: string,
  p: { email: string; first_name: string; last_name: string; title: string; phone: string },
): Promise<string> {
  const found = await crmContactsPage(env, appId, { page: 1, search: p.email });
  const match = found.contacts.find((c) => normaliseEmail(c.email) === p.email);
  if (match) return match.id;
  const created = await crmFetch<{ id?: string; contact?: { id?: string } }>(env, appId, "POST", "/api/contacts", {
    first_name: p.first_name || p.email.slice(0, p.email.indexOf("@")),
    last_name: p.last_name,
    email: p.email,
    title: p.title,
    phone: p.phone,
  });
  const id = created.id ?? created.contact?.id;
  if (!id) throw new Error("The CRM created the contact but did not return its id");
  return id;
}

/** A line on the contact's timeline. `email` counts toward its emails. */
export async function crmNote(env: PlatformEnv, appId: string, contactId: string, type: "email" | "note", text: string): Promise<void> {
  await crmFetch(env, appId, "POST", "/api/activities", { entity_type: "contact", entity_id: contactId, type, body: text });
}
