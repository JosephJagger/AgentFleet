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

it("AI failures show localized actionable messages without provider details",async()=>{
  const {writingAIErrorMessage}=await import('./lib/writing-assistance');
  const {ApiError}=await import('./lib/types');
  expect(writingAIErrorMessage(new ApiError('secret provider detail',502,'WRITING_AI_TRUNCATED'))).toContain('截断');
  expect(writingAIErrorMessage(new ApiError('secret provider detail',502,'WRITING_AI_AUTH'))).toContain('密钥');
  setLocale('en');
  expect(writingAIErrorMessage(new ApiError('secret provider detail',504,'WRITING_AI_TIMEOUT'))).toContain('timed out');
  expect(writingAIErrorMessage(new Error('secret provider detail'))).not.toContain('secret');
});

it("provider presets prefill official endpoints and models without carrying keys across providers",async()=>{
 vi.mocked(api.writingAI).mockResolvedValue({endpoint:'https://api.deepseek.com',model:'deepseek-flash',hasKey:true,enabled:true,configured:true});
 render(<WritingAISettings/>);
 await waitFor(()=>expect((screen.getByRole('button',{name:'保存 AI 配置'}) as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:/查看与编辑连接配置/}));
 const provider=screen.getByLabelText('AI 服务商');
 expect((provider as HTMLSelectElement).value).toBe('deepseek');
 fireEvent.change(screen.getByLabelText('API 密钥'),{target:{value:'do-not-forward'}});
 fireEvent.change(provider,{target:{value:'openai'}});
 expect((screen.getByLabelText('API 基础地址') as HTMLInputElement).value).toBe('https://api.openai.com/v1');
 expect((screen.getByLabelText('模型名称') as HTMLInputElement).value).toBe('gpt-4.1-mini');
 expect((screen.getByLabelText('API 密钥') as HTMLInputElement).value).toBe('');
 fireEvent.change(provider,{target:{value:'custom'}});
 expect((screen.getByLabelText('API 基础地址') as HTMLInputElement).value).toBe('');
 fireEvent.change(provider,{target:{value:'deepseek'}});
 expect((screen.getByLabelText('API 基础地址') as HTMLInputElement).value).toBe('https://api.deepseek.com');
});
