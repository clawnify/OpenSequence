import { useState, useEffect, useCallback } from "react";

export type ReviewTab = "review" | "research" | "drafting" | "todo" | "approved";

export type Route =
  | { name: "review"; tab: ReviewTab; touch?: string }
  | { name: "replies"; show: "open" | "all" }
  | { name: "campaigns" }
  | { name: "campaign"; id: string }
  | { name: "people" }
  | { name: "person"; id: string }
  | { name: "settings" }
  | { name: "not-found" };

const TABS: ReviewTab[] = ["review", "research", "drafting", "todo", "approved"];

function parse(pathname: string, search: string): Route {
  const q = new URLSearchParams(search);
  if (pathname === "/" || pathname === "/review") {
    const tab = TABS.includes(q.get("tab") as ReviewTab) ? (q.get("tab") as ReviewTab) : "review";
    return { name: "review", tab, touch: q.get("touch") || undefined };
  }
  if (pathname === "/replies") return { name: "replies", show: q.get("show") === "all" ? "all" : "open" };
  if (pathname === "/campaigns") return { name: "campaigns" };
  const cm = pathname.match(/^\/campaigns\/([^/]+)$/);
  if (cm) return { name: "campaign", id: decodeURIComponent(cm[1]) };
  if (pathname === "/people") return { name: "people" };
  const pm = pathname.match(/^\/people\/([^/]+)$/);
  if (pm) return { name: "person", id: decodeURIComponent(pm[1]) };
  if (pathname === "/settings") return { name: "settings" };
  return { name: "not-found" };
}

const current = () => window.location.pathname + window.location.search;

/** The current path with some query params set (or removed, with null); the rest kept. */
export function withQuery(changes: Record<string, string | null>): string {
  const q = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) q.delete(k);
    else q.set(k, v);
  }
  const s = q.toString();
  return window.location.pathname + (s ? `?${s}` : "");
}

export function useRouter() {
  const [path, setPath] = useState<string>(current);

  const navigate = useCallback((to: string, opts?: { replace?: boolean }) => {
    if (to === current()) return;
    if (opts?.replace) window.history.replaceState(null, "", to);
    else window.history.pushState(null, "", to);
    setPath(current());
  }, []);

  useEffect(() => {
    const handler = () => setPath(current());
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  const url = new URL(path, window.location.origin);
  return { path, route: parse(url.pathname, url.search), navigate };
}

export type Navigate = (to: string, opts?: { replace?: boolean }) => void;
