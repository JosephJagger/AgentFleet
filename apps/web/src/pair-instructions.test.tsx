// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PairMachineDialog } from "./components/PairMachineDialog";
import { api } from "./lib/api";

vi.mock("./lib/api", () => ({ api: { createEnrollment: vi.fn(), enrollment: vi.fn(), cancelEnrollment: vi.fn() } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllEnvs(); });

it("三个系统的复制命令说明具体运行位置，并随系统选择切换", async () => {
  const enrollment = { id: "enroll_test", bootstrapSecret: "test-only", status: "pending" as const, expiresAt: "2099-01-01T00:00:00Z" };
  vi.mocked(api.createEnrollment).mockResolvedValue({ enrollment });
  vi.mocked(api.enrollment).mockResolvedValue({ enrollment });
  render(<PairMachineDialog open onClose={vi.fn()} onPaired={vi.fn()} onToast={vi.fn()} />);
  const copy = await screen.findByRole("button", { name: "复制安装命令" });
  expect(copy.getAttribute("aria-describedby")).toBe("install-run-location");
  expect(screen.getByText(/Linux 主机上打开终端.*SSH/)).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "macOS" }));
  expect(screen.getByText(/Mac 上打开「终端」.*应用程序 → 实用工具/)).toBeTruthy();
  expect(screen.queryByText(/Linux 主机上打开终端/)).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Windows" }));
  expect(screen.getByText(/Windows 主机上打开 PowerShell.*不要在 CMD 中运行/)).toBeTruthy();
  expect(screen.queryByText(/Mac 上打开「终端」/)).toBeNull();
  const windows = screen.getByRole("tab", { name: "Windows" });
  expect(windows.getAttribute("aria-selected")).toBe("true");
  expect(windows.textContent).toContain("已选择");
  expect(windows.className).toContain("platform-tab--active");
  expect(screen.getByRole("tab", { name: "Linux" }).getAttribute("aria-selected")).toBe("false");
  fireEvent.keyDown(windows, { key: "ArrowLeft" });
  const macos = screen.getByRole("tab", { name: "macOS" });
  expect(macos.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(macos);
  expect(screen.getByText(/Mac 上打开「终端」/)).toBeTruthy();
});

it("keeps npm installation hidden until the package is published and the build enables it", async () => {
  vi.stubEnv("VITE_NPM_INSTALL_AVAILABLE", "false");
  const enrollment = { id: "enroll_test", bootstrapSecret: "test-only", status: "pending" as const, expiresAt: "2099-01-01T00:00:00Z" };
  vi.mocked(api.createEnrollment).mockResolvedValue({ enrollment });
  vi.mocked(api.enrollment).mockResolvedValue({ enrollment });
  render(<PairMachineDialog open onClose={vi.fn()} onPaired={vi.fn()} onToast={vi.fn()} />);
  await screen.findByRole("button", { name: "复制安装命令" });
  expect(screen.queryByRole("button", { name: "npm 安装" })).toBeNull();
  expect(screen.queryByText(/npm install -g agentfleets/)).toBeNull();
});

it("uses one enrollment when switching installation methods and target operating systems", async () => {
  vi.stubEnv("VITE_NPM_INSTALL_AVAILABLE", "true");
  const enrollment = { id: "enroll_test", bootstrapSecret: "test-only", status: "pending" as const, expiresAt: "2099-01-01T00:00:00Z" };
  vi.mocked(api.createEnrollment).mockResolvedValue({ enrollment });
  vi.mocked(api.enrollment).mockResolvedValue({ enrollment });
  render(<PairMachineDialog open onClose={vi.fn()} onPaired={vi.fn()} onToast={vi.fn()} />);
  await screen.findByRole("button", { name: "复制安装命令" });
  expect(screen.getByRole("button", { name: "直接安装" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "npm 安装" }));
  expect(screen.getByText("npm install -g agentfleets")).toBeTruthy();
  const connectionCommand = screen.getByText(/^agentfleets connect/).textContent;
  expect(connectionCommand).toContain("--ticket 'enroll_test.test-only'");
  fireEvent.click(screen.getByRole("tab", { name: "Windows" }));
  expect(screen.getByText(/Windows 主机上打开 PowerShell.*不要在 CMD 中运行/)).toBeTruthy();
  expect(screen.getByText(/^agentfleets connect/).textContent).toBe(connectionCommand);
  fireEvent.click(screen.getByRole("button", { name: "直接安装" }));
  expect(screen.getByRole("button", { name: "复制安装命令" })).toBeTruthy();
  expect(screen.getByText(/Invoke-WebRequest.*-Ticket/).textContent).toContain("enroll_test.test-only");
  fireEvent.click(screen.getByRole("button", { name: "npm 安装" }));
  expect(api.createEnrollment).toHaveBeenCalledTimes(1);
  expect(api.cancelEnrollment).not.toHaveBeenCalled();
});

