import Fuse from "fuse.js";
import softwareTerms from "./software-terms.generated.json";

export type LearnedTerm = { id: string; phrase: string; replacement: string; scope: string; uses: number; status: string };
export type PromptCompletion = {
  memoryId?: string;
  label: string;
  insertText: string;
  detail: string;
  kind: "term" | "phrase" | "rewrite";
  replaceStart: number;
  replaceEnd: number;
};

type CompletionTerm = {
  label: string;
  detail: string;
  aliases: string[];
};

const terms: CompletionTerm[] = [
  { label: "防抖", detail: "停止输入后再触发操作", aliases: ["防抖", "停止输入再查"] },
  { label: "debounce", detail: "停止输入后再触发操作", aliases: ["debounce", "debouncing"] },
  { label: "节流", detail: "限制操作触发频率", aliases: ["节流", "限制触发频率"] },
  { label: "throttle", detail: "限制操作触发频率", aliases: ["throttle", "throttling"] },
  { label: "unit tests", detail: "验证独立逻辑单元", aliases: ["unit tests", "unit test"] },
  { label: "integration tests", detail: "验证模块间协作", aliases: ["integration tests", "integration"] },
  { label: "end-to-end tests", detail: "验证完整用户流程", aliases: ["end-to-end tests", "e2e"] },
  { label: "responsive design", detail: "适配不同屏幕尺寸", aliases: ["responsive design", "responsive"] },
  { label: "accessibility", detail: "键盘和辅助技术可用性", aliases: ["accessibility", "a11y"] },
  { label: "database migration", detail: "可追踪的数据库结构变更", aliases: ["database migration"] },
  { label: "error handling", detail: "定义失败路径与恢复行为", aliases: ["error handling"] },
  { label: "concurrency safety", detail: "避免并发读写冲突", aliases: ["concurrency safety"] },
  { label: "TypeScript", detail: "类型安全的 JavaScript", aliases: ["typescript", "type", "ts", "类型脚本"] },
  { label: "JavaScript", detail: "Web 编程语言", aliases: ["javascript", "java", "js"] },
  { label: "React", detail: "组件化 UI 库", aliases: ["react", "rea"] },
  { label: "Next.js", detail: "React 全栈框架", aliases: ["next.js", "nextjs", "next"] },
  { label: "Node.js", detail: "JavaScript 运行时", aliases: ["node.js", "nodejs", "node"] },
  { label: "Tailwind CSS", detail: "原子化 CSS 框架", aliases: ["tailwind css", "tailwind", "tail"] },
  { label: "REST API", detail: "基于资源的 HTTP 接口", aliases: ["rest api", "rest", "接口"] },
  { label: "GraphQL", detail: "API 查询语言", aliases: ["graphql", "graph"] },
  { label: "WebSocket", detail: "双向实时通信协议", aliases: ["websocket", "websock", "ws"] },
  { label: "Server-Sent Events", detail: "服务端单向事件流", aliases: ["server-sent events", "sse"] },
  { label: "PostgreSQL", detail: "关系型数据库", aliases: ["postgresql", "postgres", "postg"] },
  { label: "Redis", detail: "内存数据存储", aliases: ["redis", "redi"] },
  { label: "Docker Compose", detail: "多容器本地编排", aliases: ["docker compose", "docker", "compose"] },
  { label: "Kubernetes", detail: "容器编排平台", aliases: ["kubernetes", "k8s", "kube"] },
  { label: "GitHub Actions", detail: "GitHub 自动化工作流", aliases: ["github actions", "github act", "actions"] },
  { label: "CI/CD", detail: "持续集成与持续交付", aliases: ["ci/cd", "cicd", "ci"] },
  { label: "JSON Web Token (JWT)", detail: "紧凑的身份令牌格式", aliases: ["json web token", "jwt"] },
  { label: "OAuth 2.0", detail: "授权协议", aliases: ["oauth 2.0", "oauth"] },
  { label: "单元测试", detail: "验证独立逻辑单元", aliases: ["单元测试", "单元"] },
  { label: "集成测试", detail: "验证模块间协作", aliases: ["集成测试", "集成"] },
  { label: "端到端测试", detail: "验证完整用户流程", aliases: ["端到端测试", "端到端"] },
  { label: "响应式设计", detail: "适配不同屏幕尺寸", aliases: ["响应式设计", "响应式"] },
  { label: "无障碍访问", detail: "键盘和辅助技术可用性", aliases: ["无障碍访问", "无障碍"] },
  { label: "数据库迁移", detail: "可追踪的数据库结构变更", aliases: ["数据库迁移", "数据库迁"] },
  { label: "错误处理", detail: "定义失败路径与恢复行为", aliases: ["错误处理", "错误处"] },
  { label: "并发安全", detail: "避免并发读写冲突", aliases: ["并发安全", "并发安"] },
];

