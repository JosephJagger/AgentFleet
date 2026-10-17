// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { api } from "../lib/api";
import { afterEach, expect, it, vi } from "vitest";
import { HostsView } from "./HostsView";
import type { Machine } from "../lib/types";

vi.mock("../lib/api", () => ({ api: { hostOperations: vi.fn().mockResolvedValue([]) } }));
vi.mock("./CodexSettingsPanel", () => ({ CodexSettingsPanel: () => <div>Settings</div> }));
vi.mock("./PermissionPanel", () => ({ PermissionPanel: () => null }));
vi.mock("./HostImageStorage", () => ({ HostImageStorage: () => null }));
vi.mock("./HostCodexInventory", () => ({ HostCodexInventory: () => null }));
vi.mock("./CodexCommandGuide", () => ({ CodexCommandGuide: () => null }));
vi.mock("./HostReadiness", () => ({ HostReadiness: () => null }));
vi.mock("./DiscoveryStatus", () => ({ DiscoveryStatus: () => null }));
afterEach(cleanup);

it("keeps one recovery panel when switching between offline hosts and removes it online", () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const host = (id: string, reachability: Machine["reachability"] = "unreachable") => ({ id, name: id, os: "win32", reachability } as Machine);
    const props = { onSelect: vi.fn(), onPair: vi.fn(), onRemove: vi.fn(), onChanged: vi.fn().mockResolvedValue(undefined), renderCompatibility: () => null };
    const view = (id: string, reachability?: Machine["reachability"]) => <HostsView {...props} machines={[host(id, reachability)]} selectedId={id} />;
    const { rerender } = render(view("office"));
    for (const id of ["home", "office", "home", "office"]) {
      rerender(view(id));
      expect(screen.getAllByRole("region", { name: "恢复主机连接" })).toHaveLength(1);
    }
    rerender(view("office", "live"));
    expect(screen.queryByRole("region", { name: "恢复主机连接" })).toBeNull();
    expect(errors.mock.calls.filter(args => args.some(arg => String(arg).includes("same key")))).toHaveLength(0);
  } finally { errors.mockRestore(); }
});

it("labels the recovery button as restoring only while a connection repair is actually running", async () => {
  const machine = { id: "home", name: "home", os: "darwin", reachability: "live", maintenanceCapabilities: ["connection.repair", "provider.runtime"] } as Machine;
  const props = { onSelect: vi.fn(), onPair: vi.fn(), onRemove: vi.fn(), onChanged: vi.fn().mockResolvedValue(undefined), renderCompatibility: () => null, machines: [machine], selectedId: "home" };
  const operation = (type: string) => ({ id: type, type, state: "running", createdAt: "2026-10-17T00:00:00Z", updatedAt: "2026-10-17T00:00:00Z" });
  vi.mocked(api.hostOperations).mockResolvedValue([operation("provider.runtime")] as never);
  const first = render(<HostsView {...props} />);
  const button = await screen.findByRole("button", { name: /一键恢复连接/ });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole("button", { name: /正在恢复/ })).toBeNull();
  first.unmount();
  vi.mocked(api.hostOperations).mockResolvedValue([operation("connection.repair")] as never);
  render(<HostsView {...props} />);
  expect(await screen.findByRole("button", { name: /正在恢复/ })).toBeTruthy();
});
