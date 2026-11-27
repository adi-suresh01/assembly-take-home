import { useEffect, useRef, useState } from "react";
import { describe, parseCommand } from "./commands.js";
import { applyActions, createWorld } from "./drive.js";
import { Hud } from "./Hud.jsx";
import { Scene } from "./Scene.jsx";
import { createVoice } from "./voice.js";

const Q = new URLSearchParams(location.search);
const MODEL = Q.get("model") || "gemma-4-31b";
const LANGUAGES = (Q.get("langs") || "en,es").split(",");

export function App() {
  const world = useRef(createWorld());
  const voice = useRef(null);
  const [hud, setHud] = useState({ said: "", command: "", commandId: 0, error: false, mic: "off" });
  const [live, setLive] = useState({ speedMph: 55, status: "", destination: null, finale: false });

  // Voice: hold Space to talk, release to send.
  useEffect(() => {
    const set = (patch) => setHud((h) => ({ ...h, ...patch }));
    voice.current = createVoice({
      model: MODEL,
      languages: LANGUAGES,
      record: Q.has("record"),
      onState: (mic) => set({ mic }),
      onPartial: (said) => said && set({ said, error: false }),
      onFinal: (said, heardMs) => set({ said, heardMs }),
      onCommand: (content, actedMs) => {
        const parsed = parseCommand(content);
        setHud((h) => ({
          ...h,
          actedMs,
          commandId: h.commandId + 1,
          command: parsed ? describe(parsed.actions) : "Didn't catch a command",
          error: !parsed,
        }));
        if (!parsed) return;
        applyActions(world.current, parsed.actions);
        if (parsed.actions.some((a) => a.type === "assemble")) voice.current.close();
      },
      onError: (message) => {
        console.error("voice:", message);
        set({ command: message, commandId: Date.now(), error: true });
      },
    });
    const down = (e) => {
      if (e.code === "Space") {
        e.preventDefault();
        if (!e.repeat) voice.current.press();
      } else if (e.code === "KeyR") {
        const view = world.current.view;
        world.current = createWorld();
        world.current.view = view;
        setHud((h) => ({ ...h, said: "", command: "", error: false }));
      } else if (e.code === "KeyC") {
        world.current.view = world.current.view === "cockpit" ? "chase" : "cockpit";
      }
    };
    const up = (e) => e.code === "Space" && (e.preventDefault(), voice.current.release());
    addEventListener("keydown", down);
    addEventListener("keyup", up);
    return () => {
      removeEventListener("keydown", down);
      removeEventListener("keyup", up);
      voice.current.close();
    };
  }, []);

  // The HUD reads the world ten times a second; the scene reads it every frame.
  useEffect(() => {
    let finaleAt = null;
    const id = setInterval(() => {
      const w = world.current;
      if (w.assembled && finaleAt == null) finaleAt = performance.now();
      if (!w.assembled) finaleAt = null;
      setLive({
        speedMph: w.player.speedMph,
        status: w.status,
        destination: w.destination,
        finale: finaleAt != null && performance.now() - finaleAt > 2000,
      });
    }, 100);
    return () => clearInterval(id);
  }, []);

  // Dev only (?dev): drive with the keyboard to check the scene without talking.
  useEffect(() => {
    if (!Q.has("dev")) return;
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
    <>
      <div style={{ position: "fixed", inset: 0 }}>
        <Scene world={world} />
      </div>
      <Hud {...hud} {...live} />
    </>
  );
}
