export interface BrowserStatus {
  state:'closed'|'opening'|'open'|'failed'; error?:string; code?:string;
}
export interface BrowserFrame {
  mode:'human'|'agent'; revision:number; url:string; title:string; image:string;
  width:number; height:number; busy:boolean;
  pending:null|{id:string;action:{action:string;url?:string;selector?:string;text?:string;x?:number;y?:number;delta?:number}};
}
export interface TaskDraft { title:string;prompt:string;sessionId:string;dependsOn:number[]; }
export interface CollaborationTask extends TaskDraft {
  state:string;detail?:string;commandId?:string;turnId?:string;result:string;
  provider?:string;host?:string;sessionTitle?:string;summary?:boolean;planning?:boolean;
}
export interface CollaborationPlan { id:string;title:string;state:string;sessionId:string;createdAt:string;tasks:CollaborationTask[]; }
export const taskState=(state:string)=>({pending:'等待派发',waiting:'等待执行条件',submitted:'等待主机接收',running:'正在执行',completed:'已完成',failed:'未完成',interrupted:'已停止',cancelled:'已取消',unknown:'结果待核实',blocked:'需要处理',unavailable:'会话不可访问',paused:'已暂停派发',needs_attention:'需要处理'}[state]??state);

export function readPlanDraft(text:string):TaskDraft[] {
  const fence=/```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const data=JSON.parse(fence?.[1]??text.trim());
  if(!Array.isArray(data.tasks)||!data.tasks.length||data.tasks.length>6)throw new Error('助手没有返回完整分工，请手动安排或在原会话补充要求');
  return data.tasks.map((task:TaskDraft,index:number)=>{
    if(typeof task.title!=='string'||!task.title.trim()||task.title.length>100||typeof task.prompt!=='string'||!task.prompt.trim()||task.prompt.length>12000||typeof task.sessionId!=='string'||!Array.isArray(task.dependsOn)||!task.dependsOn.every(n=>Number.isInteger(n)&&n>=0&&n<index))throw new Error('分工格式不完整，请在原会话补充要求');
    return {title:task.title,prompt:task.prompt,sessionId:task.sessionId,dependsOn:task.dependsOn};
  });
}
