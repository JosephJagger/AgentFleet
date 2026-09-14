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
  it("paginates settings themes and starts on the saved theme page", () => {
    setTheme("jiangshan");
    render(<ThemeSettings paginated />);
    expect(screen.getAllByRole("radio")).toHaveLength(5);
    expect(screen.getByRole("radio", { name: /千里江山/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "上一页" }));
    expect(screen.getAllByRole("radio")).toHaveLength(6);
    fireEvent.click(screen.getByRole("radio", { name: /哈利波特/ }));
    expect(localStorage.getItem("agentfleet.theme")).toBe("wizard");
    fireEvent.click(screen.getByRole("button", { name: "上一页" }));
    expect(screen.getByRole("radio", { name: /天空之城/ })).toBeTruthy();
  });
  it.each([
    ["starwars", "星球大战", "#0c1420"],
    ["spirited", "千与千寻", "#f4eddf"],
    ["rivendell", "指环王", "#edf0e6"],
    ["mario", "超级马里奥", "#edf6fc"],
    ["cyber", "赛博朋克", "#14171c"],
    ["wukong", "大闹天宫", "#241b20"],
    ["nezha", "哪吒闹海", "#fbefe7"],
    ["whitesnake", "白蛇传说", "#edf4f0"],
    ["qingming", "清明上河", "#f0e8d6"],
    ["jiangshan", "千里江山", "#102d32"],
    ["daylight", "天空之城", "#edf5fa"],
    ["midnight", "黑暗骑士", "#14171c"],
    ["forest", "龙猫森林", "#14251e"],
    ["eyecare", "彼得兔园", "#f4ecd6"],
  ])("persists %s and displays its scene", (value, label, color) => {
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.append(meta);
    setTheme("matrix");
    const view = render(<ThemeSettings />);
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(label) }));
    expect(localStorage.getItem("agentfleet.theme")).toBe(value);
    expect(meta.content).toBe(color);
    expect(view.container.querySelector(".theme-scene img")?.getAttribute("src")).toBe(`/themes/${value === "eyecare" ? "rabbit" : value}.svg`);
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
    const eyecare = screen.getByRole("radio", { name: /彼得兔园/ });
    expect(screen.getAllByRole("radio")).toHaveLength(17);
    fireEvent.click(eyecare);
    expect(eyecare.getAttribute("aria-checked")).toBe("true");
    expect(document.documentElement.dataset.theme).toBe("eyecare");
    fireEvent.click(screen.getByRole("radio", { name: /骇客帝国/ }));
    expect(document.documentElement.dataset.theme).toBe("matrix");
    expect(localStorage.getItem("agentfleet.theme")).toBe("matrix");
  });
});