it("copying the npm installer does not advance enrollment; only the connect commands advance the copy step", async () => {
  vi.stubEnv("VITE_NPM_INSTALL_AVAILABLE", "true");
  const enrollment = { id: "enroll_test", bootstrapSecret: "test-only", status: "pending" as const, expiresAt: "2099-01-01T00:00:00Z" };
  vi.mocked(api.createEnrollment).mockResolvedValue({ enrollment });
  vi.mocked(api.enrollment).mockResolvedValue({ enrollment });
  const copy = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText: copy }, configurable: true });
  const onPaired = vi.fn();
  render(<PairMachineDialog open onClose={vi.fn()} onPaired={onPaired} onToast={vi.fn()} />);
  await screen.findByRole("button", { name: "复制安装命令" });
  fireEvent.click(screen.getByRole("button", { name: "npm 安装" }));
  fireEvent.click(screen.getByRole("button", { name: "复制 npm 安装命令" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "复制 npm 安装命令" }).textContent).toContain("已复制"));
  const receipt = screen.getByRole("region", { name: "主机连接回执" });
  expect(within(receipt).getByText("尚未连接")).toBeTruthy();
  expect(within(receipt).getByText("等待复制")).toBeTruthy();
  expect(within(screen.getByRole("list", { name: "配对进度" })).getAllByRole("listitem")[0].getAttribute("aria-current")).toBe("step");
  expect(onPaired).not.toHaveBeenCalled();
  expect(copy).toHaveBeenLastCalledWith("npm install -g agentfleets");
  fireEvent.click(screen.getByText("免全局安装：使用 npx"));
  fireEvent.click(screen.getByRole("button", { name: "复制 npx 连接命令" }));
  await waitFor(() => expect(within(receipt).getByText("等待出站 HTTPS")).toBeTruthy());
  expect(copy).toHaveBeenLastCalledWith(expect.stringMatching(/^npx agentfleets@latest connect .*--ticket 'enroll_test.test-only'$/));
  expect(onPaired).not.toHaveBeenCalled();
});

it.each([
  ["pending", "2000-01-01T00:00:00Z"],
  ["expired", "2099-01-01T00:00:00Z"],
  ["cancelled", "2099-01-01T00:00:00Z"],
] as const)("disables npm connection commands for a %s unusable ticket but keeps the standalone installer available", async (status, expiresAt) => {
  vi.stubEnv("VITE_NPM_INSTALL_AVAILABLE", "true");
  const enrollment = { id: "enroll_test", bootstrapSecret: "test-only", status, expiresAt };
  vi.mocked(api.createEnrollment).mockResolvedValue({ enrollment });
  vi.mocked(api.enrollment).mockResolvedValue({ enrollment });
  render(<PairMachineDialog open onClose={vi.fn()} onPaired={vi.fn()} onToast={vi.fn()} />);
  await screen.findByRole("button", { name: "复制安装命令" });
  fireEvent.click(screen.getByRole("button", { name: "npm 安装" }));
  expect((screen.getByRole("button", { name: "复制连接命令" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByText("免全局安装：使用 npx"));
  expect((screen.getByRole("button", { name: "复制 npx 连接命令" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "复制 npm 安装命令" }) as HTMLButtonElement).disabled).toBe(false);
});

it("waits for the shared host-ready receipt before reporting npm connection success", async () => {
  vi.stubEnv("VITE_NPM_INSTALL_AVAILABLE", "true");
  const enrollment = { id: "enroll_test", bootstrapSecret: "test-only", status: "pending" as const, expiresAt: "2099-01-01T00:00:00Z" };
  vi.mocked(api.createEnrollment).mockResolvedValue({ enrollment });
  vi.mocked(api.enrollment).mockResolvedValue({ enrollment: { ...enrollment, status: "redeemed", machineReady: true, machineId: "machine_fixture", machineName: "Fixture host" } });
  const onPaired = vi.fn();
  const onToast = vi.fn();
  render(<PairMachineDialog open onClose={vi.fn()} onPaired={onPaired} onToast={onToast} />);
  await screen.findByRole("button", { name: "复制安装命令" });
  fireEvent.click(screen.getByRole("button", { name: "npm 安装" }));
  expect(onPaired).not.toHaveBeenCalled();
  await waitFor(() => expect(onPaired).toHaveBeenCalledWith("machine_fixture"), { timeout: 2500 });
  expect(onPaired).toHaveBeenCalledTimes(1);
  expect(onToast).toHaveBeenCalledWith("success", "Fixture host 已安全连接");
  expect(api.createEnrollment).toHaveBeenCalledTimes(1);
});

it("keeps the purging uninstall command in the footer without a legacy pairing entry", async () => {
  const enrollment = { id: "enroll_test", bootstrapSecret: "test-only", status: "pending" as const, expiresAt: "2099-01-01T00:00:00Z" };
  vi.mocked(api.createEnrollment).mockResolvedValue({ enrollment });
  vi.mocked(api.enrollment).mockResolvedValue({ enrollment });
  const copy = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText: copy }, configurable: true });
  render(<PairMachineDialog open onClose={vi.fn()} onPaired={vi.fn()} onToast={vi.fn()} />);
  const installCopy = await screen.findByRole("button", { name: "复制安装命令" });
  const uninstallCopy = screen.getByRole("button", { name: "复制卸载命令" });
  const note = screen.getByText(/仅当你不再希望 AgentFleets 连接这台主机时.*卸载这台主机上的 AgentFleets Agent.*清除连接身份/);
  expect(installCopy.compareDocumentPosition(uninstallCopy) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(installCopy.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(note.compareDocumentPosition(uninstallCopy) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(installCopy.closest(".connection-receipt")).not.toBe(uninstallCopy.closest(".connection-receipt"));
  expect(screen.queryByText("已经从旧版终端获得配对码？")).toBeNull();
  expect(screen.queryByRole("combobox", { name: "卸载目标系统" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Windows" }));
  fireEvent.click(screen.getByRole("button", { name: "复制卸载命令" }));
  expect(copy).toHaveBeenCalledWith(expect.stringContaining("-Mode Uninstall -Purge"));
  expect(copy.mock.calls[0][0]).not.toContain("test-only");
});