const curatedLabels = new Set(terms.map(term => term.label.toLowerCase()));
const dictionary = softwareTerms.filter(term => !curatedLabels.has(term.toLowerCase()));
const fuzzyTerms = new Fuse([...terms.map(term => term.label), ...dictionary], { threshold: 0.28, ignoreLocation: true, includeScore: true, minMatchCharLength: 3 });
export const softwareTermCount = new Set([...terms.map(term => term.label.toLowerCase()), ...dictionary.map(term => term.toLowerCase())]).size;

const phraseRules: Array<{ pattern: RegExp; label: string; detail: string }> = [
  { pattern: /(?:为|给).*(?:接口|API).*补充$/i, label: "单元测试，并覆盖正常、边界和异常分支", detail: "补全测试范围" },
  { pattern: /(?:排查|分析).*React$/i, label: " 组件的渲染性能，定位瓶颈并给出修复", detail: "补全性能排查目标" },
  { pattern: /(?:优化).*(?:SQL|查询)$/i, label: "，分析执行计划并验证优化效果", detail: "补全数据库优化步骤" },
  { pattern: /(?:实现|添加).*(?:登录|认证|鉴权)$/i, label: "，处理会话过期、退出和失败反馈", detail: "补全认证边界" },
  { pattern: /(?:修复|排查).*(?:bug|错误|异常)$/i, label: "，定位根因并补充回归测试", detail: "补全修复验收要求" },
  { pattern: /重构$/i, label: "这段代码，保持现有行为并补充必要测试", detail: "补全重构约束" },
  { pattern: /\b(?:add|write).*tests? for$/i, label: " this behavior, including edge cases and failure paths", detail: "补全测试范围" },
  { pattern: /\b(?:debug|investigate).*error$/i, label: ", identify the root cause, and add a regression test", detail: "补全修复验收要求" },
  { pattern: /\brefactor$/i, label: " this code while preserving behavior and existing APIs", detail: "补全重构约束" },
  { pattern: /\b(?:optimize|analyse|analyze).*SQL$/i, label: " queries using execution plans and verify the performance improvement", detail: "补全数据库优化步骤" },
  { pattern: /\b(?:add|implement).*authentication$/i, label: ", including session expiration, logout, and error feedback", detail: "补全认证边界" },
  { pattern: /\b(?:debug|investigate).*React$/i, label: " rendering performance and identify the bottleneck before changing code", detail: "补全性能排查目标" },
];

