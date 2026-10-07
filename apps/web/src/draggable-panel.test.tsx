// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useDraggablePanel } from "./lib/use-draggable-panel";
afterEach(cleanup);
it("drags independently, respects CSS zoom and keeps the whole panel inside the viewport", () => {
 const panel=document.createElement("div");
 Object.defineProperty(panel,"offsetWidth",{value:400});
 panel.getBoundingClientRect=()=>{const [x,y]=panel.style.translate.split(" ").map(parseFloat);return {left:100+(x||0)*.8,top:100+(y||0)*.8,width:320,height:240} as DOMRect;};
 const header=document.createElement("header");header.setPointerCapture=vi.fn();header.hasPointerCapture=()=>false;
 const {result}=renderHook(()=>useDraggablePanel({current:panel},true));
 const event=(x:number,y:number,target:HTMLElement=header)=>({button:0,pointerId:1,clientX:x,clientY:y,target,currentTarget:header,preventDefault:vi.fn()}) as never;
 act(()=>result.current.handle.onPointerDown(event(100,100)));
 act(()=>result.current.handle.onPointerMove(event(180,140)));
 expect(panel.style.translate).toBe("100px 50px");
 act(()=>result.current.handle.onPointerMove(event(5000,5000)));
 const rect=panel.getBoundingClientRect();
 expect(rect.left+rect.width).toBeLessThanOrEqual(innerWidth-8);
 expect(rect.top+rect.height).toBeLessThanOrEqual(innerHeight-8);
 act(()=>result.current.handle.onPointerUp(event(5000,5000)));
 const saved=panel.style.translate;
 act(()=>result.current.handle.onPointerMove(event(0,0)));
 expect(panel.style.translate).toBe(saved);
 const button=document.createElement("button");
 act(()=>result.current.handle.onPointerDown(event(0,0,button)));
 act(()=>result.current.handle.onPointerMove(event(80,80)));
 expect(panel.style.translate).toBe(saved);
});
