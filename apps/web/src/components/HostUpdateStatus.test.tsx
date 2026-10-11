// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, it, expect } from "vitest";
import { HostUpdateStatus } from "./HostUpdateStatus";
afterEach(cleanup);
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

it("does not present old upgrade success or duplicate versions as this check's upgrade", () => {
 render(<HostUpdateStatus machine={{agentVersion:"1.2.3",reachability:"live",codexProfile:{agentInstalledVersion:"1.2.3",agentUpdateTarget:"1.2.3",agentUpdateState:"succeeded",agentUpdateCheckedAt:"2026-01-01T00:00:00Z",agentUpdateVerifiedAt:"2026-01-01T00:00:00Z"}}} operations={[{id:"check",type:"agent.update",state:"succeeded",createdAt:"2026-01-02T00:00:00Z",updatedAt:"2026-01-02T00:00:00Z",result:{phase:"current",version:"1.2.3"}}]} release={{status:"mismatch",expectedVersion:"1.2.4",publicVersion:"1.2.3",checkedAt:"2026-01-02T00:00:00Z"}}/>);
 expect(screen.queryByText("已安装版本")).toBeNull();
 expect(screen.queryByText("本次更新目标")).toBeNull();
 expect(screen.queryByText("升级完成，健康检查通过")).toBeNull();
 expect(screen.getByText("更新源不一致，暂无法确认最新版本")).toBeTruthy();
 expect(screen.getByText("检查完成，更新源未提供更高版本")).toBeTruthy();
 expect(screen.getByText("上次升级记录")).toBeTruthy();
});
