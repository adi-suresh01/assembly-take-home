// TEMPORARY spike page (replaced in Task 6): hold Space, speak, read what came back.
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, parseCommand } from "./commands.js";
import { createVoice } from "./voice.js";

const Q = new URLSearchParams(location.search);
const MODEL = Q.get("model") || "gemma-4-31b";
const LANGS = (Q.get("langs") || "en,es").split(",");

function Spike() {
  const [state, setState] = useState("off");
  const [partial, setPartial] = useState("");
  const [log, setLog] = useState([]);
  const [events, setEvents] = useState([]);
  const turn = useRef({});
  const voice = useRef(null);

  useEffect(() => {
    voice.current = createVoice({
      model: MODEL,
      languages: LANGS,
      record: true,
      onState: setState,
      onPartial: setPartial,
      onFinal: (text, ms) => {
        turn.current = { text, heardMs: ms };
        console.warn("FINAL", text);
        setPartial("");
      },
      onCommand: (raw, ms) => {
        const parsed = parseCommand(raw);
        const row = { ...turn.current, raw, actedMs: ms, said: parsed ? describe(parsed.actions) : "Didn't catch a command" };
        console.warn("SPIKE", JSON.stringify(row));
        setLog((l) => [row, ...l]);
      },
      onEvent: (ev) => console.warn("EV", ev) || setEvents((l) => [`${(performance.now() / 1000).toFixed(1)}s ${ev}`, ...l].slice(0, 25)),
      onError: (m) => setLog((l) => [{ text: "ERROR", said: m }, ...l]),
    });
    const down = (e) => e.code === "Space" && !e.repeat && (e.preventDefault(), voice.current.press());
    const up = (e) => e.code === "Space" && (e.preventDefault(), voice.current.release());
    addEventListener("keydown", down);
    addEventListener("keyup", up);
    return () => (removeEventListener("keydown", down), removeEventListener("keyup", up), voice.current.close());
  }, []);

  return (
    <div style={{ font: "16px system-ui", padding: 24, color: "#eee", background: "#1E2A4A", minHeight: "100vh" }}>
      <h2>Spike: hold Space and speak (model {MODEL}) — mic: {state}</h2>
      <p style={{ opacity: 0.7 }}>{partial}</p>
      <table cellPadding={6}>
        <tbody>
          {log.map((r, i) => (
            <tr key={i} style={{ verticalAlign: "top" }}>
              <td>{r.text}</td>
              <td><b>{r.said}</b></td>
              <td>heard {r.heardMs ?? "–"} ms / acted {r.actedMs ?? "–"} ms</td>
              <td style={{ opacity: 0.5, fontSize: 12 }}>{r.raw}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <pre style={{ opacity: 0.6, fontSize: 12, marginTop: 24 }}>{events.join("\n")}</pre>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<Spike />);
