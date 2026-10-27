// @vitest-environment jsdom
import {cleanup, fireEvent, render, screen} from "@testing-library/react";
import {afterEach, expect, it, vi} from "vitest";
import {ApprovalCard} from "./App";
import {mapApproval} from "./lib/api";
import {setLocale} from "./i18n";
import type {FleetSession} from "./lib/types";

afterEach(()=>{cleanup();setLocale("zh-CN");});
const session={id:"session",provider:"claude",machineName:"Host",projectAlias:"Project"} as FleetSession;
function approval(toolName="ExitPlanMode",provider="claude") {
 return mapApproval({approvalId:"approval",logicalSessionId:"session",state:"pending",context:{action:{
  toolName,input:{plan:"# Proposed plan\n\nImplement only after approval."},reason:"ExitPlanMode: native payload",
 }},actionHash:"hash",approvalVersion:1},[{...session,provider} as FleetSession],[],[]);
}

it("recognizes legacy host plan-exit requests and separates execution consent from ordinary approval",()=>{
 setLocale("zh-CN");
 const request=approval(),decide=vi.fn();
 expect(request.planExit?.plan).toContain("Proposed plan");
 render(<ApprovalCard approval={request} provider="claude" busy={false} onDecide={decide}/>);
 expect(screen.getByText("是否结束计划并开始执行？")).toBeTruthy();
 expect(screen.queryByRole("button",{name:"仅本次允许"})).toBeNull();
 fireEvent.click(screen.getByText("查看待批准的计划"));
 expect(decide).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole("button",{name:"暂不执行，继续计划"}));
 expect(decide).toHaveBeenLastCalledWith("decline");
 fireEvent.click(screen.getByRole("button",{name:"批准计划并开始执行"}));
 expect(decide).toHaveBeenLastCalledWith("accept");
});

it("preserves ordinary approval semantics and does not recognize a plan from prose or another provider",()=>{
 setLocale("zh-CN");
 expect(approval("Bash").planExit).toBeUndefined();
 expect(approval("ExitPlanMode","grok").planExit).toBeUndefined();
 const decide=vi.fn();
 render(<ApprovalCard approval={approval("Bash")} provider="claude" busy={false} onDecide={decide}/>);
 fireEvent.click(screen.getByRole("button",{name:"仅本次允许"}));
 expect(decide).toHaveBeenCalledWith("accept");
});

it("localizes plan consent and disables both decisions while delivery is in progress",()=>{
 setLocale("en");
 const decide=vi.fn();
 render(<ApprovalCard approval={approval()} provider="claude" busy onDecide={decide}/>);
 fireEvent.click(screen.getByRole("button",{name:"Approve plan and start execution"}));
 fireEvent.click(screen.getByRole("button",{name:"Keep planning"}));
 expect(decide).not.toHaveBeenCalled();
});

it("keeps multi-select only when the native question marks it",()=>{
 const raw=(multi:boolean)=>({approvalId:"approval",logicalSessionId:"session",context:{action:{kind:"user_input",questions:[{id:"q",header:"H",question:"Q",multi,options:[{label:"A",description:""}]}]}}});
 const grok=[{...session,provider:"grok"} as FleetSession];
 expect(mapApproval(raw(true),grok,[],[]).questions?.[0]?.multi).toBe(true);
 expect(mapApproval(raw(false),grok,[],[]).questions?.[0]?.multi).toBeUndefined();
});
it("maps Grok native plan reviews only from the explicit structured request",()=>{
 const raw={approvalId:"approval",logicalSessionId:"session",context:{action:{kind:"user_input",toolName:"exit_plan_mode",planContent:"# Grok plan"}}};
 expect(mapApproval(raw,[{...session,provider:"grok"} as FleetSession],[],[]).grokPlan).toBe("# Grok plan");
 expect(mapApproval(raw,[session],[],[]).grokPlan).toBeUndefined();
});
