import { locale, setLocale, t } from "../i18n";
import domainTerms from "./domain-terms.generated.json";
import { afterEach, describe, expect, it } from "vitest";
import { applyPromptCompletion, promptCompletions, softwareTermCount } from "./prompt-completions";

describe("prompt completions", () => {
  it.each(["登录老掉", "登陆老掉", "登陆老掉。", "登录经常掉线", "登陆总是退出 "])("recognizes Chinese login wording: %s", prompt => {
    expect(promptCompletions(prompt, prompt.length)[0]).toMatchObject({ kind: "rewrite", label: "排查登录会话意外失效的问题，检查令牌过期、刷新和持久化逻辑" });
  });
  it("uses the open-source dictionary with typo tolerance", () => {
    expect(softwareTermCount).toBeGreaterThan(3900);
    expect(promptCompletions("use typscript", 13).some(item=>item.label === "TypeScript")).toBe(true);
  });
  it("uses only confirmed learned entries and keeps surrounding text", () => {
    const entries = [{id:"a",phrase:"等我输完再查",replacement:"对输入查询添加防抖",scope:"project",status:"active",uses:3}, {id:"b",phrase:"MysteryTerm",replacement:"MysteryTerm",scope:"personal",status:"candidate",uses:0}];
    const prompt="请实现：等我输完再查";
    const completion=promptCompletions(prompt,prompt.length,5,entries)[0];
    expect(completion.memoryId).toBe("a");
    expect(applyPromptCompletion(prompt,completion).value).toBe("请实现：对输入查询添加防抖");
    expect(promptCompletions("Mystery",7,5,entries).some(item=>item.memoryId === "b")).toBe(false);
  });
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

it.each([['波纹剪','波纹剪辑'],['认识','认识论'],['元认','元认知'],['Epistem','Epistemology'],['Rotoscop','Rotoscoping'],['LUT','Look-up table']])('completes specialist terminology %s', (input,label)=>{
 expect(promptCompletions(input,input.length).some(item=>item.label===label)).toBe(true);
});
it.each(['先听到下个镜头的声音再切画面','我是否只找支持自己观点的证据','Make the background music quieter while someone speaks'])('offers a scoped wording suggestion for %s',input=>{
 expect(promptCompletions(input,input.length)[0]?.kind).toBe('rewrite');
});


describe("completion description localization", () => {
  const originalLocale = locale();
  afterEach(() => setLocale(originalLocale));

  it("localizes the mixed-source co suggestions without changing inserted terms", () => {
    const suggestions = promptCompletions("co", 2, 12);
    expect(suggestions.map(item => item.label)).toEqual(expect.arrayContaining(["Docker Compose", "Conforming", "Color gamut", "Color space", "Color grading"]));
    setLocale("zh-CN");
    for (const item of suggestions) expect(t(item.detail)).toMatch(/[\u3400-\u9fff]/);
    const conforming = suggestions.find(item => item.label === "Conforming")!;
    expect(t(conforming.detail)).toBe("把剪辑对应到高质量原始素材");
    setLocale("en");
    for (const item of suggestions) expect(t(item.detail)).not.toMatch(/[\u3400-\u9fff]/);
    expect(t(conforming.detail)).toBe("Relink an edit to high-quality source media");
    expect(applyPromptCompletion("co", conforming).value).toBe("Conforming");
  });

  it("provides both interface languages for every generated domain description", () => {
    for (const term of domainTerms) {
      setLocale("zh-CN");
      expect(t(term.detail)).toMatch(/[\u3400-\u9fff]/);
      setLocale("en");
      expect(t(term.detail)).not.toMatch(/[\u3400-\u9fff]/);
    }
  });
});

it.each([['RAG','Retrieval-augmented generation'],['LoRA','Low-rank adaptation'],['MCP','Model Context Protocol'],['VLM','Vision-language model'],['提示词工','提示词工程'],['向量检','向量检索'],['上下文窗','上下文窗口'],['KV','KV cache']])('completes AI terms and abbreviations: %s',(input,label)=>{
 expect(promptCompletions(input,input.length).some(item=>item.label===label)).toBe(true);
});
it.each(['AI总是编造答案','让AI根据公司文档回答问题','agent一直重复调用同一个工具','The model keeps returning invalid JSON'])('suggests actionable AI wording: %s',input=>{
 expect(promptCompletions(input,input.length)[0]?.kind).toBe('rewrite');
});

it.each([['SKU','Stock keeping unit'],['ROAS','Return on ad spend'],['RFM','RFM segmentation'],['夏普','夏普比率'],['最大回','最大回撤'],['前视偏','前视偏差'],['LoRA','Low-rank adaptation'],['MCP','Model Context Protocol'],['置信区','置信区间'],['客户获取','客户获取成本']])('completes business and quantitative concepts: %s',(input,label)=>{
 expect(promptCompletions(input,input.length).some(item=>item.label===label)).toBe(true);
});
it.each(['回测赚钱实盘却亏钱','海外仓经常断货','访问很多但就是没人下单','The AI keeps making up facts','ROAS looks great but we still lose money'])('rewrites specialist plain language: %s',input=>{
 expect(promptCompletions(input,input.length)[0]?.kind).toBe('rewrite');
});
