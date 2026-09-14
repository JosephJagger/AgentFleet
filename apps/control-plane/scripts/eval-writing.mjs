import { readFile } from 'node:fs/promises';
import { WritingSemantic } from '../dist/src/writing-semantic.js';
import { hybridWritingSuggestions, localChineseSuggestions } from '../dist/src/writing-nlp.js';
const engine = new WritingSemantic(process.env.WRITING_MODEL_PATH);
try {
  const until = Date.now() + 60000;
  while (engine.status() === 'warming' && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 100));
  if (engine.status() !== 'ready') throw new Error(`Semantic engine is ${engine.status()}`);
  const calibration = [
    ['每次回来都让我重新输账号密码','session-expiry'],
    ['刚进去没多久又被踢回登录页','session-expiry'],
    ['字还没打完就一直刷新搜索结果','input-debounce'],
    ['好几个 Excel 想用订单号关联起来','sheet-merge'],
    ['表里面一个手机号出现了三遍帮我整理下','sheet-dedupe'],
    ['每到周五都得手工做销售汇总太麻烦','office-report'],
    ['助手干到一半网络断了希望能续上','agent-resume'],
    ['说了好多遍的要求助手还是会忘','agent-context'],
    ['小人直接从墙中间过去了','game-collision'],
    ['片子里人嘴动完了声音才出来','video-sync'],
    ['孔太小轴插不进去','engineering-tolerance'],
    ['I have to sign back in whenever I return','session-expiry'],
    ['Join several spreadsheets using their order numbers','sheet-merge'],
    ['The assistant loses track of what I asked earlier','agent-context'],
    ['The voice arrives after the lips have moved','video-sync'],
    ['今天晚上吃什么',null],['帮我写一首关于春天的诗',null],['办公桌摇晃怎么处理',null],
    ['游戏剧情有点无聊',null],['这张表的颜色好看吗',null],['视频里那个人是谁',null],
    ['我家的门打不开',null],['登录已经修好了',null],['不要修改登录逻辑',null],
    ['The game story is boring',null],['What should I have for lunch',null],
    ['Please do not change the spreadsheet',null],['The drawing on my wall is beautiful',null],
  ];
  const cases = process.argv.includes('--calibration') ? calibration : JSON.parse(await readFile(new URL('./writing-holdout.json',import.meta.url),'utf8'));
  let baselineHits=0;
  let hits=0, wrong=0, abstained=0, rejected=0; const durations=[]; const results=[];
  for (const [draft, expected] of cases) {
    const start=performance.now(); let ranked=[];
    const result=await hybridWritingSuggestions(draft, async text => ranked=await engine.search(text));
    durations.push(performance.now()-start);
    if (expected && localChineseSuggestions(draft).suggestions[0]?.intent===expected) baselineHits++;
    const actual=result.suggestions[0]?.intent ?? null;
    if (expected && actual===expected) hits++; else if (actual) wrong++; else if (expected) abstained++; else rejected++;
    results.push({draft,expected,actual,top:ranked.slice(0,2).map(item=>({...item,score:+item.score.toFixed(3)}))});
  }
  durations.sort((a,b)=>a-b);
  console.log(JSON.stringify({model:'paraphrase-multilingual-MiniLM-L12-v2 q8',threshold:0.74,margin:0.08,baselineHits,cases:cases.length,hits,wrong,abstained,rejected,p95Ms:Math.round(durations[Math.floor(durations.length*.95)]),results},null,2));
  if (wrong) process.exitCode=1;
} finally { await engine.close(); }
