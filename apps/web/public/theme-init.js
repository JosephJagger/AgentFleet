// Match the React default before the first paint, without overwriting saved choices.
const themeColors = { cyber: "#14171c", daylight: "#f5f5f7", midnight: "#161618", forest: "#0d1813", eyecare: "#e8e5cf", matrix: "#050907", frozen: "#eaf4fb", wizard: "#171522", starwars: "#0c1420", spirited: "#f4eddf", rivendell: "#edf0e6", mario: "#edf6fc" };
let initialTheme = "daylight";
try {
  const saved = localStorage.getItem("agentfleet.theme");
  if (Object.hasOwn(themeColors, saved)) initialTheme = saved;
} catch { /* The default also works when browser storage is unavailable. */ }
document.documentElement.dataset.theme = initialTheme;
document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeColors[initialTheme]);
