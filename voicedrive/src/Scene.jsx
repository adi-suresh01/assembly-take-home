// The night highway. Reads the world from drive.js every frame and draws it; owns no game state.
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Environment, MeshReflectorMaterial, useGLTF } from "@react-three/drei";
import { Bloom, EffectComposer, ToneMapping, Vignette } from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { LANES, LANE_WIDTH, laneX, step } from "./drive.js";

const ROAD_W = LANES * LANE_WIDTH;
const DASH_EVERY = 12;
const LIGHT_EVERY = 40;
const POOL = 14; // vehicles drawn at once
const PAINT = { red: "#b3121f", blue: "#1f4fbf", white: "#d9dcdf", black: "#111317", player: "#f08a24" };
const SODIUM = new THREE.Color("#F3A447");

// ---------- vehicles ----------

function useCarFactory() {
  const { scene } = useGLTF("/models/CarConcept.glb");
  return useMemo(() => {
    const paints = Object.fromEntries(Object.entries(PAINT).map(([k, c]) => [k, null]));
    const glass = new THREE.MeshPhysicalMaterial({ color: "#0b0e14", metalness: 0.1, roughness: 0.05, transparent: true, opacity: 0.82 });
    const head = new THREE.MeshStandardMaterial({ color: "#ffffff", emissive: "#fff4e0", emissiveIntensity: 6, toneMapped: false });
    const tail = new THREE.MeshStandardMaterial({ color: "#400", emissive: "#D7263D", emissiveIntensity: 4, toneMapped: false });
    scene.traverse((o) => {
      if (!o.isMesh) return;
      const n = o.material.name || "";
      if (n.startsWith("Paint") && !paints.red) {
        for (const [k, c] of Object.entries(PAINT)) {
          const m = o.material.clone();
          m.color.set(c);
          m.iridescence = 0;
          m.map = null;
          paints[k] = m;
        }
      }
    });
    // One template; the file's own root transform already stands it upright facing +z.
    const template = new THREE.Group();
    const body = scene.clone(true);
    body.traverse((o) => {
      if (/^(Interior|Engine)/.test(o.name)) o.visible = false;
      // The file carries Khronos trademark logos (plate, steering emblem); keep them out of the demo.
      if (o.name === "License Plate" || o.name === "InteriorSteeringEmblem" || o.material?.name === "License") {
        o.visible = false;
        o.userData.logo = true;
      }
      if (!o.isMesh) return;
      const n = o.material.name || "";
      if (n === "Glass" || n === "Mirror") o.material = glass;
      else if (n === "Headlight") o.material = head;
      else if (n === "Brakelight") o.material = tail;
      else if (n.startsWith("Paint")) o.userData.paint = true;
    });
    template.add(body);
    const box = new THREE.Box3().setFromObject(template);
    body.position.y = -box.min.y;
    return (color, { interior = false } = {}) => {
      const car = template.clone(true);
      if (interior) car.traverse((o) => /^(Interior|Engine)/.test(o.name) && !o.userData.logo && (o.visible = true));
      car.userData.setPaint = (c) => car.traverse((o) => o.userData.paint && (o.material = paints[c] ?? paints.white));
      car.userData.setPaint(color);
      return car;
    };
  }, [scene]);
}

function makeTruck() {
  const g = new THREE.Group();
  const box = (w, h, d, mat, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };
  const trailer = new THREE.MeshStandardMaterial({ color: "#c7cbd1", metalness: 0.55, roughness: 0.4 });
  const cab = new THREE.MeshStandardMaterial({ color: "#7d1820", metalness: 0.5, roughness: 0.35 });
  const dark = new THREE.MeshStandardMaterial({ color: "#121316", roughness: 0.9 });
  const red = new THREE.MeshStandardMaterial({ color: "#400", emissive: "#D7263D", emissiveIntensity: 5, toneMapped: false });
  const amber = new THREE.MeshStandardMaterial({ color: "#420", emissive: "#F3A447", emissiveIntensity: 5, toneMapped: false });
  box(2.6, 3.4, 12, trailer, 0, 2.6, -2); // trailer box
  box(2.5, 2.8, 2.8, cab, 0, 2.0, 5.6); // cab
  box(2.4, 1.0, 1.2, dark, 0, 0.9, 7.2); // bumper / grille
  for (const z of [-6.8, -5.5, 4.6, 6.6]) for (const x of [-1.15, 1.15]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.4, 16), dark);
    w.rotation.z = Math.PI / 2;
    w.position.set(x, 0.5, z);
    g.add(w);
  }
  for (const x of [-1.05, 1.05]) box(0.4, 0.25, 0.08, red, x, 1.1, -8.02); // tail lights
  for (let z = -7.5; z <= 3.5; z += 2.75) for (const x of [-1.31, 1.31]) box(0.06, 0.12, 0.22, amber, x, 4.2, z); // markers
  g.position.y = 0;
  return g;
}

