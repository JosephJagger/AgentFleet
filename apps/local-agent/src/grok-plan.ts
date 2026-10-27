import {AgentError} from './errors.js';
import {inputAnswers,inputQuestions,type InputAnswers,type InputQuestion} from './user-input.js';

const approve='批准计划并开始执行';
const keep='暂不执行，继续计划';
const abandon='放弃本次计划';
/** Keep consent distinct from tool permission, including in auto/always mode. */
export function grokPlan(params:Record<string,unknown>):{content:string;questions:InputQuestion[]} {
  if(typeof params.toolCallId!=='string'||!params.toolCallId||typeof params.planContent!=='string'||!params.planContent.trim()||params.planContent.length>64000)
    throw new AgentError('GROK_PLAN_REVIEW_UNAVAILABLE','A complete non-empty plan of at most 64000 characters is required for approval');
  return {content:params.planContent,questions:inputQuestions([{id:'grok_plan_review',header:'计划审批',question:'请阅读完整计划后选择；填写其他文字会作为修改意见返回，并保持计划模式。',isOther:true,options:[
    {label:approve,description:'允许退出计划阶段；后续工具仍受原生权限和规则约束。'},
    {label:keep,description:'保留计划模式，不开始执行。'},
    {label:abandon,description:'结束本次计划，不批准实施。'},
  ]}])};
}
export function grokPlanAnswer(questions:InputQuestion[],answers:InputAnswers){
  const answer=inputAnswers(answers,questions).grok_plan_review!.answers[0]!;
  return answer===approve?{outcome:'approved'}:answer===abandon?{outcome:'abandoned'}:answer===keep?{outcome:'cancelled'}:{outcome:'cancelled',feedback:answer};
}
