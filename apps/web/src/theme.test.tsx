// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ThemeSettings, ThemeSwitcher } from "./components/ThemeSwitcher";
import { setTheme, type Theme } from "./lib/theme";

afterEach(() => {
  cleanup();
  setTheme("cyber");
  localStorage.clear();
});

describe("theme switching", () => {
  it.each([
    ["starwars", "星球大战", "#0c1420"],
    ["spirited", "千与千寻", "#f4eddf"],
    ["rivendell", "指环王", "#edf0e6"],
    ["mario", "超级马里奥", "#edf6fc"],
    ["cyber", "赛博朋克", "#14171c"],
    ["daylight", "天空之城", "#edf5fa"],
    ["midnight", "黑暗骑士", "#14171c"],
    ["forest", "龙猫森林", "#14251e"],
    ["eyecare", "小熊维尼", "#f4ecd6"],
  ])("persists %s and displays its scene", (value, label, color) => {
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.append(meta);
    setTheme("matrix");
    const view = render(<ThemeSettings />);
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(label) }));
    expect(localStorage.getItem("agentfleet.theme")).toBe(value);
    expect(meta.content).toBe(color);
    expect(view.container.querySelector(".theme-scene img")?.getAttribute("src")).toBe(`/themes/${value}.svg`);
    expect(document.documentElement.dataset.theme).toBe(value as Theme);
    meta.remove();
  });
  it("persists a selected theme and updates the browser chrome", () => {
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.append(meta);
    setTheme("cyber");
    render(<ThemeSwitcher />);
    fireEvent.change(screen.getByRole("combobox", { name: "界面主题" }), { target: { value: "eyecare" } });
    expect(document.documentElement.dataset.theme).toBe("eyecare");
    expect(localStorage.getItem("agentfleet.theme")).toBe("eyecare");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#f4ecd6");
    meta.remove();
  });

  it("offers a complete theme picker for settings", () => {
    setTheme("cyber");
    render(<ThemeSettings />);
    const eyecare = screen.getByRole("radio", { name: /小熊维尼/ });
    expect(screen.getAllByRole("radio")).toHaveLength(12);
    fireEvent.click(eyecare);
    expect(eyecare.getAttribute("aria-checked")).toBe("true");
    expect(document.documentElement.dataset.theme).toBe("eyecare");
    fireEvent.click(screen.getByRole("radio", { name: /骇客帝国/ }));
    expect(document.documentElement.dataset.theme).toBe("matrix");
    expect(localStorage.getItem("agentfleet.theme")).toBe("matrix");
  });
});
