// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WritingPreferencesPanel, WritingPreferencesFields } from "./components/WritingPreferencesPanel";
import { useCompletionPreferences } from "./lib/completion-preferences";
import { WritingAISettings } from "./components/WritingAISettings";
import { api } from "./lib/api";
import { setLocale } from "./i18n";
vi.mock("./lib/api",()=>({api:{writingPreferences:vi.fn(),saveWritingPreferences:vi.fn(),writingHistory:vi.fn(),writingHistoryFeedback:vi.fn(),writingAI:vi.fn(),saveWritingAI:vi.fn(),writingLearning:vi.fn(),saveWritingEntry:vi.fn(),deleteWritingEntry:vi.fn()}}));
afterEach(()=>{cleanup();vi.resetAllMocks();setLocale("zh-CN");});
it("English AI settings remain optional and do not request suggestions on save",async()=>{
  setLocale("en");
  vi.mocked(api.writingAI).mockResolvedValue({endpoint:"",model:"",enabled:false,hasKey:false,configured:false});
  vi.mocked(api.saveWritingAI).mockResolvedValue({endpoint:"https://provider.test/v1",model:"test",enabled:true,hasKey:true,configured:true});
  render(<WritingAISettings/>);
  await waitFor(()=>expect((screen.getByRole("button",{name:"Save AI settings"}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText("API base URL"),{target:{value:"https://provider.test/v1"}});
  fireEvent.change(screen.getByLabelText("Model name"),{target:{value:"test"}});
  fireEvent.change(screen.getByLabelText("API key"),{target:{value:"test-secret"}});
  fireEvent.click(screen.getByLabelText("Enable AI understanding"));
  fireEvent.submit(screen.getByRole("button",{name:"Save AI settings"}).closest("form")!);
  await screen.findByText("AI settings saved");
  expect(api.saveWritingAI).toHaveBeenCalledWith({endpoint:"https://provider.test/v1",model:"test",apiKey:"test-secret",enabled:true,clearKey:false});
  expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("");
});


it("shows only automatic input options and saves account defaults",async()=>{
 const defaults={terms:true,suggestions:true,nlp:true,learning:true};
 vi.mocked(api.writingPreferences).mockImplementation(async()=>({defaults,overrides:null,effective:defaults}));
 vi.mocked(api.saveWritingPreferences).mockImplementation(async value=>{Object.assign(defaults,value);return {defaults,overrides:null,effective:defaults};});
 render(<WritingPreferencesPanel owner="owner"/>);
 await waitFor(()=>expect((screen.getByRole('checkbox',{name:/自动积累词库与表达/}) as HTMLInputElement).disabled).toBe(false));
 expect(screen.queryByText('确认采用')).toBeNull();expect(screen.queryByText('问答记录与反馈')).toBeNull();
 expect(screen.getAllByRole('checkbox')).toHaveLength(4);
 fireEvent.click(screen.getByRole('checkbox',{name:/自动积累词库与表达/}));
 await waitFor(()=>expect(api.saveWritingPreferences).toHaveBeenCalledWith({learning:false},undefined));
});

it("session options inherit individually and restore global settings",async()=>{
 const defaults={terms:false,suggestions:true,nlp:true,learning:false};let overrides:Partial<typeof defaults>|null=null;
 const value=()=>({defaults,overrides,effective:{...defaults,...overrides}});
 vi.mocked(api.writingPreferences).mockImplementation(async()=>value());
 vi.mocked(api.saveWritingPreferences).mockImplementation(async next=>{overrides=next===null?null:{...overrides,...next};return value();});
 function SessionOptions(){const settings=useCompletionPreferences('owner','session');return <WritingPreferencesFields settings={settings} session/>;}
 render(<SessionOptions/>);
 await waitFor(()=>expect((screen.getByRole('checkbox',{name:/术语补全/}) as HTMLInputElement).disabled).toBe(false));
 fireEvent.click(screen.getByRole('checkbox',{name:/术语补全/}));
 await screen.findByText('会话覆盖');
 expect((screen.getByRole('checkbox',{name:/自动积累词库与表达/}) as HTMLInputElement).checked).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'恢复继承全局设置'}));
 await waitFor(()=>expect(api.saveWritingPreferences).toHaveBeenLastCalledWith(null,'session'));
 await waitFor(()=>expect((screen.getByRole('checkbox',{name:/术语补全/}) as HTMLInputElement).checked).toBe(false));
});
