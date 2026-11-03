import type { MachineSummary } from "./api-schema.js";

type Frame = { type: "machine.changed"; machine: MachineSummary }
  | { type: "machine.patch"; machineId: string; changes: Record<string, unknown>; removed: string[] };

/** Per-socket baselines: never share snapshots across users or transports. */
export class MachineUpdates {
  private readonly baselines = new Map<string, { fields: Record<string, string>; sentAt: number }>();
  readonly pending = new Set<string>();
  visible = true;

  constructor(readonly compact: boolean, private readonly send: (frame: Frame) => boolean) {}

  publish(machine: MachineSummary, now = Date.now()): void {
    if (!this.visible) { this.pending.add(machine.machineId); return; }
    const values = JSON.parse(JSON.stringify(machine)) as Record<string, unknown>;
    const fields = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, JSON.stringify(value)]));
    const previous = this.baselines.get(machine.machineId);
    const changes = Object.fromEntries(Object.entries(values).filter(([key]) => fields[key] !== previous?.fields[key]));
    const removed = Object.keys(previous?.fields ?? {}).filter(key => !(key in fields));
    const keys = Object.keys(changes);
    if (previous && !keys.length && !removed.length) return;
    // Old pages still receive compatible snapshots. Heartbeat-only changes do
    // not need to retransmit static catalogs every few seconds.
    if (!this.compact && previous && !removed.length && keys.every(key => key === "lastHeartbeatAt") && now - previous.sentAt < 60_000) return;
    const frame: Frame = this.compact && previous
      ? { type: "machine.patch", machineId: machine.machineId, changes, removed }
      : { type: "machine.changed", machine };
    if (this.send(frame)) this.baselines.set(machine.machineId, { fields, sentAt: now });
  }
}
