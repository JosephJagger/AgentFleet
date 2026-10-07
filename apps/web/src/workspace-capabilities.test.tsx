// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectFilesPanel } from "./components/ProjectFilesPanel";
import { SessionWorkspace } from "./components/SessionWorkspace";
import { api } from "./lib/api";
import type { CommandReceipt, FleetSession } from "./lib/types";
vi.mock("./lib/api", () => ({ api: { command: vi.fn() } }));
const session = { id: "s", nativeThreadId: "t", executionSegmentId: "e", threadControlVersion: 1, projectLeaseVersion: 1, actions: { manage: { allowed: true } } } as FleetSession;
afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.command).mockResolvedValue({ command: { id: "read" } as CommandReceipt }); });
it("refreshing an identical file receipt preserves unsaved edits", async () => {
 const props = { session, commands: [] as CommandReceipt[], onChanged: vi.fn() };
 const view = render(<ProjectFilesPanel {...props}/>);
 fireEvent.change(screen.getByLabelText("项目内文件路径"), { target: { value: "test.txt" } });
 fireEvent.click(screen.getByRole("button", { name: "读取文件" }));
 await waitFor(() => expect(api.command).toHaveBeenCalledOnce());
 const receipt = { id: "read", state: "succeeded", codexResult: { operation: "files.read", status: "available", rows: [{ name: "revision", detail: "a".repeat(64), status: "" }, { name: "content:0", detail: "old", status: "" }] } } as CommandReceipt;
 view.rerender(<ProjectFilesPanel {...props} commands={[receipt]}/>);
 await waitFor(() => expect((screen.getByLabelText("文件内容") as HTMLTextAreaElement).value).toBe("old"));
 fireEvent.change(screen.getByLabelText("文件内容"), { target: { value: "draft" } });
 view.rerender(<ProjectFilesPanel {...props} commands={[structuredClone(receipt)]}/>);
 expect((screen.getByLabelText("文件内容") as HTMLTextAreaElement).value).toBe("draft");
});
it("workspace separates files, commands and integrations from session configuration", () => {
 render(<SessionWorkspace session={session} commands={[]} onChanged={vi.fn()}/>);
 fireEvent.click(screen.getByText("项目工作区", { selector: "summary" }));
 expect(screen.getByRole("button", { name: "文件" })).toBeTruthy();
 fireEvent.click(screen.getByRole("button", { name: "集成" }));
 fireEvent.click(screen.getByText("项目集成", { selector: "summary > span" }));
 expect(screen.queryByRole("option", { name: "退出原生账号" })).toBeNull();
 expect(screen.getByRole("option", { name: "查看 MCP 工具与资源" })).toBeTruthy();
});
