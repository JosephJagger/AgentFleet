// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HostSshAccess } from "./components/HostSshAccess";
import type { Machine, SshAccount } from "./lib/types";
const mocks = vi.hoisted(() => ({ sshAccounts: vi.fn(), sshReachable: vi.fn(), saveSshAccount: vi.fn(), testSshAccount: vi.fn(), verifySshAccount: vi.fn(), deleteSshAccount: vi.fn() }));
vi.mock("./lib/api", () => ({ api: mocks }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const machine = (id: string, os = "linux 6.14") => ({ id, name: id, os } as Machine);
const account: SshAccount = {
  id: "ssh_1", machineId: "a", name: "qianyi", alias: "af-qianyi", algorithm: "ed25519", username: "deploy", address: "", port: 22, effectiveAddress: "10.0.0.8",
  publicKey: "ssh-ed25519 AAAA", fingerprint: "SHA256:abc", hasPrivateKey: true, hasPassphrase: false, hostKeyFingerprints: ["SHA256:host"],
  verification: { userExists: true, authorized: false }, description: "构建机", enabled: true, sources: [], delivered: [{ machineId: "b", ok: true, syncedAt: "" }], createdAt: "", updatedAt: "",
};

it("非 Linux 主机只显示暂不支持", () => {
  render(<HostSshAccess machine={machine("mac", "darwin 24")} machines={[]} canManage />);
  expect(screen.getByRole("status").textContent).toContain("暂仅支持 Linux");
  expect(mocks.sshAccounts).not.toHaveBeenCalled();
});

it("列出登记的账号、校验状态与可访问主机，并可测试连接", async () => {
  mocks.sshAccounts.mockResolvedValue({ accounts: [account] });
  mocks.sshReachable.mockResolvedValue({ accounts: [{ id: "ssh_2", alias: "af-db", targetName: "db", username: "ops", hostname: "10.0.0.9", port: 22, description: "" }] });
  mocks.testSshAccount.mockResolvedValue({ results: [{ machineId: "b", machineName: "b", ok: true, durationMs: 42 }] });
  render(<HostSshAccess machine={machine("a")} machines={[machine("a"), machine("b")]} canManage={false} />);
  expect(await screen.findByText("ssh af-qianyi")).toBeTruthy();
  expect(screen.getByText(/deploy@10\.0\.0\.8:22/)).toBeTruthy();
  expect(screen.getByText("公钥不在 authorized_keys")).toBeTruthy();
  expect(screen.getByText("已下发到 b")).toBeTruthy();
  expect(screen.getByText("ssh af-db")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "添加 SSH 账号" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
  expect(await screen.findByText("b → 连接成功（42 ms）")).toBeTruthy();
});

it("管理员添加账号时提交截图表单的字段", async () => {
  mocks.sshAccounts.mockResolvedValue({ accounts: [] });
  mocks.sshReachable.mockResolvedValue({ accounts: [] });
  mocks.saveSshAccount.mockResolvedValue({ account });
  render(<HostSshAccess machine={machine("a")} machines={[machine("a"), machine("b")]} canManage />);
  fireEvent.click(await screen.findByRole("button", { name: "添加 SSH 账号" }));
  fireEvent.change(screen.getByLabelText(/名称/), { target: { value: "qianyi" } });
  fireEvent.change(screen.getByLabelText(/用户名/), { target: { value: "deploy" } });
  fireEvent.change(screen.getByLabelText(/私钥 \*/), { target: { value: "-----BEGIN OPENSSH PRIVATE KEY-----" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await vi.waitFor(() => expect(mocks.saveSshAccount).toHaveBeenCalled());
  expect(mocks.saveSshAccount.mock.calls[0]![0]).toMatchObject({ machineId: "a", name: "qianyi", username: "deploy", algorithm: "ed25519", port: 22, sources: [] });
  expect(mocks.saveSshAccount.mock.calls[0]![0].passphrase).toBeUndefined();
});
