// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WritingAISettings } from "./components/WritingAISettings";
import { api } from "./lib/api";
vi.mock("./lib/api",()=>({api:{writingAI:vi.fn(),saveWritingAI:vi.fn()}}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
it("toggles repeatedly without submitting and summarizes only saved models",async()=>{
 const saved={endpoint:"https://example.test/v1",model:"saved-model",enabled:true,hasKey:true,configured:true};
 vi.mocked(api.writingAI).mockResolvedValue(saved);
 vi.mocked(api.saveWritingAI).mockResolvedValue({...saved,model:"new-model"});
 render(<WritingAISettings/>);
 await screen.findByText("已保存模型：saved-model");
 const toggle=screen.getByRole("button",{name:/查看与编辑连接配置/});
 for(let i=0;i<3;i++){
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  fireEvent.change(screen.getByLabelText("模型名称"),{target:{value:"new-model"}});
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByText("已保存模型：saved-model")).toBeTruthy();
 }
 expect(api.saveWritingAI).not.toHaveBeenCalled();
 fireEvent.click(toggle);
 expect((screen.getByLabelText("模型名称") as HTMLInputElement).value).toBe("new-model");
 fireEvent.click(screen.getByRole("button",{name:"保存 AI 配置"}));
 await screen.findByText("已保存模型：new-model");
 fireEvent.click(toggle);
 expect(toggle.getAttribute("aria-expanded")).toBe("false");
});
it("keeps the previous summary after a failed save",async()=>{
 vi.mocked(api.writingAI).mockResolvedValue({endpoint:"https://example.test/v1",model:"old",enabled:true,hasKey:true,configured:true});
 vi.mocked(api.saveWritingAI).mockRejectedValue(new Error("failed"));
 render(<WritingAISettings/>);
 await screen.findByText("已保存模型：old");
 fireEvent.click(screen.getByRole("button",{name:/查看与编辑连接配置/}));
 fireEvent.change(screen.getByLabelText("模型名称"),{target:{value:"draft"}});
 fireEvent.click(screen.getByRole("button",{name:"保存 AI 配置"}));
 await waitFor(()=>expect(screen.getByText("AI 配置保存失败，请检查地址与模型名称")).toBeTruthy());
 expect(screen.getByText("已保存模型：old")).toBeTruthy();
});
