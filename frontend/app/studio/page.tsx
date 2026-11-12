"use client";
// Dev-only 3D studio: builds the brand objects in three.js and exports them as transparent PNGs.
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

const ORANGE = "#ff8a00", FLESH = "#ffb02e", PEEL = "#ff7200", WHITE = "#fff8f1", CREAM = "#ffd9b8";

const mat = (color: string, rough = 0.3) =>
  new THREE.MeshPhysicalMaterial({ color, roughness: rough, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.15, sheen: 0.15, sheenColor: new THREE.Color("#ffd2a8"), sheenRoughness: 0.6 });

function ext(shape: THREE.Shape, depth: number, bevel = 0.12, center = true) {
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.85, bevelSegments: 10, curveSegments: 72 });
  if (center) g.center();
  g.computeVertexNormals();
  return g;
}

function roundRect(w: number, h: number, r: number) {
  const s = new THREE.Shape(), x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

const deg = (d: number) => (d * Math.PI) / 180;

/** Orange segment: a plump crescent of flesh with a darker peel along the outer edge. */
function segment() {
  const g = new THREE.Group();
  const a0 = deg(205), a1 = deg(335);
  const flesh = new THREE.Shape();
  flesh.moveTo(Math.cos(a0) * 0.9, Math.sin(a0) * 0.9);
  flesh.absarc(0, 0, 0.9, a0, a1, false);
  flesh.quadraticCurveTo(0, -0.2, Math.cos(a0) * 0.9, Math.sin(a0) * 0.9);
  const peel = new THREE.Shape();
  peel.moveTo(Math.cos(a0) * 1.02, Math.sin(a0) * 1.02);
  peel.absarc(0, 0, 1.02, a0, a1, false);
  peel.lineTo(Math.cos(a1) * 0.86, Math.sin(a1) * 0.86);
  peel.absarc(0, 0, 0.86, a1, a0, true);
  peel.closePath();
  const f = new THREE.Mesh(ext(flesh, 0.42, 0.16, false), mat(FLESH, 0.35));
  const p = new THREE.Mesh(ext(peel, 0.5, 0.12, false), mat(PEEL, 0.4));
  p.position.z = -0.04;
  // juice cells: soft white dots
  for (const [x, y] of [[-0.35, -0.42], [0, -0.52], [0.35, -0.42], [-0.15, -0.3], [0.17, -0.3]] as const) {
    const d = new THREE.Mesh(new THREE.SphereGeometry(0.055, 24, 24), mat(WHITE, 0.2));
    d.scale.z = 0.4; d.position.set(x, y - 0.08, 0.6); g.add(d);
  }
  g.add(f, p);
  const box = new THREE.Box3().setFromObject(g), c = box.getCenter(new THREE.Vector3());
  g.children.forEach((m) => m.position.sub(c));
  const wrap = new THREE.Group(); wrap.add(g);
  return wrap;
}

function shield() {
  const s = new THREE.Shape();
  s.moveTo(0, 1); s.bezierCurveTo(0.4, 0.82, 0.7, 0.8, 0.85, 0.78);
  s.bezierCurveTo(0.85, 0.1, 0.6, -0.55, 0, -1);
  s.bezierCurveTo(-0.6, -0.55, -0.85, 0.1, -0.85, 0.78);
  s.bezierCurveTo(-0.7, 0.8, -0.4, 0.82, 0, 1);
  const g = new THREE.Group();
  g.add(new THREE.Mesh(ext(s, 0.3, 0.16), mat(ORANGE)));
  const c = new THREE.Shape();
  c.moveTo(-0.42, 0.05); c.lineTo(-0.27, 0.2); c.lineTo(-0.1, 0.03); c.lineTo(0.3, 0.43); c.lineTo(0.45, 0.28); c.lineTo(-0.1, -0.27); c.closePath();
  const check = new THREE.Mesh(ext(c, 0.08, 0.05), mat(WHITE, 0.2));
  check.position.set(0, 0.02, 0.28);
  g.add(check);
  return g;
}

function bubble() {
  const s = roundRect(1.9, 1.35, 0.5);
  const g = new THREE.Group();
  const body = new THREE.Mesh(ext(s, 0.3, 0.16), mat(ORANGE));
  const t = new THREE.Shape(); t.moveTo(-0.55, 0); t.lineTo(-0.1, 0); t.lineTo(-0.7, -0.55); t.closePath();
  const tail = new THREE.Mesh(ext(t, 0.3, 0.12), mat(ORANGE)); tail.position.set(-0.45, -0.72, 0);
  g.add(body, tail);
  for (const x of [-0.45, 0, 0.45]) {
    const d = new THREE.Mesh(new THREE.SphereGeometry(0.15, 40, 40), mat(WHITE, 0.2));
    d.scale.z = 0.55; d.position.set(x, 0, 0.3); g.add(d);
  }
  return g;
}

function lock() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(ext(roundRect(1.6, 1.25, 0.32), 0.45, 0.16), mat(ORANGE));
  body.position.y = -0.35;
  const shackle = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.13, 32, 64, Math.PI), mat(CREAM, 0.25));
  shackle.position.y = 0.3;
  const legs = [-0.5, 0.5].map((x) => { const m = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.4, 32), mat(CREAM, 0.25)); m.position.set(x, 0.1, 0); return m; });
  const hole = new THREE.Mesh(new THREE.SphereGeometry(0.14, 32, 32), mat(WHITE, 0.2));
  hole.scale.z = 0.5; hole.position.set(0, -0.3, 0.38);
  const slot = new THREE.Mesh(ext(roundRect(0.1, 0.3, 0.05), 0.04, 0.03), mat(WHITE, 0.2));
  slot.position.set(0, -0.5, 0.37);
  g.add(shackle, ...legs, body, hole, slot);
  return g;
}