function Vehicles({ world }) {
  const makeCar = useCarFactory();
  const group = useRef();
  const slots = useMemo(
    () => Array.from({ length: POOL }, () => {
      const slot = new THREE.Group();
      const car = makeCar("white");
      const truck = makeTruck();
      slot.add(car, truck);
      slot.userData = { car, truck, color: "white" };
      return slot;
    }),
    [makeCar],
  );
  const player = useMemo(() => makeCar("player", { interior: true }), [makeCar]);
  const beam = useRef();

  useLayoutEffect(() => {
    slots.forEach((s) => group.current.add(s));
    group.current.add(player);
  }, [slots, player]);

  useFrame(() => {
    const w = world.current;
    slots.forEach((s, i) => {
      const v = w.traffic[i];
      s.visible = !!v;
      if (!v) return;
      s.position.set(v.x, 0, v.z);
      s.userData.car.visible = v.kind !== "truck";
      s.userData.truck.visible = v.kind === "truck";
      if (v.kind !== "truck" && s.userData.color !== v.color) {
        s.userData.car.userData.setPaint(v.color);
        s.userData.color = v.color;
      }
    });
    const p = w.player;
    player.position.set(p.x, 0, p.z);
    player.rotation.y = THREE.MathUtils.clamp((laneX(p.lane) - p.x) * 0.06, -0.08, 0.08);
    if (beam.current) {
      beam.current.position.set(p.x, 0.8, p.z + 2.2);
      beam.current.target.position.set(p.x, 0, p.z + 30);
      beam.current.target.updateMatrixWorld();
    }
  });

  return (
    <group ref={group}>
      <spotLight ref={beam} color="#fff1dc" intensity={400} distance={90} angle={0.42} penumbra={0.7} decay={1.6} />
    </group>
  );
}

// ---------- the road and everything along it ----------

