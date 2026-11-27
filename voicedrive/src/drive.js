// Car and traffic logic, no rendering: a kinematic highway the scene draws and the voice drives.
// Units: metres and seconds inside; speeds are exposed in mph because that's what the HUD shows.

export const LANES = 4; // lane 0 is the leftmost
export const LANE_WIDTH = 3.6;
const MPH = 0.44704; // m/s per mph
const LANE_SPEED = LANE_WIDTH; // lateral m/s, so a lane change takes ~1 s
const ACCEL = 2; // m/s², gentle speed changes
const BRAKE = 9; // m/s², the most the car will brake to keep a gap
const PLAN_BRAKE = 6; // m/s², what the safe-speed rule assumes (less than BRAKE, so it always holds)
const BUMPER = 3.5; // m of space kept between bumpers
export const LENGTH = { car: 4.6, truck: 16 }; // m
const len = (v) => LENGTH[v.kind ?? "car"];
const SAME_LANE = 2.6; // m of lateral overlap that counts as "in my lane"
const COLORS = ["red", "blue", "white", "black"];

// Looking down the road (+z) in three.js, +x is on the left, so lane 0 (leftmost) gets the largest x.
export const laneX = (lane) => ((LANES - 1) / 2 - lane) * LANE_WIDTH;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createWorld(seed = 1) {
  const w = {
    rand: rng(seed),
    nextId: 1,
    player: { kind: "car", lane: 1, x: laneX(1), z: 0, speedMph: 55, targetMph: 55 },
    traffic: [],
    spawnTraffic: true,
    queue: [],
    current: null, // the action being carried out, with its progress
    pullOver: false,
    status: "",
    destination: null,
    assembled: false,
  };
  for (let z = 50; z < 300; z += 45) spawn(w, z);
  return w;
}

function spawn(w, z, kind) {
  for (let tries = 0; tries < 8; tries++) {
    const lane = Math.floor(w.rand() * LANES);
    if (w.traffic.some((v) => v.lane === lane && Math.abs(v.z - z) < 40)) continue;
    const truck = (kind ?? (w.rand() < 0.3 ? "truck" : "car")) === "truck";
    w.traffic.push({
      id: w.nextId++,
      kind: truck ? "truck" : "car",
      color: truck ? "white" : COLORS[Math.floor(w.rand() * COLORS.length)],
      lane, x: laneX(lane), z,
      cruiseMph: truck ? 45 + w.rand() * 6 : 48 + w.rand() * 14,
      speedMph: 0,
    });
    w.traffic.at(-1).speedMph = w.traffic.at(-1).cruiseMph;
    return;
  }
}

// A new utterance replaces whatever was still waiting to happen.
export function applyActions(w, actions) {
  w.queue = [...actions];
  w.current = null;
  w.status = "";
}

const ahead = (w, from, x, others) =>
  others.filter((o) => o !== from && o.z > from.z && Math.abs(o.x - x) < SAME_LANE)
    .sort((a, b) => a.z - b.z)[0];

// Fastest speed (m/s) from which we can still stop behind `obstacle` with room to spare.
function safeSpeed(me, obstacle) {
  if (!obstacle) return Infinity;
  const gap = obstacle.z - me.z - (len(me) + len(obstacle)) / 2 - BUMPER;
  return obstacle.speedMph * MPH + Math.sqrt(2 * PLAN_BRAKE * Math.max(0, gap));
}

function laneIsFree(w, lane) {
  const p = w.player;
  const vp = p.speedMph * MPH;
  return !w.traffic.some((v) => {
    if (v.lane !== lane) return false;
    const dz = v.z - p.z;
    const closing = dz > 0 ? vp - v.speedMph * MPH : v.speedMph * MPH - vp;
    const need = (len(p) + len(v)) / 2 + BUMPER + 4 + Math.max(0, closing) * 2.5;
    return Math.abs(dz) < need;
  });
}

function describeTarget(t) {
  return [t?.color, t?.kind ?? "car"].filter(Boolean).join(" ");
}

// Carry out the current action; returns true when it's finished.
function runAction(w, a) {
  const p = w.player;
  switch (a.type) {
    case "cruise":
      p.targetMph = a.speed_mph;
      w.pullOver = false;
      return true;
    case "speed_delta":
      p.targetMph = Math.min(120, Math.max(20, p.targetMph + a.delta_mph));
      w.pullOver = false;
      return true;
    case "destination":
      w.destination = a.name;
      return true;
    case "stop":
      p.targetMph = 0;
      w.pullOver = true;
      return true;
    case "assemble":
      w.assembled = true;
      w.traffic.forEach((v, i) => {
        // Rows of up to four behind the player, one per lane, like a convoy forming up.
        const row = Math.floor(i / LANES) + 1;
        v.slot = { lane: i % LANES, dz: -row * (v.kind === "truck" ? 22 : 14) - (i % 2) * 3 };
      });
      return true;
    case "lane": {
      const to = p.lane + (a.direction === "left" ? -1 : 1);
      if (a.started) return Math.abs(p.x - laneX(p.lane)) < 0.05;
      if (to < 0 || to >= LANES) {
        w.status = `Already in the ${a.direction} lane`;
        return true;
      }
      if (!laneIsFree(w, to)) {
        w.status = "Waiting for a gap";
        return false;
      }
      w.status = "";
      p.lane = to;
      a.started = true;
      return false;
    }
    case "overtake":
      return overtake(w, a);
    default:
      return true;
  }
}

