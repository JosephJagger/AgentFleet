// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ClaudeControls } from "./ClaudeControls";
import type { ClaudeSettings } from "../lib/claude-preferences";

afterEach(() => { cleanup(); vi.useRealTimers(); });
const models = [
  { model: "claude-sonnet-5-5", displayName: "Sonnet", efforts: ["low", "high"], supportsAutoMode: true },
  { model: "claude-haiku-4-5", displayName: "Haiku", efforts: [], supportsAutoMode: false },
];
function setup(settings: ClaudeSettings = { model: "host", mode: "default" }, permissionModes: string[] = []) {
  vi.useFakeTimers();
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function () { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function () { this.removeAttribute("open"); } });
  const save = vi.fn().mockResolvedValue(undefined);
  render(<ClaudeControls settings={settings} models={models} permissionModes={permissionModes} ready error="" onReload={() => {}} onSave={save} disabled={false} openRequest={1} />);
  return save;
}
it("saves a model on hosts without permission-mode metadata without submitting a permission override", async () => {
  const save = setup();
  expect((screen.getByRole("combobox", { name: "Claude Code 权限模式" }) as HTMLSelectElement).disabled).toBe(true);
  fireEvent.change(screen.getByRole("combobox", { name: "Claude Code 模型" }), { target: { value: "claude-sonnet-5-5" } });
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  expect(save).toHaveBeenCalledTimes(1);
  expect(JSON.parse(JSON.stringify(save.mock.calls[0][0]))).toEqual({ model: "claude-sonnet-5-5", mode: "default" });
});
it("explicit Save also preserves inherited permissions when switching back to the host model", async () => {
  const save = setup({ model: "claude-sonnet-5-5", effort: "high" });
  fireEvent.change(screen.getByRole("combobox", { name: "Claude Code 模型" }), { target: { value: "host" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "保存" })); });
  expect(JSON.parse(JSON.stringify(save.mock.calls[0][0]))).toEqual({ model: "host" });
});
it.each(["default", "acceptEdits", "dontAsk", "auto"] as const)("retains an explicitly selected %s permission when changing to a compatible model", async permissionMode => {
  const save = setup({ model: "host", permissionMode }, ["default", "auto", "acceptEdits", "dontAsk"]);
  fireEvent.change(screen.getByRole("combobox", { name: "Claude Code 模型" }), { target: { value: "claude-sonnet-5-5" } });
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  expect(save.mock.calls[0][0].permissionMode).toBe(permissionMode);
});
it("still resets explicit auto approval when switching to a model without auto support", async () => {
  const save = setup({ model: "claude-sonnet-5-5", permissionMode: "auto" }, ["default", "auto"]);
  fireEvent.change(screen.getByRole("combobox", { name: "Claude Code 模型" }), { target: { value: "claude-haiku-4-5" } });
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  expect(save.mock.calls[0][0].permissionMode).toBe("default");
});
