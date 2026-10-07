import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { HostUpdateStatus } from "./HostUpdateStatus";
describe("host update truthfulness", () => {
  it("distinguishes a staged install from the actual running version", () => {
    render(<HostUpdateStatus machine={{agentVersion:"0.30.78",reachability:"live",codexProfile:{agentInstalledVersion:"0.30.84",agentUpdateTarget:"0.30.84",agentUpdateState:"verifying"}}}/>);
    expect(screen.getByText("0.30.78")).toBeTruthy();
    expect(screen.getAllByText("0.30.84")).toHaveLength(2);
    expect(screen.getByText("正在确认连接与运行健康")).toBeTruthy();
    expect(screen.queryByText("升级完成，健康检查通过")).toBeNull();
  });
  it("never claims an unconfirmed rollback has restored the connection", () => {
    render(<HostUpdateStatus machine={{agentVersion:"0.30.78",reachability:"unreachable",codexProfile:{agentUpdateState:"rolled_back"}}}/>);
    expect(screen.getByText("已回退，等待确认旧版连接")).toBeTruthy();
    expect(screen.getByText("主机离线，以上为最后上报状态，尚未确认当前版本。")).toBeTruthy();
  });
});
