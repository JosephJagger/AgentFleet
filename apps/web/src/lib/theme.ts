import { useSyncExternalStore } from "react";

export type Theme = "buzhoushan" | "official" | "cyber" | "daylight" | "midnight" | "forest" | "eyecare" | "matrix" | "frozen" | "wizard" | "starwars" | "spirited" | "rivendell" | "mario" | "wukong" | "nezha" | "whitesnake" | "qingming" | "jiangshan";

const STORAGE_KEY = "agentfleet.theme";
const themes: Theme[] = ["official", "cyber", "daylight", "midnight", "forest", "eyecare", "matrix", "frozen", "wizard", "starwars", "spirited", "rivendell", "mario", "wukong", "nezha", "whitesnake", "qingming", "jiangshan", "buzhoushan"];
const listeners = new Set<() => void>();

function isTheme(value: string | null): value is Theme {
  return themes.includes(value as Theme);
}

function initialTheme(): Theme {
  if (typeof location !== "undefined" && new URLSearchParams(location.search).get("broadcast") === "1") return "buzhoushan";
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isTheme(saved)) return saved;
  } catch { /* The default theme remains available when storage is blocked. */ }
  return "eyecare";
}

let current = initialTheme();

function updateDocument() {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = current;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", {
    buzhoushan: "#1e1e1e",
    official: "#ffffff",
    cyber: "#14171c",
    daylight: "#edf5fa",
    midnight: "#14171c",
    forest: "#14251e",
    eyecare: "#f4ecd6",
    matrix: "#050907",
    frozen: "#eaf4fb",
    wizard: "#171522",
    starwars: "#0c1420",
    spirited: "#f4eddf",
    rivendell: "#edf0e6",
    mario: "#edf6fc",
    wukong: "#241b20",
    nezha: "#fbefe7",
    whitesnake: "#edf4f0",
    qingming: "#f0e8d6",
    jiangshan: "#102d32",
  }[current]);
}

export const theme = () => current;

let themeFrame: number | undefined;
export function setTheme(value: Theme) {
  if (!isTheme(value) || value === current) return;
  // Apply the palette as one update rather than animating every surface independently.
  if (typeof requestAnimationFrame === "function") {
    if (themeFrame !== undefined) cancelAnimationFrame(themeFrame);
    document.documentElement.classList.add("theme-switching");
    themeFrame = requestAnimationFrame(() => {
      themeFrame = requestAnimationFrame(() => {
        document.documentElement.classList.remove("theme-switching");
        themeFrame = undefined;
      });
    });
  }
  current = value;
  try { localStorage.setItem(STORAGE_KEY, value); } catch { /* Switching still works for this page. */ }
  updateDocument();
  listeners.forEach(listener => listener());
}

export function useTheme() {
  return useSyncExternalStore(listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, theme, () => "eyecare" as Theme);
}

updateDocument();
