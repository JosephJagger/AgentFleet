import { describe, expect, it } from "vitest";
import { applyPromptCompletion, promptCompletions } from "./prompt-completions";

describe("prompt completions", () => {
  it.each([["Use types", "TypeScript"], ["请使用types", "TypeScript"], ["write unit te", "unit tests"], ["use responsive", "responsive design"]])("completes mixed and English input: %s", (prompt, label) => {
    expect(promptCompletions(prompt, prompt.length)[0]?.label).toBe(label);
  });
  it.each(["the button doesn't work", "the page is slow", "the layout is broken on mobile", "I keep getting logged out", "the numbers don't match", "I can't save", "make it look better"])("rewrites English plain language: %s", (prompt) => {
    const suggestion = promptCompletions(prompt, prompt.length)[0];
    expect(suggestion.kind).toBe("rewrite");
    expect(suggestion.insertText).not.toMatch(/[\u3400-\u9fff]/);
  });
  it("does not suggest a completed phrase again or replace inside a word", () => {
    const prompt = "请排查 React";
    const next = applyPromptCompletion(prompt, promptCompletions(prompt, prompt.length)[0]);
    expect(promptCompletions(next.value, next.caret).filter(item => item.kind === "phrase")).toEqual([]);
    expect(promptCompletions("use typescript", 8)).toEqual([]);
    expect(promptCompletions("use TypeScript", 14)).toEqual([]);
  });
  it("completes English development instructions", () => {
    const prompt = "Please refactor";
    const suggestion = promptCompletions(prompt, prompt.length)[0];
    expect(suggestion.kind).toBe("phrase");
    expect(applyPromptCompletion(prompt, suggestion).value).toContain("preserving behavior");
  });
  it("matches English development terms at the caret", () => {
    const prompt = "请用 type";
    expect(promptCompletions(prompt, prompt.length)[0]).toMatchObject({ label: "TypeScript", kind: "term", replaceStart: 3, replaceEnd: 7 });
  });

  it("matches Chinese development concepts and replaces only the active fragment", () => {
    const prompt = "请补充单元，并保留说明";
    const completion = promptCompletions(prompt, 5)[0];
    expect(completion.label).toBe("单元测试");
    expect(applyPromptCompletion(prompt, completion)).toEqual({ value: "请补充单元测试，并保留说明", caret: 7 });
  });

  it("does not compete with slash commands or completed terms", () => {
    expect(promptCompletions("/type", 5)).toEqual([]);
    expect(promptCompletions("使用 TypeScript", 13)).toEqual([]);
  });

  it("completes a development instruction from its context", () => {
    const prompt = "请为这个接口补充";
    const completion = promptCompletions(prompt, prompt.length)[0];
    expect(completion).toMatchObject({ kind: "phrase", label: "单元测试，并覆盖正常、边界和异常分支" });
    expect(applyPromptCompletion(prompt, completion).value).toBe("请为这个接口补充单元测试，并覆盖正常、边界和异常分支");
  });

  it("rewrites a non-technical description into an actionable engineering request", () => {
    const prompt = "请帮我看看，按钮点了没反应";
    const completion = promptCompletions(prompt, prompt.length)[0];
    expect(completion).toMatchObject({ kind: "rewrite", replaceStart: 6, replaceEnd: prompt.length });
    expect(applyPromptCompletion(prompt, completion).value).toBe("请帮我看看，排查按钮点击事件未触发或异步请求失败的问题，并补充明确的错误反馈");
  });
});
