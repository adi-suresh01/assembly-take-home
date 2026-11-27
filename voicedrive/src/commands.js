// What the car understands. Each finished turn goes to AssemblyAI's LLM Gateway with LLM_PROMPT,
// {{turn}} replaced by the transcript; parseCommand checks what comes back.

export const LLM_PROMPT = `You turn a driver's spoken command into JSON for a car on a 4-lane highway.
The driver mixes English and Spanish freely, sometimes in one sentence (Hindi too, now and then). Resolve number words
in any of the three languages (sattar = 70, setenta y dos = 72, sixty-five = 65) and self-corrections
(use the last value the driver settles on). Write addresses as number then street, e.g. "1450 Valencia Street".

Reply with JSON only, no prose: {"actions":[...]} with the actions in the order spoken. Action types:
- {"type":"cruise","speed_mph":N}            set the speed
- {"type":"speed_delta","delta_mph":N}       faster (+5 to +10) or slower (negative)
- {"type":"lane","direction":"left"|"right"}
- {"type":"overtake","target":{"color":"red"|"blue"|"white"|"black"|null,"kind":"car"|"truck"|null}}
- {"type":"stop"}                            pull over / stop the car
- {"type":"destination","name":"..."}        a place to drive to, name exactly as said
- {"type":"assemble"}                        "Founders, assemble!"
- {"type":"none"}                            anything that isn't a driving command

Examples:
"Lane left." -> {"actions":[{"type":"lane","direction":"left"}]}
"Cámbiate al carril derecho." -> {"actions":[{"type":"lane","direction":"right"}]}
"Oye, pasa a ese camión and then cruise at seventy." -> {"actions":[{"type":"overtake","target":{"color":null,"kind":"truck"}},{"type":"cruise","speed_mph":70}]}
"Oye, pasa a ese camión, phir speed sattar kar do." -> {"actions":[{"type":"overtake","target":{"color":null,"kind":"truck"}},{"type":"cruise","speed_mph":70}]}
"Un poquito más rápido. No, actually, setenta y dos." -> {"actions":[{"type":"cruise","speed_mph":72}]}
"Take me to Dolores Park." -> {"actions":[{"type":"destination","name":"Dolores Park"}]}
"Llévame al mil cuatrocientos cincuenta de Valencia Street." -> {"actions":[{"type":"destination","name":"1450 Valencia Street"}]}
"Llévame al 1450 de Valencia Street." -> {"actions":[{"type":"destination","name":"1450 Valencia Street"}]}
"gaadi rok do" -> {"actions":[{"type":"stop"}]}

Driver: {{turn}}`;

const COLORS = ["red", "blue", "white", "black"];
const KINDS = ["car", "truck"];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

// One action in, a clean action out, or null if it isn't one we understand.
function clean(a) {
  switch (a?.type) {
    case "cruise":
      return isNum(a.speed_mph) ? { type: "cruise", speed_mph: Math.round(clamp(a.speed_mph, 20, 120)) } : null;
    case "speed_delta":
      return isNum(a.delta_mph) ? { type: "speed_delta", delta_mph: Math.round(clamp(a.delta_mph, -50, 50)) } : null;
    case "lane":
      return a.direction === "left" || a.direction === "right" ? { type: "lane", direction: a.direction } : null;
    case "overtake": {
      const target = {};
      if (COLORS.includes(a.target?.color)) target.color = a.target.color;
      if (KINDS.includes(a.target?.kind)) target.kind = a.target.kind;
      return Object.keys(target).length ? { type: "overtake", target } : { type: "overtake" };
    }
    case "destination":
      return typeof a.name === "string" && a.name.trim() ? { type: "destination", name: a.name.trim() } : null;
    case "stop":
    case "assemble":
    case "none":
      return { type: a.type };
    default:
      return null;
  }
}

// The LLM's reply text -> {actions} or null. Tolerates code fences and prose around the JSON.
export function parseCommand(content) {
  if (typeof content !== "string") return null;
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let data;
  try {
    data = JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(data?.actions) || data.actions.length === 0) return null;
  const actions = data.actions.map(clean);
  return actions.every(Boolean) ? { actions } : null;
}

function phrase(a) {
  switch (a.type) {
    case "cruise":
      return `cruise ${a.speed_mph} mph`;
    case "speed_delta":
      return a.delta_mph >= 0 ? `speed up ${a.delta_mph} mph` : `slow down ${-a.delta_mph} mph`;
    case "lane":
      return `move to the ${a.direction} lane`;
    case "overtake": {
      const what = [a.target?.color, a.target?.kind ?? (a.target?.color ? "car" : null)].filter(Boolean).join(" ");
      return what ? `overtake the ${what}` : "overtake";
    }
    case "stop":
      return "pull over";
    case "destination":
      return `head to ${a.name}`;
    case "assemble":
      return "assemble";
    default:
      return "no command";
  }
}

// Plain words for the exit tab: "Overtake the truck, then cruise 70 mph".
export function describe(actions) {
  const text = actions.map(phrase).join(", then ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
