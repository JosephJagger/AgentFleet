import { expect, it } from "vitest";
import { onlineFirst } from "./lib/machine-order";
import type { Machine } from "./lib/types";

it("keeps online hosts first without changing peer order or the source list", () => {
  const machines = [
    { id: "offline", reachability: "unreachable" },
    { id: "online-a", reachability: "live" },
    { id: "connecting", reachability: "connecting" },
    { id: "online-b", reachability: "live" },
    { id: "revoked", reachability: "live", identity: "revoked" },
  ] as Machine[];
  expect(onlineFirst(machines).map(machine => machine.id)).toEqual(["online-a", "online-b", "offline", "connecting", "revoked"]);
  expect(machines[0].id).toBe("offline");
  const reconnected = machines.map(machine => machine.id === "offline" ? { ...machine, reachability: "live" as const } : machine);
  expect(onlineFirst(reconnected).map(machine => machine.id)).toEqual(["offline", "online-a", "online-b", "connecting", "revoked"]);
});
