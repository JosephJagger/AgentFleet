import { useState } from "react";
import { api } from "../lib/api";
import type { FleetSession, Machine, CommandReceipt, HostOperation } from "../lib/types";

export function useCodexOperation({ session, machine, commands = [], hostOperations = [], onChanged }: {
  session?: FleetSession; machine?: Machine; commands?: CommandReceipt[]; hostOperations?: HostOperation[]; onChanged: () => void;
}) {
  const [id, setId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const receipt = commands.find(c => c.id === id);
  const host = hostOperations.find(c => c.id === id);
  const result = (host?.result?.codexResult as CommandReceipt["codexResult"]) ?? receipt?.codexResult;
  const pending = busy || !!id && !receipt && !host || !!receipt && ["accepted", "dispatching", "unknown"].includes(receipt.state) || !!host && ["accepted", "running", "unknown"].includes(host.state);
  const allowed = machine ? machine.reachability === "live" && machine.maintenanceCapabilities?.includes("codex.host") : session?.actions?.manage?.allowed;
  async function run(operation: string, args: Record<string, unknown> = {}) {
    if (pending || !allowed) return;
    setBusy(true); setError(""); setId(undefined);
    try {
      if (machine) {
        const response = await api.hostCodexOperation(machine.id, { operation, arguments: args }, crypto.randomUUID());
        setId(response.id);
      } else if (session) {
        const response = await api.command(session.id, { type: "codex.manage", clientMutationId: crypto.randomUUID(), payload: { operation, arguments: args }, precondition: {
          nativeThreadId: session.nativeThreadId, executionSegmentId: session.executionSegmentId, threadControlVersion: session.threadControlVersion, expectedActiveTurnId: session.activeTurnId ?? null, projectLeaseVersion: session.projectLeaseVersion,
        } });
        setId(response.command.id);
      }
      onChanged();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return { run, pending, allowed: !!allowed, result, id, error: error || host?.error?.message || receipt?.message || "" };
}
