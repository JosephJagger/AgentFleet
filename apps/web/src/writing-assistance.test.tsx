// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WritingMemoryPanel } from "./components/WritingMemoryPanel";
import { WritingAISettings } from "./components/WritingAISettings";
import { api } from "./lib/api";
import { setLocale } from "./i18n";
vi.mock("./lib/api",()=>({api:{writingAI:vi.fn(),saveWritingAI:vi.fn(),writingLearning:vi.fn(),saveWritingEntry:vi.fn(),deleteWritingEntry:vi.fn()}}));
afterEach(()=>{cleanup();vi.resetAllMocks();setLocale("zh-CN");});
it("reviews and deletes learned candidates without treating them as confirmed",async()=>{
  const entry={id:"word",phrase:"等我输完再查",replacement:"防抖",scope:"project" as const,status:"candidate" as const,uses:0,source_session:"a",source_event:"event"};
  const value={enabled:true,scope:"project" as const,entries:[entry]};
  vi.mocked(api.saveWritingEntry).mockResolvedValue(value);vi.mocked(api.deleteWritingEntry).mockResolvedValue({...value,entries:[]});
  const refresh=vi.fn(async()=>{});
  render(<WritingMemoryPanel sessionId="a" value={value} error="" refresh={refresh}/>);
  fireEvent.click(screen.getByText("词库与自动学习"));
  expect(screen.getByText("待确认",{exact:false})).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:"确认采用"}));
  await waitFor(()=>expect(refresh).toHaveBeenCalledOnce());
  expect(api.saveWritingEntry).toHaveBeenCalledWith("a",entry,"word");
  fireEvent.click(screen.getByRole("button",{name:"删除"}));
  await waitFor(()=>expect(api.deleteWritingEntry).toHaveBeenCalledWith("a","word"));
});
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
