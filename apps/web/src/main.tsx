import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "@fontsource-variable/noto-sans-sc";
import "./styles.css";
import "./themes.css";
import "./interface.css";
import "./apple-polish.css";
import "./matrix-theme.css";
import "./storybook-themes.css";
import "./cinema-themes.css";
import "./message-themes.css";
import "./classic-themes.css";
import "./chinese-themes.css";
import "./settings-layout.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js");
  });
}
