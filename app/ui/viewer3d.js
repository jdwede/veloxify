// The 3D replay: CS2's own map (prepared once from the user's CS2 install) and every player's
// movement and aim from the demo, 32 times a second. One viewer is kept for the whole app, so the
// map stays loaded when you switch rounds or tabs.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";

// Game units are inches, the map export is in meters with its axes as (y, z, x).
const S = 0.0254;
const toWorld = (x, y, z, v = new THREE.Vector3()) => v.set(y * S, z * S, x * S);
const SIDE_COLOR = { CT: 0x5b8fd9, T: 0xe0a73a };
// Eye height standing and how much crouching takes off (game units).
const EYE = 64, CROUCH_DROP = 18;
// CS2's default view: 90° across at 4:3, which is 73.74° up and down on any screen.
const VFOV = 73.74;
// Lighting, matched against CS2's own picture of the same spot on Mirage.
const LIGHT = { sun: 4.5, sky: 0.3, baked: 0.8, exposure: 1.0 };

/** A match's 3D replay data (`matches/<id>.r3d.gz`): header plus one Int16Array per round. */
export async function loadTrack(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`3D replay data: ${res.status}`);
  const buf = await new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  if (new TextDecoder().decode(new Uint8Array(buf, 0, 4)) !== "VR3D") throw new Error("not a 3D replay file");
  const dv = new DataView(buf);
  const hl = dv.getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, hl)));
  const P = header.players.length;
  let off = 12 + hl;
  const rounds = header.rounds.map((r) => {
    const bytes = P * r.n * 7 * 2;
    // Copied out so the numbers are 2-byte aligned. Sample k of player p: data[(p * n + k) * 7 + c].
    const data = new Int16Array(buf.slice(off, off + bytes));
    off += bytes;
    return { ...r, data };
  });
  return { header, rounds };
}

const lerpAngle = (a, b, t) => a + ((((b - a + 540) % 360) + 360) % 360 - 180) * t;

/** Player p in round r at fractional sample f: position, view, crouch, health. */
export function sampleAt(r, p, f, out = {}) {
  const n = r.n, D = r.data;
  const i0 = Math.max(0, Math.min(n - 1, Math.floor(f))), i1 = Math.min(n - 1, i0 + 1);
  let t = Math.max(0, Math.min(1, f - i0));
  const a = (p * n + i0) * 7, b = (p * n + i1) * 7;
  // Spawning, dying or a jump across the map: no blending between the two.
  if (D[a + 6] <= 0 || D[b + 6] <= 0 || Math.abs(D[b] - D[a]) + Math.abs(D[b + 1] - D[a + 1]) > 160) t = t < 0.5 ? 0 : 1;
  out.x = D[a] + (D[b] - D[a]) * t;
  out.y = D[a + 1] + (D[b + 1] - D[a + 1]) * t;
  out.z = D[a + 2] + (D[b + 2] - D[a + 2]) * t;
  out.yaw = lerpAngle(D[a + 3] / 50, D[b + 3] / 50, t);
  out.pitch = (D[a + 4] + (D[b + 4] - D[a + 4]) * t) / 100;
  out.duck = (D[a + 5] + (D[b + 5] - D[a + 5]) * t) / 1000;
  out.hp = t < 0.5 ? D[a + 6] : D[b + 6];
  return out;
}

/** Where a view with this yaw and pitch (game degrees, pitch down = positive) looks, in world space. */
function viewDir(yaw, pitch, v = new THREE.Vector3()) {
  const cy = Math.cos(yaw * Math.PI / 180), sy = Math.sin(yaw * Math.PI / 180);
  const cp = Math.cos(pitch * Math.PI / 180), sp = Math.sin(pitch * Math.PI / 180);
  return v.set(cp * sy, -sp, cp * cy);
}

function makeFigure(color) {
  const mat = new THREE.MeshLambertMaterial({ color });
  const dark = new THREE.MeshLambertMaterial({ color: 0x222222 });
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.27, 0.92, 4, 12), mat);
  body.position.y = 0.73;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 12), mat);
  head.position.y = 1.64;
  const aim = new THREE.Group();
  aim.position.set(0.14, 1.4, 0.05);
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 0.62), dark);
  gun.position.z = 0.3;
  aim.add(gun);
  g.add(body, head, aim);
  g.userData = { aim, mat };
  return g;
}

