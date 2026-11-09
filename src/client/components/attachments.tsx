import { useState } from "react";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Attachment, Touch } from "@/types";

export function Attachments({ touchId, files, editable, onChange, onError, onBusy }: {
  touchId: string; files: Attachment[]; editable: boolean;
  onChange: (files: Attachment[]) => void; onError: (message: string) => void; onBusy: (busy: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<{ touch: Touch }>) => {
    setBusy(true); onBusy(true);
    try { onChange((await fn()).touch.attachments); }
    catch (e) { onError(e instanceof Error ? e.message : "Could not change attachments"); }
    finally { setBusy(false); onBusy(false); }
  };
  const upload = async (file: File) => {
    if (file.size > 5 * 1024 * 1024) throw new Error("Each attachment must be at most 5 MB.");
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = () => reject(new Error("Could not read this file."));
      reader.readAsDataURL(file);
    });
    return api<{ touch: Touch }>("POST", `/api/touches/${touchId}/attachments`, { name: file.name, content_type: file.type, data_base64: data });
  };
  return <section aria-label="Attachments" className="flex flex-col gap-3 px-4 py-3">
    <h3 className="text-sm font-medium">Attachments{files.length ? ` (${files.length})` : ""}</h3>
    {files.map((a) => <div key={a.id} className="flex min-w-0 flex-col gap-2 rounded-md bg-muted/30 p-3">
      {a.content_type.startsWith("image/") && <a href={a.url} target="_blank" rel="noreferrer"><img src={a.url} alt={a.name} className="max-h-64 max-w-full rounded-sm object-contain" /></a>}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <a href={a.url} download={a.name} className="min-w-0 break-all underline">{a.name}</a>
        <span className="text-muted-foreground">{Math.ceil(a.size / 1024)} KB</span>
        {a.source_url && <a href={a.source_url} target="_blank" rel="noreferrer" className="underline">Editable source</a>}
        {editable && <Button size="sm" variant="ghost" disabled={busy} aria-label={`Remove ${a.name}`}
          onClick={() => void act(() => api("DELETE", `/api/touches/${touchId}/attachments/${a.id}`))}>Remove</Button>}
      </div>
    </div>)}
    {editable && <div className="flex flex-col gap-1">
      <label htmlFor={`attachment-${touchId}`} className="text-sm">Add a file</label>
      <Input id={`attachment-${touchId}`} type="file" accept="image/png,image/jpeg,application/pdf" disabled={busy || files.length >= 5}
        onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void act(() => upload(file)); }} />
      <p className="text-xs text-muted-foreground">PNG, JPEG or PDF. Up to 5 MB each and 10 MB per email. Review the files before approving.</p>
    </div>}
  </section>;
}
