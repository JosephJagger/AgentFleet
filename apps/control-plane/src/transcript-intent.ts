/** Conservative recognition of NEW native user speech, never tool/history/assistant text. */
export function transcriptIntent(text:string,continuation=false):'search'|'save'|'execute'|'none' {
 const s=text.trim();
 // Quoted or hypothetical instructions are data, not a new authorization.
 if(/(?:原话|原文|记录里|转写里|文章写|他说|她说|你说|比如说|假如|如果|quote|hypothetical)/i.test(s))return 'none';
 const plain=s.replace(/[“「『"][\s\S]*?[”」』"]/g,'');
 const lookup=/(?:查(?:一下|下|看|找|一查)?|看(?:一下|看|下)?|搜索|检索|回顾|读(?:一下|下)?|调出|显示|列出|打开|search|find|show|review|read|look up)/i;
 const transcript=/(?:转写|通话|电话|语音记录|我们.{0,8}(?:说过|聊过|说了|聊了)|transcript|calls?)/i;
 const noSearch=/(?:不要|别|禁止|不许|不用|不想|不需要|不必|无需).{0,4}(?:查|看|搜索|检索|读|显示)|(?:do not|don't).{0,5}(?:search|read|show)/i;
 const retrospective=/(?:最近|过去|昨天|前天|上周|上次|之前).*(?:通话|转写).*(?:说|聊|内容|记录|什么)|(?:我们|我|你).*(?:说过|聊过|说了|聊了).*(?:什么|哪些)|^(?:请)?给我.{0,25}(?:通话|转写)|what did (?:we|I|you) say/i.test(plain);
 const followup=continuation&&/^(?:(?:最近|过去)?[一二两三四五六七八九十百\d]+(?:次(?:通话)?|天|周|个星期)(?:的)?(?:转写|记录)?[。？?]?|关键词(?:是|用|为|[:：])?.{1,200})$/.test(plain);
 if(!noSearch.test(plain)&&((lookup.test(plain)&&transcript.test(plain))||retrospective||followup||continuation&&/^(?:请)?(?:继续(?:查看|读|看|查询)|下一页|再看一页|next page|continue reading)[。！!]?$/i.test(plain)))return 'search';
 // Questions about a failed save do not authorize saving or executing anything.
 if(/(?:为什么|是否|有没有|失败|怎么回事|what happened|why)/i.test(plain))return 'none';
 const clauses=plain.split(/[，,；;。\n]/).map(x=>x.trim()).filter(Boolean);
 const positive=clauses.filter(x=>!/(?:不要|别|禁止|不许|暂不|还不|不用|不想|不需要|不必|无需|do not|don't)/i.test(x));
 const save=positive.some(x=>/(?:请|帮我|替我|我要|我想|现在|先|把|将|这.{0,8}(?:需求|任务)).{0,35}(?:保存|记下来|记下|记住|加入待办|存为待办)|^(?:保存|记下来|记下|加入待办)|^(?:please )?(?:save|remember|record)\b/i.test(x));
 const execute=positive.some(x=>/^(?:(?:请|帮我|请帮我|麻烦你|现在|我现在|我要你|我要求|用户明确要求)[，,\s]*)*(?:执行|开始(?:执行|开发)?|开发|修改|发布|取消|删除|停止|继续执行|接管|追加|安排)/.test(x)||/(?:请|帮我|现在把|现在将).{0,35}(?:执行|开发|发布|接管|追加)(?:一下|吧|这个|此|这项|这个任务|这条任务|这项任务|这项需求|该任务|该需求|$)/.test(x)||/^(?:please\s+)?(?:execute|start|develop|change|publish|cancel|delete|stop|dispatch|take over)\b/i.test(x));
 // Saving a new requirement only enables todo.save; it never permits dispatch.
 if(save)return 'save';
 if(execute)return 'execute';
 return 'none';
}
