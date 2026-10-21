// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { WorktreeFields, worktreeBranchInput, type WorktreeDraft } from "./WorktreeFields";
import type { WorktreeOverview } from "../lib/types";
afterEach(cleanup);
const overview = { branches: ["main", "feat/existing"], setupScript: false, customBranchNames: true } as WorktreeOverview;
function Form() { const [value, setValue] = useState<WorktreeDraft>({ base: "main", branch: "", setup: false }); return <WorktreeFields overview={overview} value={value} onChange={setValue} />; }
it("separates the source branch from the new name and explains missing environment without a disabled control", () => {
  render(<Form />);
  expect(screen.getByRole("combobox", { name: /基础分支/ })).toBeTruthy();
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.getByText(/未配置，可直接创建/)).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "feat/Login-Fix" } });
  expect(screen.getByText("将创建新分支：feat/Login-Fix")).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "feat/existing" } });
  expect(screen.getByRole("textbox").getAttribute("aria-invalid")).toBe("true");
});
it("preserves exact custom names and translates supported legacy names without silently discarding input", () => {
  expect(worktreeBranchInput(overview, "feat/Login-Fix")).toEqual({ branch: "feat/Login-Fix" });
  expect(worktreeBranchInput(overview, "")).toEqual({});
  expect(worktreeBranchInput({ ...overview, customBranchNames: false }, "af/login-fix")).toEqual({ name: "login-fix" });
  expect(() => worktreeBranchInput({ ...overview, customBranchNames: false }, "feat/login-fix")).toThrow(/更新连接服务/);
});
