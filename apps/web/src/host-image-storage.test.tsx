// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HostImageStorage } from "./components/HostImageStorage";
import type { CloudImageUsage } from "./lib/types";
const mocks = vi.hoisted(() => ({ imageSessions:vi.fn(async()=>({sessions:[],nextCursor:null})),machineImages: vi.fn(), clearMachineImages:vi.fn() }));
vi.mock("./lib/api", () => ({ api: mocks }));
const usage: CloudImageUsage = { machineId: "a", usedBytes: 50e6, quotaBytes: 50e6, imageCount: 5, fileCount: 3, fileBytes: 6000, fileTypes: [{type:"PDF",count:1,bytes:4000},{type:"XLSX",count:2,bytes:2000}], revision: 8, level: "full", pendingImageCommands: 0, canClear: true };
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it("显示云端配额，并提供独立于原生历史的云端清理入口", async () => {
  mocks.machineImages.mockResolvedValue(usage);
  render(<HostImageStorage machineId="a" name="工作机器" />);
  await screen.findByText("50.0 MB");
  expect(screen.getByText("/ 50.0 MB")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("文字消息不受影响");
  expect(screen.getByRole("button",{name:"预览云端清理"})).toBeTruthy();
  expect(mocks.clearMachineImages).not.toHaveBeenCalled();
  expect(screen.getByText(/3 个主机暂存文件/)).toBeTruthy();
  expect(screen.getByText("PDF")).toBeTruthy();
  expect(screen.getByText("XLSX")).toBeTruthy();
  expect(screen.getByRole("region",{name:"按会话清理附件"})).toBeTruthy();
});
it("80% 预警和未完成图片命令保护可见", async () => {
  mocks.machineImages.mockResolvedValue({ ...usage, usedBytes: 40e6, level: "warning", pendingImageCommands: 1, canClear: false });
  render(<HostImageStorage machineId="a" name="工作机器" />);
  await screen.findByText(/云端图片空间使用量已达到 80%/);
  expect(screen.getByText(/对应会话暂不能清理/)).toBeTruthy();
  expect((screen.getByRole("button",{name:"预览云端清理"}) as HTMLButtonElement).disabled).toBe(true);
});

it("先展示整台主机的范围，勾选确认后只清理云端，不调用原生清理", async () => {
  mocks.machineImages.mockResolvedValue(usage);
  mocks.clearMachineImages.mockResolvedValue({...usage,usedBytes:0,imageCount:0,revision:9,canClear:false,level:"normal"});
  render(<HostImageStorage machineId="a" name="MacPro-Home" />);
  fireEvent.click(await screen.findByRole("button",{name:"预览云端清理"}));
  expect(screen.getByText(/将清理 MacPro-Home 的 5 张云端图片/)).toBeTruthy();
  const submit=screen.getByRole("button",{name:"确认仅清理云端图片"});
  expect((submit as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(submit);
  expect(mocks.clearMachineImages).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText("我确认清理这台主机所有会话的云端图片副本"));
  fireEvent.click(submit);fireEvent.click(submit);
  await screen.findByText("云端图片副本已清理，主机原图、文字和文件附件保留。");
  expect(mocks.clearMachineImages).toHaveBeenCalledTimes(1);
  expect(mocks.clearMachineImages).toHaveBeenCalledWith("a",8);
  expect(screen.getByText(/3 个主机暂存文件/)).toBeTruthy();
  expect((screen.getByRole("button",{name:"预览云端清理"}) as HTMLButtonElement).disabled).toBe(true);
});

it("取消预览不会删除图片，再次打开需要重新勾选", async () => {
  mocks.machineImages.mockResolvedValue(usage);
  render(<HostImageStorage machineId="a" name="Mac" />);
  fireEvent.click(await screen.findByRole("button",{name:"预览云端清理"}));
  fireEvent.click(screen.getByLabelText("我确认清理这台主机所有会话的云端图片副本"));
  fireEvent.click(screen.getByRole("button",{name:"取消"}));
  fireEvent.click(screen.getByRole("button",{name:"预览云端清理"}));
  expect((screen.getByRole("button",{name:"确认仅清理云端图片"}) as HTMLButtonElement).disabled).toBe(true);
  expect(mocks.clearMachineImages).not.toHaveBeenCalled();
});

it.each([{revision:9},{pendingImageCommands:1,canClear:false}])("预览后用量或待处理消息变化会使原确认失效：%j",async change=>{
  mocks.machineImages.mockResolvedValueOnce(usage).mockResolvedValue({...usage,...change});
  render(<HostImageStorage machineId="a" name="Mac" />);
  fireEvent.click(await screen.findByRole("button",{name:"预览云端清理"}));
  fireEvent.click(screen.getByLabelText("我确认清理这台主机所有会话的云端图片副本"));
  fireEvent.click(screen.getByRole("button",{name:"刷新附件用量"}));
  await screen.findByText("图片用量或待处理消息已变化，请取消后重新预览。");
  expect((screen.getByRole("button",{name:"确认仅清理云端图片"}) as HTMLButtonElement).disabled).toBe(true);
  expect(mocks.clearMachineImages).not.toHaveBeenCalled();
});

it("清理失败保留数据，不自动重试，必须重新预览确认",async()=>{
  mocks.machineImages.mockResolvedValue(usage);
  mocks.clearMachineImages.mockRejectedValue(new Error("图片用量已变化，请刷新后重新确认清理"));
  render(<HostImageStorage machineId="a" name="Mac" />);
  fireEvent.click(await screen.findByRole("button",{name:"预览云端清理"}));
  fireEvent.click(screen.getByLabelText("我确认清理这台主机所有会话的云端图片副本"));
  fireEvent.click(screen.getByRole("button",{name:"确认仅清理云端图片"}));
  await screen.findByText("图片用量已变化，请刷新后重新确认清理");
  expect(mocks.clearMachineImages).toHaveBeenCalledTimes(1);
  expect(screen.getByText("50.0 MB")).toBeTruthy();
  expect(screen.queryByText("云端图片副本已清理，主机原图、文字和文件附件保留。")).toBeNull();
  expect(screen.getByRole("button",{name:"预览云端清理"})).toBeTruthy();
});

it("清理前发出的旧用量回执不能覆盖清理后的用量",async()=>{
  mocks.machineImages.mockResolvedValueOnce(usage);
  render(<HostImageStorage machineId="a" name="Mac" />);
  fireEvent.click(await screen.findByRole("button",{name:"预览云端清理"}));
  let finish!:(value:CloudImageUsage)=>void;
  mocks.machineImages.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  fireEvent.click(screen.getByRole("button",{name:"刷新附件用量"}));
  mocks.clearMachineImages.mockResolvedValue({...usage,usedBytes:0,imageCount:0,revision:9,canClear:false,level:"normal"});
  fireEvent.click(screen.getByLabelText("我确认清理这台主机所有会话的云端图片副本"));
  fireEvent.click(screen.getByRole("button",{name:"确认仅清理云端图片"}));
  await waitFor(()=>expect(mocks.clearMachineImages).toHaveBeenCalledTimes(1));
  await screen.findByText("云端图片副本已清理，主机原图、文字和文件附件保留。");
  await act(async()=>finish(usage));
  expect((screen.getByRole("button",{name:"预览云端清理"}) as HTMLButtonElement).disabled).toBe(true);
});
