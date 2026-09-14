// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { mapMachineReachability } from "./api";

describe("machine reachability mapping", () => {
  it("distinguishes an open-transport reconciliation from a real reconnect", () => {
    expect(mapMachineReachability("reconnecting", "reconciliation_pending")).toBe("reconciling");
    expect(mapMachineReachability("reconnecting", "connection_closed")).toBe("reconnecting");
    expect(mapMachineReachability("reconnecting", "control_plane_restarted")).toBe("reconnecting");
  });
});
