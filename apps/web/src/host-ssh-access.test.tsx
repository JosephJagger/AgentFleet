// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HostSshAccess } from "./components/HostSshAccess";
import type { Machine, SshAccount, SshLinkMatrix, SshRelaySettings } from "./lib/types";
const mocks = vi.hoisted(() => ({ sshAccounts: vi.fn(), sshLinks: vi.fn(), sshRelay: vi.fn(), saveSshRelay: vi.fn(), sshReachable: vi.fn(), saveSshAccount: vi.fn(), testSshAccount: vi.fn(), verifySshAccount: vi.fn(), deleteSshAccount: vi.fn() }));
vi.mock("./lib/api", () => ({ api: mocks }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const machine = (id: string, os = "linux 6.14") => ({ id, name: id, os } as Machine);
const account: SshAccount = {
  id: "ssh_1", machineId: "a", name: "qianyi", alias: "af-qianyi", algorithm: "ed25519", username: "deploy", address: "", port: 22, effectiveAddress: "10.0.0.8",
  publicKey: "ssh-ed25519 AAAA", fingerprint: "SHA256:abc", hasPrivateKey: true, hasPassphrase: false, hostKeyFingerprints: ["SHA256:host"],
  route: "direct", proxyJumpMachineId: null, verification: { userExists: true, authorized: false }, description: "构建机", enabled: true, sources: [], delivered: [{ machineId: "b", ok: true, syncedAt: "" }], createdAt: "", updatedAt: "",
};

it("Windows 主机只显示暂不支持，macOS 主机可用", async () => {
  const view = render(<HostSshAccess machine={machine("win", "win32 11")} machines={[]} canManage />);
  expect(screen.getByRole("status").textContent).toContain("仅支持 Linux 和 macOS");
  expect(mocks.sshAccounts).not.toHaveBeenCalled();
  view.unmount();
  mocks.sshAccounts.mockResolvedValue({ accounts: [] });
  mocks.sshReachable.mockResolvedValue({ accounts: [] });
  mocks.sshLinks.mockResolvedValue({ hosts: [], links: [] });
  render(<HostSshAccess machine={machine("mac", "darwin 24")} machines={[]} canManage />);
  expect(await screen.findByRole("button", { name: "添加 SSH 账号" })).toBeTruthy();
});

it("列出登记的账号、校验状态与可访问主机，并可测试连接", async () => {
  mocks.sshAccounts.mockResolvedValue({ accounts: [account] });
  mocks.sshReachable.mockResolvedValue({ accounts: [{ id: "ssh_2", alias: "af-db", targetName: "db", username: "ops", hostname: "10.0.0.9", port: 22, description: "" }] });
  mocks.sshLinks.mockResolvedValue({ hosts: [], links: [] });
  mocks.testSshAccount.mockResolvedValue({ results: [{ machineId: "b", machineName: "b", ok: true, durationMs: 42 }] });
  render(<HostSshAccess machine={machine("a")} machines={[machine("a"), machine("b")]} canManage />);
  expect(await screen.findByText("ssh af-qianyi")).toBeTruthy();
  expect(screen.getByText(/deploy@10\.0\.0\.8:22/)).toBeTruthy();
  expect(screen.getByText("公钥不在 authorized_keys")).toBeTruthy();
  expect(screen.getByText("已下发到 b")).toBeTruthy();
  expect(screen.getByText("ssh af-db")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
  expect(await screen.findByText("b → 连接成功（42 ms）")).toBeTruthy();
});

it("管理员只填写连接字段，不提交名称、公钥或预设密钥类型", async () => {
  mocks.sshAccounts.mockResolvedValue({ accounts: [] });
  mocks.sshReachable.mockResolvedValue({ accounts: [] });
  mocks.sshLinks.mockResolvedValue({ hosts: [], links: [] });
  mocks.saveSshAccount.mockResolvedValue({ account });
  render(<HostSshAccess machine={machine("a")} machines={[machine("a"), machine("b")]} canManage />);
  fireEvent.click(await screen.findByRole("button", { name: "添加 SSH 账号" }));
  expect(screen.queryByLabelText(/名称|公钥|加密方式/)).toBeNull();
  expect(screen.getByText(/连接别名自动使用 af-主机名/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText(/用户名/), { target: { value: "deploy" } });
  fireEvent.change(screen.getByLabelText(/私钥 \*/), { target: { value: "-----BEGIN OPENSSH PRIVATE KEY-----" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await vi.waitFor(() => expect(mocks.saveSshAccount).toHaveBeenCalled());
  expect(mocks.saveSshAccount.mock.calls[0]![0]).toMatchObject({ machineId: "a", username: "deploy", port: 22, sources: [] });
  const submitted = mocks.saveSshAccount.mock.calls[0]![0];
  for (const key of ["name", "algorithm", "publicKey", "passphrase"]) expect(submitted[key]).toBeUndefined();
});

it("编辑时保持别名、访问范围及描述，更换私钥时不发送旧公钥或类型", async () => {
  mocks.sshAccounts.mockResolvedValue({ accounts: [{ ...account, sources: ["b"], hasPassphrase: true }] });
  mocks.sshReachable.mockResolvedValue({ accounts: [] });
  mocks.sshLinks.mockResolvedValue({ hosts: [], links: [] });
  mocks.saveSshAccount.mockResolvedValue({ account });
  render(<HostSshAccess machine={machine("a")} machines={[machine("a"), machine("b")]} canManage />);
  fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
  expect(screen.getByText("连接命令：ssh af-qianyi")).toBeTruthy();
  expect(screen.getByLabelText("私钥口令").closest("details")?.open).toBe(true);
  fireEvent.change(screen.getByLabelText(/私钥 \*/), { target: { value: "replacement-private-key" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await vi.waitFor(() => expect(mocks.saveSshAccount).toHaveBeenCalled());
  const [input, id] = mocks.saveSshAccount.mock.calls[0]!;
  expect(id).toBe(account.id);
  expect(input).toMatchObject({ privateKey: "replacement-private-key", sources: ["b"], description: "构建机" });
  for (const key of ["name", "algorithm", "publicKey", "passphrase"]) expect(input[key]).toBeUndefined();
});

const link = (accountId: string, alias: string, targetMachineId: string, sources: SshLinkMatrix["links"][number]["sources"], extra: Partial<SshLinkMatrix["links"][number]> = {}) =>
  ({ accountId, alias, targetMachineId, targetName: targetMachineId, route: "direct", proxyJumpMachineId: null, enabled: true, sources, ...extra }) as SshLinkMatrix["links"][number];
const matrix: SshLinkMatrix = {
  hosts: [{ machineId: "a", name: "a", platform: "linux", supported: true }, { machineId: "b", name: "b", platform: "linux", supported: true }, { machineId: "c", name: "c", platform: "darwin", supported: true }, { machineId: "w", name: "w", platform: "win32", supported: false }],
  links: [
    link("ssh_1", "af-qianyi", "a", [
      { machineId: "b", machineName: "b", agent: "ready", state: "ok", path: "direct", durationMs: 30 },
      { machineId: "c", machineName: "c", agent: "ready", state: "failed", error: "Connection timed out" },
      { machineId: "w", machineName: "w", agent: "ready", state: "unsupported", reason: "source_platform" },
    ]),
    link("ssh_2", "af-inner", "b", [
      { machineId: "a", machineName: "a", agent: "ready", state: "ok", path: "proxyjump", via: "af-bastion" },
      { machineId: "c", machineName: "c", agent: "outdated", state: "excluded", reason: "routes_unsupported" },
      { machineId: "w", machineName: "w", agent: "ready", state: "unsupported", reason: "source_platform" },
    ], { route: "proxyjump", proxyJumpMachineId: "c" }),
  ],
};

it("互通矩阵按真实测试结果显示直连、跳板、失败，以及被排除的原因", async () => {
  mocks.sshAccounts.mockResolvedValue({ accounts: [] });
  mocks.sshReachable.mockResolvedValue({ accounts: [] });
  mocks.sshLinks.mockResolvedValue(matrix);
  render(<HostSshAccess machine={machine("a")} machines={[machine("a"), machine("b")]} canManage />);
  const table = await screen.findByRole("table");
  expect(table.textContent).toContain("af-qianyi");
  expect(screen.getByText("直连 ✓")).toBeTruthy();
  expect(screen.getByText("经跳板 ✓")).toBeTruthy();
  expect(screen.getByText("连接失败")).toBeTruthy();
  expect(screen.getByText("Connection timed out")).toBeTruthy();
  expect(screen.getByText("需更新连接服务以支持跳板")).toBeTruthy();
  expect(screen.getAllByText("该系统不支持 SSH 互通")).toHaveLength(2);
  expect(screen.getAllByLabelText("目标主机自身")).toHaveLength(2);
  expect(table.textContent).toContain("经 c 跳转");
});

it("测试全部只对管理员可见，并依次测试每个账号", async () => {
  mocks.sshAccounts.mockResolvedValue({ accounts: [account] });
  mocks.sshReachable.mockResolvedValue({ accounts: [] });
  mocks.sshLinks.mockResolvedValue(matrix);
  mocks.testSshAccount.mockResolvedValue({ results: [] });
  const view = render(<HostSshAccess machine={machine("a")} machines={[machine("a"), machine("b")]} canManage={false} />);
  await screen.findByRole("table");
  expect(screen.queryByRole("button", { name: "测试全部" })).toBeNull();
  expect(screen.queryByRole("button", { name: "测试连接" })).toBeNull();
  expect(screen.queryByRole("button", { name: "重新校验并下发" })).toBeNull();
  view.unmount();
  render(<HostSshAccess machine={machine("a")} machines={[machine("a"), machine("b")]} canManage />);
  fireEvent.click(await screen.findByRole("button", { name: "测试全部" }));
  await vi.waitFor(() => expect(mocks.testSshAccount).toHaveBeenCalledTimes(2));
  expect(mocks.testSshAccount.mock.calls.map(call => call[0])).toEqual(["ssh_1", "ssh_2"]);
});

it("跳板机只能选择已有直连账号的主机，并随账号一起保存", async () => {
  mocks.sshAccounts.mockResolvedValue({ accounts: [] });
  mocks.sshReachable.mockResolvedValue({ accounts: [] });
  mocks.sshLinks.mockResolvedValue(matrix);
  mocks.saveSshAccount.mockResolvedValue({ account });
  render(<HostSshAccess machine={machine("c", "darwin 24")} machines={[machine("a"), machine("b"), machine("c", "darwin 24")]} canManage />);
  fireEvent.click(await screen.findByRole("button", { name: "添加 SSH 账号" }));
  const route = screen.getByLabelText("连接方式") as HTMLSelectElement;
  expect(route.value).toBe("direct");
  expect(screen.queryByLabelText(/跳板机/)).toBeNull();
  fireEvent.change(route, { target: { value: "proxyjump" } });
  const jump = screen.getByLabelText(/跳板机/) as HTMLSelectElement;
  expect([...jump.options].map(option => option.value)).toEqual(["", "a"]); // b's only account hops itself, so b cannot be a jump
  fireEvent.change(jump, { target: { value: "a" } });
  fireEvent.change(screen.getByLabelText(/用户名/), { target: { value: "deploy" } });
  fireEvent.change(screen.getByLabelText(/私钥 \*/), { target: { value: "-----BEGIN OPENSSH PRIVATE KEY-----" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await vi.waitFor(() => expect(mocks.saveSshAccount).toHaveBeenCalled());
  expect(mocks.saveSshAccount.mock.calls[0]![0]).toMatchObject({ machineId: "c", route: "proxyjump", proxyJumpMachineId: "a" });
});

it("没有任何直连账号时不能选择跳板机", async () => {
  mocks.sshAccounts.mockResolvedValue({ accounts: [] });
  mocks.sshReachable.mockResolvedValue({ accounts: [] });
  mocks.sshLinks.mockResolvedValue({ hosts: [], links: [] });
  render(<HostSshAccess machine={machine("a")} machines={[machine("a"), machine("b")]} canManage />);
  fireEvent.click(await screen.findByRole("button", { name: "添加 SSH 账号" }));
  expect((screen.getByRole("option", { name: "经跳板机" }) as HTMLOptionElement).disabled).toBe(true);
  expect(screen.getByText("经跳板机需要先为另一台主机登记一个直连的 SSH 账号。")).toBeTruthy();
});

it("编辑时可从候选地址选择，并标注局域网、公网与虚拟网络；macOS 未开启远程登录会提示", async () => {
  mocks.sshAccounts.mockResolvedValue({ accounts: [{ ...account, machineId: "mac", verification: { userExists: true, authorized: true, listening: false,
    addresses: ["192.168.1.9", "100.101.1.1", "203.0.113.5"], addressKinds: { "192.168.1.9": "lan", "100.101.1.1": "overlay", "203.0.113.5": "public" } } }] });
  mocks.sshReachable.mockResolvedValue({ accounts: [] });
  mocks.sshLinks.mockResolvedValue({ hosts: [], links: [] });
  mocks.saveSshAccount.mockResolvedValue({ account });
  render(<HostSshAccess machine={machine("mac", "darwin 24")} machines={[machine("mac", "darwin 24"), machine("b")]} canManage />);
  expect(await screen.findByText("sshd 未监听：请在 系统设置 → 通用 → 共享 中打开远程登录")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  const picker = screen.getByLabelText("候选地址") as HTMLSelectElement;
  expect([...picker.options].map(option => option.textContent)).toEqual(["选择后填入地址…", "192.168.1.9 · 局域网", "100.101.1.1 · 虚拟网络", "203.0.113.5 · 公网"]);
  fireEvent.change(picker, { target: { value: "100.101.1.1" } });
  expect((screen.getByLabelText("地址") as HTMLInputElement).value).toBe("100.101.1.1");
});

const relaySettings = (over: Partial<SshRelaySettings> = {}): SshRelaySettings => ({ enabled: false, revision: 0, updatedAt: null, active: 0, limits: { perSource: 8, perTarget: 16, perWorkspace: 24, resumeGraceSeconds: 60 }, ...over });
const base = () => { mocks.sshAccounts.mockResolvedValue({ accounts: [] }); mocks.sshReachable.mockResolvedValue({ accounts: [] }); mocks.sshLinks.mockResolvedValue({ hosts: [], links: [] }); };

it("面板中转默认关闭，所有人可见状态和限制，只有管理员能切换并先确认", async () => {
  base();
  mocks.sshRelay.mockResolvedValue(relaySettings({ active: 2 }));
  mocks.saveSshRelay.mockResolvedValue(relaySettings({ enabled: true, revision: 1, active: 2 }));
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  const view = render(<HostSshAccess machine={machine("a")} machines={[machine("a"), machine("b")]} canManage={false} />);
  expect(await screen.findByText("未启用")).toBeTruthy();
  expect(screen.getByText("当前中转连接：2")).toBeTruthy();
  expect(screen.getByText(/连接断开后 60 秒内重连可自动续传/)).toBeTruthy();
  expect(screen.getByText(/每台主机最多 8 条、目标主机最多 16 条、工作区最多 24 条/)).toBeTruthy();
  expect(screen.getByText(/请确认其服务条款允许转发 SSH 数据/)).toBeTruthy();
  expect(screen.getByText("仅平台管理员可以启用或关闭面板中转。")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "启用面板中转" })).toBeNull();
  view.unmount();

  render(<HostSshAccess machine={machine("a")} machines={[machine("a"), machine("b")]} canManage />);
  const enableButton = await screen.findByRole("button", { name: "启用面板中转" });
  mocks.sshRelay.mockResolvedValue(relaySettings({ enabled: true, revision: 1, active: 2 })); // what the server returns once it is saved
  fireEvent.click(enableButton);
  expect(confirm.mock.calls[0]![0]).toContain("端到端加密");
  await vi.waitFor(() => expect(mocks.saveSshRelay).toHaveBeenCalledWith({ enabled: true, revision: 0 }));
  expect(await screen.findByText("已启用")).toBeTruthy();
  expect(screen.getByRole("button", { name: "关闭面板中转" })).toBeTruthy();
  confirm.mockRestore();
});

it("不确认就不改变面板中转开关，冲突时显示原因", async () => {
  base();
  mocks.sshRelay.mockResolvedValue(relaySettings({ enabled: true, revision: 3 }));
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  render(<HostSshAccess machine={machine("a")} machines={[machine("a")]} canManage />);
  fireEvent.click(await screen.findByRole("button", { name: "关闭面板中转" }));
  expect(confirm.mock.calls[0]![0]).toContain("立即断开");
  expect(mocks.saveSshRelay).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  mocks.saveSshRelay.mockRejectedValue(new Error("Settings changed in another browser; reload before saving"));
  fireEvent.click(screen.getByRole("button", { name: "关闭面板中转" }));
  expect((await screen.findByRole("alert")).textContent).toContain("reload before saving");
  expect(screen.getByText("已启用")).toBeTruthy();
  confirm.mockRestore();
});

it("「自动」和「仅经面板中转」只在启用面板中转后可选，并随账号保存", async () => {
  base();
  mocks.saveSshRelay.mockResolvedValue(relaySettings());
  mocks.saveSshAccount.mockResolvedValue({ account });
  mocks.sshRelay.mockResolvedValue(relaySettings());
  const off = render(<HostSshAccess machine={machine("a")} machines={[machine("a"), machine("b")]} canManage />);
  fireEvent.click(await screen.findByRole("button", { name: "添加 SSH 账号" }));
  expect((screen.getByRole("option", { name: "自动：直连优先，不通时经面板中转" }) as HTMLOptionElement).disabled).toBe(true);
  expect((screen.getByRole("option", { name: "仅经面板中转" }) as HTMLOptionElement).disabled).toBe(true);
  expect(screen.getByText("「自动」和「仅经面板中转」需要先在下方启用面板中转。")).toBeTruthy();
  off.unmount();

  mocks.sshRelay.mockResolvedValue(relaySettings({ enabled: true, revision: 1 }));
  render(<HostSshAccess machine={machine("a")} machines={[machine("a"), machine("b")]} canManage />);
  fireEvent.click(await screen.findByRole("button", { name: "添加 SSH 账号" }));
  const route = screen.getByLabelText("连接方式") as HTMLSelectElement;
  expect((screen.getByRole("option", { name: "仅经面板中转" }) as HTMLOptionElement).disabled).toBe(false);
  expect(screen.queryByText("「自动」和「仅经面板中转」需要先在下方启用面板中转。")).toBeNull();
  fireEvent.change(route, { target: { value: "relay" } });
  fireEvent.change(screen.getByLabelText(/用户名/), { target: { value: "deploy" } });
  fireEvent.change(screen.getByLabelText(/私钥 \*/), { target: { value: "-----BEGIN OPENSSH PRIVATE KEY-----" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await vi.waitFor(() => expect(mocks.saveSshAccount).toHaveBeenCalled());
  expect(mocks.saveSshAccount.mock.calls[0]![0]).toMatchObject({ machineId: "a", route: "relay" });
});

it("已经使用中转的账号在开关关闭后仍可编辑，并显示它的连接方式", async () => {
  base();
  mocks.sshRelay.mockResolvedValue(relaySettings());
  mocks.sshAccounts.mockResolvedValue({ accounts: [{ ...account, route: "relay" }] });
  render(<HostSshAccess machine={machine("a")} machines={[machine("a"), machine("b")]} canManage />);
  expect(await screen.findByText("经面板中转")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  expect((screen.getByLabelText("连接方式") as HTMLSelectElement).value).toBe("relay");
  expect((screen.getByRole("option", { name: "仅经面板中转" }) as HTMLOptionElement).disabled).toBe(false);
});

it("互通矩阵区分中转与直连的真实结果，并说明中转为何没有生效", async () => {
  mocks.sshAccounts.mockResolvedValue({ accounts: [] });
  mocks.sshReachable.mockResolvedValue({ accounts: [] });
  mocks.sshRelay.mockResolvedValue(relaySettings({ enabled: true, revision: 1 }));
  mocks.sshLinks.mockResolvedValue({
    hosts: [{ machineId: "a", name: "a", platform: "linux", supported: true }, { machineId: "b", name: "b", platform: "linux", supported: true }, { machineId: "c", name: "c", platform: "linux", supported: true }],
    links: [
      link("ssh_r", "af-nat", "a", [{ machineId: "b", machineName: "b", agent: "ready", state: "ok", path: "relay" }, { machineId: "c", machineName: "c", agent: "ready", state: "untested" }], { route: "relay" }),
      link("ssh_a", "af-either", "b", [{ machineId: "a", machineName: "a", agent: "ready", state: "untested" }, { machineId: "c", machineName: "c", agent: "ready", state: "excluded", reason: "host_key_unpinned" }], { route: "auto" }),
      link("ssh_x", "af-off", "c", [{ machineId: "a", machineName: "a", agent: "ready", state: "excluded", reason: "relay_disabled" }, { machineId: "b", machineName: "b", agent: "outdated", state: "unsupported", reason: "relay_unsupported" }], { route: "relay" }),
    ],
  } as SshLinkMatrix);
  render(<HostSshAccess machine={machine("a")} machines={[machine("a"), machine("b")]} canManage />);
  await screen.findByRole("table");
  expect(screen.getByText("经中转 ✓")).toBeTruthy();
  expect(screen.getByText("未测试（经中转）")).toBeTruthy();
  expect(screen.getByText("未测试（直连或中转）")).toBeTruthy();
  expect(screen.getByText("目标主机指纹未固定，中转需要先固定")).toBeTruthy();
  expect(screen.getByText("面板中转未启用")).toBeTruthy();
  expect(screen.getByText("需更新连接服务以支持中转")).toBeTruthy();
  const rows = screen.getAllByRole("row").map(row => row.textContent ?? "");
  expect(rows.some(text => text.includes("af-nat") && text.includes("经面板中转"))).toBe(true);
  expect(rows.some(text => text.includes("af-either") && text.includes("自动（直连优先）"))).toBe(true);
});

it("连接测试会说明实际走的是面板中转", async () => {
  base();
  mocks.sshRelay.mockResolvedValue(relaySettings({ enabled: true }));
  mocks.sshAccounts.mockResolvedValue({ accounts: [{ ...account, route: "auto" }] });
  mocks.testSshAccount.mockResolvedValue({ results: [{ machineId: "b", machineName: "b", ok: true, durationMs: 380, path: "relay" }] });
  render(<HostSshAccess machine={machine("a")} machines={[machine("a"), machine("b")]} canManage />);
  fireEvent.click(await screen.findByRole("button", { name: "测试连接" }));
  expect(await screen.findByText("b → 经面板中转连接成功（380 ms）")).toBeTruthy();
});
