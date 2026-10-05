// HTML in signatures and sent emails, as the screens show it. Nothing here
// puts HTML into the app's own page: SignaturePreview renders it in a sandbox.

/** Whether text is HTML: the same test the server uses to send an email as
 *  HTML (sequence-rules.ts). "Sam <sam@ourco.io>" is plain text. */
const HTML_TAG = /<\/?(a|b|br|div|p|span|img|table|tbody|thead|tr|td|th|font|strong|em|i|u|s|ul|ol|li|hr|h[1-6]|small|sub|sup|blockquote|center|html|body|meta|style)\b[^<>@]*>/i;

export function isHtml(text: string): boolean {
  return HTML_TAG.test(text);
}

const ENTITIES: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

/** HTML read as text, for a quick look at an email that went out. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(lt|gt|amp|quot|#39|nbsp);/g, (e) => ENTITIES[e] ?? e)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** What was copied, from the HTML a browser puts on the clipboard: the marked
 *  fragment when there is one, else the body. */
export function clipboardFragment(html: string): string {
  const marked = /<!--StartFragment-->([\s\S]*?)<!--EndFragment-->/i.exec(html);
  if (marked) return marked[1].trim();
  return html.replace(/^[\s\S]*?<body[^>]*>/i, "").replace(/<\/body>[\s\S]*$/i, "").trim();
}