function overtake(w, a) {
  const p = w.player;
  if (!a.phase) {
    const want = (v) => (!a.target?.kind || v.kind === a.target.kind) && (!a.target?.color || v.color === a.target.color);
    const candidates = w.traffic.filter((v) => v.z > p.z + 5 && want(v)).sort((x, y) => x.z - y.z);
    const sameLane = candidates.find((v) => v.lane === p.lane);
    const target = a.target ? candidates[0] : sameLane ?? candidates[0];
    if (!target) {
      w.status = a.target ? `No ${describeTarget(a.target)} ahead` : "Nothing ahead to overtake";
      return true;
    }
    Object.assign(a, { phase: target.lane === p.lane ? "out" : "pass", target, home: p.lane, keepMph: p.targetMph });
  }
  const t = a.target;
  if (!w.traffic.includes(t)) return true;
  if (a.phase === "out") {
    const options = [p.lane - 1, p.lane + 1].filter((l) => l >= 0 && l < LANES);
    const lane = options.find((l) => laneIsFree(w, l));
    if (lane == null) {
      w.status = "Waiting for a gap";
      return false;
    }
    w.status = "";
    p.lane = lane;
    a.phase = "pass";
  }
  if (a.phase === "pass") {
    p.targetMph = Math.max(a.keepMph, t.speedMph + 15);
    if (p.z > t.z + (len(t) + len(p)) / 2 + 8) a.phase = a.home === t.lane ? "back" : "done";
  }
  if (a.phase === "back") {
    if (laneIsFree(w, a.home)) {
      p.lane = a.home;
      a.phase = "done";
    } else w.status = "Waiting for a gap";
  }
  if (a.phase === "done") {
    p.targetMph = a.keepMph;
    w.status = "";
    return Math.abs(p.x - laneX(p.lane)) < 0.05;
  }
  return false;
}

function moveSpeed(v, wantMs, dt) {
  const cur = v.speedMph * MPH;
  const rate = wantMs < cur - 0.01 ? (wantMs < cur - 2 ? BRAKE : ACCEL) : ACCEL;
  const next = wantMs > cur ? Math.min(wantMs, cur + ACCEL * dt) : Math.max(wantMs, cur - rate * dt);
  v.speedMph = Math.max(0, next) / MPH;
}

export function step(w, dt) {
  const p = w.player;

  // Voice commands, one at a time.
  if (!w.current && w.queue.length) w.current = { ...w.queue.shift() };
  if (w.current && runAction(w, w.current)) w.current = null;
  if (w.pullOver && !w.current && p.lane < LANES - 1 && Math.abs(p.x - laneX(p.lane)) < 0.05 && laneIsFree(w, p.lane + 1))
    p.lane += 1;

  // Player: ease sideways to its lane, keep a safe gap, otherwise head for the target speed.
  const dx = laneX(p.lane) - p.x;
  p.x += Math.sign(dx) * Math.min(Math.abs(dx), LANE_SPEED * dt);
  const wantP = Math.min(p.targetMph * MPH, safeSpeed(p, ahead(w, p, p.x, w.traffic)));
  // Easing to a stop is comfortable; braking for traffic may be hard.
  if (p.targetMph * MPH <= wantP && wantP < p.speedMph * MPH) {
    p.speedMph = Math.max(wantP, p.speedMph * MPH - 2.5 * dt) / MPH;
  } else moveSpeed(p, wantP, dt);

  // Traffic: hold its lane and speed, never run into anyone (the player included).
  const everyone = [...w.traffic, p];
  for (const v of w.traffic) {
    if (w.assembled && v.slot) {
      const tx = laneX(v.slot.lane);
      v.x += (tx - v.x) * Math.min(1, 2 * dt);
      v.z += (p.z + v.slot.dz - v.z) * Math.min(1, 1.5 * dt) + p.speedMph * MPH * dt;
      v.speedMph = p.speedMph;
      continue;
    }
    moveSpeed(v, Math.min(v.cruiseMph * MPH, safeSpeed(v, ahead(w, v, v.x, everyone))), dt);
  }
  p.z += p.speedMph * MPH * dt;
  for (const v of w.traffic) if (!(w.assembled && v.slot)) v.z += v.speedMph * MPH * dt;

  // Keep the road busy ahead, and keep a truck coming so "pass that truck" always has a target.
  if (w.spawnTraffic && !w.assembled) {
    w.traffic = w.traffic.filter((v) => v.z > p.z - 80 && v.z < p.z + 420);
    const truckAhead = w.traffic.some((v) => v.kind === "truck" && v.z > p.z + 30);
    if (!truckAhead) spawn(w, p.z + 200 + w.rand() * 60, "truck");
    else if (w.traffic.filter((v) => v.z > p.z).length < 7) spawn(w, p.z + 250 + w.rand() * 60);
  }
}