const rewriteRules: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b(?:the )?button (?:doesn't|does not|won't) work$/i, label: "investigate why the button does not respond, check event handling and request failures, and provide clear feedback" },
  { pattern: /\b(?:the )?(?:layout|page) (?:looks wrong|is broken) on mobile$/i, label: "fix the responsive layout on mobile and check overflow, breakpoints, and touch interactions" },
  { pattern: /\b(?:login keeps failing|I keep getting logged out)$/i, label: "investigate unexpected session expiration and check token refresh and session persistence" },
  { pattern: /\b(?:the )?(?:data|numbers) (?:don't|do not) match$/i, label: "investigate the data discrepancy and verify metric definitions, query logic, time zones, and caching" },
  { pattern: /\b(?:the )?API (?:is down|doesn't work)$/i, label: "investigate the API failure using response status, timeouts, and server logs" },
  { pattern: /\b(?:it won't save|I can't save)$/i, label: "investigate the save failure and check validation, request responses, and error handling" },
  { pattern: /\bit (?:sometimes breaks|fails sometimes)$/i, label: "identify conditions that reproduce the intermittent failure and check concurrency, timeouts, and environment differences" },
  { pattern: /\bmake it (?:prettier|look better)$/i, label: "improve the visual hierarchy, spacing, typography, and interaction states while preserving the existing design language" },
  { pattern: /\badd (?:some )?feedback$/i, label: "provide clear loading, success, and failure feedback for the operation" },
  { pattern: /(?:网页|页面)(?:在)?手机上(?:乱了|显示不对|不好看)$/i, label: "修复移动端响应式布局问题，并检查内容溢出、断点和触控交互" },
  { pattern: /(?:页面|网页)(?:很卡|卡顿|加载很慢)$/i, label: "排查页面性能问题，定位长任务、重复渲染和不必要的网络请求" },
  { pattern: /按钮(?:点了|点击)(?:没反应|没用)$/i, label: "排查按钮点击事件未触发或异步请求失败的问题，并补充明确的错误反馈" },
  { pattern: /登录(?:老掉|总掉|总是退出)$/i, label: "排查登录会话意外失效的问题，检查令牌过期、刷新和持久化逻辑" },
  { pattern: /数据(?:对不上|不对|有问题)$/i, label: "核对数据口径与查询逻辑，定位聚合、时区或缓存导致的差异" },
  { pattern: /接口(?:挂了|不通|报错了?)$/i, label: "排查 API 请求失败，检查状态码、超时、重试策略和服务端日志" },
  { pattern: /(?:保存不了|保存不上|保存失败了)$/i, label: "排查保存操作失败，检查表单校验、请求响应和错误处理" },
  { pattern: /(?:有时候|偶尔)(?:坏|出错|不行)$/i, label: "定位间歇性故障的复现条件，检查竞态、超时和环境差异" },
  { pattern: /(?:改|做)(?:得|的)?好看(?:点|一点)?$/i, label: "优化界面的视觉层级、间距、排版和交互状态，并保持现有设计语言" },
  { pattern: /加个提示$/i, label: "为操作补充清晰的加载、成功和失败反馈" },
  { pattern: /(?:it is|it's) (?:broken|not working)$/i, label: "identify the reproducible failure, trace its root cause, and add a regression test" },
  { pattern: /(?:the page|it) (?:is )?(?:slow|laggy)$/i, label: "profile the page, identify rendering and network bottlenecks, and verify the improvement" },
];

function currentFragment(prompt: string, caret: number) {
  const beforeCaret = prompt.slice(0, caret);
  for (let length = Math.min(40, beforeCaret.length); length >= 2; length -= 1) {
    const query = beforeCaret.slice(-length);
    const previous = beforeCaret[beforeCaret.length - length - 1];
    if (previous && /[A-Za-z0-9_./:@-]/.test(previous)) continue;
    if (!/^[A-Za-z][A-Za-z0-9.+# /-]*$/.test(query)) continue;
    if (terms.some(term => term.aliases.some(alias => alias.toLowerCase().startsWith(query.toLowerCase())))) {
      return { query, start: caret - query.length, end: caret };
    }
  }
  // Chinese has no word separators. Find the longest suffix that begins a known alias
  // so surrounding prose is preserved when the completion is applied.
  for (let length = Math.min(8, beforeCaret.length); length >= 2; length -= 1) {
    const query = beforeCaret.slice(-length);
    if (!/^[\u3400-\u9fff]+$/.test(query)) continue;
    if (terms.some((term) => term.aliases.some((alias) => /^[\u3400-\u9fff]+$/.test(alias) && alias.startsWith(query)))) {
      return { query, start: caret - query.length, end: caret };
    }
  }
  return undefined;
}

export function promptCompletions(prompt: string, caret: number, limit = 5, learned: LearnedTerm[] = []): PromptCompletion[] {
  if (!prompt || prompt.trimStart().startsWith("/") || caret < 0 || caret > prompt.length) return [];
  // Do not replace a word fragment while the caret is inside that word.
  if (/[A-Za-z0-9_]/.test(prompt[caret] ?? "")) return [];
  const beforeCaret = prompt.slice(0, caret);
  const learnedMatches: PromptCompletion[] = learned.filter(entry => entry.status === "active").sort((a,b) => b.uses-a.uses).flatMap(entry => {
    const phrase = entry.phrase.toLowerCase();
    const before = beforeCaret.toLowerCase();
    const isRewrite = entry.phrase !== entry.replacement;
    const query = isRewrite ? entry.phrase : beforeCaret.match(/[A-Za-z][A-Za-z0-9._+-]*$|[\u3400-\u9fff]{2,20}$/)?.[0];
    if (!query || query.length < 2 || (isRewrite ? !before.endsWith(phrase) : !phrase.startsWith(query.toLowerCase()) || phrase === query.toLowerCase())) return [];
    const start = caret-query.length;
    if (/[A-Za-z0-9_]/.test(prompt[start-1] ?? "") && /^[A-Za-z]/.test(query)) return [];
    return [{ memoryId: entry.id, label: entry.replacement, insertText: entry.replacement, detail: entry.scope === "project" ? "项目词库" : "个人词库", kind: isRewrite ? "rewrite" : "term", replaceStart: start, replaceEnd: caret }];
  });
  const token = beforeCaret.match(/(?:^|[^A-Za-z0-9_./:@-])([A-Za-z][A-Za-z0-9.+#-]{2,39})$/)?.[1];
  const dictionaryMatches: PromptCompletion[] = !token ? [] : (() => {
    if (curatedLabels.has(token.toLowerCase())) return [];
    const prefix = dictionary.filter(term => term.toLowerCase().startsWith(token.toLowerCase()) && term.toLowerCase() !== token.toLowerCase()).slice(0, limit);
    const matches = prefix.length ? prefix : token.length >= 4 && !curatedLabels.has(token.toLowerCase()) && !dictionary.some(term => term.toLowerCase() === token.toLowerCase()) ? fuzzyTerms.search(token, { limit }).map(result => result.item) : [];
    return matches.map(label => ({ label, insertText: label, detail: "软件术语词库", kind: "term", replaceStart: caret-token.length, replaceEnd: caret }));
  })();
  const rewrites = rewriteRules.flatMap((rule): PromptCompletion[] => {
    const match = rule.pattern.exec(beforeCaret);
    if (!match) return [];
    return [{
      label: rule.label,
      insertText: rule.label,
      detail: "将口语描述改成可执行的专业表达",
      kind: "rewrite",
      replaceStart: caret - match[0].length,
      replaceEnd: caret,
    }];
  });
  const phrases = phraseRules
    .filter((rule) => rule.pattern.test(beforeCaret))
    .map((rule): PromptCompletion => ({
      label: rule.label.trimStart(),
      insertText: rule.label,
      detail: rule.detail,
      kind: "phrase",
      replaceStart: caret,
      replaceEnd: caret,
    }));
  const fragment = currentFragment(prompt, caret);
  if (!fragment || fragment.query.length < 2) return [...learnedMatches, ...rewrites, ...phrases, ...dictionaryMatches].slice(0, limit);
  const query = fragment.query.toLocaleLowerCase();
  const termMatches = terms
    .map((term) => {
      if (term.label.toLowerCase() === query) return { term, score: 99 };
      const scores = term.aliases.map((alias) => {
        const normalized = alias.toLocaleLowerCase();
        if (normalized === query) return term.label.toLocaleLowerCase() === query ? 99 : 0;
        if (normalized.startsWith(query)) return normalized.length - query.length + 1;
        return 99;
      });
      return { term, score: Math.min(...scores) };
    })
    .filter(({ score }) => score < 99)
    .sort((a, b) => a.score - b.score || a.term.label.localeCompare(b.term.label))
    .map(({ term }): PromptCompletion => ({ label: term.label, insertText: term.label, detail: term.detail, kind: "term", replaceStart: fragment.start, replaceEnd: fragment.end }));
  return [...learnedMatches, ...rewrites, ...phrases, ...termMatches, ...dictionaryMatches].filter((item,index,all) => all.findIndex(other => other.label === item.label) === index).slice(0, limit);
}

export function applyPromptCompletion(prompt: string, completion: PromptCompletion) {
  const suffix = prompt.slice(completion.replaceEnd);
  const value = prompt.slice(0, completion.replaceStart) + completion.insertText + suffix;
  return { value, caret: completion.replaceStart + completion.insertText.length };
}