class Viewer {
  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "v3d-canvas";
    this.canvas.tabIndex = 0;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = LIGHT.exposure;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // The map doesn't move: its shadows are drawn again only when the view moves somewhere else.
    this.renderer.shadowMap.autoUpdate = false;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color("#9ec3e6");
    this.camera = new THREE.PerspectiveCamera(VFOV, 16 / 9, 0.05, 2000);
    this.sun = new THREE.DirectionalLight(0xffe0b0, LIGHT.sun);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    Object.assign(this.sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 1, far: 400 });
    this.toSun = new THREE.Vector3(0.335, 0.866, -0.372).normalize();
    this.shadowAt = null;
    this.scene.add(this.sun, this.sun.target, new THREE.HemisphereLight(0xcfd8e6, 0x8a7560, LIGHT.sky));
    this.map = null;
    this.mapRoot = null;
    this.figures = [];
    this.free = { pos: new THREE.Vector3(), yaw: 0, pitch: 20, keys: new Set() };
    this.pov = null;
    this.raf = 0;
    this.tmp = {};
    this._bindInput();
  }

  /** Loads the map (once; the same map stays). `urlOf(name)` gives a file's URL in its folder. */
  async loadMap(map, urlOf, onProgress) {
    if (this.map === map && this.mapRoot) return;
    if (this.mapRoot) {
      this.scene.remove(this.mapRoot);
      this.mapRoot.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); [].concat(o.material).forEach((m) => { m.map?.dispose(); m.dispose(); }); } });
      this.mapRoot = null;
    }
    this.map = map;
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((u) => (u.startsWith("veloxify-map:") ? urlOf(u.slice("veloxify-map:".length)) : u));
    manager.onProgress = (_, done, total) => onProgress?.(done / Math.max(1, total));
    const gl = new GLTFLoader(manager);
    gl.setResourcePath("veloxify-map:");
    const [gltf, baked] = await Promise.all([gl.loadAsync(urlOf("world.glb")), new RGBELoader(manager).loadAsync(urlOf("irradiance.hdr"))]);
    baked.flipY = false;
    baked.channel = 1;
    baked.colorSpace = THREE.NoColorSpace;
    baked.generateMipmaps = false;
    baked.minFilter = baked.magFilter = THREE.LinearFilter;
    baked.needsUpdate = true;
    const root = gltf.scene;
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      // The map's sun: its direction (the viewer's own sun light is tuned to look like CS2).
      if (o.isDirectionalLight) {
        const from = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
        const to = new THREE.Vector3().setFromMatrixPosition(o.target.matrixWorld);
        if (from.distanceTo(to) > 0) this.toSun.copy(from.sub(to).normalize());
        this.sun.color.copy(o.color);
        o.visible = false;
      }
      if (o.isLight) o.visible = false;
      if (!o.isMesh) return;
      // Retakes-only barriers and editor-only surfaces aren't in a normal game.
      const tex = [].concat(o.material)[0]?.map?.name || "";
      if (/^retake_/i.test(o.name) || /tools(solid)?blocklight|wrongway/.test(tex)) { o.visible = false; return; }
      if (o.isSkinnedMesh) return;
      const baked1 = !!o.geometry.attributes.uv1;
      o.castShadow = o.receiveShadow = true;
      const swap = (m) => {
        const n = new THREE.MeshLambertMaterial({ map: m.map || null, color: m.color, transparent: m.transparent, side: m.side, alphaTest: m.map ? (m.alphaTest || (m.transparent ? 0.02 : 0.5)) : 0 });
        if (m.emissiveMap) { n.emissiveMap = m.emissiveMap; n.emissive = new THREE.Color(1, 1, 1); }
        if (baked1) { n.lightMap = baked; n.lightMapIntensity = LIGHT.baked * Math.PI; }
        m.dispose();
        return n;
      };
      o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
    });
    this.mapRoot = root;
    this.scene.add(root);
    this.shadowAt = null;
  }

  /** The players (header order), their names and which side each is on in the current round. */
  setPlayers(names, me) {
    for (const f of this.figures) this.scene.remove(f.group);
    this.figures = names.map((name, i) => {
      const group = makeFigure(0xaaaaaa);
      this.scene.add(group);
      const label = document.createElement("div");
      label.className = "v3d-label";
      label.textContent = name;
      return { group, label, name, me: i === me, side: "" };
    });
    this.labels?.replaceChildren(...this.figures.map((f) => f.label));
  }

  setSides(sides) {
    this.figures.forEach((f, i) => {
      f.side = sides[i] || "";
      f.group.userData.mat.color.setHex(SIDE_COLOR[f.side] || 0xaaaaaa);
      f.label.dataset.side = f.side;
    });
  }

  /** Shows the viewer in `host` (a div); the overlay layer gets the name labels. */
  mount(host) {
    this.host = host;
    host.prepend(this.canvas);
    this.labels = host.querySelector(".v3d-labels") || host.appendChild(Object.assign(document.createElement("div"), { className: "v3d-labels" }));
    this.labels.replaceChildren(...this.figures.map((f) => f.label));
    this.resize();
    this.ro?.disconnect();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
  }

  resize() {
    if (!this.host) return;
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Puts everyone where they are at fractional sample `f` of round `r`; the camera follows `pov`
   *  (a player index) or the free camera. */
  frame(r, f) {
    const s = this.tmp;
    const v = new THREE.Vector3();
    for (let i = 0; i < this.figures.length; i++) {
      const fig = this.figures[i];
      sampleAt(r, i, f, s);
      const alive = s.hp > 0;
      const hidden = !alive || i === this.pov;
      fig.group.visible = !hidden;
      fig.alive = alive;
      fig.hp = s.hp;
      if (!alive) continue;
      toWorld(s.x, s.y, s.z, fig.group.position);
      fig.group.rotation.y = s.yaw * Math.PI / 180;
      fig.group.scale.y = 1 - 0.25 * s.duck;
      fig.group.userData.aim.rotation.x = s.pitch * Math.PI / 180;
      fig.eye = toWorld(s.x, s.y, s.z + EYE - CROUCH_DROP * s.duck, fig.eye || new THREE.Vector3());
      if (i === this.pov) {
        this.camera.position.copy(fig.eye);
        this.camera.lookAt(v.copy(fig.eye).add(viewDir(s.yaw, s.pitch)));
        Object.assign(this.free, { yaw: s.yaw, pitch: s.pitch });
        this.free.pos.set(s.x, s.y, s.z + EYE - CROUCH_DROP * s.duck);
      }
    }
    if (this.pov == null) {
      const p = this.free.pos;
      toWorld(p.x, p.y, p.z, this.camera.position);
      this.camera.lookAt(v.copy(this.camera.position).add(viewDir(this.free.yaw, this.free.pitch)));
    }
    this._shadows();
    this.renderer.render(this.scene, this.camera);
    this._labels();
  }

  _shadows() {
    const look = new THREE.Vector3();
    this.camera.getWorldDirection(look);
    const focus = this.camera.position.clone().addScaledVector(look, 25);
    if (this.shadowAt && this.shadowAt.distanceTo(focus) < 8) return;
    this.shadowAt = focus;
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(this.toSun, 200);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
    this.renderer.shadowMap.needsUpdate = true;
  }

  _labels() {
    if (!this.host) return;
    const w = this.host.clientWidth, h = this.host.clientHeight;
    const v = new THREE.Vector3();
    for (const f of this.figures) {
      if (!f.group.visible) { f.label.hidden = true; continue; }
      v.copy(f.group.position);
      v.y += 1.95 * f.group.scale.y;
      v.project(this.camera);
      const off = v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1;
      f.label.hidden = off;
      if (!off) f.label.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -100%)`;
    }
  }

  /** Free camera: drag to look, WASD to move (Q/E down/up, Shift faster), wheel to move ahead. */
  _bindInput() {
    let drag = null;
    this.canvas.addEventListener("mousedown", (e) => { drag = { x: e.clientX, y: e.clientY }; this.canvas.focus(); });
    window.addEventListener("mouseup", () => { drag = null; });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag = { x: e.clientX, y: e.clientY };
      if (this.pov != null) this.onFreeCam?.();
      this.free.yaw -= dx * 0.15;
      this.free.pitch = Math.max(-89, Math.min(89, this.free.pitch + dy * 0.15));
      this.onInput?.();
    });
    this.canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (this.pov != null) this.onFreeCam?.();
      this.moveFree(-Math.sign(e.deltaY) * 120, 0, 0);
      this.onInput?.();
    }, { passive: false });
    this.canvas.addEventListener("keydown", (e) => { if ("wasdqe".includes(e.key.toLowerCase()) || e.key === "Shift") this.free.keys.add(e.key.toLowerCase()); });
    this.canvas.addEventListener("keyup", (e) => this.free.keys.delete(e.key.toLowerCase()));
    this.canvas.addEventListener("blur", () => this.free.keys.clear());
  }

  /** The free camera above and behind where the living players are, looking down at them. */
  overview(r, f) {
    const s = {};
    let n = 0, x = 0, y = 0, z = 0;
    for (let i = 0; i < this.figures.length; i++) {
      sampleAt(r, i, f, s);
      if (s.hp > 0) { x += s.x; y += s.y; z += s.z; n++; }
    }
    if (!n) return;
    Object.assign(this.free, { yaw: 90, pitch: 50 });
    this.free.pos.set(x / n, y / n - 900, z / n + 1100);
  }

  /** Moves the free camera: ahead, right, up (game units). */
  moveFree(ahead, right, up) {
    const y = this.free.yaw * Math.PI / 180, p = this.free.pitch * Math.PI / 180;
    const fx = Math.cos(p) * Math.cos(y), fy = Math.cos(p) * Math.sin(y), fz = -Math.sin(p);
    this.free.pos.x += fx * ahead + Math.sin(y) * right;
    this.free.pos.y += fy * ahead - Math.cos(y) * right;
    this.free.pos.z += fz * ahead + up;
  }

  /** Free-camera keys held: moves it for `dt` seconds; whether it moved. */
  stepKeys(dt) {
    const k = this.free.keys;
    if (!k.size) return false;
    const speed = (k.has("shift") ? 900 : 350) * dt;
    const ahead = (k.has("w") ? 1 : 0) - (k.has("s") ? 1 : 0), right = (k.has("d") ? 1 : 0) - (k.has("a") ? 1 : 0), up = (k.has("e") ? 1 : 0) - (k.has("q") ? 1 : 0);
    if (!ahead && !right && !up) return false;
    if (this.pov != null) this.onFreeCam?.();
    this.moveFree(ahead * speed, right * speed, up * speed);
    return true;
  }
}

let viewer = null;
/** The app's one 3D viewer. */
export function getViewer() {
  if (!viewer) viewer = new Viewer();
  return viewer;
}
