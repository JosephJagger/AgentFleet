// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { parseVoiceRequest, UserMessage } from "./components/UserMessage";
afterEach(cleanup);
const envelope = (input: string, transcript: string) => `<realtime_delegation>\n<input>${input}</input>\n<transcript_delta>${transcript}</transcript_delta>\n</realtime_delegation>`;
it("collapses native voice requests without losing the full request or transcript", () => {
  const input = "查看项目状态".repeat(100);
  const transcript = "user: 查看状态\nassistant: 正在检查".repeat(100);
  const { container } = render(<UserMessage body={envelope(input, transcript)} />);
  const details = container.querySelector("details")!;
  expect(details.open).toBe(false);
  expect(details.querySelector("summary")?.textContent).toContain(input);
  expect(details.querySelector(".voice-request__content")?.textContent).toContain(transcript);
  expect(details.textContent).not.toContain("<realtime_delegation>");
  details.open = true;
  expect(details.querySelector(".voice-request__content p")?.textContent).toBe(input);
});
it("renders embedded markup as text", () => {
  const { container } = render(<UserMessage body={envelope('<img src=x onerror="alert(1)">', '<script>alert(1)</script>')} />);
  expect(container.querySelector("img,script")).toBeNull();
  expect(container.textContent).toContain('<script>alert(1)</script>');
});
it("leaves ordinary, quoted and incomplete messages unchanged", () => {
  for (const body of ["普通输入", "解释这个：" + envelope("hello", "world"), "<realtime_delegation><input>未完成"]) {
    expect(parseVoiceRequest(body)).toBeNull();
    const { container, unmount } = render(<UserMessage body={body} />);
    expect(container.querySelector("details")).toBeNull();
    expect(container.textContent).toBe(body);
    unmount();
  }
});
it("supports a complete request without transcript", () => {
  expect(parseVoiceRequest("<realtime_delegation><input>查看状态</input></realtime_delegation>"))
    .toEqual({ input: "查看状态", transcript: "" });
});
