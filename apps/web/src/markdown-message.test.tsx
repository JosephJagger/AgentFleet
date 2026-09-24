// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownMessage } from "./components/MarkdownMessage";

afterEach(cleanup);

describe("assistant Markdown", () => {
  it("renders headings, nested lists, GFM tables, tasks and links", () => {
    const { container } = render(<MarkdownMessage body={'## 检查结果\n\n**完成** `npm test`\n\n1. 主机\n   - 项目\n\n- [x] 已检查\n\n| 项目 | 状态 |\n| --- | --- |\n| UI | 完成 |\n\n> 引用说明\n\n[文档](https://example.com)'} />);
    expect(screen.getByRole("heading", {name:"检查结果", level:2})).toBeTruthy();
    expect(container.querySelector("ol ul li")?.textContent).toContain("项目");
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole("table").textContent).toContain("UI");
    expect(container.querySelector("blockquote")?.textContent).toContain("引用说明");
    expect(screen.getByRole("link",{name:"文档"}).getAttribute("rel")).toBe("noopener noreferrer");
  });
  it("blocks HTML and unsafe URLs and renders remote images as links", () => {
    const {container}=render(<MarkdownMessage body={'<script>alert(1)</script>\n\n[坏链接](javascript:alert%281%29)\n\n![预览](https://example.com/pixel.png)'} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("link",{name:"预览"}).getAttribute("href")).toBe("https://example.com/pixel.png");
  });
  it("supports incomplete streamed code and copies the latest exact text", async () => {
    const writeText=vi.fn().mockResolvedValue(undefined);Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText}});
    const view=render(<MarkdownMessage body={'```sh\nprintf "hello"'} />);
    fireEvent.click(screen.getByRole("button",{name:/复制代码|Copy code/}));
    await waitFor(()=>expect(writeText).toHaveBeenCalledWith('printf "hello"\n'));
    view.rerender(<MarkdownMessage body={'```sh\nprintf "hello"\nprintf "world"\n```'} />);
    fireEvent.click(screen.getByRole("button",{name:/复制代码|Copy code/}));
    await waitFor(()=>expect(writeText).toHaveBeenLastCalledWith('printf "hello"\nprintf "world"\n'));
  });
  it("copies the complete assistant reply including prose and code", async () => {
    const writeText=vi.fn().mockResolvedValue(undefined);Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText}});
    const body='处理完成。\n\n```sh\nnpm test\n```';
    const view=render(<MarkdownMessage body={body} />);
    fireEvent.click(view.getByRole("button",{name:"复制回复"}));
    await waitFor(()=>expect(writeText).toHaveBeenCalledWith(body));
    expect(view.getByRole("button",{name:"回复已复制"})).toBeTruthy();
  });
  it("turns host file links into scoped preview and download actions", () => {
    render(<MarkdownMessage sessionId="session/one" body={'PRD 已完成：[PRD.md](/root/douyinapp/PRD.md)\n\n[Windows 文件](C:/work/spec.docx)\n\n[相对文件](docs/plan.pdf)'} />);
    const preview = screen.getAllByRole("link", { name: "预览" });
    const download = screen.getAllByRole("link", { name: "下载" });
    expect(preview).toHaveLength(3);
    expect(download).toHaveLength(3);
    expect(preview[0]?.getAttribute("href")).toBe("/api/sessions/session%2Fone/files?path=%2Froot%2Fdouyinapp%2FPRD.md");
    expect(download[0]?.getAttribute("href")).toBe("/api/sessions/session%2Fone/files?path=%2Froot%2Fdouyinapp%2FPRD.md&download=1");
    expect(preview[1]?.getAttribute("href")).toContain("path=C%3A%2Fwork%2Fspec.docx");
    expect(preview[2]?.getAttribute("href")).toContain("path=docs%2Fplan.pdf");
  });
  it("renders macOS and Windows Codex file citations without changing their exact paths or code examples", () => {
    const mac = '/Users/gongqiankun/Documents/台钓/钓鱼核心玩法参数表.xlsx';
    const win = 'C:\\work\\参数表.xlsx';
    const marker = (path: string) => `:codex-file-citation{path="${path}" purpose="output"}`;
    const body = `Excel：${marker(mac)}。Windows：${marker(win)}\n\n\`${marker(mac)}\`\n\n\`\`\`text\n${marker(mac)}\n\`\`\``;
    const { container } = render(<MarkdownMessage sessionId="session-1" body={body} />);
    expect(screen.getAllByRole("link", { name: "预览" })).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: "下载" })).toHaveLength(2);
    expect(screen.getAllByText("钓鱼核心玩法参数表.xlsx")).toHaveLength(1);
    expect(screen.getAllByText("参数表.xlsx")).toHaveLength(1);
    expect(screen.getAllByRole("link", { name: "下载" })[0]?.getAttribute("href")).toBe(`/api/sessions/session-1/files?path=${encodeURIComponent(mac)}&download=1`);
    expect(screen.getAllByRole("link", { name: "下载" })[1]?.getAttribute("href")).toBe(`/api/sessions/session-1/files?path=${encodeURIComponent(win)}&download=1`);
    expect(container.querySelector("pre")?.textContent).toContain(marker(mac));
    expect(container.querySelector("p code")?.textContent).toBe(marker(mac));
  });
});
