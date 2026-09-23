// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HostRecovery, repairCommand } from "./HostRecovery";
import type { Machine } from "../lib/types";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it.each([['win32 10.0', '/install.ps1', '-Mode Repair'], ['Windows', '/install.ps1', '-Mode Repair'], ['darwin 24', '/install-macos', '--repair'], ['macOS', '/install-macos', '--repair'], ['Linux', '/install', '--repair']])('repair command uses the right installer for %s', (os, path, mode) => {
  const command = repairCommand({ os }, 'https://panel.example');
  expect(command).toContain(`https://panel.example${path}`);
  expect(command).toContain(mode);
  expect(command).not.toMatch(/--ticket|-Purge|--uninstall/);
  if (os.startsWith('Linux')) { expect(command).toContain('&& sh'); expect(command).not.toContain('| sh'); }
});
it('copying an offline repair command does not claim execution or recovery', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  render(<HostRecovery machine={{ id: 'windows', os: 'win32', reachability: 'unreachable' } as Machine} />);
  expect(screen.getByText(/在该主机打开 PowerShell/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '复制修复命令' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
  expect(await screen.findByRole('status')).toHaveProperty('textContent', '命令已复制，尚未执行修复。请到对应主机粘贴运行。');
});
it('clipboard failures leave the command available for manual copying', async () => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
  render(<HostRecovery machine={{ id: 'mac', os: 'darwin', reachability: 'unreachable' } as Machine} />);
  fireEvent.click(screen.getByRole('button', { name: '复制修复命令' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '复制失败，请手动选中命令复制');
  expect(screen.getByLabelText('连接修复命令').textContent).toContain('/install-macos');
});
