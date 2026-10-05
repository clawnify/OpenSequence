// HTML in signatures and sent emails, as the screens show it. Nothing here
// puts HTML into the app's own page: SignaturePreview renders it in a sandbox.

/** Whether text is HTML: the same test the server uses to send an email as
 *  HTML (sequence-rules.ts). "Sam <sam@ourco.io>" is plain text. */
const HTML_TAG = /<\/?(a|b|br|div|p|span|img|table|tbody|thead|tr|td|th|font|strong|em|i|u|s|ul|ol|li|hr|h[1-6]|small|sub|sup|blockquote|center|html|body|meta|style)\b[^<>@]*>/i;

export function isHtml(text: string): boolean {
  return HTML_TAG.test(text);
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Plain text as HTML that reads the same: escaped, line breaks kept. */
export function textToHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]).replace(/\r\n?/g, "\n").replace(/\n/g, "<br>");
}

const ENTITIES: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

/** HTML read as text, for a quick look at an email that went out. Each block
 *  starts a line, as browsers and Gmail write them ("Sam<div>OurCo</div>");
 *  a <br> that only holds an empty line open is not a line of its own. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>(?=\s*<\/(div|p)>)/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<(div|p|tr|li|h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(lt|gt|amp|quot|#39|nbsp);/g, (e) => ENTITIES[e] ?? e)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * A signature from the editor's HTML: plain text when its only markup is line
 * breaks and plain blocks, so a signature without formatting keeps its emails
 * plain text. The input is always read as HTML ("Sam &amp; Co" is "Sam & Co").
 */
export function simplify(html: string): string {
  const t = html.trim();
  return /<(?!\/?(?:br|div|p)\s*\/?>)[^>]*>/i.test(t) ? t : htmlToText(t);
}
