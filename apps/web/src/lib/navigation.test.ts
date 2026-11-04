import { describe, expect, it } from "vitest";
import { routeFromPath, routePath } from "./navigation";

describe("页面与主机路由", () => {
  it.each([
    ["/", { view: "fleet" }],
    ["/workbench/host-2", { view: "fleet", machineId: "host-2" }],
    ["/hosts", { view: "hosts" }],
    ["/hosts/host-2/", { view: "hosts", machineId: "host-2" }],
    ["/admin", { view: "admin" }],
    ["/settings", { view: "security" }],
    ["/approvals", { view: "approvals" }],
    ["/sessions/session-2", { view: "fleet", sessionId: "session-2" }],
  ])("解析 %s", (path, route) => expect(routeFromPath(path)).toEqual(route));
  it("主机 ID 编码并安全解码，名称变更不影响 URL", () => {
    const route = { view: "hosts" as const, machineId: "主机 / 2" };
    expect(routeFromPath(routePath(route))).toEqual(route);
    expect(routeFromPath("/hosts/%E0%A4%A")).toEqual({ view: "hosts" });
  });
});

it('keeps the exact message when reloading or going back to a search result',()=>{
  const route={view:'fleet' as const,sessionId:'remote-session',eventId:'event/历史:42'};
  const url=new URL(routePath(route),'https://example.test');
  expect(routeFromPath(url.pathname,url.search)).toEqual(route);
  expect(routeFromPath(url.pathname,'?event='+ 'x'.repeat(201))).toEqual({view:'fleet',sessionId:'remote-session'});
  expect(routePath({...route,eventId:undefined})).toBe('/sessions/remote-session');
});
