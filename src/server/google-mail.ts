// Google Workspace exposes the same Gmail API as a dedicated Gmail connection.
// Keep provider-native reads normalized to the shape the sequence engine uses.
import { connect, type ConnectionsEnv } from "@clawnify/connections";
import type { Mail } from "./integrations.js";
import type { GmailMessage } from "./sequence-rules.js";
import { sendAttached } from "./attachments.js";

type Part = { mimeType?: string; filename?: string; headers?: Array<{ name?: string; value?: string }>; body?: { data?: string }; parts?: Part[] };
type Message = { id?: string; threadId?: string; labelIds?: string[]; internalDate?: string; snippet?: string; payload?: Part };
function text(part: Part | undefined, type: string): string {
  if (!part || part.filename) return "";
  if (part.mimeType === type && part.body?.data) {
    const encoded = part.body.data.replace(/-/g, "+").replace(/_/g, "/");
    return new TextDecoder().decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)));
  }
  return (part.parts ?? []).map((p) => text(p, type)).filter(Boolean).join("\n");
}
export function gmailMessage(m: Message): GmailMessage {
  const h = (name: string) => m.payload?.headers?.find((h) => h.name?.toLowerCase() === name)?.value;
  return { messageId: m.id, threadId: m.threadId, labelIds: m.labelIds,
    messageTimestamp: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : undefined,
    sender: h("from"), to: h("to"), subject: h("subject"), payload: m.payload,
    messageText: text(m.payload, "text/plain") || text(m.payload, "text/html") || m.snippet || "" };
}
export function googleMail(env: ConnectionsEnv, address: string, account?: string): Mail {
  const client = connect("googlesuper", env, account ? { account } : undefined);
  const raw: NonNullable<Mail["raw"]> = (req) => client.rawRequest(req);
  const get = (path: string, params: Record<string, unknown> = {}) => raw({ method: "GET", endpoint: `/gmail/v1/users/me/${path}`,
    parameters: Object.entries(params).filter(([, v]) => v !== undefined).map(([name, value]) => ({ name, value: String(value), in: "query" as const })) });
  const mail: Mail = { address, raw, async run(action, args) {
    switch (action) {
      case "GET_PROFILE": return get("profile");
      case "SETTINGS_SEND_AS_GET": return get(`settings/sendAs/${encodeURIComponent(String(args.send_as_email))}`);
      case "FETCH_MESSAGE_BY_THREAD_ID": {
        const thread = await get(`threads/${encodeURIComponent(String(args.thread_id))}`, { format: "full" }) as { messages?: Message[] };
        return { messages: (thread.messages ?? []).map(gmailMessage) };
      }
      case "FETCH_MESSAGE_BY_MESSAGE_ID": return gmailMessage(await get(`messages/${encodeURIComponent(String(args.message_id))}`, { format: "full" }) as Message);
      case "FETCH_EMAILS": {
        const page = await get("messages", { q: args.query, maxResults: args.max_results, pageToken: args.page_token }) as { messages?: Message[]; nextPageToken?: string };
        // Recovery needs subject/date; bounce detection needs sender even outside
        // known threads. Gmail list only returns ids, so read metadata in bounded batches.
        const messages: GmailMessage[] = [];
        const found = page.messages ?? [];
        for (let i = 0; i < found.length; i += 10) {
          messages.push(...await Promise.all(found.slice(i, i + 10).map(async (m) =>
            gmailMessage(await get(`messages/${encodeURIComponent(m.id!)}`, { format: "metadata" }) as Message))));
        }
        return { messages, nextPageToken: page.nextPageToken };
      }
      case "SEND_EMAIL": case "REPLY_TO_THREAD": {
        const sent = await sendAttached(mail, String(args.recipient_email), action === "SEND_EMAIL" ? String(args.subject) : null,
          String(action === "SEND_EMAIL" ? args.body : args.message_body), !!args.is_html, [], action === "REPLY_TO_THREAD" ? String(args.thread_id) : null);
        return { id: sent.messageId, threadId: sent.threadId };
      }
      default: throw new Error(`Unsupported Gmail operation: ${action}`);
    }
  } };
  return mail;
}
