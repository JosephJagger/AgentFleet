// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionRecovery } from "./components/SessionRecovery";
import { api } from "./lib/api";
vi.mock("./lib/api",()=>({api:{hostOperation:vi.fn(),hostOperations:vi.fn(),retrySessionRecovery:vi.fn(),command:vi.fn()}}));
afterEach(cleanup);beforeEach(()=>vi.clearAllMocks());
it("重试恢复由用户点击触发，主机回执后刷新，不重发任务",async()=>{
 const changed=vi.fn();vi.mocked(api.retrySessionRecovery).mockResolvedValue({id:"retry",type:"session.reconcile",state:"accepted",createdAt:"",updatedAt:""});
 vi.mocked(api.hostOperations).mockResolvedValue([{id:"retry",type:"session.reconcile",state:"succeeded",createdAt:"",updatedAt:"",result:{recovered:true,reason:"已解除挂起，原任务没有重发"}}]);
 render(<SessionRecovery machineId="machine" sessionId="session" online onChanged={changed}/>);
 expect(screen.getAllByRole("button")).toHaveLength(1);
 expect(api.retrySessionRecovery).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole("button",{name:"重试恢复"}));
 await waitFor(()=>expect(changed).toHaveBeenCalledOnce());
 expect(api.retrySessionRecovery).toHaveBeenCalledWith("session");
 expect(api.command).not.toHaveBeenCalled();expect(api.hostOperation).not.toHaveBeenCalled();
 expect(screen.getByRole("status").textContent).toContain("原任务没有重发");
});
it("恢复失败显示原因，离线不允许重试",async()=>{
 vi.mocked(api.retrySessionRecovery).mockRejectedValue(new Error("主机仍报告任务在运行"));
 const view=render(<SessionRecovery machineId="machine" sessionId="session" online onChanged={()=>{}}/>);
 fireEvent.click(screen.getByRole("button",{name:"重试恢复"}));
 await screen.findByText("主机仍报告任务在运行");
 view.rerender(<SessionRecovery machineId="machine" sessionId="session" online={false} onChanged={()=>{}}/>);
 expect((screen.getByRole("button",{name:"重试恢复"}) as HTMLButtonElement).disabled).toBe(true);
});
it("同目录的占用会话提供直接入口，不会替用户恢复另一会话",()=>{
 const open=vi.fn();render(<SessionRecovery machineId="machine" sessionId="here" relatedSessionId="blocking" online onChanged={()=>{}} onOpenSession={open}/>);
 expect(screen.getAllByRole('button')).toHaveLength(1);fireEvent.click(screen.getByRole('button',{name:'打开占用会话'}));
 expect(open).toHaveBeenCalledWith('blocking');expect(api.retrySessionRecovery).not.toHaveBeenCalled();
});
it("主机暂未恢复后可以再次点击重试",async()=>{
 vi.mocked(api.retrySessionRecovery).mockResolvedValue({id:'retry',type:'session.reconcile',state:'accepted',createdAt:'',updatedAt:''});
 vi.mocked(api.hostOperations).mockResolvedValue([{id:'retry',type:'session.reconcile',state:'succeeded',createdAt:'',updatedAt:'',result:{recovered:false,reason:'任务仍在运行'}}]);
 render(<SessionRecovery machineId="machine" sessionId="session" online onChanged={()=>{}}/>);
 fireEvent.click(screen.getByRole('button',{name:'重试恢复'}));await screen.findByText('任务仍在运行');
 expect((screen.getByRole('button',{name:'重试恢复'}) as HTMLButtonElement).disabled).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'重试恢复'}));await waitFor(()=>expect(api.retrySessionRecovery).toHaveBeenCalledTimes(2));
});
