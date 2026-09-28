// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
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
