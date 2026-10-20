// @vitest-environment jsdom
import {useRef,useState} from "react";
import {cleanup,fireEvent,render,screen} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import {CodexCommandSuggestions,GrokCommandSuggestions} from "./components/SlashCommandSuggestions";

afterEach(cleanup);
const commands=[
  {name:"session-info",description:"Show session details"},
  {name:"workflow",description:"Launch a saved workflow",hint:"<name> [--agent-budget N] [--effort LEVEL] [args] | runs | pause|resume|stop|save [name]"},
];
function Composer(){
  const input=useRef<HTMLTextAreaElement>(null),[prompt,setPrompt]=useState("");
  return <div className="composer"><div className="composer-input">
    <GrokCommandSuggestions anchor={input} prompt={prompt} commands={commands} onSelect={setPrompt}/>
    <textarea ref={input} aria-label="消息" value={prompt} onChange={e=>setPrompt(e.target.value)}/>
    <button>发送</button>
  </div></div>;
}
it("renders native commands outside the input layout and only fills the chosen command",()=>{
  const view=render(<Composer/>);
  fireEvent.change(screen.getByLabelText("消息"),{target:{value:"/"}});
  const menu=screen.getByRole("group",{name:"Grok 原生命令"});
  expect(menu.closest(".completion-floating")?.parentElement).toBe(document.body);
  expect(view.container.querySelector(".composer-input")?.contains(menu)).toBe(false);
  fireEvent.click(screen.getByRole("button",{name:/\/workflow/}));
  expect((screen.getByLabelText("消息") as HTMLTextAreaElement).value).toBe("/workflow ");
  expect(screen.queryByRole("group",{name:"Grok 原生命令"})).toBeNull();
  expect(document.activeElement).toBe(screen.getByLabelText("消息"));
});
it("filters native commands, hides unmatched input and supports dismissal without changing the draft",()=>{
  render(<Composer/>);const input=screen.getByLabelText("消息");
  fireEvent.change(input,{target:{value:"/work"}});
  expect(screen.getByText("/workflow")).toBeTruthy();expect(screen.queryByText("/session-info")).toBeNull();
  fireEvent.keyDown(input,{key:"Escape"});
  expect(screen.queryByRole("group")).toBeNull();expect((input as HTMLTextAreaElement).value).toBe("/work");
  fireEvent.change(input,{target:{value:"/"}});
  fireEvent.click(screen.getByRole("button",{name:"收起补全建议"}));
  expect(screen.queryByRole("group")).toBeNull();expect((input as HTMLTextAreaElement).value).toBe("/");
  fireEvent.change(input,{target:{value:"/missing"}});expect(screen.queryByRole("group")).toBeNull();
});
it("scrolling inside the list keeps it open; an outside pointer dismisses it",()=>{
  render(<Composer/>);fireEvent.change(screen.getByLabelText("消息"),{target:{value:"/"}});
  fireEvent.wheel(screen.getByText("/workflow"),{deltaY:100});
  expect(screen.getByRole("group")).toBeTruthy();
  fireEvent.pointerDown(screen.getByRole("button",{name:"发送"}));expect(screen.queryByRole("group")).toBeNull();
});

it("Codex uses the same floating layout and preserves selection without sending text",()=>{
  const onSelect=vi.fn();
  function CodexComposer(){const input=useRef<HTMLTextAreaElement>(null),[prompt,setPrompt]=useState("");return <div className="composer"><CodexCommandSuggestions anchor={input} prompt={prompt} onSelect={onSelect}/><div className="composer-input"><textarea ref={input} aria-label="消息" value={prompt} onChange={e=>setPrompt(e.target.value)}/><button>发送</button></div></div>;}
  const view=render(<CodexComposer/>);const input=screen.getByLabelText("消息");
  fireEvent.change(input,{target:{value:"/"}});
  const menu=screen.getByRole("group",{name:"Codex 命令"});
  expect(menu.closest(".completion-floating")?.parentElement).toBe(document.body);
  expect(view.container.querySelector(".composer")?.contains(menu)).toBe(false);
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.change(input,{target:{value:"/delet"}});
  expect(screen.queryByText("/model")).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:/\/delete/}));
  expect(onSelect).toHaveBeenCalledTimes(1);expect(onSelect).toHaveBeenCalledWith("delete");
  expect((input as HTMLTextAreaElement).value).toBe("/delet");
  expect(screen.queryByRole("group",{name:"Codex 命令"})).toBeNull();
  fireEvent.change(input,{target:{value:"/rename new name"}});
  expect(screen.getByText("/rename")).toBeTruthy();
  fireEvent.keyDown(input,{key:"Escape"});expect(screen.queryByRole("group")).toBeNull();
});
