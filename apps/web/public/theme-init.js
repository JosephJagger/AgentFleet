// Match the React default before the first paint, without overwriting saved choices.
const themeColors = { cyber: "#14171c", daylight: "#edf5fa", midnight: "#14171c", forest: "#14251e", eyecare: "#f4ecd6", matrix: "#050907", frozen: "#eaf4fb", wizard: "#171522", starwars: "#0c1420", spirited: "#f4eddf", rivendell: "#edf0e6", mario: "#edf6fc", wukong: "#241b20", nezha: "#fbefe7", whitesnake: "#edf4f0", qingming: "#f0e8d6", jiangshan: "#102d32" };
let initialTheme = "daylight";
try {
  const saved = localStorage.getItem("agentfleet.theme");
  if (Object.hasOwn(themeColors, saved)) initialTheme = saved;
} catch { /* The default also works when browser storage is unavailable. */ }
document.documentElement.dataset.theme = initialTheme;
document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeColors[initialTheme]);
