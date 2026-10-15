import { describe, expect, it } from "vitest";
import { enrollmentTicket, npmConnectCommand, npmInstallCommand, onboardCommand, uninstallCommand } from "./enrollment";

describe("browser initiated enrollment", () => {
  it("keeps the opaque secret out of the control plane URL", () => {
    const ticket = enrollmentTicket("enr_123", "secret-value");
    const command = onboardCommand("https://fleet.example.com/pair?ignored=yes", ticket);

    expect(ticket).toBe("enr_123.secret-value");
    expect(command).toContain("curl -fsSL 'https://fleet.example.com/install' | sh -s --");
    expect(command).toContain("--url 'https://fleet.example.com'");
    expect(command).toContain("--ticket 'enr_123.secret-value'");
    expect(command).toContain('--name "$(hostname)"');
    expect(command).not.toContain('--project');
    expect(command).not.toContain("?ignored=yes");
  });

  it("refuses to create a partial ticket", () => {
    expect(() => enrollmentTicket("enr_123", "")).toThrow("incomplete");
  });

  it("renders native macOS and Windows installation commands", () => {
    const ticket = enrollmentTicket("enr_123", "secret-value");
    expect(onboardCommand("https://fleet.example.com", ticket, "macos"))
      .toContain("https://fleet.example.com/install-macos");
    const windows = onboardCommand("https://fleet.example.com", ticket, "windows");
    expect(windows).toContain("https://fleet.example.com/install.ps1");
    expect(windows).toContain("-Name $env:COMPUTERNAME");
    expect(windows).not.toContain("-Project");
  });
});

describe("npm enrollment commands", () => {
  it("keeps installation separate from the one-time connection credential", () => {
    expect(npmInstallCommand).toBe("npm install -g agentfleets");
    for (const platform of ["linux", "macos", "windows"] as const) {
      const command = npmConnectCommand("https://fleet.example.com/path?ignored=true", "enr_test.fixture-secret", platform);
      expect(command).toBe("agentfleets connect --url 'https://fleet.example.com' --ticket 'enr_test.fixture-secret'");
      expect(npmConnectCommand("https://fleet.example.com", "enr_test.fixture-secret", platform, true))
        .toBe(`npx agentfleets@latest${command.slice("agentfleets".length)}`);
    }
    expect(() => npmConnectCommand("https://fleet.example.com", "")).toThrow("incomplete");
  });

  it("escapes PowerShell single quotes without enabling variable or expression expansion", () => {
    const ticket = "enr_fixture.'; $env:TEST $(Write-Output injected)";
    const command = npmConnectCommand("https://fleet.example.com", ticket, "windows");
    expect(command).toBe("agentfleets connect --url 'https://fleet.example.com' --ticket 'enr_fixture.''; $env:TEST $(Write-Output injected)'");
  });
});

it("generates platform-specific purging uninstall commands without enrollment secrets", () => {
  for (const [platform, path] of [["linux", "/install"], ["macos", "/install-macos"], ["windows", "/install.ps1"]] as const) {
    const command = uninstallCommand("https://fleet.example.com/pair?secret=hidden", platform);
    expect(command).toContain(`https://fleet.example.com${path}'`);
    expect(command).not.toMatch(/hidden|ticket/i);
    expect(command).toContain(platform === "windows" ? "-Mode Uninstall" : "--uninstall");
    expect(command).toContain(platform === "windows" ? "-Purge" : "--purge");
  }
});
