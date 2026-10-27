import {AgentError} from './errors.js';
import {isRecord} from './util.js';
import {inputAnswers,inputQuestions,type InputAnswers,type InputQuestion} from './user-input.js';

/** The native answer keys are question text, not generated panel IDs. */
export function grokQuestions(params:Record<string,unknown>):InputQuestion[] {
  const fail=():never=>{throw new AgentError('GROK_QUESTION_UNSUPPORTED','Unsupported native interview question');};
  if(!Array.isArray(params.questions))return fail();
  const seen=new Set<string>();
  return inputQuestions(params.questions.map((q,index)=>{
    if(!isRecord(q)||q.isSecret===true||!Array.isArray(q.options)||typeof q.question!=='string'||seen.has(q.question)||['__proto__','constructor','prototype'].includes(q.question))return fail();
    const flags=[q.multiSelect,q.multi_select].filter(flag=>flag!==undefined);
    if(flags.some(flag=>flag!==true&&flag!==false)||(q.multiSelect===true&&q.multi_select===false)||(q.multiSelect===false&&q.multi_select===true))return fail();
    seen.add(q.question);
    const options=(q.options as unknown[]).map(o=>{
      if(!isRecord(o)||typeof o.label!=='string'||o.preview!=null)return fail();
      return {label:o.label,description:o.description};
    });
    if(new Set(options.map(o=>o.label)).size!==options.length)return fail();
    const multi=q.multiSelect===true||q.multi_select===true;
    return {id:`grok_question_${index}`,header:'Grok',question:q.question,isOther:true,...(multi?{multi:true}:{}),options};
  }));
}
export function grokQuestionAnswer(questions:InputQuestion[],answers:InputAnswers){
  const validated=inputAnswers(answers,questions);
  const values:Record<string,string[]>={};
  const annotations:Record<string,{notes:string}>={};
  for(const q of questions){
    const picked=validated[q.id]!.answers;
    if(q.multi!==true){
      const answer=picked[0]!;
      if(q.options.some(o=>o.label===answer))values[q.question]=[answer];
      else {values[q.question]=['Other'];annotations[q.question]={notes:answer};}
      continue;
    }
    const labels=picked.filter(answer=>q.options.some(o=>o.label===answer));
    const extras=picked.filter(answer=>!q.options.some(o=>o.label===answer));
    if(extras.length>1)throw new AgentError('INPUT_ANSWERS_INVALID','A multi-select question accepts at most one free-text answer');
    values[q.question]=extras.length?[...labels,...(labels.includes('Other')?[]:['Other'])]:labels;
    if(extras.length)annotations[q.question]={notes:extras[0]!};
  }
  return {outcome:'accepted',answers:values,...(Object.keys(annotations).length?{annotations}:{})};
}
