import { useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A signature's HTML as it will look in the email, in a sandboxed frame: no
 * script in it can run, and it can't reach the app (a script here would act
 * as whoever is looking). It takes the app's own font and text colour, read
 * from the page, so it sits in the screen like the rest.
 */
export function SignaturePreview({ html, muted, className }: { html: string; muted?: boolean; className?: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(24);
  const doc = useMemo(() => {
    const body = getComputedStyle(document.body);
    const probe = document.createElement("span");
    probe.className = muted ? "text-faint" : "text-foreground";
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    const css = `body{margin:0;font-family:${body.fontFamily};font-size:${body.fontSize};line-height:1.5;color:${color};overflow-wrap:anywhere}img{max-width:100%;height:auto}`;
    return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>${css}</style></head><body>${html}</body></html>`;
  }, [html, muted]);
  const fit = () => {
    const body = frame.current?.contentDocument?.body;
    if (body) setHeight(Math.min(480, body.scrollHeight + 2));
  };
  return (
    <iframe
      ref={frame}
      title="Signature preview"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={doc}
      onLoad={fit}
      style={{ height }}
      className={cn("block w-full border-0 bg-transparent", className)}
    />
  );
}
