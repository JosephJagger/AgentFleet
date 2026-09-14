import type { Machine } from "./types";

export const hasLiveTransport = (machine: Machine): boolean =>
  machine.identity !== "revoked" && (machine.reachability === "live" || machine.reachability === "reconciling");

/** Stable partition: connection changes reorder cards without mutating shared data. */
export function onlineFirst(machines: readonly Machine[]): Machine[] {
  return [...machines.filter(hasLiveTransport), ...machines.filter(machine => !hasLiveTransport(machine))];
}
