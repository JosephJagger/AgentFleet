// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { entryFromHtml, newBuildAvailable, runningEntry } from "./app-update";

const page = (entry: string) => `<!doctype html><script type="module" crossorigin src="${entry}"></script>`;
const reply = (body: string, ok = true) => vi.fn(async () => ({ ok, text: async () => body }) as Response);

describe("frontend build detection", () => {
  it("reads the hashed entry script", () => {
    expect(entryFromHtml(page("/assets/index-abc123.js"))).toBe("/assets/index-abc123.js");
    expect(entryFromHtml("<html></html>")).toBeUndefined();
  });
  it("reads the entry script running in this document", () => {
    document.head.innerHTML = '<script type="module" src="/assets/index-old.js"></script>';
    expect(runningEntry()).toBe("/assets/index-old.js");
    document.head.innerHTML = "";
    expect(runningEntry()).toBeUndefined();
  });
  it("reports an update only when both builds are known and differ", async () => {
    expect(await newBuildAvailable(reply(page("/assets/index-new.js")), "/assets/index-old.js")).toBe(true);
    expect(await newBuildAvailable(reply(page("/assets/index-old.js")), "/assets/index-old.js")).toBe(false);
    expect(await newBuildAvailable(reply("<html>offline shell</html>"), "/assets/index-old.js")).toBe(false);
    expect(await newBuildAvailable(reply(page("/assets/index-new.js"), false), "/assets/index-old.js")).toBe(false);
    expect(await newBuildAvailable(reply(page("/assets/index-new.js")), undefined)).toBe(false);
  });
  it("treats network failures as no update and bypasses the HTTP cache", async () => {
    expect(await newBuildAvailable(vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch, "/assets/index-old.js")).toBe(false);
    const fetcher = reply(page("/assets/index-old.js"));
    await newBuildAvailable(fetcher, "/assets/index-old.js");
    expect(fetcher).toHaveBeenCalledWith("/", expect.objectContaining({ cache: "no-store" }));
  });
});
