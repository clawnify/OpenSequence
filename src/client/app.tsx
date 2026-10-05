import { useCallback, useEffect, useMemo, useState } from "react";
import { AppNav, reportLocation, useChatCommands, useHostChanges, useHostNavigate, type AppNavItem } from "@clawnify/app/client";
import { api } from "./api";
import { AppContext, type AppState } from "./context";
import { useRouter, type Route } from "./hooks/use-router";
import { ErrorBanner } from "./components/error-banner";
import { TooltipProvider } from "./components/ui/tooltip";
import { ReviewPage } from "./components/review/review-page";
import { RepliesPage } from "./components/replies/replies-page";
import { CampaignsPage } from "./components/campaigns/campaigns-page";
import { CampaignPage } from "./components/campaigns/campaign-page";
import { PeoplePage } from "./components/people/people-page";
import { PersonPage } from "./components/people/person-page";
import { SettingsPage } from "./components/settings/settings-page";
import type { Overview } from "./types";

// One definition of the navigation. <AppNav> paints it as this app's own
// sidebar when opened directly, and hands it to the Clawnify dashboard's
// sidebar when embedded there.
const MAIN: AppNavItem[] = [
  // The app opens on the review queue. This hidden item is what the app's name opens.
  { id: "home", label: "Review", href: "/", home: true },
  { id: "review", label: "Review", href: "/review", icon: "check-square", color: "blue" },
  { id: "replies", label: "Replies", href: "/replies", icon: "inbox", color: "green" },
  { id: "campaigns", label: "Campaigns", href: "/campaigns", icon: "send", color: "violet" },
  { id: "people", label: "People", href: "/people", icon: "users", color: "orange" },
];
const SETTINGS: AppNavItem[] = [{ id: "settings", label: "Settings", href: "/settings", icon: "settings" }];

function activeFor(route: Route): string {
  if (route.name === "campaign") return "campaigns";
  if (route.name === "person") return "people";
  return route.name;
}

// The chat's "/" menu while the app is open. Prompts name nothing someone else typed.
const COMMANDS = [
  {
    id: "research-queue",
    label: "Research the waiting drafts",
    prompt: "In OpenSequence, take the touches waiting for research: research each person, write the email, and hand each draft in for my approval. Never approve or send anything.",
  },
  {
    id: "find-people",
    label: "Find people for a campaign",
    prompt: "Find people who fit one of my OpenSequence campaigns. Ask me which campaign and how many, then add them to it with what you found about each in their notes.",
  },
  {
    id: "new-campaign",
    label: "Set up a campaign",
    prompt: "Help me set up a new campaign in OpenSequence: ask who it is for and why, then create it with its steps for me to review.",
  },
  {
    id: "replies",
    label: "Go through the replies",
    prompt: "Go through the replies in OpenSequence nobody has dealt with yet, and suggest a next step for each.",
  },
];

export function App() {
  const { path, route, navigate } = useRouter();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setOverview(await api<Overview>("GET", "/api/overview"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Lets the dashboard restore this exact screen on reload.
  useEffect(() => {
    reportLocation(path);
  }, [path]);

  // The Clawnify chat opens pages through our router, and after it writes
  // through the API the counts read again (each screen reloads its own data).
  useHostNavigate((to) => navigate(to));
  useHostChanges(() => {
    void refresh();
  });
  useChatCommands(COMMANDS);

  const state = useMemo<AppState>(() => ({ overview, refresh, error, setError }), [overview, refresh, error]);

  const counts: Record<string, number> = { review: overview?.counts.review ?? 0, replies: overview?.counts.replies ?? 0 };
  const groups = [
    { items: MAIN.map((n) => (counts[n.id] ? { ...n, count: counts[n.id] } : n)) },
    { label: "Settings", items: SETTINGS },
  ];

  return (
    <AppContext.Provider value={state}>
      <TooltipProvider delayDuration={200}>
        <div className="flex h-screen min-h-0 flex-col overflow-hidden bg-background text-foreground md:flex-row">
          <div className="relative flex shrink-0">
            <AppNav title="OpenSequence" icon="send" groups={groups} active={activeFor(route)} onNavigate={(item) => navigate(item.href ?? "/")} />
          </div>
          <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {route.name === "review" && <ReviewPage tab={route.tab} touchId={route.touch} navigate={navigate} />}
            {route.name === "replies" && <RepliesPage show={route.show} navigate={navigate} />}
            {route.name === "campaigns" && <CampaignsPage navigate={navigate} />}
            {route.name === "campaign" && <CampaignPage key={route.id} id={route.id} navigate={navigate} />}
            {route.name === "people" && <PeoplePage navigate={navigate} />}
            {route.name === "person" && <PersonPage key={route.id} id={route.id} navigate={navigate} />}
            {route.name === "settings" && <SettingsPage />}
            {route.name === "not-found" && (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 p-12 text-center">
                <h1 className="text-xl font-semibold">Not found</h1>
                <p className="text-sm text-muted-foreground">That page doesn't exist.</p>
                <button className="text-sm text-primary hover:underline" onClick={() => navigate("/")}>Back to the review queue</button>
              </div>
            )}
          </main>
          <ErrorBanner />
        </div>
      </TooltipProvider>
    </AppContext.Provider>
  );
}
