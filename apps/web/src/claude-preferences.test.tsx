// @vitest-environment jsdom
import {act,cleanup,renderHook} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import {api} from "./lib/api";
import {useClaudePreferences,type ClaudePreferences} from "./lib/claude-preferences";
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.useRealTimers();});

it("updates saved plan state from server receipts without a page reload",async()=>{
 vi.useFakeTimers();
 const read=vi.spyOn(api,"claudePreferences").mockResolvedValueOnce({settings:{model:"host",mode:"plan",permissionMode:"auto"},revision:1})
  .mockResolvedValue({settings:{model:"host",mode:"default",permissionMode:"auto"},revision:2});
 const hook=renderHook(({seq})=>useClaudePreferences("session",seq),{initialProps:{seq:1}});
 await act(async()=>{});
 expect(hook.result.current.settings.mode).toBe("plan");
 hook.rerender({seq:2});
 await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
 expect(hook.result.current.settings.mode).toBe("default");
 expect(hook.result.current.settings.permissionMode).toBe("auto");
 expect(read).toHaveBeenCalledTimes(2);
});

it("an older refresh cannot undo a newer explicit plan selection",async()=>{
 vi.useFakeTimers();
 let finish!:(value:ClaudePreferences)=>void;
 vi.spyOn(api,"claudePreferences").mockResolvedValueOnce({settings:{model:"host",mode:"default"},revision:2})
  .mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 vi.spyOn(api,"saveClaudePreferences").mockResolvedValue({settings:{model:"host",mode:"plan"},revision:3});
 const hook=renderHook(({seq})=>useClaudePreferences("session",seq),{initialProps:{seq:1}});
 await act(async()=>{});
 hook.rerender({seq:2});
 await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
 await act(async()=>{await hook.result.current.save({model:"host",mode:"plan"});});
 await act(async()=>{finish({settings:{model:"host",mode:"default"},revision:2});});
 expect(hook.result.current.settings.mode).toBe("plan");
});
