import { expect, test } from "vitest";
import { LANES, LENGTH, applyActions, createWorld, laneX, step } from "./drive.js";

const run = (world, seconds) => {
  for (let i = 0; i < seconds * 60; i++) step(world, 1 / 60);
};
// A quiet road with exactly the traffic a test needs.
const road = (traffic = [], lane = 1) => {
  const w = createWorld();
  w.traffic = traffic;
  w.spawnTraffic = false;
  w.player.lane = lane;
  w.player.x = laneX(lane);
  return w;
};
const car = (over) => {
  const v = { id: Math.random(), kind: "car", color: "white", lane: 1, z: 60, speedMph: 50, ...over };
  return { ...v, x: laneX(v.lane), cruiseMph: v.speedMph };
};

test("cruise sets and reaches the target speed", () => {
  const w = road();
  applyActions(w, [{ type: "cruise", speed_mph: 70 }]);
  run(w, 20);
  expect(w.player.targetMph).toBe(70);
  expect(Math.abs(w.player.speedMph - 70)).toBeLessThan(1);
});

test("lane left eases into the next lane", () => {
  const w = road([], 1);
  applyActions(w, [{ type: "lane", direction: "left" }]);
  run(w, 3);
  expect(w.player.lane).toBe(0);
  expect(Math.abs(w.player.x - laneX(0))).toBeLessThan(0.05);
});

test("lane left from the leftmost lane stays put", () => {
  const w = road([], 0);
  applyActions(w, [{ type: "lane", direction: "left" }]);
  run(w, 1);
  expect(w.player.lane).toBe(0);
  expect(w.status).toBe("Already in the left lane");
});

test("lane change waits for a gap", () => {
  const w = road([car({ lane: 0, z: 2, speedMph: 55 })], 1);
  w.player.speedMph = w.player.targetMph = 55;
  applyActions(w, [{ type: "lane", direction: "left" }]);
  run(w, 0.5);
  expect(w.player.lane).toBe(1);
  expect(w.status).toBe("Waiting for a gap");
});

test("overtakes the named truck and returns to its lane", () => {
  const w = road([car({ kind: "truck", lane: 1, z: 60, speedMph: 45 })], 1);
  w.player.speedMph = w.player.targetMph = 60;
  applyActions(w, [{ type: "overtake", target: { kind: "truck" } }]);
  run(w, 25);
  expect(w.player.z).toBeGreaterThan(w.traffic[0].z);
  expect(w.player.lane).toBe(1);
});

test("overtake with no matching vehicle does nothing", () => {
  const w = road([car({ color: "blue" })], 1);
  applyActions(w, [{ type: "overtake", target: { color: "red", kind: "car" } }]);
  run(w, 1);
  expect(w.player.lane).toBe(1);
  expect(w.status).toBe("No red car ahead");
});

test("a new command replaces whatever was still queued", () => {
  const w = road();
  applyActions(w, [{ type: "cruise", speed_mph: 30 }, { type: "lane", direction: "left" }]);
  applyActions(w, [{ type: "destination", name: "Dolores Park" }]);
  expect(w.queue).toEqual([{ type: "destination", name: "Dolores Park" }]);
});

test("stop pulls over to the right and stops", () => {
  const w = road([], 1);
  applyActions(w, [{ type: "stop" }]);
  run(w, 30);
  expect(w.player.targetMph).toBe(0);
  expect(w.player.lane).toBe(LANES - 1);
  expect(w.player.speedMph).toBeLessThan(0.5);
});

test("destination updates the sign", () => {
  const w = road();
  applyActions(w, [{ type: "destination", name: "Dolores Park" }]);
  run(w, 0.1);
  expect(w.destination).toBe("Dolores Park");
});

test("assemble gives every vehicle a formation slot", () => {
  const w = createWorld();
  applyActions(w, [{ type: "assemble" }]);
  run(w, 0.1);
  expect(w.assembled).toBe(true);
  expect(w.traffic.length).toBeGreaterThan(0);
  expect(w.traffic.every((v) => v.slot != null)).toBe(true);
});

test("never drives into another vehicle", () => {
  const w = createWorld(7);
  const acts = [
    [{ type: "lane", direction: "left" }], [{ type: "lane", direction: "right" }],
    [{ type: "cruise", speed_mph: 110 }], [{ type: "overtake" }], [{ type: "speed_delta", delta_mph: 20 }],
  ];
  for (let t = 0; t < 60 * 60; t++) {
    if (t % 180 === 0) applyActions(w, acts[(t / 180) % acts.length]);
    step(w, 1 / 60);
    for (const v of w.traffic) {
      const sameLane = Math.abs(v.x - w.player.x) < 2.2;
      const touching = Math.abs(v.z - w.player.z) < (LENGTH[v.kind] + LENGTH.car) / 2;
      expect(sameLane && touching).toBe(false);
    }
  }
});

test("keeps a truck coming so the script has a target", () => {
  const w = createWorld(3);
  w.player.speedMph = w.player.targetMph = 70;
  let sawTruck = 0;
  for (let t = 0; t < 60 * 60; t++) {
    step(w, 1 / 60);
    if (t % 60 === 0 && w.traffic.some((v) => v.kind === "truck" && v.z > w.player.z + 30)) sawTruck++;
  }
  expect(sawTruck).toBeGreaterThan(40);
});
