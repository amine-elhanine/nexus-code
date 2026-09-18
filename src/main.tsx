import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./styles-additions.css";
import "./styles/themes.css";
import "katex/dist/katex.min.css";
import { applyTheme, getStoredThemeId } from "./state/theme.js";

applyTheme(getStoredThemeId());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
