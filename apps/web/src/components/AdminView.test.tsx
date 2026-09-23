// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AdminView } from "./AdminView";
import { api } from "../lib/api";
import { setLocale } from "../i18n";

vi.mock("./RuntimeReleasePanel", () => ({ RuntimeReleasePanel: () => <div>Runtime policy</div> }));
vi.mock("../lib/api", () => ({ api: { adminUsers: vi.fn(), adminUserAction: vi.fn(), release: vi.fn(), adminSystem: vi.fn() } }));
const guest = { id: "u2", email: "guest@example.test", platformAdmin: false, disabled: false, createdAt: "2026-09-01T00:00:00Z", lastLoginAt: null, machineCount: 2 };
beforeEach(() => {
  setLocale("en");
  vi.mocked(api.adminUsers).mockResolvedValue({ page: 1, pages: 2, total: 11, users: [{ ...guest, id: "owner", email: "owner@example.test", platformAdmin: true }, guest] });
  vi.mocked(api.adminUserAction).mockResolvedValue({ ok: true });
  vi.mocked(api.adminSystem).mockResolvedValue({ authMode: "email", registration: "email-verification" });
  vi.mocked(api.release).mockResolvedValue({ build: "abc1234", schema: 37, agentVersion: "0.30.45", manifestStatus: "ready" });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); setLocale("zh-CN"); });

it("admin user actions require explicit confirmation and the administrator is protected", async () => {
  render(<AdminView />);
  await screen.findByText(guest.email);
  expect(screen.getAllByRole("button", { name: "Disable account" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Disable account" }));
  expect(api.adminUserAction).not.toHaveBeenCalled();
  expect(screen.getByRole("group", { name: "Confirm account action" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(api.adminUserAction).toHaveBeenCalledWith("u2", "disable"));
  expect(await screen.findByText("Account updated")).toBeTruthy();
});

it("user list supports paging and searching without fetching conversations", async () => {
  render(<AdminView />);
  await screen.findByText(guest.email);
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() => expect(api.adminUsers).toHaveBeenLastCalledWith(2, "", expect.any(AbortSignal)));
  fireEvent.change(screen.getByRole("textbox", { name: "Search by email" }), { target: { value: "guest@" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await waitFor(() => expect(api.adminUsers).toHaveBeenLastCalledWith(1, "guest@", expect.any(AbortSignal)));
});
