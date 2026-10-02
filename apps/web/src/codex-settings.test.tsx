// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CodexSettingsPanel } from "./components/CodexSettingsPanel";
import { api } from "./lib/api";
import type { CodexPreferences } from "./lib/codex-settings";
import { parseCodexCommand } from "./lib/codex-commands";
vi.mock("./lib/api", () => ({ api: { codexPreferences: vi.fn(), machineCodexPreferences: vi.fn(), runtimePreferences: vi.fn(), saveRuntimePreferences: vi.fn() } }));
const empty = { settings: null, overrides: {}, revision: 0 };
const fixture: CodexPreferences = {
  catalog: { models: [{ model: "host-model", displayName: "Host model", efforts: ["low", "high"], defaultEffort: "low", serviceTiers: [{id:"fast",name:"Fast"}], supportsPersonality: true }], modes: ["default", "plan"], fetchedAt: "2026-10-02T00:00:00Z" },
  preferences: { workspace: { settings: null, overrides: {model:"host-model",effort:"low"},revision:2 }, machine: empty, project: empty, session: empty },
  source: "workspace", sources: {model:"workspace",effort:"workspace",mode:"codex",serviceTier:"codex",personality:"codex"}, effective:{model:"host-model",effort:"low"}, desired:{model:"host-model",effort:"low"}
};
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it("saves only the edited field, leaving other session values inherited", async () => {
  vi.mocked(api.codexPreferences).mockResolvedValue(fixture);
  vi.mocked(api.saveRuntimePreferences).mockResolvedValue({...fixture, preferences:{...fixture.preferences,session:{settings:null,overrides:{effort:"high"},revision:1}},desired:{model:"host-model",effort:"high"}});
  const changed=vi.fn(); render(<CodexSettingsPanel sessionId="s" onChange={changed}/>);
  fireEvent.click(screen.getByText("运行配置")); await screen.findByLabelText("模型");
  expect((screen.getByLabelText("模型") as HTMLSelectElement).value).toBe("");
  fireEvent.change(screen.getByLabelText("推理强度"),{target:{value:"high"}});
  fireEvent.click(screen.getByRole("button",{name:"保存配置"}));
  await waitFor(()=>expect(api.saveRuntimePreferences).toHaveBeenCalledWith("session","s",{scope:"session",overrides:{effort:"high"},revision:0}));
  await screen.findByText(/配置已保存/);
  expect(changed).toHaveBeenLastCalledWith({sessionId:"s"});
  expect((screen.getByRole("button",{name:"保存配置"}) as HTMLButtonElement).disabled).toBe(true);
});
it("distinguishes inherited, native and explicit default tier clearing",async()=>{
  vi.mocked(api.codexPreferences).mockResolvedValue(fixture);
  vi.mocked(api.saveRuntimePreferences).mockResolvedValue(fixture);
  render(<CodexSettingsPanel sessionId="s"/>);fireEvent.click(screen.getByText("运行配置"));await screen.findByLabelText("服务档位");
  fireEvent.change(screen.getByLabelText("服务档位"),{target:{value:"__clear__"}});
  fireEvent.change(screen.getByLabelText("协作模式"),{target:{value:"__native__"}});
  fireEvent.click(screen.getByRole("button",{name:"保存配置"}));
  await waitFor(()=>expect(api.saveRuntimePreferences).toHaveBeenCalledWith("session","s",{scope:"session",overrides:{serviceTier:null,mode:"__native__"},revision:0}));
});
it("editing project settings does not copy the session override into the project",async()=>{
  vi.mocked(api.codexPreferences).mockResolvedValue({...fixture,preferences:{...fixture.preferences,session:{settings:null,overrides:{effort:"high"},revision:3}}});
  render(<CodexSettingsPanel sessionId="s"/>);fireEvent.click(screen.getByText("运行配置"));await screen.findByLabelText("推理强度");
  fireEvent.change(screen.getByLabelText("配置保存范围"),{target:{value:"project"}});
  await waitFor(()=>expect((screen.getByLabelText("推理强度") as HTMLSelectElement).value).toBe(""));
  expect((screen.getByRole("button",{name:"保存配置"}) as HTMLButtonElement).disabled).toBe(true);
});
it("host configuration does not require a session and restores all inheritance",async()=>{
  vi.mocked(api.machineCodexPreferences).mockResolvedValue({...fixture,preferences:{...fixture.preferences,machine:{settings:null,overrides:{effort:"high"},revision:2}}});
  vi.mocked(api.saveRuntimePreferences).mockResolvedValue(fixture);
  render(<CodexSettingsPanel machineId="host-a"/>);await screen.findByLabelText("推理强度");
  expect(api.codexPreferences).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"全部恢复继承"}));
  await waitFor(()=>expect(api.saveRuntimePreferences).toHaveBeenCalledWith("machine","host-a",{scope:"machine",overrides:{},revision:2}));
});
it("workspace catalog is a union and saves workspace defaults",async()=>{
  vi.mocked(api.runtimePreferences).mockResolvedValue({...fixture,catalog:null,catalogs:[{machineId:"m",catalog:fixture.catalog}]});
  vi.mocked(api.saveRuntimePreferences).mockResolvedValue(fixture);
  render(<CodexSettingsPanel workspace/>);await screen.findByLabelText("推理强度");
  fireEvent.change(screen.getByLabelText("推理强度"),{target:{value:"high"}});fireEvent.click(screen.getByRole("button",{name:"保存配置"}));
  await waitFor(()=>expect(api.saveRuntimePreferences).toHaveBeenCalledWith("workspace","",{scope:"workspace",overrides:{model:"host-model",effort:"high"},revision:2}));
});
it("late reads cannot cross session boundaries",async()=>{
  let finish!: (value:CodexPreferences)=>void;
  vi.mocked(api.codexPreferences).mockImplementation(id=>id==="a"?new Promise(resolve=>{finish=resolve;}):Promise.resolve({...fixture,desired:null}));
  const summary=vi.fn();const {rerender}=render(<CodexSettingsPanel sessionId="a" onSummary={summary}/>);
  await waitFor(()=>expect(api.codexPreferences).toHaveBeenCalledTimes(1));
  rerender(<CodexSettingsPanel sessionId="b" onSummary={summary}/>);
  await waitFor(()=>expect(summary).toHaveBeenLastCalledWith(expect.objectContaining({sessionId:"b",loaded:true,settings:undefined})));
  await act(async()=>finish(fixture));
  expect(summary).toHaveBeenLastCalledWith(expect.objectContaining({sessionId:"b",settings:undefined}));
});
it("missing catalogs still allow clearing existing overrides without invented models",async()=>{
  vi.mocked(api.codexPreferences).mockResolvedValue({...fixture,catalog:null,desired:null});
  render(<CodexSettingsPanel sessionId="s"/>);fireEvent.click(screen.getByText("运行配置"));await screen.findByText(/暂无可用模型目录/);
  expect(screen.queryByRole("option",{name:"Host model"})).toBeNull();
});
it("slash parsing separates commands from file paths and ordinary prose",()=>{
  expect(parseCodexCommand("/plan build a report")).toEqual({name:"plan",args:"build a report"});
  expect(parseCodexCommand("/root/project/file.ts")).toBeNull();expect(parseCodexCommand("explain /model")).toBeNull();
});