function pie() {
  const g = new THREE.Group();
  const sector = (a0: number, a1: number, r: number) => {
    const s = new THREE.Shape(); s.moveTo(0, 0); s.absarc(0, 0, r, a0, a1, false); s.closePath();
    const geo = new THREE.ExtrudeGeometry(s, { depth: 0.35, bevelEnabled: true, bevelThickness: 0.1, bevelSize: 0.08, bevelSegments: 8, curveSegments: 72 });
    geo.translate(0, 0, -0.175); return geo;
  };
  g.add(new THREE.Mesh(sector(deg(100), deg(360), 1), mat(ORANGE)));
  const a = new THREE.Mesh(sector(deg(5), deg(95), 1), mat(CREAM, 0.25));
  a.position.set(Math.cos(deg(50)) * 0.18, Math.sin(deg(50)) * 0.18, 0.05);
  g.add(a);
  return g;
}

function sparkle() {
  const s = new THREE.Shape();
  const k = 0.22;
  s.moveTo(0, 1); s.quadraticCurveTo(k, k, 1, 0); s.quadraticCurveTo(k, -k, 0, -1); s.quadraticCurveTo(-k, -k, -1, 0); s.quadraticCurveTo(-k, k, 0, 1);
  const g = new THREE.Group();
  g.add(new THREE.Mesh(ext(s, 0.25, 0.14), mat(ORANGE)));
  const small = new THREE.Mesh(ext(s, 0.12, 0.08), mat(CREAM, 0.25));
  small.scale.setScalar(0.38); small.position.set(0.85, 0.8, 0.1);
  g.add(small);
  return g;
}

function balance() {
  const g = new THREE.Group();
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.5, 32), mat(CREAM, 0.25)); post.position.y = -0.05;
  const base = new THREE.Mesh(ext(roundRect(1.1, 0.22, 0.11), 0.4, 0.08), mat(ORANGE)); base.position.y = -0.85;
  const beam = new THREE.Mesh(ext(roundRect(2.1, 0.14, 0.07), 0.16, 0.05), mat(ORANGE)); beam.position.y = 0.65; beam.rotation.z = 0.08;
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.14, 32, 32), mat(WHITE, 0.2)); knob.position.y = 0.72;
  g.add(post, base, beam, knob);
  for (const [x, y] of [[-0.95, 0.15], [0.95, 0.3]] as const) {
    const pan = new THREE.Mesh(new THREE.SphereGeometry(0.42, 48, 24, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), mat(ORANGE));
    pan.position.set(x, y, 0);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.04, 16, 64), mat(CREAM, 0.25)); rim.rotation.x = Math.PI / 2; rim.position.set(x, y, 0);
    const str = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.55, 8), mat(CREAM)); str.position.set(x, y + 0.3, 0);
    g.add(pan, rim, str);
  }
  return g;
}

