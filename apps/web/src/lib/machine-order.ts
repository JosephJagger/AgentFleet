import type { Machine } from "./types";

/** Stable partition: connection changes reorder cards without mutating shared data. */
export function onlineFirst(machines: readonly Machine[]): Machine[] {
  const online = (machine: Machine) => machine.reachability === "live" && machine.identity !== "revoked";
  return [...machines.filter(online), ...machines.filter(machine => !online(machine))];
}