function Road({ world }) {
  const road = useRef();
  const ground = useRef();
  const dashes = useRef();
  const posts = useRef();
  const poles = useRef();
  const heads = useRef();
  const rails = useRef();
  const lights = useRef([]);
  const tmp = useMemo(() => new THREE.Object3D(), []);
  const DASHES = (LANES - 1) * 34;
  const POSTS = 2 * 100;
  const POLES = 2 * 10;

  useFrame(() => {
    const pz = world.current.player.z;
    road.current.position.z = pz + 140;
    ground.current.position.z = pz + 140;
    rails.current.position.z = pz + 140;
    const z0 = Math.floor((pz - 40) / DASH_EVERY) * DASH_EVERY;
    let i = 0;
    for (let lane = 1; lane < LANES; lane++) {
      const x = (laneX(lane - 1) + laneX(lane)) / 2;
      for (let k = 0; k < 34; k++, i++) {
        tmp.position.set(x, 0.012, z0 + k * DASH_EVERY);
        tmp.updateMatrix();
        dashes.current.setMatrixAt(i, tmp.matrix);
      }
    }
    dashes.current.instanceMatrix.needsUpdate = true;
    const p0 = Math.floor((pz - 40) / 4) * 4;
    for (let k = 0; k < 100; k++) for (const [j, side] of [[0, -1], [1, 1]]) {
      tmp.position.set(side * (ROAD_W / 2 + 1.4), 0.4, p0 + k * 4);
      tmp.updateMatrix();
      posts.current.setMatrixAt(k * 2 + j, tmp.matrix);
    }
    posts.current.instanceMatrix.needsUpdate = true;
    const l0 = Math.floor((pz - 40) / LIGHT_EVERY) * LIGHT_EVERY;
    for (let k = 0; k < 10; k++) for (const [j, side] of [[0, -1], [1, 1]]) {
      const z = l0 + k * LIGHT_EVERY + (side > 0 ? LIGHT_EVERY / 2 : 0);
      tmp.position.set(side * (ROAD_W / 2 + 2.2), 4.5, z);
      tmp.updateMatrix();
      poles.current.setMatrixAt(k * 2 + j, tmp.matrix);
      tmp.position.set(side * (ROAD_W / 2 - 0.4), 9, z);
      tmp.updateMatrix();
      heads.current.setMatrixAt(k * 2 + j, tmp.matrix);
    }
    poles.current.instanceMatrix.needsUpdate = true;
    heads.current.instanceMatrix.needsUpdate = true;
    // Real light only from the nearest lamps ahead; the rest are glowing heads.
    lights.current.forEach((l, k) => {
      if (!l) return;
      const side = k % 2 ? 1 : -1;
      const z = l0 + (Math.floor(k / 2) + 1) * LIGHT_EVERY + (side > 0 ? LIGHT_EVERY / 2 : 0);
      l.position.set(side * (ROAD_W / 2 - 0.6), 8.6, z);
    });
  });

  return (
    <>
      <mesh ref={ground} rotation-x={-Math.PI / 2} position-y={-0.02}>
        <planeGeometry args={[400, 800]} />
        <meshStandardMaterial color="#0b0d12" roughness={1} />
      </mesh>
      <mesh ref={road} rotation-x={-Math.PI / 2}>
        <planeGeometry args={[ROAD_W + 3, 520]} />
        <MeshReflectorMaterial
          color="#22252B" roughness={0.75} metalness={0.4}
          blur={[400, 120]} resolution={1024} mixBlur={1} mixStrength={6} mixContrast={1.1}
          depthScale={1} minDepthThreshold={0.3} maxDepthThreshold={1.2} mirror={0.7}
        />
      </mesh>
      <group ref={rails}>
        {[-1, 1].map((side) => (
          <mesh key={side} position={[side * (ROAD_W / 2 + 1.25), 0.75, 0]}>
            <boxGeometry args={[0.12, 0.3, 520]} />
            <meshStandardMaterial color="#8a9099" metalness={0.8} roughness={0.35} />
          </mesh>
        ))}
        <mesh position={[ROAD_W / 2 - 0.15, 0.011, 0]} rotation-x={-Math.PI / 2}>
          <planeGeometry args={[0.15, 520]} />
          <meshStandardMaterial color="#e2b440" emissive="#e2b440" emissiveIntensity={0.25} />
        </mesh>
        <mesh position={[-ROAD_W / 2 + 0.15, 0.011, 0]} rotation-x={-Math.PI / 2}>
          <planeGeometry args={[0.15, 520]} />
          <meshStandardMaterial color="#e8eaec" emissive="#e8eaec" emissiveIntensity={0.25} />
        </mesh>
      </group>
      <instancedMesh ref={dashes} frustumCulled={false} args={[null, null, DASHES]}>
        <boxGeometry args={[0.14, 0.01, 3]} />
        <meshStandardMaterial color="#e8eaec" emissive="#e8eaec" emissiveIntensity={0.3} />
      </instancedMesh>
      <instancedMesh ref={posts} frustumCulled={false} args={[null, null, POSTS]}>
        <boxGeometry args={[0.12, 0.8, 0.12]} />
        <meshStandardMaterial color="#5b6068" metalness={0.6} roughness={0.5} />
      </instancedMesh>
      <instancedMesh ref={poles} frustumCulled={false} args={[null, null, POLES]}>
        <cylinderGeometry args={[0.1, 0.14, 9, 8]} />
        <meshStandardMaterial color="#3a3f47" metalness={0.6} roughness={0.5} />
      </instancedMesh>
      <instancedMesh ref={heads} frustumCulled={false} args={[null, null, POLES]}>
        <boxGeometry args={[1.2, 0.18, 0.5]} />
        <meshStandardMaterial color="#3b2a10" emissive={SODIUM} emissiveIntensity={8} toneMapped={false} />
      </instancedMesh>
      {Array.from({ length: 6 }, (_, k) => (
        <pointLight key={k} ref={(l) => (lights.current[k] = l)} color={SODIUM} intensity={120} distance={42} decay={1.7} />
      ))}
    </>
  );
}

