import { createContext, useContext } from "react";
import type { Overview } from "./types";

export interface AppState {
  /** The counts behind the nav badges, and whether sending is set up. */
  overview: Overview | null;
  refresh: () => Promise<void>;
  error: string | null;
  setError: (error: string | null) => void;
}

export const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const v = useContext(AppContext);
  if (!v) throw new Error("useApp outside AppContext");
  return v;
}
