import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Bold, Italic, Link2, RemoveFormatting, Underline } from "lucide-react";
import { cn } from "@/lib/utils";
import { isHtml, simplify, textToHtml } from "@/lib/html";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** The frame's page: the signature, in the app's own font and text colour. */
function frameDoc(body: string): string {
  const page = getComputedStyle(document.body);
  const probe = document.createElement("span");
  probe.className = "text-foreground";
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  const css = `html,body{margin:0;min-height:100%}body{padding:10px 12px;font-family:${page.fontFamily};font-size:${page.fontSize};line-height:1.5;color:${color};overflow-wrap:anywhere;outline:none}img{max-width:100%;height:auto}`;
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>${css}</style></head><body>${body}</body></html>`;
}

const SAFE_LINK = /^(https?:|mailto:|tel:)/i;

/**
 * Edits a signature the way Gmail's settings do, with its HTML a switch away.
 * Visual: the signature, editable, in a sandboxed frame where nothing in it can
 * run (a pasted script would act as whoever views the app). Pasting formatted
 * text keeps its formatting. Code: the HTML itself. Saved when you leave it;
 * the server cleans what it is sent.
 */
export function SignatureEditor({ value, onSave, disabled }: { value: string; onSave: (v: string) => Promise<void>; disabled?: boolean }) {
  const [mode, setMode] = useState<"visual" | "code">("visual");
  const [seed, setSeed] = useState(value);
  const [code, setCode] = useState(value);
  const [height, setHeight] = useState(96);
  const [link, setLink] = useState("");
  const [linkOpen, setLinkOpen] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  /** The signature as it would be saved: plain text or HTML. */
  const latest = useRef(value);
  // While the link box is open it holds the focus, and the frame keeps the
  // selection the link is for. Saving then could reload the frame and lose it,
  // so the save waits for the box to close.
  const linking = useRef(false);

  // A new value from outside (another signature picked, Gmail's copied in, the
  // server's cleaned version) reloads the editor; our own typing doesn't.
  useEffect(() => {
    if (latest.current !== value) {
      latest.current = value;
      setSeed(value);
      setCode(value);
    }
  }, [value]);

  const doc = useMemo(() => frameDoc(isHtml(seed) ? seed : textToHtml(seed)), [seed]);

  const commit = async (next: string) => {
    latest.current = next;
    if (next !== value) await onSave(next);
  };
  // The frame's listeners are added once per load: they call the newest commit.
  const commitRef = useRef(commit);
  commitRef.current = commit;

  // Typed in Code: HTML when it is HTML, else plain text exactly as typed ("Sam <sam@ourco.io>").
  const fromCode = (v: string) => (isHtml(v) ? simplify(v) : v.trim());

  const onLoad = () => {
    const d = frame.current?.contentDocument;
    const w = frame.current?.contentWindow;
    if (!d || !w) return;
    d.designMode = disabled ? "off" : "on";
    const fit = () => setHeight(Math.max(96, Math.min(480, d.documentElement.scrollHeight)));
    fit();
    d.addEventListener("input", () => {
      latest.current = simplify(d.body.innerHTML);
      fit();
    });
    w.addEventListener("blur", () => {
      if (!linking.current) void commitRef.current(simplify(d.body.innerHTML));
    });
  };

  // Saved when the editor loses focus, not per command: saving reloads the
  // frame with the server's cleaned copy, which would drop the cursor mid-edit.
  const exec = (command: string, arg?: string) => {
    const d = frame.current?.contentDocument;
    if (!d) return;
    frame.current?.contentWindow?.focus();
    d.execCommand(command, false, arg);
    latest.current = simplify(d.body.innerHTML);
  };

  const openLink = (open: boolean) => {
    linking.current = open;
    setLinkOpen(open);
    if (open) return;
    setLink("");
    // Linked: the frame has the focus again and saves when it loses it.
    // Closed without a link: save what was typed before it opened.
    if (!frame.current?.contentDocument?.hasFocus()) void commit(latest.current);
  };

  const addLink = () => {
    const raw = link.trim();
    const url = SAFE_LINK.test(raw) ? raw : raw.includes("@") && !raw.includes("/") ? `mailto:${raw}` : `https://${raw}`;
    if (raw) exec("createLink", url);
    openLink(false);
  };

  // The tabs switch on mouse-down, which removes the frame or the code box
  // before it can lose the focus, so switching saves.
  const switchTo = (next: "visual" | "code") => {
    if (next === mode) return;
    const v = next === "code" ? latest.current : fromCode(code);
    if (next === "code") setCode(v);
    else setSeed(v);
    setMode(next);
    void commit(v);
  };

  // Toolbar buttons keep the focus in the frame, so the selection they act on survives the click.
  const keepFocus = (e: MouseEvent) => e.preventDefault();
  const tool = (label: string, Icon: typeof Bold, command: string) => (
    <Button type="button" size="icon" variant="ghost" aria-label={label} title={label} disabled={disabled} onMouseDown={keepFocus} onClick={() => exec(command)}>
      <Icon />
    </Button>
  );

  return (
    <div className="flex flex-col rounded-md bg-card shadow-edge">
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1">
        {mode === "visual" && (
          <>
            {tool("Bold", Bold, "bold")}
            {tool("Italic", Italic, "italic")}
            {tool("Underline", Underline, "underline")}
            <Popover open={linkOpen} onOpenChange={openLink}>
              <PopoverTrigger asChild>
                <Button type="button" size="icon" variant="ghost" aria-label="Link" title="Link the selected text" disabled={disabled} onMouseDown={keepFocus}>
                  <Link2 />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="flex w-72 gap-2 p-2">
                <Input aria-label="Link address" placeholder="https://… or an email" value={link} autoFocus
                  onChange={(e) => setLink(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addLink(); } }} />
                <Button type="button" size="sm" onClick={addLink}>Link</Button>
              </PopoverContent>
            </Popover>
            {tool("Clear formatting", RemoveFormatting, "removeFormat")}
          </>
        )}
        <Tabs value={mode} onValueChange={(v) => switchTo(v as "visual" | "code")} className="ml-auto">
          <TabsList className="h-7">
            <TabsTrigger value="visual" className="h-[1.375rem] px-2 text-[0.8125rem]">Visual</TabsTrigger>
            <TabsTrigger value="code" className="h-[1.375rem] px-2 text-[0.8125rem]">Code</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {mode === "visual" ? (
        <iframe
          key={seed}
          ref={frame}
          title="Signature"
          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          srcDoc={doc}
          onLoad={onLoad}
          style={{ height }}
          className="block w-full border-0 bg-transparent"
        />
      ) : (
        <Textarea
          aria-label="Signature HTML"
          rows={8}
          value={code}
          disabled={disabled}
          spellCheck={false}
          onChange={(e) => setCode(e.target.value)}
          onBlur={() => void commit(fromCode(code))}
          className={cn("rounded-none bg-transparent font-mono text-[0.8125rem] shadow-none focus-visible:ring-0 focus-visible:ring-offset-0")}
          placeholder={"Sam de Vries<br>\n<a href=\"https://ourco.example\">ourco.example</a>"}
        />
      )}
    </div>
  );
}
