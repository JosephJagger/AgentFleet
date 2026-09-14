import test from "node:test";
import assert from "node:assert/strict";
import { chineseConcepts, localChineseSuggestions } from "../src/writing-nlp.js";

for (const [draft, intent] of [
  ["登录之后过一会儿就自己退出来了", "session-expiry"],
  ["账号莫名其妙就掉线", "session-expiry"],
  ["手机屏幕上按钮和文字挤在一起", "mobile-layout"],
  ["页面打开要等半天", "page-performance"],
  ["按钮按了之后完全没有反应", "button-response"],
  ["表单填写完后怎么都保存不了", "save-failure"],
  ["报表的数字和昨天统计的不一样", "data-discrepancy"],
  ["等我打完字再搜索", "input-debounce"],
  ["提交订单点了两次产生重复订单", "duplicate-submit"],
  ["服务器发出的请求一直超时", "api-failure"],
  ["页面列表几千条数据滑动很卡", "large-list"],
]) test(`Chinese NLP finds ${intent}: ${draft}`, () => {
  const result = localChineseSuggestions(draft).suggestions;
  assert.equal(result.length, 1); assert.equal(result[0]!.intent, intent);
  assert.ok(result[0]!.insertText.endsWith(draft!));
});

test("NLP preserves surrounding sentences and declines negation, ambiguity, code and sensitive drafts", () => {
  const draft = "不要修改其他页面。登录之后过一会儿就自己退出来了";
  const suggestion = localChineseSuggestions(draft).suggestions[0]!;
  assert.equal(draft.slice(0, suggestion.replaceStart), "不要修改其他页面。");
  assert.equal(suggestion.replaceEnd, draft.length);
  assert.deepEqual(localChineseSuggestions(suggestion.insertText).suggestions, []);
  for (const input of ["不要自动退出登录", "登录不会自己退出", "不是页面很慢", "页面已经修复但还是慢", "我不希望登录会话自动失效", "页面慢而且手机按钮重叠", "登录退出", "这是任意的聊天内容", "const x = `页面很慢`", "页面慢 password=secret", "页面慢 https://example.test", "/页面慢", "页面".repeat(1200), null]) {
    assert.deepEqual(localChineseSuggestions(input).suggestions, [], String(input));
  }
  assert.ok(chineseConcepts("登陆之后过一会儿就退出来").has("auth"));
});

test("semantic retrieval abstains on weak or ambiguous matches and preserves the original constraints",async()=>{
  const {hybridWritingSuggestions}=await import("../src/writing-nlp.js");
  let calls=0;
  const search=async()=>{calls++;return [{intent:"agent-context",score:.89},{intent:"agent-tools",score:.62}];};
  const draft="只处理当前项目。助手记不清之前的要求，保持已有接口兼容";
  const result=await hybridWritingSuggestions(draft,search);
  assert.equal(result.suggestions[0]!.source,"semantic");
  assert.equal(draft.slice(0,result.suggestions[0]!.replaceStart),"只处理当前项目。");
  assert.ok(result.suggestions[0]!.insertText.endsWith("助手记不清之前的要求，保持已有接口兼容"));
  assert.equal(calls,1);
  assert.deepEqual((await hybridWritingSuggestions("不要让助手修改文件",search)).suggestions,[]);assert.equal(calls,1);
  assert.deepEqual((await hybridWritingSuggestions("这是一段普通描述",async()=>[{intent:"agent-context",score:.73}])).suggestions,[]);
  assert.deepEqual((await hybridWritingSuggestions("这是一段普通描述",async()=>[{intent:"agent-context",score:.85},{intent:"agent-tools",score:.80}])).suggestions,[]);
  assert.equal((await hybridWritingSuggestions("I keep getting logged out",search)).suggestions[0]!.intent,"session-expiry");
});

test("curated bilingual corpus covers six domains without duplicate IDs or overlong suggestions",async()=>{
  const {default:corpus}=await import("../src/writing-corpus.json",{with:{type:"json"}});
  assert.equal(new Set(corpus.intents.map(item=>item.id)).size,corpus.intents.length);
  assert.equal(new Set(corpus.intents.map(item=>item.domain)).size,6);
  for(const intent of corpus.intents) for(const example of [...intent.examples.zh,...intent.examples.en]) {
    const result=localChineseSuggestions(example).suggestions;
    assert.equal(result[0]?.intent,intent.id,example);
    assert.ok(result[0]!.label.length<=500);
  }
});
