import "@fontsource/overpass/400.css";
import "@fontsource/overpass/700.css";
import "@fontsource/noto-sans-devanagari/400.css";
import "@fontsource/noto-sans-devanagari/700.css";
import "./styles.css";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";

// Guard against Vite hot reload creating a second root (and with it a second mic socket).
window.__root ??= createRoot(document.getElementById("root"));
window.__root.render(<App />);
