// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionRecovery } from "./components/SessionRecovery";
import { api } from "./lib/api";
vi.mock("./lib/api",()=>({api:{hostOperation:vi.fn(),hostOperations:vi.fn(),retrySessionRecovery:vi.fn(),command:vi.fn()}}));
afterEach(cleanup);beforeEach(()=>vi.clearAllMocks());
it("核验只请求主机持久记录，完成后刷新，原命令绝不重发",async()=>{
 const changed=vi.fn();const operation={id:"probe",type:"session.reconcile" as const,state:"accepted" as const,createdAt:"",updatedAt:""};
 vi.mocked(api.hostOperation).mockResolvedValue(operation);
 vi.mocked(api.hostOperations).mockResolvedValue([{...operation,state:"succeeded"}]);
 render(<SessionRecovery machineId="machine" sessionId="session" online supported onChanged={changed}/>);
 fireEvent.click(screen.getByRole("button",{name:"检查任务结果"}));
 await waitFor(()=>expect(changed).toHaveBeenCalledOnce());
 expect(api.hostOperation).toHaveBeenCalledWith("machine","session.reconcile",expect.any(String),"session");
 expect(api.command).not.toHaveBeenCalled();
 expect(screen.getByRole("status").textContent).toContain("正在同步会话状态");
});
it.each([{online:false,supported:true},{online:true,supported:false}])("离线或旧主机不能提交核验请求：%j",props=>{
 render(<SessionRecovery machineId="machine" sessionId="session" {...props} onChanged={()=>{}}/>);
 fireEvent.click(screen.getByRole("button",{name:"检查任务结果"}));expect(api.hostOperation).not.toHaveBeenCalled();
});

it("重试恢复由用户点击触发，主机回执后刷新，不重发任务",async()=>{
 const changed=vi.fn();vi.mocked(api.retrySessionRecovery).mockResolvedValue({id:"retry",type:"session.reconcile",state:"accepted",createdAt:"",updatedAt:""});
 vi.mocked(api.hostOperations).mockResolvedValue([{id:"retry",type:"session.reconcile",state:"succeeded",createdAt:"",updatedAt:"",result:{recovered:true,reason:"已解除挂起，原任务没有重发"}}]);
 render(<SessionRecovery machineId="machine" sessionId="session" online supported={false} onChanged={changed}/>);
 expect(api.retrySessionRecovery).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole("button",{name:"重试恢复"}));
 await waitFor(()=>expect(changed).toHaveBeenCalledOnce());
 expect(api.retrySessionRecovery).toHaveBeenCalledWith("session");
 expect(api.command).not.toHaveBeenCalled();expect(api.hostOperation).not.toHaveBeenCalled();
 expect(screen.getByRole("status").textContent).toContain("原任务没有重发");
});
it("恢复失败显示原因，离线不允许重试",async()=>{
 vi.mocked(api.retrySessionRecovery).mockRejectedValue(new Error("主机仍报告任务在运行"));
 const view=render(<SessionRecovery machineId="machine" sessionId="session" online supported onChanged={()=>{}}/>);
 fireEvent.click(screen.getByRole("button",{name:"重试恢复"}));
 await screen.findByText("主机仍报告任务在运行");
 view.rerender(<SessionRecovery machineId="machine" sessionId="session" online={false} supported onChanged={()=>{}}/>);
 expect((screen.getByRole("button",{name:"重试恢复"}) as HTMLButtonElement).disabled).toBe(true);
});
