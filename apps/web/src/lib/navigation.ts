import { sessionFromPath, sessionPath } from "./session-workspace";

export type View = "fleet" | "hosts" | "approvals" | "scheduled" | "usage" | "security" | "admin";
export interface AppRoute { view: View; machineId?: string; sessionId?: string; eventId?: string }

export function routeFromPath(pathname: string, search = ""): AppRoute {
  const sessionId = sessionFromPath(pathname);
  if (sessionId) {
    const eventId = new URLSearchParams(search).get("event");
    return { view: "fleet", sessionId, ...(eventId && eventId.length <= 200 ? { eventId } : {}) };
  }
  if (/^\/admin\/?$/.test(pathname)) return { view: "admin" };
  if (/^\/settings\/?$/.test(pathname)) return { view: "security" };
  if (/^\/approvals\/?$/.test(pathname)) return { view: "approvals" };
  if (/^\/scheduled\/?$/.test(pathname)) return { view: "scheduled" };
  const match = /^\/(hosts|workbench|usage)(?:\/([^/]+))?\/?$/.exec(pathname);
  if (match) {
    const view = match[1] === "hosts" ? "hosts" : match[1] === "usage" ? "usage" : "fleet";
    try { return { view, ...(match[2] ? { machineId: decodeURIComponent(match[2]) } : {}) }; }
    catch { return { view }; }
  }
  return { view: "fleet" };
}

export function routePath(route: AppRoute): string {
  if (route.view === "admin") return "/admin";
  if (route.view === "security") return "/settings";
  if (route.view === "approvals") return "/approvals";
  if (route.view === "scheduled") return "/scheduled";
  if (route.view === "usage") return route.machineId ? `/usage/${encodeURIComponent(route.machineId)}` : "/usage";
  if (route.view === "fleet" && route.sessionId) return sessionPath(route.sessionId) + (route.eventId ? `?${new URLSearchParams({ event:route.eventId })}` : "");
  const base = route.view === "hosts" ? "/hosts" : "/workbench";
  return route.machineId ? `${base}/${encodeURIComponent(route.machineId)}` : base;
}
