import { X } from "lucide-react";
import { useApp } from "../context";

export function ErrorBanner() {
  const { error, setError } = useApp();
  if (!error) return null;
  return (
    <div role="alert" className="fixed bottom-4 left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-md bg-destructive-tint px-4 py-2.5 text-sm text-destructive shadow-float">
      <span>{error}</span>
      <button onClick={() => setError(null)} aria-label="Dismiss error" className="text-destructive/70 hover:text-destructive">
        <X className="size-4" />
      </button>
    </div>
  );
}