function windowTexture() {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 128;
  const g = c.getContext("2d");
  g.fillStyle = "#06080e";
  g.fillRect(0, 0, 64, 128);
  for (let y = 4; y < 128; y += 8) for (let x = 4; x < 64; x += 8) {
    if (Math.random() < 0.14) {
      g.fillStyle = Math.random() < 0.7 ? "#f3c57a" : "#cfe3ff";
      g.fillRect(x + 1, y + 1, 2, 3);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function Skyline({ world }) {
  const ref = useRef();
  const buildings = useMemo(() => {
    const tex = windowTexture();
    const out = [];
    for (let i = 0; i < 140; i++) {
      const side = i % 2 ? 1 : -1;
      const h = 25 + Math.random() ** 2 * 160;
      const w = 14 + Math.random() * 26;
      out.push({ pos: [side * (110 + Math.random() * 420), h / 2, 520 + Math.random() * 380], size: [w, h, w], tex });
    }
    return out;
  }, []);
  useFrame(() => (ref.current.position.z = world.current.player.z));
  return (
    <group ref={ref}>
      {buildings.map((b, i) => (
        <mesh key={i} position={b.pos}>
          <boxGeometry args={b.size} />
          <meshStandardMaterial color="#0a0d16" emissiveMap={b.tex} emissive="#ffffff" emissiveIntensity={0.9} />
        </mesh>
      ))}
    </group>
  );
}

function Sky() {
  const mat = useMemo(
    () => new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {},
      vertexShader: "varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
      fragmentShader: `varying vec3 vP;
        void main(){
          float h = clamp(vP.y, -0.1, 1.0);
          vec3 top = vec3(0.025, 0.035, 0.08);
          vec3 mid = vec3(0.118, 0.165, 0.29);   // #1E2A4A
          vec3 glow = vec3(0.32, 0.22, 0.24);    // city glow on the horizon
          vec3 c = mix(glow, mid, smoothstep(0.0, 0.08, h));
          c = mix(c, top, smoothstep(0.08, 0.6, h));
          gl_FragColor = vec4(c, 1.0);
        }`,
    }),
    [],
  );
  const { camera } = useThree();
  const ref = useRef();
  useFrame(() => ref.current.position.copy(camera.position));
  return (
    <mesh ref={ref} material={mat} renderOrder={-1}>
      <sphereGeometry args={[700, 32, 16]} />
    </mesh>
  );
}

// ---------- simulation tick and camera ----------

function Rig({ world }) {
  const { camera } = useThree();
  const look = useMemo(() => new THREE.Vector3(), []);
  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05);
    const w = world.current;
    step(w, dt);
    const p = w.player;
    const k = 1 - Math.exp(-dt * 3.5);
    const fin = w.assembled;
    const speed = THREE.MathUtils.clamp((p.speedMph - 40) / 60, 0, 1);
    // C toggles the driver's seat (single-seat concept car: the wheel is on the centre line).
    if (w.view === "cockpit" && !fin) {
      camera.position.set(p.x, 1.12, p.z + 0.2);
      look.set(p.x + (laneX(p.lane) - p.x) * 0.4, 0.95, p.z + 20);
      camera.lookAt(look);
      camera.fov = 68;
      camera.updateProjectionMatrix();
      return;
    }
    const target = new THREE.Vector3(p.x * 0.8, fin ? 11 : 2.5, p.z - (fin ? 20 : 7.5));
    camera.position.lerp(target, fin ? 1 - Math.exp(-dt * 0.8) : k);
    if (speed > 0.5 && !fin) camera.position.y += Math.sin(performance.now() * 0.05) * 0.012 * speed;
    look.lerp(new THREE.Vector3(p.x, fin ? 0.5 : 1.0, p.z + (fin ? 6 : 14)), k);
    camera.lookAt(look);
    camera.fov = THREE.MathUtils.lerp(camera.fov, 55 + 7 * speed, k);
    camera.updateProjectionMatrix();
  });
  return null;
}

export function Scene({ world }) {
  return (
    <Canvas flat dpr={[1, 1.5]} camera={{ fov: 55, near: 0.1, far: 1500, position: [0, 3, -8] }}>
      <fog attach="fog" args={["#1E2A4A", 80, 1000]} />
      <Sky />
      <hemisphereLight args={["#33415f", "#0b0d12", 0.35]} />
      <Environment files="/hdri/shanghai_bund_1k.hdr" environmentIntensity={0.45} />
      <Rig world={world} />
      <Road world={world} />
      <Skyline world={world} />
      <Vehicles world={world} />
      <EffectComposer multisampling={4}>
        <Bloom luminanceThreshold={1} luminanceSmoothing={0.2} intensity={0.9} mipmapBlur radius={0.75} />
        <Vignette offset={0.28} darkness={0.7} />
        <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      </EffectComposer>
    </Canvas>
  );
}
