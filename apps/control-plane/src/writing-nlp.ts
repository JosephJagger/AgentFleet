import corpus from "./writing-corpus.json" with { type: "json" };
import type { SemanticMatch } from "./writing-semantic.js";
import { safeWritingText } from "./writing-memory.js";

// ICU word segmentation is supplied by the pinned Node runtime; no remote model.
const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
const synonyms: Record<string, string[]> = {
  auth: ["登录", "登陆", "会话", "登入", "账号", "帐号"],
  exit: ["退出", "退出来", "掉线", "掉登录", "老掉", "总掉", "失效", "掉了"],
  unexpected: ["自己", "自动", "一会儿", "过一会儿", "总是", "老是", "经常", "老", "总", "莫名其妙", "意外", "老掉", "总掉", "动不动"],
  page: ["页面", "网页", "界面", "首屏", "列表"],
  slow: ["慢", "很慢", "太慢", "特别慢", "很卡", "太卡", "卡", "卡顿", "很久", "半天", "转圈", "卡住", "卡死", "不流畅", "迟钝"],
  button: ["按钮", "按键", "点击", "点了", "点一下"],
  unresponsive: ["没反应", "没有反应", "无响应", "不响应", "没动静", "没用", "不动", "没变化"],
  mobile: ["手机", "移动端", "小屏幕", "窄屏", "手机上"],
  layout: ["挤", "挤在一起", "遮挡", "挡住", "重叠", "溢出", "乱", "错位", "看不全", "超出", "显示不全"],
  save: ["保存", "存档", "提交表单"],
  failure: ["不了", "失败", "不成功", "不上", "报错", "不行", "无法", "不能", "没保存", "没有保存"],
  data: ["数据", "数字", "金额", "统计", "报表"],
  discrepancy: ["对不上", "不一致", "不一样", "不对", "差异", "不准确"],
  input: ["输入", "打字", "搜索框", "搜索", "查询", "输入框"],
  wait: ["停下来", "停下", "停止", "输完", "打完", "输入完", "停止输入"],
  query: ["查", "查询", "搜索", "请求"],
  repeat: ["重复", "两次", "多次", "好几次", "连点", "多点", "多点几下"],
  submit: ["提交", "订单", "下单", "付款", "支付"],
  api: ["接口", "api", "服务端", "服务器", "请求"],
  timeout: ["超时", "不通", "断开", "连不上", "连接失败"],
  list: ["列表", "表格", "长列表"],
  large: ["很多", "上万", "几万", "大量", "太多", "几千"],
};
const lexicon = new Map<string, Set<string>>();
for (const [concept, aliases] of Object.entries(synonyms)) for (const alias of aliases) {
  const concepts = lexicon.get(alias) ?? new Set<string>(); concepts.add(concept); lexicon.set(alias, concepts);
}

export function chineseConcepts(text: string): Set<string> {
  const words = [...segmenter.segment(text.normalize("NFKC").toLowerCase())].map(word => word.isWordLike ? word.segment : "|");
  const concepts = new Set<string>();
  for (let start = 0; start < words.length; start++) {
    let phrase = "";
    for (let end = start; end < Math.min(words.length, start + 6); end++) {
      if (words[end] === "|") break;
      phrase += words[end];
      for (const concept of lexicon.get(phrase) ?? []) concepts.add(concept);
      if (phrase.length > 16) break;
    }
  }
  return concepts;
}

type Intent = { id: string; groups: string[][]; label: string };
const intents: Intent[] = [
  { id: "session-expiry", groups: [["auth"], ["exit"], ["unexpected"]], label: "排查登录会话意外失效" },
  { id: "large-list", groups: [["list"], ["large"], ["slow"]], label: "排查大数据量列表的渲染性能" },
  { id: "page-performance", groups: [["page"], ["slow"]], label: "排查页面加载与交互性能" },
  { id: "button-response", groups: [["button"], ["unresponsive"]], label: "排查点击交互无响应" },
  { id: "mobile-layout", groups: [["mobile"], ["layout"]], label: "修复移动端响应式布局与内容遮挡" },
  { id: "save-failure", groups: [["save"], ["failure"]], label: "排查保存操作失败" },
  { id: "data-discrepancy", groups: [["data"], ["discrepancy"]], label: "核对数据口径与结果一致性" },
  { id: "input-debounce", groups: [["input"], ["wait"], ["query"]], label: "为输入查询添加防抖" },
  { id: "duplicate-submit", groups: [["submit"], ["repeat"]], label: "检查重复提交与幂等性" },
  { id: "api-failure", groups: [["api"], ["timeout", "failure"]], label: "排查接口请求失败与超时" },
];

