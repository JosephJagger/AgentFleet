// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CodexConfiguration } from "./CodexConfiguration";
import { api } from "../lib/api";
import type { Machine } from "../lib/types";
vi.mock("../lib/api",()=>({api:{voicePreferences:vi.fn(),hostOperations:vi.fn().mockResolvedValue([]),projects:vi.fn(),sessions:vi.fn(),codexManagementContext:vi.fn()}}));
vi.mock("./CodexSettingsPanel",()=>({CodexSettingsPanel:({workspace,machineId,projectId}: {workspace?:boolean;machineId?:string;projectId?:string})=><p>settings:{workspace?"workspace":projectId??machineId}</p>}));
vi.mock("./PermissionPanel",()=>({PermissionPanel:()=>null}));
vi.mock("./CodexOperationsPanel",()=>({CodexOperationsPanel:()=>null}));
vi.mock("./CodexInspectionPanel",()=>({CodexInspectionPanel:()=>null}));
const machines=[{id:"m",name:"Office",hostname:"office",identity:"paired",reachability:"live"},{id:"n",name:"Home",hostname:"home",identity:"paired",reachability:"unreachable"}] as Machine[];
afterEach(()=>{cleanup();vi.resetAllMocks();});
it("central settings start with workspace defaults and require an explicit host for exceptions",async()=>{
 vi.mocked(api.projects).mockResolvedValue({items:[],nextCursor:null,total:0});
 render(<CodexConfiguration machines={machines}/>);
 expect(await screen.findByText("settings:workspace")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"单独配置"}));
 expect(api.projects).not.toHaveBeenCalled();
 fireEvent.change(screen.getByLabelText("主机"),{target:{value:"m"}});
 await screen.findByText("settings:m");
 expect(api.sessions).not.toHaveBeenCalled();
});
it("host and project search loads next pages instead of restricting choices to dashboard items",async()=>{
 vi.mocked(api.projects).mockImplementation(async opts=>({items:[{id:opts.cursor?"p2":"p",machineId:"m",alias:opts.cursor?"Second":"First",pathHint:"/project",syncContent:true,retentionDays:7}],nextCursor:opts.cursor?null:"next",total:2}));
 render(<CodexConfiguration machines={machines} initialMachineId="m"/>);
 await screen.findByRole("option",{name:"First · /project"});
 fireEvent.click(screen.getByRole("button",{name:"加载更多项目"}));
 await screen.findByRole("option",{name:"Second · /project"});
 fireEvent.change(screen.getByLabelText("项目"),{target:{value:"p2"}});
 expect(screen.getByText("settings:p2")).toBeTruthy();
 fireEvent.change(screen.getByLabelText("搜索项目"),{target:{value:"needle"}});
 await waitFor(()=>expect(api.projects).toHaveBeenLastCalledWith(expect.objectContaining({q:"needle",machineId:"m"}),expect.any(AbortSignal)));
 expect(screen.getByText("settings:m")).toBeTruthy();
});
it("native management never borrows or claims a session automatically",async()=>{
 vi.mocked(api.projects).mockResolvedValue({items:[],nextCursor:null,total:0});
 vi.mocked(api.hostOperations).mockResolvedValue([]);
 vi.mocked(api.sessions).mockResolvedValue({items:[],nextCursor:null,total:0});
 render(<CodexConfiguration machines={machines} initialMachineId="m"/>);
 fireEvent.click(screen.getByRole("button",{name:"账号与工具"}));
 await screen.findByLabelText("操作会话");
 await waitFor(()=>expect(api.sessions).toHaveBeenCalledWith(expect.objectContaining({machineId:"m",managed:true,provider:"codex"}),expect.any(AbortSignal)));
 expect(api.codexManagementContext).not.toHaveBeenCalled();
 fireEvent.change(screen.getByLabelText("搜索会话"),{target:{value:"deploy"}});
 await waitFor(()=>expect(api.sessions).toHaveBeenLastCalledWith(expect.objectContaining({q:"deploy"}),expect.any(AbortSignal)));
 fireEvent.change(screen.getByLabelText("主机"),{target:{value:"n"}});
 await waitFor(()=>expect(api.sessions).toHaveBeenLastCalledWith(expect.objectContaining({machineId:"n",q:undefined}),expect.any(AbortSignal)));
 expect(api.codexManagementContext).not.toHaveBeenCalled();
});

it("voice selection is directly discoverable and its draft survives default-category navigation",async()=>{
 vi.mocked(api.voicePreferences).mockResolvedValue({voice:"sol",revision:0,voices:["sol","coral"]});
 render(<CodexConfiguration machines={machines}/>);
 fireEvent.click(screen.getByRole("button",{name:"语音音色"}));
 const select=await screen.findByRole("combobox");
 fireEvent.change(select,{target:{value:"coral"}});
 fireEvent.click(screen.getByRole("button",{name:"模型与回复"}));
 expect(screen.queryByRole("combobox")).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"语音音色"}));
 expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("coral");
});
