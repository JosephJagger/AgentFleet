import {AgentError} from './errors.js';
import {isRecord} from './util.js';
import {inputQuestions,inputAnswers,type InputQuestion,type InputAnswers} from './user-input.js';
const OMIT_OPTION='[不填写此可选项]';
export interface GrokForm {questions:InputQuestion[];properties:Record<string,Record<string,unknown>>;optional:Set<string>}
/** Only bounded primitive, non-secret forms cross the durable relay. No URL visits or inferred answers. */
export function grokForm(params:Record<string,unknown>):GrokForm {
 const fail=():never=>{throw new AgentError('GROK_FORM_UNSUPPORTED','This MCP form requires unsupported or private fields; use the native client');};
 if(params.mode!=='form'||!isRecord(params.requestedSchema))return fail();
 const schema=params.requestedSchema;
 if(schema.type!=='object'||!isRecord(schema.properties)||(schema.required!==undefined&&!Array.isArray(schema.required))||Object.keys(schema.properties).length>8||Object.keys(schema).some(k=>!['type','properties','required','additionalProperties','$schema','title','description'].includes(k)))return fail();
 const required=(schema.required??[]) as unknown[];
 if(new Set(required).size!==required.length||required.some(k=>typeof k!=='string'||!Object.hasOwn(schema.properties as object,k)))return fail();
 const optional=new Set(Object.keys(schema.properties).filter(k=>!required.includes(k)));
 const properties:Record<string,Record<string,unknown>>={};
 const questions=Object.entries(schema.properties).map(([key,p])=>{
  if(!isRecord(p)||!['string','integer','number','boolean'].includes(String(p.type))||p.isSecret===true||p.writeOnly===true||p.format!==undefined||p.pattern!==undefined||p.oneOf!==undefined||p.anyOf!==undefined||p.default!==undefined)return fail();
  if(['__proto__','constructor','prototype'].includes(key)||Object.keys(p).some(k=>!['type','title','description','enum','minimum','maximum','minLength','maxLength'].includes(k)))return fail();
  if(p.enum!==undefined&&p.type!=='string'||['minimum','maximum'].some(k=>p[k]!==undefined&&(!['integer','number'].includes(String(p.type))||typeof p[k]!=='number'||!Number.isFinite(p[k])))||['minLength','maxLength'].some(k=>p[k]!==undefined&&(p.type!=='string'||!Number.isSafeInteger(p[k])||Number(p[k])<0)))return fail();
  if(p.enum!==undefined&&(!Array.isArray(p.enum)||p.enum.length>20||p.enum.some(v=>typeof v!=='string')||new Set(p.enum).size!==p.enum.length||p.enum.includes(OMIT_OPTION)))return fail();
  properties[key]=p;
  const values=p.type==='boolean'?['true','false']:Array.isArray(p.enum)?p.enum:[];
  const choices=optional.has(key)?[OMIT_OPTION,...values]:values;
  return {id:key,header:String(params.serverName??'MCP').slice(0,512),question:[params.message,p.title??key,p.description,optional.has(key)?'此字段可选；选择 '+OMIT_OPTION+' 将不提交该字段。':undefined].filter(v=>typeof v==='string').join('\n').slice(0,8000),isOther:!values.length,options:choices.map(label=>({label,description:''}))};
 });
 return {questions:inputQuestions(questions),properties,optional};
}
export function grokFormAnswer(form:GrokForm,value:InputAnswers):Record<string,unknown>{
 const answers=inputAnswers(value,form.questions),content:Record<string,unknown>={};
 for(const q of form.questions){
  const text=answers[q.id]!.answers[0]!,p=form.properties[q.id]!;
  if(form.optional.has(q.id)&&text===OMIT_OPTION)continue;
  let result:unknown=text;
  const fail=()=>{throw new AgentError('INPUT_ANSWERS_INVALID','Answer does not satisfy the native MCP field');};
  if(p.type==='boolean'){if(!['true','false'].includes(text))fail();result=text==='true';}
  else if(p.type==='number'||p.type==='integer'){
   if(!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text))fail();
   result=Number(text);if(!Number.isFinite(result)||p.type==='integer'&&!Number.isSafeInteger(result)||typeof p.minimum==='number'&&Number(result)<p.minimum||typeof p.maximum==='number'&&Number(result)>p.maximum)fail();
  }else if(Array.isArray(p.enum)&&!p.enum.includes(text)||typeof p.minLength==='number'&&Array.from(text).length<p.minLength||typeof p.maxLength==='number'&&Array.from(text).length>p.maxLength)fail();
  content[q.id]=result;
 }
 return content;
}
