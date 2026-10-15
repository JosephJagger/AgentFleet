import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { npmConnectCommand } from "./enrollment";

it.skipIf(process.platform === "win32")("passes npm connection credentials literally through a POSIX shell", () => {
  const ticket = "enr_fixture.'; $(printf injected) $UNSET `printf injected`";
  for (const platform of ["linux", "macos"]) {
    const command = npmConnectCommand("https://fleet.example.com", ticket, platform);
    const args = execFileSync("sh", ["-c", `agentfleets() { printf '%s\\n' "$@"; }; ${command}`], { encoding: "utf8" }).trimEnd().split("\n");
    expect(args).toEqual(["connect", "--url", "https://fleet.example.com", "--ticket", ticket]);
  }
});
