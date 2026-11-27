import { useEffect, useRef } from "react";
import { applyActions, createWorld } from "./drive.js";
import { Scene } from "./Scene.jsx";

export function App() {
  const world = useRef(createWorld());

  useEffect(() => {
    // C switches between the chase camera and the driver's seat (off camera, for the recording).
    const view = (e) => e.code === "KeyC" && (world.current.view = world.current.view === "cockpit" ? "chase" : "cockpit");
    addEventListener("keydown", view);
    return () => removeEventListener("keydown", view);
  }, []);

  useEffect(() => {
    // Dev only (?dev): drive with the keyboard to check the scene without talking.
    if (!new URLSearchParams(location.search).has("dev")) return;
    const keys = {
      ArrowLeft: [{ type: "lane", direction: "left" }],
      ArrowRight: [{ type: "lane", direction: "right" }],
      ArrowUp: [{ type: "speed_delta", delta_mph: 10 }],
      ArrowDown: [{ type: "speed_delta", delta_mph: -10 }],
      KeyO: [{ type: "overtake", target: { kind: "truck" } }],
      KeyA: [{ type: "assemble" }],
    };
    const down = (e) => keys[e.code] && applyActions(world.current, keys[e.code]);
    addEventListener("keydown", down);
    return () => removeEventListener("keydown", down);
  }, []);

  return (
    <div style={{ position: "fixed", inset: 0, background: "#1E2A4A" }}>
      <Scene world={world} />
    </div>
  );
}
