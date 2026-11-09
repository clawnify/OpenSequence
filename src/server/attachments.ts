import { createMimeMessage } from "mimetext/browser";
import type { Mail, Sent } from "./integrations.js";

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 5;
export interface Attachment {
  id: string;
  name: string;
  content_type: string;
  size: number;
  sha256: string;
  source_url: string | null;
}
export type AttachmentStore = Pick<R2Bucket, "put" | "get" | "delete">;
export const attachmentKey = (touch: string, id: string) => `attachments/${touch}/${id}`;
export const attachmentsOf = (value: string | null | undefined): Attachment[] => JSON.parse(value || "[]");
export const attachmentView = (touch: string, a: Attachment) => ({ ...a, url: `/api/touches/${touch}/attachments/${a.id}` });
export const attachmentIds = (value: string | null | undefined) => attachmentsOf(value).map((a) => a.id);
export function matchesAttachments(value: string, expected: unknown): boolean {
  const ids = attachmentIds(value);
  return JSON.stringify(ids) === JSON.stringify(expected ?? []);
}

export function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}

export async function decodeAttachment(input: { name: string; content_type: string; data_base64: string; source_url?: string }) {
  const name = input.name.trim();
  if (!name || name.length > 150 || /[\x00-\x1f\x7f"\\/]/.test(name)) throw new Error("Use a filename without slashes, quotes or control characters (up to 150 characters).");
  if (!input.data_base64 || input.data_base64.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 || input.data_base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data_base64)) throw new Error("Provide a base64 file of at most 5 MB.");
  const bytes = Uint8Array.from(atob(input.data_base64), (c) => c.charCodeAt(0));
  if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw new Error("Each file must be between 1 byte and 5 MB.");
  const starts = (sig: number[]) => sig.every((v, i) => bytes[i] === v);
  const valid = input.content_type === "image/png" ? starts([137,80,78,71,13,10,26,10])
    : input.content_type === "image/jpeg" ? starts([255,216,255])
    : input.content_type === "application/pdf" ? starts([37,80,68,70,45]) : false;
  if (!valid) throw new Error("Only PNG, JPEG and PDF files with matching content types are supported.");
  let source: string | null = null;
  if (input.source_url) {
    const u = new URL(input.source_url);
    if (u.protocol !== "https:" || u.username || u.password || u.href.length > 2000) throw new Error("The editable source must be an HTTPS URL without credentials.");
    source = u.href;
  }
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
  return { bytes, meta: { id: crypto.randomUUID(), name, content_type: input.content_type, size: bytes.length, sha256, source_url: source } satisfies Attachment };
}

export async function loadAttachments(store: AttachmentStore | undefined, touch: string, value: string) {
  const attachments = attachmentsOf(value);
  if (attachments.length && !store) throw new Error("Attachment storage is unavailable. Nothing was sent.");
  const files: Array<Attachment & { data: string }> = [];
  for (const a of attachments) {
    const obj = await store!.get(attachmentKey(touch, a.id));
    if (!obj) throw new Error(`Attachment missing: ${a.name}. Add it again and review the email.`);
    const bytes = new Uint8Array(await obj.arrayBuffer());
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
    if (bytes.length !== a.size || digest !== a.sha256) throw new Error(`Attachment changed: ${a.name}. Add it again and review the email.`);
    files.push({ ...a, data: base64(bytes) });
  }
  return files;
}

/** Gmail's own MIME send preserves attachments in new mail and in-thread replies. */
export async function sendAttached(mail: Mail, to: string, subject: string | null, body: string, html: boolean,
  files: Array<Attachment & { data: string }>, threadId: string | null): Promise<Sent> {
  if (!mail.raw) throw new Error("This mailbox cannot send attachments.");
  const msg = createMimeMessage();
  msg.setSender(mail.address);
  msg.setTo(to);
  if (threadId) {
    const thread = await mail.raw({ method: "GET", endpoint: `/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}`,
      parameters: [{ name: "format", value: "metadata", in: "query" }] }) as { messages?: Array<{ payload?: { headers?: Array<{ name: string; value: string }> } }> };
    const headers = thread.messages?.at(-1)?.payload?.headers ?? [];
    const header = (name: string) => headers.find((h) => h.name.toLowerCase() === name)?.value.replace(/[\r\n]+/g, " ").trim() ?? "";
    const parent = header("message-id");
    subject = header("subject");
    if (!parent || !subject) throw new Error("The original email's reply headers are missing. Nothing was sent.");
    msg.setHeader("In-Reply-To", parent);
    msg.setHeader("References", [header("references"), parent].filter(Boolean).join(" "));
  }
  msg.setSubject(subject || "");
  msg.addMessage({ contentType: html ? "text/html" : "text/plain", encoding: "base64", data: base64(new TextEncoder().encode(body)).match(/.{1,76}/g)!.join("\r\n") });
  for (const a of files) msg.addAttachment({ filename: a.name, contentType: a.content_type, data: a.data.match(/.{1,76}/g)!.join("\r\n") });
  const sent = await mail.raw({ method: "POST", endpoint: "/gmail/v1/users/me/messages/send", body: { raw: msg.asEncoded(), ...(threadId ? { threadId } : {}) } }) as { id?: string; threadId?: string };
  if (!sent.id || !sent.threadId) throw new Error("Gmail accepted the email but did not return its message and thread");
  return { messageId: sent.id, threadId: sent.threadId };
}
