// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EmailLoginForm } from "./EmailLoginForm";
import { api } from "../lib/api";
import { ApiError, type Dashboard } from "../lib/types";
import { setLocale } from "../i18n";

vi.mock("../lib/api", () => ({ api: { requestLoginCode: vi.fn(), verifyLoginCode: vi.fn() } }));
beforeEach(() => {
  setLocale("zh-CN"); sessionStorage.clear(); vi.clearAllMocks();
  vi.mocked(api.requestLoginCode).mockResolvedValue({ challengeId: "challenge", expiresIn: 600, resendAfter: 60 });
});
afterEach(() => { cleanup(); sessionStorage.clear(); vi.useRealTimers(); });

it("sends a code then logs in with the challenge, supports paste and change email", async () => {
  const onLogin = vi.fn(), dashboard = { user: { email: "user@example.com" } } as Dashboard;
  vi.mocked(api.verifyLoginCode).mockResolvedValue({ dashboard });
  render(<EmailLoginForm onLogin={onLogin} />);
  expect(screen.queryByLabelText("密码")).toBeNull();
  fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "user@example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "发送验证码" }));
  const code = await screen.findByLabelText("6 位验证码");
  expect(api.requestLoginCode).toHaveBeenCalledWith("user@example.com", "zh");
  expect((screen.getByRole("button", { name: /重新发送验证码/ }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(code, { target: { value: "12 34 56" } });
  fireEvent.click(screen.getByRole("button", { name: "验证并登录" }));
  await waitFor(() => expect(onLogin).toHaveBeenCalledWith(dashboard));
  expect(api.verifyLoginCode).toHaveBeenCalledWith("challenge", "123456");
  expect(sessionStorage.getItem("agentfleet.email-login")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "修改邮箱" }));
  expect((screen.getByLabelText("邮箱") as HTMLInputElement).value).toBe("user@example.com");
});

it("restores the challenge after reload, permits resend after cooldown and expires it", async () => {
  vi.useFakeTimers();
  sessionStorage.setItem("agentfleet.email-login", JSON.stringify({ challengeId: "restored", email: "u@example.com", expiresAt: Date.now() + 120000, resendAt: Date.now() + 60000 }));
  render(<EmailLoginForm onLogin={vi.fn()} />);
  expect(screen.getByLabelText("6 位验证码")).toBeTruthy();
  act(() => vi.advanceTimersByTime(60000));
  expect((screen.getByRole("button", { name: "重新发送验证码" }) as HTMLButtonElement).disabled).toBe(false);
  act(() => vi.advanceTimersByTime(60000));
  expect(screen.getByLabelText("邮箱")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("验证码已过期");
});

it("keeps the code step on a wrong code and shows a localized error", async () => {
  vi.mocked(api.verifyLoginCode).mockRejectedValue(new ApiError("Invalid", 401, "INVALID_OR_EXPIRED_CODE"));
  const onLogin = vi.fn();
  render(<EmailLoginForm onLogin={onLogin} />);
  fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "u@example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "发送验证码" }));
  fireEvent.change(await screen.findByLabelText("6 位验证码"), { target: { value: "111111" } });
  fireEvent.click(screen.getByRole("button", { name: "验证并登录" }));
  expect((await screen.findByRole("alert")).textContent).toContain("验证码无效或已过期");
  expect(onLogin).not.toHaveBeenCalled();
  expect(screen.getByLabelText("6 位验证码")).toBeTruthy();
});