function calendar() {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(ext(roundRect(1.7, 1.6, 0.3), 0.3, 0.14), mat(WHITE, 0.25)));
  const top = new THREE.Mesh(ext(roundRect(1.7, 0.5, 0.2), 0.34, 0.12), mat(ORANGE)); top.position.set(0, 0.6, 0.02);
  g.add(top);
  for (const x of [-0.45, 0.45]) { const r = new THREE.Mesh(new THREE.CapsuleGeometry(0.08, 0.3, 8, 16), mat(CREAM, 0.25)); r.position.set(x, 0.9, 0.12); g.add(r); }
  for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) {
    const d = new THREE.Mesh(ext(roundRect(0.3, 0.26, 0.08), 0.06, 0.03), mat(i === 1 && j === 0 ? ORANGE : CREAM, 0.25));
    d.position.set(-0.45 + i * 0.45, -0.05 - j * 0.42, 0.24); g.add(d);
  }
  return g;
}

function arrow() {
  const s = new THREE.Shape();
  s.moveTo(-0.9, -0.55); s.lineTo(-0.2, 0.1); s.lineTo(0.15, -0.25); s.lineTo(0.55, 0.15); s.lineTo(0.35, 0.35); s.lineTo(1, 0.45); s.lineTo(0.9, -0.2); s.lineTo(0.72, 0); s.lineTo(0.15, -0.58); s.lineTo(-0.2, -0.23); s.lineTo(-0.7, -0.75); s.closePath();
  const g = new THREE.Group();
  g.add(new THREE.Mesh(ext(s, 0.28, 0.12), mat(ORANGE)));
  return g;
}

function blocks() {
  const g = new THREE.Group();
  const cols = [ORANGE, CREAM, ORANGE];
  [[0, -0.55, 1.5], [0.08, -0.05, 1.25], [-0.04, 0.42, 1.0]].forEach(([x, y, w], k) => {
    const b = new THREE.Mesh(ext(roundRect(w, 0.42, 0.18), 0.9, 0.12), mat(cols[k], 0.28));
    b.position.set(x, y, 0); b.rotation.y = k * 0.18; g.add(b);
  });
  return g;
}

function question() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(ext(roundRect(1.6, 1.6, 0.8), 0.3, 0.16), mat(ORANGE));
  g.add(body);
  // The mark is one rounded stroke (a tube along a smooth path), so it cannot self-intersect the way
  // an extruded outline does: the hook arcs clockwise from the upper left and bends into the stem.
  const pts: THREE.Vector3[] = [];
  const cx = 0, cy = 0.2, r = 0.29;
  for (let i = 0; i <= 40; i++) {
    const a = deg(160 - (i / 40) * 210); // 160° -> -50°
    pts.push(new THREE.Vector3(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 0));
  }
  const end = pts[pts.length - 1]!;
  for (let i = 1; i <= 12; i++) {
    const t = i / 12; // ease from the arc's end into a straight vertical stem at x = 0
    const x = end.x * (1 - t) ** 2, y = end.y + (-0.17 - end.y) * t;
    pts.push(new THREE.Vector3(x, y, 0));
  }
  pts.push(new THREE.Vector3(0, -0.24, 0));
  const path = new THREE.CatmullRomCurve3(pts, false, "centripetal");
  const R = 0.085, white = mat(WHITE, 0.2), z = 0.36;
  const tube = new THREE.Mesh(new THREE.TubeGeometry(path, 240, R, 40, false), white);
  const capA = new THREE.Mesh(new THREE.SphereGeometry(R, 40, 40), white); capA.position.copy(pts[0]!);
  const capB = new THREE.Mesh(new THREE.SphereGeometry(R, 40, 40), white); capB.position.copy(pts[pts.length - 1]!);
  const mark = new THREE.Group(); mark.add(tube, capA, capB); mark.position.set(0, 0.08, z); mark.scale.z = 0.7;
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.105, 40, 40), white); dot.scale.z = 0.7; dot.position.set(0, -0.44, z);
  g.add(mark, dot);
  return g;
}

