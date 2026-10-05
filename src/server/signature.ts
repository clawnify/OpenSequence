// An HTML signature, as pasted from Gmail's settings or a signature maker,
// cleaned to what an email signature needs. It is kept to an allow-list of
// tags and attributes, with links and images only over http(s), because the
// same HTML is shown inside the app, where a script would act as whoever views
// it. Parsed by the Workers runtime's own HTML parser (HTMLRewriter), not by
// pattern matching.

export const MAX_SIGNATURE = 10_000;

const ALLOWED = new Set([
  "a", "b", "strong", "i", "em", "u", "s", "br", "p", "div", "span", "img", "font", "hr", "small", "sub", "sup",
  "table", "thead", "tbody", "tr", "td", "th", "ul", "ol", "li", "blockquote", "center", "h1", "h2", "h3", "h4",
]);

/** Gone with everything inside them. */
const DROPPED = new Set([
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "form", "input", "button", "textarea",
  "select", "option", "noscript", "template", "svg", "math", "link", "meta", "base", "head", "title", "audio", "video",
  "source", "canvas",
]);

const ATTRIBUTES = new Set([
  "href", "src", "alt", "title", "width", "height", "style", "color", "face", "size", "align", "valign", "border",
  "cellpadding", "cellspacing", "colspan", "rowspan", "dir", "bgcolor", "target",
]);

const SAFE_URL = /^(https?:|mailto:|tel:)/i;
const SAFE_SRC = /^https?:/i;
const UNSAFE_STYLE = /expression\s*\(|url\s*\(|javascript:|@import|behavior\s*:/i;

export async function sanitizeSignature(html: string): Promise<string> {
  const rewriter = new HTMLRewriter()
    .on("*", {
      element(el) {
        const tag = el.tagName.toLowerCase();
        if (DROPPED.has(tag)) {
          el.remove();
          return;
        }
        if (!ALLOWED.has(tag)) {
          el.removeAndKeepContent();
          return;
        }
        // The runtime's attributes are [name, value] pairs; the project also loads
        // the browser's types, where Element.attributes means something else.
        for (const [name, value] of [...(el.attributes as unknown as Iterable<[string, string]>)]) {
          const attr = name.toLowerCase();
          const v = value.trim();
          const keep =
            ATTRIBUTES.has(attr) &&
            (attr !== "href" || SAFE_URL.test(v)) &&
            (attr !== "src" || SAFE_SRC.test(v)) &&
            (attr !== "style" || !UNSAFE_STYLE.test(v));
          if (!keep) el.removeAttribute(name);
        }
        // An image left without a safe address would show as a broken one.
        if (tag === "img" && !el.getAttribute("src")) {
          el.remove();
          return;
        }
        if (tag === "a" && el.getAttribute("href")) {
          el.setAttribute("target", "_blank");
          el.setAttribute("rel", "noopener noreferrer");
        }
      },
    })
    .onDocument({
      comments(c) {
        c.remove();
      },
    });
  const out = await rewriter.transform(new Response(html)).text();
  // A doctype can't be removed by the rewriter; it is the one thing cut by text.
  return out.replace(/<!DOCTYPE[^>]*>/gi, "").trim();
}