export type NLPSuggestion = { label: string; insertText: string; replaceStart: number; replaceEnd: number; intent: string; source?: "lexical" | "semantic"; domain?: string };
const guard = /不要|不想|不希望|不需要|不允许|不用|无需|禁止|避免|防止|并非|不是|不会|别再|已经修好|已修好|已经解决|已经修复|已解决|已修复|恢复正常|没有问题|没有异常|没有掉线|没再|不再|不怎么|不慢|不卡|\b(?:not(?! (?:match|fit|respond|work)\b)|never|don't)\b/i;

export function prepareWritingDraft(draft: unknown) {
  if (!safeWritingText(draft, 2000) || draft.trimStart().startsWith("/") || /[`{}]|\b(?:const|import|SELECT)\b/.test(draft)) return;
  const match = /[^。！？!?\n]+[。！？!?]*\s*$/.exec(draft);
  if (!match) return;
  const sentence = match[0].trim();
  if (sentence.length < 4 || sentence.length > 300 || guard.test(sentence)) return;
  if (corpus.intents.some(intent => sentence.includes(intent.goals.zh) || sentence.includes(intent.goals.en))) return;
  return { sentence, start: match.index, end: draft.length, language: /[\u3400-\u9fff]/.test(sentence) ? "zh" as const : "en" as const };
}

export function lexicalIntents(sentence: string): string[] {
  const concepts = chineseConcepts(sentence);
  const ids = new Set(intents.filter(intent => intent.groups.every(group => group.some(tag => concepts.has(tag)))).map(intent => intent.id));
  const normalized = sentence.normalize("NFKC").toLowerCase().replace(/[。！？!?.]+$/, "");
  for (const intent of corpus.intents) if ([...intent.examples.zh, ...intent.examples.en].some(example => normalized === example.normalize("NFKC").toLowerCase())) ids.add(intent.id);
  if (ids.has("large-list")) ids.delete("page-performance");
  return [...ids];
}

function suggestion(prepared: NonNullable<ReturnType<typeof prepareWritingDraft>>, id: string, source: "lexical" | "semantic"): NLPSuggestion | undefined {
  const intent = corpus.intents.find(item => item.id === id);
  if (!intent) return;
  // Preserve every condition and detail; never infer a diagnosis or implementation from similarity.
  const label = `${intent.goals[prepared.language]}${prepared.language === "zh" ? "：" : ": "}${prepared.sentence}`;
  return { label, insertText: label, replaceStart: prepared.start, replaceEnd: prepared.end, intent: id, source, domain: intent.domain };
}

export function localChineseSuggestions(draft: unknown): { suggestions: NLPSuggestion[] } {
  const prepared = prepareWritingDraft(draft);
  if (!prepared) return { suggestions: [] };
  const ids = lexicalIntents(prepared.sentence);
  const result = ids.length === 1 ? suggestion(prepared, ids[0]!, "lexical") : undefined;
  return { suggestions: result ? [result] : [] };
}

export async function hybridWritingSuggestions(draft: unknown, search: (text: string) => Promise<SemanticMatch[]>) {
  const prepared = prepareWritingDraft(draft);
  if (!prepared) return { suggestions: [] };
  const ids = lexicalIntents(prepared.sentence);
  if (ids.length > 1) return { suggestions: [] };
  if (ids.length === 1) return localChineseSuggestions(draft);
  const matches = await search(prepared.sentence);
  const first = matches[0];
  // Similarity is not probability. A close second is ambiguity, not a second rewrite.
  if (!first || first.score < 0.74 || first.score - (matches[1]?.score ?? 0) < 0.08) return { suggestions: [] };
  const result = suggestion(prepared, first.intent, "semantic");
  return { suggestions: result ? [result] : [] };
}