function wallet() {
  const g = new THREE.Group();
  const back = new THREE.Mesh(ext(roundRect(1.8, 1.3, 0.3), 0.35, 0.14), mat(ORANGE)); 
  const card = new THREE.Mesh(ext(roundRect(1.4, 0.8, 0.14), 0.06, 0.04), mat(CREAM, 0.25)); card.position.set(0, 0.55, -0.05); card.rotation.z = 0.08;
  const flap = new THREE.Mesh(ext(roundRect(0.8, 0.5, 0.25), 0.2, 0.08), mat(PEEL, 0.35)); flap.position.set(0.6, -0.05, 0.25);
  const btn = new THREE.Mesh(new THREE.SphereGeometry(0.1, 32, 32), mat(WHITE, 0.2)); btn.scale.z = 0.5; btn.position.set(0.55, -0.05, 0.42);
  g.add(card, back, flap, btn);
  return g;
}

const OBJECTS: Record<string, { build: () => THREE.Object3D; rot: [number, number, number]; scale: number }> = {
  segment: { build: segment, rot: [-0.3, 0.3, 0.35], scale: 1.25 },
  shield: { build: shield, rot: [0.1, -0.45, 0.08], scale: 1.05 },
  bubble: { build: bubble, rot: [0.15, 0.45, -0.06], scale: 1.05 },
  lock: { build: lock, rot: [0.1, -0.4, 0.06], scale: 1.05 },
  pie: { build: pie, rot: [-0.6, 0.45, 0.1], scale: 0.95 },
  sparkle: { build: sparkle, rot: [0.15, -0.4, 0.2], scale: 1.0 },
  balance: { build: balance, rot: [0.15, -0.4, 0], scale: 1.0 },
  calendar: { build: calendar, rot: [0.1, -0.45, 0.06], scale: 1.0 },
  arrow: { build: arrow, rot: [0.2, -0.45, 0.05], scale: 1.05 },
  blocks: { build: blocks, rot: [0.35, -0.5, 0], scale: 1.0 },
  question: { build: question, rot: [0.1, 0.45, -0.08], scale: 1.0 },
  wallet: { build: wallet, rot: [0.1, -0.45, 0.05], scale: 1.0 },
};
const ONLY = new URLSearchParams(typeof location !== "undefined" ? location.search : "").get("only")?.split(",");

export default function Studio() {
  const mount = useRef<HTMLDivElement>(null);
  const [log, setLog] = useState<string[]>([]);

  useEffect(() => {
    const size = 1024;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setSize(size, size);
    renderer.setPixelRatio(1);
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 0.95;
    mount.current!.appendChild(renderer.domElement);
    renderer.domElement.style.width = "256px"; renderer.domElement.style.height = "256px";

    const scene = new THREE.Scene();
    const pm = new THREE.PMREMGenerator(renderer);
    scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    const key = new THREE.DirectionalLight("#ffffff", 2.2); key.position.set(-3, 4, 5);
    const rim = new THREE.DirectionalLight("#ffd0a0", 1.4); rim.position.set(4, -1, -3);
    scene.add(key, rim, new THREE.AmbientLight("#ffffff", 0.35));
    const cam = new THREE.PerspectiveCamera(28, 1, 0.1, 100); cam.position.set(0, 0, 6.2);

    (async () => {
      for (const [name, o] of Object.entries(OBJECTS).filter(([n]) => !ONLY || ONLY.includes(n))) {
        const obj = o.build();
        obj.rotation.set(...o.rot);
        obj.scale.setScalar(o.scale);
        scene.add(obj);
        renderer.render(scene, cam);
        const data = renderer.domElement.toDataURL("image/png");
        const r = await fetch("/api/save", { method: "POST", body: JSON.stringify({ name, data }) }).then((x) => x.json());
        setLog((l) => [...l, `${name}: ${r.bytes}`]);
        scene.remove(obj);
      }
      setLog((l) => [...l, "done"]);
    })();
    return () => { renderer.dispose(); renderer.domElement.remove(); };
  }, []);

  return (
    <main style={{ padding: 24, background: "#eee", color: "#000", minHeight: "100vh" }}>
      <div ref={mount} />
      <pre id="log">{log.join("\n")}</pre>
    </main>
  );
}
