import { describe as group, expect, test } from "vitest";
import { LLM_PROMPT, describe, parseCommand } from "./commands.js";

group("parseCommand", () => {
  test("accepts clean JSON", () => {
    const raw = '{"actions":[{"type":"overtake","target":{"kind":"truck"}},{"type":"cruise","speed_mph":70}]}';
    expect(parseCommand(raw)).toEqual({
      actions: [{ type: "overtake", target: { kind: "truck" } }, { type: "cruise", speed_mph: 70 }],
    });
  });

  test("strips a code fence", () => {
    expect(parseCommand('```json\n{"actions":[{"type":"stop"}]}\n```')).toEqual({ actions: [{ type: "stop" }] });
  });

  test("extracts JSON surrounded by prose", () => {
    expect(parseCommand('Sure! {"actions":[{"type":"lane","direction":"left"}]} Done.')).toEqual({
      actions: [{ type: "lane", direction: "left" }],
    });
  });

  test("rejects non-JSON and unknown actions", () => {
    expect(parseCommand("not json")).toBeNull();
    expect(parseCommand('{"actions":[{"type":"fly"}]}')).toBeNull();
    expect(parseCommand('{"actions":[{"type":"lane","direction":"up"}]}')).toBeNull();
  });

  test("clamps cruise speed to 20-120 mph", () => {
    expect(parseCommand('{"actions":[{"type":"cruise","speed_mph":200}]}').actions[0].speed_mph).toBe(120);
    expect(parseCommand('{"actions":[{"type":"cruise","speed_mph":5}]}').actions[0].speed_mph).toBe(20);
  });
});

group("describe", () => {
  test("says the command in plain words", () => {
    expect(describe([{ type: "overtake", target: { kind: "truck" } }, { type: "cruise", speed_mph: 70 }])).toBe(
      "Overtake the truck, then cruise 70 mph",
    );
    expect(describe([{ type: "none" }])).toBe("No command");
  });
});

test("prompt has the transcript slot", () => {
  expect(LLM_PROMPT).toContain("{{turn}}");
});
