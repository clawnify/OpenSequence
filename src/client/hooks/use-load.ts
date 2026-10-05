import { useCallback, useEffect, useRef, useState } from "react";
import { useHostChanges } from "@clawnify/app/client";
import { api } from "../api";
import { useApp } from "../context";

/**
 * GET a path and keep it fresh: again whenever the path changes, and after the
 * Clawnify chat writes through the API. `path` null loads nothing.
 */
export function useLoad<T>(path: string | null) {
  const { setError } = useApp();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const latest = useRef(path);
  latest.current = path;

  const reload = useCallback(async () => {
    if (!path) {
      setData(null);
      return;
    }
    setLoading(true);
    try {
      const d = await api<T>("GET", path);
      if (latest.current === path) setData(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load");
    } finally {
      if (latest.current === path) setLoading(false);
    }
  }, [path, setError]);

  useEffect(() => {
    void reload();
  }, [reload]);
  useHostChanges(() => {
    void reload();
  });

  return { data, setData, loading, reload };
}
