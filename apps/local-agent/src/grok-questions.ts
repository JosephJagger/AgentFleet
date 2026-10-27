import {AgentError} from './errors.js';
import {isRecord} from './util.js';
import {inputAnswers,inputQuestions,type InputAnswers,type InputQuestion} from './user-input.js';

/** The native answer keys are question text, not generated panel IDs. */
export function grokQuestions(params:Record<string,unknown>):InputQuestion[] {
  const fail=():never=>{throw new AgentError('GROK_QUESTION_UNSUPPORTED','Unsupported native interview question');};
  if(!Array.isArray(params.questions)||params.questions.some(q=>!isRecord(q)||q.multiSelect===true||q.multi_select===true||q.isSecret===true||!Array.isArray(q.options)))return fail();
  const seen=new Set<string>();
  return inputQuestions(params.questions.map((q,index)=>{
    if(!isRecord(q)||typeof q.question!=='string'||seen.has(q.question)||['__proto__','constructor','prototype'].includes(q.question))return fail();
    seen.add(q.question);
    const options=(q.options as unknown[]).map(o=>{
      if(!isRecord(o)||typeof o.label!=='string'||o.preview!=null)return fail();
      return {label:o.label,description:o.description};
    });
    if(new Set(options.map(o=>o.label)).size!==options.length)return fail();
    return {id:`grok_question_${index}`,header:'Grok',question:q.question,isOther:true,options};
  }));
}
export function grokQuestionAnswer(questions:InputQuestion[],answers:InputAnswers){
  const validated=inputAnswers(answers,questions);
  const values:Record<string,string[]>={};
  const annotations:Record<string,{notes:string}>={};
  for(const q of questions){
    const answer=validated[q.id]!.answers[0]!;
    if(q.options.some(o=>o.label===answer))values[q.question]=[answer];
    else {values[q.question]=['Other'];annotations[q.question]={notes:answer};}
  }
  return {outcome:'accepted',answers:values,...(Object.keys(annotations).length?{annotations}:{})};
}
